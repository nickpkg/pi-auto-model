import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RouteMetrics } from "../src/metrics/route-metrics.ts";

test("records route outcomes and summarizes latency and cost", () => {
	const metrics = new RouteMetrics();
	metrics.record({ targetId: "openai/gpt-5", success: true, latencyMs: 100, ttftMs: 20, estimatedCostUsd: 0.02 });
	metrics.record({ targetId: "openai/gpt-5", success: false, latencyMs: 300, estimatedCostUsd: 0.03, status: 429 });

	const target = metrics.get("openai/gpt-5");
	assert.ok(target);
	assert.equal(target.attempts, 2);
	assert.equal(target.successes, 1);
	assert.equal(target.failures, 1);
	assert.equal(target.totalLatencyMs, 400);
	assert.equal(target.lastLatencyMs, 300);
	assert.equal(target.estimatedCostUsd, 0.05);
	assert.equal(target.lastStatus, 429);
	assert.equal(typeof target.lastRecordedAt, "number");
	assert.deepEqual(metrics.summary(), {
		attempts: 2,
		successes: 1,
		failures: 1,
		averageLatencyMs: 200,
		p50LatencyMs: 100,
		p95LatencyMs: 300,
		estimatedCostUsd: 0.05,
		actualCostUsd: 0,
		actualSamples: 0,
	});
	assert.equal(metrics.providerSnapshot().get("openai")?.estimatedCostUsd, 0.05);
	assert.equal(metrics.providerSnapshot().get("openai")?.attempts, 2);
	assert.equal(metrics.providerUsageSnapshot().get("openai")?.attempts, 2);
	assert.deepEqual(target.ttftMs, [20]);
	assert.deepEqual(metrics.providerSnapshot().get("openai")?.ttftMs, [20]);
	metrics.snapshot().get("openai/gpt-5")!.ttftMs!.push(999);
	assert.deepEqual(metrics.get("openai/gpt-5")?.ttftMs, [20], "snapshot must not mutate live samples");
});

test("captures actual usage and learns a bounded cost multiplier", async () => {
	const filePath = join(await mkdtemp(join(tmpdir(), "pi-auto-model-actual-")), "metrics.json");
	const metrics = new RouteMetrics();
	await metrics.load(filePath);
	for (let sample = 0; sample < 3; sample++) {
		metrics.recordActual({
			targetId: "openai/gpt-5",
			estimatedCostUsd: 0.01,
			actualCostUsd: 0.04,
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 50,
			cacheWriteTokens: 0,
			costKnown: true,
		});
	}
	await metrics.flush();

	const restored = new RouteMetrics();
	await restored.load(filePath);
	assert.equal(restored.get("openai/gpt-5")?.actualInputTokens, 300);
	assert.equal(restored.get("openai/gpt-5")?.actualCostUsd, 0.12);
	assert.equal(restored.costMultiplier("openai/gpt-5"), 2);
});

test("tracks Provider retry windows for quota signals", () => {
	const metrics = new RouteMetrics();
	metrics.record({
		targetId: "openai/gpt-5",
		success: false,
		latencyMs: 20,
		status: 429,
		retryAt: 10_000,
	}, 1_000);

	assert.equal(metrics.providerUsageSnapshot(2_000).get("openai")?.lastRetryAt, 10_000);
});

test("records hourly trend buckets with rate-limit and failover counts", () => {
	const metrics = new RouteMetrics();
	const firstHour = Date.UTC(2026, 0, 2, 10, 5);
	const secondHour = Date.UTC(2026, 0, 2, 11, 5);
	metrics.record({
		targetId: "openai/gpt-5",
		success: true,
		latencyMs: 100,
		estimatedCostUsd: 0.01,
	}, firstHour);
	metrics.record({
		targetId: "openai/gpt-5",
		success: false,
		latencyMs: 300,
		estimatedCostUsd: 0.02,
		status: 429,
		failover: true,
	}, secondHour);

	const trend = metrics.trend(24, secondHour + 1_000);
	assert.equal(trend.length, 2);
	assert.equal(trend[1].rateLimitCount, 1);
	assert.equal(trend[1].failoverCount, 1);
	assert.equal(trend[1].estimatedCostUsd, 0.02);
	assert.equal(metrics.targetAttempts(24, secondHour + 1_000).get("openai/gpt-5"), 2);
});

test("persists metrics and ignores missing local files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-model-metrics-"));
	const filePath = join(directory, "metrics.json");
	const metrics = new RouteMetrics();
	await metrics.load(filePath);
	metrics.record({ targetId: "anthropic/claude", success: true, latencyMs: 50 });
	await metrics.flush();

	const restored = new RouteMetrics();
	await restored.load(filePath);
	assert.equal(restored.get("anthropic/claude")?.successes, 1);
	assert.match(await readFile(filePath, "utf8"), /"version": 3/);
});

test("merges writes from concurrent Pi processes", async () => {
	const filePath = join(await mkdtemp(join(tmpdir(), "pi-auto-model-metrics-shared-")), "metrics.json");
	const first = new RouteMetrics();
	const second = new RouteMetrics();
	await Promise.all([first.load(filePath), second.load(filePath)]);
	first.record({ targetId: "openai/a", success: true, latencyMs: 10 });
	second.record({ targetId: "anthropic/b", success: true, latencyMs: 20 });
	await Promise.all([first.flush(), second.flush()]);

	const restored = new RouteMetrics();
	await restored.load(filePath);
	assert.equal(restored.summary().attempts, 2);
});

test("loads metrics v3 buckets created before target allocation tracking", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-model-metrics-legacy-"));
	const filePath = join(directory, "metrics.json");
	await writeFile(filePath, JSON.stringify({
		version: 3,
		updatedAt: Date.now(),
		targets: {},
		buckets: {
			"1767348000000": {
				startAt: 1767348000000,
				attempts: 1,
				successes: 1,
				failures: 0,
				totalLatencyMs: 10,
				estimatedCostUsd: 0,
				failoverCount: 0,
				rateLimitCount: 0,
				statusCounts: {},
			},
		},
	}), "utf8");

	const restored = new RouteMetrics();
	await restored.load(filePath);
	assert.equal(restored.targetAttempts(24, 1767348000000 + 60_000).size, 0);
});
