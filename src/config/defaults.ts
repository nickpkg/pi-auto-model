import type {
	CandidateConstraints,
	ProviderQuotaConfig,
	RoutingPolicy,
	WeightedPoolConfig,
} from "../types.ts";
import type { BudgetConfig } from "../budget/budget.ts";
import type { BenchmarkSource } from "../models/benchmarks.ts";

/** Manual price override for one model (USD per 1M tokens). */
export interface PriceOverrideConfig {
	/** USD per 1M input tokens. */
	input?: number;
	/** USD per 1M output tokens. */
	output?: number;
	/** USD per 1M cache-read tokens. */
	cacheRead?: number;
	/** USD per 1M cache-write tokens. */
	cacheWrite?: number;
	/** Effective-price multiplier for this model (subscription/discount). */
	costCoef?: number;
}

/** Price resolution settings for the cost policy. */
export interface PricingConfig {
	/** Manual price overrides keyed by target ID (`provider/model`) or bare model ID. */
	overrides?: Record<string, PriceOverrideConfig>;
	/** Global effective-price multiplier (subscription/discount). */
	costCoef?: number;
	/** LiteLLM external price cache. */
	litellm?: {
		/** Set false to use registry prices only. Defaults to true. */
		enabled?: boolean;
		/** Custom catalog URL. Defaults to BerriAI/litellm's model_prices_and_context_window.json. */
		url?: string;
		/** Refresh interval in hours. Defaults to 24 (1 day). */
		refreshHours?: number;
	};
}

export interface AutoModelConfig {
	enabled: boolean;
	policy: RoutingPolicy;
	pool?: string;
	constraints: CandidateConstraints;
	aliases: Record<string, string>;
	quota: ProviderQuotaConfig;
	budget: BudgetConfig;
	pools: Record<string, WeightedPoolConfig>;
	failover: import("../types.ts").FailoverConfig;
	classifier: { enabled: boolean; confidenceThreshold: number; timeoutMs: number };
	/** Active benchmark source for capability classification. */
	capabilitySource?: BenchmarkSource;
	/** User-supplied benchmark score overrides, keyed by `provider/model`. */
	benchmarkOverrides?: Record<string, { ramp?: number; aa?: number }>;
	/** Cache-aware stickiness settings. */
	cacheAware?: { enabled: boolean };
	/** Record the automatic choice while keeping the current real target. */
	shadow?: { enabled: boolean };
	/** Cost-policy tuning. `qualityFloor` (0-1) sets an optional minimum quality score for cost routing; 0 disables the floor. */
	costPolicy?: { qualityFloor?: number };
	/** Price resolution: overrides, multipliers, and the LiteLLM price cache. */
	pricing?: PricingConfig;
}

export const DEFAULT_CONFIG: AutoModelConfig = {
	enabled: true,
	policy: "balanced",
	pool: undefined,
	constraints: {},
	aliases: {},
	quota: {
		enabled: true,
		windowMs: 24 * 60 * 60 * 1000,
		staleAfterMs: 60 * 60 * 1000,
		providers: {},
	},
	budget: {},
	pools: {},
	failover: { maxAttempts: 3 },
	classifier: { enabled: false, confidenceThreshold: 0.5, timeoutMs: 400 },
	capabilitySource: undefined,
	benchmarkOverrides: undefined,
	cacheAware: { enabled: true },
	shadow: { enabled: false },
	costPolicy: undefined,
};
