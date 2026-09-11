import { readFile } from "node:fs/promises";
import {
	DEFAULT_CONFIG,
	type AutoModelConfig,
} from "./defaults.ts";
import { normalizeRoutingPolicy } from "../types.ts";

export async function loadConfig(
	path: string,
	fallback: AutoModelConfig = DEFAULT_CONFIG,
): Promise<AutoModelConfig> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AutoModelConfig>;
		return {
			...fallback,
			...parsed,
			policy: normalizeRoutingPolicy(parsed.policy) ?? fallback.policy,
			pool: typeof parsed.pool === "string" ? parsed.pool : fallback.pool,
			constraints: { ...fallback.constraints, ...parsed.constraints },
			aliases: { ...fallback.aliases, ...parsed.aliases },
			quota: {
				...fallback.quota,
				...parsed.quota,
				providers: { ...fallback.quota.providers, ...parsed.quota?.providers },
			},
			budget: {
				...fallback.budget,
				...parsed.budget,
				providers: { ...fallback.budget.providers, ...parsed.budget?.providers },
			},
			pools: { ...fallback.pools, ...parsed.pools },
			classifier: { ...fallback.classifier, ...parsed.classifier },
		};
	} catch {
		return {
			...fallback,
			pool: fallback.pool,
			constraints: { ...fallback.constraints },
			aliases: { ...fallback.aliases },
			quota: {
				...fallback.quota,
				providers: { ...fallback.quota.providers },
			},
			budget: {
				...fallback.budget,
				providers: { ...fallback.budget.providers },
			},
			pools: { ...fallback.pools },
			classifier: { ...fallback.classifier },
		};
	}
}

export function mergeConfig(base: AutoModelConfig, override: AutoModelConfig): AutoModelConfig {
	return {
		...base,
		...override,
		policy: normalizeRoutingPolicy(override.policy) ?? base.policy,
		pool: override.pool ?? base.pool,
		constraints: { ...base.constraints, ...override.constraints },
		aliases: { ...base.aliases, ...override.aliases },
		quota: {
			...base.quota,
			...override.quota,
			providers: { ...base.quota.providers, ...override.quota.providers },
		},
		budget: {
			...base.budget,
			...override.budget,
			providers: { ...base.budget.providers, ...override.budget.providers },
		},
		pools: { ...base.pools, ...override.pools },
		classifier: { ...base.classifier, ...override.classifier },
	};
}
