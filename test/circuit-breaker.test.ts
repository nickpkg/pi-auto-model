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

test("honors a longer provider retry window", () => {
	const circuit = new CircuitBreaker();
	circuit.record("provider/model", 429, 1_000, 120_000);

	assert.equal(circuit.isOpen("provider/model", 61_000), true);
	assert.equal(circuit.isOpen("provider/model", 120_001), false);
});

test("transitions to half-open when cooldown expires", () => {
	const circuit = new CircuitBreaker();
	circuit.record("provider/model", 503, 1_000);
	assert.equal(circuit.getState("provider/model", 1_001), "open");
	// Cooldown expired: isOpen returns false, state transitions to half-open.
	assert.equal(circuit.isOpen("provider/model", 61_000), false);
	assert.equal(circuit.getState("provider/model", 61_000), "half-open");
});

test("closes the circuit after a successful probe in half-open", () => {
	const circuit = new CircuitBreaker();
	circuit.record("provider/model", 503, 1_000);
	// Expire cooldown → half-open.
	circuit.isOpen("provider/model", 61_000);
	assert.equal(circuit.getState("provider/model", 61_000), "half-open");
	// Probe succeeds → circuit closes.
	circuit.record("provider/model", 200, 62_000);
	assert.equal(circuit.getState("provider/model", 62_001), "closed");
	assert.equal(circuit.isOpen("provider/model", 62_001), false);
});

test("re-opens the circuit after a failed probe in half-open", () => {
	const circuit = new CircuitBreaker();
	circuit.record("provider/model", 503, 1_000);
	// Expire cooldown → half-open.
	circuit.isOpen("provider/model", 61_000);
	assert.equal(circuit.getState("provider/model", 61_000), "half-open");
	// Probe fails → circuit re-opens with continued backoff.
	circuit.record("provider/model", 503, 62_000);
	assert.equal(circuit.getState("provider/model", 62_001), "open");
	// New cooldown should be longer (2nd failure = 120s).
	assert.equal(circuit.isOpen("provider/model", 62_001), true);
	assert.equal(circuit.isOpen("provider/model", 182_000), false);
});

test("tryAcquireProbe returns true for half-open targets without in-flight probe", () => {
	const circuit = new CircuitBreaker();
	circuit.record("provider/model", 503, 1_000);
	circuit.isOpen("provider/model", 61_000); // → half-open
	assert.equal(circuit.tryAcquireProbe("provider/model", 61_000), true);
	// Second call should fail (probe already in flight).
	assert.equal(circuit.tryAcquireProbe("provider/model", 61_000), false);
});

test("tryAcquireProbe returns false for closed and open targets", () => {
	const circuit = new CircuitBreaker();
	// Closed target: no probe needed.
	assert.equal(circuit.tryAcquireProbe("closed/model", 1_000), false);
	// Open target: still in cooldown.
	circuit.record("open/model", 503, 1_000);
	assert.equal(circuit.tryAcquireProbe("open/model", 2_000), false);
});

test("releaseProbe allows a subsequent probe attempt", () => {
	const circuit = new CircuitBreaker();
	circuit.record("provider/model", 503, 1_000);
	circuit.isOpen("provider/model", 61_000); // → half-open
	assert.equal(circuit.tryAcquireProbe("provider/model", 61_000), true);
	circuit.releaseProbe("provider/model");
	assert.equal(circuit.tryAcquireProbe("provider/model", 61_000), true);
});

test("snapshot includes status and probeInFlight fields", () => {
	const circuit = new CircuitBreaker();
	circuit.record("provider/model", 503, 1_000);
	circuit.isOpen("provider/model", 61_000); // → half-open
	circuit.tryAcquireProbe("provider/model", 61_000);
	const snap = circuit.snapshot();
	const state = snap.get("provider/model");
	assert.ok(state);
	assert.equal(state!.status, "half-open");
	assert.equal(state!.probeInFlight, true);
});
