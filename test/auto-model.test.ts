import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	AUTO_MODEL_ID,
	AUTO_MODEL_PROVIDER,
	AUTO_MODEL_TARGET_ID,
	isAutoModel,
} from "../src/pi/auto-model.ts";

function model(provider: string, id: string): Model<any> {
	return { provider, id } as Model<any>;
}

test("identifies the virtual auto model", () => {
	assert.equal(AUTO_MODEL_TARGET_ID, "pi-auto-model/auto");
	assert.equal(isAutoModel(model(AUTO_MODEL_PROVIDER, AUTO_MODEL_ID)), true);
	assert.equal(isAutoModel(model("openai", "gpt-5")), false);
	assert.equal(isAutoModel(undefined), false);
});
