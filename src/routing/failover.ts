import { resolveModelIdentity, type ModelAliases } from "../models/identity.ts";
import type { RouteTarget } from "../types.ts";

export function chooseFailoverTarget(
	targets: readonly RouteTarget[],
	failedTargetId: string,
	attemptedTargetIds: readonly string[],
	aliases: ModelAliases = {},
): RouteTarget | undefined {
	const unattempted = targets.filter((target) => !attemptedTargetIds.includes(target.id));
	if (unattempted.length === 0) {
		return undefined;
	}

	const failed = targets.find((target) => target.id === failedTargetId);
	if (!failed) {
		return unattempted[0];
	}

	const failedLogicalId = resolveModelIdentity(failed.model, aliases).logicalModelId;
	return (
		unattempted.find(
			(target) => resolveModelIdentity(target.model, aliases).logicalModelId === failedLogicalId,
		) ?? unattempted[0]
	);
}
