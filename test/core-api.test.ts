import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { resolveRoute, resolveRouteFromModels } from "../src/core.ts";
import { clearBenchmarkOverrides, getBenchmark } from "../src/models/benchmarks.ts";

function model(provider: string, id: string, opts?: {
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	input?: string[];
}): Model<any> {
	return {
		provider,
		id,
		name: id,
		reasoning: true,
		input: opts?.input ?? ["text"],
		contextWindow: opts?.contextWindow ?? 1_000_000,
		maxTokens: 128_000,
		cost: opts?.cost ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
}

const models = [
	{ model: model("test", "openrouter/free"), authenticated: true },
	{ model: model("test", "qwen/qwen3.8-flash"), authenticated: true },
	{ model: model("test", "openai/gpt-5.6-luna"), authenticated: true },
];

test("resolves a route for a simple prompt", () => {
	const result = resolveRoute({
		models,
		prompt: "hello",
		disableBenchmarks: true,
	});
	assert.ok(result !== undefined);
	assert.equal(result.target.id, "test/openrouter/free");
	assert.ok(result.reason.length > 0);
	assert.ok(result.rankedTargets.length > 0);
});

test("resolves a route for a complex debugging prompt", () => {
	const result = resolveRoute({
		models,
		prompt: "Fix this production error, find the root cause, and add regression tests.\nError: boom\n at run (app.ts:12:3)",
		disableBenchmarks: true,
	});
	assert.ok(result !== undefined);
	// Should prefer the higher-capability model for debugging.
	assert.equal(result.target.id, "test/openai/gpt-5.6-luna");
	assert.notEqual(result.thinking, "off");
});

test("returns undefined when no models are authenticated", () => {
	const result = resolveRoute({
		models: [{ model: models[0].model, authenticated: false }],
		prompt: "hello",
		disableBenchmarks: true,
	});
	assert.equal(result, undefined);
});

test("returns undefined when no models are provided", () => {
	const result = resolveRoute({
		models: [],
		prompt: "hello",
		disableBenchmarks: true,
	});
	assert.equal(result, undefined);
});

test("respects policy override", () => {
	const result = resolveRoute({
		models,
		prompt: "explain this function",
		policy: "price",
		disableBenchmarks: true,
	});
	assert.ok(result !== undefined);
	assert.equal(result.policy, "price");
	assert.equal(result.target.id, "test/openrouter/free");
});

test("respects constraints to exclude models", () => {
	const result = resolveRoute({
		models,
		prompt: "hello",
		config: {
			constraints: { modelExclude: ["*free*"] },
		},
		disableBenchmarks: true,
	});
	assert.ok(result !== undefined);
	assert.notEqual(result.target.id, "test/openrouter/free");
});

test("resolveRouteFromModels assumes all authenticated", () => {
	const result = resolveRouteFromModels(
		[model("test", "openrouter/free"), model("test", "openai/gpt-5.6-luna")],
		"hello",
		{ disableBenchmarks: true },
	);
	assert.ok(result !== undefined);
	assert.equal(result.target.id, "test/openrouter/free");
});

test("handles vision requirements", () => {
	const textModel = model("test", "openai/gpt-5.6-luna", { input: ["text"] });
	const visionModel = model("test", "qwen/qwen3.8-flash", { input: ["text", "image"] });
	const result = resolveRoute({
		models: [
			{ model: textModel, authenticated: true },
			{ model: visionModel, authenticated: true },
		],
		prompt: "Explain this screenshot",
		imageCount: 1,
		disableBenchmarks: true,
	});
	assert.ok(result !== undefined);
	assert.equal(result.target.id, "test/qwen/qwen3.8-flash");
});

test("applies cache-aware stickiness for current model", () => {
	const result = resolveRoute({
		models,
		prompt: "explain this",
		currentTargetId: "test/qwen/qwen3.8-flash",
		contextTokens: 500_000,
		disableBenchmarks: true,
	});
	assert.ok(result !== undefined);
	// With cache-aware stickiness (default on) and a large context,
	// the current model should be retained.
	assert.equal(result.target.id, "test/qwen/qwen3.8-flash");
});

test("does not leak benchmark overrides into other callers", () => {
	clearBenchmarkOverrides();
	const before = getBenchmark("openai/gpt-5.6-luna");
	resolveRoute({
		models,
		prompt: "hello",
		config: { benchmarkOverrides: { "openai/gpt-5.6-luna": { ramp: 0.1 } } },
	});
	assert.deepEqual(getBenchmark("openai/gpt-5.6-luna"), before);
});
