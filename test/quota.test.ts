import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	buildProviderQuotaSignals,
	calculateProviderQuota,
	parseRetryAt,
} from "../src/quota/uvi.ts";
import {
	QuotaAdapterRegistry,
	standardHeaderQuotaAdapter,
} from "../src/quota/adapters.ts";
import { planRoute } from "../src/routing/route-planner.ts";
import { analyzeTask } from "../src/task/local-analyzer.ts";
import type { ProviderQuotaSignal, ProviderUsageSnapshot, RouteTarget } from "../src/types.ts";

const now = Date.UTC(2026, 0, 2, 12);

function usage(overrides: Partial<ProviderUsageSnapshot> = {}): ProviderUsageSnapshot {
	return {
		provider: "provider-a",
		windowStartedAt: now - 86_400_000,
		attempts: 50,
		successes: 48,
		failures: 2,
		estimatedCostUsd: 5,
		...overrides,
	};
}

function signal(provider: string, uvi: number, status: ProviderQuotaSignal["status"]): ProviderQuotaSignal {
	return {
		provider,
		status,
		uvi,
		burnRateUsdPerHour: 0,
		usageUsd: uvi,
		usageRequests: 1,
		source: "configured",
	};
}

function target(provider: string): RouteTarget {
	return {
		id: `${provider}/openai/gpt-5`,
		model: {
			provider,
			id: "openai/gpt-5",
			name: "gpt-5",
			reasoning: true,
			input: ["text"],
			contextWindow: 200_000,
			maxTokens: 16_000,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		} as Model<any>,
	};
}

test("calculates UVI from configured cost and request quotas", () => {
	const result = calculateProviderQuota(usage(), {
		enabled: true,
		windowMs: 24 * 60 * 60 * 1000,
		providers: {
			"provider-a": {
				maxUsd: 10,
				maxRequests: 100,
			},
		},
	}, now);

	assert.equal(result.uvi, 0.5);
	assert.equal(result.status, "healthy");
	assert.equal(result.burnRateUsdPerHour, 5 / 24);
});

test("marks configured quota pressure as warning or blocked", () => {
	const warning = calculateProviderQuota(usage(), {
		enabled: true,
		windowMs: 86_400_000,
		providers: { "provider-a": { maxUsd: 10, warningUvi: 0.4 } },
	}, now);
	assert.equal(warning.status, "warning");

	const blocked = calculateProviderQuota(usage({ estimatedCostUsd: 11 }), {
		enabled: true,
		windowMs: 86_400_000,
		providers: { "provider-a": { maxUsd: 10 } },
	}, now);
	assert.equal(blocked.status, "blocked");
});

test("raises UVI when usage is burning faster than the window", () => {
	const result = calculateProviderQuota(usage({
		windowStartedAt: now - 6 * 3_600_000,
	}), {
		enabled: true,
		windowMs: 24 * 3_600_000,
		providers: { "provider-a": { maxUsd: 10 } },
	}, now);

	assert.equal(result.uvi, 2);
	assert.equal(result.status, "warning");
});

test("parses common provider rate-limit reset headers", () => {
	assert.equal(parseRetryAt({ "Retry-After": "60" }, now), now + 60_000);
	assert.equal(parseRetryAt({ "x-ratelimit-reset-after": "30" }, now), now + 30_000);
	assert.equal(parseRetryAt({ "x-ratelimit-reset": String((now + 90_000) / 1000) }, now), now + 90_000);
});

test("observes standard Provider quota headers without network access", () => {
	const registry = new QuotaAdapterRegistry([standardHeaderQuotaAdapter]);
	const observation = registry.observe("openai", {
		"X-RateLimit-Limit-Requests": "100",
		"X-RateLimit-Remaining-Requests": "20",
		"Retry-After": "60",
	}, now);

	assert.equal(observation?.uvi, 0.8);
	assert.equal(observation?.retryAt, now + 60_000);
	assert.equal(observation?.source, "headers");
});

test("uses known Provider headers and expires stale observations", () => {
	const config = {
		enabled: true,
		windowMs: 86_400_000,
		staleAfterMs: 60_000,
		providers: { openai: {} },
	};
	const observed = calculateProviderQuota({
		provider: "openai",
		windowStartedAt: now - 1_000,
		attempts: 0,
		successes: 0,
		failures: 0,
		estimatedCostUsd: 0,
		observedUvi: 1,
		observedAt: now - 120_000,
	}, config, now);
	assert.equal(observed.status, "unknown");

	const registry = new QuotaAdapterRegistry();
	const observation = registry.observe("anthropic", {
		"anthropic-ratelimit-requests-limit": "100",
		"anthropic-ratelimit-requests-remaining": "25",
	}, now);
	assert.equal(observation?.uvi, 0.75);
	assert.equal(observation?.source, "known-provider-headers");
});

test("unknown quota remains non-blocking", () => {
	const result = buildProviderQuotaSignals(new Map(), {
		enabled: true,
		windowMs: 86_400_000,
		providers: { "provider-a": {} },
	}, now);

	assert.equal(result.get("provider-a")?.status, "unknown");
});

test("routing prefers lower quota pressure when candidates are otherwise equal", () => {
	const result = planRoute({
		targets: [target("provider-a"), target("provider-b")],
		profile: analyzeTask({ prompt: "Explain this function" }),
		quota: new Map([
			["provider-a", signal("provider-a", 0.95, "warning")],
			["provider-b", signal("provider-b", 0.1, "healthy")],
		]),
	});

	assert.equal(result?.target.model.provider, "provider-b");
	assert.ok(result?.reason.some((reason) => reason.includes("quota healthy")));
});
