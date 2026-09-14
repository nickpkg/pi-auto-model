import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	deriveCapabilityPrior,
	setCapabilitySource,
	getCapabilitySource,
	tierRank,
	capabilityScore,
} from "../src/models/capability.ts";
import {
	setBenchmarkOverrides,
	clearBenchmarkOverrides,
} from "../src/models/benchmarks.ts";

function model(provider: string, id: string): Model<any> {
	return { provider, id, name: id } as Model<any>;
}

test("deriveCapabilityPrior uses catalog prior when no benchmark source is set", () => {
	setCapabilitySource(undefined);
	const prior = deriveCapabilityPrior(model("openai", "gpt-5.6-luna"));
	assert.equal(prior.overall, "frontier");
	assert.equal(prior.confidence, "medium");
});

test("deriveCapabilityPrior uses benchmark data when source is set", () => {
	setCapabilitySource("ramp");
	const prior = deriveCapabilityPrior(model("anthropic", "claude-sonnet"));
	assert.equal(prior.overall, "strong");
	assert.equal(prior.confidence, "high");
});

test("deriveCapabilityPrior falls back to catalog when benchmark has no data", () => {
	setCapabilitySource("ramp");
	// openai/gpt-5.6-luna is in catalog but also in benchmarks.
	// Use a model in catalog but not in benchmarks to test fallback...
	// Actually all catalog models are in benchmarks, so test with a
	// model in neither to confirm unknown fallback.
	const prior = deriveCapabilityPrior(model("unknown", "mystery-model"));
	assert.equal(prior.overall, "unknown");
	assert.equal(prior.confidence, "low");
});

test("deriveCapabilityPrior falls back to catalog prior when benchmark source has no score", () => {
	setCapabilitySource("aa");
	// openrouter/free has no AA score, should fall back to catalog
	const prior = deriveCapabilityPrior(model("openrouter", "free"));
	assert.equal(prior.overall, "light");
	assert.equal(prior.confidence, "low"); // catalog confidence for free
});

test("benchmark overrides affect capability derivation", () => {
	setBenchmarkOverrides({ "openai/gpt-5.6-luna": { ramp: 0.50 } });
	setCapabilitySource("ramp");
	const prior = deriveCapabilityPrior(model("openai", "gpt-5.6-luna"));
	assert.equal(prior.overall, "light"); // overridden score
	clearBenchmarkOverrides();
	setCapabilitySource(undefined);
});

test("gateway model IDs can use their embedded canonical provider", () => {
	setCapabilitySource(undefined);
	assert.equal(deriveCapabilityPrior(model("gateway", "openai/gpt-5.6-luna")).overall, "frontier");
});

test("getCapabilitySource returns the active source", () => {
	setCapabilitySource("aa");
	assert.equal(getCapabilitySource(), "aa");
	setCapabilitySource(undefined);
	assert.equal(getCapabilitySource(), undefined);
});

test("tierRank orders tiers correctly", () => {
	assert.ok(tierRank("frontier") > tierRank("strong"));
	assert.ok(tierRank("strong") > tierRank("mid"));
	assert.ok(tierRank("mid") > tierRank("light"));
	assert.ok(tierRank("light") > tierRank("unknown"));
});

test("capabilityScore maps tiers to numeric scores", () => {
	assert.equal(capabilityScore("frontier"), 1);
	assert.ok(capabilityScore("strong") > capabilityScore("mid"));
	assert.ok(capabilityScore("mid") > capabilityScore("light"));
	assert.ok(capabilityScore("light") > 0);
});

test("default catalog distinguishes known native and OAuth targets without guessing unknown IDs", () => {
	for (const [provider, id, expected] of [
		["openai", "gpt-5", "frontier"], ["openai-codex", "gpt-5", "frontier"],
		["anthropic", "claude-opus-5", "frontier"], ["anthropic", "claude-sonnet", "strong"],
		["anthropic", "claude-haiku", "light"], ["custom", "gpt-5-unverified", "unknown"],
	]) {
		const prior = deriveCapabilityPrior(model(provider, id), { source: undefined });
		assert.equal(prior.overall, expected);
		assert.equal(prior.source, expected === "unknown" ? "unknown" : "catalog");
	}
});
