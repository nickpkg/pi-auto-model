import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
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
