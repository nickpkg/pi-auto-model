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
	ledger.record("openai", 1.25, firstDay);
	await ledger.flush(firstDay);

	const restored = new BudgetLedger();
	await restored.load(filePath, firstDay);
	assert.equal(restored.snapshot(firstDay).dailyUsd, 1.25);
	assert.equal(restored.snapshot(nextMonth).dailyUsd, 0);
	assert.equal(restored.snapshot(nextMonth).monthlyUsd, 0);
	assert.match(await readFile(filePath, "utf8"), /"version": 1/);
});
