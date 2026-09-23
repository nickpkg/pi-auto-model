/**
 * LiteLLM price fetcher — external price cache for the price catalog.
 *
 * Fetches BerriAI/litellm's `model_prices_and_context_window.json`
 * (per-token USD prices), converts it to USD per 1M tokens, and caches
 * it on disk. Everything here is best-effort: a missing, stale, or
 * unreachable cache must never disable routing — the resolver simply
 * falls through to Pi registry prices.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CatalogPrice } from "./price-catalog.ts";

export const DEFAULT_LITELLM_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Default refresh interval for the price cache (1 day). */
export const DEFAULT_LITELLM_REFRESH_HOURS = 24;

const FETCH_TIMEOUT_MS = 15_000;

/** On-disk price cache. */
export interface PriceCatalogSnapshot {
	version: 1;
	source: "litellm";
	updatedAt: number;
	models: Record<string, CatalogPrice>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPerMillion(perToken: unknown): number | undefined {
	if (typeof perToken !== "number" || !Number.isFinite(perToken) || perToken < 0) return undefined;
	return Number((perToken * 1_000_000).toFixed(6));
}

/**
 * Parses LiteLLM's `model_prices_and_context_window.json` into a
 * per-1M-token catalog. Only chat models with usable price fields are
 * kept; everything else is skipped.
 */
export function parseLiteLLMPrices(json: unknown): Record<string, CatalogPrice> {
	const models: Record<string, CatalogPrice> = {};
	if (!isRecord(json)) return models;
	for (const [key, value] of Object.entries(json)) {
		if (!isRecord(value)) continue;
		if (value.mode !== undefined && value.mode !== "chat") continue;
		const input = toPerMillion(value.input_cost_per_token);
		const output = toPerMillion(value.output_cost_per_token);
		if (input === undefined || output === undefined) continue;
		models[key] = {
			input,
			output,
			cacheRead: toPerMillion(value.cache_read_input_token_cost),
			cacheWrite: toPerMillion(
				value.cache_writes_5m_input_token_cost ?? value.cache_writes_1h_input_token_cost ?? value.cache_write_input_token_cost,
			),
		};
	}
	return models;
}

/** Fetches and parses the LiteLLM catalog. Throws on network or parse failure. */
export async function fetchLiteLLMPrices(
	url: string = DEFAULT_LITELLM_URL,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
	now: number = Date.now(),
): Promise<PriceCatalogSnapshot> {
	const response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`litellm price fetch failed: ${response.status}`);
	const models = parseLiteLLMPrices(await response.json());
	if (Object.keys(models).length === 0) throw new Error("litellm price catalog was empty");
	return { version: 1, source: "litellm", updatedAt: now, models };
}

function isCatalogPrice(value: unknown): value is CatalogPrice {
	if (!isRecord(value)) return false;
	return typeof value.input === "number" && typeof value.output === "number" &&
		(value.cacheRead === undefined || typeof value.cacheRead === "number") &&
		(value.cacheWrite === undefined || typeof value.cacheWrite === "number");
}

/** Loads the on-disk price cache; undefined when missing or corrupt. */
export async function loadPriceCache(filePath: string): Promise<PriceCatalogSnapshot | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
		if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.updatedAt !== "number" || !isRecord(parsed.models)) {
			return undefined;
		}
		const models: Record<string, CatalogPrice> = {};
		for (const [key, value] of Object.entries(parsed.models)) {
			if (isCatalogPrice(value)) models[key] = value;
		}
		if (Object.keys(models).length === 0) return undefined;
		return { version: 1, source: "litellm", updatedAt: parsed.updatedAt, models };
	} catch {
		return undefined;
	}
}

/** Atomically persists the price cache. Best-effort; failures propagate to the caller. */
export async function savePriceCache(filePath: string, snapshot: PriceCatalogSnapshot): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, "utf8");
	await rename(temporaryPath, filePath);
}

/** True when the cache is older than `refreshHours` (missing caches count as stale). */
export function isPriceCacheStale(
	snapshot: PriceCatalogSnapshot | undefined,
	refreshHours: number = DEFAULT_LITELLM_REFRESH_HOURS,
	now: number = Date.now(),
): boolean {
	if (!snapshot) return true;
	return now - snapshot.updatedAt >= Math.max(1, refreshHours) * 3_600_000;
}
