import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

export const AUTO_MODEL_PROVIDER = "pi-auto-model";
export const AUTO_MODEL_ID = "auto";
export const AUTO_MODEL_TARGET_ID = `${AUTO_MODEL_PROVIDER}/${AUTO_MODEL_ID}`;

export function isAutoModel(model: Model<any> | undefined): boolean {
	return model?.provider === AUTO_MODEL_PROVIDER && model.id === AUTO_MODEL_ID;
}

export function registerAutoModelProvider(pi: ExtensionAPI): void {
	pi.registerProvider(AUTO_MODEL_PROVIDER, {
		name: "Pi Auto Model",
		baseUrl: "auto-model://virtual",
		apiKey: "auto-model",
		api: "pi-messages",
		models: [
			{
				id: AUTO_MODEL_ID,
				name: "Pi Auto Model",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
			},
		],
	});
}
