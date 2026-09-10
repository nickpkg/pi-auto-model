import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBudget } from "../src/budget/budget.ts";

test("uses downgrade as the default budget response", () => {
	assert.equal(evaluateBudget(2, { maxUsdPerTask: 1 }), "downgrade");
});

test("honors explicit budget actions", () => {
	assert.equal(evaluateBudget(2, { maxUsdPerTask: 1, onExceed: "warn" }), "warn");
	assert.equal(evaluateBudget(2, { maxUsdPerTask: 1, onExceed: "block" }), "block");
	assert.equal(evaluateBudget(0.5, { maxUsdPerTask: 1, onExceed: "block" }), "allow");
});
