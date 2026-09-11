import type { Model } from "@earendil-works/pi-ai";
import { capabilityScore, deriveCapabilityPrior, supportsVision } from "../models/capability.ts";
import {
	modelTargetId,
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
}

function costOf(model: Model<any>): number | undefined {
	const cost = model.cost.input + model.cost.output;
	return cost > 0 ? cost : undefined;
}

function costScore(target: RouteTarget, targets: readonly RouteTarget[]): number {
	if (target.model.id.includes("/free")) {
		return 1;
	}

	const knownCosts = targets.map(({ model }) => costOf(model)).filter((value): value is number => value !== undefined);
	const cost = costOf(target.model);
	if (!cost || knownCosts.length === 0) {
		return 0.5;
	}

	const minimum = Math.min(...knownCosts);
	const maximum = Math.max(...knownCosts);
	return maximum === minimum ? 0.5 : 1 - (cost - minimum) / (maximum - minimum);
}

function qualityScore(target: RouteTarget, profile: TaskProfile): number {
	const capability = deriveCapabilityPrior(target.model);
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
): boolean {
	if (profile.constraints.requiresVision && !supportsVision(target.model)) {
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
} {
	switch (policy) {
		case "best":
			return { quality: 0.7, cost: 0.05, stickiness: 0.08, quota: 0.08, pool: 0.09 };
		case "price":
			return { quality: 0.35, cost: 0.32, stickiness: 0.08, quota: 0.12, pool: 0.13 };
		case "fast":
			return { quality: 0.48, cost: 0.13, stickiness: 0.15, quota: 0.12, pool: 0.12 };
		case "balanced":
			return { quality: 0.5, cost: 0.16, stickiness: 0.12, quota: 0.11, pool: 0.11 };
	}
}

function weightedPoolScore(
	target: RouteTarget,
	pool: WeightedPoolConfig | undefined,
	attempts: ReadonlyMap<string, number> | undefined,
	eligibleTargets: readonly RouteTarget[],
): number | undefined {
	if (!pool) return undefined;
	const weightsById = new Map(
		pool.targets
			.filter((entry) => entry.weight > 0)
			.map((entry) => [entry.id, entry.weight]),
	);
	const targetWeight = weightsById.get(target.id);
	if (!targetWeight) return 0;
	const poolTargets = eligibleTargets.filter((candidate) => weightsById.has(candidate.id));
	if (poolTargets.length === 0) return 0;
	const projectedShares = poolTargets.map((candidate) =>
		((attempts?.get(candidate.id) ?? 0) + 1) / (weightsById.get(candidate.id) ?? 1),
	);
	const minimum = Math.min(...projectedShares);
	const maximum = Math.max(...projectedShares);
	const projected = ((attempts?.get(target.id) ?? 0) + 1) / targetWeight;
	return maximum === minimum ? 0.5 : 1 - (projected - minimum) / (maximum - minimum);
}

function scoreTarget(
	target: RouteTarget,
	input: RoutePlannerInput,
	eligibleTargets: readonly RouteTarget[],
): RouteScore {
	const quality = qualityScore(target, input.profile);
	const cost = costScore(target, eligibleTargets);
	const stickiness = modelTargetId(target.model) === input.currentTargetId ? 1 : 0;
	const quota = quotaScore(input.quota?.get(target.model.provider));
	const pool = weightedPoolScore(target, input.pool, input.poolAttempts, eligibleTargets);
	const policy = input.policy ?? "balanced";
	const scoreWeights = weights(policy);
	return {
		targetId: target.id,
		quality,
		cost,
		stickiness,
		quota,
		pool,
		utility:
			quality * scoreWeights.quality +
			cost * scoreWeights.cost +
			stickiness * scoreWeights.stickiness +
			quota * scoreWeights.quota +
			(pool ?? 0.5) * scoreWeights.pool +
			(input.preferences?.[target.id] ?? 0),
	};
}

function explanation(
	profile: TaskProfile,
	target: RouteTarget,
	score: RouteScore,
	quota?: ProviderQuotaSignal,
): string[] {
	const reasons: string[] = profile.kinds.filter((kind) => kind !== "mixed").slice(0, 2);
	if (profile.complexity >= 0.6) reasons.push("high complexity");
	if (profile.constraints.requiresVision) reasons.push("vision required");
	if (score.cost >= 0.9) reasons.push("low cost");
	if (score.quota !== undefined && score.quota < 0.3) reasons.push("quota pressure");
	if (quota && quota.status !== "unknown") {
		const uvi = quota.uvi === undefined ? "" : ` UVI ${quota.uvi.toFixed(2)}`;
		reasons.push(`quota ${quota.status}${uvi}`);
	}
	if (score.pool !== undefined && score.pool < 0.3) reasons.push("pool allocation above target");
	if (reasons.length === 0) reasons.push(`capability tier ${deriveCapabilityPrior(target.model).overall}`);
	return reasons;
}

export function planRoute(input: RoutePlannerInput): RoutePlan | undefined {
	const policy = input.policy ?? "balanced";
	const contextTokens = input.contextTokens ?? 0;
	const poolTargets = input.pool
		? input.targets.filter((target) => input.pool?.targets.some((entry) => entry.id === target.id && entry.weight > 0))
		: input.targets;
	const eligibleTargets = poolTargets.filter((target) =>
		canSatisfyHardConstraints(target, input.profile, contextTokens),
	);
	if (eligibleTargets.length === 0) {
		return undefined;
	}

	const scores = eligibleTargets
		.map((target) => ({ target, score: scoreTarget(target, input, eligibleTargets) }))
		.sort((left, right) => right.score.utility - left.score.utility);
	let selected = scores[0];

	if (policy === "price") {
		const qualityFloor = 0.6;
		const affordable = scores.filter(({ score }) => score.quality >= qualityFloor);
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
		),
	};
}
