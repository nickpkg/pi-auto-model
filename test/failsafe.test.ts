import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { buildFallbackPending } from "../src/pi/failsafe.ts";

function model(provider: string, id: string, inputCost: number): Model<any> {
	return {
		provider,
		id,
		api: "test-api",
		name: id,
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 16_000,
		cost: { input: inputCost, output: inputCost, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
}

function makeCtx(models: Model<any>[]): never {
	return {
		scopedModels: models.map((candidate) => ({ model: candidate })),
		modelRegistry: {
			hasConfiguredAuth: () => true,
		},
	} as never;
}

function baseArgs() {
	return {
		ctx: makeCtx([model("openai", "gpt-5", 3), model("anthropic", "claude-sonnet", 1)]),
		config: DEFAULT_CONFIG,
		requestId: "req-fallback",
		sessionId: "sess-fallback",
		prompt: "Explain caching in a few sentences",
		contextTokens: 5_000,
		apisUsed: [],
	};
}

test("builds a fallback pending request from the available models", () => {
	const plan = buildFallbackPending(baseArgs());
	assert.ok(plan);
	assert.equal(plan.requestId, "req-fallback");
	assert.equal(plan.sessionId, "sess-fallback");
	assert.equal(plan.targets.length, 2);
	assert.ok(plan.profile);
	assert.ok(plan.thinking);
	assert.equal(typeof plan.estimatedCostUsd, "number");
});

test("prefers the last known-good route as the first fallback target", () => {
	const args = { ...baseArgs(), lastRouteId: "anthropic/claude-sonnet" };
	const plan = buildFallbackPending(args);
	assert.ok(plan);
	assert.equal(plan.targets[0].id, "anthropic/claude-sonnet");
});

test("ignores a lastRouteId that is no longer in the candidate list", () => {
	const args = { ...baseArgs(), lastRouteId: "disconnected/old-model" };
	const plan = buildFallbackPending(args);
	assert.ok(plan);
	assert.ok(plan.targets.every((target) => target.id !== "disconnected/old-model"));
});

test("caps the fallback target list to failover.maxAttempts", () => {
	const args = {
		...baseArgs(),
		config: { ...DEFAULT_CONFIG, failover: { maxAttempts: 1 } },
	};
	const plan = buildFallbackPending(args);
	assert.ok(plan);
	assert.equal(plan.targets.length, 1);
});

test("returns undefined when no real models are available", () => {
	const args = { ...baseArgs(), ctx: makeCtx([]) };
	assert.equal(buildFallbackPending(args), undefined);
});

test("does not bypass hard context or vision constraints", () => {
	const tiny = { ...model("openai", "tiny", 1), contextWindow: 1_000 };
	assert.equal(buildFallbackPending({ ...baseArgs(), ctx: makeCtx([tiny]), contextTokens: 5_000 }), undefined);
	assert.equal(buildFallbackPending({ ...baseArgs(), imageCount: 1 }), undefined);
});

test("does not retry explicitly excluded unhealthy targets", () => {
	const plan = buildFallbackPending({ ...baseArgs(), excludedTargetIds: ["openai/gpt-5"] });
	assert.ok(plan);
	assert.ok(plan.targets.every((target) => target.id !== "openai/gpt-5"));
});

test("returns undefined when candidate resolution throws", () => {
	const args = { ...baseArgs(), ctx: { bad: true } as never };
	assert.equal(buildFallbackPending(args), undefined);
});

test("fallback preserves exact pins, capability pins and restricted pools", () => {
	const args = baseArgs();
	assert.equal(buildFallbackPending({ ...args, pinnedTargetId: "missing/model" }), undefined);
	assert.deepEqual(buildFallbackPending({ ...args, pinnedTargetId: "anthropic/claude-sonnet" })?.targets.map((t) => t.id), ["anthropic/claude-sonnet"]);
	assert.deepEqual(buildFallbackPending({ ...args, minimumTier: "frontier" })?.targets.map((t) => t.id), ["openai/gpt-5"]);
	const pool = { targets: [{ id: "missing/model", weight: 1 }], fallback: "none" as const };
	assert.equal(buildFallbackPending({ ...args, config: { ...DEFAULT_CONFIG, pool: "restricted", pools: { restricted: pool } } }), undefined);
	assert.ok(buildFallbackPending({ ...args, config: { ...DEFAULT_CONFIG, pool: "restricted", pools: { restricted: { ...pool, fallback: "any" } } } }));
});

test("keeps the prefix text to strip on the fallback request", () => {
	const args = { ...baseArgs(), prompt: "@high Explain caching", prefixToStrip: "@high " };
	const plan = buildFallbackPending(args);
	assert.ok(plan);
	assert.equal(plan.prefixToStrip, "@high ");
});

test("carries failover.firstOutputTimeoutMs into the fallback request", () => {
	const args = {
		...baseArgs(),
		config: {
			...DEFAULT_CONFIG,
			failover: { maxAttempts: 3, firstOutputTimeoutMs: 60_000 },
		},
	};
	const plan = buildFallbackPending(args);
	assert.ok(plan);
	assert.equal(plan.firstOutputTimeoutMs, 60_000);
});

test("leaves firstOutputTimeoutMs off when the config does not set it", () => {
	const plan = buildFallbackPending(baseArgs());
	assert.ok(plan);
	assert.equal(plan.firstOutputTimeoutMs, undefined);
});
