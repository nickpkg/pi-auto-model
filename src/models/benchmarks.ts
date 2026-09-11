/**
 * External benchmark data for capability assessment.
 *
 * This module provides objective, benchmark-backed capability ratings
 * instead of relying solely on hand-tuned priors. Two sources are supported:
 *
 * - **Ramp**: SWE-Bench resolve rate (coding-oriented, 0–1).
 * - **AA** (Artificial Analysis): general Intelligence Index (broader, 0–100).
 *
 * Sources are never mixed. The active source is selected via configuration.
 *
 * Benchmark data is maintained in `BENCHMARKS`. Each entry can contain one
 * or both source scores. When a source score is missing, the model falls
 * back to the hand-tuned `CAPABILITY_PRIORS` in `capability.ts`.
 */

export type BenchmarkSource = "ramp" | "aa";

export interface BenchmarkEntry {
	/** SWE-Bench resolve rate, 0–1. */
	ramp?: number;
	/** Artificial Analysis Intelligence Index, 0–100. */
	aa?: number;
}

export const BENCHMARK_PROVENANCE = {
	ramp: {
		url: "https://labs.ramp.com/swebench",
		retrievedAt: "2026-09-11",
		metric: "resolve rate",
	},
	aa: {
		url: "https://artificialanalysis.ai/leaderboards/models",
		retrievedAt: "2026-09-11",
		metric: "Intelligence Index",
	},
} as const;

/**
 * Mode thresholds for Ramp (SWE-Bench resolve rate).
 * A model at or above a threshold enters the corresponding tier.
 */
export const RAMP_THRESHOLDS = {
	mid: 0.75,
	strong: 0.80,
	frontier: 0.85,
} as const;

/**
 * Mode thresholds for AA (Intelligence Index).
 * A model at or above a threshold enters the corresponding tier.
 */
export const AA_THRESHOLDS = {
	mid: 40,
	strong: 47,
	frontier: 52,
} as const;

/**
 * Bundled benchmark data for known models.
 *
 * Keys are model target IDs in `provider/model` form. Values contain
 * available benchmark scores. Missing scores fall back to priors.
 *
 * Data is sourced from publicly published benchmark reports. It is
 * approximate and periodically updated. It does not claim to be a
 * precise or current representation of any provider's offering.
 */
const BENCHMARKS: Readonly<Record<string, BenchmarkEntry>> = {
	"openai/gpt-5.6-luna": { ramp: 0.89, aa: 54 },
	"openai/gpt-5": { ramp: 0.88, aa: 53 },
	"openai/gpt-5.4-nano": { ramp: 0.72, aa: 38 },
	"anthropic/claude-opus-5": { ramp: 0.87, aa: 52 },
	"anthropic/claude-sonnet": { ramp: 0.82, aa: 48 },
	"anthropic/claude-haiku": { ramp: 0.71, aa: 37 },
	"google/gemini-3.1-pro-preview": { ramp: 0.84, aa: 50 },
	"google/gemini-flash-latest": { ramp: 0.76, aa: 43 },
	"google/gemini-flash-lite-latest": { ramp: 0.68, aa: 34 },
	"deepseek/deepseek-v4-flash-0731": { ramp: 0.78, aa: 44 },
	"deepseek/deepseek-v4": { ramp: 0.83, aa: 49 },
	"z-ai/glm-5.3-flash": { ramp: 0.77, aa: 42 },
	"z-ai/glm-5.3": { ramp: 0.81, aa: 46 },
	"qwen/qwen3.8-flash": { ramp: 0.73, aa: 39 },
	"qwen/qwen3.8": { ramp: 0.79, aa: 45 },
	"kimi-coding/k3": { ramp: 0.80, aa: 47 },
	"openrouter/free": { ramp: 0.45 },
};

/**
 * User-supplied overrides merged over bundled data.  Set via
 * `setBenchmarkOverrides` at configuration load time.
 */
let overrides: Record<string, BenchmarkEntry> = {};

/**
 * Sets user-supplied benchmark overrides.  Overrides are merged over
 * bundled data on a per-field basis.
 */
export function setBenchmarkOverrides(entries: Record<string, BenchmarkEntry>): void {
	overrides = entries;
}

/**
 * Clears all benchmark overrides.  Intended for testing.
 */
export function clearBenchmarkOverrides(): void {
	overrides = {};
}

/**
 * Returns the benchmark entry for a model target ID, merging user
 * overrides over bundled data.  Returns `undefined` when no data exists.
 */
export function getBenchmark(targetId: string): BenchmarkEntry | undefined {
	return getBenchmarkFrom(targetId, overrides);
}

export function getBenchmarkFrom(
	targetId: string,
	overrideEntries: Readonly<Record<string, BenchmarkEntry>>,
): BenchmarkEntry | undefined {
	const bundled = BENCHMARKS[targetId];
	const override = overrideEntries[targetId];
	if (!bundled && !override) return undefined;
	return {
		ramp: override?.ramp ?? bundled?.ramp,
		aa: override?.aa ?? bundled?.aa,
	};
}

/**
 * Classifies a model into a capability tier based on the selected
 * benchmark source.  Returns `undefined` when the source has no data
 * for the model (caller should fall back to priors).
 */
export function tierFromBenchmark(
	targetId: string,
	source: BenchmarkSource,
	overrideEntries: Readonly<Record<string, BenchmarkEntry>> = overrides,
): import("../types.ts").CapabilityTier | undefined {
	const entry = getBenchmarkFrom(targetId, overrideEntries);
	if (!entry) return undefined;

	if (source === "ramp") {
		const score = entry.ramp;
		if (score === undefined) return undefined;
		if (score >= RAMP_THRESHOLDS.frontier) return "frontier";
		if (score >= RAMP_THRESHOLDS.strong) return "strong";
		if (score >= RAMP_THRESHOLDS.mid) return "mid";
		return "light";
	}

	// AA
	const score = entry.aa;
	if (score === undefined) return undefined;
	if (score >= AA_THRESHOLDS.frontier) return "frontier";
	if (score >= AA_THRESHOLDS.strong) return "strong";
	if (score >= AA_THRESHOLDS.mid) return "mid";
	return "light";
}

/**
 * Returns the raw numeric benchmark score for a model, or `undefined`.
 */
export function benchmarkScore(
	targetId: string,
	source: BenchmarkSource,
): number | undefined {
	const entry = getBenchmark(targetId);
	if (!entry) return undefined;
	return source === "ramp" ? entry.ramp : entry.aa;
}
