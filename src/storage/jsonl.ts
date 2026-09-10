import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RecordedDecision } from "../types.ts";

export async function appendDecision(path: string, decision: RecordedDecision): Promise<void> {
	await appendJsonl(path, decision);
}

export interface FeedbackRecord {
	createdAt: number;
	targetId: string;
	feedback: "good" | "bad";
	preference: number;
	reason?: string;
}

export async function appendFeedback(path: string, record: FeedbackRecord): Promise<void> {
	await appendJsonl(path, record);
}

async function appendJsonl(path: string, entry: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}
