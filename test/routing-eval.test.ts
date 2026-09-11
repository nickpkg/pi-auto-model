import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { analyzeTask } from "../src/task/local-analyzer.ts";
import { planRoute } from "../src/routing/route-planner.ts";
import type { RouteTarget } from "../src/types.ts";

const target = (id: string, cost: number): RouteTarget => ({
	id,
	model: {
		provider: id.split("/", 1)[0], id: id.slice(id.indexOf("/") + 1), name: id,
		api: "test", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 16_000,
		cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>,
});

test("offline routing corpus keeps simple work cheap and hard work capable", async () => {
	const fixtures = JSON.parse(await readFile(new URL("./fixtures/routing-eval.json", import.meta.url), "utf8")) as Array<{ prompt: string; expected: "light" | "frontier" }>;
	const targets = [target("gateway/openrouter/free", 0), target("gateway/openai/gpt-5.6-luna", 10)];
	for (const fixture of fixtures) {
		const selected = planRoute({ targets, profile: analyzeTask({ prompt: fixture.prompt }) })?.target.id;
		assert.equal(selected, fixture.expected === "light" ? "gateway/openrouter/free" : "gateway/openai/gpt-5.6-luna", fixture.prompt);
	}
});
