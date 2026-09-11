import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, RouteTarget, SessionRuntimeState } from "../types.ts";

export class ApplyRouteError extends Error {
	readonly code = "SET_MODEL_FAILED";
	readonly targetId: string;

	constructor(targetId: string) {
		super(`Pi rejected model selection for ${targetId}`);
		this.name = "ApplyRouteError";
		this.targetId = targetId;
	}
}

export async function applyRoute(
	pi: ExtensionAPI,
	state: SessionRuntimeState,
	target: RouteTarget,
	thinking: ThinkingLevel,
): Promise<void> {
	state.inFlightSelfSet++;
	try {
		const applied = await pi.setModel(target.model);
		if (!applied) {
			throw new ApplyRouteError(target.id);
		}

		pi.setThinkingLevel(thinking);
		state.sessionRoute = {
			provider: target.model.provider,
			modelId: target.model.id,
			thinking,
			apisUsed: [...new Set([...(state.sessionRoute.apisUsed ?? []), target.model.api])],
		};
		state.updatedAt = Date.now();
	} finally {
		state.inFlightSelfSet--;
	}
}
