import type { CandidateConstraints, RoutingPolicy } from "../types.ts";

export interface AutoRouterConfig {
	enabled: boolean;
	policy: RoutingPolicy;
	constraints: CandidateConstraints;
	aliases: Record<string, string>;
	budget: { maxUsdPerTask?: number; onExceed?: "warn" | "downgrade" | "block" };
	classifier: { enabled: boolean; confidenceThreshold: number; timeoutMs: number };
}

export const DEFAULT_CONFIG: AutoRouterConfig = {
	enabled: true,
	policy: "balanced",
	constraints: {},
	aliases: {},
	budget: {},
	classifier: { enabled: false, confidenceThreshold: 0.5, timeoutMs: 400 },
};
