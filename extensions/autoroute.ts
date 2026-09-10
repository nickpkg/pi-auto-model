import type {
	BeforeAgentStartEvent,
	AgentSettledEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionCompactEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import {
	probeContextCapabilities,
	probePiCapabilities,
} from "../src/pi/capability-probe.ts";
import { applyRoute } from "../src/pi/apply.ts";
import {
	forceSettleStaleTask,
	handleModelSelect,
	settlePendingActivation,
	setActivation,
	stateForContext,
} from "../src/pi/activation.ts";
import {
	handleBeforeCompact,
	restoreAfterCompaction,
} from "../src/pi/compaction.ts";
import { handleBeforeFork, handleSessionStart } from "../src/pi/fork.ts";
import {
	formatCandidateFailure,
	resolvePiCandidates,
} from "../src/pi/registry-adapter.ts";
import { RuntimeStateStore } from "../src/pi/runtime-store.ts";
import { planRoute } from "../src/routing/route-planner.ts";
import { chooseFailoverTarget } from "../src/routing/failover.ts";
import { chooseThinkingLevel } from "../src/routing/thinking-router.ts";
import { CircuitBreaker } from "../src/health/circuit-breaker.ts";
import { DEFAULT_CONFIG, type AutorouteConfig } from "../src/config/defaults.ts";
import { loadConfig, mergeConfig } from "../src/config/loader.ts";
import { appendDecision } from "../src/storage/jsonl.ts";
import { estimateCost, evaluateBudget } from "../src/budget/budget.ts";
import { analyzeTask } from "../src/task/local-analyzer.ts";
import { refineWithClassifier, shouldClassify } from "../src/task/classifier.ts";
import {
	compatibilityAction,
	stripThinkingForRequest,
} from "../src/compat/guard.ts";
import {
	modelTargetId,
	type AfterProviderResponseEvent,
	type ModelSelectEvent,
	type SessionCompactFailedEvent,
} from "../src/types.ts";
import {
	registerRouteCommand,
	registerUnavailableRouteCommand,
} from "../src/ui/commands.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safeHandler<E>(
	name: string,
	handler: (event: E, ctx: ExtensionContext) => Promise<void> | void,
): (event: E, ctx: ExtensionContext) => Promise<void> {
	return async (event, ctx) => {
		try {
			await handler(event, ctx);
		} catch (error) {
			ctx.ui.notify(`Autoroute ${name} failed: ${errorMessage(error)}`, "warning");
		}
	};
}

function contextIsCompatible(ctx: ExtensionContext): boolean {
	const probe = probeContextCapabilities(ctx);
	if (!probe.ok) {
		ctx.ui.notify(
			`Autoroute disabled: incompatible Pi context (missing ${probe.missing.join(", ")})`,
			"error",
		);
	}
	return probe.ok;
}

export default function autoroute(pi: ExtensionAPI): void {
	const store = new RuntimeStateStore();
	const circuits = new CircuitBreaker();
	const configs = new Map<string, AutorouteConfig>();
	const globalDir = process.env.USERPROFILE ? join(process.env.USERPROFILE, ".pi", "agent") : ctxlessAgentDir();
	const piProbe = probePiCapabilities(pi);

	if (!piProbe.ok) {
		registerUnavailableRouteCommand(pi, piProbe.missing);
		return;
	}

	registerRouteCommand(pi, store);

	pi.on(
		"session_start",
		safeHandler<SessionStartEvent>("session_start", async (_event, ctx) => {
			if (!contextIsCompatible(ctx)) {
				return;
			}
			handleSessionStart(_event, ctx, store);
			const global = await loadConfig(join(globalDir, "autoroute.json"));
			const config = ctx.isProjectTrusted()
				? mergeConfig(global, await loadConfig(join(ctx.cwd, ".pi", "autoroute.json"), global))
				: global;
			configs.set(ctx.sessionManager.getSessionId(), config);
			if (config.enabled) {
				setActivation(stateForContext(store, ctx), "active");
			}
		}),
	);

	pi.on(
		"model_select",
		safeHandler<ModelSelectEvent>("model_select", (event, ctx) => {
			if (!contextIsCompatible(ctx)) {
				return;
			}
			const state = stateForContext(store, ctx);
			handleModelSelect(event, state);
		}),
	);

	pi.on(
		"before_agent_start",
		safeHandler<BeforeAgentStartEvent>("before_agent_start", async (_event, ctx) => {
			if (!contextIsCompatible(ctx)) {
				return;
			}

			const state = stateForContext(store, ctx);
			const config = configs.get(state.sessionId) ?? DEFAULT_CONFIG;
			forceSettleStaleTask(state, Date.now());
			state.compactionSuspend = undefined;
			settlePendingActivation(state);
			if (state.activation !== "active") {
				return;
			}

			const retrying =
				state.activeTask?.lastFailure !== undefined &&
				state.activeTask.phase !== "settled";
			let profile = state.activeTask?.profile ?? analyzeTask({
				prompt: _event.prompt,
				imageCount: _event.images?.length,
				contextTokens: ctx.getContextUsage()?.tokens ?? 0,
			});
			if (shouldClassify(profile, config.classifier.enabled, config.classifier.confidenceThreshold)) {
				try {
					profile = await refineWithClassifier(ctx, profile, _event.prompt, config.classifier.timeoutMs);
				} catch {
					// Classifier failures intentionally fall back without user-facing output.
				}
			}
			const candidateResolution = resolvePiCandidates(ctx, config.constraints);
			const healthyTargets = candidateResolution.targets.filter(
				(target) => !circuits.isOpen(target.id),
			);
			if (healthyTargets.length === 0) {
				const failure = candidateResolution.failure;
				if (failure) {
					ctx.ui.notify(formatCandidateFailure(failure), "error");
				}
				return;
			}

			const defaultPlan = planRoute({
				targets: healthyTargets,
				profile,
				currentTargetId: ctx.model ? modelTargetId(ctx.model) : undefined,
				contextTokens: ctx.getContextUsage()?.tokens ?? 0,
				policy: state.manualOverrides.policy ?? config.policy,
				preferences: state.feedbackPreferences,
			});
			const retryTarget = retrying && state.activeTask?.routeTargetId
				? chooseFailoverTarget(
						healthyTargets,
						state.activeTask.routeTargetId,
						state.activeTask.attemptedTargetIds,
						config.aliases,
					)
				: undefined;
			const plan = retryTarget
				? {
						target: retryTarget,
						thinking: chooseThinkingLevel(retryTarget.model, profile),
						policy: defaultPlan?.policy ?? "balanced",
						score: defaultPlan?.score ?? {
							targetId: retryTarget.id,
							quality: 0,
							cost: 0,
							stickiness: 0,
							utility: 0,
						},
						reason: ["retry failover", `after ${state.activeTask?.lastFailure?.status}`],
					}
				: defaultPlan;
			if (!plan) {
				ctx.ui.notify(
					"Autoroute: no eligible model can satisfy this task's vision, context, or output requirements. Current model unchanged.",
					"error",
				);
				return;
			}
			const budgetAction = evaluateBudget(
				estimateCost(plan.target, ctx.getContextUsage()?.tokens ?? 0, profile),
				config.budget,
			);
			if (budgetAction === "block") {
				ctx.ui.notify("Autoroute budget exceeded. Current model unchanged.", "warning");
				return;
			}

			const pinned = state.manualOverrides.pinnedTargetId
				? candidateResolution.targets.find((target) => target.id === state.manualOverrides.pinnedTargetId)
				: undefined;
			const pinnedPlan = pinned
				? planRoute({
						targets: [pinned],
						profile,
						contextTokens: ctx.getContextUsage()?.tokens ?? 0,
						policy: state.manualOverrides.policy,
						preferences: state.feedbackPreferences,
					})
				: undefined;
			const effectivePlan = pinnedPlan ?? plan;
			const thinking = state.manualOverrides.thinkingMode === "fixed"
				? state.manualOverrides.fixedThinking ?? effectivePlan.thinking
				: state.manualOverrides.thinkingMode === "pi"
					? ctx.thinkingLevel ?? effectivePlan.thinking
					: effectivePlan.thinking;

			await state.lock.run(async () => {
				await applyRoute(pi, state, effectivePlan.target, thinking);
			});

			const now = Date.now();
			state.activeTask = {
				startedAt: now,
				lastActivityAt: now,
				phase: "applied",
				routeTargetId: effectivePlan.target.id,
				thinking,
				profile,
				attemptedTargetIds: retrying
					? [...(state.activeTask?.attemptedTargetIds ?? []), effectivePlan.target.id]
					: [effectivePlan.target.id],
			};
			store.recordDecision(state, {
				id: `route-${now}-${effectivePlan.target.id}`,
				targetId: effectivePlan.target.id,
				thinking,
				policy: effectivePlan.policy,
				reason: pinnedPlan ? ["user pin", ...effectivePlan.reason] : effectivePlan.reason,
				score: effectivePlan.score,
				taskKinds: profile.kinds,
				createdAt: now,
			});
			void appendDecision(join(globalDir, "autoroute", "decisions.jsonl"), state.lastDecision!).catch(() => {});
			ctx.ui.notify(
				`Autoroute → ${effectivePlan.target.id} · ${thinking}\nWhy: ${[...effectivePlan.reason, ...(budgetAction === "warn" ? ["budget warning"] : [])].join(" · ")}`,
				"info",
			);
		}),
	);

	pi.on("after_provider_response", safeHandler<AfterProviderResponseEvent>(
		"after_provider_response",
		(event, ctx) => {
			if (event.status < 400) {
				return;
			}
			const state = store.get(ctx.sessionManager.getSessionId());
			if (!state?.activeTask) {
				return;
			}
			state.activeTask.lastFailure = { status: event.status, at: Date.now() };
			if (state.activeTask.routeTargetId) {
				circuits.record(state.activeTask.routeTargetId, event.status);
			}
			state.activeTask.lastActivityAt = Date.now();
			state.updatedAt = Date.now();
		},
	));

	pi.on("agent_settled", safeHandler<AgentSettledEvent>("agent_settled", (_event, ctx) => {
		const state = store.get(ctx.sessionManager.getSessionId());
		if (!state?.activeTask) {
			return;
		}
		state.activeTask.phase = "settled";
		state.activeTask = undefined;
		state.updatedAt = Date.now();
	}));

	pi.on("context", async (event: ContextEvent, ctx) => {
		try {
			const state = store.get(ctx.sessionManager.getSessionId());
			const targetApi = ctx.model?.api;
			if (!state || !targetApi) {
				return;
			}
			if (compatibilityAction(state.sessionRoute.apisUsed ?? [], targetApi) === "keep") {
				return;
			}
			return {
				messages: stripThinkingForRequest(event.messages) as typeof event.messages,
			};
		} catch (error) {
			ctx.ui.notify(`Autoroute context failed: ${errorMessage(error)}`, "warning");
			return;
		}
	});

	pi.on(
		"session_before_compact",
		safeHandler<SessionBeforeCompactEvent>("session_before_compact", async (event, ctx) => {
			if (!contextIsCompatible(ctx)) {
				return;
			}
			const state = stateForContext(store, ctx);
			await handleBeforeCompact(pi, event, ctx, state);
		}),
	);

	pi.on(
		"session_compact",
		safeHandler<SessionCompactEvent>("session_compact", async (event, ctx) => {
			await restoreAfterCompaction(
				pi,
				event,
				ctx,
				store.get(ctx.sessionManager.getSessionId()),
			);
		}),
	);

	pi.on(
		"session_compact_failed",
		safeHandler<SessionCompactFailedEvent>("session_compact_failed", async (event, ctx) => {
			await restoreAfterCompaction(
				pi,
				event,
				ctx,
				store.get(ctx.sessionManager.getSessionId()),
			);
		}),
	);

	pi.on(
		"session_before_fork",
		safeHandler<SessionBeforeForkEvent>("session_before_fork", (event, ctx) => {
			if (!contextIsCompatible(ctx)) {
				return;
			}
			handleBeforeFork(event, ctx, store);
		}),
	);

	pi.on(
		"session_before_switch",
		safeHandler<SessionBeforeSwitchEvent>("session_before_switch", (_event, ctx) => {
			const state = store.get(ctx.sessionManager.getSessionId());
			if (state) {
				state.updatedAt = Date.now();
			}
		}),
	);

	pi.on(
		"session_shutdown",
		safeHandler<SessionShutdownEvent>("session_shutdown", (_event, ctx) => {
			store.delete(ctx.sessionManager.getSessionId());
		}),
	);
}

function ctxlessAgentDir(): string {
	return join(process.cwd(), ".pi", "agent");
}
