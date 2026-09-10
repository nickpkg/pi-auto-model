import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.ts";
import { appendDecision } from "../src/storage/jsonl.ts";

test("loads configuration with safe defaults", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autoroute-"));
	const file = join(dir, "autoroute.json");
	await writeFile(file, JSON.stringify({ policy: "best", aliases: { "a/b": "x:y" } }));
	const config = await loadConfig(file);
	assert.equal(config.policy, "best");
	assert.equal(config.aliases["a/b"], "x:y");
	assert.equal(config.enabled, true);
});

test("allows a project or global config to disable automatic activation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autoroute-"));
	const file = join(dir, "autoroute.json");
	await writeFile(file, JSON.stringify({ enabled: false }));
	const config = await loadConfig(file);
	assert.equal(config.enabled, false);
});

test("falls back to the default policy for an unsupported policy name", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autoroute-"));
	const file = join(dir, "autoroute.json");
	await writeFile(file, JSON.stringify({ policy: "economy" }));
	const config = await loadConfig(file);
	assert.equal(config.policy, "balanced");
});

test("appends decisions as JSONL", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "autoroute-")), "decisions.jsonl");
	await appendDecision(file, { id: "r1", targetId: "p/m", thinking: "low", policy: "balanced", reason: [], score: { targetId: "p/m", quality: 0, cost: 0, stickiness: 0, utility: 0 }, taskKinds: ["mixed"], createdAt: 1 });
	assert.match(await readFile(file, "utf8"), /"id":"r1"/);
});
