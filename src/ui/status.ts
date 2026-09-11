import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { modelLabel } from "../pi/activation.ts";
import type { SessionRuntimeState } from "../types.ts";

export const STATUS_KEY = "pi-auto-model";

function activationLabel(state: SessionRuntimeState): string {
	switch (state.activation) {
		case "active":
			return "ON";
		case "suspended-by-user":
			return "OFF (manual)";
		default:
			return "OFF";
	}
}

export function formatFooterStatus(
	state: SessionRuntimeState,
	currentModel: Model<any> | undefined,
): string {
	const route = state.lastDecision?.targetId
		?? (state.sessionRoute.provider && state.sessionRoute.modelId
			? `${state.sessionRoute.provider}/${state.sessionRoute.modelId}`
			: "none");
	const policy = state.manualOverrides.policy
		?? state.lastDecision?.policy
		?? state.routingPolicy
		?? "balanced";
	const pool = state.manualOverrides.pool ?? state.routingPool ?? "none";
	const model = modelLabel(currentModel);
	return `Auto ${activationLabel(state)} · ${route} · ${policy} · ${pool} · ${model}`;
}

export function updateAutoModelStatus(
	ctx: ExtensionContext,
	state: SessionRuntimeState,
	currentModel: Model<any> | undefined = ctx.model,
): void {
	ctx.ui.setStatus(STATUS_KEY, formatFooterStatus(state, currentModel));
}

export function clearAutoModelStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
}
