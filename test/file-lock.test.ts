import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withFileLock } from "../src/storage/file-lock.ts";

test("Windows lock acquisition retries transient EPERM without running unlocked", { skip: process.platform !== "win32" }, async (t) => {
	const path = join(await fs.mkdtemp(join(tmpdir(), "pi-auto-model-lock-")), "state.lock");
	const open = fs.open;
	let attempts = 0;
	let actions = 0;
	const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
		if (++attempts === 1) throw Object.assign(new Error("pending deletion"), { code: "EPERM" });
		return open(...args);
	});
	syncBuiltinESMExports();
	try {
		await withFileLock(path, async () => {
			actions++;
			assert.equal(attempts, 2);
			assert.ok((await fs.stat(path)).isFile());
		});
		assert.equal(actions, 1);
		await assert.rejects(fs.stat(path), { code: "ENOENT" });
	} finally {
		mock.mock.restore();
		syncBuiltinESMExports();
	}
});
