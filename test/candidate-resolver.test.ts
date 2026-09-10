import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	resolveCandidates,
	type CandidateModel,
} from "../src/routing/candidate-resolver.ts";

function model(provider: string, id: string): Model<any> {
	return { provider, id } as Model<any>;
}

function candidate(
	provider: string,
	id: string,
	authenticated = true,
): CandidateModel {
	return { model: model(provider, id), authenticated };
}

test("does not return unauthenticated candidates", () => {
	const resolution = resolveCandidates([
		candidate("openai", "gpt-5", false),
		candidate("anthropic", "claude-sonnet", true),
	]);

	assert.deepEqual(
		resolution.targets.map((target) => target.id),
		["anthropic/claude-sonnet"],
	);
});

test("never returns a target outside allow and deny constraints", () => {
	const candidates = [
		candidate("openai", "gpt-5"),
		candidate("anthropic", "claude-sonnet"),
		candidate("openrouter", "anthropic/claude-sonnet"),
	];
	const resolution = resolveCandidates(candidates, {
		providerAllow: ["anthropic", "openrouter"],
		providerDeny: ["openrouter"],
		modelExclude: ["anthropic/claude-sonnet"],
	});

	assert.equal(resolution.targets.length, 0);
	assert.equal(resolution.failure?.reason, "filtered-by-constraints");
});

test("reports authentication and scope failures separately", () => {
	const noAuth = resolveCandidates([candidate("openai", "gpt-5", false)]);
	assert.equal(noAuth.failure?.reason, "auth-unavailable");

	const noScope = resolveCandidates([]);
	assert.equal(noScope.failure?.reason, "scope-empty");
});
