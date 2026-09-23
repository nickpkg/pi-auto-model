import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	catalogPriceOfModel,
	estimateRequestCostUsd,
	matchCatalogKey,
	resolveModelPrice,
	type CatalogPrice,
} from "../src/pricing/price-catalog.ts";
import {
	fetchLiteLLMPrices,
	isPriceCacheStale,
	loadPriceCache,
	parseLiteLLMPrices,
	savePriceCache,
	DEFAULT_LITELLM_URL,
} from "../src/pricing/litellm-fetch.ts";
import { DEFAULT_CONFIG, type AutoModelConfig } from "../src/config/defaults.ts";
import { loadConfig, mergeConfig } from "../src/config/loader.ts";

function model(provider: string, id: string, input: number, output: number): Model<any> {
	return {
		provider,
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 32_000,
		cost: { input, output, cacheRead: input, cacheWrite: input },
	} as Model<any>;
}

const catalog: Record<string, CatalogPrice> = {
	"openai/gpt-5.6-luna": { input: 1.25, output: 10 },
	"gemini/gemini-3-flash": { input: 0.15, output: 0.6 },
	"anthropic/claude-sonnet-4-20250514": { input: 3, output: 15 },
};

test("resolveModelPrice prefers a user override over every other source", () => {
	const price = resolveModelPrice("openai/gpt-5.6-luna", model("openai", "gpt-5.6-luna", 1, 1), {
		overrides: { "openai/gpt-5.6-luna": { input: 0.5, output: 2 } },
		catalog,
		catalogUpdatedAt: 100,
	});

	assert.equal(price.source, "override");
	assert.equal(price.input, 0.5);
	assert.equal(price.output, 2);
});

test("resolveModelPrice accepts overrides keyed by bare model id", () => {
	const price = resolveModelPrice("openai/gpt-5.6-luna", model("openai", "gpt-5.6-luna", 1, 1), {
		overrides: { "gpt-5.6-luna": { input: 0.25 } },
	});

	assert.equal(price.source, "override");
	assert.equal(price.input, 0.25);
	// Fields not overridden fall through to the registry price.
	assert.equal(price.output, 1);
});

test("resolveModelPrice uses the LiteLLM cache before registry prices", () => {
	const price = resolveModelPrice("openai/gpt-5.6-luna", model("openai", "gpt-5.6-luna", 1, 1), {
		catalog,
		catalogUpdatedAt: 1_000,
	});

	assert.equal(price.source, "litellm");
	assert.equal(price.input, 1.25);
	assert.equal(price.output, 10);
	assert.equal(price.updatedAt, 1_000);
});

test("resolveModelPrice falls back to the Pi registry price", () => {
	const price = resolveModelPrice("some/unknown-model", model("some", "unknown-model", 0.5, 1.5), {
		catalog,
	});

	assert.equal(price.source, "catalog");
	assert.equal(price.input, 0.5);
	assert.equal(price.output, 1.5);
});

test("resolveModelPrice marks zero-cost unknown models as unknown", () => {
	const price = resolveModelPrice("local/llama", model("local", "llama", 0, 0), { catalog });

	assert.equal(price.source, "unknown");
});

test("catalogPriceOfModel mirrors the registry cost with catalog provenance", () => {
	const price = catalogPriceOfModel(model("openai", "gpt-5.6-luna", 1.25, 10));

	assert.equal(price.source, "catalog");
	assert.equal(price.input, 1.25);
	assert.equal(price.output, 10);
});

test("costCoef scales the effective price and per-model coefficients win", () => {
	const globalCoef = resolveModelPrice("openai/gpt-5.6-luna", model("openai", "gpt-5.6-luna", 1, 1), {
		costCoef: 0.5,
	});
	assert.equal(globalCoef.coefficient, 0.5);

	const perModel = resolveModelPrice("openai/gpt-5.6-luna", model("openai", "gpt-5.6-luna", 1, 1), {
		costCoef: 0.5,
		overrides: { "openai/gpt-5.6-luna": { costCoef: 0.2 } },
	});
	assert.equal(perModel.coefficient, 0.2);
	assert.equal(perModel.source, "override");
});

test("estimateRequestCostUsd is token-based and coefficient-aware", () => {
	const cost = estimateRequestCostUsd(
		{ input: 3, output: 15, source: "catalog", updatedAt: 0, coefficient: 0.5 },
		1_000_000,
		2_000_000,
	);

	// (1M * 3 + 2M * 15) / 1M * 0.5 = 16.5
	assert.equal(cost, 16.5);
});

test("matchCatalogKey matches exact, aliased, unprefixed, and versioned keys", () => {
	const keys = Object.keys(catalog);

	assert.equal(matchCatalogKey(keys, "openai", "gpt-5.6-luna"), "openai/gpt-5.6-luna");
	// Pi provider "google" maps to catalog prefix "gemini".
	assert.equal(matchCatalogKey(keys, "google", "gemini-3-flash"), "gemini/gemini-3-flash");
	// Versioned catalog keys match unversioned Pi model ids.
	assert.equal(
		matchCatalogKey(keys, "anthropic", "claude-sonnet-4"),
		"anthropic/claude-sonnet-4-20250514",
	);
	// Unprefixed catalog keys match by bare model id.
	assert.equal(matchCatalogKey(["gpt-4o"], "openai", "gpt-4o"), "gpt-4o");
	// No confident match.
	assert.equal(matchCatalogKey(keys, "local", "llama"), undefined);
});

test("matchCatalogKey does not treat sibling model names as versions", () => {
	const keys = [
		"openai/gpt-4o-mini",
		"anthropic/claude-sonnet-4-5",
		"gemini/gemini-2.5-flash-lite",
		"openai/gpt-4o-2024-08-06",
	];

	assert.equal(matchCatalogKey(keys, "openai", "gpt-4o"), "openai/gpt-4o-2024-08-06");
	assert.equal(matchCatalogKey(keys, "anthropic", "claude-sonnet-4"), undefined);
	assert.equal(matchCatalogKey(keys, "google", "gemini-2.5-flash"), undefined);
	assert.equal(matchCatalogKey(["openai/gpt-4o-mini"], "openai", "gpt-4o"), undefined);
});

test("matchCatalogKey prefers the provider-matched key on ambiguous bases", () => {
	const keys = ["openai/claude-sonnet-4-20250514", "anthropic/claude-sonnet-4-20250514"];

	assert.equal(matchCatalogKey(keys, "anthropic", "claude-sonnet-4"), "anthropic/claude-sonnet-4-20250514");
});

test("parseLiteLLMPrices converts per-token costs and skips non-chat models", () => {
	const parsed = parseLiteLLMPrices({
		"openai/gpt-5.6-luna": {
			mode: "chat",
			input_cost_per_token: 0.00000125,
			output_cost_per_token: 0.00001,
			cache_read_input_token_cost: 0.000000125,
		},
		"openai/text-embedding-3": {
			mode: "embedding",
			input_cost_per_token: 0.00000002,
			output_cost_per_token: 0,
		},
		"openai/no-price": { mode: "chat" },
	});

	assert.deepEqual(parsed, {
		"openai/gpt-5.6-luna": {
			input: 1.25,
			output: 10,
			cacheRead: 0.125,
			cacheWrite: undefined,
		},
	});
});

test("fetchLiteLLMPrices uses the provided fetch function and timestamps the snapshot", async () => {
	const snapshot = await fetchLiteLLMPrices(
		"https://example.test/prices.json",
		async (url) => {
			assert.equal(url, "https://example.test/prices.json");
			assert.ok(typeof AbortSignal !== "undefined");
			return new Response(
				JSON.stringify({ "deepseek/deepseek-chat": { mode: "chat", input_cost_per_token: 0.00000027, output_cost_per_token: 0.0000011 } }),
				{ status: 200 },
			);
		},
		1_234,
	);

	assert.equal(snapshot.version, 1);
	assert.equal(snapshot.source, "litellm");
	assert.equal(snapshot.updatedAt, 1_234);
	assert.equal(snapshot.models["deepseek/deepseek-chat"].input, 0.27);
});

test("fetchLiteLLMPrices rejects non-OK responses", async () => {
	await assert.rejects(
		fetchLiteLLMPrices("https://example.test/prices.json", async () => new Response("nope", { status: 404 })),
		/late|failed/,
	);
});

test("price cache round-trips through disk and tolerates corruption", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-auto-model-prices-"));
	const path = join(dir, "prices.json");

	const snapshot = {
		version: 1 as const,
		source: "litellm" as const,
		updatedAt: 1_000,
		models: { "openai/gpt-5.6-luna": { input: 1.25, output: 10 } },
	};
	await savePriceCache(path, snapshot);
	assert.deepEqual(await loadPriceCache(path), snapshot);

	await writeFile(path, "{ not json", "utf8");
	assert.equal(await loadPriceCache(path), undefined);

	await writeFile(path, JSON.stringify({ version: 2, updatedAt: 1, models: {} }), "utf8");
	assert.equal(await loadPriceCache(path), undefined);

	await readFile(path, "utf8"); // file exists; loader simply returned undefined
});

test("isPriceCacheStale treats missing and old caches as stale", () => {
	const now = 10 * 3_600_000;
	assert.equal(isPriceCacheStale(undefined, 1, now), true);
	assert.equal(isPriceCacheStale({ version: 1, source: "litellm", updatedAt: now, models: { "a/b": { input: 1, output: 1 } } }, 1, now), false);
	assert.equal(isPriceCacheStale({ version: 1, source: "litellm", updatedAt: 0, models: { "a/b": { input: 1, output: 1 } } }, 1, now), true);
});

test("configuration loads and merges the pricing section", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-auto-model-config-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({
		policy: "cost",
		pricing: {
			costCoef: 0.8,
			overrides: { "openai/gpt-5.6-luna": { input: 0.1, output: 0.4 } },
			litellm: { enabled: true, refreshHours: 24 },
		},
	}), "utf8");

	const global = await loadConfig(file);
	assert.equal(global.pricing?.costCoef, 0.8);
	assert.equal(global.pricing?.overrides?.["openai/gpt-5.6-luna"]?.input, 0.1);
	assert.equal(global.pricing?.litellm?.refreshHours, 24);

	const merged = mergeConfig(global, {
		...DEFAULT_CONFIG,
		pricing: { costCoef: 0.5, overrides: { "local/llama": { costCoef: 0 } } },
	} satisfies AutoModelConfig);
	assert.equal(merged.pricing?.costCoef, 0.5);
	assert.equal(merged.pricing?.overrides?.["openai/gpt-5.6-luna"]?.input, 0.1);
	assert.equal(merged.pricing?.overrides?.["local/llama"]?.costCoef, 0);
	assert.equal(merged.pricing?.litellm?.refreshHours, 24);
});

test("configuration rejects invalid pricing sections", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-auto-model-config-"));
	const file = join(dir, "auto-model.json");
	await writeFile(file, JSON.stringify({
		pricing: { costCoef: -1 },
	}), "utf8");

	const loaded = await loadConfig(file);
	// Invalid config falls back to defaults rather than disabling routing.
	assert.equal(loaded.pricing, DEFAULT_CONFIG.pricing);
	assert.equal(loaded.policy, DEFAULT_CONFIG.policy);
});

test("default LiteLLM URL points at the official catalog", () => {
	assert.match(DEFAULT_LITELLM_URL, /BerriAI\/litellm\/main\/model_prices_and_context_window\.json$/);
});

test("default price cache refresh keeps up with model releases", async () => {
	const { DEFAULT_LITELLM_REFRESH_HOURS } = await import("../src/pricing/litellm-fetch.ts");
	// Daily by default: new models reach routing prices within a day
	// without any configuration.
	assert.equal(DEFAULT_LITELLM_REFRESH_HOURS, 24);
});
