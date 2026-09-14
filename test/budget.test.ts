import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BudgetLedger,
	evaluateBudget,
	evaluateGlobalBudget,
} from "../src/budget/budget.ts";

test("uses downgrade as the default budget response", () => {
	assert.equal(evaluateBudget(2, { maxUsdPerTask: 1 }), "downgrade");
});

test("supports session budget and avoid action", () => {
	const usage = {
		dayKey: "2026-01-02",
		monthKey: "2026-01",
		sessionUsd: 0.05,
		dailyUsd: 1,
		monthlyUsd: 1,
		providers: {},
	};
	assert.equal(evaluateGlobalBudget(0.1, "provider-a", {
		sessionUsd: 0.05,
		onExceed: "avoid",
	}, usage).action, "avoid");
});

test("honors explicit budget actions", () => {
	assert.equal(evaluateBudget(2, { maxUsdPerTask: 1, onExceed: "warn" }), "warn");
	assert.equal(evaluateBudget(2, { maxUsdPerTask: 1, onExceed: "block" }), "block");
	assert.equal(evaluateBudget(0.5, { maxUsdPerTask: 1, onExceed: "block" }), "allow");
});

test("enforces global and Provider budget limits", () => {
	const usage = {
		dayKey: "2026-01-02",
		monthKey: "2026-01",
		dailyUsd: 4,
		monthlyUsd: 9,
		providers: {
			anthropic: { dailyUsd: 1, monthlyUsd: 3 },
		},
	};
	const decision = evaluateGlobalBudget(2, "anthropic", {
		dailyUsd: 5,
		monthlyUsd: 10,
		onExceed: "block",
		providers: {
			anthropic: { dailyUsd: 2 },
		},
	}, usage);

	assert.equal(decision.action, "block");
	assert.deepEqual(decision.exceeded, ["daily", "monthly", "anthropic daily"]);
});

test("persists and rotates budget usage by UTC day and month", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-model-budget-"));
	const filePath = join(directory, "budget.json");
	const firstDay = Date.UTC(2026, 0, 31, 12);
	const nextMonth = Date.UTC(2026, 1, 1, 12);
	const ledger = new BudgetLedger();
	await ledger.load(filePath, firstDay);
	ledger.startSession("session-1", firstDay);
	ledger.record("openai", 1.25, firstDay);
	await ledger.flush(firstDay);

	const restored = new BudgetLedger();
	await restored.load(filePath, firstDay);
	assert.equal(restored.snapshot(firstDay).dailyUsd, 1.25);
	assert.equal(restored.snapshot(nextMonth).dailyUsd, 0);
	assert.equal(restored.snapshot(nextMonth).monthlyUsd, 0);
	assert.equal(restored.snapshot(firstDay).sessionUsd, 1.25);
	assert.equal(restored.snapshot(firstDay).history?.length, 1);
	assert.match(await readFile(filePath, "utf8"), /"version": 1/);
});

test("serializes budget reservations across Pi processes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-model-budget-"));
	const filePath = join(directory, "budget.json");
	const first = new BudgetLedger();
	const second = new BudgetLedger();
	await Promise.all([first.load(filePath), second.load(filePath)]);
	first.startSession("session-1");
	second.startSession("session-2");
	const decisions = await Promise.all([
		first.reserve("openai", 1, { dailyUsd: 1.5, onExceed: "block" }),
		second.reserve("anthropic", 1, { dailyUsd: 1.5, onExceed: "block" }),
	]);
	assert.deepEqual(decisions.map((decision) => decision.action).sort(), ["allow", "block"]);
	const restored = new BudgetLedger();
	await restored.load(filePath);
	assert.equal(restored.snapshot().dailyUsd, 1);
});

test("reconciles reservations across processes, sessions and month boundaries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-budget-reconcile-"));
	const path = join(directory, "budget.json");
	const at = Date.UTC(2026, 0, 31, 23, 59);
	const now = Date.UTC(2026, 1, 1, 0, 1);
	const first = new BudgetLedger();
	const second = new BudgetLedger();
	await Promise.all([first.load(path, at), second.load(path, at)]);
	await first.reserve("a", 1, {}, at, "s1");
	await second.reserve("b", 2, {}, now, "s2");
	await first.reconcile({ provider: "a", estimate: 1, at, sessionId: "s1" }, 0.25, now);
	const restored = new BudgetLedger();
	await restored.load(path, now);
	const usage = restored.snapshot(now);
	assert.equal(usage.dailyUsd, 2);
	assert.equal(usage.monthlyUsd, 2);
	assert.equal(usage.sessions?.s1, 0.25);
	assert.equal(usage.sessions?.s2, 2);
	assert.equal(usage.history?.[0].usd, 0.25);
	assert.equal(evaluateBudget(0.1, { maxUsdPerTask: 0, onExceed: "block" }), "block");
});
