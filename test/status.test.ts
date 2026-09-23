import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { RuntimeStateStore } from "../src/pi/runtime-store.ts";
import { SessionLock } from "../src/pi/session-lock.ts";
import { createInitialState } from "../src/types.ts";
import { formatFooterStatus } from "../src/ui/status.ts";

function model(provider: string, id: string): Model<any> {
	return { provider, id, api: "test" } as Model<any>;
}

test("formats a compact active status with route and policy", () => {
	const state = createInitialState("session", model("pi-auto-model", "auto"), new SessionLock());
	state.activation = "active";
	state.lastDecision = {
		id: "route-1",
		targetId: "anthropic/claude-sonnet",
		thinking: "high",
		policy: "best",
		reason: ["debugging"],
		score: { targetId: "anthropic/claude-sonnet", quality: 1, cost: 0, stickiness: 0, utility: 1 },
		taskKinds: ["debug"],
		createdAt: Date.now(),
	};

	assert.equal(
		formatFooterStatus(state, model("anthropic", "claude-sonnet")),
		"Auto ON · anthropic/claude-sonnet · best · none · anthropic/claude-sonnet",
	);
});

test("does not present the model selected before startup as a route", () => {
	const store = new RuntimeStateStore();
	const state = store.getOrCreate(
		"session",
		model("cc-switch-open-router", "z-ai/glm-5.3-flash"),
	);
	state.activation = "active";

	assert.deepEqual(state.sessionRoute, { apisUsed: ["test"] });
	assert.equal(
		formatFooterStatus(state, model("pi-auto-model", "auto")),
		"Auto ON · none · balanced · none · pi-auto-model/auto",
	);
});
