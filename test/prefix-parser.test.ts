import assert from "node:assert/strict";
import test from "node:test";
import {
	parsePrefixPin,
	hasPrefixPin,
	modeToMinimumTier,
} from "../src/task/prefix-parser.ts";

test("parses @low mode prefix", () => {
	const pin = parsePrefixPin("@low summarize this file");
	assert.equal(pin.mode, "low");
	assert.equal(pin.modelTargetId, undefined);
	assert.equal(pin.strippedPrompt, "summarize this file");
});

test("parses @medium mode prefix", () => {
	const pin = parsePrefixPin("@medium implement this small change");
	assert.equal(pin.mode, "medium");
	assert.equal(pin.strippedPrompt, "implement this small change");
});

test("parses @high mode prefix", () => {
	const pin = parsePrefixPin("@high debug this failing test");
	assert.equal(pin.mode, "high");
	assert.equal(pin.strippedPrompt, "debug this failing test");
});

test("parses @ultra mode prefix", () => {
	const pin = parsePrefixPin("@ultra review this architecture");
	assert.equal(pin.mode, "ultra");
	assert.equal(pin.strippedPrompt, "review this architecture");
});

test("parses @model: prefix with exact target", () => {
	const pin = parsePrefixPin("@model:anthropic/claude-opus-5 use this exact model");
	assert.equal(pin.mode, undefined);
	assert.equal(pin.modelTargetId, "anthropic/claude-opus-5");
	assert.equal(pin.strippedPrompt, "use this exact model");
});

test("is case-insensitive for mode prefixes", () => {
	const pin = parsePrefixPin("@HIGH debug this");
	assert.equal(pin.mode, "high");
	assert.equal(pin.strippedPrompt, "debug this");
});

test("handles leading whitespace before prefix", () => {
	const pin = parsePrefixPin("  @low  do something");
	assert.equal(pin.mode, "low");
	assert.equal(pin.strippedPrompt, "do something");
});

test("returns original prompt when no prefix is present", () => {
	const pin = parsePrefixPin("just a normal prompt");
	assert.equal(pin.mode, undefined);
	assert.equal(pin.modelTargetId, undefined);
	assert.equal(pin.strippedPrompt, "just a normal prompt");
});

test("does not match prefix in the middle of the prompt", () => {
	const pin = parsePrefixPin("please @high do something");
	assert.equal(pin.mode, undefined);
	assert.equal(pin.strippedPrompt, "please @high do something");
});

test("hasPrefixPin detects and rejects correctly", () => {
	assert.equal(hasPrefixPin("@low test"), true);
	assert.equal(hasPrefixPin("@model:openai/gpt-5 test"), true);
	assert.equal(hasPrefixPin("no prefix here"), false);
});

test("modeToMinimumTier maps modes to tiers", () => {
	assert.equal(modeToMinimumTier("low"), "light");
	assert.equal(modeToMinimumTier("medium"), "mid");
	assert.equal(modeToMinimumTier("high"), "strong");
	assert.equal(modeToMinimumTier("ultra"), "frontier");
});

test("preserves original prompt when stripped result is empty", () => {
	const pin = parsePrefixPin("@low");
	assert.equal(pin.mode, "low");
	// When the stripped prompt would be empty, return the original.
	assert.equal(pin.strippedPrompt, "@low");
});
