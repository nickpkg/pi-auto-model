import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface TargetMetrics {
	attempts: number;
	successes: number;
	failures: number;
	totalLatencyMs: number;
	lastLatencyMs?: number;
	estimatedCostUsd: number;
	lastStatus?: number;
	lastRecordedAt?: number;
}

export interface MetricsSummary {
	attempts: number;
	successes: number;
	failures: number;
	averageLatencyMs: number;
	estimatedCostUsd: number;
}

interface MetricsFile {
	version: 1;
	updatedAt: number;
	targets: Record<string, TargetMetrics>;
}

function emptyMetrics(): TargetMetrics {
	return {
		attempts: 0,
		successes: 0,
		failures: 0,
		totalLatencyMs: 0,
		estimatedCostUsd: 0,
	};
}

function isTargetMetrics(value: unknown): value is TargetMetrics {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<TargetMetrics>;
	return (
		typeof candidate.attempts === "number" &&
		typeof candidate.successes === "number" &&
		typeof candidate.failures === "number" &&
		typeof candidate.totalLatencyMs === "number" &&
		typeof candidate.estimatedCostUsd === "number"
	);
}

export class RouteMetrics {
	private readonly targets = new Map<string, TargetMetrics>();
	private filePath?: string;
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();

	async load(filePath: string): Promise<void> {
		this.filePath = filePath;
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<MetricsFile>;
			if (parsed.version !== 1 || !parsed.targets || typeof parsed.targets !== "object") return;
			for (const [targetId, value] of Object.entries(parsed.targets)) {
				if (isTargetMetrics(value)) {
					this.targets.set(targetId, { ...value });
				}
			}
		} catch {
			// Missing or corrupt local metrics should never disable routing.
		}
	}

	record(input: {
		targetId: string;
		success: boolean;
		latencyMs: number;
		estimatedCostUsd?: number;
		status?: number;
	}, now = Date.now()): void {
		const current = this.targets.get(input.targetId) ?? emptyMetrics();
		current.attempts++;
		if (input.success) {
			current.successes++;
		} else {
			current.failures++;
		}
		current.totalLatencyMs += Math.max(0, input.latencyMs);
		current.lastLatencyMs = Math.max(0, input.latencyMs);
		current.estimatedCostUsd += Math.max(0, input.estimatedCostUsd ?? 0);
		current.lastStatus = input.status;
		current.lastRecordedAt = now;
		this.targets.set(input.targetId, current);
	}

	get(targetId: string): TargetMetrics | undefined {
		const value = this.targets.get(targetId);
		return value ? { ...value } : undefined;
	}

	summary(): MetricsSummary {
		let attempts = 0;
		let successes = 0;
		let failures = 0;
		let totalLatencyMs = 0;
		let estimatedCostUsd = 0;
		for (const value of this.targets.values()) {
			attempts += value.attempts;
			successes += value.successes;
			failures += value.failures;
			totalLatencyMs += value.totalLatencyMs;
			estimatedCostUsd += value.estimatedCostUsd;
		}
		return {
			attempts,
			successes,
			failures,
			averageLatencyMs: attempts ? totalLatencyMs / attempts : 0,
			estimatedCostUsd,
		};
	}

	snapshot(): ReadonlyMap<string, TargetMetrics> {
		return new Map([...this.targets].map(([id, value]) => [id, { ...value }]));
	}

	providerSnapshot(): ReadonlyMap<string, TargetMetrics> {
		const providers = new Map<string, TargetMetrics>();
		for (const [targetId, value] of this.targets) {
			const separator = targetId.indexOf("/");
			const providerId = separator > 0 ? targetId.slice(0, separator) : targetId;
			const aggregate = providers.get(providerId) ?? emptyMetrics();
			aggregate.attempts += value.attempts;
			aggregate.successes += value.successes;
			aggregate.failures += value.failures;
			aggregate.totalLatencyMs += value.totalLatencyMs;
			aggregate.lastLatencyMs = value.lastLatencyMs;
			aggregate.estimatedCostUsd += value.estimatedCostUsd;
			if (
				value.lastRecordedAt !== undefined &&
				(aggregate.lastRecordedAt === undefined || value.lastRecordedAt >= aggregate.lastRecordedAt)
			) {
				aggregate.lastStatus = value.lastStatus;
				aggregate.lastRecordedAt = value.lastRecordedAt;
			}
			providers.set(providerId, aggregate);
		}
		return new Map([...providers].map(([id, value]) => [id, { ...value }]));
	}

	async flush(): Promise<void> {
		if (!this.filePath) return;
		const filePath = this.filePath;
		const payload: MetricsFile = {
			version: 1,
			updatedAt: Date.now(),
			targets: Object.fromEntries(this.targets),
		};
		this.writeChain = this.writeChain.then(async () => {
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		});
		return this.writeChain;
	}
}
