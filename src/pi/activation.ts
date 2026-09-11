import type {
	ExtensionContext,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type {
	AutoActivationState,
	ModelSelectEvent,
	SessionRuntimeState,
} from "../types.ts";
import { RuntimeStateStore } from "./runtime-store.ts";
import { isAutoModel } from "./auto-model.ts";

export function sessionIdOf(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

export function stateForContext(
	store: RuntimeStateStore,
	ctx: ExtensionContext,
): SessionRuntimeState {
	return store.getOrCreate(sessionIdOf(ctx), ctx.model);
}

export function handleModelSelect(
	event: ModelSelectEvent,
	state: SessionRuntimeState,
): "auto" | "manual" | "restore" | "internal" {
	if (state.inFlightSelfSet > 0) {
		return "internal";
	}

	if (isAutoModel(event.model)) {
		state.activation = "active";
		state.pendingActivation = undefined;
		state.manualOverrides.pinnedTargetId = undefined;
		state.updatedAt = Date.now();
		return "auto";
	}

	if (event.source === "restore") {
		state.activation = "suspended-by-user";
		state.pendingActivation = undefined;
		state.manualOverrides.pinnedTargetId = undefined;
		state.updatedAt = Date.now();
		return "restore";
	}

	// Unknown future sources should be treated as user intent by the caller's
	// conservative default. The current Pi type only exposes set/cycle/restore.
	state.activation = "suspended-by-user";
	state.pendingActivation = undefined;
	state.manualOverrides.pinnedTargetId = undefined;
	state.sessionRoute.apisUsed = [
		...new Set([...(state.sessionRoute.apisUsed ?? []), event.model.api]),
	];
	state.updatedAt = Date.now();
	return "manual";
}

export function setActivation(
	state: SessionRuntimeState,
	activation: AutoActivationState,
): void {
	state.activation = activation;
	state.pendingActivation = undefined;
	state.updatedAt = Date.now();
}

export function settlePendingActivation(state: SessionRuntimeState): void {
	if (!state.pendingActivation) {
		return;
	}
	state.activation = state.pendingActivation;
	state.pendingActivation = undefined;
	state.updatedAt = Date.now();
}

export function forceSettleStaleTask(
	state: SessionRuntimeState,
	now: number,
	staleTaskMs = 5 * 60 * 1000,
): boolean {
	if (!state.activeTask || now - state.activeTask.lastActivityAt <= staleTaskMs) {
		return false;
	}

	state.activeTask = undefined;
	state.updatedAt = now;
	return true;
}

export function modelLabel(model: Model<any> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

export function formatStatus(
	state: SessionRuntimeState,
	currentModel: Model<any> | undefined,
): string {
	const route = state.sessionRoute.provider && state.sessionRoute.modelId
		? `${state.sessionRoute.provider}/${state.sessionRoute.modelId}`
		: "none";
	return [
		`Pi Auto Model: ${state.activation}`,
		`Current model: ${modelLabel(currentModel)}`,
		`Last route: ${route}`,
		`Policy: ${state.manualOverrides.policy ?? state.lastDecision?.policy ?? state.routingPolicy ?? "balanced"}`,
	].join("\n");
}

export function activateFromCommand(
	_pi: ExtensionAPI,
	state: SessionRuntimeState,
): void {
	setActivation(state, "active");
}
