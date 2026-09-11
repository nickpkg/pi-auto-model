export type ProviderErrorClass =
	| "rate-limit"
	| "server"
	| "auth"
	| "client"
	| "not-found"
	| "unknown";

export interface ProviderErrorClassification {
	classification: ProviderErrorClass;
	retryable: boolean;
	unsafeToReplay: boolean;
}

export function classifyProviderError(status: number, hasStreamedOutput = false, hasToolCall = false): ProviderErrorClassification {
	const classification: ProviderErrorClass =
		status === 429 ? "rate-limit" :
		status >= 500 ? "server" :
		status === 401 || status === 403 ? "auth" :
		status === 404 ? "not-found" :
		status >= 400 ? "client" : "unknown";
	return {
		classification,
		retryable: classification === "rate-limit" || classification === "server",
		unsafeToReplay: hasStreamedOutput || hasToolCall,
	};
}

export function shouldOpenCircuit(status: number): boolean {
	return status === 429 || status >= 500;
}

/**
 * Detects Gemini `thought_signature` / `thinking_signature` 400 errors.
 *
 * These are session-history compatibility issues, not provider health
 * problems. They should trigger failover (try a different target) but
 * should NOT open the circuit breaker, because the provider itself is
 * healthy — it just can't process the accumulated thinking signatures
 * from a previous turn with a different model.
 */
export function isSignatureError(status: number, errorText: string): boolean {
	if (status !== 400) {
		return false;
	}
	const lower = errorText.toLowerCase();
	return (
		lower.includes("thought_signature") ||
		lower.includes("thinking_signature") ||
		(lower.includes("signature") && (lower.includes("thinking") || lower.includes("thought")))
	);
}

/**
 * Extended classification that distinguishes signature errors and whether
 * the failure should open the circuit breaker.
 */
export interface DetailedErrorClassification extends ProviderErrorClassification {
	signatureError: boolean;
	/** Whether this failure should open the circuit breaker. */
	opensCircuit: boolean;
}

export function classifyDetailedError(
	status: number,
	errorText: string,
	hasStreamedOutput = false,
	hasToolCall = false,
): DetailedErrorClassification {
	const base = classifyProviderError(status, hasStreamedOutput, hasToolCall);
	const sig = isSignatureError(status, errorText);
	return {
		...base,
		signatureError: sig,
		// Signature errors are retryable (failover to a different target)
		// but must NOT open the circuit (the provider is healthy).
		retryable: base.retryable || sig,
		opensCircuit: !sig && shouldOpenCircuit(status),
	};
}
