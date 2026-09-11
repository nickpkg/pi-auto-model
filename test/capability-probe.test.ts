import assert from "node:assert/strict";
import test from "node:test";
import { probePiCapabilities } from "../src/pi/capability-probe.ts";

test("reports current-request retry as an optional Pi capability", () => {
	const withoutRetry = probePiCapabilities({
		on() {},
		registerCommand() {},
		setModel: async () => true,
		setThinkingLevel() {},
		appendEntry() {},
	} as never);
	assert.equal(withoutRetry.ok, true);
	assert.equal(withoutRetry.optional.retryProviderRequest, false);

	const withRetry = probePiCapabilities({
		on() {},
		registerCommand() {},
		setModel: async () => true,
		setThinkingLevel() {},
		appendEntry() {},
		retryProviderRequest() {},
	} as never);
	assert.equal(withRetry.optional.retryProviderRequest, true);
});
