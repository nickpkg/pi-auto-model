import type { Model } from "@earendil-works/pi-ai";
import type { ModelCapabilityPrior } from "../types.ts";

const CAPABILITY_PRIORS: Readonly<Record<string, ModelCapabilityPrior>> = {
	"openai/gpt-5.6-luna": {
		overall: "frontier",
		coding: "frontier",
		reasoning: "frontier",
		toolUse: "strong",
		instructionFollowing: "strong",
		confidence: "medium",
	},
	"deepseek/deepseek-v4-flash-0731": {
		overall: "strong",
		coding: "strong",
		reasoning: "strong",
		toolUse: "strong",
		instructionFollowing: "mid",
		confidence: "medium",
	},
	"z-ai/glm-5.3-flash": {
		overall: "strong",
		coding: "strong",
		reasoning: "strong",
		toolUse: "mid",
		instructionFollowing: "mid",
		confidence: "medium",
	},
	"qwen/qwen3.8-flash": {
		overall: "mid",
		coding: "mid",
		reasoning: "mid",
		toolUse: "mid",
		instructionFollowing: "mid",
		confidence: "medium",
	},
	"openrouter/free": {
		overall: "light",
		coding: "light",
		reasoning: "light",
		toolUse: "light",
		instructionFollowing: "light",
		confidence: "low",
	},
};

export function capabilityScore(tier: ModelCapabilityPrior["overall"]): number {
	switch (tier) {
		case "frontier":
			return 1;
		case "strong":
			return 0.82;
		case "mid":
			return 0.64;
		case "light":
			return 0.45;
		case "unknown":
			return 0.55;
	}
}

export function deriveCapabilityPrior(model: Model<any>): ModelCapabilityPrior {
	const catalogPrior = CAPABILITY_PRIORS[model.id];
	if (catalogPrior) {
		return catalogPrior;
	}

	return {
		overall: "unknown",
		coding: "unknown",
		reasoning: model.reasoning ? "unknown" : "light",
		toolUse: "unknown",
		instructionFollowing: "unknown",
		confidence: "low",
	};
}

export function supportsVision(model: Model<any>): boolean {
	return model.input.includes("image");
}
