import type { Model } from "@earendil-works/pi-ai";
import type { ModelCapabilityPrior } from "../types.ts";
import { tierFromBenchmark, type BenchmarkEntry, type BenchmarkSource } from "./benchmarks.ts";
import { modelTargetId } from "../types.ts";

/**
 * Active benchmark source.  Set via `setCapabilitySource` at configuration
 * load time.  When set, `deriveCapabilityPrior` prefers benchmark-backed
 * tier classification over hand-tuned priors.
 */
let activeSource: BenchmarkSource | undefined;

/**
 * Sets the active benchmark source for capability derivation.
 * Pass `undefined` to fall back to hand-tuned priors only.
 */
export function setCapabilitySource(source: BenchmarkSource | undefined): void {
	activeSource = source;
}

/**
 * Returns the active benchmark source, or `undefined` if none is set.
 */
export function getCapabilitySource(): BenchmarkSource | undefined {
	return activeSource;
}

export interface CapabilityOptions {
	source?: BenchmarkSource;
	overrides?: Readonly<Record<string, BenchmarkEntry>>;
}

const CAPABILITY_PRIORS: Readonly<Record<string, ModelCapabilityPrior>> = {
	"openai/gpt-5.6-luna": {
		overall: "frontier",
		coding: "frontier",
		reasoning: "frontier",
		toolUse: "strong",
		instructionFollowing: "strong",
		confidence: "medium",
	},
	"deepseek/deepseek-v4-flash-0731": {
		overall: "strong",
		coding: "strong",
		reasoning: "strong",
		toolUse: "strong",
		instructionFollowing: "mid",
		confidence: "medium",
	},
	"z-ai/glm-5.3-flash": {
		overall: "strong",
		coding: "strong",
		reasoning: "strong",
		toolUse: "mid",
		instructionFollowing: "mid",
		confidence: "medium",
	},
	"qwen/qwen3.8-flash": {
		overall: "mid",
		coding: "mid",
		reasoning: "mid",
		toolUse: "mid",
		instructionFollowing: "mid",
		confidence: "medium",
	},
	"openrouter/free": {
		overall: "light",
		coding: "light",
		reasoning: "light",
		toolUse: "light",
		instructionFollowing: "light",
		confidence: "low",
	},
};

// Coarse catalog priors, not measured benchmark scores. Unknown IDs stay unknown.
const CATALOG_TIERS: Readonly<Record<string, ModelCapabilityPrior["overall"]>> = {
	"openai/gpt-5": "frontier",
	"openai/gpt-5.4-nano": "light",
	"anthropic/claude-opus-5": "frontier",
	"anthropic/claude-sonnet": "strong",
	"anthropic/claude-haiku": "light",
	"google/gemini-3.1-pro-preview": "strong",
	"google/gemini-flash-latest": "mid",
	"google/gemini-flash-lite-latest": "light",
	"deepseek/deepseek-v4": "strong",
	"z-ai/glm-5.3": "strong",
	"qwen/qwen3.8": "mid",
	"kimi-coding/k3": "strong",
};

export function capabilityScore(tier: ModelCapabilityPrior["overall"]): number {
	switch (tier) {
		case "frontier":
			return 1;
		case "strong":
			return 0.82;
		case "mid":
			return 0.64;
		case "light":
			return 0.45;
		case "unknown":
			return 0.55;
	}
}

/**
 * Returns a numeric rank for a capability tier, higher = more capable.
 * Used for minimum-tier filtering (e.g. prefix mode pins).
 */
export function tierRank(tier: ModelCapabilityPrior["overall"]): number {
	switch (tier) {
		case "frontier":
			return 4;
		case "strong":
			return 3;
		case "mid":
			return 2;
		case "light":
			return 1;
		case "unknown":
			return 0;
	}
}

export function deriveCapabilityPrior(model: Model<any>, options?: CapabilityOptions): ModelCapabilityPrior {
	const source = options ? options.source : activeSource;
	const overrideEntries = options ? options.overrides ?? {} : undefined;
	const provider = model.provider === "openai-codex" ? "openai"
		: model.provider === "google-gemini-cli" ? "google" : model.provider;
	const keys = [...new Set([modelTargetId(model), `${provider}/${model.id}`, model.id])];
	// 1. If an active benchmark source has data for this model, derive the
	//    overall tier from the benchmark.  Sub-dimensional tiers fall back
	//    to the catalog prior or unknown.  Uses model.id for lookup,
	//    consistent with the catalog prior keys.
	if (source) {
		const benchmarkKey = keys.find((key) => tierFromBenchmark(key, source, overrideEntries) !== undefined);
		const benchTier = benchmarkKey ? tierFromBenchmark(benchmarkKey, source, overrideEntries) : undefined;
		if (benchTier) {
			const catalogPrior = keys.map((key) => CAPABILITY_PRIORS[key]).find(Boolean);
			return {
				overall: benchTier,
				coding: catalogPrior?.coding ?? benchTier,
				reasoning: catalogPrior?.reasoning ?? (model.reasoning ? benchTier : "light"),
				toolUse: catalogPrior?.toolUse ?? benchTier,
				instructionFollowing: catalogPrior?.instructionFollowing ?? benchTier,
				confidence: "high",
				source,
			};
		}
	}

	// 2. Fall back to hand-tuned catalog priors.
	const catalogPrior = keys.map((key) => CAPABILITY_PRIORS[key]).find(Boolean);
	if (catalogPrior) {
		return { ...catalogPrior, source: "catalog" };
	}
	const tier = keys.map((key) => CATALOG_TIERS[key]).find(Boolean);
	if (tier) return {
		overall: tier, coding: tier, reasoning: model.reasoning ? tier : "light",
		toolUse: tier, instructionFollowing: tier, confidence: "medium", source: "catalog",
	};

	return {
		overall: "unknown",
		coding: "unknown",
		reasoning: model.reasoning ? "unknown" : "light",
		toolUse: "unknown",
		instructionFollowing: "unknown",
		confidence: "low",
		source: "unknown",
	};
}

export function supportsVision(model: Model<any>): boolean {
	return model.input.includes("image");
}
