import assert from "node:assert/strict";
import test from "node:test";
import { parseClassifierResult, mergeClassifierResult } from "../src/task/classifier.ts";
import { analyzeTask } from "../src/task/local-analyzer.ts";

test("parses a full structured classifier response", () => {
	const result = parseClassifierResult(JSON.stringify({
		complexity: 0.8,
		kind: "debug",
		kinds: ["debug", "test"],
		minTier: "strong",
		requiresReasoning: true,
		requiresVision: false,
		highRisk: true,
	}));
	assert.equal(result?.complexity, 0.8);
	assert.equal(result?.kind, "debug");
	assert.deepEqual(result?.kinds, ["debug", "test"]);
	assert.equal(result?.minTier, "strong");
	assert.equal(result?.requiresReasoning, true);
	assert.equal(result?.requiresVision, false);
	assert.equal(result?.highRisk, true);
});

test("parses a partial response with only complexity", () => {
	const result = parseClassifierResult('{"complexity":0.3}');
	assert.equal(result?.complexity, 0.3);
	assert.equal(result?.kind, undefined);
});

test("rejects malformed JSON", () => {
	assert.equal(parseClassifierResult("not json"), undefined);
});

test("rejects non-object JSON", () => {
	assert.equal(parseClassifierResult("[1,2,3]"), undefined);
	assert.equal(parseClassifierResult('"string"'), undefined);
	assert.equal(parseClassifierResult("42"), undefined);
});

test("rejects empty object", () => {
	assert.equal(parseClassifierResult("{}"), undefined);
});

test("filters invalid task kinds", () => {
	const result = parseClassifierResult(JSON.stringify({
		kinds: ["debug", "invalid-kind", "test"],
	}));
	assert.deepEqual(result?.kinds, ["debug", "test"]);
});

test("filters invalid tier", () => {
	const result = parseClassifierResult('{"minTier":"god-tier"}');
	assert.equal(result?.minTier, undefined);
});

test("clamps complexity to valid range", () => {
	const result = parseClassifierResult('{"complexity":1.5}');
	// parseClassifierResult only validates range; mergeClassifierResult clamps.
	assert.equal(result, undefined);

	const result2 = parseClassifierResult('{"complexity":-0.5}');
	assert.equal(result2, undefined);
});

test("mergeClassifierResult overrides complexity", () => {
	const profile = analyzeTask({ prompt: "hello" });
	const merged = mergeClassifierResult(profile, { complexity: 0.9 });
	assert.equal(merged.complexity, 0.9);
	assert.ok(merged.confidence >= 0.65);
});

test("mergeClassifierResult enforces the requested minimum tier", () => {
	const merged = mergeClassifierResult(analyzeTask({ prompt: "hello" }), { minTier: "strong" });
	assert.equal(merged.constraints.minimumTier, "strong");
});

test("mergeClassifierResult overrides task kind", () => {
	const profile = analyzeTask({ prompt: "hello" });
	const merged = mergeClassifierResult(profile, { kind: "debug" });
	assert.ok(merged.kinds.includes("debug"));
});

test("mergeClassifierResult boosts reasoning demand when required", () => {
	const profile = analyzeTask({ prompt: "hello" });
	const merged = mergeClassifierResult(profile, { requiresReasoning: true });
	assert.ok(merged.demand.reasoning >= 0.7);
});

test("mergeClassifierResult reduces reasoning demand when not required", () => {
	const profile = analyzeTask({ prompt: "Fix this production error, find the root cause" });
	const merged = mergeClassifierResult(profile, { requiresReasoning: false });
	assert.ok(merged.demand.reasoning <= 0.3);
});

test("mergeClassifierResult sets vision requirement", () => {
	const profile = analyzeTask({ prompt: "explain this code" });
	const merged = mergeClassifierResult(profile, { requiresVision: true });
	assert.equal(merged.constraints.requiresVision, true);
	assert.equal(merged.demand.vision, 1);
});

test("mergeClassifierResult adjusts risk", () => {
	const profile = analyzeTask({ prompt: "deploy to production" });
	const merged = mergeClassifierResult(profile, { highRisk: true });
	assert.ok(merged.risk >= 0.6);
});
