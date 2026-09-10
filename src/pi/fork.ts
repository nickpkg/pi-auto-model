import type {
	ExtensionContext,
	SessionBeforeForkEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { RuntimeStateStore } from "./runtime-store.ts";

export function handleBeforeFork(
	_event: SessionBeforeForkEvent,
	ctx: ExtensionContext,
	store: RuntimeStateStore,
): void {
	const parent = store.getOrCreate(ctx.sessionManager.getSessionId(), ctx.model);
	store.queueFork(parent);
}

export function handleSessionStart(
	event: SessionStartEvent,
	ctx: ExtensionContext,
	store: RuntimeStateStore,
): void {
	const sessionId = ctx.sessionManager.getSessionId();
	if (event.reason === "fork") {
		store.consumeFork(sessionId, ctx.model);
	}
	store.getOrCreate(sessionId, ctx.model);
}
