import { open, stat, unlink } from "node:fs/promises";

export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
	// ponytail: one lock per state file; shard only if contention becomes measurable.
	const deadline = Date.now() + 5_000;
	let handle;
	while (!handle) {
		try {
			handle = await open(path, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
			try {
				if (Date.now() - (await stat(path)).mtimeMs > 30_000) await unlink(path);
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await action();
	} finally {
		await handle.close();
		await unlink(path).catch(() => {});
	}
}
