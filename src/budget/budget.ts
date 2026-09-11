import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RouteTarget, TaskProfile } from "../types.ts";

export type BudgetAction = "allow" | "warn" | "downgrade" | "block";

export interface ProviderBudgetLimit {
	dailyUsd?: number;
	monthlyUsd?: number;
	onExceed?: Exclude<BudgetAction, "allow">;
}

export interface BudgetConfig {
	maxUsdPerTask?: number;
	dailyUsd?: number;
	monthlyUsd?: number;
	onExceed?: Exclude<BudgetAction, "allow">;
	providers?: Record<string, ProviderBudgetLimit>;
}

export interface BudgetUsageSnapshot {
	dayKey: string;
	monthKey: string;
	dailyUsd: number;
	monthlyUsd: number;
	providers: Record<string, {
		dailyUsd: number;
		monthlyUsd: number;
	}>;
}

export interface BudgetDecision {
	action: BudgetAction;
	exceeded: string[];
}

export function estimateCost(target: RouteTarget, inputTokens: number, profile: TaskProfile): number {
	return (
		inputTokens * target.model.cost.input +
		profile.constraints.requiredOutputTokens * target.model.cost.output
	) / 1_000_000;
}

export function evaluateBudget(estimate: number, config: BudgetConfig = {}): BudgetAction {
	if (!config.maxUsdPerTask || estimate <= config.maxUsdPerTask) return "allow";
	return config.onExceed ?? "downgrade";
}

const ACTION_RANK: Record<BudgetAction, number> = {
	allow: 0,
	warn: 1,
	downgrade: 2,
	block: 3,
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

	record(provider: string, estimate: number, now = Date.now()): void {
		this.rotate(now);
		const value = Math.max(0, estimate);
		this.usage.dailyUsd += value;
		this.usage.monthlyUsd += value;
		const providerUsage = this.usage.providers[provider] ?? { dailyUsd: 0, monthlyUsd: 0 };
		providerUsage.dailyUsd += value;
		providerUsage.monthlyUsd += value;
		this.usage.providers[provider] = providerUsage;
	}

	evaluate(
		estimate: number,
		provider: string,
		config: BudgetConfig,
		now = Date.now(),
	): BudgetDecision {
		this.rotate(now);
		return evaluateGlobalBudget(estimate, provider, config, this.usage);
	}

	snapshot(now = Date.now()): BudgetUsageSnapshot {
		this.rotate(now);
		return {
			...this.usage,
			providers: Object.fromEntries(
				Object.entries(this.usage.providers).map(([provider, value]) => [provider, { ...value }]),
			),
		};
	}

	async flush(now = Date.now()): Promise<void> {
		if (!this.filePath) return;
		const filePath = this.filePath;
		const payload: BudgetFile = {
			version: 1,
			updatedAt: Date.now(),
			usage: this.snapshot(now),
		};
		this.writeChain = this.writeChain.then(async () => {
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		});
		return this.writeChain;
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
		dailyUsd: 0,
		monthlyUsd: 0,
		providers: {},
	};
}

function normalizeUsage(value: BudgetUsageSnapshot, now: number): BudgetUsageSnapshot {
	const fresh = createUsage(now);
	const usage: BudgetUsageSnapshot = {
		dayKey: typeof value.dayKey === "string" ? value.dayKey : fresh.dayKey,
		monthKey: typeof value.monthKey === "string" ? value.monthKey : fresh.monthKey,
		dailyUsd: typeof value.dailyUsd === "number" ? Math.max(0, value.dailyUsd) : 0,
		monthlyUsd: typeof value.monthlyUsd === "number" ? Math.max(0, value.monthlyUsd) : 0,
		providers: {},
	};
	for (const [provider, limits] of Object.entries(value.providers ?? {})) {
		usage.providers[provider] = {
			dailyUsd: Math.max(0, limits.dailyUsd ?? 0),
			monthlyUsd: Math.max(0, limits.monthlyUsd ?? 0),
		};
	}
	return usage;
}
