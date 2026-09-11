import type { ProviderQuotaObservation } from "../types.ts";
import { parseRetryAt } from "./uvi.ts";

export interface ProviderQuotaAdapter {
	readonly id: string;
	matches(provider: string): boolean;
	observe(
		provider: string,
		headers: Record<string, string>,
		now?: number,
	): ProviderQuotaObservation | undefined;
}

function normalizeHeaders(headers: Record<string, string>): Map<string, string> {
	return new Map(
		Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value.trim()]),
	);
}

function numberHeader(headers: Map<string, string>, names: readonly string[]): number | undefined {
	for (const name of names) {
		const value = Number(headers.get(name));
		if (Number.isFinite(value) && value >= 0) return value;
	}
	return undefined;
}

function ratio(headers: Map<string, string>, limitNames: readonly string[], remainingNames: readonly string[]): number | undefined {
	const limit = numberHeader(headers, limitNames);
	const remaining = numberHeader(headers, remainingNames);
	return limit !== undefined && limit > 0 && remaining !== undefined
		? Math.min(Math.max(1 - remaining / limit, 0), 1)
		: undefined;
}

export const knownProviderQuotaAdapter: ProviderQuotaAdapter = {
	id: "known-provider-rate-limit-headers",
	matches: (provider) => provider === "anthropic" || provider === "openai",
	observe(_provider, rawHeaders, now = Date.now()) {
		const headers = normalizeHeaders(rawHeaders);
		const requestUvi = ratio(
			headers,
			["anthropic-ratelimit-requests-limit", "x-ratelimit-limit-requests", "x-ratelimit-limit"],
			["anthropic-ratelimit-requests-remaining", "x-ratelimit-remaining-requests", "x-ratelimit-remaining"],
		);
		const tokenUvi = ratio(
			headers,
			["anthropic-ratelimit-tokens-limit", "x-ratelimit-limit-tokens"],
			["anthropic-ratelimit-tokens-remaining", "x-ratelimit-remaining-tokens"],
		);
		const retryAt = parseRetryAt(rawHeaders, now);
		const values = [requestUvi, tokenUvi].filter((value): value is number => value !== undefined);
		if (!values.length && retryAt === undefined) return undefined;
		return {
			uvi: values.length ? Math.max(...values) : undefined,
			retryAt,
			source: "known-provider-headers",
		};
	},
};

/**
 * Reads standard rate-limit headers already present on a Provider response.
 * It never makes a network request and works for any Provider using these names.
 */
export const standardHeaderQuotaAdapter: ProviderQuotaAdapter = {
	id: "standard-rate-limit-headers",
	matches: () => true,
	observe(_provider, rawHeaders, now = Date.now()) {
		const headers = normalizeHeaders(rawHeaders);
		const limit = numberHeader(headers, [
			"x-ratelimit-limit-requests",
			"x-rate-limit-limit-requests",
			"x-ratelimit-limit",
		]);
		const remaining = numberHeader(headers, [
			"x-ratelimit-remaining-requests",
			"x-rate-limit-remaining-requests",
			"x-ratelimit-remaining",
		]);
		const retryAt = parseRetryAt(rawHeaders, now);
		const uvi = limit !== undefined && limit > 0 && remaining !== undefined
			? Math.min(Math.max(1 - remaining / limit, 0), 1)
			: undefined;

		if (uvi === undefined && retryAt === undefined) return undefined;
		return {
			uvi,
			retryAt,
			source: "headers",
		};
	},
};

export class QuotaAdapterRegistry {
	private readonly adapters: ProviderQuotaAdapter[] = [];

	constructor(adapters: readonly ProviderQuotaAdapter[] = [knownProviderQuotaAdapter, standardHeaderQuotaAdapter]) {
		this.adapters.push(...adapters);
	}

	register(adapter: ProviderQuotaAdapter): void {
		this.adapters.unshift(adapter);
	}

	observe(
		provider: string,
		headers: Record<string, string>,
		now = Date.now(),
	): ProviderQuotaObservation | undefined {
		for (const adapter of this.adapters) {
			if (!adapter.matches(provider)) continue;
			const observation = adapter.observe(provider, headers, now);
			if (observation) return observation;
		}
		return undefined;
	}
}
