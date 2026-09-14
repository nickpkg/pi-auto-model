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
import { randomUUID } from "node:crypto";
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
	/** Unique dispatch identity, including retries and tool-loop continuations. */
	attemptId?: string;
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
	ttftMs?: number;
	message?: AssistantMessage;
}

export interface StreamProxyDeps {
	getRegistry: () => ModelRegistry | undefined;
	circuits: CircuitBreaker;
	getPendingStream: (sessionId?: string) => PendingStreamRequest | undefined;
	/** Called before a target is attempted. Return false to skip it. */
	beforeAttempt?: (target: RouteTarget, request: PendingStreamRequest, context: Context) => boolean | Promise<boolean>;
	/** Called when an attempt's HTTP response arrives (for quota/circuit updates). */
	onAttemptResponse?: (target: RouteTarget, status: number, headers: Record<string, string>, request: PendingStreamRequest) => void;
	/** Called after an attempt finishes (success or failure) for metrics/quality. */
	onAttemptSettled?: (result: AttemptResult, request: PendingStreamRequest) => unknown;
	/** Called when the proxy selects a target (for state recording). */
	onTargetCommitted?: (target: RouteTarget, request: PendingStreamRequest) => void;
	/** Called when the proxy implementation itself throws, never for provider failures. */
	onInternalError?: (error: unknown, sessionId?: string) => void;
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
		event.type === "toolcall_delta" ||
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
		if (error?.errorMessage) return error.errorMessage;
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
		content: [],
		errorMessage: text,
		api: "pi-messages", provider: "pi-auto-model", model: "auto",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error", timestamp: Date.now(),
	} as AssistantMessage;
}

function pushError(outer: AssistantMessageEventStream, text: string): void {
	const error = makeErrorMessage(text);
	outer.push({ type: "error", reason: "error", error });
	outer.end(error);
}

function ignoreFailure(action: (() => void) | undefined): void {
	try {
		action?.();
	} catch {
		// Observability and lifecycle callbacks must never break model delivery.
	}
}

async function allowOnFailure(action: (() => boolean | Promise<boolean>) | undefined): Promise<boolean> {
	try {
		return action ? await action() : true;
	} catch {
		// A failed policy check is not permission to send a request.
		return false;
	}
}

function finishWithError(outer: AssistantMessageEventStream, text: string): void {
	try {
		pushError(outer, text);
	} catch {
		try {
			outer.end();
		} catch {}
	}
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
function guardStream(
	inner: AssistantMessageEventStream,
	timeoutMs: number | undefined,
	controller: AbortController,
	parentSignal?: AbortSignal,
): AssistantMessageEventStream {
	const guarded = createAssistantMessageEventStream();
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cleanup = (): void => {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", cancel);
	};
	const fail = (reason: "error" | "aborted", text: string): void => {
		if (settled) return;
		settled = true;
		cleanup();
		controller.abort();
		const error = { ...makeErrorMessage(text), stopReason: reason };
		guarded.push({ type: "error", reason, error });
		guarded.end(error);
	};
	const cancel = (): void => fail("aborted", "Request aborted.");
	parentSignal?.addEventListener("abort", cancel, { once: true });
	if (parentSignal?.aborted) cancel();
	if (!settled && timeoutMs && timeoutMs > 0) {
		timer = setTimeout(() => fail("error", "Pi Auto Model: target produced no output within the configured timeout."), timeoutMs);
	}
	void (async () => {
		try {
			for await (const event of inner) {
				if (settled) return;
				if (isSubstantive(event)) clearTimeout(timer);
				guarded.push(event);
				if (event.type === "done" || event.type === "error") {
					settled = true;
					cleanup();
					guarded.end(event.type === "done" ? event.message : event.error);
					return;
				}
			}
			if (!settled) {
				settled = true;
				cleanup();
				guarded.end();
			}
		} catch (error) {
			fail(parentSignal?.aborted ? "aborted" : "error", extractErrorText(error));
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
	return (_autoModel, context, options) => {
		const outer = createAssistantMessageEventStream();
		void runFailoverLoop(outer, context, options, deps).catch((error) => {
			ignoreFailure(deps.onInternalError ? () => deps.onInternalError!(error, options?.sessionId) : undefined);
			finishWithError(outer, `Pi Auto Model internal routing failure: ${extractErrorText(error)}`);
		});
		return outer;
	};
}

async function runFailoverLoop(
	outer: AssistantMessageEventStream,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: StreamProxyDeps,
): Promise<void> {
	const plan = deps.getPendingStream(options?.sessionId);
	if (!plan?.targets.length) {
		pushError(outer, "Pi Auto Model: no approved route plan available.");
		return;
	}
	const registry = deps.getRegistry();
	if (!registry) {
		pushError(outer, "Pi Auto Model: model registry not yet initialised.");
		return;
	}
	let lastErrorText = "All targets failed";
	for (const target of plan.targets) {
		if (options?.signal?.aborted) {
			const error = { ...makeErrorMessage("Request aborted."), stopReason: "aborted" as const };
			outer.push({ type: "error", reason: "aborted", error });
			outer.end(error);
			return;
		}
		if (deps.circuits.isOpen(target.id)) continue;
		const provider = registry.getProvider(target.model.provider);
		if (!provider?.streamSimple) continue;
		let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
		try { auth = await registry.getApiKeyAndHeaders(target.model); } catch { continue; }
		if (!auth.ok) continue;
		const probing = deps.circuits.getState(target.id) === "half-open";
		if (probing && !deps.circuits.tryAcquireProbe(target.id)) continue;
		const pending = { ...plan, attemptId: randomUUID(), profile: { ...plan.profile, constraints: {
			...plan.profile.constraints,
			// Reserve against the actual output allowance, not the task-size heuristic.
			requiredOutputTokens: Math.min(options?.maxTokens ?? target.model.maxTokens, target.model.maxTokens),
		} } };
		if (!await allowOnFailure(deps.beforeAttempt ? () => deps.beforeAttempt!(target, pending, context) : undefined)) {
			if (probing) deps.circuits.releaseProbe(target.id);
			lastErrorText = `Pi Auto Model: ${target.id} was blocked by routing policy.`;
			continue;
		}
		const requestModel = auth.baseUrl ? { ...target.model, baseUrl: auth.baseUrl } : target.model;
		const startedAt = Date.now();
		const controller = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		let responseStatus = 0;
		let responseHeaders: Record<string, string> = {};
		let substantive = false;
		let ttftMs: number | undefined;
		let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
		const buffer: AssistantMessageEvent[] = [];
		let committed = false;
		const commit = (): void => {
			if (committed) return;
			committed = true;
			ignoreFailure(deps.onTargetCommitted ? () => deps.onTargetCommitted!(target, pending) : undefined);
		};
		try {
			const inner = provider.streamSimple(requestModel, adaptContext(context, target, plan.apisUsed, plan.prefixToStrip), {
				...options, signal, apiKey: auth.apiKey, env: auth.env,
				headers: { ...auth.headers, ...(options?.headers as Record<string, string>) },
				maxTokens: pending.profile.constraints.requiredOutputTokens,
				reasoning: (plan.thinking === "off" ? undefined : plan.thinking) as SimpleStreamOptions["reasoning"],
				onResponse: async (response) => {
					responseStatus = response.status;
					responseHeaders = response.headers;
					try { await options?.onResponse?.(response, requestModel); } catch {}
					ignoreFailure(deps.onAttemptResponse ? () => deps.onAttemptResponse!(target, response.status, response.headers, pending) : undefined);
				},
			});
			for await (const event of guardStream(inner, plan.firstOutputTimeoutMs, controller, options?.signal)) {
				if (event.type === "done" || event.type === "error") { terminal = event; break; }
				if (isSubstantive(event) && !substantive) {
					substantive = true;
					ttftMs = Date.now() - startedAt;
					commit();
					flushBuffer(outer, buffer);
				}
				if (substantive) outer.push(event);
				else buffer.push(event);
			}
		} catch (error) {
			terminal = { type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: makeErrorMessage(extractErrorText(error)) };
		} finally {
			controller.abort();
			if (probing) deps.circuits.releaseProbe(target.id);
		}
		const success = terminal?.type === "done";
		const aborted = options?.signal?.aborted || (terminal?.type === "error" && terminal.reason === "aborted");
		lastErrorText = terminal?.type === "error" ? extractErrorText(terminal) : "Provider stream ended without a completion event.";
		const status = responseStatus >= 400 ? responseStatus : success ? responseStatus || 200 : 503;
		const classification = classifyDetailedError(status, lastErrorText, substantive);
		const retryable = !success && !aborted && !substantive && classification.retryable;
		if (success || (!aborted && classification.opensCircuit)) deps.circuits.record(target.id, status, Date.now());
		try {
			await deps.onAttemptSettled?.({
				target, status: responseStatus || (success ? 200 : 0), headers: responseHeaders,
				success, retryable, latencyMs: Date.now() - startedAt, ttftMs,
				message: terminal?.type === "done" ? terminal.message : terminal?.error,
			}, pending);
		} catch { /* Keep the reservation when accounting is unavailable. */ }
		if (success) {
			commit();
			flushBuffer(outer, buffer);
			outer.push(terminal!);
			outer.end((terminal as Extract<AssistantMessageEvent, { type: "done" }>).message);
			return;
		}
		if (!retryable) {
			if (substantive) flushBuffer(outer, buffer);
			const error = terminal?.type === "error" ? terminal.error : makeErrorMessage(lastErrorText);
			outer.push({ type: "error", reason: aborted ? "aborted" : "error", error });
			outer.end(error);
			return;
		}
	}
	pushError(outer, lastErrorText);
}

function flushBuffer(outer: AssistantMessageEventStream, buffer: AssistantMessageEvent[]): void {
	for (const event of buffer) {
		outer.push(event);
	}
	buffer.length = 0;
}
