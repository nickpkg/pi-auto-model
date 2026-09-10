import type { RouteTarget, LogicalModel } from "../types.ts";
import {
	resolveModelIdentity,
	type IdentityCatalog,
	type ModelAliases,
} from "./identity.ts";
import { deriveCapabilityPrior } from "./capability.ts";

export function normalizeLogicalModels(
	targets: readonly RouteTarget[],
	aliases: ModelAliases = {},
	catalog: IdentityCatalog = {},
): LogicalModel[] {
	const models = new Map<string, LogicalModel>();

	for (const target of targets) {
		const identity = resolveModelIdentity(target.model, aliases, catalog);
		const existing = models.get(identity.logicalModelId);
		if (existing) {
			existing.targets.push(target);
			continue;
		}

		models.set(identity.logicalModelId, {
			id: identity.logicalModelId,
			displayName: target.model.name,
			identity,
			capabilityPrior: deriveCapabilityPrior(target.model),
			targets: [target],
		});
	}

	return [...models.values()];
}
