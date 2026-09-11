import { readFile } from "node:fs/promises";
import {
	DEFAULT_CONFIG,
	type AutoRouterConfig,
} from "./defaults.ts";
import { normalizeRoutingPolicy } from "../types.ts";

export async function loadConfig(
	path: string,
	fallback: AutoRouterConfig = DEFAULT_CONFIG,
): Promise<AutoRouterConfig> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AutoRouterConfig>;
		return {
			...fallback,
			...parsed,
			policy: normalizeRoutingPolicy(parsed.policy) ?? fallback.policy,
			constraints: { ...fallback.constraints, ...parsed.constraints },
			aliases: { ...fallback.aliases, ...parsed.aliases },
			budget: { ...fallback.budget, ...parsed.budget },
			classifier: { ...fallback.classifier, ...parsed.classifier },
		};
	} catch {
		return {
			...fallback,
			constraints: { ...fallback.constraints },
			aliases: { ...fallback.aliases },
			budget: { ...fallback.budget },
			classifier: { ...fallback.classifier },
		};
	}
}

export function mergeConfig(base: AutoRouterConfig, override: AutoRouterConfig): AutoRouterConfig {
	return {
		...base,
		...override,
		policy: normalizeRoutingPolicy(override.policy) ?? base.policy,
		constraints: { ...base.constraints, ...override.constraints },
		aliases: { ...base.aliases, ...override.aliases },
		budget: { ...base.budget, ...override.budget },
		classifier: { ...base.classifier, ...override.classifier },
	};
}
