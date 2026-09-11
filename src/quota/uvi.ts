import type {
	ProviderQuotaConfig,
	ProviderQuotaRule,
	ProviderQuotaSignal,
	ProviderUsageSnapshot,
} from "../types.ts";

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}

function ruleFor(
	config: ProviderQuotaConfig,
	provider: string,
): ProviderQuotaRule {
	return config.providers[provider] ?? {};
}

export function calculateProviderQuota(
	usage: ProviderUsageSnapshot,
	config: ProviderQuotaConfig,
	now = Date.now(),
): ProviderQuotaSignal {
	const rule = ruleFor(config, usage.provider);
	const windowMs = Math.max(60_000, rule.windowMs ?? config.windowMs);
	const retryAt = usage.lastRetryAt && usage.lastRetryAt > now ? usage.lastRetryAt : undefined;
	const observedIsFresh = usage.observedUvi !== undefined &&
		usage.observedAt !== undefined &&
		now - usage.observedAt <= Math.max(60_000, config.staleAfterMs ?? windowMs);
	const observedUvi = observedIsFresh ? usage.observedUvi : undefined;
	const configuredFractions = [
		rule.maxUsd && rule.maxUsd > 0 ? usage.estimatedCostUsd / rule.maxUsd : undefined,
		rule.maxRequests && rule.maxRequests > 0 ? usage.attempts / rule.maxRequests : undefined,
	].filter((value): value is number => value !== undefined);
	const configuredUvi = configuredFractions.length ? Math.max(...configuredFractions) : undefined;
	const elapsedWindowFraction = clamp(
		(now - usage.windowStartedAt) / windowMs,
		0.01,
		1,
	);
	const velocityUvi = configuredUvi === undefined
		? undefined
		: configuredUvi / elapsedWindowFraction;
	const localUvi = configuredUvi === undefined
		? undefined
		: Math.max(configuredUvi, velocityUvi ?? configuredUvi);
	const uvi = localUvi === undefined && observedUvi === undefined
		? undefined
		: Math.max(localUvi ?? 0, observedUvi ?? 0);
	const elapsedHours = Math.max((now - usage.windowStartedAt) / 3_600_000, 1 / 60);
	const burnRateUsdPerHour = usage.estimatedCostUsd / elapsedHours;
	const warningUvi = clamp(rule.warningUvi ?? 0.8, 0, 10);
	const blockUvi = Math.max(warningUvi, rule.blockUvi ?? 1);

	let status: ProviderQuotaSignal["status"] = "unknown";
	let source: ProviderQuotaSignal["source"] = "unknown";
	if (config.enabled) {
		if (retryAt) {
			status = "cooldown";
			source = "rate-limit";
		} else if (uvi !== undefined) {
			const configuredLimitReached = configuredUvi !== undefined && configuredUvi >= blockUvi;
			const observedLimitReached = observedUvi !== undefined && observedUvi >= 1;
			status = configuredLimitReached || observedLimitReached
				? "blocked"
				: uvi >= warningUvi
					? "warning"
					: "healthy";
			source = observedUvi !== undefined && (configuredUvi === undefined || observedUvi >= configuredUvi)
				? "adapter"
				: "configured";
		}
	}

	return {
		provider: usage.provider,
		status,
		uvi,
		burnRateUsdPerHour,
		usageUsd: usage.estimatedCostUsd,
		usageRequests: usage.attempts,
		maxUsd: rule.maxUsd,
		maxRequests: rule.maxRequests,
		retryAt,
		source,
	};
}

export function buildProviderQuotaSignals(
	usages: ReadonlyMap<string, ProviderUsageSnapshot>,
	config: ProviderQuotaConfig,
	now = Date.now(),
): ReadonlyMap<string, ProviderQuotaSignal> {
	const providers = new Set([...usages.keys(), ...Object.keys(config.providers)]);
	return new Map([...providers].map((provider) => {
		const usage = usages.get(provider) ?? {
			provider,
			windowStartedAt: now - config.windowMs,
			attempts: 0,
			successes: 0,
			failures: 0,
			estimatedCostUsd: 0,
		};
		return [provider, calculateProviderQuota(usage, config, now)];
	}));
}

export function isProviderQuotaBlocked(signal: ProviderQuotaSignal | undefined): boolean {
	return signal?.status === "blocked" || signal?.status === "cooldown";
}

export function quotaScore(signal: ProviderQuotaSignal | undefined): number {
	if (!signal || signal.status === "unknown" || signal.uvi === undefined) {
		return 0.5;
	}
	if (isProviderQuotaBlocked(signal)) {
		return 0;
	}
	return clamp(1 - signal.uvi, 0, 1);
}

export function parseRetryAt(
	headers: Record<string, string>,
	now = Date.now(),
): number | undefined {
	const normalized = new Map(
		Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value.trim()]),
	);
	const retryAfter = normalized.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.min(now + seconds * 1000, now + MAX_RETRY_AFTER_MS);
		}
		const timestamp = Date.parse(retryAfter);
		if (Number.isFinite(timestamp) && timestamp > now) {
			return Math.min(timestamp, now + MAX_RETRY_AFTER_MS);
		}
	}

	const reset = normalized.get("x-ratelimit-reset") ?? normalized.get("x-rate-limit-reset");
	if (reset) {
		const value = Number(reset);
		if (Number.isFinite(value)) {
			const timestamp = value > 10_000_000_000 ? value : value * 1000;
			if (timestamp > now) {
				return Math.min(timestamp, now + MAX_RETRY_AFTER_MS);
			}
		}
	}

	const resetAfter = normalized.get("x-ratelimit-reset-after");
	if (resetAfter) {
		const seconds = Number(resetAfter);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.min(now + seconds * 1000, now + MAX_RETRY_AFTER_MS);
		}
	}

	return undefined;
}

export function formatQuotaSignal(signal: ProviderQuotaSignal | undefined): string {
	if (!signal || signal.status === "unknown") return "quota unknown";
	const uvi = signal.uvi === undefined ? "n/a" : signal.uvi.toFixed(2);
	const usage = signal.maxUsd !== undefined
		? `$${signal.usageUsd.toFixed(4)}/$${signal.maxUsd.toFixed(2)}`
		: signal.maxRequests !== undefined
			? `${signal.usageRequests}/${signal.maxRequests} requests`
			: signal.source === "adapter"
				? "header observed"
				: `${signal.usageRequests} requests`;
	const cooldown = signal.retryAt
		? ` until ${new Date(signal.retryAt).toLocaleTimeString()}`
		: "";
	const burn = signal.burnRateUsdPerHour === undefined
		? ""
		: ` · burn $${signal.burnRateUsdPerHour.toFixed(4)}/h`;
	return `quota ${signal.status} · UVI ${uvi} · ${usage}${burn}${cooldown}`;
}
