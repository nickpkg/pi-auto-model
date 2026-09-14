import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RouteTarget, TaskProfile } from "../types.ts";
import { withFileLock } from "../storage/file-lock.ts";

export type BudgetAction = "allow" | "warn" | "avoid" | "downgrade" | "block";

export interface ProviderBudgetLimit {
	dailyUsd?: number;
	monthlyUsd?: number;
	onExceed?: Exclude<BudgetAction, "allow">;
}

export interface BudgetConfig {
	maxUsdPerTask?: number;
	sessionUsd?: number;
	dailyUsd?: number;
	monthlyUsd?: number;
	onExceed?: Exclude<BudgetAction, "allow">;
	providers?: Record<string, ProviderBudgetLimit>;
}

export interface BudgetUsageSnapshot {
	dayKey: string;
	monthKey: string;
	sessionKey?: string;
	sessionUsd?: number;
	sessions?: Record<string, number>;
	dailyUsd: number;
	monthlyUsd: number;
	providers: Record<string, {
		dailyUsd: number;
		monthlyUsd: number;
	}>;
	history?: BudgetUsageBucket[];
}

export interface BudgetUsageBucket {
	startAt: number;
	usd: number;
	providers: Record<string, number>;
}

export interface BudgetDecision {
	action: BudgetAction;
	exceeded: string[];
}

export interface BudgetReservation {
	provider: string;
	estimate: number;
	at: number;
	sessionId: string;
}

export function estimateCost(target: RouteTarget, inputTokens: number, profile: TaskProfile): number {
	return (
		inputTokens * target.model.cost.input +
		profile.constraints.requiredOutputTokens * target.model.cost.output
	) / 1_000_000;
}

export function evaluateBudget(estimate: number, config: BudgetConfig = {}): BudgetAction {
	if (config.maxUsdPerTask === undefined || estimate <= config.maxUsdPerTask) return "allow";
	return config.onExceed ?? "downgrade";
}

const ACTION_RANK: Record<BudgetAction, number> = {
	allow: 0,
	warn: 1,
	avoid: 2,
	downgrade: 3,
	block: 4,
};

export function strongerBudgetAction(left: BudgetAction, right: BudgetAction): BudgetAction {
	return ACTION_RANK[left] >= ACTION_RANK[right] ? left : right;
}

export function evaluateGlobalBudget(
	estimate: number,
	provider: string,
	config: BudgetConfig,
	usage: BudgetUsageSnapshot,
): BudgetDecision {
	const exceeded: string[] = [];
	const providerLimit = config.providers?.[provider];
	const providerUsage = usage.providers[provider];
	let action: BudgetAction = evaluateBudget(estimate, config);
	if (config.maxUsdPerTask !== undefined && estimate > config.maxUsdPerTask) {
		exceeded.push("task");
	}

	if (config.sessionUsd !== undefined && (usage.sessionUsd ?? 0) + estimate > config.sessionUsd) {
		exceeded.push("session");
		action = strongerBudgetAction(action, config.onExceed ?? "downgrade");
	}
	if (config.dailyUsd !== undefined && usage.dailyUsd + estimate > config.dailyUsd) {
		exceeded.push("daily");
		action = strongerBudgetAction(action, config.onExceed ?? "downgrade");
	}
	if (config.monthlyUsd !== undefined && usage.monthlyUsd + estimate > config.monthlyUsd) {
		exceeded.push("monthly");
		action = strongerBudgetAction(action, config.onExceed ?? "downgrade");
	}
	if (providerLimit?.dailyUsd !== undefined && (providerUsage?.dailyUsd ?? 0) + estimate > providerLimit.dailyUsd) {
		exceeded.push(`${provider} daily`);
		action = strongerBudgetAction(action, providerLimit.onExceed ?? config.onExceed ?? "downgrade");
	}
	if (providerLimit?.monthlyUsd !== undefined && (providerUsage?.monthlyUsd ?? 0) + estimate > providerLimit.monthlyUsd) {
		exceeded.push(`${provider} monthly`);
		action = strongerBudgetAction(action, providerLimit.onExceed ?? config.onExceed ?? "downgrade");
	}

	return { action, exceeded };
}

interface BudgetFile {
	version: 1;
	updatedAt: number;
	usage: BudgetUsageSnapshot;
}

export class BudgetLedger {
	private usage: BudgetUsageSnapshot = createUsage();
	private filePath?: string;
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();

	async load(filePath: string, now = Date.now()): Promise<void> {
		this.filePath = filePath;
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<BudgetFile>;
			if (parsed.version === 1 && parsed.usage) {
				this.usage = normalizeUsage(parsed.usage, now);
			}
		} catch {
			this.usage = createUsage(now);
		}
	}

	async reserve(
		provider: string,
		estimate: number,
		config: BudgetConfig,
		now = Date.now(),
		sessionId = this.usage.sessionKey,
	): Promise<BudgetDecision> {
		if (!this.filePath) {
			if (sessionId) this.startSession(sessionId, now);
			const decision = this.evaluate(estimate, provider, config, now);
			if (decision.action !== "block" && decision.action !== "avoid") this.record(provider, estimate, now);
			return decision;
		}
		await this.writeChain.catch(() => {});
		const filePath = this.filePath;
		await mkdir(dirname(filePath), { recursive: true });
		return withFileLock(`${filePath}.lock`, async () => {
			const sessionKey = sessionId;
			await this.reloadUsage(filePath, now);
			if (sessionKey) {
				this.usage.sessionKey = sessionKey;
				this.usage.sessionUsd = this.usage.sessions?.[sessionKey] ?? 0;
			}
			const decision = this.evaluate(estimate, provider, config, now);
			if (decision.action !== "block" && decision.action !== "avoid") {
				this.record(provider, estimate, now);
				await this.persist(now);
			}
			return decision;
		});
	}

	/** Replace one reservation with observed cost, in its original accounting windows. */
	async reconcile(reservation: BudgetReservation, actualCost: number, now = Date.now()): Promise<void> {
		if (!Number.isFinite(actualCost) || actualCost < 0) throw new Error("Invalid actual cost");
		const apply = (): void => {
			this.rotate(now);
			const delta = actualCost - reservation.estimate;
			const date = new Date(reservation.at).toISOString();
			const provider = this.usage.providers[reservation.provider] ?? { dailyUsd: 0, monthlyUsd: 0 };
			if (this.usage.dayKey === date.slice(0, 10)) {
				this.usage.dailyUsd = Math.max(0, this.usage.dailyUsd + delta);
				provider.dailyUsd = Math.max(0, provider.dailyUsd + delta);
			}
			if (this.usage.monthKey === date.slice(0, 7)) {
				this.usage.monthlyUsd = Math.max(0, this.usage.monthlyUsd + delta);
				provider.monthlyUsd = Math.max(0, provider.monthlyUsd + delta);
			}
			this.usage.providers[reservation.provider] = provider;
			const sessions = this.usage.sessions ??= {};
			sessions[reservation.sessionId] = Math.max(0, (sessions[reservation.sessionId] ?? 0) + delta);
			if (this.usage.sessionKey === reservation.sessionId) this.usage.sessionUsd = sessions[reservation.sessionId];
			const bucket = this.usage.history?.find((entry) => entry.startAt === Math.floor(reservation.at / 3_600_000) * 3_600_000);
			if (bucket) {
				bucket.usd = Math.max(0, bucket.usd + delta);
				bucket.providers[reservation.provider] = Math.max(0, (bucket.providers[reservation.provider] ?? 0) + delta);
			}
		};
		if (!this.filePath) return apply();
		const filePath = this.filePath;
		await this.writeChain.catch(() => {});
		await withFileLock(`${filePath}.lock`, async () => {
			await this.reloadUsage(filePath, now);
			apply();
			await this.persist(now);
		});
	}

	async recordShared(provider: string, estimate: number, now = Date.now()): Promise<void> {
		if (!this.filePath) return this.record(provider, estimate, now);
		await this.writeChain.catch(() => {});
		const filePath = this.filePath;
		await mkdir(dirname(filePath), { recursive: true });
		await withFileLock(`${filePath}.lock`, async () => {
			const sessionKey = this.usage.sessionKey;
			await this.reloadUsage(filePath, now);
			if (sessionKey) {
				this.usage.sessionKey = sessionKey;
				this.usage.sessionUsd = this.usage.sessions?.[sessionKey] ?? 0;
			}
			this.record(provider, estimate, now);
			await this.persist(now);
		});
	}

	startSession(sessionKey: string, now = Date.now()): void {
		this.rotate(now);
		this.usage.sessionKey = sessionKey;
		this.usage.sessionUsd = this.usage.sessions?.[sessionKey] ?? 0;
	}

	record(provider: string, estimate: number, now = Date.now()): void {
		this.rotate(now);
		const value = Math.max(0, estimate);
		this.usage.sessionUsd = (this.usage.sessionUsd ?? 0) + value;
		if (this.usage.sessionKey) {
			this.usage.sessions = {
				...(this.usage.sessions ?? {}),
				[this.usage.sessionKey]: this.usage.sessionUsd,
			};
		}
		this.usage.dailyUsd += value;
		this.usage.monthlyUsd += value;
		const providerUsage = this.usage.providers[provider] ?? { dailyUsd: 0, monthlyUsd: 0 };
		providerUsage.dailyUsd += value;
		providerUsage.monthlyUsd += value;
		this.usage.providers[provider] = providerUsage;
		const bucketStart = Math.floor(now / 3_600_000) * 3_600_000;
		const history = this.usage.history ?? [];
		const bucket = history.find((entry) => entry.startAt === bucketStart) ?? {
			startAt: bucketStart,
			usd: 0,
			providers: {},
		};
		bucket.usd += value;
		bucket.providers[provider] = (bucket.providers[provider] ?? 0) + value;
		this.usage.history = [
			...history.filter((entry) => entry.startAt !== bucketStart),
			bucket,
		].sort((left, right) => left.startAt - right.startAt).slice(-24 * 90);
	}

	evaluate(
		estimate: number,
		provider: string,
		config: BudgetConfig,
		now = Date.now(),
		sessionId = this.usage.sessionKey,
	): BudgetDecision {
		this.rotate(now);
		return evaluateGlobalBudget(estimate, provider, config, {
			...this.usage, sessionUsd: sessionId ? this.usage.sessions?.[sessionId] ?? 0 : this.usage.sessionUsd,
		});
	}

	snapshot(now = Date.now()): BudgetUsageSnapshot {
		this.rotate(now);
		return {
			...this.usage,
			providers: Object.fromEntries(
				Object.entries(this.usage.providers).map(([provider, value]) => [provider, { ...value }]),
			),
			history: (this.usage.history ?? []).map((entry) => ({
				...entry,
				providers: { ...entry.providers },
			})),
		};
	}

	async flush(now = Date.now()): Promise<void> {
		if (!this.filePath) return;
		this.writeChain = this.writeChain.catch(() => {}).then(async () => {
			await this.persist(now);
		});
		return this.writeChain;
	}

	private async persist(now: number): Promise<void> {
		if (!this.filePath) return;
		const payload: BudgetFile = { version: 1, updatedAt: Date.now(), usage: this.snapshot(now) };
		const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		await rename(temporaryPath, this.filePath);
	}

	private async reloadUsage(filePath: string, now: number): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<BudgetFile>;
			this.usage = parsed.version === 1 && parsed.usage ? normalizeUsage(parsed.usage, now) : createUsage(now);
		} catch {
			this.usage = createUsage(now);
		}
	}

	private rotate(now: number): void {
		const current = createUsage(now);
		if (this.usage.dayKey !== current.dayKey) {
			this.usage.dayKey = current.dayKey;
			this.usage.dailyUsd = 0;
			for (const value of Object.values(this.usage.providers)) value.dailyUsd = 0;
		}
		if (this.usage.monthKey !== current.monthKey) {
			this.usage.monthKey = current.monthKey;
			this.usage.monthlyUsd = 0;
			for (const value of Object.values(this.usage.providers)) value.monthlyUsd = 0;
		}
	}
}

function createUsage(now = Date.now()): BudgetUsageSnapshot {
	const date = new Date(now);
	return {
		dayKey: date.toISOString().slice(0, 10),
		monthKey: date.toISOString().slice(0, 7),
		sessionUsd: 0,
		sessions: {},
		dailyUsd: 0,
		monthlyUsd: 0,
		providers: {},
		history: [],
	};
}

function normalizeUsage(value: BudgetUsageSnapshot, now: number): BudgetUsageSnapshot {
	const fresh = createUsage(now);
	const usage: BudgetUsageSnapshot = {
		dayKey: typeof value.dayKey === "string" ? value.dayKey : fresh.dayKey,
		monthKey: typeof value.monthKey === "string" ? value.monthKey : fresh.monthKey,
		sessionKey: typeof value.sessionKey === "string" ? value.sessionKey : undefined,
		sessionUsd: typeof value.sessionUsd === "number" ? Math.max(0, value.sessionUsd) : 0,
		sessions: Object.fromEntries(
			Object.entries(value.sessions ?? {})
				.filter(([, amount]) => typeof amount === "number")
			.map(([key, amount]) => [key, Math.max(0, amount as number)]),
		),
		dailyUsd: typeof value.dailyUsd === "number" ? Math.max(0, value.dailyUsd) : 0,
		monthlyUsd: typeof value.monthlyUsd === "number" ? Math.max(0, value.monthlyUsd) : 0,
		providers: {},
		history: Array.isArray(value.history)
			? value.history
				.filter((entry): entry is BudgetUsageBucket =>
					Boolean(entry) && typeof entry.startAt === "number" && typeof entry.usd === "number",
				)
				.map((entry) => ({
					startAt: entry.startAt,
					usd: Math.max(0, entry.usd),
					providers: { ...entry.providers },
				}))
				.slice(-24 * 90)
			: [],
	};
	for (const [provider, limits] of Object.entries(value.providers ?? {})) {
		usage.providers[provider] = {
			dailyUsd: Math.max(0, limits.dailyUsd ?? 0),
			monthlyUsd: Math.max(0, limits.monthlyUsd ?? 0),
		};
	}
	return usage;
}
