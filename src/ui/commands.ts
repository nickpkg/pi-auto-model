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
const POLICIES: RoutingPolicy[] = ["balanced", "best", "cost", "fast"];
const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

const POLICY_OPTIONS: CompletionItem[] = [
	{ value: "balanced", label: "balanced", description: "Balance capability, cost, and stickiness" },
	{ value: "best", label: "best", description: "Prefer capability and quality" },
	{ value: "cost", label: "cost", description: "Prefer lower-cost eligible models" },
	{ value: "fast", label: "fast", description: "Prefer a stable current target" },
];

const THINKING_MODE_OPTIONS: CompletionItem[] = [
	{ value: "auto", label: "auto", description: "Let Pi Auto Model choose the thinking level" },
	{ value: "pi", label: "pi", description: "Keep Pi's current thinking level" },
	{ value: "fixed", label: "fixed", description: "Force a fixed thinking level" },
];

const THINKING_LEVEL_OPTIONS: CompletionItem[] = THINKING.map((level) => ({
	value: level,
	label: level,
	description: "Force a fixed thinking level",
}));

const FEEDBACK_OPTIONS: CompletionItem[] = [
	{ value: "good", label: "good", description: "Positive feedback for the latest decision" },
	{ value: "bad", label: "bad", description: "Negative feedback with a reason" },
];

const EXPORT_OPTIONS: CompletionItem[] = [
	{ value: "json", label: "json", description: "Export unified events as JSON" },
	{ value: "jsonl", label: "jsonl", description: "Export unified events as JSONL" },
];

const POOL_OPTIONS: CompletionItem[] = [
	{ value: "off", label: "off", description: "Clear the session pool override" },
	{ value: "none", label: "none", description: "Clear the session pool override" },
];

/**
 * Complete "/auto-model <subcommand>" and then each subcommand's arguments.
 *
 * While the user is still typing the subcommand name, suggest subcommands.
 * Stop suggesting once it exactly matches a subcommand so Enter submits it
 * instead of accepting a longer command such as "models" for "mode". Once a
 * space appears, only suggest values for the chosen subcommand so an accepted
 * completion never replaces the subcommand itself (the completion value
 * includes it, e.g. "mode balanced").
 */
function completions(prefix: string): CompletionItem[] | null {
	const trimmed = prefix.trimStart();
	if (!trimmed.includes(" ")) {
		const first = trimmed.toLowerCase();
		if (COMMANDS.some((command) => command === first)) return null;
		const matches = COMMANDS.filter((command) => command.startsWith(first));
		return matches.length ? matches.map((value) => ({ value, label: value })) : null;
	}
	const [subcommand, ...tokens] = trimmed.toLowerCase().split(/\s+/);
	const valuePrefix = tokens.filter(Boolean).join(" ");
	switch (subcommand) {
		case "mode":
			return withCommandPrefix("mode", POLICY_OPTIONS, valuePrefix);
		case "thinking":
			if (tokens[0] === "fixed") {
				return withCommandPrefix("thinking fixed", THINKING_LEVEL_OPTIONS, tokens.slice(1).filter(Boolean).join(" "));
			}
			return withCommandPrefix("thinking", THINKING_MODE_OPTIONS, valuePrefix);
		case "feedback":
			return withCommandPrefix("feedback", FEEDBACK_OPTIONS, valuePrefix);
		case "export":
			return withCommandPrefix("export", EXPORT_OPTIONS, valuePrefix);
		case "pool":
			return withCommandPrefix("pool", POOL_OPTIONS, valuePrefix);
		default:
			return null;
	}
}

function withCommandPrefix(command: string, options: readonly CompletionItem[], prefix: string): CompletionItem[] | null {
	const lower = prefix.toLowerCase();
	const matches = options.filter((item) => item.label.startsWith(lower));
	if (matches.length === 0) return null;
	return matches.map((item) => ({ ...item, value: `${command} ${item.value}` }));
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
	previewRoute?: (prompt: string, ctx: ExtensionCommandContext) => Promise<{ targetId: string; thinking: ThinkingLevel; policy: RoutingPolicy; reason: readonly string[]; utility: number } | undefined>,
	savePolicy?: (policy: RoutingPolicy) => Promise<void>,
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
					const preview = await previewRoute?.(originalRest, ctx);
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
					? persisted.slice(-50).map((event) => `${formatLocalDateTime(event.at)}  ${event.targetId ?? "unknown"} · ${String(event.metadata?.policy ?? "")}`).join("\n")
					: current.decisionHistory.length
						? current.decisionHistory.map((d) => `${formatLocalDateTime(d.createdAt)}  ${d.targetId} · ${d.thinking}  ${d.reason.join(", ")}`).join("\n")
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
						return `  ${formatLocalDateTime(bucket.startAt)} · ${bucket.attempts} attempts · ${formatRate(bucket.successes, bucket.attempts)} · avg ${averageLatency} ms · p50/p95 ${p50}/${p95} ms · $${bucket.estimatedCostUsd.toFixed(4)} · ${bucket.rateLimitCount} rate-limit · ${bucket.failoverCount} failover`;
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
					"Hourly trend (last 24h, local time):",
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
				const now = Date.now();
				const history = budget.usage.history ?? [];
				const spentHistory = history.filter((entry) => entry.usd > 0);
				const recentRows = spentHistory
					.filter((entry) => entry.startAt + 3_600_000 > now - 24 * 3_600_000 && entry.startAt <= now)
					.map((entry) => `  ${formatLocalDateTime(entry.startAt)} · $${entry.usd.toFixed(4)}`);
				const lastSpend = spentHistory.at(-1);
				const providerRows = Object.entries(budget.usage.providers)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([provider, usage]) => {
						const limit = budget.config.providers?.[provider];
						if (usage.dailyUsd === 0 && usage.monthlyUsd === 0 && !limit) {
							return `  ${provider} · no recorded spend`;
						}
						const dailyLimit = limit?.dailyUsd === undefined ? "none" : `$${limit.dailyUsd.toFixed(4)}`;
						const monthlyLimit = limit?.monthlyUsd === undefined ? "none" : `$${limit.monthlyUsd.toFixed(4)}`;
						return `  ${provider} · today $${usage.dailyUsd.toFixed(4)} (limit ${dailyLimit}) · month $${usage.monthlyUsd.toFixed(4)} (limit ${monthlyLimit})`;
					});
				const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "system local";
				return notify(ctx, [
					"Pi Auto Model Budget",
					`Estimated local spend · ${timeZone}`,
					`Today ${budget.usage.dayKey}: $${budget.usage.dailyUsd.toFixed(4)} · limit ${budget.config.dailyUsd === undefined ? "none" : `$${budget.config.dailyUsd.toFixed(4)}`}`,
					`This month ${budget.usage.monthKey}: $${budget.usage.monthlyUsd.toFixed(4)} · limit ${budget.config.monthlyUsd === undefined ? "none" : `$${budget.config.monthlyUsd.toFixed(4)}`}`,
					`This session: $${(budget.usage.sessionUsd ?? 0).toFixed(4)} · limit ${budget.config.sessionUsd === undefined ? "none" : `$${budget.config.sessionUsd.toFixed(4)}`}`,
					"By provider (today / month):",
					...(providerRows.length ? providerRows : ["  no usage recorded"]),
					"Spend by active hour (last 24h, local time):",
					...(recentRows.length ? recentRows : ["  none"]),
					...(recentRows.length === 0 && lastSpend
						? [`Last recorded spend: ${formatLocalDateTime(lastSpend.startAt)} · $${lastSpend.usd.toFixed(4)}`]
						: []),
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
							? `open until ${formatLocalDateTime(circuit.retryAt)}`
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
				let policy = normalizeRoutingPolicy(rest[0]);
				if (!policy && rest.length === 0 && ctx.hasUI && typeof ctx.ui.select === "function") {
					const chosen = await ctx.ui.select("Select Pi Auto Model policy", [...POLICIES]);
					if (!chosen) return;
					policy = normalizeRoutingPolicy(chosen);
				}
				if (!policy || !POLICIES.includes(policy)) {
					return notify(ctx, "Usage: /auto-model mode balanced|best|cost|fast", "warning");
				}
				try {
					await savePolicy?.(policy);
				} catch (error) {
					return notify(ctx, `Pi Auto Model policy was not changed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				current.manualOverrides.policy = policy;
				updateAutoModelStatus(ctx, current);
				return notify(ctx, `Pi Auto Model policy: ${policy}${savePolicy ? " (saved as global default)" : ""}`);
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
				let mode = rest[0];
				let level = rest[1] as ThinkingLevel;
				if (!mode && ctx.hasUI && typeof ctx.ui.select === "function") {
					const chosen = await ctx.ui.select("Pi Auto Model thinking mode", ["auto", "pi", "fixed"]);
					if (!chosen) return;
					mode = chosen;
				}
				if (mode === "auto" || mode === "pi") {
					current.manualOverrides.thinkingMode = mode;
					current.manualOverrides.fixedThinking = undefined;
					updateAutoModelStatus(ctx, current);
					return notify(ctx, `Pi Auto Model thinking mode: ${mode}`);
				}
				if (mode === "fixed") {
					if (!level && ctx.hasUI && typeof ctx.ui.select === "function") {
						const chosen = await ctx.ui.select("Fixed thinking level", [...THINKING]);
						if (!chosen) return;
						level = chosen as ThinkingLevel;
					}
					if (!THINKING.includes(level)) return notify(ctx, "Usage: /auto-model thinking auto|pi|fixed <level>", "warning");
					current.manualOverrides.thinkingMode = "fixed";
					current.manualOverrides.fixedThinking = level;
					updateAutoModelStatus(ctx, current);
					return notify(ctx, `Pi Auto Model thinking level: ${level}`);
				}
				return notify(ctx, "Usage: /auto-model thinking auto|pi|fixed <level>", "warning");
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

function formatLocalDateTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString([], {
		year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
	});
}

function formatMetrics(metrics: TargetMetrics): string {
	const average = metrics.attempts ? Math.round(metrics.totalLatencyMs / metrics.attempts) : 0;
	const p50 = percentile(metrics.latenciesMs ?? [], 0.5);
	const p95 = percentile(metrics.latenciesMs ?? [], 0.95);
	const actual = metrics.actualSamples
		? ` · actual $${(metrics.actualCostUsd ?? 0).toFixed(4)} · calibrated ×${Math.min(2, Math.max(0.5, (metrics.actualCostUsd ?? 0) / Math.max(metrics.actualEstimatedCostUsd ?? 0, Number.EPSILON))).toFixed(2)}`
		: "";
	const ttft = metrics.ttftMs?.length ? ` · TTFT p50/p95 ${percentile(metrics.ttftMs, 0.5)}/${percentile(metrics.ttftMs, 0.95)} ms` : "";
	return `${formatRate(metrics.successes, metrics.attempts)} success · avg ${average} ms · p50/p95 ${p50}/${p95} ms${ttft} · estimated $${metrics.estimatedCostUsd.toFixed(4)}${actual}`;
}

export function registerUnavailableAutoModelCommand(pi: ExtensionAPI, missing: readonly string[]): void {
	if (typeof pi.registerCommand !== "function") return;
	const reason = `Pi Auto Model disabled: incompatible Pi version (missing ${missing.join(", ")})`;
	pi.registerCommand("auto-model", { description: "Show Pi Auto Model compatibility diagnostics", getArgumentCompletions: completions, handler: async (_args, ctx) => notify(ctx, reason, "error") });
}
