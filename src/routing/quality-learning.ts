import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskKind } from "../types.ts";
import { withFileLock } from "../storage/file-lock.ts";

interface WeightedStats {
	attempts: number;
	successes: number;
	failures: number;
	lastAt: number;
}

interface FeedbackStats {
	offset: number;
	lastAt: number;
}

interface QualityFile {
	version: 1;
	updatedAt: number;
	targets: Record<string, WeightedStats>;
	providers: Record<string, WeightedStats>;
	byKind: Record<string, Record<string, WeightedStats>>;
	feedback: Record<string, FeedbackStats>;
}

export interface QualitySignal {
	score: number;
	reason: string;
}

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FEEDBACK_OFFSET = 0.1;

type QualityOperation =
	| { type: "outcome"; targetId: string; provider: string; kinds: readonly TaskKind[]; success: boolean; now: number }
	| { type: "feedback"; targetId: string; kinds: readonly TaskKind[]; vote: "good" | "bad"; now: number };

function clamp(value: number, minimum = 0, maximum = 1): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function decay(stats: WeightedStats, now: number): WeightedStats {
	const factor = Math.exp(-Math.log(2) * Math.max(0, now - stats.lastAt) / HALF_LIFE_MS);
	return {
		attempts: stats.attempts * factor,
		successes: stats.successes * factor,
		failures: stats.failures * factor,
		lastAt: stats.lastAt,
	};
}

function emptyStats(now: number): WeightedStats {
	return { attempts: 0, successes: 0, failures: 0, lastAt: now };
}

function updateStats(
	stats: WeightedStats | undefined,
	success: boolean,
	now: number,
): WeightedStats {
	const next = stats ? decay(stats, now) : emptyStats(now);
	next.attempts += 1;
	if (success) next.successes += 1;
	else next.failures += 1;
	next.lastAt = now;
	return next;
}

function statsScore(stats: WeightedStats | undefined, now: number): { score: number; confidence: number } {
	if (!stats || stats.attempts <= 0) return { score: 0.5, confidence: 0 };
	const current = decay(stats, now);
	const rate = (current.successes + 1) / (current.attempts + 2);
	return {
		score: rate,
		confidence: clamp(current.attempts / (current.attempts + 4)),
	};
}

export class QualityLearning {
	private readonly targets = new Map<string, WeightedStats>();
	private readonly providers = new Map<string, WeightedStats>();
	private readonly byKind = new Map<string, Map<string, WeightedStats>>();
	private readonly feedback = new Map<string, FeedbackStats>();
	private filePath?: string;
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();
	private readonly pendingOperations: QualityOperation[] = [];

	async load(filePath: string): Promise<void> {
		this.filePath = filePath;
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<QualityFile>;
			if (parsed.version !== 1) return;
			for (const [id, value] of Object.entries(parsed.targets ?? {})) this.targets.set(id, value);
			for (const [id, value] of Object.entries(parsed.providers ?? {})) this.providers.set(id, value);
			for (const [kind, values] of Object.entries(parsed.byKind ?? {})) {
				this.byKind.set(kind, new Map(Object.entries(values)));
			}
			for (const [key, value] of Object.entries(parsed.feedback ?? {})) this.feedback.set(key, value);
		} catch {
			// Missing or corrupt local learning state falls back to cold start.
		}
	}

	record(targetId: string, provider: string, kinds: readonly TaskKind[], success: boolean, now = Date.now(), track = true): void {
		if (track) this.pendingOperations.push({ type: "outcome", targetId, provider, kinds: [...kinds], success, now });
		this.targets.set(targetId, updateStats(this.targets.get(targetId), success, now));
		this.providers.set(provider, updateStats(this.providers.get(provider), success, now));
		for (const kind of new Set(kinds.length ? kinds : ["mixed" as TaskKind])) {
			const values = this.byKind.get(kind) ?? new Map<string, WeightedStats>();
			values.set(targetId, updateStats(values.get(targetId), success, now));
			this.byKind.set(kind, values);
		}
		if (track) this.flushSoon();
	}

	recordFeedback(
		targetId: string,
		kinds: readonly TaskKind[],
		vote: "good" | "bad",
		now = Date.now(),
		track = true,
	): number {
		if (track) this.pendingOperations.push({ type: "feedback", targetId, kinds: [...kinds], vote, now });
		const delta = vote === "good" ? 0.02 : -0.02;
		const keys = [`target:${targetId}`, ...new Set(kinds.map((kind) => `kind:${kind}:${targetId}`))];
		let latest = 0;
		for (const key of keys) {
			const current = this.feedback.get(key);
			const factor = current ? Math.exp(-Math.log(2) * Math.max(0, now - current.lastAt) / HALF_LIFE_MS) : 1;
			const offset = clamp((current?.offset ?? 0) * factor + delta, -MAX_FEEDBACK_OFFSET, MAX_FEEDBACK_OFFSET);
			this.feedback.set(key, { offset, lastAt: now });
			latest = offset;
		}
		if (track) this.flushSoon();
		return latest;
	}

	signal(targetId: string, provider: string, kinds: readonly TaskKind[], now = Date.now()): QualitySignal {
		const kindStats = kinds
			.map((kind) => this.byKind.get(kind)?.get(targetId))
			.filter((value): value is WeightedStats => value !== undefined);
		const targetStats = kindStats.length
			? kindStats.reduce((best, value) => value.attempts > best.attempts ? value : best)
			: this.targets.get(targetId);
		const target = statsScore(targetStats, now);
		const providerScore = statsScore(this.providers.get(provider), now);
		const base = targetStats
			? target.score * target.confidence + providerScore.score * (1 - target.confidence)
			: providerScore.score;
		const confidence = targetStats
			? Math.max(target.confidence, providerScore.confidence * 0.5)
			: providerScore.confidence;
		const feedbackKeys = [
			...kinds.map((kind) => `kind:${kind}:${targetId}`),
			`target:${targetId}`,
		];
		const feedback = feedbackKeys
			.map((key) => this.feedback.get(key))
			.filter((value): value is FeedbackStats => value !== undefined)
			.map((value) => value.offset * Math.exp(-Math.log(2) * Math.max(0, now - value.lastAt) / HALF_LIFE_MS))
			.reduce((total, value) => total + value, 0) / Math.max(1, feedbackKeys.length);
		const exploration = Math.min(0.08, 0.08 * (1 - confidence));
		const score = clamp(base * confidence + 0.5 * (1 - confidence) + feedback + exploration);
		const reason = targetStats
			? `quality ${Math.round(score * 100)}% · ${Math.round(confidence * 100)}% confidence`
			: "quality cold-start exploration";
		return { score, reason };
	}

	async flush(): Promise<void> {
		if (!this.filePath) return;
		const operations = this.pendingOperations.splice(0);
		if (operations.length === 0) return this.writeChain;
		const filePath = this.filePath;
		this.writeChain = this.writeChain.catch(() => {}).then(async () => {
			await mkdir(dirname(filePath), { recursive: true });
			await withFileLock(`${filePath}.lock`, async () => {
				const merged = new QualityLearning();
				await merged.load(filePath);
				for (const operation of operations) merged.apply(operation);
				const payload: QualityFile = {
					version: 1,
					updatedAt: Date.now(),
					targets: Object.fromEntries(merged.targets),
					providers: Object.fromEntries(merged.providers),
					byKind: Object.fromEntries([...merged.byKind].map(([kind, values]) => [kind, Object.fromEntries(values)])),
					feedback: Object.fromEntries(merged.feedback),
				};
				await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
				this.targets.clear();
				this.providers.clear();
				this.byKind.clear();
				this.feedback.clear();
				for (const [key, value] of merged.targets) this.targets.set(key, value);
				for (const [key, value] of merged.providers) this.providers.set(key, value);
				for (const [key, value] of merged.byKind) this.byKind.set(key, value);
				for (const [key, value] of merged.feedback) this.feedback.set(key, value);
				for (const operation of this.pendingOperations) this.apply(operation);
			});
		}).catch((error) => {
			this.pendingOperations.unshift(...operations);
			throw error;
		});
		return this.writeChain;
	}

	private apply(operation: QualityOperation): void {
		if (operation.type === "outcome") {
			this.record(operation.targetId, operation.provider, operation.kinds, operation.success, operation.now, false);
		} else {
			this.recordFeedback(operation.targetId, operation.kinds, operation.vote, operation.now, false);
		}
	}

	private flushSoon(): void {
		void this.flush().catch(() => {});
	}
}
