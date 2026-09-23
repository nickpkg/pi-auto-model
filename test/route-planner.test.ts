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

test("uses learned cost multipliers for cost routing", () => {
	const first = target("model-a", "first");
	const second = target("model-b", "second");
	const plan = planRoute({
		targets: [first, second],
		profile: analyzeTask({ prompt: "Explain this" }),
		policy: "cost",
		costMultipliers: new Map([[first.id, 2], [second.id, 0.5]]),
	});

	assert.equal(plan?.target.id, second.id);
});

test("cost policy picks the cheapest eligible model with no quality floor by default", () => {
	const plan = planRoute({
		targets,
		profile: analyzeTask({
			prompt: "Fix this production error, find the root cause, and add regression tests.\nError: boom\n at run (app.ts:12:3)",
		}),
		policy: "cost",
	});

	assert.equal(plan?.target.id, "cc-switch-open-router/openrouter/free");
});

test("cost policy honors a configured quality floor", () => {
	const plan = planRoute({
		targets,
		profile: analyzeTask({
			prompt: "Fix this production error, find the root cause, and add regression tests.\nError: boom\n at run (app.ts:12:3)",
		}),
		policy: "cost",
		costQualityFloor: 0.6,
	});

	assert.equal(plan?.target.id, "cc-switch-open-router/openai/gpt-5.6-luna");
});

test("cost policy ranks by per-request estimate, preferring cheap output for output-heavy tasks", () => {
	// Blended input+output sums are equal (4 + 4 vs 8 + 0), but the task
	// needs a large answer, so the cheap-output model wins per request.
	const inputHeavy = target("model-input-heavy", "first");
	inputHeavy.model.cost = { input: 8, output: 0, cacheRead: 8, cacheWrite: 8 };
	const outputHeavy = target("model-output-heavy", "second");
	outputHeavy.model.cost = { input: 4, output: 4, cacheRead: 4, cacheWrite: 4 };
	const profile = analyzeTask({ prompt: "Write a detailed design document" });
	profile.constraints.requiredOutputTokens = 60_000;

	const plan = planRoute({ targets: [inputHeavy, outputHeavy], profile, policy: "cost" });

	assert.equal(plan?.target.id, inputHeavy.id);
});

test("cost policy prefers context-price models for large contexts", () => {
	// Same total price, but with a large cached context the cheap-input
	// model wins per request.
	const cheapInput = target("model-cheap-input", "first");
	cheapInput.model.cost = { input: 1, output: 7, cacheRead: 1, cacheWrite: 1 };
	const expensiveInput = target("model-pricey-input", "second");
	expensiveInput.model.cost = { input: 7, output: 1, cacheRead: 7, cacheWrite: 7 };
	const profile = analyzeTask({ prompt: "Summarize this document" });
	profile.constraints.requiredOutputTokens = 1_000;

	const plan = planRoute({
		targets: [cheapInput, expensiveInput],
		profile,
		policy: "cost",
		contextTokens: 120_000,
	});

	assert.equal(plan?.target.id, cheapInput.id);
});

test("resolved prices override registry costs in the cost score", () => {
	const first = target("model-a", "first");
	const second = target("model-b", "second");
	const plan = planRoute({
		targets: [first, second],
		profile: analyzeTask({ prompt: "Explain this" }),
		policy: "cost",
		prices: new Map([
			[first.id, { input: 100, output: 100, source: "override", updatedAt: 0, coefficient: 1 }],
			[second.id, { input: 1, output: 1, source: "catalog", updatedAt: 0, coefficient: 1 }],
		]),
	});

	assert.equal(plan?.target.id, second.id);
	assert.equal(plan?.score.price?.source, "catalog");
	// The override's price provenance is recorded on the rejected target.
	assert.ok(plan?.reason.some((reason) => reason.includes("catalog")));
});

test("cost decisions expose price provenance in the reason", () => {
	const first = target("model-a", "first");
	const plan = planRoute({
		targets: [first],
		profile: analyzeTask({ prompt: "Explain this" }),
		policy: "cost",
		prices: new Map([
			[first.id, { input: 1.25, output: 10, source: "litellm", updatedAt: 1_000, coefficient: 1 }],
		]),
	});

	assert.equal(plan?.score.price?.source, "litellm");
	assert.ok(plan?.reason.some((reason) => reason.includes("$1.25/$10 per 1M (litellm)")));
});

test("unknown prices keep the cost score neutral", () => {
	const pricey = target("model-pricey", "first");
	pricey.model.cost = { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 };
	const cheap = target("model-cheap", "second");
	cheap.model.cost = { input: 0.5, output: 0.5, cacheRead: 0.5, cacheWrite: 0.5 };
	const unknown = target("model-unknown", "third");
	unknown.model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	const plan = planRoute({
		targets: [pricey, cheap, unknown],
		profile: analyzeTask({ prompt: "Explain this" }),
		policy: "cost",
	});

	// The zero-price model has no price data at all, so it must not be
	// treated as free; the genuinely cheapest priced model wins.
	assert.equal(plan?.target.id, cheap.id);
	assert.equal(plan?.score.price?.source, "catalog");
});

test("a known zero price ranks as free under the cost policy", () => {
	const paid = target("model-paid", "first");
	const free = target("model-free", "second");
	const plan = planRoute({
		targets: [paid, free],
		profile: analyzeTask({ prompt: "Explain this" }),
		policy: "cost",
		prices: new Map([
			[paid.id, { input: 0.1, output: 0.1, source: "litellm", updatedAt: 0, coefficient: 1 }],
			[free.id, { input: 0, output: 0, source: "override", updatedAt: 0, coefficient: 1 }],
		]),
	});

	assert.equal(plan?.target.id, free.id);
	assert.equal(plan?.score.cost, 1);
});
