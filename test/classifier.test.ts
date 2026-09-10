import assert from "node:assert/strict";
import test from "node:test";
import { shouldClassify } from "../src/task/classifier.ts";
import { analyzeTask } from "../src/task/local-analyzer.ts";

test("only enables classifier below the configured confidence threshold", () => {
	const profile = analyzeTask({ prompt: "hello" });
	assert.equal(shouldClassify(profile, false, 1), false);
	assert.equal(shouldClassify(profile, true, 0), false);
	assert.equal(shouldClassify(profile, true, 1), true);
});
