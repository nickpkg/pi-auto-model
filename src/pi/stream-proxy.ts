/**
 * Same-request failover via streamSimple proxy.
 *
 * When the user selects pi-auto-model/auto, Pi calls this handler instead of
 * a real provider. The handler iterates through a pre-planned target list,
 * proxies the real provider's stream, and transparently fails over to the
 * next target when an error occurs before substantive output (text or tool
 * call) has been flushed to the user.
 *
 * Key safety property: once any substantive event has been forwarded to the
 * outer stream, we never failover. This prevents duplicate tool-call
 * execution and inconsistent output.
 */
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Api,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RouteTarget, TaskProfile, ThinkingLevel } from "../types.ts";
import type { CircuitBreaker } from "../health/circuit-breaker.ts";
import { classifyDetailedError } from "../health/provider-errors.ts";
import { compatibilityAction, stripThinkingForRequest } from "../compat/guard.ts";

// ─── public types ───────────────────────────────────────────────

/**
 * Route plan stored by before_agent_start for each streamSimple call in the
 * task's tool loop. The targets are ordered by utility (best first).
 */
export interface PendingStreamRequest {
	targets: readonly RouteTarget[];
	thinking: ThinkingLevel;
	profile: TaskProfile;
	requestId: string;
	sessionId: string;
	estimatedCostUsd: number;
	/** APIs previously used in the session, for cross-API thinking stripping. */
	apisUsed: readonly string[];
	/** Prefix string to strip from the last user message before sending. */
	prefixToStrip?: string;
	/**
	 * Optional fail-safe: fail over when a target produces no substantive
	 * output within this window (from `config.failover.firstOutputTimeoutMs`).
	 * Off when undefined.
	 */
	firstOutputTimeoutMs?: number;
}

/**
 * Per-attempt telemetry collected by the proxy. Passed to callbacks so the
 * extension can update metrics, quality, events, etc.
 */
export interface AttemptResult {
	target: RouteTarget;
	status: number;
	headers: Record<string, string>;
	success: boolean;
	retryable: boolean;
	latencyMs: number;
}

export interface StreamProxyDeps {
	getRegistry: () => ModelRegistry | undefined;
	circuits: CircuitBreaker;
	getPendingStream: () => PendingStreamRequest | undefined;
	/** Called before a target is attempted. Return false to skip it. */
	beforeAttempt?: (target: RouteTarget) => boolean | Promise<boolean>;
	/** Called when an attempt's HTTP response arrives (for quota/circuit updates). */
	onAttemptResponse?: (target: RouteTarget, status: number, headers: Record<string, string>) => void;
	/** Called after an attempt finishes (success or failure) for metrics/quality. */
	onAttemptSettled?: (result: AttemptResult) => void;
	/** Called when the proxy selects a target (for state recording). */
	onTargetCommitted?: (target: RouteTarget) => void;
}

// ─── helpers ────────────────────────────────────────────────────

/**
 * Returns true for events that constitute "substantive output" — i.e. once
 * the user has seen this, failover is unsafe because tool calls may have
 * side effects or partial text may be visible.
 */
function isSubstantive(event: AssistantMessageEvent): boolean {
	return (
		event.type === "text_delta" ||
		event.type === "text_end" ||
		event.type === "toolcall_start" ||
		event.type === "toolcall_end"
	);
}

/**
 * Extracts error text from a stream error event's AssistantMessage content,
 * or from a thrown Error. Used for signature-error detection.
 */
function extractErrorText(source: AssistantMessageEvent | unknown): string {
	if (typeof source === "object" && source !== null && "type" in source && (source as Record<string, unknown>).type === "error") {
		const error = (source as unknown as { error: AssistantMessage }).error;
		if (error?.content) {
			return error.content
				.filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && c.type === "text")
				.map((c) => c.text)
				.join(" ");
		}
	}
	if (source instanceof Error) {
		return source.message;
	}
	return String(source);
}

function makeErrorMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as AssistantMessage;
}

function pushError(outer: AssistantMessageEventStream, text: string): void {
	const error = makeErrorMessage(text);
	outer.push({ type: "error", reason: "error", error });
	outer.end(error);
}

/**
 * Wraps an inner stream so that failing over is possible even when the
 * provider never emits anything. If no *substantive* event has been
 * forwarded within `timeoutMs`, it emits an error event on the returned
 * stream, which the proxy treats as a safe pre-output failover (nothing has
 * been shown to the user). Once substantive output has been forwarded or the
 * stream ends normally, the timer is cancelled and the wrapper is a plain
 * pass-through. Only safe before output: a mid-response hang cannot be
 * failed over without duplicating visible output.
 */
function withFirstOutputTimeout(
	inner: AssistantMessageEventStream,
	timeoutMs: number,
	onTimeout: () => void,
): AssistantMessageEventStream {
	const guarded = createAssistantMessageEventStream();
	let sawSubstantive = false;
	let settled = false;

	const timer = setTimeout(() => {
		if (settled || sawSubstantive) return;
		settled = true;
		onTimeout();
		const error = makeErrorMessage(
			"Pi Auto Model: target produced no output within the configured timeout.",
		);
		guarded.push({ type: "error", reason: "error", error });
		guarded.end(error);
	}, Math.max(1, timeoutMs));

	void (async () => {
		try {
			for await (const event of inner) {
				if (isSubstantive(event)) {
					sawSubstantive = true;
				}
				if (settled) {
					// Timeout already fired; stop forwarding.
					return;
				}
				guarded.push(event);
				if (event.type === "done" || event.type === "error") {
					settled = true;
					clearTimeout(timer);
					guarded.end(event.type === "done" ? event.message : event.error);
					return;
				}
			}
			// Inner stream ended without a terminal event (abandoned).
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				guarded.end();
			}
		} catch (error) {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				const message = makeErrorMessage(extractErrorText(error));
				guarded.push({ type: "error", reason: "error", error: message });
				guarded.end(message);
			}
		}
	})();

	return guarded;
}

/**
 * Strips thinking blocks from context messages when the target model's API
 * differs from APIs used earlier in the session. This prevents sending
 * Anthropic-format thinking to OpenAI-format providers, etc.
 *
 * Also strips a leading prefix pin (e.g. `@high `) from the last user
 * message when `prefixToStrip` is set.
 */
function adaptContext(
	context: Context,
	target: RouteTarget,
	apisUsed: readonly string[],
	prefixToStrip?: string,
): Context {
	let messages = context.messages;

	if (compatibilityAction(apisUsed, target.model.api) !== "keep") {
		messages = stripThinkingForRequest(messages) as Context["messages"];
	}

	if (prefixToStrip) {
		messages = stripPrefixFromLastUserMessage(messages, prefixToStrip) as Context["messages"];
	}

	return { ...context, messages };
}

/**
 * Removes a leading prefix from the last user message's text content.
 * Non-text parts are preserved.  Messages other than the last user
 * message are returned unchanged.
 */
function stripPrefixFromLastUserMessage(
	messages: Context["messages"],
	prefix: string,
): Context["messages"] {
	// Find the last user message.
	let lastIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			lastIndex = i;
			break;
		}
	}
	if (lastIndex < 0) return messages;

	const lastMessage = messages[lastIndex];
	const content = lastMessage.content;
	if (!Array.isArray(content)) return messages;

	const strippedContent = content.map((part) => {
		if (typeof part === "object" && part !== null && part.type === "text" && typeof (part as { text: string }).text === "string") {
			const textPart = part as { type: "text"; text: string };
			const trimmed = textPart.text.trimStart();
			if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
				const after = textPart.text.slice(textPart.text.indexOf(trimmed) + prefix.length).replace(/^\s+/, "");
				return { ...textPart, text: after };
			}
		}
		return part;
	});

	return [
		...messages.slice(0, lastIndex),
		{ ...lastMessage, content: strippedContent } as typeof lastMessage,
		...messages.slice(lastIndex + 1),
	];
}

// ─── core proxy ─────────────────────────────────────────────────

/**
 * Creates a streamSimple handler that proxies real provider streams with
 * same-request failover. Register this as the virtual provider's
 * `streamSimple` in `registerProvider`.
 */
export function createStreamProxyHandler(
	deps: StreamProxyDeps,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return (_autoModel: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const outer = createAssistantMessageEventStream();
		void runFailoverLoop(outer, context, options, deps);
		return outer;
	};
}

async function runFailoverLoop(
	outer: AssistantMessageEventStream,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: StreamProxyDeps,
): Promise<void> {
	const pending = deps.getPendingStream();

	if (!pending || pending.targets.length === 0) {
		pushError(outer, "Pi Auto Model: no route plan available. Select pi-auto-model/auto in /model to re-enable.");
		return;
	}

	const registry = deps.getRegistry();
	if (!registry) {
		pushError(outer, "Pi Auto Model: model registry not yet initialised.");
		return;
	}

	const maxAttempts = Math.max(1, pending.targets.length);
	let lastErrorText = "All targets failed";

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const target = pending.targets[attempt];
		const startedAt = Date.now();
		if (deps.beforeAttempt && !await deps.beforeAttempt(target)) {
			lastErrorText = `Pi Auto Model: ${target.id} was blocked by routing policy.`;
			continue;
		}

		// Resolve the real provider and auth for this target.
		const provider = registry.getProvider(target.model.provider);
		if (!provider?.streamSimple) {
			lastErrorText = `Pi Auto Model: provider ${target.model.provider} has no streamSimple.`;
			continue;
		}

		let authOk = true;
		let apiKey: string | undefined;
		let authEnv: Record<string, string> | undefined;
		let headers: Record<string, string> | undefined;
		let requestModel = target.model;
		try {
			const auth = await registry.getApiKeyAndHeaders(target.model);
			if (auth.ok) {
				apiKey = auth.apiKey;
				authEnv = auth.env;
				headers = auth.headers as Record<string, string> | undefined;
				if (auth.baseUrl) requestModel = { ...target.model, baseUrl: auth.baseUrl };
			} else {
				authOk = false;
			}
		} catch {
			authOk = false;
		}
		if (!authOk) {
			lastErrorText = `Pi Auto Model: auth not configured for ${target.id}.`;
			continue;
		}

		// If the target's circuit is in half-open, acquire a probe slot.
		// If another session is already probing it, skip to the next target.
		const circuitState = deps.circuits.getState(target.id);
		let acquiredProbe = false;
		if (circuitState === "half-open") {
			acquiredProbe = deps.circuits.tryAcquireProbe(target.id);
			if (!acquiredProbe) {
				lastErrorText = `Pi Auto Model: ${target.id} is being probed by another session, skipping.`;
				continue;
			}
		}

		// Adapt context for cross-API thinking compatibility and prefix stripping.
		const adaptedContext = adaptContext(context, target, pending.apisUsed, pending.prefixToStrip);

		// Capture the HTTP response for failover classification.
		let responseStatus = 0;
		let responseHeaders: Record<string, string> = {};

		const timeoutController = pending.firstOutputTimeoutMs && pending.firstOutputTimeoutMs > 0
			? new AbortController()
			: undefined;
		const signal = timeoutController
			? AbortSignal.any([...(options?.signal ? [options.signal] : []), timeoutController.signal])
			: options?.signal;
		const innerOptions: SimpleStreamOptions = {
			...options,
			signal,
			apiKey,
			headers: { ...headers, ...(options?.headers as Record<string, string>) } as SimpleStreamOptions["headers"],
			env: authEnv as SimpleStreamOptions["env"],
			reasoning: (pending.thinking === "off" ? undefined : pending.thinking) as SimpleStreamOptions["reasoning"],
			onResponse: async (response: { status: number; headers: Record<string, string> }) => {
				responseStatus = response.status;
				responseHeaders = response.headers;
				await options?.onResponse?.(response, requestModel);
				deps.onAttemptResponse?.(target, response.status, response.headers);
			},
		};

		let inner: AssistantMessageEventStream;
		try {
			inner = provider.streamSimple(requestModel, adaptedContext, innerOptions);
		} catch (error) {
			if (acquiredProbe) deps.circuits.releaseProbe(target.id);
			lastErrorText = error instanceof Error ? error.message : String(error);
			const classification = classifyDetailedError(503, lastErrorText);
			deps.onAttemptSettled?.({
				target,
				status: 0,
				headers: {},
				success: false,
				retryable: classification.retryable,
				latencyMs: Date.now() - startedAt,
			});
			continue;
		}

		// Optional fail-safe: if the target never produces output within the
		// configured window, emit an error so we fail over to the next target.
		// This only ever fires before substantive output, so nothing the user
		// has already seen is discarded.
		if (pending.firstOutputTimeoutMs && pending.firstOutputTimeoutMs > 0) {
			inner = withFirstOutputTimeout(inner, pending.firstOutputTimeoutMs, () => timeoutController?.abort());
		}

		// Consume the inner stream with buffering.
		let sawSubstantive = false;
		let flushed = false;
		let committed = false;
		const buffer: AssistantMessageEvent[] = [];
		let settled = false;

		const commit = (): void => {
			if (!committed) {
				committed = true;
				deps.onTargetCommitted?.(target);
			}
		};

		try {
			for await (const event of inner) {
				if (isSubstantive(event)) {
					sawSubstantive = true;
				}

				if (event.type === "error") {
					if (!sawSubstantive) {
						// Safe to failover — nothing has been shown to the user.
						const errorText = extractErrorText(event);
						const classification = classifyDetailedError(
							responseStatus || 503,
							errorText,
							false,
							false,
						);
						settled = true;
						deps.onAttemptSettled?.({
							target,
							status: responseStatus || 0,
							headers: responseHeaders,
							success: false,
							retryable: classification.retryable,
							latencyMs: Date.now() - startedAt,
						});
						// Only open the circuit for non-signature failures.
						// Signature errors are compatibility issues, not provider health.
						if (classification.opensCircuit && responseStatus > 0) {
							deps.circuits.record(target.id, responseStatus, Date.now());
						} else if (responseStatus > 0 && responseStatus < 400) {
							// Success status: close the circuit.
							deps.circuits.record(target.id, responseStatus, Date.now());
						}
						if (acquiredProbe) deps.circuits.releaseProbe(target.id);
						lastErrorText = `Target ${target.id} failed (status ${responseStatus || "stream-error"}).`;
						break; // try next target
					}
					// Already committed — flush remaining buffer and forward the error.
					flushBuffer(outer, buffer);
					outer.push(event);
					outer.end(event.error);
					settled = true;
					const errorTextAfter = extractErrorText(event);
					const classificationAfter = classifyDetailedError(
						responseStatus || 503,
						errorTextAfter,
						true,
						false,
					);
					deps.onAttemptSettled?.({
						target,
						status: responseStatus || 0,
						headers: responseHeaders,
						success: false,
						retryable: false,
						latencyMs: Date.now() - startedAt,
					});
					if (classificationAfter.opensCircuit && responseStatus > 0) {
						deps.circuits.record(target.id, responseStatus, Date.now());
					}
					commit();
					return;
				}

				if (event.type === "done") {
					flushBuffer(outer, buffer);
					outer.push(event);
					outer.end(event.message);
					settled = true;
					deps.onAttemptSettled?.({
						target,
						status: responseStatus || 200,
						headers: responseHeaders,
						success: true,
						retryable: false,
						latencyMs: Date.now() - startedAt,
					});
					// Success: close the circuit (clears half-open probe state too).
					deps.circuits.record(target.id, responseStatus || 200, Date.now());
					commit();
					return;
				}

				// Flush buffer once we see substantive output.
				if (sawSubstantive && !flushed) {
					flushBuffer(outer, buffer);
					flushed = true;
					commit();
				}

				if (flushed) {
					outer.push(event);
				} else {
					buffer.push(event);
				}
			}
		} catch (error) {
			if (acquiredProbe) deps.circuits.releaseProbe(target.id);
			const errorText = extractErrorText(error);
			if (!sawSubstantive) {
				// Safe to failover.
				const classification = classifyDetailedError(
					responseStatus || 503,
					errorText,
					false,
					false,
				);
				if (!settled) {
					deps.onAttemptSettled?.({
						target,
						status: responseStatus || 0,
						headers: responseHeaders,
						success: false,
						retryable: classification.retryable,
						latencyMs: Date.now() - startedAt,
					});
				}
				if (classification.opensCircuit && responseStatus > 0) {
					deps.circuits.record(target.id, responseStatus, Date.now());
				}
				lastErrorText = errorText;
				continue;
			}
			// Already committed — push an error.
			flushBuffer(outer, buffer);
			pushError(outer, errorText);
			if (!settled) {
				deps.onAttemptSettled?.({
					target,
					status: responseStatus || 0,
					headers: responseHeaders,
					success: false,
					retryable: false,
					latencyMs: Date.now() - startedAt,
				});
			}
			const classificationCatch = classifyDetailedError(
				responseStatus || 503,
				errorText,
				true,
				false,
			);
			if (classificationCatch.opensCircuit && responseStatus > 0) {
				deps.circuits.record(target.id, responseStatus, Date.now());
			}
			return;
		}

		// If we broke out of the loop for failover, the attempt was already
		// settled above. If the stream ended without done/error (abandoned),
		// record it and try the next target.
		if (!settled) {
			if (acquiredProbe) deps.circuits.releaseProbe(target.id);
			deps.onAttemptSettled?.({
				target,
				status: responseStatus || 0,
				headers: responseHeaders,
				success: false,
				retryable: true,
				latencyMs: Date.now() - startedAt,
			});
		}
	}

	// All targets exhausted.
	pushError(outer, lastErrorText);
}

function flushBuffer(outer: AssistantMessageEventStream, buffer: AssistantMessageEvent[]): void {
	for (const event of buffer) {
		outer.push(event);
	}
	buffer.length = 0;
}
