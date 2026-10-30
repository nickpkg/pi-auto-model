import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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

	contextTokens = 0;

	getContextUsage(): { tokens: number; contextWindow: number } {
		return { tokens: this.contextTokens, contextWindow: 200_000 };
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

test("accepts a request whose Pi context estimate fits despite large serialized context", async () => {
	const f = await setup();
	let calls = 0;
	f.ctx.contextTokens = 130_000;
	f.ctx.providers.set("openai", { streamSimple: () => { calls++; return streamFromEvents([doneEvent("ok")]); } });
	try {
		await begin(f);
		const context = { messages: [{ role: "user", content: "x".repeat(600_000) }] } as never;
		const events = await collectEvents(f.pi.providerConfigs.get("pi-auto-model")!.streamSimple!(
			f.ctx.model, context, { sessionId: "integration-session" },
		));
		assert.equal(events.at(-1)?.type, "done");
		assert.equal(calls, 1);
	} finally { f.restore(); }
});

test("rejects context growth that exceeds target capacity at dispatch", async () => {
	const f = await setup();
	let calls = 0;
	f.ctx.contextTokens = 130_000;
	f.ctx.providers.set("openai", { streamSimple: () => { calls++; return streamFromEvents([doneEvent("wrong")]); } });
	try {
		await begin(f);
		const events = await collectEvents(f.pi.providerConfigs.get("pi-auto-model")!.streamSimple!(
			f.ctx.model, { messages: [{ role: "user", content: "x".repeat(720_000) }] },
			{ sessionId: "integration-session" },
		));
		assert.equal(events.at(-1)?.type, "error");
		assert.equal(calls, 0);
	} finally { f.restore(); }
});

test("routes an extension-triggered turn without before_agent_start", async () => {
	const f = await setup();
	let calls = 0;
	for (const provider of ["openai", "anthropic"]) f.ctx.providers.set(provider, {
		streamSimple: () => { calls++; return streamFromEvents([doneEvent("ok")]); },
	});
	try {
		await f.pi.emit("session_start", { type: "session_start", reason: "startup" }, f.ctx);
		await f.pi.emit("agent_start", { type: "agent_start" }, f.ctx);
		assert.equal(routeNotices(f).length, 0);
		await f.pi.emit("context", { type: "context", messages: [
			{ role: "user", content: [{ type: "text", text: "Explain this" }] },
		] }, f.ctx);
		assert.equal((await dispatch(f)).at(-1)?.type, "done");
		assert.equal(calls, 1);
		assert.equal(routeNotices(f).length, 1);
		// Later context events in the same run reuse the plan.
		await f.pi.emit("context", { type: "context", messages: [] }, f.ctx);
		assert.equal(routeNotices(f).length, 1);
	} finally { f.restore(); }
});

test("routes an extension-triggered turn on its triggering message, not an earlier prompt", async () => {
	const trigger = "Subagent finished: refactor the authentication module, add migrations, and fix the failing integration tests across the repository.";
	const stale = await setup();
	const expected = await setup();
	const f = await setup();
	try {
		await begin(stale, "hi");
		await begin(expected, trigger);
		const expectedRoute = routeNotices(expected).at(-1);
		assert.ok(expectedRoute);
		assert.notEqual(routeNotices(stale).at(-1), expectedRoute);
		await f.pi.emit("session_start", { type: "session_start", reason: "startup" }, f.ctx);
		await f.pi.emit("agent_start", { type: "agent_start" }, f.ctx);
		await f.pi.emit("context", { type: "context", messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "Hello" }] },
			{ role: "custom", customType: "subagent-result", content: trigger },
		] }, f.ctx);
		assert.equal(routeNotices(f).at(-1), expectedRoute);
	} finally { f.restore(); expected.restore(); stale.restore(); }
});

test("routes a Pi 1.4 custom before_agent_start turn as an extension trigger on its message", async () => {
	const trigger = "Subagent finished: refactor the authentication module, add migrations, and fix the failing integration tests across the repository.";
	const expected = await setup();
	const f = await setup();
	let calls = 0;
	for (const provider of ["openai", "anthropic"]) f.ctx.providers.set(provider, {
		streamSimple: () => { calls++; return streamFromEvents([doneEvent("ok")]); },
	});
	try {
		await begin(expected, trigger);
		const expectedRoute = routeNotices(expected).at(-1);
		assert.ok(expectedRoute);
		await f.pi.emit("session_start", { type: "session_start", reason: "startup" }, f.ctx);
		await f.pi.emit("before_agent_start", {
			type: "before_agent_start", messageType: "custom", systemPrompt: "", systemPromptOptions: {},
			message: { role: "custom", customType: "intercom", content: `@model:anthropic/claude-sonnet ${trigger}`, display: true, timestamp: 0 },
		}, f.ctx);
		assert.deepEqual(f.ctx.notifications.filter((m) => m.includes("routing failed")), []);
		const route = routeNotices(f).at(-1) ?? "";
		assert.equal(routeNotices(f).length, 1);
		// Extension messages never honor inline prefixes.
		assert.doesNotMatch(route, /anthropic\/claude-sonnet/);
		assert.equal((await dispatch(f)).at(-1)?.type, "done");
		assert.equal(calls, 1);
		// The agent_start/context fallback must not route the same run again.
		await f.pi.emit("agent_start", { type: "agent_start" }, f.ctx);
		await f.pi.emit("context", { type: "context", messages: [{ role: "custom", content: trigger }] }, f.ctx);
		assert.equal(routeNotices(f).length, 1);
		// A custom turn does not consume the first user prompt's prefix allowance.
		await f.pi.emit("agent_settled", { type: "agent_settled" }, f.ctx);
		await f.pi.emit("before_agent_start", {
			type: "before_agent_start", messageType: "user", prompt: "@model:anthropic/claude-sonnet Explain this", systemPrompt: "", systemPromptOptions: {},
		}, f.ctx);
		assert.match(routeNotices(f).at(-1) ?? "", /→ anthropic\/claude-sonnet/);
	} finally { f.restore(); expected.restore(); }
});

test("routes the same custom message text as the equivalent extension-triggered context turn", async () => {
	const trigger = "Subagent finished: refactor the authentication module, add migrations, and fix the failing integration tests across the repository.";
	const viaContext = await setup();
	const viaEvent = await setup();
	try {
		await viaContext.pi.emit("session_start", { type: "session_start", reason: "startup" }, viaContext.ctx);
		await viaContext.pi.emit("agent_start", { type: "agent_start" }, viaContext.ctx);
		await viaContext.pi.emit("context", { type: "context", messages: [{ role: "custom", content: [{ type: "text", text: trigger }] }] }, viaContext.ctx);
		await viaEvent.pi.emit("session_start", { type: "session_start", reason: "startup" }, viaEvent.ctx);
		await viaEvent.pi.emit("before_agent_start", {
			type: "before_agent_start", messageType: "custom", systemPrompt: "", systemPromptOptions: {},
			message: { role: "custom", customType: "intercom", content: [{ type: "text", text: trigger }], display: true, timestamp: 0 },
		}, viaEvent.ctx);
		assert.ok(routeNotices(viaContext).at(-1));
		assert.equal(routeNotices(viaEvent).at(-1), routeNotices(viaContext).at(-1));
	} finally { viaEvent.restore(); viaContext.restore(); }
});

test("routes a Pi 1.4 user before_agent_start turn with messageType", async () => {
	const f = await setup();
	f.ctx.providers.set("anthropic", { streamSimple: () => streamFromEvents([doneEvent("ok")]) });
	try {
		await f.pi.emit("session_start", { type: "session_start", reason: "startup" }, f.ctx);
		await f.pi.emit("before_agent_start", {
			type: "before_agent_start", messageType: "user", prompt: "@model:anthropic/claude-sonnet Explain this", systemPrompt: "", systemPromptOptions: {},
		}, f.ctx);
		assert.equal(routeNotices(f).length, 1);
		assert.match(routeNotices(f).at(-1) ?? "", /→ anthropic\/claude-sonnet/);
		assert.equal((await dispatch(f)).at(-1)?.type, "done");
	} finally { f.restore(); }
});

test("routes a normal run only once and routes again after it settles", async () => {
	const f = await setup();
	const context = { type: "context", messages: [{ role: "user", content: "Explain this" }] };
	try {
		await begin(f, "Explain this");
		await f.pi.emit("agent_start", { type: "agent_start" }, f.ctx);
		await f.pi.emit("context", context, f.ctx);
		await f.pi.emit("agent_start", { type: "agent_start" }, f.ctx);
		await f.pi.emit("context", context, f.ctx);
		assert.equal(routeNotices(f).length, 1);
		await f.pi.emit("agent_settled", { type: "agent_settled" }, f.ctx);
		await f.pi.emit("agent_start", { type: "agent_start" }, f.ctx);
		await f.pi.emit("context", context, f.ctx);
		assert.equal(routeNotices(f).length, 2);
	} finally { f.restore(); }
});

test("does not override a blocked run on agent_start", async () => {
	const f = await setup({ budget: { maxUsdPerTask: 0.000001, onExceed: "block" } });
	let calls = 0;
	for (const provider of ["openai", "anthropic"]) f.ctx.providers.set(provider, {
		streamSimple: () => { calls++; return streamFromEvents([doneEvent("wrong")]); },
	});
	try {
		await begin(f, "Explain this");
		await f.pi.emit("agent_start", { type: "agent_start" }, f.ctx);
		await f.pi.emit("context", { type: "context", messages: [{ role: "user", content: "Explain this" }] }, f.ctx);
		assert.equal((await dispatch(f)).at(-1)?.type, "error");
		assert.equal(calls, 0);
		assert.equal(f.ctx.notifications.filter((m) => m.includes("budget exceeded")).length, 1);
	} finally { f.restore(); }
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
		const failure = { type: "tool_execution_end", toolName: "edit", isError: true,
			result: { content: [{ type: "text", text: "Could not find the exact old text" }] } };
		await fixture.pi.emit("tool_execution_end", failure, fixture.ctx);
		await fixture.pi.emit("tool_execution_end", failure, fixture.ctx);
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

function routeNotices(fixture: Awaited<ReturnType<typeof setup>>): string[] {
	return fixture.ctx.notifications.filter((message) => message.includes("Pi Auto Model →"));
}

async function dispatch(fixture: Awaited<ReturnType<typeof setup>>): Promise<AssistantMessageEvent[]> {
	return collectEvents(fixture.pi.providerConfigs.get("pi-auto-model")!.streamSimple!(
		fixture.ctx.model, { messages: [] }, { sessionId: "integration-session" },
	));
}

test("task diagnostics keep successful delivery unknown until explicit outcome and include auxiliary costs", async () => {
	const f = await setup({ constraints: { providerAllow: ["openai"] }, classifier: { enabled: true }, pricing: { litellm: { enabled: false } } });
	(f.ctx.modelRegistry as any).complete = async () => ({ content: [{ type: "text", text: '{"complexity":0.2}' }], usage: { cost: { total: 0.002 } } });
	f.ctx.providers.set("openai", { streamSimple: () => {
		const done = doneEvent("ok") as Extract<AssistantMessageEvent, { type: "done" }>;
		done.message.stopReason = "stop";
		done.message.usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
			cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
		return streamFromEvents([done]);
	} });
	try {
		await begin(f);
		await dispatch(f);
		await dispatch(f);
		await f.pi.emit("tool_execution_end", { toolName: "bash", isError: true,
			result: { content: [{ type: "text", text: "1 test failed: AssertionError" }] } }, f.ctx);
		await f.pi.emit("session_before_compact", compactionEvent(), f.ctx);
		await f.pi.emit("agent_settled", {}, f.ctx);
		const command = f.pi.commands.get("auto-model")!;
		await command.handler("task", f.ctx);
		assert.match(f.ctx.notifications.at(-1)!, /Outcome: unknown/);
		assert.match(f.ctx.notifications.at(-1)!, /Cost: \$0\.0320 \(reported/);
		assert.match(f.ctx.notifications.at(-1)!, /Attempts: 4/);
		await command.handler("outcome success", f.ctx);
		await command.handler("task", f.ctx);
		assert.match(f.ctx.notifications.at(-1)!, /Outcome: success \(user assessment\)/);
		await f.pi.emit("session_shutdown", {}, f.ctx);
		const quality = JSON.parse(await readFile(join(f.root, ".pi/agent/auto-model/quality.json"), "utf8"));
		assert.equal(quality.targets["openai/gpt-5"].failures, 0, "validation failure is not delivery failure");
		const events = (await readFile(join(f.root, ".pi/agent/auto-model/events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(events.filter((event) => event.kind === "task_summary").length, 1);
		assert.equal(events.find((event) => event.kind === "task_outcome").metadata.evidence, "user");
	} finally { f.restore(); }
});

test("task diagnostics retain unknown cost and cancelled outcomes", async () => {
	const f = await setup({ constraints: { providerAllow: ["openai"] }, pricing: { litellm: { enabled: false } } });
	f.ctx.providers.set("openai", { streamSimple: () => streamFromEvents([{ type: "error", reason: "aborted",
		error: { role: "assistant", content: [], stopReason: "aborted" } as unknown as AssistantMessage }]) });
	try {
		await begin(f);
		await dispatch(f);
		await f.pi.emit("agent_settled", {}, f.ctx);
		await f.pi.commands.get("auto-model")!.handler("task", f.ctx);
		assert.match(f.ctx.notifications.at(-1)!, /Outcome: cancelled/);
		assert.match(f.ctx.notifications.at(-1)!, /\(estimated/);
	} finally { f.restore(); }
});

test("reliability learning counts a multi-turn successful task once", async () => {
	const f = await setup({ constraints: { providerAllow: ["openai"] }, pricing: { litellm: { enabled: false } } });
	f.ctx.providers.set("openai", { streamSimple: () => streamFromEvents([doneEvent("ok")]) });
	try {
		await begin(f);
		await dispatch(f);
		await dispatch(f);
		await dispatch(f);
		await f.pi.emit("agent_settled", {}, f.ctx);
		await f.pi.emit("session_shutdown", {}, f.ctx);
		const quality = JSON.parse(await readFile(join(f.root, ".pi/agent/auto-model/quality.json"), "utf8"));
		assert.equal(Math.round(quality.targets["openai/gpt-5"].attempts), 1);
		assert.equal(quality.targets["openai/gpt-5"].failures, 0);
	} finally { f.restore(); }
});

test("a new prompt keeps the known outcome of a task that never received agent_settled", async () => {
	const f = await setup({ constraints: { providerAllow: ["openai"] }, pricing: { litellm: { enabled: false } } });
	f.ctx.providers.set("openai", { streamSimple: () => streamFromEvents([{ type: "error", reason: "error",
		error: { role: "assistant", content: [], stopReason: "error", errorMessage: "bad request" } as unknown as AssistantMessage }]) });
	try {
		await begin(f);
		await dispatch(f);
		await f.pi.emit("before_agent_start", { type: "before_agent_start", prompt: "next", systemPrompt: "", systemPromptOptions: {} }, f.ctx);
		await f.pi.emit("session_shutdown", {}, f.ctx);
		const events = (await readFile(join(f.root, ".pi/agent/auto-model/events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const summaries = events.filter((event) => event.kind === "task_summary");
		assert.equal(summaries.length, 2);
		assert.equal(summaries[0].metadata.outcome, "failure", "not relabelled as cancelled by the next prompt");
	} finally { f.restore(); }
});

test("timed-out authorization records task failure without a provider dispatch", async () => {
	const f = await setup({ failover: { requestTimeoutMs: 25 } });
	let release!: () => void;
	f.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
		await new Promise<void>((resolve) => { release = resolve; });
		return { ok: true, apiKey: "test-key", baseUrl: undefined, headers: undefined };
	};
	f.ctx.providers.set("openai", { streamSimple: () => { throw new Error("must not dispatch"); } });
	try {
		await begin(f);
		assert.equal((await dispatch(f)).at(-1)?.type, "error");
		await f.pi.emit("agent_settled", {}, f.ctx);
		await f.pi.commands.get("auto-model")!.handler("task", f.ctx);
		assert.match(f.ctx.notifications.at(-1)!, /Outcome: failure/);
		release();
	} finally { f.restore(); }
});

test("classifier cost survives a subsequent budget-blocked task", async () => {
	const f = await setup({ classifier: { enabled: true }, constraints: { providerAllow: ["openai"] },
		pricing: { litellm: { enabled: false } }, budget: { dailyUsd: 0.003, onExceed: "block" } });
	(f.ctx.modelRegistry as any).complete = async () => ({ content: [{ type: "text", text: '{"complexity":0.2}' }], usage: { cost: { total: 0.002 } } });
	try {
		await begin(f);
		await f.pi.emit("agent_settled", {}, f.ctx);
		await f.pi.commands.get("auto-model")!.handler("task", f.ctx);
		assert.match(f.ctx.notifications.at(-1)!, /Outcome: failure/);
		assert.match(f.ctx.notifications.at(-1)!, /Cost: \$0\.0020 \(reported/);
	} finally { f.restore(); }
});

test("compaction cannot spend a task allowance already consumed by the main request", async () => {
	const f = await setup({ constraints: { providerAllow: ["openai"] }, pricing: { litellm: { enabled: false } },
		budget: { maxUsdPerTask: 0.02, onExceed: "block" } });
	let calls = 0;
	f.ctx.providers.set("openai", { streamSimple: () => {
		calls++;
		const done = doneEvent("ok") as Extract<AssistantMessageEvent, { type: "done" }>;
		done.message.usage = { cost: { total: 0.02 } } as AssistantMessage["usage"];
		return streamFromEvents([done]);
	} });
	try {
		await begin(f);
		await dispatch(f);
		const result = await f.pi.emit("session_before_compact", compactionEvent(), f.ctx);
		assert.equal(result?.cancel, true);
		assert.equal(calls, 1);
	} finally { f.restore(); }
});

test("validation, environment and interrupted execution failures do not escalate", async () => {
	for (const scenario of ["validation", "environment", "recovered"]) {
		const f = await setup({ policy: "cost", pricing: { litellm: { enabled: false },
			overrides: { "anthropic/claude-sonnet": { input: 0.1, output: 0.1 }, "openai/gpt-5": { input: 10, output: 10 } } } });
		const strong = f.ctx.modelRegistry.find("openai", "gpt-5")!;
		const cheap = f.ctx.modelRegistry.find("anthropic", "claude-sonnet")!;
		strong.cost.input = strong.cost.output = 10;
		cheap.cost.input = cheap.cost.output = 0;
		const calls: string[] = [];
		for (const provider of ["openai", "anthropic"]) f.ctx.providers.set(provider, {
			streamSimple: () => { calls.push(provider); return streamFromEvents([doneEvent("ok")]); },
		});
		try {
			await begin(f);
			const error = { toolName: scenario === "recovered" ? "edit" : "bash", isError: true,
				result: { content: [{ type: "text", text: scenario === "validation" ? "2 tests failed" : scenario === "environment" ? "command not found" : "old text not found" }] } };
			await f.pi.emit("tool_execution_end", error, f.ctx);
			if (scenario === "recovered") await f.pi.emit("tool_execution_end", { toolName: "edit", isError: false }, f.ctx);
			await f.pi.emit("tool_execution_end", error, f.ctx);
			await dispatch(f);
			assert.deepEqual(calls, ["anthropic"], scenario);
		} finally { f.restore(); }
	}
});

test("price overrides govern preview, dispatch and cumulative tool-loop reservations", async () => {
	const f = await setup({ constraints: { providerAllow: ["openai"] },
		pricing: { litellm: { enabled: false }, costCoef: 100, overrides: { "openai/gpt-5": { input: 0.1, output: 0.1 } } },
		budget: { dailyUsd: 0.003, onExceed: "block" } });
	let calls = 0;
	f.ctx.providers.set("openai", { streamSimple: () => { calls++; return streamFromEvents([doneEvent("ok")]); } });
	try {
		await f.pi.emit("session_start", { type: "session_start", reason: "startup" }, f.ctx);
		await f.pi.commands.get("auto-model")!.handler("plan hello", f.ctx);
		assert.match(f.ctx.notifications.at(-1)!, /Target: openai\/gpt-5/);
		assert.equal(calls, 0);
		await f.pi.emit("before_agent_start", { prompt: "hello" }, f.ctx);
		assert.equal(routeNotices(f).length, 1);
		assert.equal((await dispatch(f)).at(-1)?.type, "done");
		const budget = JSON.parse(await readFile(join(f.root, ".pi/agent/auto-model/budget.json"), "utf8"));
		assert.ok(budget.usage.dailyUsd > 0.0016 && budget.usage.dailyUsd < 0.0017);
		assert.equal((await dispatch(f)).at(-1)?.type, "error");
		assert.equal(calls, 1);
	} finally { f.restore(); }
});

test("a damaged budget at startup is backed up, reported once and does not stop dispatch", async () => {
	const f = await setup({ budget: { dailyUsd: 1, onExceed: "block" } });
	const directory = join(f.root, ".pi/agent/auto-model");
	const path = join(directory, "budget.json");
	await mkdir(directory, { recursive: true });
	await writeFile(path, "{broken");
	let calls = 0;
	for (const provider of ["openai", "anthropic"]) f.ctx.providers.set(provider, {
		streamSimple: () => { calls++; return streamFromEvents([doneEvent("ok")]); },
	});
	try {
		await begin(f);
		assert.equal((await dispatch(f)).at(-1)?.type, "done");
		assert.equal(calls, 1);
		assert.equal(f.ctx.notifications.filter((message) => /budget ledger/i.test(message)).length, 1);
		assert.ok((await readdir(directory)).some((name) => name.startsWith("budget.json.corrupt-")));
		assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
	} finally { f.restore(); }
});

test("classifier and compaction use resolved prices before the first routed request", async () => {
	for (const source of ["override", "cache"]) {
		const f = await setup({ constraints: { providerAllow: ["openai"] }, classifier: { enabled: true },
			pricing: { litellm: { enabled: false }, overrides: source === "override" ? { "openai/gpt-5": { input: 0, output: 0 } } : {} },
			budget: { dailyUsd: 0, onExceed: "block" } });
		if (source === "cache") {
			await mkdir(join(f.root, ".pi/agent/auto-model"), { recursive: true });
			await writeFile(join(f.root, ".pi/agent/auto-model/prices.json"), JSON.stringify({
				version: 1, source: "litellm", updatedAt: Date.now(), models: { "openai/gpt-5": { input: 0, output: 0 } },
			}));
		}
		let classified = 0;
		let compacted = 0;
		(f.ctx.modelRegistry as any).complete = async () => {
			classified++;
			return { content: [{ type: "text", text: '{"complexity":0.2}' }] };
		};
		f.ctx.providers.set("openai", { streamSimple: () => {
			compacted++;
			const done = doneEvent("Summary") as Extract<AssistantMessageEvent, { type: "done" }>;
			done.message.stopReason = "stop";
			return streamFromEvents([done]);
		} });
		try {
			await begin(f);
			assert.equal(classified, 1, source);
			const result = await f.pi.emit("session_before_compact", compactionEvent(true), f.ctx);
			assert.ok(result?.compaction, source);
			assert.equal(compacted, 2, source);
			const budget = JSON.parse(await readFile(join(f.root, ".pi/agent/auto-model/budget.json"), "utf8"));
			assert.equal(budget.usage.dailyUsd, 0, source);
		} finally { f.restore(); }
	}
});

test("failover reserves each provider at its own override price", async () => {
	const f = await setup({ policy: "cost", pricing: { litellm: { enabled: false }, overrides: {
		"openai/gpt-5": { input: 0.1, output: 0.1 }, "anthropic/claude-sonnet": { input: 0.2, output: 0.2 },
	} }, budget: { dailyUsd: 0.006, onExceed: "block" } });
	const calls: string[] = [];
	f.ctx.providers.set("openai", { streamSimple: () => {
		calls.push("openai");
		return streamFromEvents([{ type: "error", reason: "error", error: {
			role: "assistant", content: [], errorMessage: "503 unavailable",
		} as unknown as AssistantMessage }]);
	} });
	f.ctx.providers.set("anthropic", { streamSimple: () => {
		calls.push("anthropic");
		return streamFromEvents([doneEvent("ok")]);
	} });
	try {
		await begin(f);
		assert.equal((await dispatch(f)).at(-1)?.type, "done");
		assert.deepEqual(calls, ["openai", "anthropic"]);
		const budget = JSON.parse(await readFile(join(f.root, ".pi/agent/auto-model/budget.json"), "utf8"));
		assert.ok(budget.usage.providers.openai.dailyUsd > 0.0016 && budget.usage.providers.openai.dailyUsd < 0.0017);
		assert.equal(budget.usage.providers.anthropic.dailyUsd, 2 * budget.usage.providers.openai.dailyUsd);
	} finally { f.restore(); }
});

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

function lastRoute(fixture: Awaited<ReturnType<typeof setup>>): string {
	return routeNotices(fixture).at(-1) ?? "";
}

test("a matching rule narrows the candidates and is explained", async () => {
	const f = await setup({ rules: [
		{ name: "reviews", when: { promptMatches: "^review" }, then: { only: ["anthropic/*"] } },
	] });
	try {
		await begin(f, "hello");
		assert.match(lastRoute(f), /openai\/gpt-5/);
		assert.doesNotMatch(lastRoute(f), /rule "/);
		await f.pi.emit("agent_settled", {}, f.ctx);
		await f.pi.emit("before_agent_start", { prompt: "Review this diff" }, f.ctx);
		assert.match(lastRoute(f), /anthropic\/claude-sonnet[\s\S]*Why: rule "reviews"/);
		await f.pi.commands.get("auto-model")!.handler("rules", f.ctx);
		const output = f.ctx.notifications.at(-1) ?? "";
		assert.match(output, /1\. reviews: when promptMatches=\^review → only=anthropic\/\*/);
		assert.match(output, /Last applied: reviews/);
	} finally { f.restore(); }
});

test("a manual pin disables rules", async () => {
	const f = await setup({ rules: [{ name: "claude", then: { only: ["anthropic/*"] } }] });
	try {
		await f.pi.emit("session_start", { type: "session_start", reason: "startup" }, f.ctx);
		await f.pi.commands.get("auto-model")!.handler("pin openai/gpt-5", f.ctx);
		await f.pi.emit("before_agent_start", { prompt: "hello" }, f.ctx);
		assert.match(lastRoute(f), /openai\/gpt-5/);
		assert.doesNotMatch(lastRoute(f), /rule "/);
	} finally { f.restore(); }
});

test("a rule without an eligible model falls back to normal routing and warns once", async () => {
	const f = await setup({ rules: [{ name: "local-only", then: { only: ["ollama/*"] } }] });
	const warning = /rule "local-only" matched, but no eligible model satisfies it/;
	try {
		await begin(f, "hello");
		assert.match(lastRoute(f), /openai\/gpt-5[\s\S]*rule "local-only" ignored \(no eligible model\)/);
		await f.pi.emit("agent_settled", {}, f.ctx);
		await f.pi.emit("before_agent_start", { prompt: "hello again" }, f.ctx);
		assert.equal(routeNotices(f).length, 2, "the request is not blocked");
		assert.equal(f.ctx.notifications.filter((message) => warning.test(message)).length, 1);
	} finally { f.restore(); }
});

test("invalid rules are reported at startup and by doctor", async () => {
	const f = await setup({ rules: [{ name: "broken", then: { policy: "cheapest" } }] });
	try {
		await f.pi.emit("session_start", { type: "session_start", reason: "startup" }, f.ctx);
		assert.ok(f.ctx.notifications.some((message) => /1 configuration issue\(s\)/.test(message)));
		await f.pi.commands.get("auto-model")!.handler("doctor", f.ctx);
		const output = f.ctx.notifications.at(-1) ?? "";
		assert.match(output, /Configuration issues:\n {2}.*rule "broken" ignored: "policy"/);
		assert.match(output, /Rules: 0/);
	} finally { f.restore(); }
});

test("compaction ends warm-target stickiness for the next task only", async () => {
	const f = await setup();
	f.ctx.contextTokens = 80_000;
	try {
		await begin(f, "@model:anthropic/claude-sonnet hello");
		await f.pi.emit("agent_settled", {}, f.ctx);
		await f.pi.emit("session_compact", { type: "session_compact", reason: "threshold", compactionEntry: {}, fromExtension: false }, f.ctx);
		await f.pi.commands.get("auto-model")!.handler("doctor", f.ctx);
		assert.match(f.ctx.notifications.at(-1) ?? "", /Prompt cache: cold \(compaction\); next task routes fresh/);
		await f.pi.emit("before_agent_start", { prompt: "hello" }, f.ctx);
		assert.match(lastRoute(f), /openai\/gpt-5[\s\S]*cache cold \(compaction\)/);
		await f.pi.commands.get("auto-model")!.handler("doctor", f.ctx);
		assert.match(f.ctx.notifications.at(-1) ?? "", /Prompt cache: warm or unknown/);
	} finally { f.restore(); }
});

test("a long idle gap ends warm-target stickiness", async () => {
	const f = await setup();
	f.ctx.contextTokens = 80_000;
	const realNow = Date.now;
	try {
		await begin(f, "@model:anthropic/claude-sonnet hello");
		await f.pi.emit("agent_settled", {}, f.ctx);
		const settledAt = realNow();
		Date.now = () => settledAt + 6 * 60_000;
		await f.pi.emit("before_agent_start", { prompt: "hello" }, f.ctx);
		assert.match(lastRoute(f), /openai\/gpt-5[\s\S]*cache cold \(idle 6m\)/);
	} finally { Date.now = realNow; f.restore(); }
});

test("a scenario shorthand routes a task kind and the plan preview shows the rule trace", async () => {
	const f = await setup({ scenarios: { vision: "best", review: "anthropic/*" } });
	const prompt = "Review this pull request and point out bugs";
	try {
		await f.pi.emit("session_start", { type: "session_start", reason: "startup" }, f.ctx);
		await f.pi.commands.get("auto-model")!.handler(`plan ${prompt}`, f.ctx);
		const preview = f.ctx.notifications.at(-1) ?? "";
		assert.match(preview, /Target: anthropic\/claude-sonnet/);
		assert.match(preview, /Rules:\n {2}✗ scenario:vision: task has no images\n {2}✓ scenario:review/);
		await f.pi.emit("before_agent_start", { prompt }, f.ctx);
		assert.match(lastRoute(f), /anthropic\/claude-sonnet[\s\S]*rule "scenario:review"/);
		await f.pi.commands.get("auto-model")!.handler("plan hello", f.ctx);
		assert.match(f.ctx.notifications.at(-1) ?? "", /✗ scenario:review: task is/);
	} finally { f.restore(); }
});
