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
import { DEFAULT_CONFIG, type AutoModelConfig } from "../src/config/defaults.ts";
import { loadConfig, mergeConfig } from "../src/config/loader.ts";
import { appendDecision } from "../src/storage/jsonl.ts";
import {
	BudgetLedger,
	estimateCost,
} from "../src/budget/budget.ts";
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
	type ProviderQuotaObservation,
	type SessionCompactFailedEvent,
} from "../src/types.ts";
import {
	registerAutoModelCommand,
	registerUnavailableAutoModelCommand,
} from "../src/ui/commands.ts";
import { RouteMetrics } from "../src/metrics/route-metrics.ts";
import {
	buildProviderQuotaSignals,
	isProviderQuotaBlocked,
} from "../src/quota/uvi.ts";
import { QuotaAdapterRegistry } from "../src/quota/adapters.ts";
import {
	isAutoModel,
	AUTO_MODEL_ID,
	AUTO_MODEL_PROVIDER,
	registerAutoModelProvider,
} from "../src/pi/auto-model.ts";
import { clearAutoModelStatus, updateAutoModelStatus } from "../src/ui/status.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function mergeQuotaObservation(
	current: ProviderQuotaObservation | undefined,
	next: ProviderQuotaObservation,
): ProviderQuotaObservation {
	return {
		uvi: Math.max(current?.uvi ?? 0, next.uvi ?? 0) || undefined,
		retryAt: Math.max(current?.retryAt ?? 0, next.retryAt ?? 0) || undefined,
		source: next.source,
	};
}

function notifyAfterModelSelection(
	ctx: ExtensionContext,
	message: string,
): void {
	setTimeout(() => ctx.ui.notify(message, "info"), 0);
}

function safeHandler<E>(
	name: string,
	handler: (event: E, ctx: ExtensionContext) => Promise<void> | void,
): (event: E, ctx: ExtensionContext) => Promise<void> {
	return async (event, ctx) => {
		try {
			await handler(event, ctx);
		} catch (error) {
			ctx.ui.notify(`Pi Auto Model ${name} failed: ${errorMessage(error)}`, "warning");
		}
	};
}

function contextIsCompatible(ctx: ExtensionContext): boolean {
	const probe = probeContextCapabilities(ctx);
	if (!probe.ok) {
		ctx.ui.notify(
			`Pi Auto Model disabled: incompatible Pi context (missing ${probe.missing.join(", ")})`,
			"error",
		);
	}
	return probe.ok;
}

export default function autoModel(pi: ExtensionAPI): void {
	registerAutoModelProvider(pi);
	const store = new RuntimeStateStore();
	const circuits = new CircuitBreaker();
	const metrics = new RouteMetrics();
	const budgetLedger = new BudgetLedger();
	const quotaAdapters = new QuotaAdapterRegistry();
	const configs = new Map<string, AutoModelConfig>();
	const globalDir = process.env.USERPROFILE ? join(process.env.USERPROFILE, ".pi", "agent") : ctxlessAgentDir();
	const metricsPath = join(globalDir, "auto-model", "metrics.json");
	const budgetPath = join(globalDir, "auto-model", "budget.json");
	const piProbe = probePiCapabilities(pi);

	if (!piProbe.ok) {
		registerUnavailableAutoModelCommand(pi, piProbe.missing);
		return;
	}

	registerAutoModelCommand(
		pi,
		store,
		circuits,
		metrics,
		(ctx) => configs.get(ctx.sessionManager.getSessionId())?.constraints ?? DEFAULT_CONFIG.constraints,
		(ctx) => buildProviderQuotaSignals(
			metrics.providerUsageSnapshot(),
			configs.get(ctx.sessionManager.getSessionId())?.quota ?? DEFAULT_CONFIG.quota,
		),
		(ctx) => ({
			usage: budgetLedger.snapshot(),
			config: configs.get(ctx.sessionManager.getSessionId())?.budget ?? DEFAULT_CONFIG.budget,
		}),
		(ctx) => configs.get(ctx.sessionManager.getSessionId())?.pools ?? DEFAULT_CONFIG.pools,
	);

	pi.on(
		"session_start",
		safeHandler<SessionStartEvent>("session_start", async (_event, ctx) => {
			if (!contextIsCompatible(ctx)) {
				return;
			}
			handleSessionStart(_event, ctx, store);
			await metrics.load(metricsPath);
			await budgetLedger.load(budgetPath);
			const global = await loadConfig(join(globalDir, "auto-model.json"));
			const config = ctx.isProjectTrusted()
				? mergeConfig(global, await loadConfig(join(ctx.cwd, ".pi", "auto-model.json"), global))
				: global;
			configs.set(ctx.sessionManager.getSessionId(), config);
			metrics.setQuotaWindow(config.quota.windowMs);
			const state = stateForContext(store, ctx);
			state.routingPolicy = config.policy;
			state.routingPool = config.pool;
			if (config.pool && !config.pools[config.pool]) {
				ctx.ui.notify(`Pi Auto Model: configured pool "${config.pool}" was not found. Using all eligible models.`, "warning");
			}
			if (config.enabled) {
				const preserveForkActivation = _event.reason === "fork";
				if (!preserveForkActivation || state.activation === "active") {
					setActivation(state, "active");
				}
				const shouldSelectAuto =
					_event.reason === "startup" ||
					_event.reason === "new" ||
					(_event.reason === "fork" && state.activation === "active");
				if (shouldSelectAuto && !isAutoModel(ctx.model)) {
					const autoModel = ctx.modelRegistry.find(AUTO_MODEL_PROVIDER, AUTO_MODEL_ID);
					if (autoModel) {
						state.inFlightSelfSet++;
						try {
							await pi.setModel(autoModel);
						} finally {
							state.inFlightSelfSet--;
						}
					}
				}
			}
			updateAutoModelStatus(ctx, state);
		}),
	);

	pi.on(
		"model_select",
		safeHandler<ModelSelectEvent>("model_select", (event, ctx) => {
			if (!contextIsCompatible(ctx)) {
				return;
			}
			const state = stateForContext(store, ctx);
			const selection = handleModelSelect(event, state);
			updateAutoModelStatus(ctx, state, event.model);
			if (selection === "manual") {
				notifyAfterModelSelection(
					ctx,
					`Pi Auto Model disabled: manually selected ${event.model.provider}/${event.model.id}. Select pi-auto-model/auto in /model to re-enable it.`,
				);
			} else if (selection === "auto" && event.source !== "restore") {
				notifyAfterModelSelection(ctx, "Pi Auto Model enabled for this session.");
			}
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

			const activeFailure = state.activeTask?.lastFailure && state.activeTask.routeTargetId
				? {
						targetId: state.activeTask.routeTargetId,
						status: state.activeTask.lastFailure.status,
						attemptedTargetIds: state.activeTask.attemptedTargetIds,
					}
				: undefined;
			const previousFailure = activeFailure ?? state.lastFailedRoute;
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
			const poolName = state.manualOverrides.pool ?? config.pool;
			const pool = poolName ? config.pools[poolName] : undefined;
			const poolAttempts = pool
				? metrics.targetAttempts(pool.windowHours ?? 24)
				: undefined;
			const quotaSignals = buildProviderQuotaSignals(
				metrics.providerUsageSnapshot(),
				config.quota,
			);
			const nonCircuitTargets = candidateResolution.targets.filter(
				(target) => !circuits.isOpen(target.id),
			);
			const poolEligibleTargets = pool
				? nonCircuitTargets.filter((target) => pool.targets.some((entry) => entry.id === target.id && entry.weight > 0))
				: nonCircuitTargets;
			const quotaEligibleTargets = poolEligibleTargets.filter(
				(target) => !isProviderQuotaBlocked(quotaSignals.get(target.model.provider)),
			);
			const healthyTargets = quotaEligibleTargets.length > 0
				? quotaEligibleTargets
				: poolEligibleTargets;
			if (healthyTargets.length === 0) {
				const failure = candidateResolution.failure;
				if (poolName && pool) {
					ctx.ui.notify(`Pi Auto Model pool "${poolName}" has no eligible target after health, quota, and circuit checks.`, "error");
				} else if (failure) {
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
				quota: quotaSignals,
				pool,
				poolAttempts,
			});
			const retryTarget = previousFailure
				? chooseFailoverTarget(
						healthyTargets,
						previousFailure.targetId,
						previousFailure.attemptedTargetIds,
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
						reason: ["retry failover", `after ${previousFailure?.status}`],
					}
				: defaultPlan;
			if (!plan) {
				ctx.ui.notify(
					"Pi Auto Model: no eligible model can satisfy this task's vision, context, or output requirements. Current model unchanged.",
					"error",
				);
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
						quota: quotaSignals,
					})
				: undefined;
			let effectivePlan = pinnedPlan ?? plan;
			let effectiveEstimate = estimateCost(
				effectivePlan.target,
				ctx.getContextUsage()?.tokens ?? 0,
				profile,
			);
			let budgetDecision = budgetLedger.evaluate(
				effectiveEstimate,
				effectivePlan.target.model.provider,
				config.budget,
			);
			if (budgetDecision.action === "downgrade" && !pinnedPlan) {
				const cheaperPlan = planRoute({
					targets: healthyTargets,
					profile,
					currentTargetId: ctx.model ? modelTargetId(ctx.model) : undefined,
					contextTokens: ctx.getContextUsage()?.tokens ?? 0,
					policy: "price",
					preferences: state.feedbackPreferences,
					quota: quotaSignals,
					pool,
					poolAttempts,
				});
				if (cheaperPlan) {
					const cheaperEstimate = estimateCost(
						cheaperPlan.target,
						ctx.getContextUsage()?.tokens ?? 0,
						profile,
					);
					if (cheaperEstimate < effectiveEstimate) {
						effectivePlan = cheaperPlan;
						effectiveEstimate = cheaperEstimate;
						budgetDecision = budgetLedger.evaluate(
							effectiveEstimate,
							effectivePlan.target.model.provider,
							config.budget,
						);
					}
				}
			}
			if (budgetDecision.action === "block") {
				ctx.ui.notify(
					`Pi Auto Model budget exceeded (${budgetDecision.exceeded.join(", ") || "task"}). Current model unchanged.`,
					"warning",
				);
				return;
			}
			const thinking = state.manualOverrides.thinkingMode === "fixed"
				? state.manualOverrides.fixedThinking ?? effectivePlan.thinking
				: state.manualOverrides.thinkingMode === "pi"
					? ctx.thinkingLevel ?? effectivePlan.thinking
					: effectivePlan.thinking;

			await state.lock.run(async () => {
				await applyRoute(pi, state, effectivePlan.target, thinking);
			});

			const now = Date.now();
			state.lastFailedRoute = undefined;
			state.activeTask = {
				startedAt: now,
				lastActivityAt: now,
				phase: "applied",
				routeTargetId: effectivePlan.target.id,
				thinking,
				profile,
				estimatedCostUsd: effectiveEstimate,
				failover: retryTarget !== undefined,
				attemptedTargetIds: previousFailure
					? [...previousFailure.attemptedTargetIds, effectivePlan.target.id]
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
			budgetLedger.record(effectivePlan.target.model.provider, effectiveEstimate);
			void budgetLedger.flush().catch(() => {});
			updateAutoModelStatus(ctx, state, effectivePlan.target.model);
			void appendDecision(join(globalDir, "auto-model", "decisions.jsonl"), state.lastDecision!).catch(() => {});
			ctx.ui.notify(
				`Pi Auto Model → ${effectivePlan.target.id} · ${thinking}\nWhy: ${[
					...effectivePlan.reason,
					...(budgetDecision.action !== "allow"
						? [`budget ${budgetDecision.action}`, ...budgetDecision.exceeded]
						: []),
				].join(" · ")}`,
				"info",
			);
		}),
	);

	pi.on("after_provider_response", safeHandler<AfterProviderResponseEvent>(
		"after_provider_response",
		(event, ctx) => {
			const state = store.get(ctx.sessionManager.getSessionId());
			if (!state?.activeTask) {
				return;
			}
			const now = Date.now();
			const provider = ctx.model?.provider ?? state.activeTask.routeTargetId?.split("/", 1)[0];
			const observation = provider
				? quotaAdapters.observe(provider, event.headers, now)
				: undefined;
			if (observation) {
				state.activeTask.quotaObservation = mergeQuotaObservation(
					state.activeTask.quotaObservation,
					observation,
				);
			}
			if (event.status < 400) {
				state.activeTask.lastActivityAt = now;
				state.updatedAt = now;
				return;
			}
			state.activeTask.lastFailure = { status: event.status, at: Date.now() };
			if (state.activeTask.routeTargetId) {
				circuits.record(
					state.activeTask.routeTargetId,
					event.status,
					now,
					observation?.retryAt,
				);
			}
			if (!state.activeTask.resultRecorded && state.activeTask.routeTargetId) {
				state.lastFailedRoute = {
					targetId: state.activeTask.routeTargetId,
					status: event.status,
					at: now,
					attemptedTargetIds: [...state.activeTask.attemptedTargetIds],
				};
				metrics.record({
					targetId: state.activeTask.routeTargetId,
					success: false,
					latencyMs: Date.now() - state.activeTask.startedAt,
					estimatedCostUsd: state.activeTask.estimatedCostUsd,
					status: event.status,
					retryAt: observation?.retryAt,
					quotaObservation: state.activeTask.quotaObservation,
					failover: state.activeTask.failover,
				});
				state.activeTask.resultRecorded = true;
				void metrics.flush().catch(() => {});
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
		if (!state.activeTask.resultRecorded && state.activeTask.routeTargetId) {
			state.lastFailedRoute = undefined;
			metrics.record({
				targetId: state.activeTask.routeTargetId,
				success: true,
				latencyMs: Date.now() - state.activeTask.startedAt,
				estimatedCostUsd: state.activeTask.estimatedCostUsd,
				quotaObservation: state.activeTask.quotaObservation,
				failover: state.activeTask.failover,
			});
			void metrics.flush().catch(() => {});
		}
		state.activeTask = undefined;
		state.updatedAt = Date.now();
		updateAutoModelStatus(ctx, state);
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
			ctx.ui.notify(`Pi Auto Model context failed: ${errorMessage(error)}`, "warning");
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
				updateAutoModelStatus(ctx, state);
			}
		}),
	);

	pi.on(
		"session_shutdown",
		safeHandler<SessionShutdownEvent>("session_shutdown", (_event, ctx) => {
			clearAutoModelStatus(ctx);
			void metrics.flush().catch(() => {});
			void budgetLedger.flush().catch(() => {});
			store.delete(ctx.sessionManager.getSessionId());
		}),
	);
}

function ctxlessAgentDir(): string {
	return join(process.cwd(), ".pi", "agent");
}
