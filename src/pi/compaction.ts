import { randomUUID } from "node:crypto";
import { compact, type CompactionResult, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { SessionRuntimeState } from "../types.ts";
import type { AutoModelConfig } from "../config/defaults.ts";
import type { BudgetLedger, BudgetReservation } from "../budget/budget.ts";
import type { CircuitBreaker } from "../health/circuit-breaker.ts";
import { analyzeTask } from "../task/local-analyzer.ts";
import { resolvePiCandidates } from "./registry-adapter.ts";
import { createStreamProxyHandler } from "./stream-proxy.ts";

export async function handleBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	state: SessionRuntimeState,
	config: AutoModelConfig,
	budget: BudgetLedger,
	circuits: CircuitBreaker,
): Promise<{ cancel: true } | { compaction: CompactionResult } | undefined> {
	if (state.activation !== "active") return;
	if (event.signal?.aborted) return { cancel: true };
	const targets = resolvePiCandidates(ctx, config.constraints).targets
		.filter(({ model, id }) => !circuits.isOpen(id) && model.input.includes("text") &&
			model.contextWindow > event.preparation.tokensBefore + Math.min(model.maxTokens, event.preparation.settings.reserveTokens))
		.sort((a, b) => (a.model.cost.input + a.model.cost.output) - (b.model.cost.input + b.model.cost.output));
	const target = targets[0];
	if (!target) return { cancel: true };
	let spent = 0;
	// Pi captures the native request model before this hook; setModel here cannot reroute it.
	// Return Pi's own compaction result, preserving split turns and file-operation tracking.
	const result = await compact(event.preparation, target.model, undefined, undefined,
		event.customInstructions, event.signal, "off", (_model, context, options) => {
			const outputTokens = Math.min(options?.maxTokens ?? target.model.maxTokens, target.model.maxTokens);
			const profile = analyzeTask({ prompt: "summarize conversation" });
			profile.constraints.requiredOutputTokens = outputTokens;
			let reservation: BudgetReservation | undefined;
			const stream = createStreamProxyHandler({
				getRegistry: () => ctx.modelRegistry,
				circuits,
				getPendingStream: () => ({ targets: [target], profile, thinking: "off", requestId: randomUUID(),
					sessionId: state.sessionId, estimatedCostUsd: 0, apisUsed: [], firstOutputTimeoutMs: config.failover.firstOutputTimeoutMs }),
				beforeAttempt: async () => {
					// ponytail: text/JSON heuristic; use a tokenizer if measured underestimation warrants it.
					const inputTokens = Math.ceil(JSON.stringify(context).length / 3);
					if (inputTokens + outputTokens >= target.model.contextWindow) return false;
					const estimate = (inputTokens * target.model.cost.input + outputTokens * target.model.cost.output) / 1_000_000;
					const at = Date.now();
					const limits = { ...config.budget, maxUsdPerTask: config.budget.maxUsdPerTask === undefined
						? undefined : Math.max(0, config.budget.maxUsdPerTask - spent) };
					const decision = await budget.reserve(target.model.provider, estimate, limits, at, state.sessionId);
					if (decision.action === "block" || decision.action === "avoid") return false;
					reservation = { provider: target.model.provider, estimate, at, sessionId: state.sessionId };
					spent += estimate;
					return true;
				},
				onAttemptSettled: async ({ message }) => {
					const actual = message?.usage?.cost?.total;
					if (reservation && typeof actual === "number" && Number.isFinite(actual) && actual > 0) {
						await budget.reconcile(reservation, actual);
						spent += actual - reservation.estimate;
					}
				},
			});
			return stream(target.model, context, options);
		}, undefined, { enabled: false, maxRetries: 0, baseDelayMs: 0 }, undefined, state.sessionId);
	ctx.ui.notify(`Pi Auto Model compaction → ${target.id} · off`, "info");
	return { compaction: result };
}
