import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QualityLearning } from "../src/routing/quality-learning.ts";

test("learns by task kind with bounded exploration and persistence", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "auto-model-quality-")), "quality.json");
	const learning = new QualityLearning();
	await learning.load(file);
	const cold = learning.signal("provider-a/model", "provider-a", ["debug"]);
	assert.match(cold.reason, /cold-start/);
	for (let index = 0; index < 6; index += 1) {
		learning.record("provider-a/model", "provider-a", ["debug"], true, 1_000 + index);
	}
	learning.recordFeedback("provider-a/model", ["debug"], "good", 2_000);
	await learning.flush();

	const restored = new QualityLearning();
	await restored.load(file);
	const learned = restored.signal("provider-a/model", "provider-a", ["debug"], 3_000);
	const otherKind = restored.signal("provider-a/model", "provider-a", ["generate"], 3_000);
	assert.ok(learned.score > 0.5);
	assert.ok(learned.reason.includes("confidence"));
	assert.notEqual(learned.score, otherKind.score);
	assert.ok(learned.score <= 1);
});

test("merges learning from concurrent Pi processes", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "auto-model-quality-shared-")), "quality.json");
	const first = new QualityLearning();
	const second = new QualityLearning();
	await Promise.all([first.load(file), second.load(file)]);
	first.record("openai/a", "openai", ["debug"], true, 1_000);
	second.record("anthropic/b", "anthropic", ["debug"], true, 1_001);
	await Promise.all([first.flush(), second.flush()]);

	const restored = new QualityLearning();
	await restored.load(file);
	assert.match(restored.signal("openai/a", "openai", ["debug"], 2_000).reason, /confidence/);
	assert.match(restored.signal("anthropic/b", "anthropic", ["debug"], 2_000).reason, /confidence/);
});
