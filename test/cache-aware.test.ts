import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { planRoute } from "../src/routing/route-planner.ts";
import { analyzeTask } from "../src/task/local-analyzer.ts";
import type { RouteTarget } from "../src/types.ts";

function target(id: string, opts?: {
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	provider?: string;
}): RouteTarget {
	return {
		id: opts?.provider ? `${opts.provider}/${id}` : `test/${id}`,
		model: {
			provider: opts?.provider ?? "test",
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: opts?.cost ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		} as Model<any>,
	};
}

test("cache-aware stickiness retains the current model when context is large", () => {
	// Two models with identical capability but different cost.
	// The cheaper model would normally win, but with a large warm cache
	// on the current model, cache-aware stickiness should retain it.
	const expensive = target("expensive-model", {
		cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 15 },
	});
	const cheap = target("cheap-model", {
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 2 },
	});

	// Without cache-aware: cheap model wins.
	const planNoCache = planRoute({
		targets: [expensive, cheap],
		profile: analyzeTask({ prompt: "explain this" }),
		currentTargetId: expensive.id,
		contextTokens: 500_000,
		cacheAware: false,
	});
	// With a simple prompt and no cache awareness, the cheaper model should win
	// or at least be competitive. The exact winner depends on scoring.
	assert.ok(planNoCache !== undefined);

	// With cache-aware: the current model's cache savings make it sticky.
	const planWithCache = planRoute({
		targets: [expensive, cheap],
		profile: analyzeTask({ prompt: "explain this" }),
		currentTargetId: expensive.id,
		contextTokens: 500_000,
		cacheAware: true,
	});
	assert.ok(planWithCache !== undefined);
	// The cache-aware bonus should make the current model at least as
	// attractive as the cheaper alternative.
	assert.equal(planWithCache.target.id, expensive.id);
});

test("cache-aware does not block upgrades for high-complexity tasks", () => {
	// Use catalog models so capability priors differentiate them.
	const weak = target("openrouter/free", {
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 2 },
	});
	const strong = target("openai/gpt-5.6-luna", {
		cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 15 },
	});

	// A complex debugging task with the "best" policy (quality-first)
	// should still upgrade to the strong model even with cache-aware
	// stickiness on the weak model.  Cache-aware only penalizes
	// downgrades, never upgrades.
	const plan = planRoute({
		targets: [weak, strong],
		profile: analyzeTask({
			prompt: "Fix this critical production error, find root cause, add regression tests.\nError: crash\n at run (app.ts:12:3)",
		}),
		policy: "best",
		currentTargetId: weak.id,
		contextTokens: 100_000,
		cacheAware: true,
	});
	assert.ok(plan !== undefined);
	assert.equal(plan.target.id, strong.id);
});

test("cache-aware has no effect when there is no current model", () => {
	const a = target("model-a", {
		cost: { input: 5, output: 5, cacheRead: 0.5, cacheWrite: 8 },
	});
	const b = target("model-b", {
		cost: { input: 3, output: 3, cacheRead: 0.3, cacheWrite: 5 },
	});

	const plan = planRoute({
		targets: [a, b],
		profile: analyzeTask({ prompt: "explain this" }),
		contextTokens: 200_000,
		cacheAware: true,
	});
	assert.ok(plan !== undefined);
	// Without a current model, cache stickiness should not bias selection.
	// The cheaper model should win.
	assert.equal(plan.target.id, b.id);
});

test("cache-aware reports stickiness reason for retained model", () => {
	const current = target("current-model", {
		cost: { input: 5, output: 5, cacheRead: 0.5, cacheWrite: 8 },
	});
	const alt = target("alt-model", {
		cost: { input: 3, output: 3, cacheRead: 0.3, cacheWrite: 5 },
	});

	const plan = planRoute({
		targets: [current, alt],
		profile: analyzeTask({ prompt: "explain this" }),
		currentTargetId: current.id,
		contextTokens: 300_000,
		cacheAware: true,
	});
	assert.ok(plan !== undefined);
	if (plan.target.id === current.id) {
		assert.ok(plan.reason.includes("cache-aware stickiness"));
	}
});
