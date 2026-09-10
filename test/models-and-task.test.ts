import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { resolveModelIdentity } from "../src/models/identity.ts";
import { normalizeLogicalModels } from "../src/models/normalizer.ts";
import { analyzeTask } from "../src/task/local-analyzer.ts";
import type { RouteTarget } from "../src/types.ts";

function target(provider: string, id: string): RouteTarget {
	return {
		id: `${provider}/${id}`,
		model: { provider, id, name: id } as Model<any>,
	};
}

test("only merges models through explicit declared identities", () => {
	const targets = [
		target("anthropic", "claude-sonnet"),
		target("gateway", "sonnet-latest"),
	];
	const logicalModels = normalizeLogicalModels(targets, {
		"gateway/sonnet-latest": "anthropic:claude-sonnet",
		"anthropic/claude-sonnet": "anthropic:claude-sonnet",
	});

	assert.equal(logicalModels.length, 1);
	assert.equal(logicalModels[0].targets.length, 2);
	assert.equal(logicalModels[0].identity.confidence, "declared");
});

test("keeps unknown models isolated", () => {
	const identity = resolveModelIdentity(
		{ provider: "gateway", id: "latest-model" } as Model<any>,
	);

	assert.equal(identity.confidence, "unknown");
	assert.equal(identity.source, "isolated");
	assert.equal(identity.logicalModelId, "isolated:gateway/latest-model");
});

test("recognizes deterministic OpenRouter canonical identities", () => {
	const identity = resolveModelIdentity(
		{ provider: "openrouter", id: "anthropic/claude-sonnet" } as Model<any>,
	);

	assert.deepEqual(identity, {
		logicalModelId: "anthropic:claude-sonnet",
		confidence: "exact",
		source: "canonical",
	});
});

test("classifies a stack-trace repair request as debugging", () => {
	const profile = analyzeTask({
		prompt: "Fix this error and add a regression test.\nError: boom\n at run (app.ts:12:3)",
		recentToolCalls: 3,
	});

	assert.ok(profile.kinds.includes("debug"));
	assert.ok(profile.kinds.includes("test"));
	assert.ok(profile.semantic.debugging > 0);
	assert.ok(profile.demand.toolUse > 0);
});

test("marks image tasks as requiring vision", () => {
	const profile = analyzeTask({
		prompt: "Explain this screenshot",
		imageCount: 1,
	});

	assert.equal(profile.constraints.requiresVision, true);
	assert.equal(profile.demand.vision, 1);
});
