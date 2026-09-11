import assert from "node:assert/strict";
import test from "node:test";
import {
	tierFromBenchmark,
	getBenchmark,
	setBenchmarkOverrides,
	clearBenchmarkOverrides,
	benchmarkScore,
	RAMP_THRESHOLDS,
	AA_THRESHOLDS,
	BENCHMARK_PROVENANCE,
} from "../src/models/benchmarks.ts";

test("classifies Ramp scores into capability tiers", () => {
	assert.equal(tierFromBenchmark("openai/gpt-5", "ramp"), "frontier");
	assert.equal(tierFromBenchmark("deepseek/deepseek-v4-flash-0731", "ramp"), "mid");
	assert.equal(tierFromBenchmark("qwen/qwen3.8-flash", "ramp"), "light");
	assert.equal(tierFromBenchmark("openrouter/free", "ramp"), "light");
});

test("classifies AA scores into capability tiers", () => {
	assert.equal(tierFromBenchmark("openai/gpt-5", "aa"), "frontier");
	assert.equal(tierFromBenchmark("anthropic/claude-sonnet", "aa"), "strong");
	assert.equal(tierFromBenchmark("google/gemini-flash-latest", "aa"), "mid");
	assert.equal(tierFromBenchmark("google/gemini-flash-lite-latest", "aa"), "light");
});

test("returns undefined for unknown models", () => {
	assert.equal(tierFromBenchmark("unknown/model", "ramp"), undefined);
	assert.equal(tierFromBenchmark("unknown/model", "aa"), undefined);
});

test("returns undefined when the selected source has no data", () => {
	// openrouter/free has no AA score
	assert.equal(tierFromBenchmark("openrouter/free", "aa"), undefined);
});

test("user overrides merge over bundled data", () => {
	setBenchmarkOverrides({ "openai/gpt-5": { ramp: 0.50 } });
	assert.equal(tierFromBenchmark("openai/gpt-5", "ramp"), "light");
	// AA should still use bundled data
	assert.equal(tierFromBenchmark("openai/gpt-5", "aa"), "frontier");
	clearBenchmarkOverrides();
	assert.equal(tierFromBenchmark("openai/gpt-5", "ramp"), "frontier");
});

test("benchmarkScore returns raw numeric value", () => {
	assert.equal(benchmarkScore("openai/gpt-5", "ramp"), 0.88);
	assert.equal(benchmarkScore("openai/gpt-5", "aa"), 53);
	assert.equal(benchmarkScore("unknown/model", "ramp"), undefined);
});

test("getBenchmark returns merged entry", () => {
	setBenchmarkOverrides({ "openai/gpt-5": { aa: 99 } });
	const entry = getBenchmark("openai/gpt-5");
	assert.equal(entry?.ramp, 0.88); // from bundled
	assert.equal(entry?.aa, 99); // from override
	clearBenchmarkOverrides();
});

test("threshold constants are accessible", () => {
	assert.ok(RAMP_THRESHOLDS.frontier > RAMP_THRESHOLDS.strong);
	assert.ok(RAMP_THRESHOLDS.strong > RAMP_THRESHOLDS.mid);
	assert.ok(AA_THRESHOLDS.frontier > AA_THRESHOLDS.strong);
	assert.ok(AA_THRESHOLDS.strong > AA_THRESHOLDS.mid);
});

test("bundled benchmark sources have auditable provenance", () => {
	assert.match(BENCHMARK_PROVENANCE.ramp.url, /^https:\/\//);
	assert.match(BENCHMARK_PROVENANCE.aa.url, /^https:\/\//);
	assert.match(BENCHMARK_PROVENANCE.ramp.retrievedAt, /^\d{4}-\d{2}-\d{2}$/);
});
