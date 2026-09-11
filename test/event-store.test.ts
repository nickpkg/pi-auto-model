import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UnifiedEventStore } from "../src/observability/event-store.ts";

test("persists, queries, and exports correlated events", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-events-"));
	const path = join(dir, "events.jsonl");
	const store = new UnifiedEventStore(path);
	store.record({ id: "request-1", requestId: "r1", kind: "request", at: 1 });
	store.record({ id: "route-1", requestId: "r1", kind: "route_decision", at: 2, targetId: "p/m" });
	await store.flush();
	assert.equal(store.query({ requestId: "r1" }).length, 2);

	const restored = new UnifiedEventStore(path);
	await restored.load();
	assert.equal(restored.query({ kind: "route_decision" })[0].targetId, "p/m");
	const exportPath = join(dir, "export.json");
	await restored.exportTo(exportPath);
	assert.match(await readFile(exportPath, "utf8"), /route_decision/);
});

test("compacts persisted history and recovers after a transient write failure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "auto-model-events-"));
	const path = join(dir, "events.jsonl");
	await writeFile(path, Array.from({ length: 5 }, (_, at) => JSON.stringify({ id: `e${at}`, kind: "request", at })).join("\n") + "\n");
	const compacted = new UnifiedEventStore(path, 2);
	await compacted.load();
	assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 2);
	for (let at = 5; at < 10; at++) compacted.record({ id: `e${at}`, kind: "request", at });
	await compacted.flush();
	assert.ok((await readFile(path, "utf8")).trim().split("\n").length <= 4);

	const blocker = join(dir, "blocker");
	await writeFile(blocker, "not a directory");
	const recovering = new UnifiedEventStore(join(blocker, "events.jsonl"));
	recovering.record({ id: "failed", kind: "request", at: 1 });
	await assert.rejects(recovering.flush());
	await unlink(blocker);
	await mkdir(blocker);
	recovering.record({ id: "recovered", kind: "request", at: 2 });
	await recovering.flush();
	assert.match(await readFile(join(blocker, "events.jsonl"), "utf8"), /recovered/);
});
