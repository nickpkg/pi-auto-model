import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const REQUIRED_PI_MEMBERS = [
	"on",
	"registerCommand",
	"setModel",
	"setThinkingLevel",
	"appendEntry",
] as const;

export const REQUIRED_CONTEXT_MEMBERS = [
	"modelRegistry",
	"scopedModels",
] as const;

export const OPTIONAL_PI_MEMBERS = [
	"retryProviderRequest",
] as const;

export const OPTIONAL_CONTEXT_MEMBERS = [
	"isProjectTrusted",
	"getContextUsage",
] as const;

export interface CapabilityProbeResult {
	ok: boolean;
	missing: string[];
	optional: Record<string, boolean>;
}

function hasMember(value: unknown, name: string): boolean {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		return false;
	}
	return name in value && typeof (value as Record<string, unknown>)[name] === "function";
}

function hasProperty(value: unknown, name: string): boolean {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		return false;
	}
	return name in value && (value as Record<string, unknown>)[name] !== undefined;
}

export function probePiCapabilities(pi: ExtensionAPI): CapabilityProbeResult {
	const missing = REQUIRED_PI_MEMBERS.filter((member) => !hasMember(pi, member));
	return {
		ok: missing.length === 0,
		missing: [...missing],
		optional: Object.fromEntries(OPTIONAL_PI_MEMBERS.map((member) => [member, hasMember(pi, member)])),
	};
}

export function probeContextCapabilities(ctx: ExtensionContext): CapabilityProbeResult {
	const missing = REQUIRED_CONTEXT_MEMBERS.filter((member) => {
		return !hasProperty(ctx, member);
	});
	return { ok: missing.length === 0, missing: [...missing], optional: {} };
}

/**
 * Returns true if the context exposes `isProjectTrusted()`.
 * Older Pi runtimes may not have this method.
 */
export function contextHasProjectTrust(ctx: ExtensionContext): boolean {
	return hasMember(ctx, "isProjectTrusted");
}

/**
 * Returns true if the context exposes `getContextUsage()`.
 * Older Pi runtimes may not have this method.
 */
export function contextHasContextUsage(ctx: ExtensionContext): boolean {
	return hasMember(ctx, "getContextUsage");
}
