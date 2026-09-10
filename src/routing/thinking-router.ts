import type { Model } from "@earendil-works/pi-ai";
import type { TaskProfile, ThinkingLevel } from "../types.ts";

const LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function requestedLevel(profile: TaskProfile): ThinkingLevel {
	const demand =
		profile.demand.reasoning * 0.45 +
		profile.complexity * 0.2 +
		profile.risk * 0.15 +
		profile.semantic.debugging * 0.1 +
		Math.max(profile.semantic.planning, profile.semantic.architecture) * 0.1;

	if (demand < 0.15) return "off";
	if (demand < 0.3) return "minimal";
	if (demand < 0.45) return "low";
	if (demand < 0.65) return "medium";
	if (demand < 0.82) return "high";
	if (demand < 0.93) return "xhigh";
	return "max";
}

export function chooseThinkingLevel(
	model: Model<any>,
	profile: TaskProfile,
): ThinkingLevel {
	if (!model.reasoning) {
		return "off";
	}

	const requested = requestedLevel(profile);
	const requestedIndex = LEVELS.indexOf(requested);
	for (let index = requestedIndex; index >= 0; index--) {
		const level = LEVELS[index];
		if (model.thinkingLevelMap?.[level] !== null) {
			return level;
		}
	}
	return "off";
}
