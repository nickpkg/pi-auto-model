/**
 * Core routing API — usable without a Pi `ExtensionContext`.
 *
 * Other Pi extensions or external tooling can resolve a model selection
 * programmatically by calling `resolveRoute`. The function uses package
 * defaults and bundled benchmark data without requiring a live Pi session.
 *
 * @example
 * ```ts
 * import { resolveRoute } from "pi-auto-model/core";
 *
 * const selection = resolveRoute({
 *   models: availableModels,
 *   prompt: "Debug this failing test",
 *   contextTokens: 12_000,
 * });
 * // selection.target  → { provider, modelId, ... }
 * // selection.thinking → "high"
 * // selection.reason   → ["debug", "high complexity"]
 * ```
 */

import type { Model } from "@earendil-works/pi-ai";
import { analyzeTask } from "./task/local-analyzer.ts";
import { resolveCandidates, type CandidateModel } from "./routing/candidate-resolver.ts";
import { planRoute } from "./routing/route-planner.ts";
import {
	DEFAULT_CONFIG,
	type AutoModelConfig,
} from "./config/defaults.ts";
import { modelTargetId, type RouteTarget, type RoutingPolicy } from "./types.ts";

export interface CoreModel {
	model: Model<any>;
	/** Whether the model has configured authentication. */
	authenticated: boolean;
}

export interface ResolveRouteInput {
	/** Available models with authentication status. */
	models: readonly CoreModel[];
	/** The user's prompt for this turn. */
	prompt: string;
	/** Number of images attached to the prompt. */
	imageCount?: number;
	/** Current context window usage in tokens. */
	contextTokens?: number;
	/** Number of recent tool calls in the session. */
	recentToolCalls?: number;
	/** The currently active model's target ID, for stickiness. */
	currentTargetId?: string;
	/** Routing policy override. */
	policy?: RoutingPolicy;
	/** Full configuration override.  When omitted, defaults are used. */
	config?: Partial<AutoModelConfig>;
	/** Disable benchmark-based capability classification. */
	disableBenchmarks?: boolean;
}

export interface ResolveRouteResult {
	/** The selected target. */
	target: RouteTarget;
	/** Recommended thinking level. */
	thinking: import("./types.ts").ThinkingLevel;
	/** Routing policy used. */
	policy: RoutingPolicy;
	/** Human-readable reasons for the selection. */
	reason: string[];
	/** Full score breakdown. */
	score: import("./types.ts").RouteScore;
	/** All eligible targets in utility order (best first). */
	rankedTargets: RouteTarget[];
}

/**
 * Resolves a model route without a Pi `ExtensionContext`.
 *
 * This function:
 * 1. Applies benchmark overrides and capability source from config.
 * 2. Analyzes the task locally.
 * 3. Resolves and filters candidates.
 * 4. Scores and selects the best target.
 *
 * It does NOT perform classifier calls, circuit-breaker checks, quota
 * lookups, or budget enforcement — those require live session state.
 * Use the full extension for production routing with health and budget.
 */
export function resolveRoute(input: ResolveRouteInput): ResolveRouteResult | undefined {
	const config = { ...DEFAULT_CONFIG, ...input.config };

	// Analyze the task.
	const profile = analyzeTask({
		prompt: input.prompt,
		imageCount: input.imageCount,
		contextTokens: input.contextTokens,
		recentToolCalls: input.recentToolCalls,
	});

	// Resolve candidates.
	const candidates: CandidateModel[] = input.models.map((entry) => ({
		model: entry.model,
		authenticated: entry.authenticated,
	}));
	const resolution = resolveCandidates(candidates, config.constraints);
	if (resolution.targets.length === 0) {
		return undefined;
	}

	// Plan the route.
	const plan = planRoute({
		targets: resolution.targets,
		profile,
		currentTargetId: input.currentTargetId,
		contextTokens: input.contextTokens ?? 0,
		policy: input.policy ?? config.policy,
		cacheAware: config.cacheAware?.enabled !== false,
		costQualityFloor: config.costPolicy?.qualityFloor,
		capabilityOptions: input.disableBenchmarks
			? { source: undefined, overrides: {} }
			: { source: config.capabilitySource, overrides: config.benchmarkOverrides },
	});
	if (!plan) {
		return undefined;
	}

	return {
		target: plan.target,
		thinking: plan.thinking,
		policy: plan.policy,
		reason: plan.reason,
		score: plan.score,
		rankedTargets: plan.rankedTargets,
	};
}

/**
 * Convenience function to resolve a route from raw `Model` objects,
 * assuming all are authenticated.
 */
export function resolveRouteFromModels(
	models: readonly Model<any>[],
	prompt: string,
	options?: Omit<ResolveRouteInput, "models" | "prompt">,
): ResolveRouteResult | undefined {
	return resolveRoute({
		models: models.map((model) => ({ model, authenticated: true })),
		prompt,
		...options,
	});
}

export { modelTargetId } from "./types.ts";
export type { RouteTarget, TaskProfile, RouteScore, RoutingPolicy } from "./types.ts";
export type { AutoModelConfig } from "./config/defaults.ts";
export { analyzeTask } from "./task/local-analyzer.ts";
export { planRoute } from "./routing/route-planner.ts";
export { resolveCandidates } from "./routing/candidate-resolver.ts";
