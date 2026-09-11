import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { activateFromCommand, formatStatus, setActivation } from "../pi/activation.ts";
import { formatCandidateFailure, resolvePiCandidates } from "../pi/registry-adapter.ts";
import { RuntimeStateStore } from "../pi/runtime-store.ts";
import { applyFeedback } from "../routing/feedback.ts";
import { appendFeedback } from "../storage/jsonl.ts";
import {
	normalizeRoutingPolicy,
	type CandidateConstraints,
	type RoutingPolicy,
	type ThinkingLevel,
	type WeightedPoolConfig,
} from "../types.ts";
import { isAutoModel } from "../pi/auto-model.ts";
import { CircuitBreaker } from "../health/circuit-breaker.ts";
import { RouteMetrics, percentile, type TargetMetrics } from "../metrics/route-metrics.ts";
import type { BudgetConfig, BudgetUsageSnapshot } from "../budget/budget.ts";
import {
	formatQuotaSignal,
} from "../quota/uvi.ts";
import type { ProviderQuotaSignal } from "../types.ts";
import { updateAutoModelStatus } from "./status.ts";
import type { UnifiedEvent } from "../observability/event-store.ts";
import type { QualityLearning } from "../routing/quality-learning.ts";

const FEEDBACK_LOG = join(homedir(), ".pi", "agent", "auto-model", "feedback.jsonl");

const COMMANDS = ["on", "off", "status", "why", "plan", "models", "providers", "history", "metrics", "quota", "budget", "pool", "export", "doctor", "mode", "pin", "unpin", "thinking", "feedback"] as const;
const POLICIES: RoutingPolicy[] = ["balanced", "best", "price", "fast"];
const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function completions(prefix: string) {
	const first = prefix.trim().toLowerCase().split(/\s+/)[0];
	const matches = COMMANDS.filter((command) => command.startsWith(first));
	return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

function state(store: RuntimeStateStore, ctx: ExtensionCommandContext) {
	return store.getOrCreate(ctx.sessionManager.getSessionId(), ctx.model);
}

function notify(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info") {
	ctx.ui.notify(text, type);
}

export function registerAutoModelCommand(
	pi: ExtensionAPI,
	store: RuntimeStateStore,
	circuits?: CircuitBreaker,
	metrics?: RouteMetrics,
	getConstraints?: (ctx: ExtensionCommandContext) => CandidateConstraints,
	getQuotaSignals?: (ctx: ExtensionCommandContext) => ReadonlyMap<string, ProviderQuotaSignal>,
	getBudget?: (ctx: ExtensionCommandContext) => {
		usage: BudgetUsageSnapshot;
		config: BudgetConfig;
	},
	getPools?: (ctx: ExtensionCommandContext) => Readonly<Record<string, WeightedPoolConfig>>,
	getEvents?: (ctx: ExtensionCommandContext) => readonly UnifiedEvent[],
	quality?: QualityLearning,
	exportEvents?: (format: "json" | "jsonl") => Promise<string>,
	recordEvent?: (event: UnifiedEvent) => void,
	getRetryCapability?: () => boolean,
	previewRoute?: (prompt: string, ctx: ExtensionCommandContext) => { targetId: string; thinking: ThinkingLevel; policy: RoutingPolicy; reason: readonly string[]; utility: number } | undefined,
): void {
	pi.registerCommand("auto-model", {
		description: "Control and inspect Pi Auto Model",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args.trim().toLowerCase().split(/\s+/);
			const originalRest = args.trim().replace(/^\S+\s*/, "");
			const current = state(store, ctx);
			if (command === "on") {
				activateFromCommand(pi, current);
				updateAutoModelStatus(ctx, current);
				return notify(ctx, "Pi Auto Model enabled for this session.");
			}
			if (command === "off") {
				setActivation(current, "disabled");
				if (isAutoModel(ctx.model)) {
					const previousTarget = current.sessionRoute.provider && current.sessionRoute.modelId
						? `${current.sessionRoute.provider}/${current.sessionRoute.modelId}`
						: undefined;
					const separator = previousTarget?.indexOf("/") ?? -1;
					const previousModel = previousTarget && separator > 0
						? ctx.modelRegistry.find(previousTarget.slice(0, separator), previousTarget.slice(separator + 1))
						: undefined;
					const fallbackModel = previousModel ?? resolvePiCandidates(ctx).targets[0]?.model;
					if (fallbackModel) {
						current.inFlightSelfSet++;
						try {
							await pi.setModel(fallbackModel);
						} finally {
							current.inFlightSelfSet--;
						}
					}
				}
				updateAutoModelStatus(ctx, current);
				return notify(ctx, "Pi Auto Model disabled for this session.");
			}
			if (command === "status" || command === "") {
				updateAutoModelStatus(ctx, current);
				return notify(ctx, formatStatus(current, ctx.model));
			}
			if (command === "why") {
				const decision = current.lastDecision;
				return notify(ctx, decision
					? `Pi Auto Model Decision\nTarget: ${decision.targetId}\nThinking: ${decision.thinking}\nPolicy: ${decision.policy}\nWhy: ${decision.reason.join(" · ")}\nScore: ${(decision.score.utility * 100).toFixed(1)} (heuristic)`
					: "No Pi Auto Model decision exists in this session yet.");
			}
			if (command === "plan") {
				if (!originalRest) return notify(ctx, "Usage: /auto-model plan <prompt>", "warning");
				try {
					const preview = previewRoute?.(originalRest, ctx);
					return notify(ctx, preview
						? `Pi Auto Model Preview\nTarget: ${preview.targetId}\nThinking: ${preview.thinking}\nPolicy: ${preview.policy}\nWhy: ${preview.reason.join(" · ")}\nScore: ${(preview.utility * 100).toFixed(1)} (heuristic)\nNo request was sent.`
						: "No eligible model can satisfy this prompt.", preview ? "info" : "warning");
				} catch {
					return notify(ctx, "Route preview failed. No request was sent.", "warning");
				}
			}
			if (command === "models") {
				const result = resolvePiCandidates(ctx, getConstraints?.(ctx));
				return notify(ctx, result.targets.length
					? `Eligible models:\n${result.targets.map((target) => `  ${target.id}`).join("\n")}`
					: formatCandidateFailure(result.failure!));
			}
			if (command === "providers") {
				const providers = [...new Set(resolvePiCandidates(ctx, getConstraints?.(ctx)).targets.map((target) => target.model.provider))];
				return notify(ctx, providers.length ? `Eligible providers:\n${providers.map((p) => `  ${p}`).join("\n")}` : "No eligible providers.", providers.length ? "info" : "warning");
			}
			if (command === "history") {
				const persisted = getEvents?.(ctx)?.filter((event) => event.kind === "route_decision") ?? [];
				return notify(ctx, persisted.length
					? persisted.slice(-50).map((event) => `${new Date(event.at).toLocaleTimeString()}  ${event.targetId ?? "unknown"} · ${String(event.metadata?.policy ?? "")}`).join("\n")
					: current.decisionHistory.length
						? current.decisionHistory.map((d) => `${new Date(d.createdAt).toLocaleTimeString()}  ${d.targetId} · ${d.thinking}  ${d.reason.join(", ")}`).join("\n")
						: "No Pi Auto Model decisions exist in this session yet.");
			}
			if (command === "metrics") {
				const summary = metrics?.summary();
				if (!summary || summary.attempts === 0) {
					return notify(ctx, "No Pi Auto Model route metrics recorded yet.");
				}
				const rows = [...(metrics?.snapshot() ?? [])]
					.sort(([, left], [, right]) => right.attempts - left.attempts)
					.map(([targetId, value]) => `  ${targetId} · ${formatMetrics(value)}`)
					.join("\n");
				const providers = [...(metrics?.providerSnapshot() ?? [])]
					.sort(([, left], [, right]) => right.attempts - left.attempts)
					.map(([providerId, value]) => `  ${providerId} · ${formatMetrics(value)}`)
					.join("\n");
				const quotaSignals = getQuotaSignals?.(ctx);
				const quotaRows = [...(quotaSignals ?? [])]
					.map(([providerId, signal]) => `  ${providerId} · ${formatQuotaSignal(signal)}`)
					.join("\n");
				const trend = metrics?.trend(24) ?? [];
				const trendRows = trend.length
					? trend.map((bucket) => {
						const averageLatency = bucket.attempts
							? Math.round(bucket.totalLatencyMs / bucket.attempts)
							: 0;
						const p50 = percentile(bucket.latenciesMs ?? [], 0.5);
						const p95 = percentile(bucket.latenciesMs ?? [], 0.95);
						return `  ${new Date(bucket.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${bucket.attempts} attempts · ${formatRate(bucket.successes, bucket.attempts)} · avg ${averageLatency} ms · p50/p95 ${p50}/${p95} ms · $${bucket.estimatedCostUsd.toFixed(4)} · ${bucket.rateLimitCount} rate-limit · ${bucket.failoverCount} failover`;
					}).join("\n")
					: "  no hourly data";
				return notify(ctx, [
					"Pi Auto Model Metrics",
					`Attempts: ${summary.attempts}`,
					`Success rate: ${formatRate(summary.successes, summary.attempts)}`,
					`Average latency: ${Math.round(summary.averageLatencyMs)} ms`,
					`Latency p50/p95: ${Math.round(summary.p50LatencyMs)} / ${Math.round(summary.p95LatencyMs)} ms`,
					`Estimated cost: $${summary.estimatedCostUsd.toFixed(4)}`,
					`Actual reported cost: ${summary.actualSamples ? `$${summary.actualCostUsd.toFixed(4)} (${summary.actualSamples} samples)` : "unknown"}`,
					"By provider:",
					providers,
					"Quota/UVI:",
					quotaRows || "  unknown",
					"Hourly trend (24h):",
					trendRows,
					"By target:",
					rows,
				].join("\n"));
			}
			if (command === "quota") {
				const quotaSignals = getQuotaSignals?.(ctx);
				if (!quotaSignals || quotaSignals.size === 0) {
					return notify(ctx, "No Provider quota configuration or observations available yet.");
				}
				return notify(ctx, [
					"Pi Auto Model Quota/UVI",
					...[...quotaSignals]
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([providerId, signal]) => `  ${providerId} · ${formatQuotaSignal(signal)}`),
				].join("\n"));
			}
			if (command === "budget") {
				const budget = getBudget?.(ctx);
				if (!budget) {
					return notify(ctx, "No global budget ledger is available.");
				}
				const providerRows = Object.entries(budget.usage.providers)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([provider, usage]) => {
						const limit = budget.config.providers?.[provider];
						const dailyLimit = limit?.dailyUsd === undefined ? "unlimited" : `$${limit.dailyUsd.toFixed(4)}`;
						const monthlyLimit = limit?.monthlyUsd === undefined ? "unlimited" : `$${limit.monthlyUsd.toFixed(4)}`;
						return `  ${provider} · day $${usage.dailyUsd.toFixed(4)}/${dailyLimit} · month $${usage.monthlyUsd.toFixed(4)}/${monthlyLimit}`;
					});
				return notify(ctx, [
					"Pi Auto Model Budget",
					`Day ${budget.usage.dayKey}: $${budget.usage.dailyUsd.toFixed(4)}/${budget.config.dailyUsd === undefined ? "unlimited" : `$${budget.config.dailyUsd.toFixed(4)}`}`,
					`Month ${budget.usage.monthKey}: $${budget.usage.monthlyUsd.toFixed(4)}/${budget.config.monthlyUsd === undefined ? "unlimited" : `$${budget.config.monthlyUsd.toFixed(4)}`}`,
					`Session: $${(budget.usage.sessionUsd ?? 0).toFixed(4)}/${budget.config.sessionUsd === undefined ? "unlimited" : `$${budget.config.sessionUsd.toFixed(4)}`}`,
					`Recent hourly spend: ${(budget.usage.history ?? []).slice(-24).map((entry) => `$${entry.usd.toFixed(4)}`).join(" · ") || "none"}`,
					"Providers:",
					...(providerRows.length ? providerRows : ["  no usage recorded"]),
				].join("\n"));
			}
			if (command === "export") {
				const format = rest[0] === "jsonl" ? "jsonl" : "json";
				if (!exportEvents) return notify(ctx, "Unified event export is unavailable.", "warning");
				const path = await exportEvents(format);
				return notify(ctx, `Unified events exported to ${path}`);
			}
			if (command === "pool") {
				const pools = getPools?.(ctx) ?? {};
				const requested = rest[0];
				if (!requested) {
					return notify(ctx, [
						`Active pool: ${current.manualOverrides.pool ?? current.routingPool ?? "none"}`,
						`Available pools: ${Object.keys(pools).join(", ") || "none"}`,
						"Usage: /auto-model pool <name>|off",
					].join("\n"));
				}
				if (requested === "off" || requested === "none") {
					current.manualOverrides.pool = undefined;
					updateAutoModelStatus(ctx, current);
					return notify(ctx, "Pi Auto Model pool override cleared.");
				}
				if (!pools[requested]) {
					return notify(ctx, `Unknown pool "${requested}". Available: ${Object.keys(pools).join(", ") || "none"}`, "warning");
				}
				current.manualOverrides.pool = requested;
				updateAutoModelStatus(ctx, current);
				return notify(ctx, `Pi Auto Model pool: ${requested}`);
			}
			if (command === "doctor") {
				const result = resolvePiCandidates(ctx, getConstraints?.(ctx));
				const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
				const circuitSnapshot = circuits?.snapshot();
				const quotaSignals = getQuotaSignals?.(ctx);
				const modelLines = result.diagnostics.length
					? result.diagnostics.map((diagnostic) => {
						const model = ctx.modelRegistry.find(
							diagnostic.id.slice(0, diagnostic.id.indexOf("/")),
							diagnostic.id.slice(diagnostic.id.indexOf("/") + 1),
						);
						const circuit = circuitSnapshot?.get(diagnostic.id);
						const circuitStatus = circuits?.getState(diagnostic.id) ?? "closed";
						const circuitText = circuitStatus === "half-open"
							? "half-open (probing)"
							: circuitStatus === "open" && circuit?.retryAt && circuit.retryAt > Date.now()
							? `open until ${new Date(circuit.retryAt).toLocaleTimeString()}`
							: "closed";
						const capabilities = model
							? `context ${model.contextWindow.toLocaleString()} · vision ${model.input.includes("image") ? "yes" : "no"}`
							: "capabilities unknown";
						const eligibility = diagnostic.eligible ? "eligible" : diagnostic.reasons.join(", ");
						const performance = metrics?.get(diagnostic.id);
						const quota = quotaSignals?.get(diagnostic.id.slice(0, diagnostic.id.indexOf("/")));
						return `  ${diagnostic.id} · auth ${diagnostic.authenticated ? "yes" : "no"} · ${eligibility} · ${capabilities} · circuit ${circuitText} · ${performance ? formatMetrics(performance) : "no metrics"} · ${formatQuotaSignal(quota)}`;
					}).join("\n")
					: "  none";
				return notify(ctx, [
					"Pi Auto Model Doctor",
					`Activation: ${current.activation}`,
					`Current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
					`Pi scope: ${ctx.scopedModels.length || "all available"}`,
					`Pool: ${current.manualOverrides.pool ?? current.routingPool ?? "none"}`,
					`Context: ${usage?.tokens ?? "unknown"} / ${usage?.contextWindow ?? "unknown"} tokens`,
					`Eligible targets: ${result.targets.length}`,
					"Candidates:",
					modelLines,
					`Decision history: ${current.decisionHistory.length}`,
					`Compatibility APIs: ${(current.sessionRoute.apisUsed ?? []).join(", ") || "none"}`,
					`Current-request retry hook: ${getRetryCapability?.() ? "available" : "unavailable (next-task failover only)"}`,
					`Feedback preferences: ${Object.entries(current.feedbackPreferences).map(([id, value]) => `${id} ${value >= 0 ? "+" : ""}${value.toFixed(2)}`).join(", ") || "none"}`,
				].join("\n"));
			}
			if (command === "mode") {
				const policy = normalizeRoutingPolicy(rest[0]);
				if (!policy || !POLICIES.includes(policy)) {
					return notify(ctx, "Usage: /auto-model mode balanced|best|price|fast", "warning");
				}
				current.manualOverrides.policy = policy;
				updateAutoModelStatus(ctx, current);
				return notify(ctx, `Pi Auto Model policy: ${policy}`);
			}
			if (command === "pin") {
				if (!rest[0]) return notify(ctx, "Usage: /auto-model pin <provider/model>", "warning");
				current.manualOverrides.pinnedTargetId = rest[0];
				updateAutoModelStatus(ctx, current);
				return notify(ctx, `Pi Auto Model pinned target: ${rest[0]}`);
			}
			if (command === "unpin") {
				current.manualOverrides.pinnedTargetId = undefined;
				updateAutoModelStatus(ctx, current);
				return notify(ctx, "Pi Auto Model target pin cleared.");
			}
			if (command === "thinking") {
				const mode = rest[0];
				if (mode === "auto" || mode === "pi") {
					current.manualOverrides.thinkingMode = mode;
					current.manualOverrides.fixedThinking = undefined;
					updateAutoModelStatus(ctx, current);
					return notify(ctx, `Pi Auto Model thinking mode: ${mode}`);
				}
				const level = rest[1] as ThinkingLevel;
				if (mode !== "fixed" || !THINKING.includes(level)) return notify(ctx, "Usage: /auto-model thinking auto|pi|fixed <level>", "warning");
				current.manualOverrides.thinkingMode = "fixed";
				current.manualOverrides.fixedThinking = level;
				updateAutoModelStatus(ctx, current);
				return notify(ctx, `Pi Auto Model thinking level: ${level}`);
			}
			if (command === "feedback") {
				const vote = rest[0];
				if (vote !== "good" && vote !== "bad") {
					return notify(ctx, "Usage: /auto-model feedback good|bad [target] [reason]", "warning");
				}
				const targetId = rest[1]?.includes("/") ? rest[1] : current.lastDecision?.targetId;
				if (!targetId) {
					return notify(ctx, "No Pi Auto Model decision exists yet. Pass a target: /auto-model feedback bad <provider/model>", "warning");
				}
				const reason = rest.slice(rest[1] === targetId ? 2 : 1).join(" ") || undefined;
				const preference = applyFeedback(current.feedbackPreferences[targetId] ?? 0, vote);
				current.feedbackPreferences[targetId] = preference;
				const learnedPreference = quality?.recordFeedback(
					targetId,
					current.lastDecision?.taskKinds ?? ["mixed"],
					vote,
				);
				recordEvent?.({
					id: `feedback-${Date.now()}-${targetId}`,
					kind: "user_feedback",
					at: Date.now(),
					targetId,
					taskKinds: current.lastDecision?.taskKinds,
					metadata: { feedback: vote, reason },
				});
				await appendFeedback(FEEDBACK_LOG, {
					createdAt: Date.now(),
					targetId,
					feedback: vote,
					preference: learnedPreference ?? preference,
					reason,
				}).catch(() => undefined);
				return notify(ctx, `Pi Auto Model feedback recorded: ${targetId} ${vote} (preference ${preference >= 0 ? "+" : ""}${preference.toFixed(2)}, capped at ±0.10)`);
			}
			notify(ctx, "Usage: /auto-model on|off|status|why|plan|models|providers|history|metrics|quota|budget|pool|export|doctor|mode|pin|unpin|thinking|feedback", "warning");
		},
	});
}

function formatRate(successes: number, attempts: number): string {
	return attempts ? `${((successes / attempts) * 100).toFixed(1)}%` : "n/a";
}

function formatMetrics(metrics: TargetMetrics): string {
	const average = metrics.attempts ? Math.round(metrics.totalLatencyMs / metrics.attempts) : 0;
	const p50 = percentile(metrics.latenciesMs ?? [], 0.5);
	const p95 = percentile(metrics.latenciesMs ?? [], 0.95);
	const actual = metrics.actualSamples
		? ` · actual $${(metrics.actualCostUsd ?? 0).toFixed(4)} · calibrated ×${Math.min(2, Math.max(0.5, (metrics.actualCostUsd ?? 0) / Math.max(metrics.actualEstimatedCostUsd ?? 0, Number.EPSILON))).toFixed(2)}`
		: "";
	return `${formatRate(metrics.successes, metrics.attempts)} success · avg ${average} ms · p50/p95 ${p50}/${p95} ms · estimated $${metrics.estimatedCostUsd.toFixed(4)}${actual}`;
}

export function registerUnavailableAutoModelCommand(pi: ExtensionAPI, missing: readonly string[]): void {
	if (typeof pi.registerCommand !== "function") return;
	const reason = `Pi Auto Model disabled: incompatible Pi version (missing ${missing.join(", ")})`;
	pi.registerCommand("auto-model", { description: "Show Pi Auto Model compatibility diagnostics", getArgumentCompletions: completions, handler: async (_args, ctx) => notify(ctx, reason, "error") });
}
