import type { Model } from "@earendil-works/pi-ai";
import { capabilityScore, deriveCapabilityPrior, supportsVision } from "../models/capability.ts";
import {
	modelTargetId,
	type RoutePlan,
	type RouteScore,
	type RouteTarget,
	type RoutingPolicy,
	type TaskProfile,
} from "../types.ts";
import { chooseThinkingLevel } from "./thinking-router.ts";

export interface RoutePlannerInput {
	targets: readonly RouteTarget[];
	profile: TaskProfile;
	currentTargetId?: string;
	contextTokens?: number;
	policy?: RoutingPolicy;
	preferences?: Readonly<Record<string, number>>;
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

function weights(policy: RoutingPolicy): { quality: number; cost: number; stickiness: number } {
	switch (policy) {
		case "best":
			return { quality: 0.85, cost: 0.05, stickiness: 0.1 };
		case "price":
			return { quality: 0.45, cost: 0.45, stickiness: 0.1 };
		case "fast":
			return { quality: 0.6, cost: 0.2, stickiness: 0.2 };
		case "balanced":
			return { quality: 0.65, cost: 0.2, stickiness: 0.15 };
	}
}

function scoreTarget(
	target: RouteTarget,
	input: RoutePlannerInput,
	eligibleTargets: readonly RouteTarget[],
): RouteScore {
	const quality = qualityScore(target, input.profile);
	const cost = costScore(target, eligibleTargets);
	const stickiness = modelTargetId(target.model) === input.currentTargetId ? 1 : 0;
	const policy = input.policy ?? "balanced";
	const scoreWeights = weights(policy);
	return {
		targetId: target.id,
		quality,
		cost,
		stickiness,
		utility:
			quality * scoreWeights.quality +
			cost * scoreWeights.cost +
			stickiness * scoreWeights.stickiness +
			(input.preferences?.[target.id] ?? 0),
	};
}

function explanation(profile: TaskProfile, target: RouteTarget, score: RouteScore): string[] {
	const reasons: string[] = profile.kinds.filter((kind) => kind !== "mixed").slice(0, 2);
	if (profile.complexity >= 0.6) reasons.push("high complexity");
	if (profile.constraints.requiresVision) reasons.push("vision required");
	if (score.cost >= 0.9) reasons.push("low cost");
	if (reasons.length === 0) reasons.push(`capability tier ${deriveCapabilityPrior(target.model).overall}`);
	return reasons;
}

export function planRoute(input: RoutePlannerInput): RoutePlan | undefined {
	const policy = input.policy ?? "balanced";
	const contextTokens = input.contextTokens ?? 0;
	const eligibleTargets = input.targets.filter((target) =>
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
		reason: explanation(input.profile, selected.target, selected.score),
	};
}
