import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBreaker } from "../src/health/circuit-breaker.ts";

test("opens after a provider failure and closes after cooldown", () => {
	const circuit = new CircuitBreaker();
	circuit.record("provider/model", 429, 1_000);
	assert.equal(circuit.isOpen("provider/model", 1_001), true);
	assert.equal(circuit.isOpen("provider/model", 61_000), false);
});

test("clears a circuit after a successful response", () => {
	const circuit = new CircuitBreaker();
	circuit.record("provider/model", 503, 1_000);
	circuit.record("provider/model", 200, 2_000);
	assert.equal(circuit.isOpen("provider/model", 2_001), false);
});
