import assert from "node:assert/strict";
import test from "node:test";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	Api,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createStreamProxyHandler,
	type PendingStreamRequest,
	type StreamProxyDeps,
	type AttemptResult,
} from "../src/pi/stream-proxy.ts";
import { CircuitBreaker } from "../src/health/circuit-breaker.ts";
import type { RouteTarget, TaskProfile, ThinkingLevel } from "../src/types.ts";

// ─── Test helpers ───────────────────────────────────────────────

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		api: "test-api",
		name: id,
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 16_000,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

function target(provider: string, id: string): RouteTarget {
	return { model: model(provider, id), id: `${provider}/${id}` };
}

function makeProfile(): TaskProfile {
	return {
		taskId: "test-task",
		kinds: ["explain"],
		complexity: 0.3,
		demand: { coding: 0.3, reasoning: 0.3, toolUse: 0, instructionFollowing: 0.3, context: 0, vision: 0 },
		semantic: { debugging: 0, planning: 0, architecture: 0, review: 0, generation: 0, explanation: 1 },
		risk: 0,
		latencySensitivity: 0.5,
		costSensitivity: 0.5,
		confidence: 0.8,
		constraints: { requiresVision: false, requiredContextTokens: 0, requiredOutputTokens: 1000 },
	};
}

function makePending(targets: RouteTarget[], firstOutputTimeoutMs?: number): PendingStreamRequest {
	return {
		targets,
		thinking: "medium" as ThinkingLevel,
		profile: makeProfile(),
		requestId: "test-req-1",
		sessionId: "test-session",
		estimatedCostUsd: 0.01,
		apisUsed: ["test-api"],
		firstOutputTimeoutMs,
	};
}

/** Creates a stream that emits the given events synchronously then completes. */
function streamFromEvents(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		for (const event of events) {
			stream.push(event);
		}
	});
	return stream;
}

/** Creates a stream that emits an error after receiving the HTTP response. */
function streamFromError(
	events: AssistantMessageEvent[],
	status: number,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		for (const event of events) {
			stream.push(event);
		}
	});
	return stream;
}

/** Creates a stream that emits nothing and never ends (simulates a hung provider). */
function hangStream(): AssistantMessageEventStream {
	return createAssistantMessageEventStream();
}

function startEvent(): AssistantMessageEvent {
	return {
		type: "start",
		partial: { role: "assistant", content: [] } as unknown as AssistantMessage,
	};
}

function textDeltaEvent(text: string): AssistantMessageEvent {
	return {
		type: "text_delta",
		contentIndex: 0,
		delta: text,
		partial: { role: "assistant", content: [{ type: "text", text }] } as unknown as AssistantMessage,
	};
}

function doneEvent(text: string): AssistantMessageEvent {
	return {
		type: "done",
		reason: "stop",
		message: { role: "assistant", content: [{ type: "text", text }] } as unknown as AssistantMessage,
	};
}

function errorEvent(): AssistantMessageEvent {
	return {
		type: "error",
		reason: "error",
		error: { role: "assistant", content: [{ type: "text", text: "stream error" }] } as unknown as AssistantMessage,
	};
}

/** Collects all events from a stream into an array. */
async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

/** A fake registry that returns configurable providers. */
function makeFakeRegistry(providers: Map<string, { streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream }>) {
	return {
		getProvider: (name: string) => providers.get(name),
		getApiKeyAndHeaders: async (_model: Model<Api>) => ({ ok: true as const, apiKey: "test-key", baseUrl: undefined, headers: undefined }),
	};
}

function makeDeps(
	pending: PendingStreamRequest | undefined,
	registry: unknown,
	circuits: CircuitBreaker,
): { deps: StreamProxyDeps; settled: AttemptResult[]; committed: RouteTarget[] } {
	const settled: AttemptResult[] = [];
	const committed: RouteTarget[] = [];
	const deps: StreamProxyDeps = {
		getRegistry: () => registry as never,
		circuits,
		getPendingStream: () => pending,
		onAttemptSettled: (result) => settled.push(result),
		onTargetCommitted: (target) => committed.push(target),
	};
	return { deps, settled, committed };
}

// ─── Tests ──────────────────────────────────────────────────────

test("proxies a successful stream from the first target", async () => {
	const targets = [target("openai", "gpt-5"), target("anthropic", "claude")];
	const pending = makePending(targets);

	const providers = new Map();
	providers.set("openai", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Hello"),
			doneEvent("Hello"),
		]),
	});

	const { deps, settled, committed } = makeDeps(pending, makeFakeRegistry(providers), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	assert.ok(events.some((e) => e.type === "done"));
	assert.ok(events.some((e) => e.type === "text_delta"));
	assert.equal(committed.length, 1);
	assert.equal(committed[0].id, "openai/gpt-5");
	assert.equal(settled.length, 1);
	assert.equal(settled[0].success, true);
});

test("reuses the route plan for later tool-loop model turns", async () => {
	const targets = [target("openai", "gpt-5")];
	const providers = new Map();
	providers.set("openai", {
		streamSimple: () => streamFromEvents([startEvent(), textDeltaEvent("ok"), doneEvent("ok")]),
	});
	const { deps } = makeDeps(makePending(targets), makeFakeRegistry(providers), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);

	const first = await collectEvents(handler(model("pi-auto-model", "auto"), { messages: [] } as Context));
	const second = await collectEvents(handler(model("pi-auto-model", "auto"), { messages: [] } as Context));

	assert.ok(first.some((event) => event.type === "done"));
	assert.ok(second.some((event) => event.type === "done"));
});

test("ignores routing telemetry failures while preserving a successful response", async () => {
	const providers = new Map();
	providers.set("openai", {
		streamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onResponse?.({ status: 200, headers: {} }, _model);
				stream.push(startEvent());
				stream.push(textDeltaEvent("ok"));
				stream.push(doneEvent("ok"));
			});
			return stream;
		},
	});
	const { deps } = makeDeps(makePending([target("openai", "gpt-5")]), makeFakeRegistry(providers), new CircuitBreaker());
	deps.beforeAttempt = () => { throw new Error("budget unavailable"); };
	deps.onAttemptResponse = () => { throw new Error("quota unavailable"); };
	deps.onAttemptSettled = () => { throw new Error("metrics unavailable"); };
	deps.onTargetCommitted = () => { throw new Error("state unavailable"); };

	const events = await collectEvents(createStreamProxyHandler(deps)(
		model("pi-auto-model", "auto"),
		{ messages: [] } as Context,
		{ onResponse: () => { throw new Error("caller telemetry unavailable"); } },
	));

	assert.ok(events.some((event) => event.type === "done"));
	assert.ok(events.every((event) => event.type !== "error"));
});

test("uses an authenticated emergency model when the router itself throws", async () => {
	const emergencyModel = model("openai", "gpt-5");
	let internalErrors = 0;
	const provider = {
		streamSimple: () => streamFromEvents([startEvent(), textDeltaEvent("emergency"), doneEvent("emergency")]),
	};
	const deps: StreamProxyDeps = {
		getRegistry: () => ({
			getAvailable: () => [emergencyModel],
			getProvider: () => provider,
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
		}) as never,
		circuits: new CircuitBreaker(),
		getPendingStream: () => { throw new Error("corrupt route state"); },
		onInternalError: () => { internalErrors++; },
	};

	const events = await collectEvents(createStreamProxyHandler(deps)(model("pi-auto-model", "auto"), { messages: [] } as Context));

	assert.ok(events.some((event) => event.type === "done"));
	assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "emergency"));
	assert.equal(internalErrors, 1);
});

test("does not leak a failed emergency attempt into the fallback response", async () => {
	const first = model("first", "broken");
	const second = model("second", "working");
	const deps: StreamProxyDeps = {
		getRegistry: () => ({
			getAvailable: () => [first, second],
			getProvider: (provider: string) => ({
				streamSimple: () => provider === "first"
					? streamFromEvents([startEvent(), errorEvent()])
					: streamFromEvents([startEvent(), textDeltaEvent("recovered"), doneEvent("recovered")]),
			}),
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
		}) as never,
		circuits: new CircuitBreaker(),
		getPendingStream: () => { throw new Error("corrupt route state"); },
	};

	const events = await collectEvents(createStreamProxyHandler(deps)(model("pi-auto-model", "auto"), { messages: [] } as Context));

	assert.equal(events.filter((event) => event.type === "start").length, 1);
	assert.ok(events.some((event) => event.type === "text_delta" && event.delta === "recovered"));
	assert.ok(events.every((event) => event.type !== "error"));
});

test("resolves concurrent streams by session id", async () => {
	const plans = new Map([
		["s1", makePending([target("openai", "gpt-5")])],
		["s2", { ...makePending([target("anthropic", "claude")]), sessionId: "s2" }],
	]);
	const providers = new Map();
	providers.set("openai", { streamSimple: () => streamFromEvents([textDeltaEvent("one"), doneEvent("one")]) });
	providers.set("anthropic", { streamSimple: () => streamFromEvents([textDeltaEvent("two"), doneEvent("two")]) });
	const { deps } = makeDeps(undefined, makeFakeRegistry(providers), new CircuitBreaker());
	deps.getPendingStream = (sessionId) => plans.get(sessionId ?? "");
	const handler = createStreamProxyHandler(deps);

	const [one, two] = await Promise.all([
		collectEvents(handler(model("pi-auto-model", "auto"), { messages: [] } as Context, { sessionId: "s1" })),
		collectEvents(handler(model("pi-auto-model", "auto"), { messages: [] } as Context, { sessionId: "s2" })),
	]);

	assert.ok(one.some((event) => event.type === "text_delta" && event.delta === "one"));
	assert.ok(two.some((event) => event.type === "text_delta" && event.delta === "two"));
});

test("skips a target blocked before an attempt", async () => {
	const targets = [target("openai", "gpt-5"), target("anthropic", "claude")];
	const providers = new Map();
	providers.set("openai", { streamSimple: () => streamFromEvents([doneEvent("wrong")]) });
	providers.set("anthropic", { streamSimple: () => streamFromEvents([doneEvent("ok")]) });
	const { deps, committed } = makeDeps(makePending(targets), makeFakeRegistry(providers), new CircuitBreaker());
	deps.beforeAttempt = (candidate) => candidate.id !== "openai/gpt-5";

	await collectEvents(createStreamProxyHandler(deps)(model("pi-auto-model", "auto"), { messages: [] } as Context));

	assert.equal(committed[0]?.id, "anthropic/claude");
});

test("fails over to the second target when the first errors before substantive output", async () => {
	const targets = [target("openai", "gpt-5"), target("anthropic", "claude")];
	const pending = makePending(targets);

	const providers = new Map();
	providers.set("openai", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			errorEvent(),
		]),
	});
	providers.set("anthropic", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Hello from Claude"),
			doneEvent("Hello from Claude"),
		]),
	});

	const { deps, settled, committed } = makeDeps(pending, makeFakeRegistry(providers), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	// The user should only see the second target's output.
	assert.ok(events.some((e) => e.type === "done"));
	assert.ok(events.every((e) => e.type !== "text_delta" && e.type !== "text_end" || (e.type === "text_delta" && e.delta === "Hello from Claude")));
	assert.equal(committed.length, 1);
	assert.equal(committed[0].id, "anthropic/claude");
	// First attempt failed, second succeeded.
	assert.equal(settled.length, 2);
	assert.equal(settled[0].success, false);
	assert.equal(settled[0].retryable, true);
	assert.equal(settled[1].success, true);
});

test("does not fail over after substantive output has been flushed", async () => {
	const targets = [target("openai", "gpt-5"), target("anthropic", "claude")];
	const pending = makePending(targets);

	const providers = new Map();
	providers.set("openai", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Partial answer"),
			errorEvent(),
		]),
	});
	providers.set("anthropic", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Should not be seen"),
			doneEvent("Should not be seen"),
		]),
	});

	const { deps, settled, committed } = makeDeps(pending, makeFakeRegistry(providers), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	// The user sees the first target's partial output then the error.
	assert.ok(events.some((e) => e.type === "text_delta" && e.delta === "Partial answer"));
	assert.ok(events.some((e) => e.type === "error"));
	// Only the first target was committed; no failover.
	assert.equal(committed.length, 1);
	assert.equal(committed[0].id, "openai/gpt-5");
	assert.equal(settled.length, 1);
	assert.equal(settled[0].success, false);
	assert.equal(settled[0].retryable, false);
});

test("returns an error stream when all targets fail", async () => {
	const targets = [target("openai", "gpt-5"), target("anthropic", "claude")];
	const pending = makePending(targets);

	const providers = new Map();
	providers.set("openai", {
		streamSimple: () => streamFromEvents([startEvent(), errorEvent()]),
	});
	providers.set("anthropic", {
		streamSimple: () => streamFromEvents([startEvent(), errorEvent()]),
	});

	const { deps, settled } = makeDeps(pending, makeFakeRegistry(providers), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	assert.ok(events.some((e) => e.type === "error"));
	assert.equal(settled.length, 2);
	assert.equal(settled[0].success, false);
	assert.equal(settled[1].success, false);
});

test("returns an error stream when no pending request exists", async () => {
	const { deps } = makeDeps(undefined, makeFakeRegistry(new Map()), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	assert.ok(events.some((e) => e.type === "error"));
});

test("records circuit breaker entries for failed attempts", async () => {
	const targets = [target("openai", "gpt-5")];
	const pending = makePending(targets);
	const circuits = new CircuitBreaker();

	const providers = new Map();
	let capturedStatus = 503;
	providers.set("openai", {
		streamSimple: (_model: Model<Api>, _ctx: Context, opts?: SimpleStreamOptions) => {
			// Simulate an HTTP error response callback then stream error.
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				opts?.onResponse?.({ status: capturedStatus, headers: {} }, _model);
				stream.push(startEvent());
				stream.push(errorEvent());
			});
			return stream;
		},
	});

	const { deps } = makeDeps(pending, makeFakeRegistry(providers), circuits);
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	await collectEvents(stream);

	assert.equal(circuits.isOpen("openai/gpt-5"), true);
});

test("skips targets without a provider streamSimple", async () => {
	const targets = [target("unknown", "no-stream"), target("openai", "gpt-5")];
	const pending = makePending(targets);

	const providers = new Map();
	providers.set("openai", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Hello"),
			doneEvent("Hello"),
		]),
	});

	const { deps, committed } = makeDeps(pending, makeFakeRegistry(providers), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	assert.ok(events.some((e) => e.type === "done"));
	assert.equal(committed[0].id, "openai/gpt-5");
});

test("skips targets without configured auth", async () => {
	const targets = [target("noauth", "model-a"), target("openai", "gpt-5")];
	const pending = makePending(targets);

	const providers = new Map();
	providers.set("openai", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Hello"),
			doneEvent("Hello"),
		]),
	});

	const registry = {
		getProvider: (name: string) => providers.get(name),
		getApiKeyAndHeaders: async (m: Model<Api>) =>
			m.provider === "noauth"
				? { ok: false as const, error: "no auth" }
				: { ok: true as const, apiKey: "key", baseUrl: undefined, headers: undefined },
	};

	const { deps, committed } = makeDeps(pending, registry, new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	assert.ok(events.some((e) => e.type === "done"));
	assert.equal(committed[0].id, "openai/gpt-5");
});

test("fails over on Gemini signature 400 without opening the circuit", async () => {
	const targets = [target("google", "gemini-2.5-pro"), target("anthropic", "claude")];
	const pending = makePending(targets);
	const circuits = new CircuitBreaker();

	const providers = new Map();
	providers.set("google", {
		streamSimple: (_m: Model<Api>, _ctx: Context, opts?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				opts?.onResponse?.({ status: 400, headers: {} }, _m);
				stream.push(startEvent());
				stream.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [{ type: "text", text: "thought_signature mismatch in request" }],
					} as unknown as AssistantMessage,
				});
			});
			return stream;
		},
	});
	providers.set("anthropic", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Hello from Claude"),
			doneEvent("Hello from Claude"),
		]),
	});

	const { deps, settled, committed } = makeDeps(pending, makeFakeRegistry(providers), circuits);
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	// Failover succeeded to the second target.
	assert.ok(events.some((e) => e.type === "done"));
	assert.equal(committed.length, 1);
	assert.equal(committed[0].id, "anthropic/claude");
	// First attempt failed and was retryable (signature error).
	assert.equal(settled.length, 2);
	assert.equal(settled[0].success, false);
	assert.equal(settled[0].retryable, true);
	// Circuit should NOT be open for the Gemini target (signature error).
	assert.equal(circuits.isOpen("google/gemini-2.5-pro"), false);
});

test("opens circuit for non-signature 5xx but still fails over", async () => {
	const targets = [target("openai", "gpt-5"), target("anthropic", "claude")];
	const pending = makePending(targets);
	const circuits = new CircuitBreaker();

	const providers = new Map();
	providers.set("openai", {
		streamSimple: (_m: Model<Api>, _ctx: Context, opts?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				opts?.onResponse?.({ status: 503, headers: {} }, _m);
				stream.push(startEvent());
				stream.push(errorEvent());
			});
			return stream;
		},
	});
	providers.set("anthropic", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Hello from Claude"),
			doneEvent("Hello from Claude"),
		]),
	});

	const { deps, settled } = makeDeps(pending, makeFakeRegistry(providers), circuits);
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	await collectEvents(stream);

	// Circuit should be open for the OpenAI target (5xx error).
	assert.equal(circuits.isOpen("openai/gpt-5"), true);
	assert.equal(settled.length, 2);
	assert.equal(settled[0].success, false);
	assert.equal(settled[0].retryable, true);
});

test("closes circuit on successful probe after half-open transition", async () => {
	const targets = [target("openai", "gpt-5")];
	const pending = makePending(targets);
	const circuits = new CircuitBreaker();

	// Pre-open the circuit.
	circuits.record("openai/gpt-5", 503, 1_000);
	// Expire cooldown → half-open.
	circuits.isOpen("openai/gpt-5", 61_000);
	assert.equal(circuits.getState("openai/gpt-5", 61_000), "half-open");

	const providers = new Map();
	providers.set("openai", {
		streamSimple: (_m: Model<Api>, _ctx: Context, opts?: SimpleStreamOptions) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				opts?.onResponse?.({ status: 200, headers: {} }, _m);
				stream.push(startEvent());
				stream.push(textDeltaEvent("Hello"));
				stream.push(doneEvent("Hello"));
			});
			return stream;
		},
	});

	const { deps, settled } = makeDeps(pending, makeFakeRegistry(providers), circuits);
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	await collectEvents(stream);

	// Probe succeeded → circuit closed.
	assert.equal(circuits.getState("openai/gpt-5"), "closed");
	assert.equal(settled.length, 1);
	assert.equal(settled[0].success, true);
});

test("fails over when a target produces nothing before the first-output timeout", async () => {
	const targets = [target("openai", "gpt-5"), target("anthropic", "claude")];
	const pending = makePending(targets, 40);

	let timedOutSignal: AbortSignal | undefined;
	const providers = new Map();
	providers.set("openai", {
		streamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
			timedOutSignal = options?.signal;
			return hangStream();
		},
	});
	providers.set("anthropic", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Hello from Claude"),
			doneEvent("Hello from Claude"),
		]),
	});

	const { deps, settled, committed } = makeDeps(pending, makeFakeRegistry(providers), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	// The hung attempt is skipped and the second target completes.
	assert.ok(events.some((e) => e.type === "done"));
	assert.ok(events.every((e) => e.type !== "error"));
	assert.equal(committed.length, 1);
	assert.equal(committed[0].id, "anthropic/claude");
	assert.equal(settled.length, 2);
	assert.equal(settled[0].success, false);
	assert.equal(settled[0].retryable, true);
	assert.equal(settled[1].success, true);
	assert.equal(timedOutSignal?.aborted, true);
});

test("applies auth baseUrl and preserves the caller response hook", async () => {
	const targets = [target("openai", "gpt-5")];
	const pending = makePending(targets);
	let requestBaseUrl: string | undefined;
	let responseCalls = 0;
	const providers = new Map();
	providers.set("openai", {
		streamSimple: (requestModel: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
			requestBaseUrl = requestModel.baseUrl;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onResponse?.({ status: 200, headers: { "x-test": "ok" } }, requestModel);
				stream.push(startEvent());
				stream.push(doneEvent("ok"));
			});
			return stream;
		},
	});
	const registry = {
		getProvider: (name: string) => providers.get(name),
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key", baseUrl: "https://oauth.example/v1" }),
	};
	const { deps } = makeDeps(pending, registry, new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	await collectEvents(handler(model("pi-auto-model", "auto"), { messages: [] } as Context, {
		onResponse: () => { responseCalls++; },
	}));
	assert.equal(requestBaseUrl, "https://oauth.example/v1");
	assert.equal(responseCalls, 1);
});

test("does not fail over once output arrives before the first-output timeout", async () => {
	const targets = [target("openai", "gpt-5"), target("anthropic", "claude")];
	const pending = makePending(targets, 200);

	const providers = new Map();
	providers.set("openai", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Fast answer"),
			doneEvent("Fast answer"),
		]),
	});
	providers.set("anthropic", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Should not be seen"),
			doneEvent("Should not be seen"),
		]),
	});

	const { deps, settled, committed } = makeDeps(pending, makeFakeRegistry(providers), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	assert.ok(events.some((e) => e.type === "done"));
	assert.equal(committed.length, 1);
	assert.equal(committed[0].id, "openai/gpt-5");
	assert.equal(settled.length, 1);
	assert.equal(settled[0].success, true);
});

test("returns an error stream when every target times out", async () => {
	const targets = [target("openai", "gpt-5"), target("anthropic", "claude")];
	const pending = makePending(targets, 40);

	const providers = new Map();
	providers.set("openai", { streamSimple: () => hangStream() });
	providers.set("anthropic", { streamSimple: () => hangStream() });

	const { deps, settled } = makeDeps(pending, makeFakeRegistry(providers), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	assert.ok(events.some((e) => e.type === "error"));
	assert.equal(settled.length, 2);
	assert.ok(settled.every((result) => !result.success));
});

test("ignores the first-output timeout when it is not configured", async () => {
	const targets = [target("openai", "gpt-5")];
	const pending = makePending(targets);

	const providers = new Map();
	providers.set("openai", {
		streamSimple: () => streamFromEvents([
			startEvent(),
			textDeltaEvent("Hello"),
			doneEvent("Hello"),
		]),
	});

	const { deps, settled, committed } = makeDeps(pending, makeFakeRegistry(providers), new CircuitBreaker());
	const handler = createStreamProxyHandler(deps);
	const stream = handler(model("pi-auto-model", "auto"), { messages: [] } as Context);
	const events = await collectEvents(stream);

	assert.ok(events.some((e) => e.type === "done"));
	assert.equal(committed.length, 1);
	assert.equal(committed[0].id, "openai/gpt-5");
	assert.equal(settled[0].success, true);
});
