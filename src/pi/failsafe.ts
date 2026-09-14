import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoModelConfig } from "../config/defaults.ts";
import { analyzeTask } from "../task/local-analyzer.ts";
import { chooseThinkingLevel } from "../routing/thinking-router.ts";
import { estimateCost } from "../budget/budget.ts";
import { planRoute } from "../routing/route-planner.ts";
import type { PendingStreamRequest } from "./stream-proxy.ts";
import { resolvePiCandidates } from "./registry-adapter.ts";
import type { CapabilityTier } from "../types.ts";

/**
 * Fail-safe routing.
 *
 * Builds a best-effort plan when the normal routing pipeline cannot produce
 * one. Hard model compatibility and caller-supplied health/quota exclusions
 * still apply.
 *
 * Exact pins and pool restrictions remain authoritative. Intentional policy
 * stops must not invoke this fallback; per-dispatch budget checks still apply.
 */
export interface FallbackPendingArgs {
	ctx: ExtensionContext;
	config: AutoModelConfig;
	requestId: string;
	sessionId: string;
	prompt: string;
	imageCount?: number;
	contextTokens: number;
	/** APIs already used in the session, for cross-API thinking stripping. */
	apisUsed: readonly string[];
	/** Prefix pin text to strip from the prompt before sending. */
	prefixToStrip?: string;
	/** Last known-good route id (`provider/model`), preferred when available. */
	lastRouteId?: string;
	excludedTargetIds?: readonly string[];
	excludedProviders?: readonly string[];
	pinnedTargetId?: string;
	minimumTier?: CapabilityTier;
}

/**
 * Builds a pending stream request from the best available real targets, or
 * returns undefined when no real model can be reached at all.
 */
export function buildFallbackPending(args: FallbackPendingArgs): PendingStreamRequest | undefined {
	let targets: ReturnType<typeof resolvePiCandidates>["targets"];
	try {
		targets = resolvePiCandidates(args.ctx, args.config.constraints).targets;
	} catch {
		// Candidate enumeration must never raise: report nothing to route.
		return undefined;
	}
	targets = targets.filter((target) =>
		(!args.pinnedTargetId || target.id === args.pinnedTargetId) &&
		!args.excludedTargetIds?.includes(target.id) &&
		!args.excludedProviders?.includes(target.model.provider),
	);
	if (targets.length === 0) {
		return undefined;
	}
	const profile = analyzeTask({
		prompt: args.prompt,
		imageCount: args.imageCount,
		contextTokens: args.contextTokens,
	});
	profile.constraints.minimumTier = args.minimumTier;
	const pool = args.config.pool ? args.config.pools[args.config.pool] : undefined;
	if (args.config.pool && !pool) return undefined;
	let route = planRoute({
		targets,
		pool,
		profile,
		contextTokens: args.contextTokens,
		policy: "balanced",
		capabilityOptions: { source: args.config.capabilitySource, overrides: args.config.benchmarkOverrides },
	});
	if (!route && pool?.fallback === "any") route = planRoute({
		targets, profile, contextTokens: args.contextTokens,
		capabilityOptions: { source: args.config.capabilitySource, overrides: args.config.benchmarkOverrides },
	});
	if (!route) return undefined;

	// Prefer the last known-good eligible route, then the planner's remaining
	// hard-constraint-safe candidates.
	const ordered = [...route.rankedTargets];
	if (args.lastRouteId) {
		const index = ordered.findIndex((target) => target.id === args.lastRouteId);
		if (index >= 0) {
			const [last] = ordered.splice(index, 1);
			ordered.unshift(last);
		}
	}

	const maxAttempts = Math.max(1, args.config.failover?.maxAttempts ?? 3);
	const preferred = ordered.slice(0, maxAttempts);
	const first = preferred[0];

	return {
		targets: preferred,
		thinking: chooseThinkingLevel(first.model, profile),
		profile,
		requestId: args.requestId,
		sessionId: args.sessionId,
		estimatedCostUsd: estimateCost(first, args.contextTokens, profile),
		apisUsed: args.apisUsed,
		prefixToStrip: args.prefixToStrip,
		firstOutputTimeoutMs: args.config.failover?.firstOutputTimeoutMs,
	};
}
