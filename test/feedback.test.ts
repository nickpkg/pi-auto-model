import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { applyFeedback } from "../src/routing/feedback.ts";
import { planRoute } from "../src/routing/route-planner.ts";
import { analyzeTask } from "../src/task/local-analyzer.ts";
import type { RouteTarget } from "../src/types.ts";

function target(id: string, inputCost: number): RouteTarget {
	return {
		id: `cc-switch-open-router/${id}`,
		model: {
			provider: "cc-switch-open-router",
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: inputCost, output: inputCost, cacheRead: 0, cacheWrite: 0 },
		} as Model<any>,
	};
}

test("caps explicit feedback preference", () => {
	assert.equal(applyFeedback(0.1, "good"), 0.1);
	assert.equal(applyFeedback(-0.1, "bad"), -0.1);
});

test("accumulates feedback in bounded steps", () => {
	let preference = 0;
	for (let vote = 0; vote < 20; vote += 1) {
		preference = applyFeedback(preference, "bad");
	}
	assert.equal(preference, -0.1);
	assert.equal(applyFeedback(0, "good"), 0.02);
});

test("negative feedback can move routing away from a target", () => {
	const cheap = target("openrouter/free", 0);
	const other = target("z-ai/glm-5.3-flash", 1);
	const profile = analyzeTask({ prompt: "你好" });

	const before = planRoute({ targets: [cheap, other], profile });
	assert.equal(before?.target.id, cheap.id);

	const after = planRoute({
		targets: [cheap, other],
		profile,
		preferences: { [cheap.id]: -0.1, [other.id]: 0.1 },
	});
	assert.equal(after?.target.id, other.id);
});
