import type { TaskKind, TaskProfile } from "../types.ts";

export interface LocalAnalysisInput {
	prompt: string;
	imageCount?: number;
	contextTokens?: number;
	recentToolCalls?: number;
}

const KEYWORDS: ReadonlyArray<[TaskKind, RegExp]> = [
	["debug", /\b(debug|bug|error|exception|stack trace|fix)\b|调试|报错|异常|修复/i],
	["refactor", /\b(refactor|cleanup|restructure)\b|重构|整理代码/i],
	["review", /\b(review|audit|code review)\b|审查|评审/i],
	["test", /\b(test|spec|coverage)\b|测试|用例|覆盖率/i],
	["plan", /\b(plan|roadmap|steps?)\b|计划|步骤|方案/i],
	["architecture", /\b(architect|design system|trade-?off)\b|架构|设计方案/i],
	["ops", /\b(deploy|incident|production|kubernetes|k8s)\b|部署|线上|运维|告警/i],
	["research", /\b(research|compare|investigate)\b|调研|对比|研究/i],
	["explain", /\b(explain|what is|how does)\b|解释|是什么|原理/i],
	["code-edit", /\b(implement|change|modify|add|remove)\b|实现|修改|新增|删除/i],
	["generate", /\b(generate|create|write)\b|生成|创建|编写/i],
];

function clamp(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function hasKind(kinds: readonly TaskKind[], kind: TaskKind): boolean {
	return kinds.includes(kind);
}

export function analyzeTask(input: LocalAnalysisInput): TaskProfile {
	const prompt = input.prompt.trim();
	const kinds: TaskKind[] = KEYWORDS
		.filter(([, pattern]) => pattern.test(prompt))
		.map(([kind]) => kind);
	const resolvedKinds: TaskKind[] =
		kinds.length === 0 ? ["mixed"] : [...new Set(kinds)];
	const imageCount = input.imageCount ?? 0;
	const contextTokens = input.contextTokens ?? 0;
	const recentToolCalls = input.recentToolCalls ?? 0;
	const codeSignals = /\b(function|class|const|let|import|```)\b|[{};]/.test(prompt);
	const traceSignals = /\bat\s+\S+\s+\(|Error:|Exception|Traceback/i.test(prompt);
	const multiStep = /\b(and then|after that|also|then)\b|然后|并且|同时/.test(prompt);

	const debugging = clamp(
		(hasKind(resolvedKinds, "debug") ? 0.7 : 0) + (traceSignals ? 0.25 : 0),
	);
	const planning = clamp(hasKind(resolvedKinds, "plan") ? 0.8 : 0);
	const architecture = clamp(hasKind(resolvedKinds, "architecture") ? 0.85 : 0);
	const review = clamp(hasKind(resolvedKinds, "review") ? 0.85 : 0);
	const generation = clamp(
		(hasKind(resolvedKinds, "generate") ? 0.65 : 0) +
			(hasKind(resolvedKinds, "code-edit") ? 0.25 : 0),
	);
	const explanation = clamp(hasKind(resolvedKinds, "explain") ? 0.85 : 0);
	const coding = clamp(
		(codeSignals ? 0.4 : 0) +
			(hasKind(resolvedKinds, "code-edit") ? 0.45 : 0) +
			(hasKind(resolvedKinds, "refactor") ? 0.35 : 0) +
			(hasKind(resolvedKinds, "test") ? 0.25 : 0),
	);
	const reasoning = clamp(
		0.15 + debugging * 0.4 + planning * 0.3 + architecture * 0.4 + review * 0.2,
	);
	const toolUse = clamp(
		(hasKind(resolvedKinds, "ops") ? 0.6 : 0) +
			(hasKind(resolvedKinds, "test") ? 0.45 : 0) +
			(hasKind(resolvedKinds, "code-edit") ? 0.25 : 0) +
			(recentToolCalls > 2 ? 0.15 : 0),
	);
	const complexity = clamp(
		0.1 +
			Math.min(prompt.length / 4000, 0.25) +
			(debugging + planning + architecture + review) * 0.3 +
			(multiStep ? 0.15 : 0) +
			(recentToolCalls > 4 ? 0.1 : 0),
	);
	const taskId = `local-${Date.now()}-${prompt.length}`;

	return {
		taskId,
		kinds: resolvedKinds.length > 1 ? [...resolvedKinds, "mixed"] : resolvedKinds,
		complexity,
		demand: {
			coding,
			reasoning,
			toolUse,
			instructionFollowing: clamp(0.3 + (multiStep ? 0.3 : 0)),
			context: clamp(contextTokens / 128_000),
			vision: imageCount > 0 ? 1 : 0,
		},
		semantic: {
			debugging,
			planning,
			architecture,
			review,
			generation,
			explanation,
		},
		risk: clamp((hasKind(resolvedKinds, "ops") ? 0.5 : 0) + debugging * 0.25),
		latencySensitivity: hasKind(resolvedKinds, "ops") ? 0.7 : 0.4,
		costSensitivity: hasKind(resolvedKinds, "research") ? 0.6 : 0.4,
		confidence: clamp(0.35 + Math.min(kinds.length * 0.18, 0.55) + (traceSignals ? 0.1 : 0)),
		constraints: {
			requiresVision: imageCount > 0,
			requiredContextTokens: contextTokens + Math.max(Math.ceil(prompt.length / 4), 1024),
			requiredOutputTokens: hasKind(resolvedKinds, "generate") || coding > 0.5 ? 4096 : 2048,
		},
	};
}
