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
	return exclusionReasons(model, constraints).length === 0;
}

function exclusionReasons(
	model: Model<any>,
	constraints: CandidateConstraints,
): string[] {
	const targetId = modelTargetId(model);
	const reasons: string[] = [];
	if (constraints.providerAllow?.length && !matchesAny(model.provider, constraints.providerAllow)) {
		reasons.push("provider not in allow list");
	}
	if (constraints.modelInclude?.length && !matchesAny(targetId, constraints.modelInclude)) {
		reasons.push("model not in include list");
	}
	if (matchesAny(model.provider, constraints.providerDeny)) {
		reasons.push("provider denied");
	}
	if (matchesAny(targetId, constraints.modelExclude)) {
		reasons.push("model excluded");
	}
	return reasons;
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
			diagnostics: [],
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
			diagnostics: candidates.map(({ model }) => ({
				id: modelTargetId(model),
				authenticated: false,
				eligible: false,
				reasons: ["authentication unavailable"],
			})),
			failure: {
				reason: "auth-unavailable",
				message: "No model in the current Pi model scope has configured authentication.",
				models: candidates.map(({ model }) => modelTargetId(model)),
			},
		};
	}

	const diagnostics = candidates.map(({ model, authenticated: hasAuth }) => {
		if (!hasAuth) {
			return {
				id: modelTargetId(model),
				authenticated: false,
				eligible: false,
				reasons: ["authentication unavailable"],
			};
		}
		const reasons = exclusionReasons(model, constraints);
		return {
			id: modelTargetId(model),
			authenticated: true,
			eligible: reasons.length === 0,
			reasons,
		};
	});
	const targets = authenticated
		.map(({ model }) => model)
		.filter((model) => isAllowed(model, constraints))
		.map(toTarget);
	if (targets.length === 0) {
		return {
			targets: [],
			diagnostics,
			failure: {
				reason: "filtered-by-constraints",
				message: "All authenticated models were excluded by Pi Auto Model constraints.",
				models: authenticated.map(({ model }) => modelTargetId(model)),
			},
		};
	}

	return { targets, diagnostics };
}
