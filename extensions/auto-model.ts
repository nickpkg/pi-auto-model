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
	handleModelSelect,
	settlePendingActivation,
	setActivation,
	stateForContext,
} from "../src/pi/activation.ts";
import { handleBeforeCompact } from "../src/pi/compaction.ts";
import { classifyToolFailure } from "../src/task/tool-failure.ts";
import { handleBeforeFork, handleSessionStart } from "../src/pi/fork.ts";
import {
	formatCandidateFailure,
	resolvePiCandidates,
} from "../src/pi/registry-adapter.ts";
import { RuntimeStateStore } from "../src/pi/runtime-store.ts";
import { planRoute, hardConstraintFailure, isInPool } from "../src/routing/route-planner.ts";
import { requestContextTokens } from "../src/pi/request-context.ts";
import { chooseFailoverTarget } from "../src/routing/failover.ts";
import {
	effectiveRules,
	filterTargetsByRule,
	hasRuleFilters,
	matchRule,
	preferredTargetIds,
	traceRules,
	type RoutingRule,
	type RuleFacts,
} from "../src/routing/rules.ts";
import { coldCacheReason } from "../src/routing/cache-state.ts";
import { chooseThinkingLevel } from "../src/routing/thinking-router.ts";
import { CircuitBreaker } from "../src/health/circuit-breaker.ts";
import { DEFAULT_CONFIG, type AutoModelConfig } from "../src/config/defaults.ts";
import { loadConfig, mergeConfig, saveConfigPolicy } from "../src/config/loader.ts";
import { appendDecision } from "../src/storage/jsonl.ts";
import {
	BudgetLedger,
	estimateCost,
	type BudgetReservation,
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
	type SessionRuntimeState,
	type RoutePlan,
	type RouteTarget,
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
	AUTO_MODEL_MAX_TOKENS,
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
import {
	DEFAULT_LITELLM_REFRESH_HOURS,
	DEFAULT_LITELLM_URL,
	fetchLiteLLMPrices,
	isPriceCacheStale,
	loadPriceCache,
	savePriceCache,
	type PriceCatalogSnapshot,
} from "../src/pricing/litellm-fetch.ts";
import {
	resolveModelPrice,
	type ResolvedModelPrice,
} from "../src/pricing/price-catalog.ts";

/**
 * Result of the normal routing pipeline in before_agent_start.
 * - `routed`: a pending stream plan was set and session state applied.
 * - `blocked`: the user's configuration intentionally stopped the request
 *   (budget block). Callers must NOT override this with a fallback.
 * - `failed`: routing could not produce a plan; callers should degrade to
 *   the fail-safe fallback so the user's request still succeeds.
 */
type AutoRouteOutcome =
	| { status: "routed"; plan?: RoutePlan; ruleTrace?: string[] }
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

function currentRouteId(state: SessionRuntimeState, ctx: ExtensionContext): string | undefined {
	if (ctx.model && !isAutoModel(ctx.model)) return modelTargetId(ctx.model);
	const route = state.sessionRoute;
	return route.provider && route.provider !== AUTO_MODEL_PROVIDER && route.modelId
		? `${route.provider}/${route.modelId}` : undefined;
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

function latestPromptText(messages: ContextEvent["messages"]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown } | undefined;
		if (!message || (message.role !== "user" && message.role !== "custom")) continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((part: { type?: string; text?: string } | undefined) => part?.type === "text" ? part.text ?? "" : "")
				.join("\n");
		}
		return "";
	}
	return "";
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
	const configPath = join(globalDir, "auto-model.json");
	const metricsPath = join(globalDir, "auto-model", "metrics.json");
	const budgetPath = join(globalDir, "auto-model", "budget.json");
	const qualityPath = join(globalDir, "auto-model", "quality.json");
	const pricesPath = join(globalDir, "auto-model", "prices.json");
	const eventsPath = join(globalDir, "auto-model", "events.jsonl");
	const events = new UnifiedEventStore(eventsPath);
	const quality = new QualityLearning();
	const piProbe = probePiCapabilities(pi);

	// ─── Stream proxy shared state ───────────────────────────────
	// One plan per session prevents forks and parallel SDK sessions from
	// consuming or mutating each other's tool-loop route.
	const pendingStreams = new Map<string, PendingStreamRequest>();
	const reservations = new Map<string, BudgetReservation>();
	const routerHealth = new Map<string, { failures: number; bypassUntil?: number }>();
	// A run can emit agent_start again during tool-loop continuations.
	const runRouted = new Set<string>();
	// Runs started without before_agent_start, waiting for their first context
	// event to see the triggering message.
	const runAwaitingRoute = new Set<string>();
	// Rules already reported as unusable, per session, so each is reported once.
	const ignoredRuleNotices = new Map<string, Set<string>>();
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

	// ─── Price catalog state ─────────────────────────────────────
	// Layered price resolution: user override → LiteLLM cache → Pi
	// registry cost. The cache is loaded from disk once and refreshed in
	// the background; every failure mode falls through to registry prices.
	let priceCache: PriceCatalogSnapshot | undefined;
	let priceCacheLoaded = false;
	let priceRefreshCheckedAt = 0;
	const ensurePriceCache = async (): Promise<void> => {
		if (priceCacheLoaded) return;
		priceCacheLoaded = true;
		priceCache = await loadPriceCache(pricesPath).catch(() => undefined);
	};
	const refreshPriceCache = (config: AutoModelConfig): void => {
		const litellm = config.pricing?.litellm;
		if (litellm?.enabled === false) return;
		const refreshHours = litellm?.refreshHours ?? DEFAULT_LITELLM_REFRESH_HOURS;
		const now = Date.now();
		// In-memory guard so repeated requests never stack fetches.
		if (now < priceRefreshCheckedAt) return;
		priceRefreshCheckedAt = now + Math.max(1, refreshHours) * 3_600_000;
		void ensurePriceCache().then(() => {
			if (!isPriceCacheStale(priceCache, refreshHours, now)) return;
			return fetchLiteLLMPrices(litellm?.url ?? DEFAULT_LITELLM_URL).then(async (snapshot) => {
				priceCache = snapshot;
				await savePriceCache(pricesPath, snapshot).catch(() => undefined);
			});
		}).catch(() => undefined);
	};
	const resolvePrices = (
		config: AutoModelConfig,
		targets: readonly RouteTarget[],
	): Map<string, ResolvedModelPrice> =>
		new Map(targets.map((target) => [
			target.id,
			resolveModelPrice(target.id, target.model, {
				overrides: config.pricing?.overrides,
				catalog: priceCache?.models,
				catalogUpdatedAt: priceCache?.updatedAt,
				costCoef: config.pricing?.costCoef,
			}),
		]));

	const streamProxyHandler = createStreamProxyHandler({
		getRegistry: () => modelRegistry,
		circuits,
		getPendingStream: pendingFor,
		onRequestStopped: (request, timedOut) => {
			const task = store.get(request.sessionId)?.activeTask;
			if (task?.requestId !== request.requestId) return;
			task.finalAttemptSuccess = false;
			task.finalAttemptAborted = !timedOut;
		},
		beforeAttempt: async (target, request, context) => {
			const state = store.get(request.sessionId);
			if (!state?.activeTask || !request.attemptId) return "missing active task or dispatch identity";
			return state.lock.run(async () => {
				const task = state.activeTask;
				if (!task || task.requestId !== request.requestId) return "active task does not match this request";
				const config = configs.get(state.sessionId) ?? DEFAULT_CONFIG;
				const inputTokens = Math.max(task.inputTokens ?? 0, requestContextTokens(context));
				const profile = { ...request.profile, constraints: {
					...request.profile.constraints,
					requiredContextTokens: inputTokens,
					requiresVision: request.profile.constraints.requiresVision || JSON.stringify(context.messages, (key, value) => key === "data" ? "" : value).includes('"type":"image"'),
				} };
				const failure = hardConstraintFailure(target, profile, inputTokens, { source: config.capabilitySource, overrides: config.benchmarkOverrides });
				if (failure) return failure;
				const prices = resolvePrices(config, request.targets);
				const estimate = estimateCost(target, inputTokens, profile, prices.get(target.id));
				const limits = { ...config.budget, maxUsdPerTask: config.budget.maxUsdPerTask === undefined
					? undefined : Math.max(0, config.budget.maxUsdPerTask - (task.budgetSpentUsd ?? 0)) };
				const initial = budgetLedger.evaluate(estimate, target.model.provider, limits, Date.now(), state.sessionId);
				if (initial.action === "block" || initial.action === "avoid") return `budget ${initial.action}: ${initial.exceeded.join(", ")}`;
				if (initial.action === "downgrade" && request.targets.some((candidate) =>
					candidate.id !== target.id && estimateCost(candidate, inputTokens, profile, prices.get(candidate.id)) < estimate)) return "budget requires a cheaper route";
				const at = Date.now();
				const decision = await budgetLedger.reserve(target.model.provider, estimate, limits, at, state.sessionId);
				if (decision.action === "block" || decision.action === "avoid") return `budget reservation ${decision.action}: ${decision.exceeded.join(", ")}`;
				reservations.set(request.attemptId!, { provider: target.model.provider, estimate, at, sessionId: state.sessionId });
				task.budgetSpentUsd = (task.budgetSpentUsd ?? 0) + estimate;
				task.attemptCount = (task.attemptCount ?? 0) + 1;
				task.unknownCostAttempts = (task.unknownCostAttempts ?? 0) + 1;
				return true;
			});
		},
		onAttemptResponse: (target, status, headers, request) => {
			const state = store.get(request.sessionId);
			if (!state?.activeTask || state.activeTask.requestId !== request.requestId) return;
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
		onAttemptSettled: async (result: AttemptResult, request) => {
			if (result.notDispatched) {
				const reservation = request.attemptId ? reservations.get(request.attemptId) : undefined;
				if (request.attemptId) reservations.delete(request.attemptId);
				if (!reservation) return;
				await budgetLedger.reconcile(reservation, 0);
				const task = store.get(request.sessionId)?.activeTask;
				if (task?.requestId !== request.requestId) return;
				task.budgetSpentUsd = Math.max(0, (task.budgetSpentUsd ?? 0) - reservation.estimate);
				task.attemptCount = Math.max(0, (task.attemptCount ?? 0) - 1);
				task.unknownCostAttempts = Math.max(0, (task.unknownCostAttempts ?? 0) - 1);
				return;
			}
			const active = store.get(request.sessionId)?.activeTask;
			if (active?.requestId === request.requestId) {
				active.finalAttemptSuccess = result.success;
				active.finalAttemptAborted = result.aborted;
			}
			const reservation = request.attemptId ? reservations.get(request.attemptId) : undefined;
			if (request.attemptId) reservations.delete(request.attemptId);
			const usage = result.message?.usage;
			const cost = usage?.cost?.total;
			const knownCost = typeof cost === "number" && Number.isFinite(cost) && cost > 0;
			if (reservation && knownCost) await budgetLedger.reconcile(reservation, cost);
			const state = store.get(request.sessionId);
			if (!state?.activeTask || state.activeTask.requestId !== request.requestId) return;
			if (reservation && knownCost) state.activeTask.budgetSpentUsd = (state.activeTask.budgetSpentUsd ?? 0) + cost - reservation.estimate;
			if (reservation && knownCost) state.activeTask.unknownCostAttempts = Math.max(0, (state.activeTask.unknownCostAttempts ?? 0) - 1);
			// Successes are recorded once per task at settlement so long tool loops do not dominate.
			// Timeouts and cancellations say nothing about the target's reliability.
			if (!result.success && !result.aborted && !result.timedOut) {
				quality.record(result.target.id, result.target.model.provider, request.profile.kinds, false);
			}
			const now = Date.now();
			const attemptEstimate = reservation?.estimate ?? (state.activeTask.profile
				? estimateCost(result.target, state.activeTask.inputTokens ?? 0, state.activeTask.profile,
					resolvePrices(configs.get(state.sessionId) ?? DEFAULT_CONFIG, [result.target]).get(result.target.id))
				: state.activeTask.estimatedCostUsd);
			if (usage) {
				metrics.recordActual({ targetId: result.target.id, estimatedCostUsd: attemptEstimate ?? 0,
					actualCostUsd: knownCost ? cost : 0, costKnown: knownCost,
					inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0,
					cacheReadTokens: usage.cacheRead ?? 0, cacheWriteTokens: usage.cacheWrite ?? 0 });
				events.record({ id: `usage-${request.attemptId}`, requestId: request.requestId, sessionId: request.sessionId,
					kind: "usage_actual", at: now, targetId: result.target.id, provider: result.target.model.provider,
					costUsd: knownCost ? cost : undefined, metadata: { attemptId: request.attemptId, estimatedCostUsd: attemptEstimate,
						inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite } });
			}
			metrics.record({
				targetId: result.target.id,
				success: result.success,
				latencyMs: result.latencyMs,
				ttftMs: result.ttftMs,
				estimatedCostUsd: attemptEstimate,
				status: result.status || undefined,
				quotaObservation: quotaAdapters.observe(result.target.model.provider, result.headers, now),
				failover: !result.success && result.retryable,
			});
			if (!state.activeTask.attemptedTargetIds.includes(result.target.id)) {
				state.activeTask.attemptedTargetIds.push(result.target.id);
			}
			state.lastFailedRoute = result.retryable ? {
				targetId: result.target.id, status: result.status || 503, at: now,
				attemptedTargetIds: [...state.activeTask.attemptedTargetIds],
			} : undefined;
			events.record({
				id: `proxy-response-${request.attemptId}`,
				requestId: state.activeTask.requestId,
				sessionId: state.sessionId,
				kind: "provider_response",
				at: now,
				metadata: { attemptId: request.attemptId, ttftMs: result.ttftMs, plannedTargetId: state.lastDecision?.targetId, retryable: result.retryable },
				targetId: result.target.id,
				provider: result.target.model.provider,
				status: result.status || undefined,
				success: result.success,
				latencyMs: result.latencyMs,
			});
			if (!result.success && result.retryable) {
				events.record({
					id: `proxy-failover-${request.attemptId}`,
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
			if (!state?.activeTask || state.activeTask.requestId !== request.requestId ||
				pendingStreams.get(request.sessionId)?.requestId !== request.requestId) return;
			state.activeTask.routeTargetId = target.id;
			const updatedRequest = {
				...request,
				apisUsed: [...new Set([...request.apisUsed, target.model.api])],
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
		(ctx) => events.query({ limit: 10_000 }),
		quality,
		async (format) => {
			const path = join(globalDir, "auto-model", `events-export-${Date.now()}.${format}`);
			await events.exportTo(path, format);
			return path;
		},
		(event) => events.record(event),
		() => piProbe.optional.retryProviderRequest === true,
		(ctx) => {
			const config = configs.get(ctx.sessionManager.getSessionId()) ?? DEFAULT_CONFIG;
			return resolvePrices(config, resolvePiCandidates(ctx, config.constraints).targets);
		},
		async (prompt, ctx) => {
			const state = stateForContext(store, ctx);
			const config = configs.get(state.sessionId) ?? DEFAULT_CONFIG;
			const outcome = await applyAutoRoute(
				{ prompt } as BeforeAgentStartEvent, ctx, { ...state, activeTask: undefined },
				config, "preview", !state.initialPromptHandled, true,
			);
			const plan = outcome.status === "routed" ? outcome.plan : undefined;
			return plan && { targetId: plan.target.id, thinking: plan.thinking, policy: plan.policy,
				reason: [...plan.reason, ...(config.classifier.enabled ? ["local preview; live classifier may refine this route"] : [])],
				utility: plan.score.utility, ruleTrace: outcome.status === "routed" ? outcome.ruleTrace : undefined };

		},
		(policy) => saveConfigPolicy(configPath, policy),
		(ctx) => {
			const config = configs.get(ctx.sessionManager.getSessionId()) ?? DEFAULT_CONFIG;
			return { rules: effectiveRules(config), diagnostics: config.diagnostics ?? [] };
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
			await ensurePriceCache();
			await budgetLedger.load(budgetPath);
			const budgetWarning = budgetLedger.takeWarning();
			if (budgetWarning) notifySafe(ctx, budgetWarning, "warning");
			await quality.load(qualityPath);
			await events.load();
			budgetLedger.startSession(ctx.sessionManager.getSessionId());
			const global = await loadConfig(configPath);
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
			if (config.diagnostics?.length) {
				ctx.ui.notify(`Pi Auto Model: ${config.diagnostics.length} configuration issue(s). Run /auto-model doctor for details.`, "warning");
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

	// Extension-triggered turns (e.g. sendMessage with triggerTurn) start
	// without before_agent_start. Their triggering message is only appended
	// after agent_start, so routing waits for the first context event.
	pi.on("agent_start", safeHandler<unknown>("agent_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (runRouted.has(sessionId) || !isAutoModel(ctx.model)) return;
		runRouted.add(sessionId);
		runAwaitingRoute.add(sessionId);
	}));

	pi.on("context", safeHandler<ContextEvent>("context", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!runAwaitingRoute.delete(sessionId) || !isAutoModel(ctx.model)) return;
		await routeRun({ type: "before_agent_start", prompt: latestPromptText(event.messages) } as BeforeAgentStartEvent, ctx, false);
	}));

	pi.on("before_agent_start", safeHandler<BeforeAgentStartEvent>("before_agent_start", async (event, ctx) => {
		runRouted.add(ctx.sessionManager.getSessionId());
		// Pi >= 1.4 also emits this for idle sendMessage(..., { triggerTurn }) runs:
		// messageType "custom" with `message` and no `prompt`. Route those on the
		// message text as extension turns (no prefix pins, no first-prompt credit).
		const custom = event as { messageType?: string; message?: unknown };
		if (custom.messageType === "custom") {
			const prompt = latestPromptText([custom.message] as ContextEvent["messages"]);
			await routeRun({ ...event, prompt, images: undefined }, ctx, false);
			return;
		}
		await routeRun(event, ctx, true);
	}));

	async function routeRun(_event: BeforeAgentStartEvent, ctx: ExtensionContext, fromUserPrompt: boolean): Promise<void> {
		if (!contextIsCompatible(ctx)) {
			return;
		}

		const state = stateForContext(store, ctx);
		const config = configs.get(state.sessionId) ?? DEFAULT_CONFIG;
		const allowPrefix = fromUserPrompt && !state.initialPromptHandled;
		// A new user task must never inherit an earlier task's dispatch permission.
		pendingStreams.delete(state.sessionId);
		if (fromUserPrompt) state.initialPromptHandled = true;
		settleInterruptedTask(ctx, state);
		const budgetWarning = budgetLedger.takeWarning();
		if (budgetWarning) notifySafe(ctx, budgetWarning, "warning");
		settlePendingActivation(state);
		if (state.activation !== "active") {
			return;
		}
		const requestId = randomUUID();
		state.activeTask = { requestId, startedAt: Date.now(), lastActivityAt: Date.now(), phase: "applied",
			attemptedTargetIds: [], budgetSpentUsd: 0, attemptCount: 0, unknownCostAttempts: 0 };
		const health = routerHealth.get(state.sessionId);
		if (health?.bypassUntil && health.bypassUntil > Date.now()) {
			notifySafe(ctx, "Pi Auto Model routing is temporarily bypassed after repeated internal failures.", "warning");
			applyFallbackPlan(_event, ctx, state, config, requestId, allowPrefix);
			return;
		}
		if (health?.bypassUntil) routerHealth.delete(state.sessionId);

		// Internal exceptions may use a constrained fallback; intentional
		// policy stops must never be converted into dispatch permission.
		let outcome: AutoRouteOutcome;
		try {
			outcome = await applyAutoRoute(_event, ctx, state, config, requestId, allowPrefix, false, fromUserPrompt ? "user" : "extension");
		} catch (error) {
			recordRouterFailure(state.sessionId);
			notifySafe(ctx, `Pi Auto Model routing failed (${errorMessage(error)}). Falling back to a working model.`);
			outcome = { status: "failed" };
		}
		if (outcome.status === "routed" || outcome.status === "blocked") {
			if (outcome.status === "blocked" && state.activeTask) state.activeTask.finalAttemptSuccess = false;
			if (outcome.status === "routed") routerHealth.delete(state.sessionId);
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
	}

	// ─── Shared routing pipeline for execution and local previews ───
	async function applyAutoRoute(
		_event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
		state: SessionRuntimeState,
		config: AutoModelConfig,
		requestId: string,
		allowPrefix: boolean,
		preview = false,
		trigger: "user" | "extension" = "user",
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
			let classifierCostUsd = 0;
			let classifierAttempts = 0;
			let classifierUnknownCosts = 0;
			let profile = state.activeTask?.profile ?? analyzeTask({
				prompt: effectivePrompt,
				imageCount: _event.images?.length,
				contextTokens: contextTokensOf(ctx),
			});
			if (!preview && shouldClassify(profile, config.classifier.enabled, config.classifier.confidenceThreshold)) {
				try {
					profile = await refineWithClassifier(ctx, profile, _event.prompt, config.classifier.timeoutMs, {
						source: config.capabilitySource,
						overrides: config.benchmarkOverrides,
					}, config.constraints, { ledger: budgetLedger, config: config.budget,
						prices: resolvePrices(config, resolvePiCandidates(ctx, config.constraints).targets),
						onCost: (cost, reconciled) => {
							classifierCostUsd += cost;
							if (reconciled) classifierUnknownCosts--;
							else { classifierAttempts++; classifierUnknownCosts++; }
							if (state.activeTask?.requestId === requestId) {
								state.activeTask.budgetSpentUsd = classifierCostUsd;
								state.activeTask.attemptCount = classifierAttempts;
								state.activeTask.unknownCostAttempts = classifierUnknownCosts;
							}
						} });
				} catch {
					// Classifier failures intentionally fall back without user-facing output.
				}
			}
			if (!preview) events.record({
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
			if ((prefixPin.modelTargetId && !prefixPinnedTarget) || (effectiveCandidateTargets.length === 0 && prefixPin.mode)) {
				const hint = prefixPin.modelTargetId
					? `@model:${prefixPin.modelTargetId}`
					: `@${prefixPin.mode}`;
				notifySafe(
					ctx,
					`Pi Auto Model: prefix pin "${hint}" matched no eligible model. Request blocked.`,
					"warning",
				);
				return { status: "blocked" };
			}
			const poolName = state.manualOverrides.pool ?? config.pool;
			const pool = poolName ? config.pools[poolName] : undefined;
			if (poolName && !pool) return { status: "blocked" };
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
			// Resolved prices: user overrides → LiteLLM cache → registry cost.
			// Loaded from the local cache file; refreshed in the background.
			await ensurePriceCache();
			refreshPriceCache(config);
			const prices = resolvePrices(config, effectiveCandidateTargets);
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
					notifySafe(ctx, `Pi Auto Model pool "${poolName}" has no eligible target after health, quota, and circuit checks. Request blocked.`, "error");
				} else if (failure) {
					notifySafe(ctx, `${formatCandidateFailure(failure)} Request blocked.`, "error");
				}
				return { status: "blocked" };
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
					`Pi Auto Model failover budget exhausted after ${previousFailure.attemptedTargetIds.length} attempt(s). Request blocked.`,
					"warning",
				);
				return { status: "blocked" };
			}

			// Once the prompt cache is gone (compaction or idle expiry), staying on
			// the current target no longer saves anything.
			const coldReason = coldCacheReason(state);
			const coldCache = coldReason !== undefined;
			const stickyTargetId = coldCache ? undefined : currentRouteId(state, ctx);
			const capabilityOptions = { source: config.capabilitySource, overrides: config.benchmarkOverrides };
			const rulesDisabled = Boolean(state.manualOverrides.pinnedTargetId || prefixPinnedTarget || prefixPin.mode);
			const rules = rulesDisabled ? [] : effectiveRules(config);
			const ruleFacts: RuleFacts = {
				kinds: profile.kinds,
				complexity: profile.complexity,
				contextTokens: contextTokensOf(ctx),
				hasImages: profile.constraints.requiresVision,
				trigger,
				prompt: effectivePrompt,
			};
			const matchedRule = matchRule(rules, ruleFacts);
			let activeRule: RoutingRule | undefined = matchedRule;
			let ruleTargets = matchedRule && hasRuleFilters(matchedRule)
				? filterTargetsByRule(routeTargets, matchedRule, capabilityOptions)
				: routeTargets;
			const planDefault = (targets: readonly RouteTarget[], rule: RoutingRule | undefined) => planRoute({
				outputTokenLimit: AUTO_MODEL_MAX_TOKENS,
				targets,
				profile,
				currentTargetId: stickyTargetId,
				contextTokens: contextTokensOf(ctx),
				policy: rule?.then.policy ?? state.manualOverrides.policy ?? config.policy,
				quota: quotaSignals,
				pool: activePool,
				poolAttempts,
				latencyP95Ms,
				quality: qualitySignals,
				costMultipliers,
				prices,
				cacheAware: !coldCache && config.cacheAware?.enabled !== false,
				costQualityFloor: config.costPolicy?.qualityFloor,
				costStickinessTolerance: config.costPolicy?.stickinessTolerance,
				capabilityOptions,
				preferredTargetIds: preferredTargetIds(targets, rule),
			});
			let defaultPlan = ruleTargets.length > 0 ? planDefault(ruleTargets, activeRule) : undefined;
			let ignoredRule: RoutingRule | undefined;
			if (!defaultPlan && matchedRule && ruleTargets !== routeTargets) {
				// A rule narrows the choice but must never be the reason a request is blocked.
				ignoredRule = matchedRule;
				activeRule = undefined;
				ruleTargets = routeTargets;
				defaultPlan = planDefault(routeTargets, undefined);
				const shown = ignoredRuleNotices.get(state.sessionId) ?? new Set<string>();
				if (!preview && !shown.has(matchedRule.name)) {
					shown.add(matchedRule.name);
					ignoredRuleNotices.set(state.sessionId, shown);
					notifySafe(ctx, `Pi Auto Model: rule "${matchedRule.name}" matched, but no eligible model satisfies it. Using normal routing.`, "warning");
				}
			}
			const routePolicy = activeRule?.then.policy ?? state.manualOverrides.policy ?? config.policy;
			const retryTarget = previousFailure
				? chooseFailoverTarget(
						defaultPlan?.rankedTargets ?? [],
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
				const poolTargets = routeTargets.filter((target) => isInPool(target, activePool));
				const failures = poolTargets.length === 0
					? [`no candidate is in pool "${poolName}"`]
					: poolTargets.slice(0, 3).map((target) => `${target.id}: ${hardConstraintFailure(
						target, profile, contextTokensOf(ctx), { source: config.capabilitySource, overrides: config.benchmarkOverrides }, AUTO_MODEL_MAX_TOKENS,
					) ?? "not eligible"}`);
				notifySafe(
					ctx,
					`Pi Auto Model: no eligible model can satisfy this task's vision, context, or output requirements. Request blocked. ${failures.join("; ")}`,
					"error",
				);
				return { status: "blocked" };
			}
			const pinned = state.manualOverrides.pinnedTargetId
				? healthyTargets.find((target) => target.id === state.manualOverrides.pinnedTargetId)
				: undefined;
			const pinnedPlan = pinned
				? planRoute({
						outputTokenLimit: AUTO_MODEL_MAX_TOKENS,
						targets: [pinned],
						profile,
						contextTokens: contextTokensOf(ctx),
						policy: state.manualOverrides.policy,
						quota: quotaSignals,
						pool: activePool,
						latencyP95Ms,
						quality: qualitySignals,
						costMultipliers,
						prices,
						costQualityFloor: config.costPolicy?.qualityFloor,
						capabilityOptions: { source: config.capabilitySource, overrides: config.benchmarkOverrides },
					})
				: undefined;
			if (state.manualOverrides.pinnedTargetId && !pinnedPlan) return { status: "blocked" };
			let effectivePlan = pinnedPlan ?? plan;
			let shadowTargetId: string | undefined;
			if (config.shadow?.enabled && !pinnedPlan && !prefixPinnedTarget && !prefixPin.mode) {
				const currentId = state.sessionRoute.provider && state.sessionRoute.modelId
					? `${state.sessionRoute.provider}/${state.sessionRoute.modelId}`
					: state.startupModelId;
				const current = currentId ? plan.rankedTargets.find((target) => target.id === currentId) : undefined;
				const currentPlan = current ? planRoute({
					outputTokenLimit: AUTO_MODEL_MAX_TOKENS,
					targets: [current],
					profile,
					contextTokens: contextTokensOf(ctx),
					policy: routePolicy,
					costMultipliers,
					prices,
					costQualityFloor: config.costPolicy?.qualityFloor,
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
				prices.get(effectivePlan.target.id),
			);
			const limits = { ...config.budget, maxUsdPerTask: config.budget.maxUsdPerTask === undefined
				? undefined : Math.max(0, config.budget.maxUsdPerTask - classifierCostUsd) };
			let budgetDecision = budgetLedger.evaluate(
				effectiveEstimate,
				effectivePlan.target.model.provider,
				limits, Date.now(), state.sessionId,
			);
			if ((budgetDecision.action === "downgrade" || budgetDecision.action === "avoid") && !pinnedPlan) {
				const budgetTargets = budgetDecision.action === "avoid"
					? ruleTargets.filter((target) => target.model.provider !== effectivePlan.target.model.provider)
					: ruleTargets;
				const cheaperPlan = planRoute({
					outputTokenLimit: AUTO_MODEL_MAX_TOKENS,
					targets: budgetTargets,
					profile,
					currentTargetId: stickyTargetId,
					contextTokens: contextTokensOf(ctx),
					policy: "cost",
					quota: quotaSignals,
					pool: activePool,
					poolAttempts,
					latencyP95Ms,
					quality: qualitySignals,
					costMultipliers,
					prices,
					costQualityFloor: config.costPolicy?.qualityFloor,
					// A budget downgrade must not be vetoed by cost stickiness.
					costStickinessTolerance: 0,
					capabilityOptions: { source: config.capabilitySource, overrides: config.benchmarkOverrides },
				});
				if (cheaperPlan) {
					const cheaperEstimate = estimateCost(
						cheaperPlan.target,
						contextTokensOf(ctx),
						profile,
						prices.get(cheaperPlan.target.id),
					);
					if (cheaperEstimate < effectiveEstimate) {
						effectivePlan = cheaperPlan;
						effectiveEstimate = cheaperEstimate;
						budgetDecision = budgetLedger.evaluate(
							effectiveEstimate,
							effectivePlan.target.model.provider,
							limits, Date.now(), state.sessionId,
						);
					}
				}
			}
			if (budgetDecision.action === "block" || budgetDecision.action === "avoid") {
				notifySafe(
					ctx,
					`Pi Auto Model budget exceeded (${budgetDecision.exceeded.join(", ") || "task"}). Current model unchanged.`,
					"warning",
				);
				// Intentional user-configured stop: do not route around it.
				return { status: "blocked" };
			}
			if (!pinnedPlan) {
				const routeTags = [
					...(activeRule ? [`rule "${activeRule.name}"`] : []),
					...(ignoredRule ? [`rule "${ignoredRule.name}" ignored (no eligible model)`] : []),
					...(coldReason ? [`cache cold (${coldReason})`] : []),
				];
				if (routeTags.length) effectivePlan = { ...effectivePlan, reason: [...routeTags, ...effectivePlan.reason] };
			}
			const thinking = state.manualOverrides.thinkingMode === "fixed"
				? state.manualOverrides.fixedThinking ?? effectivePlan.thinking
				: state.manualOverrides.thinkingMode === "pi"
					? ctx.thinkingLevel ?? effectivePlan.thinking
					: activeRule?.then.thinking ?? effectivePlan.thinking;

			if (preview) {
				const ruleTrace = rulesDisabled
					? ["rules skipped while a pin is active"]
					: [...traceRules(rules, ruleFacts), ...(ignoredRule ? [`${ignoredRule.name} ignored: no eligible model`] : [])];
				return { status: "routed", plan: { ...effectivePlan, thinking }, ruleTrace };
			}

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
				maxAttempts: config.failover.maxAttempts,
				requestTimeoutMs: config.failover.requestTimeoutMs,
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
			state.cacheBoundary = undefined;
			state.activeTask = {
				requestId,
				startedAt: state.activeTask?.startedAt ?? now,
				lastActivityAt: now,
				phase: "applied",
				routeTargetId: effectivePlan.target.id,
				thinking,
				profile,
				estimatedCostUsd: effectiveEstimate,
				inputTokens: contextTokensOf(ctx),
				budgetSpentUsd: classifierCostUsd,
				attemptCount: classifierAttempts,
				unknownCostAttempts: classifierUnknownCosts,
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
				ruleName: activeRule?.name,
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
					ruleName: activeRule?.name,
					ignoredRuleName: ignoredRule?.name,
					cacheCold: coldReason,
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
	 * quota, budget, pin, or pool rules.
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
				prices: resolvePrices(config, resolvePiCandidates(ctx, config.constraints).targets),
				config: { ...config, pool: state.manualOverrides.pool ?? config.pool },
				pinnedTargetId: prefixPin.modelTargetId ?? state.manualOverrides.pinnedTargetId,
				minimumTier: prefixPin.mode ? modeToMinimumTier(prefixPin.mode) : undefined,
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
			startedAt: state.activeTask?.startedAt ?? Date.now(),
			lastActivityAt: Date.now(),
			phase: "applied",
			routeTargetId: first.id,
			thinking: fallback.thinking,
			profile: fallback.profile,
			estimatedCostUsd: fallback.estimatedCostUsd,
			inputTokens: contextTokensOf(ctx),
			budgetSpentUsd: state.activeTask?.budgetSpentUsd ?? 0,
			attemptCount: state.activeTask?.attemptCount ?? 0,
			unknownCostAttempts: state.activeTask?.unknownCostAttempts ?? 0,
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
			if (pendingStreams.has(state.sessionId)) return;
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

	/** Settles a task that never received agent_settled, keeping its real outcome when one is known. */
	function settleInterruptedTask(ctx: ExtensionContext, state: SessionRuntimeState): void {
		const previous = state.activeTask;
		if (!previous) return;
		if (previous.finalAttemptSuccess === undefined) previous.finalAttemptAborted = true;
		const failedRoute = state.lastFailedRoute;
		settleActiveTask(ctx, state.sessionId);
		// Settlement clears lastFailedRoute; keep it so the next task still avoids a failed target.
		if (previous.lastFailure && failedRoute) state.lastFailedRoute = failedRoute;
	}

	function settleActiveTask(ctx: ExtensionContext, sessionId: string, expectedRequestId?: string): void {
		const state = store.get(sessionId);
		if (!state?.activeTask) {
			return;
		}
		if (expectedRequestId && state.activeTask.requestId !== expectedRequestId) return;
		state.activeTask.phase = "settled";
		if (!state.activeTask.resultRecorded && state.activeTask.routeTargetId &&
			state.activeTask.finalAttemptSuccess !== undefined && !state.activeTask.finalAttemptAborted) {
			state.lastFailedRoute = undefined;
			metrics.record({
				targetId: state.activeTask.routeTargetId,
				success: state.activeTask.finalAttemptSuccess,
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
				success: state.activeTask.finalAttemptSuccess,
				latencyMs: Date.now() - state.activeTask.startedAt,
			});
			void metrics.flush().catch(() => {});
		}
		// Successes are learned once per task; failed attempts are learned as they settle.
		if (state.activeTask.routeTargetId && state.activeTask.finalAttemptSuccess === true && !state.activeTask.finalAttemptAborted) {
			quality.record(state.activeTask.routeTargetId, state.activeTask.routeTargetId.split("/", 1)[0],
				state.activeTask.profile?.kinds ?? ["mixed"], true);
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
		}
		const task = state.activeTask;
		events.record({ id: `task-${task.requestId}`, kind: "task_summary", requestId: task.requestId,
			sessionId, at: Date.now(), targetId: task.routeTargetId, taskKinds: task.profile?.kinds,
			latencyMs: Date.now() - task.startedAt, costUsd: task.budgetSpentUsd ?? 0,
			metadata: { outcome: task.finalAttemptAborted ? "cancelled" : task.finalAttemptSuccess === false ? "failure" : "unknown",
				costBasis: (task.attemptCount ?? 0) > 0 && task.unknownCostAttempts === 0 ? "reported" : "estimated",
				attempts: task.attemptCount ?? 0, toolErrors: task.toolCallErrors ?? 0,
				escalated: task.stageEscalated ?? false, escalationReason: task.escalationReason,
				policy: state.routingPolicy ?? "balanced" },
		});
		state.activeTask = undefined;
		state.lastTaskEndedAt = Date.now();
		pendingStreams.delete(state.sessionId);
		state.updatedAt = Date.now();
		updateAutoModelStatus(ctx, state);
		void metrics.flush().catch(() => {});
	}

	pi.on("agent_settled", safeHandler<AgentSettledEvent>("agent_settled", (_event, ctx) => {
		runRouted.delete(ctx.sessionManager.getSessionId());
		runAwaitingRoute.delete(ctx.sessionManager.getSessionId());
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
		if (event.message.stopReason === "aborted") state.activeTask.finalAttemptAborted = true;
		if (event.message.stopReason === "error") state.activeTask.finalAttemptSuccess = false;
		// Proxy usage is settled per attempt, including failures and target changes.
		if (pendingStreams.has(state.sessionId)) return;
		if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted") state.activeTask.finalAttemptSuccess = true;
		const usage = event.message.usage;
		if (!usage) return;
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
				const kind = classifyToolFailure(event.toolName, event.result);
				const task = state.activeTask;
				task.recoveryFailures = kind === "execution" ? (task.lastRecoveryTool === event.toolName ? task.recoveryFailures ?? 0 : 0) + 1 : 0;
				task.lastRecoveryTool = event.toolName;
				events.record({ id: `tool-failure-${task.requestId}-${task.toolCallErrors}`, kind: "tool_failure",
					requestId: task.requestId, sessionId: state.sessionId, at: Date.now(), targetId: task.routeTargetId,
					metadata: { failureKind: kind, tool: event.toolName } });
				const pending = pendingStreams.get(state.sessionId);
				if (task.recoveryFailures >= 2 && !task.stageEscalated && pending) {
					const config = configs.get(state.sessionId) ?? DEFAULT_CONFIG;
					const strongest = pending.targets.filter((target) => !circuits.isOpen(target.id)).sort((left, right) =>
						tierRank(deriveCapabilityPrior(right.model, { source: config.capabilitySource, overrides: config.benchmarkOverrides }).overall) -
						tierRank(deriveCapabilityPrior(left.model, { source: config.capabilitySource, overrides: config.benchmarkOverrides }).overall),
					)[0];
					const capabilityOptions = { source: config.capabilitySource, overrides: config.benchmarkOverrides };
					if (strongest && pending.targets[0] && tierRank(deriveCapabilityPrior(strongest.model, capabilityOptions).overall) >
						tierRank(deriveCapabilityPrior(pending.targets[0].model, capabilityOptions).overall)) {
						pendingStreams.set(state.sessionId, {
							...pending,
							targets: [strongest, ...pending.targets.filter((target) => target.id !== strongest.id)],
							thinking: chooseThinkingLevel(strongest.model, pending.profile),
						});
						state.activeTask.stageEscalated = true;
						state.activeTask.escalationReason = `repeated ${event.toolName} execution errors`;
						events.record({
							id: `stage-escalation-${state.activeTask.requestId}`,
							requestId: state.activeTask.requestId,
							sessionId: state.sessionId,
							kind: "failover",
							at: Date.now(),
							targetId: strongest.id,
							metadata: { reason: state.activeTask.escalationReason, toolCallErrors: state.activeTask.toolCallErrors },
						});
					}
				}
			} else {
				state.activeTask.recoveryFailures = 0;
				state.activeTask.lastRecoveryTool = undefined;
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
		async (event, ctx) => {
			if (!contextIsCompatible(ctx)) {
				return { cancel: true };
			}
			const state = stateForContext(store, ctx);
			try {
				const config = configs.get(state.sessionId) ?? DEFAULT_CONFIG;
				const task = state.activeTask;
				const compactionConfig = task && config.budget.maxUsdPerTask !== undefined
					? { ...config, budget: { ...config.budget, maxUsdPerTask: Math.max(0, config.budget.maxUsdPerTask - (task.budgetSpentUsd ?? 0)) } }
					: config;
				return await handleBeforeCompact(event, ctx, state, compactionConfig, budgetLedger, circuits,
					resolvePrices(config, resolvePiCandidates(ctx, config.constraints).targets), (cost, reconciled) => {
						if (!task || state.activeTask !== task) return;
						task.budgetSpentUsd = (task.budgetSpentUsd ?? 0) + cost;
						task.unknownCostAttempts = (task.unknownCostAttempts ?? 0) + (reconciled ? -1 : 1);
						if (!reconciled) task.attemptCount = (task.attemptCount ?? 0) + 1;
					});
			} catch (error) {
				notifySafe(ctx, `Pi Auto Model compaction cancelled: ${errorMessage(error)}`);
				return { cancel: true };
			}
		},
	);

	// Older Pi versions never emit this event; routing then keeps cache stickiness.
	pi.on("session_compact", safeHandler<SessionCompactEvent>("session_compact", (event, ctx) => {
		if (!contextIsCompatible(ctx)) return;
		const state = store.get(ctx.sessionManager.getSessionId());
		if (state?.activation !== "active") return;
		state.cacheBoundary = { at: Date.now(), reason: "compaction" };
	}));

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
		safeHandler<SessionShutdownEvent>("session_shutdown", async (_event, ctx) => {
			const state = store.get(ctx.sessionManager.getSessionId());
			if (state) settleInterruptedTask(ctx, state);
			clearAutoModelStatus(ctx);
			await Promise.allSettled([metrics.flush(), quality.flush(), events.flush()]);
			store.delete(ctx.sessionManager.getSessionId());
			pendingStreams.delete(ctx.sessionManager.getSessionId());
			routerHealth.delete(ctx.sessionManager.getSessionId());
			runRouted.delete(ctx.sessionManager.getSessionId());
			runAwaitingRoute.delete(ctx.sessionManager.getSessionId());
			ignoredRuleNotices.delete(ctx.sessionManager.getSessionId());
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
