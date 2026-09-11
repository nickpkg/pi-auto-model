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

	constructor(adapters: readonly ProviderQuotaAdapter[] = [standardHeaderQuotaAdapter]) {
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
