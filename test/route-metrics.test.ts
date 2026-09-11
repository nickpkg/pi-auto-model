import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RouteMetrics } from "../src/metrics/route-metrics.ts";

test("records route outcomes and summarizes latency and cost", () => {
	const metrics = new RouteMetrics();
	metrics.record({ targetId: "openai/gpt-5", success: true, latencyMs: 100, estimatedCostUsd: 0.02 });
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
		estimatedCostUsd: 0.05,
	});
	assert.equal(metrics.providerSnapshot().get("openai")?.estimatedCostUsd, 0.05);
	assert.equal(metrics.providerSnapshot().get("openai")?.attempts, 2);
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
	assert.match(await readFile(filePath, "utf8"), /"version": 1/);
});
