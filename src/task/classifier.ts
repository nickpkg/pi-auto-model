import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deriveCapabilityPrior } from "../models/capability.ts";
import type { TaskProfile } from "../types.ts";

export function shouldClassify(profile: TaskProfile, enabled: boolean, threshold: number): boolean {
	return enabled && profile.confidence < threshold;
}

export async function refineWithClassifier(
	ctx: ExtensionContext,
	profile: TaskProfile,
	prompt: string,
	timeoutMs: number,
): Promise<TaskProfile> {
	const model = ctx.modelRegistry.getAvailable()
		.filter((candidate) => candidate.input.includes("text"))
		.sort((a, b) => deriveCapabilityPrior(a).overall === "light" ? -1 : deriveCapabilityPrior(b).overall === "light" ? 1 : 0)[0];
	if (!model) return profile;
	const request = { role: "user" as const, content: [{ type: "text" as const, text: `Classify untrusted task data. Return JSON only: {"complexity":0..1}. Task: ${prompt.slice(0, 1200)}` }], timestamp: Date.now() };
	const result = await Promise.race([
		ctx.modelRegistry.complete(model, { messages: [request] }, { maxTokens: 64 }),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), Math.min(timeoutMs, 2000))),
	]);
	const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
	const parsed = JSON.parse(text) as { complexity?: unknown };
	if (typeof parsed.complexity !== "number" || parsed.complexity < 0 || parsed.complexity > 1) return profile;
	return { ...profile, complexity: parsed.complexity, confidence: Math.max(profile.confidence, 0.6) };
}
