import type { Model } from "@earendil-works/pi-ai";
import { modelTargetId, type ModelIdentity } from "../types.ts";

export interface IdentityCatalog {
	readonly [targetId: string]: string;
}

export interface ModelAliases {
	readonly [targetId: string]: string;
}

function isolatedIdentity(model: Model<any>): ModelIdentity {
	return {
		logicalModelId: `isolated:${modelTargetId(model)}`,
		confidence: "unknown",
		source: "isolated",
	};
}

export function resolveModelIdentity(
	model: Model<any>,
	aliases: ModelAliases = {},
	catalog: IdentityCatalog = {},
): ModelIdentity {
	const targetId = modelTargetId(model);
	const alias = aliases[targetId];
	if (alias) {
		return {
			logicalModelId: alias,
			confidence: "declared",
			source: "user",
		};
	}

	const catalogIdentity = catalog[targetId];
	if (catalogIdentity) {
		return {
			logicalModelId: catalogIdentity,
			confidence: "exact",
			source: "catalog",
		};
	}

	// Gateway IDs in the form vendor/model are deterministic provider-neutral
	// identities, not fuzzy name matches.
	if (/^(anthropic|deepseek|google|meta|mistral|openai|qwen|x-ai|z-ai)\/[^/]+/.test(model.id)) {
		return {
			logicalModelId: model.id.replace("/", ":"),
			confidence: "exact",
			source: "canonical",
		};
	}

	return isolatedIdentity(model);
}
