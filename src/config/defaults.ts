import type {
	CandidateConstraints,
	ProviderQuotaConfig,
	RoutingPolicy,
	WeightedPoolConfig,
} from "../types.ts";
import type { BudgetConfig } from "../budget/budget.ts";

export interface AutoModelConfig {
	enabled: boolean;
	policy: RoutingPolicy;
	pool?: string;
	constraints: CandidateConstraints;
	aliases: Record<string, string>;
	quota: ProviderQuotaConfig;
	budget: BudgetConfig;
	pools: Record<string, WeightedPoolConfig>;
	classifier: { enabled: boolean; confidenceThreshold: number; timeoutMs: number };
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
		providers: {},
	},
	budget: {},
	pools: {},
	classifier: { enabled: false, confidenceThreshold: 0.5, timeoutMs: 400 },
};
