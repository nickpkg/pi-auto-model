export type CompatAction = "keep" | "strip-thinking";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function compatibilityAction(
	apisUsed: readonly string[],
	targetApi: string,
): CompatAction {
	return apisUsed.every((api) => api === targetApi) ? "keep" : "strip-thinking";
}

export function stripThinkingForRequest(messages: readonly unknown[]): unknown[] {
	return messages.map((message) => {
		if (
			!isRecord(message) ||
			message.role !== "assistant" ||
			!Array.isArray(message.content)
		) {
			return message;
		}

		const content = message.content.filter(
			(block) => !isRecord(block) || block.type !== "thinking",
		);
		return content.length === message.content.length ? message : { ...message, content };
	});
}
