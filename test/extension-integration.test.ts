import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import autoModel from "../extensions/auto-model.ts";

type Handler = (event: any, ctx: any) => Promise<void> | void;

function model(provider: string, id: string, inputCost: number): Model<any> {
	return {
		provider,
		id,
		api: "test-api",
		name: id,
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 16_000,
		cost: { input: inputCost, output: inputCost, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
}

class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>();
	readonly providerConfigs = new Map<string, { streamSimple?: (...args: unknown[]) => AssistantMessageEventStream }>();
	readonly notifications: string[] = [];
	private context!: FakeContext;
	private readonly models: Model<any>[];

	constructor(models: Model<any>[]) {
		this.models = models;
	}

	bindContext(context: FakeContext): void {
		this.context = context;
	}

	on(event: string, handler: Handler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	registerCommand(name: string, options: { handler: (args: string, ctx: FakeContext) => Promise<void> }): void {
		this.commands.set(name, options);
	}

	registerProvider(_name: string, config: { models?: Array<{ id: string; name: string }>; streamSimple?: (...args: unknown[]) => AssistantMessageEventStream }): void {
		this.providerConfigs.set(_name, config);
		for (const entry of config.models ?? []) {
			if (!this.models.some((candidate) => candidate.provider === "pi-auto-model" && candidate.id === entry.id)) {
				this.models.push(model("pi-auto-model", entry.id, 0));
			}
		}
	}

	async setModel(next: Model<any>): Promise<boolean> {
		this.context.model = next;
		return true;
	}

	setThinkingLevel(_level: string): void {}
	appendEntry(): void {}

	async emit(event: string, payload: unknown, ctx: FakeContext): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}
}

class FakeContext {
	model: Model<any>;
	readonly notifications: string[] = [];
	readonly status = new Map<string, string | undefined>();
	readonly sessionManager = { getSessionId: () => "integration-session" };
	readonly modelRegistry = {
		getAvailable: () => this.models,
		find: (provider: string, id: string) => this.models.find((candidate) => candidate.provider === provider && candidate.id === id),
		hasConfiguredAuth: (_model: Model<any>) => true,
		getProvider: (name: string) => this.providers.get(name),
		getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key", baseUrl: undefined, headers: undefined }),
	};
	readonly scopedModels: Array<{ model: Model<any> }>;
	readonly cwd: string;
	readonly providers = new Map<string, { streamSimple: (...args: unknown[]) => AssistantMessageEventStream }>();
	private readonly models: Model<any>[];

	constructor(models: Model<any>[], cwd: string, initial: Model<any>) {
		this.models = models;
		this.cwd = cwd;
		this.model = initial;
		this.scopedModels = models.map((candidate) => ({ model: candidate }));
	}

	isProjectTrusted(): boolean {
		return false;
	}

	getContextUsage(): { tokens: number; contextWindow: number } {
		return { tokens: 0, contextWindow: 200_000 };
	}

	ui = {
		notify: (message: string) => {
			this.notifications.push(message);
		},
		setStatus: (key: string, value: string | undefined) => {
			this.status.set(key, value);
		},
	};
}

async function setup(config: object = {}, initialTargetId = "pi-auto-model/auto"): Promise<{
	pi: FakePi;
	ctx: FakeContext;
	root: string;
	restore: () => void;
}> {	const root = await mkdtemp(join(tmpdir(), "pi-auto-model-integration-"));
	const agentDir = join(root, ".pi", "agent");
	await writeFile(join(agentDir, "auto-model.json"), JSON.stringify(config), "utf8").catch(async () => {
		await import("node:fs/promises").then(({ mkdir }) => mkdir(agentDir, { recursive: true }));
		await writeFile(join(agentDir, "auto-model.json"), JSON.stringify(config), "utf8");
	});
	const candidates = [
		model("pi-auto-model", "auto", 0),
		model("openai", "gpt-5", 1),
		model("anthropic", "claude-sonnet", 3),
	];
	const initial = candidates.find((candidate) => `${candidate.provider}/${candidate.id}` === initialTargetId) ?? candidates[0];
	const ctx = new FakeContext(candidates, root, initial);
	const pi = new FakePi(candidates);
	pi.bindContext(ctx);
	const previousUserProfile = process.env.USERPROFILE;
	process.env.USERPROFILE = root;
	autoModel(pi as never);
	return {
		pi,
		ctx,
		root,
		restore: () => {
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		},
	};
}

test("runs the request lifecycle and exports correlated quota events", async () => {
	const fixture = await setup({
		quota: {
			enabled: true,
			windowMs: 86_400_000,
			staleAfterMs: 60_000,
			providers: { openai: { maxRequests: 10 } },
		},
	});
	try {
		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		await fixture.pi.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "Explain this function",
			systemPrompt: "",
			systemPromptOptions: {},
		}, fixture.ctx);
		assert.ok(fixture.ctx.notifications.some((m) => m.includes("Pi Auto Model →")));

		await fixture.pi.emit("after_provider_response", {
			type: "after_provider_response",
			status: 200,
			headers: {
				"x-ratelimit-limit-requests": "10",
				"x-ratelimit-remaining-requests": "5",
			},
		}, fixture.ctx);
		await fixture.pi.emit("agent_settled", { type: "agent_settled" }, fixture.ctx);

		const command = fixture.pi.commands.get("auto-model");
		assert.ok(command);
		await command.handler("export json", fixture.ctx);
		const exportNotice = fixture.ctx.notifications.find((message) => message.includes("events-export-"));
		assert.ok(exportNotice);
		const exportPath = exportNotice!.match(/to (.+)$/)?.[1];
		assert.ok(exportPath);
		const events = JSON.parse(await readFile(exportPath!, "utf8")) as Array<{ kind: string; requestId?: string }>;
		const requestIds = new Set(events.map((event) => event.requestId).filter(Boolean));
		assert.ok(events.some((event) => event.kind === "request"));
		assert.ok(events.some((event) => event.kind === "route_decision"));
		assert.ok(events.some((event) => event.kind === "quota_observation"));
		assert.ok(events.some((event) => event.kind === "provider_response"));
		assert.ok(requestIds.size >= 1);
	} finally {
		fixture.restore();
	}
});

test("blocks a task before changing the current model when budget is exceeded", async () => {
	const fixture = await setup({
		budget: {
			maxUsdPerTask: 0.000001,
			onExceed: "block",
		},
	});
	try {
		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		await fixture.pi.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "Explain this function",
			systemPrompt: "",
			systemPromptOptions: {},
		}, fixture.ctx);
		assert.equal(fixture.ctx.model.provider, "pi-auto-model");
		assert.ok(fixture.ctx.notifications.some((message) => message.includes("budget exceeded")));
	} finally {
		fixture.restore();
	}
});

test("fails over on the next task for 429 without treating 400 as provider health failure", async () => {
	const fixture = await setup();
	try {
		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		await fixture.pi.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "Explain this function",
			systemPrompt: "",
			systemPromptOptions: {},
		}, fixture.ctx);
		const firstRoute = fixture.ctx.notifications.find((m) => m.includes("Pi Auto Model →"));
		const firstTarget = firstRoute?.match(/Pi Auto Model → (\S+)/)?.[1]?.split("/", 1)[0];
		assert.ok(firstTarget);

		await fixture.pi.emit("after_provider_response", {
			type: "after_provider_response",
			status: 429,
			headers: { "retry-after": "60" },
		}, fixture.ctx);
		await fixture.pi.emit("agent_settled", { type: "agent_settled" }, fixture.ctx);
		await fixture.pi.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "Try the same explanation again",
			systemPrompt: "",
			systemPromptOptions: {},
		}, fixture.ctx);
		const secondRoute = [...fixture.ctx.notifications].reverse().find((m) => m.includes("Pi Auto Model →"));
		const secondTarget = secondRoute?.match(/Pi Auto Model → (\S+)/)?.[1]?.split("/", 1)[0];
		assert.ok(secondTarget);
		assert.notEqual(secondTarget, firstTarget);

		await fixture.pi.emit("after_provider_response", {
			type: "after_provider_response",
			status: 400,
			headers: {},
		}, fixture.ctx);
		await fixture.pi.emit("agent_settled", { type: "agent_settled" }, fixture.ctx);
		const doctor = fixture.pi.commands.get("auto-model");
		assert.ok(doctor);
		await doctor.handler("doctor", fixture.ctx);
		const doctorOutput = fixture.ctx.notifications.at(-1) ?? "";
		assert.match(doctorOutput, new RegExp(`${secondTarget}.*circuit closed`));
	} finally {
		fixture.restore();
	}
});

test("only honors inline prefixes on the first user prompt", async () => {
	const fixture = await setup();
	try {
		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		await fixture.pi.emit("before_agent_start", {
			type: "before_agent_start", prompt: "Explain this", systemPrompt: "", systemPromptOptions: {},
		}, fixture.ctx);
		await fixture.pi.emit("agent_settled", { type: "agent_settled" }, fixture.ctx);
		await fixture.pi.emit("before_agent_start", {
			type: "before_agent_start", prompt: "@ultra Explain this again", systemPrompt: "", systemPromptOptions: {},
		}, fixture.ctx);
		const latest = [...fixture.ctx.notifications].reverse().find((message) => message.includes("Pi Auto Model →")) ?? "";
		assert.doesNotMatch(latest, /prefix @ultra/);
	} finally {
		fixture.restore();
	}
});

test("shadow mode records the automatic choice but keeps the current real target", async () => {
	const fixture = await setup({ shadow: { enabled: true } }, "anthropic/claude-sonnet");
	try {
		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		await fixture.pi.emit("before_agent_start", {
			type: "before_agent_start", prompt: "Explain this", systemPrompt: "", systemPromptOptions: {},
		}, fixture.ctx);
		const latest = [...fixture.ctx.notifications].reverse().find((message) => message.includes("Pi Auto Model →")) ?? "";
		assert.match(latest, /anthropic\/claude-sonnet/);
		assert.match(latest, /would select openai\/gpt-5/);
	} finally {
		fixture.restore();
	}
});

// ─── Stream helpers for the fail-safe integration test ─────────

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

function streamFromEvents(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		for (const event of events) {
			stream.push(event);
		}
	});
	return stream;
}

async function collectEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

test("falls back to a working model so routing failures never block the user request", async () => {
	// The configured pool explicitly excludes every real model, which forces
	// the routing pipeline to refuse producing a plan.
	const fixture = await setup({
		pool: "empty",
		pools: {
			empty: { targets: [{ id: "no-such/model", weight: 1 }] },
		},
	});
	// Emulate real providers so the virtual auto model can proxy the request.
	for (const [provider, id] of [["openai", "gpt-5"], ["anthropic", "claude-sonnet"]] as const) {
		fixture.ctx.providers.set(provider, {
			streamSimple: () => streamFromEvents([
				startEvent(),
				textDeltaEvent(`answered by ${id}`),
				doneEvent(`answered by ${id}`),
			]),
		});
	}
	const virtual = fixture.pi.providerConfigs.get("pi-auto-model");
	assert.ok(virtual?.streamSimple, "virtual auto provider must be registered");
	try {
		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		await fixture.pi.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "Explain this function",
			systemPrompt: "",
			systemPromptOptions: {},
		}, fixture.ctx);

		// The user is told the pool refused and that a fallback was used.
		assert.ok(fixture.ctx.notifications.some((message) => message.includes("no eligible target")));
		assert.ok(fixture.ctx.notifications.some((message) => message.includes("fell back to")));

		// The request still runs end-to-end through a real provider.
		const events = await collectEvents(
			virtual.streamSimple!(fixture.ctx.model, { messages: [] }, {}),
		);
		const toolLoopEvents = await collectEvents(
			virtual.streamSimple!(fixture.ctx.model, { messages: [] }, {}),
		);
		assert.ok(events.some((event) => event.type === "done"));
		assert.ok(toolLoopEvents.some((event) => event.type === "done"));
		assert.ok(events.every((event) => event.type !== "error"));
	} finally {
		fixture.restore();
	}
});
