import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyProviderError,
	shouldOpenCircuit,
	isSignatureError,
	classifyDetailedError,
} from "../src/health/provider-errors.ts";

test("classifies retryable and unsafe provider failures", () => {
	assert.equal(classifyProviderError(429).retryable, true);
	assert.equal(classifyProviderError(503).retryable, true);
	assert.equal(classifyProviderError(400).retryable, false);
	assert.equal(classifyProviderError(503, true, false).unsafeToReplay, true);
	assert.equal(shouldOpenCircuit(400), false);
	assert.equal(shouldOpenCircuit(500), true);
});

test("detects Gemini thought_signature 400 errors", () => {
	assert.equal(isSignatureError(400, "thought_signature mismatch"), true);
	assert.equal(isSignatureError(400, "invalid thinking_signature"), true);
	assert.equal(isSignatureError(400, "signature and thinking blocks mismatch"), true);
	// Non-signature 400 errors.
	assert.equal(isSignatureError(400, "invalid request body"), false);
	assert.equal(isSignatureError(401, "thought_signature mismatch"), false);
	assert.equal(isSignatureError(503, "thought_signature mismatch"), false);
});

test("classifyDetailedError marks signature errors as retryable but not opensCircuit", () => {
	const sig = classifyDetailedError(400, "thought_signature mismatch", false, false);
	assert.equal(sig.signatureError, true);
	assert.equal(sig.retryable, true);
	assert.equal(sig.opensCircuit, false);

	const rateLimit = classifyDetailedError(429, "rate limited", false, false);
	assert.equal(rateLimit.signatureError, false);
	assert.equal(rateLimit.retryable, true);
	assert.equal(rateLimit.opensCircuit, true);

	const serverError = classifyDetailedError(503, "server error", false, false);
	assert.equal(serverError.signatureError, false);
	assert.equal(serverError.retryable, true);
	assert.equal(serverError.opensCircuit, true);

	const clientError = classifyDetailedError(400, "bad request", false, false);
	assert.equal(clientError.signatureError, false);
	assert.equal(clientError.retryable, false);
	assert.equal(clientError.opensCircuit, false);
});
