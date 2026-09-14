import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deriveCapabilityPrior, type CapabilityOptions } from "../models/capability.ts";
import type { TaskProfile, TaskKind, CapabilityTier, CandidateConstraints } from "../types.ts";
import { resolvePiCandidates } from "../pi/registry-adapter.ts";
import type { BudgetLedger, BudgetConfig } from "../budget/budget.ts";

export function shouldClassify(profile: TaskProfile, enabled: boolean, threshold: number): boolean {
	return enabled && profile.confidence < threshold;
}

/**
 * Structured classifier output.  All fields are optional so the classifier
 * can return partial results.  The refiner merges only the fields that are
 * present and valid.
 */
export interface ClassifierResult {
	complexity?: number;
	/** Primary task kind, used to override the local heuristic. */
	kind?: TaskKind;
	/** Secondary task kinds. */
	kinds?: TaskKind[];
	/** Required capability tier for this task. */
	minTier?: CapabilityTier;
	/** Whether the task requires deep reasoning. */
	requiresReasoning?: boolean;
	/** Whether the task involves vision/image input. */
	requiresVision?: boolean;
	/** Whether the task is high-risk (ops, production, destructive). */
	highRisk?: boolean;
}

const VALID_KINDS: ReadonlySet<TaskKind> = new Set([
	"explain", "code-edit", "generate", "debug", "refactor",
	"review", "test", "plan", "architecture", "ops", "research", "mixed",
]);

const VALID_TIERS: ReadonlySet<CapabilityTier> = new Set([
	"frontier", "strong", "mid", "light", "unknown",
]);

/**
 * Parses and validates a classifier response into a structured result.
 * Returns `undefined` when the response is malformed.
 */
export function parseClassifierResult(raw: string): ClassifierResult | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const obj = parsed as Record<string, unknown>;

	const result: ClassifierResult = {};

	if (typeof obj.complexity === "number" && obj.complexity >= 0 && obj.complexity <= 1) {
		result.complexity = obj.complexity;
	}

	if (typeof obj.kind === "string" && VALID_KINDS.has(obj.kind as TaskKind)) {
		result.kind = obj.kind as TaskKind;
	}

	if (Array.isArray(obj.kinds)) {
		const validKinds = obj.kinds.filter(
			(k): k is TaskKind => typeof k === "string" && VALID_KINDS.has(k as TaskKind),
		);
		if (validKinds.length > 0) {
			result.kinds = validKinds;
		}
	}

	if (typeof obj.minTier === "string" && VALID_TIERS.has(obj.minTier as CapabilityTier)) {
		result.minTier = obj.minTier as CapabilityTier;
	}

	if (typeof obj.requiresReasoning === "boolean") {
		result.requiresReasoning = obj.requiresReasoning;
	}

	if (typeof obj.requiresVision === "boolean") {
		result.requiresVision = obj.requiresVision;
	}

	if (typeof obj.highRisk === "boolean") {
		result.highRisk = obj.highRisk;
	}

	// At least one field must be present.
	if (Object.keys(result).length === 0) return undefined;
	return result;
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/**
 * Merges a structured classifier result into the local task profile.
 * Only fields present in the classifier result override the local heuristic.
 */
export function mergeClassifierResult(profile: TaskProfile, result: ClassifierResult): TaskProfile {
	const merged = { ...profile };

	if (result.complexity !== undefined) {
		merged.complexity = clamp(result.complexity);
	}

	if (result.kind && result.kind !== "mixed") {
		merged.kinds = result.kinds && result.kinds.length > 0
			? [...new Set([...result.kinds, "mixed" as TaskKind])] as TaskKind[]
			: [result.kind, "mixed" as TaskKind];
	} else if (result.kinds && result.kinds.length > 0) {
		merged.kinds = [...new Set([...result.kinds, "mixed" as TaskKind])] as TaskKind[];
	}

	if (result.requiresReasoning !== undefined) {
		merged.demand = {
			...merged.demand,
			reasoning: clamp(
				result.requiresReasoning
					? Math.max(merged.demand.reasoning, 0.7)
					: Math.min(merged.demand.reasoning, 0.3),
			),
		};
	}

	if (result.requiresVision !== undefined) {
		merged.constraints = {
			...merged.constraints,
			requiresVision: result.requiresVision || merged.constraints.requiresVision,
		};
		merged.demand = {
			...merged.demand,
			vision: result.requiresVision ? 1 : merged.demand.vision,
		};
	}
	if (result.minTier !== undefined) {
		merged.constraints = { ...merged.constraints, minimumTier: result.minTier };
	}

	if (result.highRisk !== undefined) {
		merged.risk = clamp(
			result.highRisk
				? Math.max(merged.risk, 0.6)
				: Math.min(merged.risk, 0.3),
		);
	}

	// Upgrading confidence: the classifier gave us structured info.
	merged.confidence = Math.max(merged.confidence, 0.65);

	return merged;
}

export async function refineWithClassifier(
	ctx: ExtensionContext,
	profile: TaskProfile,
	prompt: string,
	timeoutMs: number,
	capabilityOptions?: CapabilityOptions,
	constraints: CandidateConstraints = {},
	budget?: { ledger: BudgetLedger; config: BudgetConfig; onCost: (cost: number) => void },
): Promise<TaskProfile> {
	const model = resolvePiCandidates(ctx, constraints).targets.map((target) => target.model)
		.filter((candidate) => candidate.input.includes("text"))
		.sort((a, b) => deriveCapabilityPrior(a, capabilityOptions).overall === "light" ? -1 : deriveCapabilityPrior(b, capabilityOptions).overall === "light" ? 1 : 0)[0];
	if (!model) return profile;

	const classifierPrompt = `Classify this coding task. Return JSON only with any of these fields:
{"complexity":0..1,"kind":"debug|refactor|review|test|plan|architecture|ops|research|explain|code-edit|generate|mixed","kinds":["debug","test"],"minTier":"light|mid|strong|frontier","requiresReasoning":bool,"requiresVision":bool,"highRisk":bool}
Task: ${prompt.slice(0, 1200)}`;

	const request = {
		role: "user" as const,
		content: [{ type: "text" as const, text: classifierPrompt }],
		timestamp: Date.now(),
	};
	const reservation = { provider: model.provider, sessionId: ctx.sessionManager.getSessionId(),
		at: Date.now(), estimate: (Math.ceil(classifierPrompt.length / 3) * model.cost.input + 128 * model.cost.output) / 1_000_000 };
	if (budget) {
		const decision = await budget.ledger.reserve(model.provider, reservation.estimate, budget.config, reservation.at, reservation.sessionId);
		if (decision.action === "block" || decision.action === "avoid") return profile;
		budget.onCost(reservation.estimate);
	}
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let result: Awaited<ReturnType<typeof ctx.modelRegistry.complete>>;
	try {
		result = await Promise.race([
			ctx.modelRegistry.complete(model, { messages: [request] }, { maxTokens: 128, signal: controller.signal }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => { controller.abort(); reject(new Error("Classifier timeout")); }, Math.max(1, Math.min(timeoutMs, 2000)));
			}),
		]);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
	const actual = result.usage?.cost?.total;
	if (budget && typeof actual === "number" && Number.isFinite(actual) && actual > 0) {
		await budget.ledger.reconcile(reservation, actual);
		budget.onCost(actual - reservation.estimate);
	}
	const text = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");

	const parsed = parseClassifierResult(text);
	if (!parsed) return profile;

	return mergeClassifierResult(profile, parsed);
}
