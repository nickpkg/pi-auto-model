import type { RouteTarget, TaskProfile } from "../types.ts";

export type BudgetAction = "allow" | "warn" | "downgrade" | "block";

export interface BudgetConfig {
	maxUsdPerTask?: number;
	onExceed?: Exclude<BudgetAction, "allow">;
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
