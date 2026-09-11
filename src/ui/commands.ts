import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { activateFromCommand, formatStatus, setActivation } from "../pi/activation.ts";
import { formatCandidateFailure, resolvePiCandidates } from "../pi/registry-adapter.ts";
import { RuntimeStateStore } from "../pi/runtime-store.ts";
import { applyFeedback } from "../routing/feedback.ts";
import { appendFeedback } from "../storage/jsonl.ts";
import { normalizeRoutingPolicy, type RoutingPolicy, type ThinkingLevel } from "../types.ts";
import { isAutoModel } from "../pi/auto-model.ts";

const FEEDBACK_LOG = join(homedir(), ".pi", "agent", "auto-model", "feedback.jsonl");

const COMMANDS = ["on", "off", "status", "why", "models", "providers", "history", "doctor", "mode", "pin", "unpin", "thinking", "feedback"] as const;
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

export function registerAutoModelCommand(pi: ExtensionAPI, store: RuntimeStateStore): void {
	pi.registerCommand("auto-model", {
		description: "Control and inspect Pi Auto Model",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args.trim().toLowerCase().split(/\s+/);
			const current = state(store, ctx);
			if (command === "on") {
				activateFromCommand(pi, current);
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
				return notify(ctx, "Pi Auto Model disabled for this session.");
			}
			if (command === "status" || command === "") return notify(ctx, formatStatus(current, ctx.model));
			if (command === "why") {
				const decision = current.lastDecision;
				return notify(ctx, decision
					? `Pi Auto Model Decision\nTarget: ${decision.targetId}\nThinking: ${decision.thinking}\nPolicy: ${decision.policy}\nWhy: ${decision.reason.join(" · ")}\nScore: ${(decision.score.utility * 100).toFixed(1)} (heuristic)`
					: "No Pi Auto Model decision exists in this session yet.");
			}
			if (command === "models") {
				const result = resolvePiCandidates(ctx);
				return notify(ctx, result.targets.length
					? `Eligible models:\n${result.targets.map((target) => `  ${target.id}`).join("\n")}`
					: formatCandidateFailure(result.failure!));
			}
			if (command === "providers") {
				const providers = [...new Set(resolvePiCandidates(ctx).targets.map((target) => target.model.provider))];
				return notify(ctx, providers.length ? `Eligible providers:\n${providers.map((p) => `  ${p}`).join("\n")}` : "No eligible providers.", providers.length ? "info" : "warning");
			}
			if (command === "history") {
				return notify(ctx, current.decisionHistory.length
					? current.decisionHistory.map((d) => `${new Date(d.createdAt).toLocaleTimeString()}  ${d.targetId} · ${d.thinking}  ${d.reason.join(", ")}`).join("\n")
					: "No Pi Auto Model decisions exist in this session yet.");
			}
			if (command === "doctor") {
				const result = resolvePiCandidates(ctx);
				return notify(ctx, `Pi Auto Model Doctor\nActivation: ${current.activation}\nPi scope: ${ctx.scopedModels.length || "all available"}\nEligible targets: ${result.targets.length}\nDecision history: ${current.decisionHistory.length}\nCompatibility APIs: ${(current.sessionRoute.apisUsed ?? []).join(", ") || "none"}\nFeedback preferences: ${Object.entries(current.feedbackPreferences).map(([id, value]) => `${id} ${value >= 0 ? "+" : ""}${value.toFixed(2)}`).join(", ") || "none"}`);
			}
			if (command === "mode") {
				const policy = normalizeRoutingPolicy(rest[0]);
				if (!policy || !POLICIES.includes(policy)) {
					return notify(ctx, "Usage: /auto-model mode balanced|best|price|fast", "warning");
				}
				current.manualOverrides.policy = policy;
				return notify(ctx, `Pi Auto Model policy: ${policy}`);
			}
			if (command === "pin") {
				if (!rest[0]) return notify(ctx, "Usage: /auto-model pin <provider/model>", "warning");
				current.manualOverrides.pinnedTargetId = rest[0];
				return notify(ctx, `Pi Auto Model pinned target: ${rest[0]}`);
			}
			if (command === "unpin") {
				current.manualOverrides.pinnedTargetId = undefined;
				return notify(ctx, "Pi Auto Model target pin cleared.");
			}
			if (command === "thinking") {
				const mode = rest[0];
				if (mode === "auto" || mode === "pi") {
					current.manualOverrides.thinkingMode = mode;
					current.manualOverrides.fixedThinking = undefined;
					return notify(ctx, `Pi Auto Model thinking mode: ${mode}`);
				}
				const level = rest[1] as ThinkingLevel;
				if (mode !== "fixed" || !THINKING.includes(level)) return notify(ctx, "Usage: /auto-model thinking auto|pi|fixed <level>", "warning");
				current.manualOverrides.thinkingMode = "fixed";
				current.manualOverrides.fixedThinking = level;
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
				await appendFeedback(FEEDBACK_LOG, {
					createdAt: Date.now(),
					targetId,
					feedback: vote,
					preference,
					reason,
				}).catch(() => undefined);
				return notify(ctx, `Pi Auto Model feedback recorded: ${targetId} ${vote} (preference ${preference >= 0 ? "+" : ""}${preference.toFixed(2)}, capped at ±0.10)`);
			}
			notify(ctx, "Usage: /auto-model on|off|status|why|models|providers|history|doctor|mode|pin|unpin|thinking|feedback", "warning");
		},
	});
}

export function registerUnavailableAutoModelCommand(pi: ExtensionAPI, missing: readonly string[]): void {
	if (typeof pi.registerCommand !== "function") return;
	const reason = `Pi Auto Model disabled: incompatible Pi version (missing ${missing.join(", ")})`;
	pi.registerCommand("auto-model", { description: "Show Pi Auto Model compatibility diagnostics", getArgumentCompletions: completions, handler: async (_args, ctx) => notify(ctx, reason, "error") });
}
