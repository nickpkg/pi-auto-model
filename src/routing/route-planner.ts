import type { Model } from "@earendil-works/pi-ai";
import { capabilityScore, deriveCapabilityPrior, supportsVision, tierRank, type CapabilityOptions } from "../models/capability.ts";
import {
	modelTargetId,
	normalizeRoutingPolicy,
	type RoutePlan,
	type RouteScore,
	type RouteTarget,
	type RoutingPolicy,
	type TaskProfile,
	type ProviderQuotaSignal,
	type WeightedPoolConfig,
} from "../types.ts";
import { chooseThinkingLevel } from "./thinking-router.ts";
import { quotaScore } from "../quota/uvi.ts";
import type { QualitySignal } from "./quality-learning.ts";

export interface RoutePlannerInput {
	targets: readonly RouteTarget[];
	profile: TaskProfile;
	currentTargetId?: string;
	contextTokens?: number;
	policy?: RoutingPolicy;
	preferences?: Readonly<Record<string, number>>;
	quota?: ReadonlyMap<string, ProviderQuotaSignal>;
	pool?: WeightedPoolConfig;
	poolAttempts?: ReadonlyMap<string, number>;
	latencyP95Ms?: ReadonlyMap<string, number>;
	quality?: ReadonlyMap<string, QualitySignal>;
	/** Soft actual/estimated cost ratio learned from completed turns. */
	costMultipliers?: ReadonlyMap<string, number>;
	/** Enable prompt-cache-aware stickiness economics. */
	cacheAware?: boolean;
	/** Minimum quality score required for cost-policy selection. Defaults to 0 (no floor). */
	costQualityFloor?: number;
	capabilityOptions?: CapabilityOptions;
}

function costOf(model: Model<any>): number | undefined {
	const cost = model.cost.input + model.cost.output;
	return cost > 0 ? cost : undefined;
}

/**
 * Per-token input cost, falling back to 0 when missing.
 */
function inputPerToken(model: Model<any>): number {
	return model.cost?.input ?? 0;
}

/**
 * Per-token cache-read cost, falling back to input cost when unknown.
 */
function cacheReadPerToken(model: Model<any>): number {
	const cr = model.cost?.cacheRead;
	return cr !== undefined && cr >= 0 ? cr : inputPerToken(model);
}

/**
 * Per-token cache-write cost, falling back to input cost when unknown.
 */
function cacheWritePerToken(model: Model<any>): number {
	const cw = model.cost?.cacheWrite;
	return cw !== undefined && cw >= 0 ? cw : inputPerToken(model);
}

/**
 * Computes the cache-write tax for switching from `current` to `candidate`.
 *
 * The tax is the one-time cost of writing the full conversation context
 * into the candidate model's prompt cache.  If the candidate does not
 * support caching (cacheWrite == input), the tax is zero because there
 * is no additional write cost — but there is also no future cache-read
 * benefit, which the caller handles separately.
 *
 * Returns a cost in the same units as `model.cost.input` (per-token).
 */
function cacheWriteTax(current: Model<any> | undefined, candidate: Model<any>, contextTokens: number): number {
	if (!current || contextTokens <= 0) return 0;
	const writeCost = cacheWritePerToken(candidate);
	const inputCost = inputPerToken(candidate);
	// The tax is the *additional* write cost over a normal input request.
	// If cacheWrite == input, there is no extra tax (the tokens would be
	// sent as input anyway), but also no future cache-read benefit.
	const taxPerToken = Math.max(0, writeCost - inputCost);
	return taxPerToken * contextTokens;
}

/**
 * Computes the warm-read savings of staying on `current` instead of
 * switching to `candidate`.
 *
 * The savings come from paying cache-read instead of full input on the
 * cached portion of the context.  We assume the full context is cached
 * on the current model (optimistic but represents the steady-state).
 *
 * Returns a cost in the same units as `model.cost.input` (per-token).
 */
function warmReadSavings(current: Model<any> | undefined, candidate: Model<any>, contextTokens: number): number {
	if (!current || contextTokens <= 0) return 0;
	const currentInput = inputPerToken(current);
	const currentCacheRead = cacheReadPerToken(current);
	const candidateInput = inputPerToken(candidate);
	// Staying: pay cacheRead on cached tokens.
	// Switching: pay input (or cacheWrite) on all tokens on the new model.
	// Savings = (switching cost) - (staying cost) on the context portion.
	const stayingContextCost = currentCacheRead * contextTokens;
	const switchingContextCost = candidateInput * contextTokens;
	return Math.max(0, switchingContextCost - stayingContextCost);
}

/**
 * Returns a normalized cache stickiness bonus for the current target,
 * or a penalty for switching, based on cache economics.
 *
 * - When the target IS the current model: returns a bonus proportional
 *   to warm-read savings (capped at 0.08 utility).
 * - When the target is NOT the current model AND is NOT more capable
 *   (i.e. a downgrade or lateral move): returns a penalty proportional
 *   to the cache-write tax (capped at -0.08 utility).
 * - When the target is MORE capable than the current (an upgrade): no
 *   penalty, so capability upgrades are never blocked by cache economics.
 *
 * Returns 0 when cache-aware is disabled or no current model is set.
 */
function cacheStickinessAdjustment(
	target: RouteTarget,
	input: RoutePlannerInput,
	eligibleTargets: readonly RouteTarget[],
): number {
	if (!input.cacheAware) return 0;
	const currentId = input.currentTargetId;
	if (!currentId) return 0;
	const contextTokens = input.contextTokens ?? 0;
	if (contextTokens <= 0) return 0;

	const currentTarget = eligibleTargets.find((t) => t.id === currentId);
	const currentModel = currentTarget?.model;
	if (!currentModel) return 0;

	if (target.id === currentId) {
		// Bonus for staying: proportional to warm-read savings relative
		// to the cheapest alternative's input cost.
		const cheapestAlternative = eligibleTargets
			.filter((t) => t.id !== currentId)
			.sort((a, b) => inputPerToken(a.model) - inputPerToken(b.model))[0];
		if (!cheapestAlternative) return 0;
		const savings = warmReadSavings(currentModel, cheapestAlternative.model, contextTokens);
		// Normalize: cap the bonus at 0.08 utility.
		return Math.min(0.08, savings / 100_000);
	}

	// For switching: only penalize downgrades, never upgrades.
	const currentTier = tierRank(deriveCapabilityPrior(currentModel, input.capabilityOptions).overall);
	const candidateTier = tierRank(deriveCapabilityPrior(target.model, input.capabilityOptions).overall);
	if (candidateTier > currentTier) {
		// This is an upgrade — no cache penalty.
		return 0;
	}

	// Downgrade or lateral move: apply cache-write tax penalty.
	const tax = cacheWriteTax(currentModel, target.model, contextTokens);
	return -Math.min(0.08, tax / 100_000);
}

function effectiveCost(target: RouteTarget, multipliers?: ReadonlyMap<string, number>): number | undefined {
	const cost = costOf(target.model);
	return cost === undefined ? undefined : cost * (multipliers?.get(target.id) ?? 1);
}

function costScore(target: RouteTarget, targets: readonly RouteTarget[], multipliers?: ReadonlyMap<string, number>): number {
	if (target.model.id.includes("/free")) {
		return 1;
	}

	const knownCosts = targets.map((candidate) => effectiveCost(candidate, multipliers)).filter((value): value is number => value !== undefined);
	const cost = effectiveCost(target, multipliers);
	if (!cost || knownCosts.length === 0) {
		return 0.5;
	}

	const minimum = Math.min(...knownCosts);
	const maximum = Math.max(...knownCosts);
	return maximum === minimum ? 0.5 : 1 - (cost - minimum) / (maximum - minimum);
}

function qualityScore(target: RouteTarget, profile: TaskProfile, capabilityOptions?: CapabilityOptions): number {
	const capability = deriveCapabilityPrior(target.model, capabilityOptions);
	const dimensions: Array<[number, number]> = [
		[profile.demand.coding, capabilityScore(capability.coding ?? capability.overall)],
		[profile.demand.reasoning, capabilityScore(capability.reasoning ?? capability.overall)],
		[profile.demand.toolUse, capabilityScore(capability.toolUse ?? capability.overall)],
		[
			profile.demand.instructionFollowing,
			capabilityScore(capability.instructionFollowing ?? capability.overall),
		],
	];
	const totalDemand = dimensions.reduce((total, [demand]) => total + demand, 0);
	if (totalDemand === 0) {
		return capabilityScore(capability.overall);
	}

	const shortfall = dimensions.reduce(
		(total, [demand, score]) => total + demand * Math.max(0, demand - score) ** 2,
		0,
	);
	const overallGap = 1 - capabilityScore(capability.overall);
	const complexityPenalty = profile.complexity * overallGap * 0.7;
	const riskPenalty = profile.risk * overallGap * 0.5;
	return Math.max(0, 1 - shortfall / totalDemand - complexityPenalty - riskPenalty);
}

function canSatisfyHardConstraints(
	target: RouteTarget,
	profile: TaskProfile,
	contextTokens: number,
	capabilityOptions?: CapabilityOptions,
): boolean {
	if (profile.constraints.requiresVision && !supportsVision(target.model)) {
		return false;
	}
	if (profile.constraints.minimumTier && tierRank(deriveCapabilityPrior(target.model, capabilityOptions).overall) < tierRank(profile.constraints.minimumTier)) {
		return false;
	}

	const safetyAdjustedContext = Math.ceil(Math.max(contextTokens, profile.constraints.requiredContextTokens) * 1.15);
	return (
		safetyAdjustedContext + profile.constraints.requiredOutputTokens <= target.model.contextWindow &&
		target.model.maxTokens >= profile.constraints.requiredOutputTokens
	);
}

function weights(policy: RoutingPolicy): {
	quality: number;
	cost: number;
	stickiness: number;
	quota: number;
	pool: number;
	latency: number;
	reliability: number;
} {
	switch (policy) {
		case "best":
			return { quality: 0.55, cost: 0.04, stickiness: 0.05, quota: 0.07, pool: 0.08, latency: 0.1, reliability: 0.11 };
		case "cost":
		case "price":
			return { quality: 0.26, cost: 0.3, stickiness: 0.05, quota: 0.1, pool: 0.1, latency: 0.08, reliability: 0.11 };
		case "fast":
			return { quality: 0.32, cost: 0.1, stickiness: 0.1, quota: 0.1, pool: 0.1, latency: 0.16, reliability: 0.12 };
		case "balanced":
			return { quality: 0.38, cost: 0.13, stickiness: 0.09, quota: 0.1, pool: 0.1, latency: 0.1, reliability: 0.1 };
	}
}

function poolEntries(pool: WeightedPoolConfig | undefined): {
	targets: Map<string, number>;
	providers: Map<string, number>;
} {
	return {
		targets: new Map((pool?.targets ?? [])
			.filter((entry) => entry.weight > 0)
			.map((entry) => [entry.id, entry.weight])),
		providers: new Map((pool?.providers ?? [])
			.filter((entry) => entry.weight > 0)
			.map((entry) => [entry.id, entry.weight])),
	};
}

function weightedPoolScore(
	target: RouteTarget,
	pool: WeightedPoolConfig | undefined,
	attempts: ReadonlyMap<string, number> | undefined,
	eligibleTargets: readonly RouteTarget[],
): number | undefined {
	if (!pool) return undefined;
	const { targets: targetWeights, providers: providerWeights } = poolEntries(pool);
	const hasTargetPool = targetWeights.size > 0;
	const hasProviderPool = providerWeights.size > 0;
	const weightFor = (candidate: RouteTarget): number | undefined => {
		const targetWeight = targetWeights.get(candidate.id);
		const providerWeight = providerWeights.get(candidate.model.provider);
		if (hasTargetPool && targetWeight === undefined) return undefined;
		if (hasProviderPool && providerWeight === undefined) return undefined;
		return (targetWeight ?? 1) * (providerWeight ?? 1);
	};
	const targetWeight = weightFor(target);
	if (!targetWeight) return 0;
	const poolTargets = eligibleTargets.filter((candidate) => weightFor(candidate) !== undefined);
	if (poolTargets.length === 0) return 0;
	const projectedShares = poolTargets.map((candidate) =>
		((attempts?.get(candidate.id) ?? 0) + 1) / (weightFor(candidate) ?? 1),
	);
	const minimum = Math.min(...projectedShares);
	const maximum = Math.max(...projectedShares);
	const projected = ((attempts?.get(target.id) ?? 0) + 1) / targetWeight;
	return maximum === minimum ? 0.5 : 1 - (projected - minimum) / (maximum - minimum);
}

function latencyScore(target: RouteTarget, input: RoutePlannerInput, eligibleTargets: readonly RouteTarget[]): number {
	const values = eligibleTargets
		.map((candidate) => input.latencyP95Ms?.get(candidate.id))
		.filter((value): value is number => value !== undefined && value > 0);
	const current = input.latencyP95Ms?.get(target.id);
	if (current === undefined || values.length < 2) return 0.5;
	const minimum = Math.min(...values);
	const maximum = Math.max(...values);
	return maximum === minimum ? 0.5 : 1 - (current - minimum) / (maximum - minimum);
}

function scoreTarget(
	target: RouteTarget,
	input: RoutePlannerInput,
	eligibleTargets: readonly RouteTarget[],
): RouteScore {
	const quality = qualityScore(target, input.profile, input.capabilityOptions);
	const cost = costScore(target, eligibleTargets, input.costMultipliers);
	const stickiness = modelTargetId(target.model) === input.currentTargetId ? 1 : 0;
	const latency = latencyScore(target, input, eligibleTargets);
	const learning = input.quality?.get(target.id);
	const reliability = learning?.score ?? 0.5;
	const quota = quotaScore(input.quota?.get(target.model.provider));
	const pool = weightedPoolScore(target, input.pool, input.poolAttempts, eligibleTargets);
	const policy = normalizeRoutingPolicy(input.policy) ?? "balanced";
	const scoreWeights = weights(policy);
	const cacheAdjustment = cacheStickinessAdjustment(target, input, eligibleTargets);
	return {
		targetId: target.id,
		quality,
		cost,
		stickiness,
		latency,
		reliability,
		quota,
		pool,
		utility:
			quality * scoreWeights.quality +
			cost * scoreWeights.cost +
			stickiness * scoreWeights.stickiness +
			latency * scoreWeights.latency * (0.5 + input.profile.latencySensitivity * 0.5) +
			reliability * scoreWeights.reliability +
			quota * scoreWeights.quota +
			(pool ?? 0.5) * scoreWeights.pool +
			(input.preferences?.[target.id] ?? 0) * 0.5 +
			cacheAdjustment,
	};
}

function explanation(
	profile: TaskProfile,
	target: RouteTarget,
	score: RouteScore,
	quota?: ProviderQuotaSignal,
	quality?: QualitySignal,
	cacheAware?: boolean,
	isCurrentTarget?: boolean,
	capabilityOptions?: CapabilityOptions,
): string[] {
	const reasons: string[] = profile.kinds.filter((kind) => kind !== "mixed").slice(0, 2);
	if (profile.complexity >= 0.6) reasons.push("high complexity");
	if (profile.constraints.requiresVision) reasons.push("vision required");
	if (score.cost >= 0.9) reasons.push("low cost");
	if (score.latency !== undefined && score.latency >= 0.8 && profile.latencySensitivity >= 0.6) reasons.push("low latency");
	if (quality) reasons.push(quality.reason);
	if (score.quota !== undefined && score.quota < 0.3) reasons.push("quota pressure");
	if (quota && quota.status !== "unknown") {
		const uvi = quota.uvi === undefined ? "" : ` UVI ${quota.uvi.toFixed(2)}`;
		reasons.push(`quota ${quota.status}${uvi}`);
	}
	if (score.pool !== undefined && score.pool < 0.3) reasons.push("pool allocation above target");
	if (cacheAware && isCurrentTarget) reasons.push("cache-aware stickiness");
	const capability = deriveCapabilityPrior(target.model, capabilityOptions);
	reasons.push(`capability ${capability.overall} (${capability.source ?? "catalog"}, ${capability.confidence} confidence)`);
	return reasons;
}

export function planRoute(input: RoutePlannerInput): RoutePlan | undefined {
	const policy = normalizeRoutingPolicy(input.policy) ?? "balanced";
	const contextTokens = input.contextTokens ?? 0;
	const poolTargets = input.pool
		? input.targets.filter((target) => {
			const { targets, providers } = poolEntries(input.pool);
			return (targets.size === 0 || targets.has(target.id)) &&
				(providers.size === 0 || providers.has(target.model.provider));
		})
		: input.targets;
	const eligibleTargets = poolTargets.filter((target) =>
		canSatisfyHardConstraints(target, input.profile, contextTokens, input.capabilityOptions),
	);
	if (eligibleTargets.length === 0) {
		return undefined;
	}

	const scores = eligibleTargets
		.map((target) => ({ target, score: scoreTarget(target, input, eligibleTargets) }))
		.sort((left, right) => right.score.utility - left.score.utility);
	let selected = scores[0];

	if (policy === "cost") {
		const qualityFloor = Math.min(1, Math.max(0, input.costQualityFloor ?? 0));
		const affordable = qualityFloor > 0
			? scores.filter(({ score }) => score.quality >= qualityFloor)
			: scores;
		if (affordable.length > 0) {
			selected = affordable.sort((left, right) => right.score.cost - left.score.cost)[0];
		}
	}

	const current = scores.find(({ score }) => score.targetId === input.currentTargetId);
	const contextPenalty = Math.min(contextTokens / selected.target.model.contextWindow, 1) * 0.12;
	if (current && selected.score.utility - current.score.utility <= 0.05 + contextPenalty) {
		selected = current;
	}

	return {
		target: selected.target,
		thinking: chooseThinkingLevel(selected.target.model, input.profile),
		policy,
		score: selected.score,
		reason: explanation(
			input.profile,
			selected.target,
			selected.score,
			input.quota?.get(selected.target.model.provider),
			input.quality?.get(selected.target.id),
			input.cacheAware,
			selected.target.id === input.currentTargetId,
			input.capabilityOptions,
		),
		rankedTargets: scores.map((entry) => entry.target),
	};
}
