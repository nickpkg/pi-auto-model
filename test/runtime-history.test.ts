import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeStateStore } from "../src/pi/runtime-store.ts";

test("keeps only the most recent twenty route decisions", () => {
	const store = new RuntimeStateStore();
	const state = store.getOrCreate("session-1");
	for (let index = 0; index < 25; index++) {
		store.recordDecision(state, {
			id: `route-${index}`,
			targetId: "provider/model",
			thinking: "low",
			policy: "balanced",
			reason: ["test"],
			score: { targetId: "provider/model", quality: 0, cost: 0, stickiness: 0, utility: index },
			taskKinds: ["mixed"],
			createdAt: index,
		});
	}
	assert.equal(state.decisionHistory.length, 20);
	assert.equal(state.lastDecision?.id, "route-24");
	assert.equal(state.decisionHistory[0].id, "route-24");
	assert.equal(state.decisionHistory.at(-1)?.id, "route-5");
});
