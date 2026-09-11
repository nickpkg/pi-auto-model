import type { Model } from "@earendil-works/pi-ai";
import {
	modelTargetId,
	type CandidateConstraints,
	type CandidateResolution,
	type RouteTarget,
} from "../types.ts";

export interface CandidateModel {
	model: Model<any>;
	authenticated: boolean;
}

function matchesPattern(value: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const expression = new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "i");
	return expression.test(value);
}

function matchesAny(value: string, patterns: readonly string[] | undefined): boolean {
	return patterns?.some((pattern) => matchesPattern(value, pattern)) ?? false;
}

function isAllowed(
	model: Model<any>,
	constraints: CandidateConstraints,
): boolean {
	const targetId = modelTargetId(model);
	const providerAllowed =
		!constraints.providerAllow?.length ||
		matchesAny(model.provider, constraints.providerAllow);
	const modelAllowed =
		!constraints.modelInclude?.length ||
		matchesAny(targetId, constraints.modelInclude);

	return (
		providerAllowed &&
		modelAllowed &&
		!matchesAny(model.provider, constraints.providerDeny) &&
		!matchesAny(targetId, constraints.modelExclude)
	);
}

function toTarget(model: Model<any>): RouteTarget {
	return { model, id: modelTargetId(model) };
}

export function resolveCandidates(
	candidates: readonly CandidateModel[],
	constraints: CandidateConstraints = {},
): CandidateResolution {
	if (candidates.length === 0) {
		return {
			targets: [],
			failure: {
				reason: "scope-empty",
				message: "No models are available in the current Pi model scope.",
				models: [],
			},
		};
	}

	const authenticated = candidates.filter((candidate) => candidate.authenticated);
	if (authenticated.length === 0) {
		return {
			targets: [],
			failure: {
				reason: "auth-unavailable",
				message: "No model in the current Pi model scope has configured authentication.",
				models: candidates.map(({ model }) => modelTargetId(model)),
			},
		};
	}

	const targets = authenticated
		.map(({ model }) => model)
		.filter((model) => isAllowed(model, constraints))
		.map(toTarget);
	if (targets.length === 0) {
		return {
			targets: [],
			failure: {
				reason: "filtered-by-constraints",
				message: "All authenticated models were excluded by Pi Auto Model constraints.",
				models: authenticated.map(({ model }) => modelTargetId(model)),
			},
		};
	}

	return { targets };
}
