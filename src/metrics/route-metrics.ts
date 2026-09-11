import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	ProviderQuotaObservation,
	ProviderUsageSnapshot,
} from "../types.ts";

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

export interface MetricsBucket {
	startAt: number;
	attempts: number;
	successes: number;
	failures: number;
	totalLatencyMs: number;
	estimatedCostUsd: number;
	failoverCount: number;
	rateLimitCount: number;
	statusCounts: Record<string, number>;
	targetAttempts: Record<string, number>;
}

interface MetricsFile {
	version: 1 | 2 | 3;
	updatedAt: number;
	targets: Record<string, TargetMetrics>;
	providers?: Record<string, ProviderUsageSnapshot>;
	buckets?: Record<string, MetricsBucket>;
}

const METRICS_BUCKET_MS = 60 * 60 * 1000;
const MAX_BUCKETS = 24 * 90;

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

function emptyBucket(startAt: number): MetricsBucket {
	return {
		startAt,
		attempts: 0,
		successes: 0,
		failures: 0,
		totalLatencyMs: 0,
		estimatedCostUsd: 0,
		failoverCount: 0,
		rateLimitCount: 0,
		statusCounts: {},
		targetAttempts: {},
	};
}

function isMetricsBucket(value: unknown): value is MetricsBucket {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<MetricsBucket>;
	return (
		typeof candidate.startAt === "number" &&
		typeof candidate.attempts === "number" &&
		typeof candidate.successes === "number" &&
		typeof candidate.failures === "number" &&
		typeof candidate.totalLatencyMs === "number" &&
		typeof candidate.estimatedCostUsd === "number" &&
		typeof candidate.failoverCount === "number" &&
		typeof candidate.rateLimitCount === "number" &&
		typeof candidate.statusCounts === "object" &&
		candidate.statusCounts !== null &&
		(candidate.targetAttempts === undefined || typeof candidate.targetAttempts === "object")
	);
}

export class RouteMetrics {
	private readonly targets = new Map<string, TargetMetrics>();
	private readonly providerUsage = new Map<string, ProviderUsageSnapshot>();
	private readonly buckets = new Map<number, MetricsBucket>();
	private filePath?: string;
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();
	private quotaWindowMs = 24 * 60 * 60 * 1000;

	async load(filePath: string): Promise<void> {
		this.filePath = filePath;
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<MetricsFile>;
			if (
				(parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
				!parsed.targets ||
				typeof parsed.targets !== "object"
			) return;
			for (const [targetId, value] of Object.entries(parsed.targets)) {
				if (isTargetMetrics(value)) {
					this.targets.set(targetId, { ...value });
				}
			}
			if (parsed.providers && typeof parsed.providers === "object") {
				for (const [provider, value] of Object.entries(parsed.providers)) {
					if (isProviderUsageSnapshot(value)) {
						this.providerUsage.set(provider, { ...value });
					}
				}
			}
			if (parsed.buckets && typeof parsed.buckets === "object") {
				for (const [key, value] of Object.entries(parsed.buckets)) {
					if (isMetricsBucket(value)) {
						this.buckets.set(Number(key), {
							...value,
							statusCounts: { ...value.statusCounts },
						targetAttempts: { ...value.targetAttempts },
						});
					}
				}
			}
			if (this.providerUsage.size === 0) {
				const now = Date.now();
				for (const [targetId, value] of this.targets) {
					const provider = providerOf(targetId);
					const current = this.providerUsage.get(provider) ?? emptyProviderUsage(provider, value.lastRecordedAt ?? now);
					current.attempts += value.attempts;
					current.successes += value.successes;
					current.failures += value.failures;
					current.estimatedCostUsd += value.estimatedCostUsd;
					current.lastStatus = value.lastStatus;
					this.providerUsage.set(provider, current);
				}
			}
		} catch {
			// Missing or corrupt local metrics should never disable routing.
		}
	}

	setQuotaWindow(windowMs: number, now = Date.now()): void {
		this.quotaWindowMs = Math.max(60_000, windowMs);
		for (const [provider, usage] of this.providerUsage) {
			if (now - usage.windowStartedAt >= this.quotaWindowMs) {
				this.providerUsage.set(provider, emptyProviderUsage(provider, windowStart(now, this.quotaWindowMs)));
			}
		}
	}

	record(input: {
		targetId: string;
		success: boolean;
		latencyMs: number;
		estimatedCostUsd?: number;
		status?: number;
		retryAt?: number;
		quotaObservation?: ProviderQuotaObservation;
		failover?: boolean;
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

		const provider = providerOf(input.targetId);
		const usage = this.ensureProviderUsage(provider, now);
		usage.attempts++;
		if (input.success) {
			usage.successes++;
		} else {
			usage.failures++;
		}
		usage.estimatedCostUsd += Math.max(0, input.estimatedCostUsd ?? 0);
		usage.lastStatus = input.status;
		const retryAt = Math.max(input.retryAt ?? 0, input.quotaObservation?.retryAt ?? 0);
		if (retryAt > 0) {
			usage.lastRetryAt = Math.max(usage.lastRetryAt ?? 0, retryAt);
		}
		if (input.quotaObservation?.uvi !== undefined) {
			usage.observedUvi = input.quotaObservation.uvi;
			usage.observedAt = now;
			usage.observedSource = input.quotaObservation.source;
		}

		const bucketStart = bucketStartAt(now);
		const bucket = this.buckets.get(bucketStart) ?? emptyBucket(bucketStart);
		bucket.attempts++;
		if (input.success) {
			bucket.successes++;
		} else {
			bucket.failures++;
		}
		bucket.totalLatencyMs += Math.max(0, input.latencyMs);
		bucket.estimatedCostUsd += Math.max(0, input.estimatedCostUsd ?? 0);
		bucket.targetAttempts[input.targetId] = (bucket.targetAttempts[input.targetId] ?? 0) + 1;
		if (input.failover) bucket.failoverCount++;
		if (input.status !== undefined) {
			const statusKey = String(input.status);
			bucket.statusCounts[statusKey] = (bucket.statusCounts[statusKey] ?? 0) + 1;
			if (input.status === 429) bucket.rateLimitCount++;
		}
		this.buckets.set(bucketStart, bucket);
		this.pruneBuckets(bucketStart);
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

	providerUsageSnapshot(now = Date.now()): ReadonlyMap<string, ProviderUsageSnapshot> {
		for (const [provider, usage] of this.providerUsage) {
			this.ensureProviderUsage(provider, now);
		}
		return new Map([...this.providerUsage].map(([id, value]) => [id, { ...value }]));
	}

	trend(hours = 24, now = Date.now()): MetricsBucket[] {
		const from = now - Math.max(1, hours) * METRICS_BUCKET_MS;
		return [...this.buckets.values()]
			.filter((bucket) => bucket.startAt >= from && bucket.startAt <= now)
			.sort((left, right) => left.startAt - right.startAt)
			.map((bucket) => ({
				...bucket,
				statusCounts: { ...bucket.statusCounts },
				targetAttempts: { ...bucket.targetAttempts },
			}));
	}

	targetAttempts(hours = 24, now = Date.now()): ReadonlyMap<string, number> {
		const counts = new Map<string, number>();
		for (const bucket of this.trend(hours, now)) {
			for (const [targetId, attempts] of Object.entries(bucket.targetAttempts)) {
				counts.set(targetId, (counts.get(targetId) ?? 0) + attempts);
			}
		}
		return counts;
	}

	async flush(): Promise<void> {
		if (!this.filePath) return;
		const filePath = this.filePath;
		const payload: MetricsFile = {
			version: 3,
			updatedAt: Date.now(),
			targets: Object.fromEntries(this.targets),
			providers: Object.fromEntries(this.providerUsage),
			buckets: Object.fromEntries(
				[...this.buckets].map(([startAt, bucket]) => [String(startAt), bucket]),
			),
		};
		this.writeChain = this.writeChain.then(async () => {
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		});
		return this.writeChain;
	}

	private ensureProviderUsage(provider: string, now: number): ProviderUsageSnapshot {
		const current = this.providerUsage.get(provider);
		if (!current || now - current.windowStartedAt >= this.quotaWindowMs) {
			const fresh = emptyProviderUsage(provider, windowStart(now, this.quotaWindowMs));
			this.providerUsage.set(provider, fresh);
			return fresh;
		}
		return current;
	}

	private pruneBuckets(currentStartAt: number): void {
		if (this.buckets.size <= MAX_BUCKETS) return;
		const oldestAllowed = currentStartAt - (MAX_BUCKETS - 1) * METRICS_BUCKET_MS;
		for (const startAt of this.buckets.keys()) {
			if (startAt < oldestAllowed) this.buckets.delete(startAt);
		}
	}
}

function providerOf(targetId: string): string {
	const separator = targetId.indexOf("/");
	return separator > 0 ? targetId.slice(0, separator) : targetId;
}

function emptyProviderUsage(provider: string, windowStartedAt: number): ProviderUsageSnapshot {
	return {
		provider,
		windowStartedAt,
		attempts: 0,
		successes: 0,
		failures: 0,
		estimatedCostUsd: 0,
	};
}

function windowStart(now: number, windowMs: number): number {
	return Math.floor(now / windowMs) * windowMs;
}

function bucketStartAt(now: number): number {
	return Math.floor(now / METRICS_BUCKET_MS) * METRICS_BUCKET_MS;
}

function isProviderUsageSnapshot(value: unknown): value is ProviderUsageSnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ProviderUsageSnapshot>;
	return (
		typeof candidate.provider === "string" &&
		typeof candidate.windowStartedAt === "number" &&
		typeof candidate.attempts === "number" &&
		typeof candidate.successes === "number" &&
		typeof candidate.failures === "number" &&
		typeof candidate.estimatedCostUsd === "number"
	);
}
