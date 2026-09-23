import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	DEFAULT_CONFIG,
	type AutoModelConfig,
} from "./defaults.ts";
import { normalizeRoutingPolicy } from "../types.ts";

export async function loadConfig(
	path: string,
	fallback: AutoModelConfig = DEFAULT_CONFIG,
): Promise<AutoModelConfig> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isValidConfig(value)) throw new Error("invalid auto-model config");
		const parsed = value;
		return {
			...fallback,
			...parsed,
			policy: normalizeRoutingPolicy(parsed.policy) ?? fallback.policy,
			pool: typeof parsed.pool === "string" ? parsed.pool : fallback.pool,
			constraints: { ...fallback.constraints, ...parsed.constraints },
			aliases: { ...fallback.aliases, ...parsed.aliases },
			quota: {
				...fallback.quota,
				...parsed.quota,
				providers: { ...fallback.quota.providers, ...parsed.quota?.providers },
			},
			budget: {
				...fallback.budget,
				...parsed.budget,
				providers: { ...fallback.budget.providers, ...parsed.budget?.providers },
			},
			pools: { ...fallback.pools, ...parsed.pools },
			failover: { ...fallback.failover, ...parsed.failover },
			classifier: { ...fallback.classifier, ...parsed.classifier },
			capabilitySource: parsed.capabilitySource ?? fallback.capabilitySource,
			benchmarkOverrides: parsed.benchmarkOverrides ?? fallback.benchmarkOverrides,
			cacheAware: { enabled: parsed.cacheAware?.enabled ?? fallback.cacheAware?.enabled ?? true },
			shadow: { enabled: parsed.shadow?.enabled ?? fallback.shadow?.enabled ?? false },
			costPolicy: parsed.costPolicy ?? fallback.costPolicy,
		};
	} catch {
		return {
			...fallback,
			pool: fallback.pool,
			constraints: { ...fallback.constraints },
			aliases: { ...fallback.aliases },
			quota: {
				...fallback.quota,
				providers: { ...fallback.quota.providers },
			},
			budget: {
				...fallback.budget,
				providers: { ...fallback.budget.providers },
			},
			pools: { ...fallback.pools },
			failover: { ...fallback.failover },
			classifier: { ...fallback.classifier },
			capabilitySource: fallback.capabilitySource,
			benchmarkOverrides: fallback.benchmarkOverrides,
			cacheAware: { enabled: fallback.cacheAware?.enabled ?? true },
			shadow: { enabled: fallback.shadow?.enabled ?? false },
			costPolicy: fallback.costPolicy,
		};
	}
}

export async function saveConfigPolicy(path: string, policy: AutoModelConfig["policy"]): Promise<void> {
	let config: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(parsed)) throw new Error("invalid auto-model config");
		config = parsed;
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
	}
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(temporaryPath, `${JSON.stringify({ ...config, policy }, null, 2)}\n`, "utf8");
	await rename(temporaryPath, path);
}

export function mergeConfig(base: AutoModelConfig, override: AutoModelConfig): AutoModelConfig {
	return {
		...base,
		...override,
		policy: normalizeRoutingPolicy(override.policy) ?? base.policy,
		pool: override.pool ?? base.pool,
		constraints: { ...base.constraints, ...override.constraints },
		aliases: { ...base.aliases, ...override.aliases },
		quota: {
			...base.quota,
			...override.quota,
			providers: { ...base.quota.providers, ...override.quota.providers },
		},
		budget: {
			...base.budget,
			...override.budget,
			providers: { ...base.budget.providers, ...override.budget.providers },
		},
		pools: { ...base.pools, ...override.pools },
		failover: { ...base.failover, ...override.failover },
		classifier: { ...base.classifier, ...override.classifier },
		capabilitySource: override.capabilitySource ?? base.capabilitySource,
		benchmarkOverrides: override.benchmarkOverrides ?? base.benchmarkOverrides,
		cacheAware: { enabled: override.cacheAware?.enabled ?? base.cacheAware?.enabled ?? true },
		shadow: { enabled: override.shadow?.enabled ?? base.shadow?.enabled ?? false },
		costPolicy: override.costPolicy ?? base.costPolicy,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): boolean {
	return value === undefined || typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalPositiveNumber(value: unknown): boolean {
	return value === undefined || typeof value === "number" && Number.isFinite(value) && value > 0;
}

function optionalNumberInRange(value: unknown, max: number): boolean {
	return value === undefined || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}

function optionalPositiveInteger(value: unknown): boolean {
	return value === undefined || typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function optionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}

function optionalStrings(value: unknown): boolean {
	return value === undefined || Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function recordValues(value: unknown, validate: (entry: unknown) => boolean): boolean {
	return value === undefined || isRecord(value) && Object.values(value).every(validate);
}

export function isValidConfig(value: unknown): value is Partial<AutoModelConfig> {
	if (!isRecord(value)) return false;
	if (!optionalBoolean(value.enabled)) return false;
	if (value.policy !== undefined && normalizeRoutingPolicy(value.policy) === undefined) return false;
	if (value.pool !== undefined && typeof value.pool !== "string") return false;
	if (value.capabilitySource !== undefined && value.capabilitySource !== "ramp" && value.capabilitySource !== "aa") return false;

	if (value.constraints !== undefined && (!isRecord(value.constraints) ||
		![value.constraints.modelInclude, value.constraints.modelExclude, value.constraints.providerAllow, value.constraints.providerDeny].every(optionalStrings))) return false;
	if (!recordValues(value.aliases, (entry) => typeof entry === "string")) return false;

	if (value.quota !== undefined) {
		if (!isRecord(value.quota) || !optionalBoolean(value.quota.enabled) || !optionalPositiveNumber(value.quota.windowMs) || !optionalPositiveNumber(value.quota.staleAfterMs)) return false;
		if (!recordValues(value.quota.providers, (entry) => isRecord(entry) &&
			[entry.maxUsd, entry.maxRequests, entry.warningUvi, entry.blockUvi, entry.windowMs].every(optionalNumber))) return false;
	}

	const budgetActions = new Set(["warn", "avoid", "downgrade", "block"]);
	if (value.budget !== undefined) {
		if (!isRecord(value.budget) || ![value.budget.maxUsdPerTask, value.budget.sessionUsd, value.budget.dailyUsd, value.budget.monthlyUsd].every(optionalNumber)) return false;
		if (value.budget.onExceed !== undefined && !budgetActions.has(value.budget.onExceed as string)) return false;
		if (!recordValues(value.budget.providers, (entry) => isRecord(entry) &&
			optionalNumber(entry.dailyUsd) && optionalNumber(entry.monthlyUsd) &&
			(entry.onExceed === undefined || budgetActions.has(entry.onExceed as string)))) return false;
	}

	if (!recordValues(value.pools, (entry) => {
		if (!isRecord(entry) || !optionalPositiveNumber(entry.windowHours)) return false;
		if (entry.allocation !== undefined && !["rolling", "fixed", "daily"].includes(entry.allocation as string)) return false;
		if (entry.fallback !== undefined && !["none", "any"].includes(entry.fallback as string)) return false;
		const validTargets = (targets: unknown) => targets === undefined || Array.isArray(targets) && targets.every((target) =>
			isRecord(target) && typeof target.id === "string" && typeof target.weight === "number" && Number.isFinite(target.weight) && target.weight > 0,
		);
		return validTargets(entry.targets) && validTargets(entry.providers);
	})) return false;

	if (value.failover !== undefined && (!isRecord(value.failover) ||
		!optionalPositiveInteger(value.failover.maxAttempts) ||
		!optionalPositiveNumber(value.failover.firstOutputTimeoutMs))) return false;
	if (value.classifier !== undefined && (!isRecord(value.classifier) || !optionalBoolean(value.classifier.enabled) ||
		!optionalNumberInRange(value.classifier.confidenceThreshold, 1) || !optionalPositiveNumber(value.classifier.timeoutMs))) return false;
	if (value.cacheAware !== undefined && (!isRecord(value.cacheAware) || !optionalBoolean(value.cacheAware.enabled))) return false;
	if (value.shadow !== undefined && (!isRecord(value.shadow) || !optionalBoolean(value.shadow.enabled))) return false;
	if (value.costPolicy !== undefined && (!isRecord(value.costPolicy) || !optionalNumberInRange(value.costPolicy.qualityFloor, 1))) return false;
	if (!recordValues(value.benchmarkOverrides, (entry) => isRecord(entry) && optionalNumberInRange(entry.ramp, 1) && optionalNumberInRange(entry.aa, 100))) return false;
	return true;
}
