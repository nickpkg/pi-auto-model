/**
 * Inline prefix parser for per-turn model pins.
 *
 * Users can prefix their first message with a capability mode or an
 * exact model target to control routing for that turn:
 *
 *   @low summarize this file
 *   @medium implement this small change
 *   @high debug this failing test
 *   @ultra review this architecture
 *   @model:anthropic/claude-opus-5 use this exact model
 *
 * The prefix is stripped before the model receives the prompt.
 * Later-turn prefixes are ignored because they would carry existing
 * session context into a new model and lose its prompt cache.
 *
 * Only a leading prefix at the very start of the prompt is recognized.
 * Whitespace between the prefix and the rest of the prompt is consumed.
 */

export type CapabilityModeHint = "low" | "medium" | "high" | "ultra";

export interface PrefixPin {
	/** Capability mode hint, when the prefix is @low/@medium/@high/@ultra. */
	mode?: CapabilityModeHint;
	/** Exact model target ID `provider/model`, when the prefix is @model:... */
	modelTargetId?: string;
	/** The prompt with the prefix stripped. */
	strippedPrompt: string;
}

const MODE_PREFIXES = new Map<string, CapabilityModeHint>([
	["@low", "low"],
	["@medium", "medium"],
	["@high", "high"],
	["@ultra", "ultra"],
]);

const MODEL_PREFIX_RE = /^@model:(\S+)\s*/;
const MODE_PREFIX_RE = /^@(low|medium|high|ultra)\b\s*/i;

/**
 * Parses a leading prefix pin from the prompt.
 *
 * Returns the parsed pin and the stripped prompt.  When no prefix is
 * found, returns the original prompt unchanged with no pin.
 */
export function parsePrefixPin(prompt: string): PrefixPin {
	const trimmed = prompt.trimStart();

	// Check @model:provider/model first (more specific).
	const modelMatch = trimmed.match(MODEL_PREFIX_RE);
	if (modelMatch) {
		const targetId = modelMatch[1];
		const strippedPrompt = trimmed.slice(modelMatch[0].length);
		return {
			modelTargetId: targetId,
			strippedPrompt: strippedPrompt.length > 0 ? strippedPrompt : prompt,
		};
	}

	// Check @low/@medium/@high/@ultra.
	const modeMatch = trimmed.match(MODE_PREFIX_RE);
	if (modeMatch) {
		const mode = MODE_PREFIXES.get(`@${modeMatch[1].toLowerCase()}`);
		if (mode) {
			const strippedPrompt = trimmed.slice(modeMatch[0].length);
			return {
				mode,
				strippedPrompt: strippedPrompt.length > 0 ? strippedPrompt : prompt,
			};
		}
	}

	return { strippedPrompt: prompt };
}

/**
 * Returns true if the prompt starts with a recognized prefix pin.
 */
export function hasPrefixPin(prompt: string): boolean {
	const pin = parsePrefixPin(prompt);
	return pin.mode !== undefined || pin.modelTargetId !== undefined;
}

/**
 * Maps a capability mode hint to a minimum capability tier.
 *
 * The router uses this to filter candidates: only models at or above
 * the indicated tier are considered for this turn.
 */
export function modeToMinimumTier(mode: CapabilityModeHint): import("../types.ts").CapabilityTier {
	switch (mode) {
		case "low":
			return "light";
		case "medium":
			return "mid";
		case "high":
			return "strong";
		case "ultra":
			return "frontier";
	}
}
