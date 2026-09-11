import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { planRoute } from "../src/routing/route-planner.ts";
import { analyzeTask } from "../src/task/local-analyzer.ts";
import type { RouteTarget } from "../src/types.ts";

function target(id: string, provider = "cc-switch-open-router"): RouteTarget {
	return {
		id: `${provider}/${id}`,
		model: {
			provider,
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		} as Model<any>,
	};
}

const targets = [
	target("openrouter/free"),
	target("deepseek/deepseek-v4-flash-0731"),
	target("openai/gpt-5.6-luna"),
];

test("prefers the low-cost light model for a simple request", () => {
	const plan = planRoute({
		targets,
		profile: analyzeTask({ prompt: "你好" }),
	});

	assert.equal(plan?.target.id, "cc-switch-open-router/openrouter/free");
});

test("prefers a higher-capability model for debugging with a stack trace", () => {
	const plan = planRoute({
		targets,
		profile: analyzeTask({
			prompt: "Fix this production error, find the root cause, and add regression tests.\nError: boom\n at run (app.ts:12:3)",
		}),
	});

	assert.equal(plan?.target.id, "cc-switch-open-router/openai/gpt-5.6-luna");
	assert.notEqual(plan?.thinking, "off");
});

test("retains the current target when the improvement is below stickiness threshold", () => {
	const plan = planRoute({
		targets: [target("deepseek/deepseek-v4-flash-0731"), target("z-ai/glm-5.3-flash")],
		profile: analyzeTask({ prompt: "Explain this function" }),
		currentTargetId: "cc-switch-open-router/z-ai/glm-5.3-flash",
		contextTokens: 500_000,
	});

	assert.equal(plan?.target.id, "cc-switch-open-router/z-ai/glm-5.3-flash");
});

test("does not choose a model that cannot satisfy vision requirements", () => {
	const textOnly = target("openai/gpt-5.6-luna");
	textOnly.model.input = ["text"];
	const vision = target("deepseek/deepseek-v4-flash-0731");
	vision.model.input = ["text", "image"];

	const plan = planRoute({
		targets: [textOnly, vision],
		profile: analyzeTask({ prompt: "Explain this screenshot", imageCount: 1 }),
	});

	assert.equal(plan?.target.id, vision.id);
});

test("enforces a classifier minimum capability tier", () => {
	const profile = analyzeTask({ prompt: "hello" });
	profile.constraints.minimumTier = "strong";
	const plan = planRoute({
		targets: [target("openrouter/free"), target("openai/gpt-5.6-luna")],
		profile,
	});

	assert.equal(plan?.target.id, "cc-switch-open-router/openai/gpt-5.6-luna");
});

test("uses weighted-fair allocation inside a configured pool", () => {
	const first = target("openai/gpt-5");
	const second = target("anthropic/claude-sonnet");
	const plan = planRoute({
		targets: [first, second],
		profile: analyzeTask({ prompt: "Explain this function" }),
		pool: {
			targets: [
				{ id: first.id, weight: 9 },
				{ id: second.id, weight: 1 },
			],
		},
		poolAttempts: new Map([
			[first.id, 9],
			[second.id, 0],
		]),
	});

	assert.equal(plan?.target.id, second.id);
	assert.ok(plan?.reason.includes("pool allocation above target") === false);
});

test("pool excludes targets that are not members", () => {
	const first = target("openai/gpt-5");
	const second = target("anthropic/claude-sonnet");
	const plan = planRoute({
		targets: [first, second],
		profile: analyzeTask({ prompt: "Explain this function" }),
		pool: { targets: [{ id: second.id, weight: 1 }] },
	});

	assert.equal(plan?.target.id, second.id);
});

test("uses latency observations and provider pool membership", () => {
	const fast = target("openai/gpt-5", "openai");
	const slow = target("anthropic/claude-sonnet", "anthropic");
	const plan = planRoute({
		targets: [fast, slow],
		profile: analyzeTask({ prompt: "Check service latency and operations health" }),
		policy: "fast",
		latencyP95Ms: new Map([[fast.id, 100], [slow.id, 1_000]]),
		pool: { providers: [{ id: "openai", weight: 1 }] },
	});

	assert.equal(plan?.target.id, fast.id);
	assert.ok((plan?.score.latency ?? 0) >= 0.5);
});

test("uses learned cost multipliers for price routing", () => {
	const first = target("model-a", "first");
	const second = target("model-b", "second");
	const plan = planRoute({
		targets: [first, second],
		profile: analyzeTask({ prompt: "Explain this" }),
		policy: "price",
		costMultipliers: new Map([[first.id, 2], [second.id, 0.5]]),
	});

	assert.equal(plan?.target.id, second.id);
});
