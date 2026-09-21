import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { refineWithClassifier } from "../src/task/classifier.ts";
import { analyzeTask } from "../src/task/local-analyzer.ts";

type Handler = (event: any, ctx: any) => any;

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
	readonly commands = new Map<string, {
		handler: (args: string, ctx: FakeContext) => Promise<void>;
		getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	}>();
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

	registerCommand(name: string, options: {
		handler: (args: string, ctx: FakeContext) => Promise<void>;
		getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	}): void {
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

	async emit(event: string, payload: unknown, ctx: FakeContext): Promise<any> {
		let result;
		for (const handler of this.handlers.get(event) ?? []) {
			result = await handler(payload, ctx) ?? result;
		}
		return result;
	}
}

class FakeContext {
	model: Model<any>;
	readonly notifications: string[] = [];
	readonly status = new Map<string, string | undefined>();
	readonly selectCalls: Array<{ title: string; options: string[] }> = [];
	readonly selectResults: string[] = [];
	hasUI = true;
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
		select: async (title: string, options: string[]) => {
			this.selectCalls.push({ title, options });
			return this.selectResults.shift();
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

test("completes sub-command arguments without replacing the sub-command", async () => {
	const fixture = await setup();
	try {
		const completions = fixture.pi.commands.get("auto-model")?.getArgumentCompletions;
		assert.ok(completions);
		// Partial subcommands still complete. An exact subcommand returns itself
		// as the sole suggestion — this keeps Pi's autocomplete popup open so that
		// typing a space refreshes it with the argument options (returning null
		// would close the popup, and Pi does not re-trigger on space input).
		assert.deepEqual(completions("mod")?.map((item) => item.value), ["models", "mode"]);
		assert.deepEqual(completions("mode")?.map((item) => item.value), ["mode"]);
		// After a space, only the sub-command's values are suggested, and the
		// returned value carries the sub-command so accepting it never
		// replaces "mode" with a different command.
		const policies = completions("mode bal");
		assert.ok(policies);
		assert.equal(policies.length, 1);
		assert.equal(policies[0].value, "mode balanced");
		assert.equal(policies[0].label, "balanced");
		assert.equal(completions("mode cost")?.[0].value, "mode cost");
		assert.equal(completions("mode ")?.length, 4);
		assert.equal(completions("thinking fixed med")?.[0].value, "thinking fixed medium");
		assert.equal(completions("thinking pi")?.[0].value, "thinking pi");
		assert.equal(completions("feedback go")?.[0].value, "feedback good");
		assert.equal(completions("export json")?.[0].value, "export json");
		assert.equal(completions("status x"), null);
	} finally {
		fixture.restore();
	}
});

test("opens a policy chooser when mode runs without an argument", async () => {
	const fixture = await setup();
	try {
		fixture.ctx.selectResults.push("cost");
		await fixture.pi.commands.get("auto-model")!.handler("mode", fixture.ctx);
		assert.deepEqual(fixture.ctx.selectCalls, [{
			title: "Select Pi Auto Model policy",
			options: ["balanced", "best", "cost", "fast"],
		}]);
		const output = fixture.ctx.notifications.at(-1) ?? "";
		assert.match(output, /policy: cost/);
		const config = JSON.parse(await readFile(join(fixture.root, ".pi/agent/auto-model.json"), "utf8"));
		assert.equal(config.policy, "cost");
	} finally {
		fixture.restore();
	}
});

test("cancelling the policy chooser leaves mode unchanged without a usage warning", async () => {
	const fixture = await setup();
	try {
		await fixture.pi.commands.get("auto-model")!.handler("mode", fixture.ctx);
		assert.deepEqual(fixture.ctx.selectCalls, [{
			title: "Select Pi Auto Model policy",
			options: ["balanced", "best", "cost", "fast"],
		}]);
		assert.equal(fixture.ctx.notifications.length, 0);
	} finally {
		fixture.restore();
	}
});

test("walks through choosers when thinking runs without an argument", async () => {
	const fixture = await setup();
	try {
		fixture.ctx.selectResults.push("fixed", "high");
		await fixture.pi.commands.get("auto-model")!.handler("thinking", fixture.ctx);
		assert.deepEqual(fixture.ctx.selectCalls, [{
			title: "Pi Auto Model thinking mode",
			options: ["auto", "pi", "fixed"],
		}, {
			title: "Fixed thinking level",
			options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		}]);
		const output = fixture.ctx.notifications.at(-1) ?? "";
		assert.match(output, /thinking level: high/);
	} finally {
		fixture.restore();
	}
});

test("keeps the typed-argument path and falls back to usage without a chooser UI", async () => {
	const fixture = await setup();
	try {
		const command = fixture.pi.commands.get("auto-model")!;
		await command.handler("thinking fixed low", fixture.ctx);
		assert.equal(fixture.ctx.selectCalls.length, 0);
		assert.match(fixture.ctx.notifications.at(-1) ?? "", /thinking level: low/);
		fixture.ctx.hasUI = false;
		await command.handler("mode", fixture.ctx);
		assert.equal(fixture.ctx.selectCalls.length, 0);
		assert.match(fixture.ctx.notifications.at(-1) ?? "", /Usage: \/auto-model mode/);
	} finally {
		fixture.restore();
	}
});

test("persists mode changes as the global default", async () => {
	const fixture = await setup({ aliases: { "a/b": "c/d" } });
	try {
		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		await fixture.pi.commands.get("auto-model")!.handler("mode cost", fixture.ctx);
		const config = JSON.parse(await readFile(join(fixture.root, ".pi/agent/auto-model.json"), "utf8"));
		assert.equal(config.policy, "cost");
		assert.equal(config.aliases["a/b"], "c/d");
	} finally {
		fixture.restore();
	}
});

test("shows local budget periods and only spend from the last 24 hours", async () => {
	const fixture = await setup();
	try {
		const now = Date.now();
		const date = new Date(now);
		const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
		const budgetDir = join(fixture.root, ".pi/agent/auto-model");
		await mkdir(budgetDir, { recursive: true });
		await writeFile(join(budgetDir, "budget.json"), JSON.stringify({
			version: 1,
			updatedAt: now,
			usage: {
				dayKey: `${monthKey}-${String(date.getDate()).padStart(2, "0")}`,
				monthKey,
				dailyUsd: 0.02,
				monthlyUsd: 0.03,
				providers: { openai: { dailyUsd: 0.02, monthlyUsd: 0.03 } },
				history: [
					{ startAt: now - 48 * 3_600_000, usd: 0.01, providers: { openai: 0.01 } },
					{ startAt: now - 3_600_000, usd: 0.02, providers: { openai: 0.02 } },
				],
			},
		}), "utf8");

		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		await fixture.pi.commands.get("auto-model")!.handler("budget", fixture.ctx);
		const output = fixture.ctx.notifications.at(-1) ?? "";
		assert.match(output, /Estimated local spend/);
		assert.match(output, /Spend by active hour \(last 24h, local time\):[\s\S]*\$0\.0200/);
		assert.doesNotMatch(output, /\$0\.0100/);
	} finally {
		fixture.restore();
	}
});

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
		for (const provider of ["openai", "anthropic"]) fixture.ctx.providers.set(provider, {
			streamSimple: (model, _context, options: any) => {
				void options.onResponse({ status: 200, headers: { "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "5" } }, model);
				const done = doneEvent("done") as Extract<AssistantMessageEvent, { type: "done" }>;
				done.message.usage = { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 180,
					cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } };
				return streamFromEvents([done]);
			},
		});
		await dispatch(fixture);

		await fixture.pi.emit("after_provider_response", {
			type: "after_provider_response",
			status: 200,
			headers: {
				"x-ratelimit-limit-requests": "10",
				"x-ratelimit-remaining-requests": "5",
			},
		}, fixture.ctx);
		await fixture.pi.emit("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: {
					input: 100,
					output: 20,
					cacheRead: 50,
					cacheWrite: 10,
					totalTokens: 180,
					cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
				},
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
		assert.ok(events.some((event) => event.kind === "usage_actual"));
		assert.ok(requestIds.size >= 1);
	} finally {
		fixture.restore();
	}
});

test("previews a route without sending a provider request", async () => {
	const fixture = await setup();
	try {
		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		const command = fixture.pi.commands.get("auto-model");
		assert.ok(command);
		await command.handler("plan Review the architecture and propose a migration plan", fixture.ctx);
		const preview = fixture.ctx.notifications.at(-1) ?? "";
		assert.match(preview, /Pi Auto Model Preview/);
		assert.match(preview, /Target: /);
		assert.match(preview, /No request was sent\./);
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
	let providerCalls = 0;
	fixture.ctx.providers.set("openai", {
		streamSimple: () => {
			providerCalls++;
			return streamFromEvents([doneEvent("must not run")]);
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
		const virtual = fixture.pi.providerConfigs.get("pi-auto-model");
		assert.ok(virtual?.streamSimple);
		const events = await collectEvents(virtual.streamSimple!(
			fixture.ctx.model,
			{ messages: [] },
			{ sessionId: "integration-session" },
		));
		assert.ok(events.some((event) => event.type === "error"));
		assert.equal(providerCalls, 0);
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
		fixture.ctx.providers.set(firstTarget, { streamSimple: (model, _context, options: any) => {
			void options.onResponse({ status: 429, headers: { "retry-after": "60" } }, model);
			return streamFromEvents([{ type: "error", reason: "error", error: { role: "assistant", content: [], errorMessage: "rate limited" } as unknown as AssistantMessage }]);
		} });
		await dispatch(fixture);

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
	const fixture = await setup({ shadow: { enabled: true }, policy: "price" }, "anthropic/claude-sonnet");
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

test("uses other models only when an empty pool explicitly allows fallback", async () => {
	const fixture = await setup({
		pool: "empty",
		pools: {
			empty: { targets: [{ id: "no-such/model", weight: 1 }], fallback: "any" },
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

		assert.ok(fixture.ctx.notifications.some((message) => message.includes("Pi Auto Model →")));

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

test("escalates the next model call after repeated tool errors", async () => {
	const fixture = await setup();
	const frontier = fixture.ctx.modelRegistry.find("openai", "gpt-5")!;
	const light = fixture.ctx.modelRegistry.find("anthropic", "claude-sonnet")!;
	frontier.cost.input = frontier.cost.output = 10;
	light.cost.input = light.cost.output = 0;
	const calls: string[] = [];
	for (const target of [frontier, light]) {
		fixture.ctx.providers.set(target.provider, {
			streamSimple: () => {
				calls.push(target.provider);
				return streamFromEvents([startEvent(), textDeltaEvent("ok"), doneEvent("ok")]);
			},
		});
	}
	const virtual = fixture.pi.providerConfigs.get("pi-auto-model");
	assert.ok(virtual?.streamSimple);
	try {
		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		await fixture.pi.emit("before_agent_start", {
			type: "before_agent_start", prompt: "Summarize this paragraph", systemPrompt: "", systemPromptOptions: {},
		}, fixture.ctx);
		await fixture.pi.emit("tool_execution_end", { type: "tool_execution_end", isError: true }, fixture.ctx);
		await fixture.pi.emit("tool_execution_end", { type: "tool_execution_end", isError: true }, fixture.ctx);
		await collectEvents(virtual.streamSimple!(
			fixture.ctx.model,
			{ messages: [] },
			{ sessionId: "integration-session" },
		));
		assert.deepEqual(calls, ["openai"]);
	} finally {
		fixture.restore();
	}
});

test("temporarily bypasses routing after repeated internal failures", async () => {
	const fixture = await setup();
	fixture.ctx.scopedModels.splice(0);
	const originalGetAvailable = fixture.ctx.modelRegistry.getAvailable;
	let calls = 0;
	(fixture.ctx.modelRegistry as { getAvailable: () => Model<any>[] }).getAvailable = () => {
		calls++;
		if (calls <= 6) throw new Error("registry fault");
		return originalGetAvailable();
	};
	fixture.ctx.providers.set("openai", {
		streamSimple: () => streamFromEvents([startEvent(), textDeltaEvent("recovered"), doneEvent("recovered")]),
	});
	const virtual = fixture.pi.providerConfigs.get("pi-auto-model");
	assert.ok(virtual?.streamSimple);
	try {
		await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
		for (let attempt = 0; attempt < 4; attempt++) {
			await fixture.pi.emit("before_agent_start", {
				type: "before_agent_start", prompt: "Explain this", systemPrompt: "", systemPromptOptions: {},
			}, fixture.ctx);
		}
		assert.ok(fixture.ctx.notifications.some((message) => message.includes("temporarily bypassed")));
		const events = await collectEvents(virtual.streamSimple!(
			fixture.ctx.model,
			{ messages: [] },
			{ sessionId: "integration-session" },
		));
		assert.ok(events.some((event) => event.type === "done"));
	} finally {
		fixture.restore();
	}
});

async function begin(fixture: Awaited<ReturnType<typeof setup>>, prompt = "hello"): Promise<void> {
	await fixture.pi.emit("session_start", { type: "session_start", reason: "startup" }, fixture.ctx);
	await fixture.pi.emit("before_agent_start", { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: {} }, fixture.ctx);
}

async function dispatch(fixture: Awaited<ReturnType<typeof setup>>): Promise<AssistantMessageEvent[]> {
	return collectEvents(fixture.pi.providerConfigs.get("pi-auto-model")!.streamSimple!(
		fixture.ctx.model, { messages: [] }, { sessionId: "integration-session" },
	));
}

test("never sends a request when every provider is denied", async () => {
	const f = await setup({ constraints: { providerAllow: ["unavailable"] } });
	let calls = 0;
	for (const provider of ["openai", "anthropic"]) f.ctx.providers.set(provider, {
		streamSimple: () => { calls++; return streamFromEvents([doneEvent("wrong")]); },
	});
	try {
		await begin(f);
		assert.equal((await dispatch(f)).at(-1)?.type, "error");
		assert.equal(calls, 0);
	} finally { f.restore(); }
});

test("a newly blocked task cannot reuse the preceding task's approved plan", async () => {
	const f = await setup({ pools: { empty: { targets: [{ id: "missing/model", weight: 1 }], fallback: "none" } } });
	let calls = 0;
	f.ctx.providers.set("openai", { streamSimple: () => { calls++; return streamFromEvents([doneEvent("ok")]); } });
	try {
		await begin(f);
		assert.equal((await dispatch(f)).at(-1)?.type, "done");
		await f.pi.commands.get("auto-model")!.handler("pool empty", f.ctx);
		// Deliberately omit agent_settled to simulate an interrupted lifecycle.
		await f.pi.emit("before_agent_start", { prompt: "hello again" }, f.ctx);
		assert.equal((await dispatch(f)).at(-1)?.type, "error");
		assert.equal(calls, 1);
	} finally { f.restore(); }
});

test("reserves each tool-loop request and blocks cumulative task or daily overspend", async () => {
	for (const limit of ["dailyUsd", "maxUsdPerTask"]) {
		const f = await setup({ constraints: { providerAllow: ["openai"] }, budget: { [limit]: 0.025, onExceed: "block" } });
		let calls = 0;
		f.ctx.providers.set("openai", { streamSimple: () => { calls++; return streamFromEvents([doneEvent("ok")]); } });
		try {
			await begin(f);
			assert.equal((await dispatch(f)).at(-1)?.type, "done");
			assert.equal((await dispatch(f)).at(-1)?.type, "error");
			assert.equal(calls, 1, limit);
		} finally { f.restore(); }
	}
});

test("settles actual costs per request before the next tool-loop call", async () => {
	const f = await setup();
	for (const [provider, cost] of [["openai", 0.01], ["anthropic", 0.02]] as const) {
		f.ctx.providers.set(provider, { streamSimple: () => {
			const done = doneEvent("ok") as Extract<AssistantMessageEvent, { type: "done" }>;
			done.message.usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
				cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
			return streamFromEvents([textDeltaEvent("ok"), done]);
		} });
	}
	try {
		await begin(f);
		await dispatch(f);
		await dispatch(f);
		const budget = JSON.parse(await readFile(join(f.root, ".pi/agent/auto-model/budget.json"), "utf8"));
		assert.ok(Math.abs(budget.usage.dailyUsd - 0.02) < 1e-9);
		assert.ok(Math.abs(budget.usage.providers.openai.dailyUsd - 0.02) < 1e-9);
	} finally { f.restore(); }
});

test("classifier and compaction honor the same provider constraints", async () => {
	const f = await setup({ constraints: { providerAllow: ["anthropic"] }, classifier: { enabled: true } });
	const calls: string[] = [];
	(f.ctx.modelRegistry as any).complete = async (model: Model<any>) => {
		calls.push(model.provider);
		return { content: [{ type: "text", text: '{"complexity":0.2}' }] };
	};
	f.ctx.providers.set("anthropic", { streamSimple: () => {
		calls.push("anthropic-compaction");
		const done = doneEvent("Retain the tested fix.") as Extract<AssistantMessageEvent, { type: "done" }>;
		done.message.stopReason = "stop";
		return streamFromEvents([done]);
	} });
	try {
		await begin(f);
		assert.deepEqual(calls, ["anthropic"]);
		const result = await f.pi.emit("session_before_compact", compactionEvent(), f.ctx);
		assert.deepEqual(calls, ["anthropic", "anthropic-compaction"]);
		assert.match(result?.compaction?.summary ?? "", /Retain the tested fix/);
		assert.equal(result.compaction.firstKeptEntryId, "kept-entry");
		assert.deepEqual(result.compaction.details.modifiedFiles, ["src/fix.ts"]);
		assert.equal(f.ctx.model.provider, "pi-auto-model", "native model remains unchanged");
	} finally { f.restore(); }
});

test("classifier aborts its provider request on timeout and cannot bypass a zero budget", async () => {
	const f = await setup({ classifier: { enabled: true }, budget: { dailyUsd: 0, onExceed: "block" } });
	let signal: AbortSignal | undefined;
	let calls = 0;
	(f.ctx.modelRegistry as any).complete = (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
		calls++;
		signal = options.signal;
		return new Promise(() => {});
	};
	try {
		await begin(f);
		assert.equal(calls, 0);
		await assert.rejects(refineWithClassifier(f.ctx as never, analyzeTask({ prompt: "hello" }), "hello", 5), /timeout/);
		assert.equal(calls, 1);
		assert.equal(signal?.aborted, true);
	} finally { f.restore(); }
});

test("failover attributes charged attempts to their actual providers", async () => {
	const f = await setup();
	f.ctx.providers.set("openai", { streamSimple: (_model, _ctx, options: any) => {
		void options.onResponse({ status: 503, headers: { "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "0" } });
		const error: Extract<AssistantMessageEvent, { type: "error" }> = {
			type: "error", reason: "error", error: { role: "assistant", content: [], errorMessage: "unavailable" } as unknown as AssistantMessage,
		};
		error.error.usage = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100,
			cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
		return streamFromEvents([error]);
	} });
	f.ctx.providers.set("anthropic", { streamSimple: () => {
		const done = doneEvent("ok") as Extract<AssistantMessageEvent, { type: "done" }>;
		done.message.usage = { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 220,
			cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } };
		return streamFromEvents([done]);
	} });
	try {
		await begin(f);
		assert.equal((await dispatch(f)).at(-1)?.type, "done");
		await f.pi.emit("session_shutdown", {}, f.ctx);
		const budget = JSON.parse(await readFile(join(f.root, ".pi/agent/auto-model/budget.json"), "utf8"));
		assert.ok(Math.abs(budget.usage.dailyUsd - 0.03) < 1e-9);
		assert.ok(Math.abs(budget.usage.providers.openai.dailyUsd - 0.01) < 1e-9);
		assert.ok(Math.abs(budget.usage.providers.anthropic.dailyUsd - 0.02) < 1e-9);
		const metrics = JSON.parse(await readFile(join(f.root, ".pi/agent/auto-model/metrics.json"), "utf8"));
		assert.equal(metrics.targets["openai/gpt-5"].actualCostUsd, 0.01);
		assert.equal(metrics.targets["anthropic/claude-sonnet"].actualCostUsd, 0.02);
		assert.equal(metrics.providers.anthropic.observedUvi, undefined, "OpenAI headers must not contaminate Anthropic quota");
	} finally { f.restore(); }
});

function compactionEvent(split = false) {
	return { preparation: {
		tokensBefore: 1000, firstKeptEntryId: "kept-entry",
		messagesToSummarize: [{ role: "user", content: "Remember the tested fix", timestamp: 1 }],
		turnPrefixMessages: split ? [{ role: "user", content: "Continue the fix", timestamp: 2 }] : [],
		isSplitTurn: split, fileOps: { read: new Set<string>(), written: new Set(["src/fix.ts"]), edited: new Set<string>() },
		settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 },
	} };
}

test("compaction cancels when no authorized target or budget is available", async () => {
	for (const config of [{ constraints: { providerAllow: ["missing"] } }, { budget: { dailyUsd: 0, onExceed: "block" } }]) {
		const f = await setup(config);
		let calls = 0;
		f.ctx.providers.set("openai", { streamSimple: () => { calls++; return streamFromEvents([doneEvent("wrong")]); } });
		try {
			await begin(f);
			const result = await f.pi.emit("session_before_compact", compactionEvent(), f.ctx);
			assert.equal(result?.cancel, true);
			assert.equal(calls, 0);
			assert.equal(f.ctx.model.provider, "pi-auto-model");
		} finally { f.restore(); }
	}
});

test("split compaction reserves and settles each native summary separately", async () => {
	const f = await setup({ budget: { maxUsdPerTask: 0.012, onExceed: "block" } });
	let calls = 0;
	f.ctx.providers.set("openai", { streamSimple: () => {
		calls++;
		const done = doneEvent("Summary") as Extract<AssistantMessageEvent, { type: "done" }>;
		done.message.stopReason = "stop";
		done.message.usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
			cost: { input: 0.012, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.012 } };
		return streamFromEvents([done]);
	} });
	try {
		await begin(f);
		const result = await f.pi.emit("session_before_compact", compactionEvent(true), f.ctx);
		assert.equal(calls, 1, "second summary is blocked after first summary consumes the task budget");
		assert.equal(result?.cancel, true, "partial compaction must not be persisted");
		const budget = JSON.parse(await readFile(join(f.root, ".pi/agent/auto-model/budget.json"), "utf8"));
		assert.ok(Math.abs(budget.usage.dailyUsd - 0.012) < 1e-9);
	} finally { f.restore(); }
});

test("automatic routing keeps the real warm target across user turns", async () => {
	const f = await setup();
	f.ctx.getContextUsage = () => ({ tokens: 80_000, contextWindow: 200_000 });
	try {
		await begin(f, "@model:anthropic/claude-sonnet hello");
		await f.pi.emit("agent_settled", {}, f.ctx);
		await f.pi.emit("before_agent_start", { prompt: "hello" }, f.ctx);
		const latest = f.ctx.notifications.filter((text) => text.includes("Pi Auto Model →")).at(-1);
		assert.match(latest!, /anthropic\/claude-sonnet/);
	} finally { f.restore(); }
});

test("preview and execution share pool, pin and budget constraints without sending requests", async () => {
	for (const scenario of ["pool", "pin", "budget", "empty-pool"] as const) {
		const config = scenario === "budget" ? { budget: { dailyUsd: 0, onExceed: "block" } }
			: scenario === "pool" || scenario === "empty-pool" ? { pool: "test", pools: { test: {
				targets: [{ id: scenario === "pool" ? "anthropic/claude-sonnet" : "missing/model", weight: 1 }], fallback: "none",
			} } } : {};
		const f = await setup(config);
		try {
			await f.pi.emit("session_start", { type: "session_start", reason: "startup" }, f.ctx);
			const command = f.pi.commands.get("auto-model")!;
			if (scenario === "pin") await command.handler("pin anthropic/claude-sonnet", f.ctx);
			await command.handler("plan hello", f.ctx);
			const preview = f.ctx.notifications.at(-1)!;
			await f.pi.emit("before_agent_start", { prompt: "hello" }, f.ctx);
			const actual = f.ctx.notifications.filter((message) => message.includes("Pi Auto Model →")).at(-1);
			if (scenario === "budget" || scenario === "empty-pool") {
				assert.match(preview, /No eligible model/);
				assert.equal(actual, undefined);
			} else {
				assert.match(preview, /Target: anthropic\/claude-sonnet/);
				assert.match(actual!, /anthropic\/claude-sonnet/);
			}
			await assert.rejects(readFile(join(f.root, ".pi/agent/auto-model/budget.json")), { code: "ENOENT" });
		} finally { f.restore(); }
	}
});
