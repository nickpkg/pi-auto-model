import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	CandidateConstraints,
	CandidateResolution,
} from "../types.ts";
import {
	resolveCandidates,
	type CandidateModel,
} from "../routing/candidate-resolver.ts";

export function resolvePiCandidates(
	ctx: ExtensionContext,
	constraints: CandidateConstraints = {},
): CandidateResolution {
	const scoped = ctx.scopedModels.map(({ model }) => model);
	const models = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
	const candidates: CandidateModel[] = models.map((model) => ({
		model,
		authenticated: ctx.modelRegistry.hasConfiguredAuth(model),
	}));

	return resolveCandidates(candidates, constraints);
}

export function formatCandidateFailure(
	failure: NonNullable<CandidateResolution["failure"]>,
): string {
	const attempted = failure.models.length > 0
		? `\nModels: ${failure.models.join(", ")}`
		: "";
	return `Autoroute: no eligible model.\n${failure.message}${attempted}\nCurrent model unchanged.`;
}
