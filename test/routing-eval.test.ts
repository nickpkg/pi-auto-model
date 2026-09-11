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
	const fixtures = JSON.parse(await readFile(new URL("./fixtures/routing-eval.json", import.meta.url), "utf8")) as Array<{ id: string; prompt: string; expected: "light" | "frontier" }>;
	const targets = [target("gateway/openrouter/free", 0), target("gateway/openai/gpt-5.6-luna", 10)];
	let correct = 0;
	let overRouted = 0;
	let underRouted = 0;
	let cost = 0;
	for (const fixture of fixtures) {
		const selected = planRoute({ targets, profile: analyzeTask({ prompt: fixture.prompt }) })?.target.id;
		const selectedTier = selected === "gateway/openrouter/free" ? "light" : "frontier";
		if (selectedTier === fixture.expected) correct++;
		if (fixture.expected === "light" && selectedTier === "frontier") overRouted++;
		if (fixture.expected === "frontier" && selectedTier === "light") underRouted++;
		if (selectedTier === "frontier") cost += 10;
	}
	const scorecard = {
		cases: fixtures.length,
		accuracy: correct / fixtures.length,
		overRoutingRate: overRouted / fixtures.filter((fixture) => fixture.expected === "light").length,
		underRoutingRate: underRouted / fixtures.filter((fixture) => fixture.expected === "frontier").length,
		costIndexVsAlwaysFrontier: cost / (fixtures.length * 10),
	};
	console.log(`routing eval ${JSON.stringify(scorecard)}`);
	assert.ok(scorecard.accuracy >= 0.9, "routing accuracy regressed below 90%");
	assert.ok(scorecard.overRoutingRate <= 0.1, "too many simple tasks use the frontier model");
	assert.ok(scorecard.underRoutingRate <= 0.1, "too many hard tasks use the light model");
	assert.ok(scorecard.costIndexVsAlwaysFrontier <= 0.6, "estimated routing cost savings regressed");
});
