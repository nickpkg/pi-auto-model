import type {
	BeforeAgentStartEvent,
	AgentEndEvent,
	AgentSettledEvent,
	MessageEndEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolCallEvent,
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
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	probeContextCapabilities,
	probePiCapabilities,
	contextHasProjectTrust,
	contextHasContextUsage,
} from "../src/pi/capability-probe.ts";
import {
	createStreamProxyHandler,
	type PendingStreamRequest,
	type AttemptResult,
} from "../src/pi/stream-proxy.ts";
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
import { parsePrefixPin, modeToMinimumTier } from "../src/task/prefix-parser.ts";
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
	type SessionRuntimeState,
} from "../src/types.ts";
import { buildFallbackPending } from "../src/pi/failsafe.ts";
import {
	registerAutoModelCommand,
	registerUnavailableAutoModelCommand,
} from "../src/ui/commands.ts";
import { RouteMetrics } from "../src/metrics/route-metrics.ts";
import { percentile } from "../src/metrics/route-metrics.ts";
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
import { UnifiedEventStore } from "../src/observability/event-store.ts";
import { QualityLearning } from "../src/routing/quality-learning.ts";
import { classifyProviderError } from "../src/health/provider-errors.ts";
import { deriveCapabilityPrior, tierRank } from "../src/models/capability.ts";

/**
 * Result of the normal routing pipeline in before_agent_start.
 * - `routed`: a pending stream plan was set and session state applied.
 * - `blocked`: the user's configuration intentionally stopped the request
 *   (budget block). Callers must NOT override this with a fallback.
 * - `failed`: routing could not produce a plan; callers should degrade to
 *   the fail-safe fallback so the user's request still succeeds.
 */
type AutoRouteOutcome =
	| { status: "routed" }
	| { status: "blocked" }
	| { status: "failed" };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Safely delivers a Pi UI notification. A notification failure must never
 * propagate back into Pi's event loop, so all internal notifies go through
 * this helper.
 */
function notifySafe(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "warning"): void {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Intentional: never let our own diagnostics break the user flow.
	}
}

/**
 * Safely returns the current context token count.
 * Returns 0 when the Pi runtime does not expose `getContextUsage()`.
 */
function contextTokensOf(ctx: ExtensionContext): number {
	if (!contextHasContextUsage(ctx)) return 0;
	return ctx.getContextUsage()?.tokens ?? 0;
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
	setTimeout(() => notifySafe(ctx, message, "info"), 0);
}

function safeHandler<E>(
	name: string,
	handler: (event: E, ctx: ExtensionContext) => Promise<void> | void,
): (event: E, ctx: ExtensionContext) => Promise<void> {
	return async (event, ctx) => {
		try {
			await handler(event, ctx);
		} catch (error) {
			notifySafe(ctx, `Pi Auto Model ${name} failed: ${errorMessage(error)}`, "warning");
		}
	};
}

function contextIsCompatible(ctx: ExtensionContext): boolean {
	const probe = probeContextCapabilities(ctx);
	if (!probe.ok) {
		notifySafe(
			ctx,
			`Pi Auto Model disabled: incompatible Pi context (missing ${probe.missing.join(", ")})`,
			"error",
		);
	}
	return probe.ok;
}

export default function autoModel(pi: ExtensionAPI): void {
	const store = new RuntimeStateStore();
	const circuits = new CircuitBreaker();
	const metrics = new RouteMetrics();
	const budgetLedger = new BudgetLedger();
	const quotaAdapters = new QuotaAdapterRegistry();
	const configs = new Map<string, AutoModelConfig>();
	const globalDir = resolveAgentDir();
	const metricsPath = join(globalDir, "auto-model", "metrics.json");
	const budgetPath = join(globalDir, "auto-model", "budget.json");
	const qualityPath = join(globalDir, "auto-model", "quality.json");
	const eventsPath = join(globalDir, "auto-model", "events.jsonl");
	const events = new UnifiedEventStore(eventsPath);
	const quality = new QualityLearning();
	const piProbe = probePiCapabilities(pi);

	// ─── Stream proxy shared state ───────────────────────────────
	// One plan per session prevents forks and parallel SDK sessions from
	// consuming or mutating each other's tool-loop route.
	const pendingStreams = new Map<string, PendingStreamRequest>();
	const emergencyBlockedSessions = new Set<string>();
	const routerHealth = new Map<string, { failures: number; bypassUntil?: number }>();
	let modelRegistry: ModelRegistry | undefined;
	const pendingFor = (sessionId?: string): PendingStreamRequest | undefined => {
		if (sessionId) return pendingStreams.get(sessionId);
		return pendingStreams.size === 1 ? pendingStreams.values().next().value : undefined;
	};
	const recordRouterFailure = (sessionId: string): void => {
		const current = routerHealth.get(sessionId) ?? { failures: 0 };
		current.failures++;
		// ponytail: fixed local circuit; make configurable only if real usage needs tuning.
		if (current.failures >= 3) current.bypassUntil = Date.now() + 60_000;
		routerHealth.set(sessionId, current);
	};

	const streamProxyHandler = createStreamProxyHandler({
		getRegistry: () => modelRegistry,
		circuits,
		getPendingStream: pendingFor,
		beforeAttempt: async (target, request) => {
			const state = store.get(request.sessionId);
			if (!state?.activeTask) return false;
			if (state.activeTask.accountedTargetIds?.includes(target.id)) return true;
			const config = configs.get(state.sessionId) ?? DEFAULT_CONFIG;
			const estimate = state.activeTask.profile
				? estimateCost(target, state.activeTask.inputTokens ?? 0, state.activeTask.profile)
				: state.activeTask.estimatedCostUsd ?? 0;
			const initial = budgetLedger.evaluate(estimate, target.model.provider, config.budget);
			if (initial.action === "block" || initial.action === "avoid") return false;
			if (initial.action === "downgrade" && state.activeTask.profile) {
				const hasCheaper = request.targets.some((candidate) =>
					candidate.id !== target.id &&
					estimateCost(candidate, state.activeTask!.inputTokens ?? 0, state.activeTask!.profile!) < estimate,
				);
				if (hasCheaper) return false;
			}
			const decision = await budgetLedger.reserve(target.model.provider, estimate, config.budget);
			if (decision.action === "block" || decision.action === "avoid") return false;
			state.activeTask.accountedTargetIds = [...(state.activeTask.accountedTargetIds ?? []), target.id];
			return true;
		},
		onAttemptResponse: (target, status, headers, request) => {
			const state = store.get(request.sessionId);
			if (!state?.activeTask) return;
			const now = Date.now();
			const observation = quotaAdapters.observe(target.model.provider, headers, now);
			if (observation) {
				state.activeTask.quotaObservation = mergeQuotaObservation(
					state.activeTask.quotaObservation,
					observation,
				);
				events.record({
					id: `quota-${state.activeTask.requestId}-${now}`,
					requestId: state.activeTask.requestId,
					sessionId: state.sessionId,
					kind: "quota_observation",
					at: now,
					targetId: target.id,
					provider: target.model.provider,
					source: observation.source,
					metadata: { uvi: observation.uvi, retryAt: observation.retryAt },
				});
			}
		},
		onAttemptSettled: (result: AttemptResult, request) => {
			const state = store.get(request.sessionId);
			if (!state?.activeTask) return;
			const now = Date.now();
			const attemptEstimate = state.activeTask.profile
				? estimateCost(result.target, state.activeTask.inputTokens ?? 0, state.activeTask.profile)
				: state.activeTask.estimatedCostUsd;
			metrics.record({
				targetId: result.target.id,
				success: result.success,
				latencyMs: result.latencyMs,
				estimatedCostUsd: attemptEstimate,
				status: result.status || undefined,
				quotaObservation: state.activeTask.quotaObservation,
				failover: !result.success && result.retryable,
			});
			state.activeTask.finalAttemptSuccess = result.success;
			if (!state.activeTask.attemptedTargetIds.includes(result.target.id)) {
				state.activeTask.attemptedTargetIds.push(result.target.id);
			}
			events.record({
				id: `proxy-response-${state.activeTask.requestId}-${result.target.id}-${now}`,
				requestId: state.activeTask.requestId,
				sessionId: state.sessionId,
				kind: "provider_response",
				at: now,
				targetId: result.target.id,
				provider: result.target.model.provider,
				status: result.status || undefined,
				success: result.success,
				latencyMs: result.latencyMs,
			});
			if (!result.success && result.retryable) {
				events.record({
					id: `proxy-failover-${state.activeTask.requestId}-${result.target.id}`,
					requestId: state.activeTask.requestId,
					sessionId: state.sessionId,
					kind: "failover",
					at: now,
					targetId: result.target.id,
					provider: result.target.model.provider,
					status: result.status || undefined,
					metadata: { retryable: true, inRequest: true },
				});
			}
			// Mark as recorded so agent_settled doesn't double-record.
			state.activeTask.resultRecorded = true;
			void metrics.flush().catch(() => {});
		},
		onTargetCommitted: (target, request) => {
			const state = store.get(request.sessionId);
			if (!state?.activeTask) return;
			state.activeTask.routeTargetId = target.id;
			const updatedRequest = {
				...request,
				targets: [target, ...request.targets.filter((candidate) => candidate.id !== target.id)],
			};
			pendingStreams.set(request.sessionId, updatedRequest);
			state.sessionRoute = {
				provider: target.model.provider,
				modelId: target.model.id,
				thinking: request.thinking,
				apisUsed: [
					...new Set([
						...(state.sessionRoute.apisUsed ?? []),
						target.model.api,
					]),
				],
			};
			state.updatedAt = Date.now();
		},
		onInternalError: (_error, sessionId) => {
			if (sessionId) recordRouterFailure(sessionId);
		},
		canEmergencyPassthrough: (sessionId) => !sessionId || !emergencyBlockedSessions.has(sessionId),
	});

	registerAutoModelProvider(pi, streamProxyHandler);

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
		(ctx) => events.query({ limit: 100 }),
		quality,
		async (format) => {
			const path = join(globalDir, "auto-model", `events-export-${Date.now()}.${format}`);
			await events.exportTo(path, format);
			return path;
		},
		(event) => events.record(event),
		() => piProbe.optional.retryProviderRequest === true,
		(prompt, ctx) => {
			const state = stateForContext(store, ctx);
			const config = configs.get(state.sessionId) ?? DEFAULT_CONFIG;
			const quota = buildProviderQuotaSignals(metrics.providerUsageSnapshot(), config.quota);
			const targets = resolvePiCandidates(ctx, config.constraints).targets.filter(
				(target) => !circuits.isOpen(target.id) && !isProviderQuotaBlocked(quota.get(target.model.provider)),
			);
			const profile = analyzeTask({ prompt, contextTokens: contextTokensOf(ctx) });
			const plan = planRoute({
				targets,
				profile,
				currentTargetId: ctx.model ? modelTargetId(ctx.model) : undefined,
				contextTokens: contextTokensOf(ctx),
				policy: state.manualOverrides.policy ?? config.policy,
				quota,
				latencyP95Ms: new Map([...metrics.snapshot()].map(([id, value]) => [id, percentile(value.latenciesMs ?? [], 0.95)])),
				quality: new Map(targets.map((target) => [target.id, quality.signal(target.id, target.model.provider, profile.kinds)])),
				costMultipliers: new Map(targets.map((target) => [target.id, metrics.costMultiplier(target.id)])),
				cacheAware: config.cacheAware?.enabled !== false,
				capabilityOptions: { source: config.capabilitySource, overrides: config.benchmarkOverrides },
			});
			return plan && { targetId: plan.target.id, thinking: plan.thinking, policy: plan.policy, reason: plan.reason, utility: plan.score.utility };
		},
	);

	pi.on(
		"session_start",
		safeHandler<SessionStartEvent>("session_start", async (_event, ctx) => {
			if (!contextIsCompatible(ctx)) {
				return;
			}
			modelRegistry = ctx.modelRegistry;
			handleSessionStart(_event, ctx, store);
			await metrics.load(metricsPath);
			await budgetLedger.load(budgetPath);
			await quality.load(qualityPath);
			await events.load();
			budgetLedger.startSession(ctx.sessionManager.getSessionId());
			const global = await loadConfig(join(globalDir, "auto-model.json"));
			const config = contextHasProjectTrust(ctx) && ctx.isProjectTrusted()
				? mergeConfig(global, await loadConfig(join(ctx.cwd, ".pi", "auto-model.json"), global))
				: global;
			configs.set(ctx.sessionManager.getSessionId(), config);
			metrics.setQuotaWindow(
				config.quota.windowMs,
				new Map(Object.entries(config.quota.providers)
					.filter(([, rule]) => rule.windowMs !== undefined)
					.map(([provider, rule]) => [provider, rule.windowMs!])),
			);
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
			emergencyBlockedSessions.delete(state.sessionId);
			const allowPrefix = !state.initialPromptHandled;
			state.initialPromptHandled = true;
			forceSettleStaleTask(state, Date.now());
			state.compactionSuspend = undefined;
			settlePendingActivation(state);
			if (state.activation !== "active") {
				return;
			}
			const requestId = randomUUID();
			const health = routerHealth.get(state.sessionId);
			if (health?.bypassUntil && health.bypassUntil > Date.now()) {
				notifySafe(ctx, "Pi Auto Model routing is temporarily bypassed after repeated internal failures.", "warning");
				applyFallbackPlan(_event, ctx, state, config, requestId, allowPrefix);
				return;
			}
			if (health?.bypassUntil) routerHealth.delete(state.sessionId);

			// Fail-safe: the user's request must always reach a real model.
			// Run the normal routing pipeline; if it cannot produce a plan or
			// throws, degrade to the best available real model instead of
			// letting the virtual auto model surface a routing error.
			let outcome: AutoRouteOutcome;
			try {
				outcome = await applyAutoRoute(_event, ctx, state, config, requestId, allowPrefix);
			} catch (error) {
				recordRouterFailure(state.sessionId);
				notifySafe(ctx, `Pi Auto Model routing failed (${errorMessage(error)}). Falling back to a working model.`);
				outcome = { status: "failed" };
			}
			if (outcome.status === "routed" || outcome.status === "blocked") {
				if (outcome.status === "routed") routerHealth.delete(state.sessionId);
				if (outcome.status === "blocked") emergencyBlockedSessions.add(state.sessionId);
				// Routed: session state, budgets and notifications were applied
				// inside applyAutoRoute. Blocked: the user's configuration
				// intentionally stopped this request (budget block); respect it.
				return;
			}
			// A plan may already exist if applyAutoRoute produced one and then
			// threw in a post-plan side effect (bookkeeping, notifications).
			// Keep the valid plan instead of replacing it with the fallback.
			if (pendingStreams.has(state.sessionId)) {
				return;
			}
			// Degrade to a working real model so the request can proceed.
			applyFallbackPlan(_event, ctx, state, config, requestId, allowPrefix);
		}),
	);

	// ─── Routing pipeline (extracted so its failures never block the user) ───
	async function applyAutoRoute(
		_event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
		state: SessionRuntimeState,
		config: AutoModelConfig,
		requestId: string,
		allowPrefix: boolean,
	): Promise<AutoRouteOutcome> {
			const activeFailure = state.activeTask?.lastFailure && state.activeTask.routeTargetId
				? {
						targetId: state.activeTask.routeTargetId,
						status: state.activeTask.lastFailure.status,
						attemptedTargetIds: state.activeTask.attemptedTargetIds,
					}
				: undefined;
			const previousFailure = activeFailure ?? state.lastFailedRoute;
			// Parse inline prefix pin (@low/@medium/@high/@ultra/@model:...).
			const prefixPin: ReturnType<typeof parsePrefixPin> = allowPrefix ? parsePrefixPin(_event.prompt) : {
				strippedPrompt: _event.prompt,
			};
			const effectivePrompt = prefixPin.strippedPrompt;
			let profile = state.activeTask?.profile ?? analyzeTask({
				prompt: effectivePrompt,
				imageCount: _event.images?.length,
				contextTokens: contextTokensOf(ctx),
			});
			if (shouldClassify(profile, config.classifier.enabled, config.classifier.confidenceThreshold)) {
				try {
					profile = await refineWithClassifier(ctx, profile, _event.prompt, config.classifier.timeoutMs, {
						source: config.capabilitySource,
						overrides: config.benchmarkOverrides,
					});
				} catch {
					// Classifier failures intentionally fall back without user-facing output.
				}
			}
			events.record({
				id: `request-${requestId}`,
				requestId,
				sessionId: state.sessionId,
				kind: "request",
				at: Date.now(),
				taskKinds: profile.kinds,
				metadata: { complexity: profile.complexity, confidence: profile.confidence },
			});
			const candidateResolution = resolvePiCandidates(ctx, config.constraints);
			// Apply prefix mode filter: restrict to models at or above the
			// indicated capability tier.
			const modeFilteredTargets = prefixPin.mode
				? candidateResolution.targets.filter((target) => {
					const prior = deriveCapabilityPrior(target.model, {
						source: config.capabilitySource,
						overrides: config.benchmarkOverrides,
					});
					return tierRank(prior.overall) >= tierRank(modeToMinimumTier(prefixPin.mode!));
				})
				: candidateResolution.targets;
			// Apply prefix model pin: restrict to the exact target.
			const prefixPinnedTarget = prefixPin.modelTargetId
				? candidateResolution.targets.find((target) => target.id === prefixPin.modelTargetId)
				: undefined;
			const effectiveCandidateTargets = prefixPinnedTarget
				? [prefixPinnedTarget]
				: modeFilteredTargets;
			if (effectiveCandidateTargets.length === 0 && (prefixPin.mode || prefixPin.modelTargetId)) {
				const hint = prefixPin.modelTargetId
					? `@model:${prefixPin.modelTargetId}`
					: `@${prefixPin.mode}`;
				notifySafe(
					ctx,
					`Pi Auto Model: prefix pin "${hint}" matched no eligible model. Falling back to a working model.`,
					"warning",
				);
				return { status: "failed" };
			}
			const poolName = state.manualOverrides.pool ?? config.pool;
			const pool = poolName ? config.pools[poolName] : undefined;
			const poolAttempts = pool
				? metrics.targetAttempts(
					pool.allocation === "fixed"
						? 24 * 90
						: pool.allocation === "daily"
							? 24
							: pool.windowHours ?? 24,
				)
				: undefined;
			const quotaSignals = buildProviderQuotaSignals(
				metrics.providerUsageSnapshot(),
				config.quota,
			);
			const qualitySignals = new Map(effectiveCandidateTargets.map((target) => [
				target.id,
				quality.signal(target.id, target.model.provider, profile.kinds),
			]));
			const latencyP95Ms = new Map([...metrics.snapshot()].map(([targetId, value]) => [
				targetId,
				percentile(value.latenciesMs ?? [], 0.95),
			]));
			const costMultipliers = new Map(effectiveCandidateTargets.map((target) => [
				target.id,
				metrics.costMultiplier(target.id),
			]));
			const nonCircuitTargets = effectiveCandidateTargets.filter(
				(target) => !circuits.isOpen(target.id),
			);
			const poolEligibleTargets = pool
				? nonCircuitTargets.filter((target) => {
					const targetPool = pool.targets ?? [];
					const providerPool = pool.providers ?? [];
					return (targetPool.length === 0 || targetPool.some((entry) => entry.id === target.id && entry.weight > 0)) &&
						(providerPool.length === 0 || providerPool.some((entry) => entry.id === target.model.provider && entry.weight > 0));
				})
				: nonCircuitTargets;
			const quotaEligibleTargets = poolEligibleTargets.filter(
				(target) => !isProviderQuotaBlocked(quotaSignals.get(target.model.provider)),
			);
			const poolFallbackTargets = pool?.fallback === "any"
				? nonCircuitTargets.filter((target) => !isProviderQuotaBlocked(quotaSignals.get(target.model.provider)))
				: [];
			const usePoolFallback = Boolean(
				pool &&
				pool.fallback === "any" &&
				(poolEligibleTargets.length === 0 || quotaEligibleTargets.length === 0) &&
				poolFallbackTargets.length > 0,
			);
			const healthyTargets = usePoolFallback
				? poolFallbackTargets
				: quotaEligibleTargets.length > 0
					? quotaEligibleTargets
					: poolEligibleTargets;
			const activePool = usePoolFallback ? undefined : pool;
			if (healthyTargets.length === 0) {
				const failure = candidateResolution.failure;
				if (poolName && pool) {
					notifySafe(ctx, `Pi Auto Model pool "${poolName}" has no eligible target after health, quota, and circuit checks. Falling back to a working model.`, "error");
				} else if (failure) {
					notifySafe(ctx, `${formatCandidateFailure(failure)} Falling back to a working model.`, "error");
				}
				return { status: "failed" };
			}
			const canUseFailover = Boolean(
				previousFailure &&
				previousFailure.attemptedTargetIds.length < Math.max(1, config.failover.maxAttempts),
			);
			const routeTargets = previousFailure && canUseFailover
				? healthyTargets.filter((target) => !previousFailure.attemptedTargetIds.includes(target.id))
				: healthyTargets;
			if (previousFailure && (!canUseFailover || routeTargets.length === 0)) {
				notifySafe(
					ctx,
					`Pi Auto Model failover budget exhausted after ${previousFailure.attemptedTargetIds.length} attempt(s). Falling back to a working model.`,
					"warning",
				);
				return { status: "failed" };
			}

			const defaultPlan = planRoute({
				targets: routeTargets,
				profile,
				currentTargetId: ctx.model ? modelTargetId(ctx.model) : undefined,
				contextTokens: contextTokensOf(ctx),
				policy: state.manualOverrides.policy ?? config.policy,
				quota: quotaSignals,
				pool: activePool,
				poolAttempts,
				latencyP95Ms,
				quality: qualitySignals,
				costMultipliers,
				cacheAware: config.cacheAware?.enabled !== false,
				capabilityOptions: { source: config.capabilitySource, overrides: config.benchmarkOverrides },
			});
			const retryTarget = previousFailure
				? chooseFailoverTarget(
						routeTargets,
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
						rankedTargets: [
							retryTarget,
							...(defaultPlan?.rankedTargets ?? []).filter((t) => t.id !== retryTarget.id),
						],
					}
				: defaultPlan;
			if (!plan) {
				notifySafe(
					ctx,
					"Pi Auto Model: no eligible model can satisfy this task's vision, context, or output requirements. Falling back to a working model.",
					"error",
				);
				return { status: "failed" };
			}
			const pinned = state.manualOverrides.pinnedTargetId
				? effectiveCandidateTargets.find((target) => target.id === state.manualOverrides.pinnedTargetId)
				: undefined;
			const pinnedPlan = pinned
				? planRoute({
						targets: [pinned],
						profile,
						contextTokens: contextTokensOf(ctx),
						policy: state.manualOverrides.policy,
						quota: quotaSignals,
						pool: activePool,
						latencyP95Ms,
						quality: qualitySignals,
						costMultipliers,
						capabilityOptions: { source: config.capabilitySource, overrides: config.benchmarkOverrides },
					})
				: undefined;
			let effectivePlan = pinnedPlan ?? plan;
			let shadowTargetId: string | undefined;
			if (config.shadow?.enabled && !pinnedPlan && !prefixPinnedTarget && !prefixPin.mode) {
				const currentId = state.sessionRoute.provider && state.sessionRoute.modelId
					? `${state.sessionRoute.provider}/${state.sessionRoute.modelId}`
					: undefined;
				const current = currentId ? plan.rankedTargets.find((target) => target.id === currentId) : undefined;
				const currentPlan = current ? planRoute({
					targets: [current],
					profile,
					contextTokens: contextTokensOf(ctx),
					policy: state.manualOverrides.policy ?? config.policy,
					costMultipliers,
					capabilityOptions: { source: config.capabilitySource, overrides: config.benchmarkOverrides },
				}) : undefined;
				if (current && currentPlan) {
					shadowTargetId = effectivePlan.target.id;
					effectivePlan = {
						...currentPlan,
						rankedTargets: [current, ...plan.rankedTargets.filter((target) => target.id !== current.id)],
						reason: [`shadow kept ${current.id}`, `would select ${shadowTargetId}`],
					};
				}
			}
			let effectiveEstimate = estimateCost(
				effectivePlan.target,
				contextTokensOf(ctx),
				profile,
			);
			let budgetDecision = budgetLedger.evaluate(
				effectiveEstimate,
				effectivePlan.target.model.provider,
				config.budget,
			);
			if ((budgetDecision.action === "downgrade" || budgetDecision.action === "avoid") && !pinnedPlan) {
				const budgetTargets = budgetDecision.action === "avoid"
					? routeTargets.filter((target) => target.model.provider !== effectivePlan.target.model.provider)
					: routeTargets;
				const cheaperPlan = planRoute({
					targets: budgetTargets,
					profile,
					currentTargetId: ctx.model ? modelTargetId(ctx.model) : undefined,
					contextTokens: contextTokensOf(ctx),
					policy: "price",
					quota: quotaSignals,
					pool: activePool,
					poolAttempts,
					latencyP95Ms,
					quality: qualitySignals,
					costMultipliers,
					capabilityOptions: { source: config.capabilitySource, overrides: config.benchmarkOverrides },
				});
				if (cheaperPlan) {
					const cheaperEstimate = estimateCost(
						cheaperPlan.target,
						contextTokensOf(ctx),
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
			budgetDecision = await budgetLedger.reserve(
				effectivePlan.target.model.provider,
				effectiveEstimate,
				config.budget,
			);
			if (budgetDecision.action === "block" || budgetDecision.action === "avoid") {
				notifySafe(
					ctx,
					`Pi Auto Model budget exceeded (${budgetDecision.exceeded.join(", ") || "task"}). Current model unchanged.`,
					"warning",
				);
				// Intentional user-configured stop: do not route around it.
				return { status: "blocked" };
			}
			const thinking = state.manualOverrides.thinkingMode === "fixed"
				? state.manualOverrides.fixedThinking ?? effectivePlan.thinking
				: state.manualOverrides.thinkingMode === "pi"
					? ctx.thinkingLevel ?? effectivePlan.thinking
					: effectivePlan.thinking;

			// Store the ranked target list for the streamSimple proxy.
			// The model stays as pi-auto-model/auto; the proxy will call
			// the real provider's streamSimple internally and fail over
			// if the first target errors before substantive output.
			const proxyTargets = [
				effectivePlan.target,
				...(effectivePlan.rankedTargets ?? []).filter(
					(t) => t.id !== effectivePlan.target.id,
				),
			];
			const pendingStream: PendingStreamRequest = {
				targets: proxyTargets,
				thinking,
				profile,
				requestId,
				sessionId: state.sessionId,
				estimatedCostUsd: effectiveEstimate,
				apisUsed: state.sessionRoute.apisUsed ?? [],
				prefixToStrip: prefixPin.mode || prefixPin.modelTargetId
					? _event.prompt.slice(0, _event.prompt.length - effectivePrompt.length) || undefined
					: undefined,
				firstOutputTimeoutMs: config.failover?.firstOutputTimeoutMs,
			};
			pendingStreams.set(state.sessionId, pendingStream);

			// Set thinking level for UI consistency. The proxy will also
			// pass this to the real provider via options.reasoning.
			pi.setThinkingLevel(thinking);

			// Update sessionRoute optimistically (proxy may update on failover).
			state.sessionRoute = {
				provider: effectivePlan.target.model.provider,
				modelId: effectivePlan.target.model.id,
				thinking,
				apisUsed: [
					...new Set([
						...(state.sessionRoute.apisUsed ?? []),
						effectivePlan.target.model.api,
					]),
				],
			};
			state.updatedAt = Date.now();

			const now = Date.now();
			state.lastFailedRoute = undefined;
			state.activeTask = {
				requestId,
				startedAt: now,
				lastActivityAt: now,
				phase: "applied",
				routeTargetId: effectivePlan.target.id,
				thinking,
				profile,
				estimatedCostUsd: effectiveEstimate,
				inputTokens: contextTokensOf(ctx),
				accountedTargetIds: [effectivePlan.target.id],
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
				reason: pinnedPlan
					? ["user pin", ...effectivePlan.reason]
					: prefixPinnedTarget
						? [`prefix @model:${prefixPin.modelTargetId}`, ...effectivePlan.reason]
						: prefixPin.mode
							? [`prefix @${prefixPin.mode}`, ...effectivePlan.reason]
							: effectivePlan.reason,
				score: effectivePlan.score,
				taskKinds: profile.kinds,
				createdAt: now,
			});
			events.record({
				id: `route-${requestId}`,
				requestId,
				sessionId: state.sessionId,
				kind: "route_decision",
				at: now,
				targetId: effectivePlan.target.id,
				provider: effectivePlan.target.model.provider,
				modelId: effectivePlan.target.model.id,
				taskKinds: profile.kinds,
				costUsd: effectiveEstimate,
				metadata: {
					policy: effectivePlan.policy,
					utility: effectivePlan.score.utility,
					budgetAction: budgetDecision.action,
					shadowTargetId,
				},
			});
			events.record({
				id: `budget-${requestId}`,
				requestId,
				sessionId: state.sessionId,
				kind: "budget_usage",
				at: now,
				targetId: effectivePlan.target.id,
				provider: effectivePlan.target.model.provider,
				costUsd: effectiveEstimate,
				metadata: {
					action: budgetDecision.action,
					exceeded: budgetDecision.exceeded.join(","),
				},
			});
			updateAutoModelStatus(ctx, state, effectivePlan.target.model);
			void appendDecision(join(globalDir, "auto-model", "decisions.jsonl"), state.lastDecision!).catch(() => {});
			notifySafe(
				ctx,
				`Pi Auto Model → ${effectivePlan.target.id} · ${thinking}\nWhy: ${[
					...effectivePlan.reason,
					...(budgetDecision.action !== "allow"
						? [`budget ${budgetDecision.action}`, ...budgetDecision.exceeded]
						: []),
				].join(" · ")}`,
				"info",
			);
			return { status: "routed" };
	}

	/**
	 * Fail-safe degradation: the normal pipeline produced no plan. Build the
	 * eligible real model list without bypassing hard compatibility, health,
	 * quota, or budget rules. Prefix pins are intentionally ignored here — a
	 * pin that matched nothing must not block the request.
	 */
	function applyFallbackPlan(
		_event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
		state: SessionRuntimeState,
		config: AutoModelConfig,
		requestId: string,
		allowPrefix: boolean,
	): void {
		let fallback: PendingStreamRequest | undefined;
		try {
			const prefixPin: ReturnType<typeof parsePrefixPin> = allowPrefix ? parsePrefixPin(_event.prompt) : {
				strippedPrompt: _event.prompt,
			};
			const effectivePrompt = prefixPin.strippedPrompt;
			const fallbackQuota = buildProviderQuotaSignals(metrics.providerUsageSnapshot(), config.quota);
			fallback = buildFallbackPending({
				ctx,
				config,
				requestId,
				sessionId: state.sessionId,
				prompt: effectivePrompt,
				imageCount: _event.images?.length,
				contextTokens: contextTokensOf(ctx),
				apisUsed: state.sessionRoute.apisUsed ?? [],
				prefixToStrip: prefixPin.mode || prefixPin.modelTargetId
					? _event.prompt.slice(0, _event.prompt.length - effectivePrompt.length) || undefined
					: undefined,
				lastRouteId: state.sessionRoute.provider && state.sessionRoute.modelId
					? `${state.sessionRoute.provider}/${state.sessionRoute.modelId}`
					: undefined,
				excludedTargetIds: [...circuits.snapshot()]
					.filter(([targetId]) => circuits.isOpen(targetId))
					.map(([targetId]) => targetId),
				excludedProviders: [...fallbackQuota]
					.filter(([, signal]) => isProviderQuotaBlocked(signal))
					.map(([provider]) => provider),
			});
		} catch {
			fallback = undefined;
		}
		if (!fallback) {
			notifySafe(
				ctx,
				"Pi Auto Model: no real model is available to run this request. Select a concrete model in /model to proceed.",
				"error",
			);
			return;
		}
		pendingStreams.set(state.sessionId, fallback);
		try {
			pi.setThinkingLevel(fallback.thinking);
		} catch {
			// Thinking level is cosmetic; the stream proxy still sends real
			// reasoning levels per target.
		}
		const first = fallback.targets[0];
		state.sessionRoute = {
			provider: first.model.provider,
			modelId: first.model.id,
			thinking: fallback.thinking,
			apisUsed: [
				...new Set([
					...(state.sessionRoute.apisUsed ?? []),
					first.model.api,
				]),
			],
		};
		state.activeTask = {
			requestId,
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			phase: "applied",
			routeTargetId: first.id,
			thinking: fallback.thinking,
			profile: fallback.profile,
			estimatedCostUsd: fallback.estimatedCostUsd,
			inputTokens: contextTokensOf(ctx),
			accountedTargetIds: [],
			failover: false,
			attemptedTargetIds: [first.id],
		};
		state.updatedAt = Date.now();
		updateAutoModelStatus(ctx, state);
		notifySafe(
			ctx,
			`Pi Auto Model: routing unavailable; fell back to ${first.id} so your request can proceed.`,
			"warning",
		);
	}

	pi.on("after_provider_response", safeHandler<AfterProviderResponseEvent>(
		"after_provider_response",
		(event, ctx) => {
			const state = store.get(ctx.sessionManager.getSessionId());
			if (!state?.activeTask) {
				return;
			}
			// When the streamSimple proxy is active, it records metrics
			// internally via onAttemptSettled. If the proxy already recorded
			// (resultRecorded=true), skip to avoid double-recording.
			// For the auto model, prefer the route target's provider.
			const routeProvider = state.activeTask.routeTargetId?.split("/", 1)[0];
			const now = Date.now();
			const provider = isAutoModel(ctx.model)
				? routeProvider ?? ctx.model?.provider
				: ctx.model?.provider ?? routeProvider;
			const observation = provider
				? quotaAdapters.observe(provider, event.headers, now)
				: undefined;
			if (observation) {
				state.activeTask.quotaObservation = mergeQuotaObservation(
					state.activeTask.quotaObservation,
					observation,
				);
				events.record({
					id: `quota-${state.activeTask.requestId}-${now}`,
					requestId: state.activeTask.requestId,
					sessionId: state.sessionId,
					kind: "quota_observation",
					at: now,
					targetId: state.activeTask.routeTargetId,
					provider,
					source: observation.source,
					metadata: {
						uvi: observation.uvi,
						retryAt: observation.retryAt,
					},
				});
			}
			events.record({
				id: `response-${state.activeTask.requestId}-${now}`,
				requestId: state.activeTask.requestId,
				sessionId: state.sessionId,
				kind: "provider_response",
				at: now,
				targetId: state.activeTask.routeTargetId,
				provider,
				status: event.status,
				latencyMs: now - state.activeTask.startedAt,
				success: event.status < 400,
			});
			if (event.status < 400) {
				state.activeTask.lastActivityAt = now;
				state.updatedAt = now;
				return;
			}
			const classification = classifyProviderError(
				event.status,
				state.activeTask.streamStarted,
				(state.activeTask.toolCallCount ?? 0) > 0,
			);
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
				const canContinueOnNextTask = classification.retryable && !classification.unsafeToReplay;
				state.lastFailedRoute = canContinueOnNextTask
					? {
							targetId: state.activeTask.routeTargetId,
							status: event.status,
							at: now,
							attemptedTargetIds: [...state.activeTask.attemptedTargetIds],
						}
					: undefined;
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
				events.record({
					id: `failover-${state.activeTask.requestId}`,
					requestId: state.activeTask.requestId,
					sessionId: state.sessionId,
					kind: "failover",
					at: now,
					targetId: state.activeTask.routeTargetId,
					provider,
					status: event.status,
					metadata: {
						classification: classification.classification,
						retryable: classification.retryable,
						unsafeToReplay: classification.unsafeToReplay,
						nextTask: canContinueOnNextTask,
					},
				});
				state.activeTask.resultRecorded = true;
				void metrics.flush().catch(() => {});
			}
			state.activeTask.lastActivityAt = Date.now();
			state.updatedAt = Date.now();
		},
	));

	function settleActiveTask(ctx: ExtensionContext, sessionId: string, expectedRequestId?: string): void {
		const state = store.get(sessionId);
		if (!state?.activeTask) {
			return;
		}
		if (expectedRequestId && state.activeTask.requestId !== expectedRequestId) return;
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
			const provider = state.activeTask.routeTargetId.split("/", 1)[0];
			events.record({
				id: `settled-${state.activeTask.requestId}`,
				requestId: state.activeTask.requestId,
				sessionId: state.sessionId,
				kind: "provider_response",
				at: Date.now(),
				targetId: state.activeTask.routeTargetId,
				provider,
				success: true,
				latencyMs: Date.now() - state.activeTask.startedAt,
			});
			void metrics.flush().catch(() => {});
		}
		if (state.activeTask.routeTargetId) {
			const usage = state.activeTask.actualUsage;
			if (usage) {
				metrics.recordActual({
					targetId: state.activeTask.routeTargetId,
					estimatedCostUsd: state.activeTask.estimatedCostUsd ?? 0,
					actualCostUsd: usage.costUsd,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens,
					cacheWriteTokens: usage.cacheWriteTokens,
					costKnown: usage.costKnown,
				});
				events.record({
					id: `usage-${state.activeTask.requestId}`,
					requestId: state.activeTask.requestId,
					sessionId: state.sessionId,
					kind: "usage_actual",
					at: Date.now(),
					targetId: state.activeTask.routeTargetId,
					provider: state.activeTask.routeTargetId.split("/", 1)[0],
					costUsd: usage.costKnown ? usage.costUsd : undefined,
					metadata: {
						inputTokens: usage.inputTokens,
						outputTokens: usage.outputTokens,
						cacheReadTokens: usage.cacheReadTokens,
						cacheWriteTokens: usage.cacheWriteTokens,
						estimatedCostUsd: state.activeTask.estimatedCostUsd,
					},
				});
			}
			quality.record(
				state.activeTask.routeTargetId,
				state.activeTask.routeTargetId.split("/", 1)[0],
				state.activeTask.profile?.kinds ?? ["mixed"],
				state.activeTask.finalAttemptSuccess !== false && (state.activeTask.toolCallErrors ?? 0) === 0,
			);
		}
		state.activeTask = undefined;
		pendingStreams.delete(state.sessionId);
		state.updatedAt = Date.now();
		updateAutoModelStatus(ctx, state);
		void metrics.flush().catch(() => {});
	}

	pi.on("agent_settled", safeHandler<AgentSettledEvent>("agent_settled", (_event, ctx) => {
		settleActiveTask(ctx, ctx.sessionManager.getSessionId());
	}));

	// Pi < 0.85 has no agent_settled event. Defer the compatibility fallback
	// so newer Pi can emit agent_settled or begin an automatic retry first.
	pi.on("agent_end", safeHandler<AgentEndEvent>("agent_end", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const requestId = store.get(sessionId)?.activeTask?.requestId;
		if (!requestId) return;
		setTimeout(() => {
			try {
				settleActiveTask(ctx, sessionId, requestId);
			} catch (error) {
				notifySafe(ctx, `Pi Auto Model agent_end settlement failed: ${errorMessage(error)}`);
			}
		}, 0);
	}));

	pi.on("message_update", safeHandler<MessageUpdateEvent>("message_update", (_event, ctx) => {
		const state = store.get(ctx.sessionManager.getSessionId());
		if (state?.activeTask) {
			state.activeTask.streamStarted = true;
			state.activeTask.phase = "running";
			state.activeTask.lastActivityAt = Date.now();
		}
	}));

	pi.on("message_end", safeHandler<MessageEndEvent>("message_end", (event, ctx) => {
		const state = store.get(ctx.sessionManager.getSessionId());
		if (!state?.activeTask || event.message.role !== "assistant") return;
		const usage = event.message.usage;
		const current = state.activeTask.actualUsage ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
			costKnown: false,
		};
		current.inputTokens += Math.max(0, usage.input ?? 0);
		current.outputTokens += Math.max(0, usage.output ?? 0);
		current.cacheReadTokens += Math.max(0, usage.cacheRead ?? 0);
		current.cacheWriteTokens += Math.max(0, usage.cacheWrite ?? 0);
		const cost = Math.max(0, usage.cost?.total ?? 0);
		current.costUsd += cost;
		current.costKnown ||= cost > 0;
		state.activeTask.actualUsage = current;
	}));

	pi.on("tool_execution_start", safeHandler<ToolExecutionStartEvent>("tool_execution_start", (_event, ctx) => {
		const state = store.get(ctx.sessionManager.getSessionId());
		if (state?.activeTask) {
			state.activeTask.lastActivityAt = Date.now();
		}
	}));

	pi.on("tool_call", safeHandler<ToolCallEvent>("tool_call", (_event, ctx) => {
		const state = store.get(ctx.sessionManager.getSessionId());
		if (state?.activeTask) {
			state.activeTask.toolCallCount = (state.activeTask.toolCallCount ?? 0) + 1;
			state.activeTask.lastActivityAt = Date.now();
		}
	}));

	pi.on("tool_execution_end", safeHandler<ToolExecutionEndEvent>("tool_execution_end", (event, ctx) => {
		const state = store.get(ctx.sessionManager.getSessionId());
		if (state?.activeTask) {
			if (event.isError) {
				state.activeTask.toolCallErrors = (state.activeTask.toolCallErrors ?? 0) + 1;
				const pending = pendingStreams.get(state.sessionId);
				if (state.activeTask.toolCallErrors >= 2 && !state.activeTask.stageEscalated && pending) {
					const config = configs.get(state.sessionId) ?? DEFAULT_CONFIG;
					const strongest = [...pending.targets].sort((left, right) =>
						tierRank(deriveCapabilityPrior(right.model, { source: config.capabilitySource, overrides: config.benchmarkOverrides }).overall) -
						tierRank(deriveCapabilityPrior(left.model, { source: config.capabilitySource, overrides: config.benchmarkOverrides }).overall),
					)[0];
					if (strongest && strongest.id !== pending.targets[0]?.id) {
						pendingStreams.set(state.sessionId, {
							...pending,
							targets: [strongest, ...pending.targets.filter((target) => target.id !== strongest.id)],
							thinking: chooseThinkingLevel(strongest.model, pending.profile),
						});
						state.activeTask.stageEscalated = true;
						events.record({
							id: `stage-escalation-${state.activeTask.requestId}`,
							requestId: state.activeTask.requestId,
							sessionId: state.sessionId,
							kind: "failover",
							at: Date.now(),
							targetId: strongest.id,
							metadata: { reason: "repeated tool errors", toolCallErrors: state.activeTask.toolCallErrors },
						});
					}
				}
			}
			state.activeTask.lastActivityAt = Date.now();
		}
	}));

	pi.on("context", async (event: ContextEvent, ctx) => {
		try {
			const state = store.get(ctx.sessionManager.getSessionId());
			const targetApi = ctx.model?.api;
			if (!state || !targetApi) {
				return;
			}
			// When the streamSimple proxy is active, it adapts context
			// internally based on the real target model's API. Skip here
			// to avoid premature or redundant thinking stripping.
			if (isAutoModel(ctx.model)) {
				return;
			}
			if (compatibilityAction(state.sessionRoute.apisUsed ?? [], targetApi) === "keep") {
				return;
			}
			return {
				messages: stripThinkingForRequest(event.messages) as typeof event.messages,
			};
		} catch (error) {
			notifySafe(ctx, `Pi Auto Model context failed: ${errorMessage(error)}`, "warning");
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
			void quality.flush().catch(() => {});
			void events.flush().catch(() => {});
			store.delete(ctx.sessionManager.getSessionId());
			pendingStreams.delete(ctx.sessionManager.getSessionId());
			routerHealth.delete(ctx.sessionManager.getSessionId());
			emergencyBlockedSessions.delete(ctx.sessionManager.getSessionId());
		}),
	);
}

function resolveAgentDir(): string {
	// Cross-platform home directory resolution, with a working-directory
	// fallback so extension startup can never fail on path resolution.
	// USERPROFILE is Windows-specific; HOME is the Unix convention;
	// os.homedir() is the most reliable cross-platform fallback.
	try {
		const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
		return join(home, ".pi", "agent");
	} catch {
		return join(process.cwd(), ".pi", "agent");
	}
}
