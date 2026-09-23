/**
 * Price catalog — layered model price resolution for cost routing.
 *
 * Prices are resolved per request with an explicit provenance trail:
 *
 *   1. user override — `pricing.overrides` in auto-model.json
 *   2. LiteLLM price cache — fetched in the background, cached on disk
 *   3. Pi registry `model.cost`
 *   4. unknown — no price data; the cost score stays neutral
 *
 * All prices are USD per 1M tokens, matching Pi's `Model.cost` units.
 * LiteLLM publishes per-token USD prices; the fetcher converts them.
 */

import type { Model } from "@earendil-works/pi-ai";

/** Where a resolved price came from. */
export type PriceSource = "override" | "litellm" | "catalog" | "unknown";

/** Fully resolved per-model price with provenance. */
export interface ResolvedModelPrice {
	/** USD per 1M input tokens. */
	input: number;
	/** USD per 1M output tokens. */
	output: number;
	/** USD per 1M cache-read tokens. */
	cacheRead?: number;
	/** USD per 1M cache-write tokens. */
	cacheWrite?: number;
	source: PriceSource;
	/** When this price was last known fresh (epoch ms); 0 = unknown. */
	updatedAt: number;
	/** User-configured effective-price multiplier (subscription/discount). */
	coefficient: number;
}

/** User-configured price override (USD per 1M tokens). */
export interface PriceOverride {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Effective-price multiplier for this model. */
	costCoef?: number;
}

/** External catalog entry, keyed by `provider/model` (USD per 1M tokens). */
export interface CatalogPrice {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** Pi providers whose catalog key prefix differs from the Pi provider id. */
const PROVIDER_ALIASES: Record<string, readonly string[]> = {
	google: ["google", "gemini"],
	"google-vertex": ["google-vertex", "vertex_ai", "gemini"],
	"amazon-bedrock": ["amazon-bedrock", "bedrock"],
	"openai-codex": ["openai-codex", "openai"],
	zai: ["zai", "z-ai"],
	"zai-coding-cn": ["zai", "z-ai"],
};

/**
 * Matches a Pi target against external catalog keys.
 *
 * Lookup order:
 * 1. exact `provider/model` (alias-aware, e.g. `google/glm` → `gemini/glm`)
 * 2. exact bare model id
 * 3. dated or dotted version suffix — `claude-sonnet-4` ↔
 *    `claude-sonnet-4-20250514`, `gpt-4o` ↔ `gpt-4o-2024-08-06`.
 *    Sibling names (`gpt-4o` vs `gpt-4o-mini`) do not match.
 *    Provider-matched and more specific (longer) keys win.
 *
 * Returns undefined when nothing matches confidently.
 */
export function matchCatalogKey(
	keys: readonly string[],
	provider: string,
	modelId: string,
): string | undefined {
	const keySet = new Set(keys);
	const aliases = [provider, ...(PROVIDER_ALIASES[provider] ?? [])];
	for (const alias of aliases) {
		const candidate = `${alias}/${modelId}`;
		if (keySet.has(candidate)) return candidate;
	}
	if (keySet.has(modelId)) return modelId;

	let best: { key: string; score: number } | undefined;
	for (const key of keys) {
		const separator = key.indexOf("/");
		const keyProvider = separator > 0 ? key.slice(0, separator) : undefined;
		const base = separator > 0 ? key.slice(separator + 1) : key;
		if (!base) continue;
		const versioned = versionedVariant(modelId, base) || versionedVariant(base, modelId);
		if (!versioned) continue;
		const providerMatched = keyProvider !== undefined && aliases.includes(keyProvider);
		const score = (providerMatched ? 2_000 : 0) + base.length;
		if (!best || score > best.score) best = { key, score };
	}
	return best?.key;
}

/**
 * True when `longer` is `shorter` plus a date or dotted version suffix.
 * `gpt-4o-mini` and `claude-sonnet-4-5` are different models, not versions.
 */
function versionedVariant(shorter: string, longer: string): boolean {
	if (longer === shorter) return true;
	if (!longer.startsWith(`${shorter}-`) && !longer.startsWith(`${shorter}.`)) return false;
	const suffix = longer.slice(shorter.length + 1);
	if (!suffix) return false;
	// YYYYMMDD, or dash/dot-separated dates and numeric versions (v1, 4.1, 2024-08-06).
	return /^v?\d{8}$/.test(suffix) || /^(?:v?\d+)(?:[.-](?:v?\d+))+$/.test(suffix);
}

/** Registry-only fallback price derived from Pi's `model.cost`. */
export function catalogPriceOfModel(model: Model<any>): ResolvedModelPrice {
	const known = model.cost.input + model.cost.output > 0;
	return {
		input: model.cost.input,
		output: model.cost.output,
		cacheRead: model.cost.cacheRead,
		cacheWrite: model.cost.cacheWrite,
		source: known ? "catalog" : "unknown",
		updatedAt: 0,
		coefficient: 1,
	};
}

export interface ResolvePriceOptions {
	/** User overrides keyed by target ID (`provider/model`) or bare model ID. */
	overrides?: Readonly<Record<string, PriceOverride>>;
	/** External catalog prices keyed by `provider/model` (USD per 1M tokens). */
	catalog?: Readonly<Record<string, CatalogPrice>>;
	/** When the external catalog was last refreshed (epoch ms). */
	catalogUpdatedAt?: number;
	/** Global effective-price multiplier (subscription/discount). */
	costCoef?: number;
	/** Override for `Date.now()` in tests. */
	now?: number;
}

/**
 * Resolves a model price through the layered cascade, tracking where
 * each price came from. Override fields replace the underlying layer's
 * values; `costCoef` scales the effective price without rewriting it.
 */
export function resolveModelPrice(
	targetId: string,
	model: Model<any>,
	options: ResolvePriceOptions = {},
): ResolvedModelPrice {
	const now = options.now ?? Date.now();
	const override = options.overrides?.[targetId] ?? options.overrides?.[model.id];
	const catalogKey = options.catalog
		? matchCatalogKey(Object.keys(options.catalog), model.provider, model.id)
		: undefined;
	const entry = catalogKey ? options.catalog?.[catalogKey] : undefined;

	const input = override?.input ?? entry?.input ?? model.cost.input;
	const output = override?.output ?? entry?.output ?? model.cost.output;
	const cacheRead = override?.cacheRead ?? entry?.cacheRead ?? model.cost.cacheRead;
	const cacheWrite = override?.cacheWrite ?? entry?.cacheWrite ?? model.cost.cacheWrite;
	const coefficient = Math.max(0, override?.costCoef ?? options.costCoef ?? 1);
	const source: PriceSource = override
		? "override"
		: entry
			? "litellm"
			: input + output > 0
				? "catalog"
				: "unknown";
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		source,
		updatedAt: override ? now : (entry ? options.catalogUpdatedAt ?? 0 : 0),
		coefficient,
	};
}

/**
 * Estimated USD cost of one request. Token-based instead of a raw
 * input+output price sum, so output-heavy tasks prefer cheap-output
 * models. The user coefficient scales the effective price.
 */
export function estimateRequestCostUsd(
	price: ResolvedModelPrice,
	inputTokens: number,
	outputTokens: number,
): number {
	return (inputTokens * price.input + outputTokens * price.output) * price.coefficient / 1_000_000;
}

/** Compact price label for decision reasons and diagnostics. */
export function formatPriceSummary(
	price: Pick<ResolvedModelPrice, "input" | "output" | "source" | "coefficient">,
): string {
	const coefficient = price.coefficient !== 1 ? ` ×${trimNumber(price.coefficient)}` : "";
	return `$${trimNumber(price.input)}/$${trimNumber(price.output)} per 1M (${price.source}${coefficient})`;
}

function trimNumber(value: number): string {
	return String(Number(value.toFixed(4)));
}
