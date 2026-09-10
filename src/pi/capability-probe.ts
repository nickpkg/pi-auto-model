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
	"isProjectTrusted",
	"getContextUsage",
] as const;

export interface CapabilityProbeResult {
	ok: boolean;
	missing: string[];
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
	return { ok: missing.length === 0, missing: [...missing] };
}

export function probeContextCapabilities(ctx: ExtensionContext): CapabilityProbeResult {
	const missing = REQUIRED_CONTEXT_MEMBERS.filter((member) => {
		if (member === "isProjectTrusted" || member === "getContextUsage") {
			return !hasMember(ctx, member);
		}
		return !hasProperty(ctx, member);
	});
	return { ok: missing.length === 0, missing: [...missing] };
}
