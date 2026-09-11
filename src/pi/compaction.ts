import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
	modelTargetId,
	type RouteTarget,
	type SessionCompactFailedEvent,
	type SessionRuntimeState,
	type ThinkingLevel,
} from "../types.ts";
import { applyRoute } from "./apply.ts";
import { isAutoModel } from "./auto-model.ts";

function modelCost(model: Model<any>): number {
	return model.cost.input + model.cost.output;
}

function canFitCompaction(model: Model<any>, tokensBefore: number): boolean {
	return model.contextWindow > tokensBefore;
}

function selectCheapCompactionTarget(
	ctx: ExtensionContext,
	tokensBefore: number,
): RouteTarget | undefined {
	const candidates = ctx.modelRegistry
		.getAvailable()
		.filter((model) => !isAutoModel(model))
		.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
		.filter((model) => canFitCompaction(model, tokensBefore))
		.sort((left, right) => {
			const costDelta = modelCost(left) - modelCost(right);
			return costDelta !== 0 ? costDelta : right.contextWindow - left.contextWindow;
		});
	const model = candidates[0];
	return model ? { model, id: modelTargetId(model) } : undefined;
}

function findModelByTargetId(ctx: ExtensionContext, targetId: string): Model<any> | undefined {
	const separator = targetId.indexOf("/");
	if (separator < 1) {
		return undefined;
	}
	return ctx.modelRegistry.find(targetId.slice(0, separator), targetId.slice(separator + 1));
}

export async function handleBeforeCompact(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	state: SessionRuntimeState,
): Promise<void> {
	if (state.activation !== "active") {
		return;
	}

	const target = selectCheapCompactionTarget(ctx, event.preparation.tokensBefore);
	if (!target || !ctx.model) {
		return;
	}

	state.compactionSuspend = {
		savedTargetId: modelTargetId(ctx.model),
		savedThinking: ctx.thinkingLevel ?? state.sessionRoute.thinking ?? "off",
	};

	try {
		await state.lock.run(async () => {
			await applyRoute(pi, state, target, "off");
		});
		ctx.ui.notify(`Pi Auto Model compaction → ${target.id} · off`, "info");
	} catch {
		state.compactionSuspend = undefined;
		ctx.ui.notify("Pi Auto Model compaction routing failed, using the current model.", "warning");
	}
}

export async function restoreAfterCompaction(
	pi: ExtensionAPI,
	_ctxEvent: SessionCompactEvent | SessionCompactFailedEvent,
	ctx: ExtensionContext,
	state: SessionRuntimeState | undefined,
): Promise<void> {
	const saved = state?.compactionSuspend;
	if (!state || !saved) {
		return;
	}

	try {
		const model = findModelByTargetId(ctx, saved.savedTargetId);
		if (!model) {
			ctx.ui.notify("Pi Auto Model could not restore the pre-compaction model.", "warning");
			return;
		}

		await state.lock.run(async () => {
			await applyRoute(
				pi,
				state,
				{ model, id: saved.savedTargetId },
				saved.savedThinking as ThinkingLevel,
			);
		});
		ctx.ui.notify(`Pi Auto Model restored ${saved.savedTargetId}.`, "info");
	} catch {
		ctx.ui.notify("Pi Auto Model could not restore the pre-compaction model.", "warning");
	} finally {
		state.compactionSuspend = undefined;
		state.updatedAt = Date.now();
	}
}
