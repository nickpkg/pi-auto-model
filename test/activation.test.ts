import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	handleModelSelect,
} from "../src/pi/activation.ts";
import { SessionLock } from "../src/pi/session-lock.ts";
import { createInitialState, type ModelSelectEvent } from "../src/types.ts";

function model(provider: string, id: string): Model<any> {
	return { provider, id, api: "test" } as Model<any>;
}

function event(modelValue: Model<any>, source: string): ModelSelectEvent {
	return {
		type: "model_select",
		model: modelValue,
		previousModel: undefined,
		source,
	};
}

test("selecting the virtual model enables automatic routing", () => {
	const state = createInitialState("session", model("openai", "gpt-5"), new SessionLock());

	assert.equal(handleModelSelect(event(model("pi-auto-model", "auto"), "set"), state), "auto");
	assert.equal(state.activation, "active");
	assert.equal(state.sessionRoute.provider, undefined);
	assert.equal(state.sessionRoute.modelId, undefined);
});

test("manually selecting a concrete model suspends automatic routing", () => {
	const state = createInitialState("session", model("pi-auto-model", "auto"), new SessionLock());
	state.activation = "active";

	assert.equal(handleModelSelect(event(model("openai", "gpt-5"), "set"), state), "manual");
	assert.equal(state.activation, "suspended-by-user");
});

test("internal model changes do not suspend automatic routing", () => {
	const state = createInitialState("session", model("pi-auto-model", "auto"), new SessionLock());
	state.activation = "active";
	state.inFlightSelfSet = 1;

	assert.equal(handleModelSelect(event(model("openai", "gpt-5"), "set"), state), "internal");
	assert.equal(state.activation, "active");
});
