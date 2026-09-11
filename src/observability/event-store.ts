import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type UnifiedEventKind =
	| "request"
	| "route_decision"
	| "provider_response"
	| "usage_actual"
	| "quota_observation"
	| "budget_usage"
	| "failover"
	| "user_feedback";

export interface UnifiedEvent {
	id: string;
	requestId?: string;
	sessionId?: string;
	kind: UnifiedEventKind;
	at: number;
	targetId?: string;
	provider?: string;
	modelId?: string;
	taskKinds?: string[];
	status?: number;
	latencyMs?: number;
	costUsd?: number;
	success?: boolean;
	source?: string;
	metadata?: Record<string, string | number | boolean | undefined>;
}

export interface EventQuery {
	requestId?: string;
	kind?: UnifiedEventKind;
	since?: number;
	until?: number;
	limit?: number;
}

export class UnifiedEventStore {
	private readonly events: UnifiedEvent[] = [];
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();
	private persistedCount = 0;
	private readonly filePath: string;
	private readonly maxEvents: number;

	constructor(filePath: string, maxEvents = 10_000) {
		this.filePath = filePath;
		this.maxEvents = maxEvents;
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const contents = await readFile(this.filePath, "utf8");
			for (const line of contents.split(/\r?\n/)) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as UnifiedEvent;
					if (typeof event.id === "string" && typeof event.kind === "string" && typeof event.at === "number") {
						this.events.push(event);
						this.persistedCount++;
					}
				} catch {
					// Ignore malformed local history records.
				}
			}
			this.trim();
			if (this.persistedCount > this.maxEvents) {
				await writeFile(this.filePath, this.events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
				this.persistedCount = this.events.length;
			}
		} catch {
			// Missing local history is a normal first-run state.
		}
	}

	record(event: UnifiedEvent): void {
		this.events.push({ ...event });
		this.trim();
		this.persistedCount++;
		const snapshot = this.persistedCount > this.maxEvents * 2 ? [...this.events] : undefined;
		if (snapshot) this.persistedCount = snapshot.length;
		this.writeChain = this.writeChain.catch(() => {}).then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			if (snapshot) {
				await writeFile(this.filePath, snapshot.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
			} else {
				await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
			}
		});
		void this.writeChain.catch(() => {});
	}

	query(query: EventQuery = {}): UnifiedEvent[] {
		const values = this.events.filter((event) =>
			(query.requestId === undefined || event.requestId === query.requestId) &&
			(query.kind === undefined || event.kind === query.kind) &&
			(query.since === undefined || event.at >= query.since) &&
			(query.until === undefined || event.at <= query.until),
		);
		const limit = Math.max(1, query.limit ?? 100);
		return values.slice(-limit).map((event) => ({ ...event }));
	}

	async exportTo(filePath: string, format: "json" | "jsonl" = "json"): Promise<void> {
		await mkdir(dirname(filePath), { recursive: true });
		const contents = format === "json"
			? `${JSON.stringify(this.events, null, 2)}\n`
			: this.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
		await writeFile(filePath, contents, "utf8");
	}

	async flush(): Promise<void> {
		return this.writeChain;
	}

	private trim(): void {
		if (this.events.length > this.maxEvents) {
			this.events.splice(0, this.events.length - this.maxEvents);
		}
	}
}
