import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	compatibilityAction,
	stripThinkingForRequest,
} from "../src/compat/guard.ts";
import { chooseFailoverTarget } from "../src/routing/failover.ts";
import type { RouteTarget } from "../src/types.ts";

function target(provider: string, id: string): RouteTarget {
	return {
		id: `${provider}/${id}`,
		model: { provider, id, name: id } as Model<any>,
	};
}

test("prefers an untried target for the same logical model during failover", () => {
	const first = target("provider-a", "deepseek/deepseek-v4");
	const sameLogicalModel = target("provider-b", "deepseek/deepseek-v4");
	const differentModel = target("provider-c", "openai/gpt-5");

	const selected = chooseFailoverTarget(
		[first, sameLogicalModel, differentModel],
		first.id,
		[first.id],
	);

	assert.equal(selected?.id, sameLogicalModel.id);
});

test("does not retry targets already attempted by the same task", () => {
	const first = target("provider-a", "deepseek/deepseek-v4");
	const second = target("provider-b", "deepseek/deepseek-v4");

	const selected = chooseFailoverTarget(
		[first, second],
		first.id,
		[first.id, second.id],
	);

	assert.equal(selected, undefined);
});

test("keeps same-API requests untouched", () => {
	assert.equal(
		compatibilityAction(["openai-completions"], "openai-completions"),
		"keep",
	);
});

test("strips thinking only from a cross-API request copy", () => {
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "answer" },
			],
		},
	];
	const stripped = stripThinkingForRequest(messages);

	assert.equal(compatibilityAction(["anthropic-messages"], "openai-completions"), "strip-thinking");
	assert.equal((stripped[0] as { content: unknown[] }).content.length, 1);
	assert.equal(messages[0].content.length, 2);
	assert.notEqual(stripped[0], messages[0]);
});
