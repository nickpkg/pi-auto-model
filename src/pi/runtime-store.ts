import type { Model } from "@earendil-works/pi-ai";
import {
	createInitialState,
	type RecordedDecision,
	type SessionRuntimeState,
} from "../types.ts";
import { SessionLock } from "./session-lock.ts";

export interface ForkStateSnapshot {
	activation: SessionRuntimeState["activation"];
	sessionRoute: SessionRuntimeState["sessionRoute"];
	manualOverrides: SessionRuntimeState["manualOverrides"];
	generation: number;
	initialPromptHandled: boolean;
}

export class RuntimeStateStore {
	private readonly states = new Map<string, SessionRuntimeState>();
	private readonly pendingForks: ForkStateSnapshot[] = [];

	getOrCreate(sessionId: string, model?: Model<any>): SessionRuntimeState {
		const existing = this.states.get(sessionId);
		if (existing) {
			existing.updatedAt = Date.now();
			return existing;
		}

		const state = createInitialState(sessionId, model, new SessionLock());
		this.states.set(sessionId, state);
		return state;
	}

	get(sessionId: string): SessionRuntimeState | undefined {
		return this.states.get(sessionId);
	}

	delete(sessionId: string): void {
		this.states.delete(sessionId);
	}

	recordDecision(state: SessionRuntimeState, decision: RecordedDecision): void {
		state.lastDecision = decision;
		state.decisionHistory.unshift(decision);
		state.decisionHistory.splice(20);
		state.updatedAt = Date.now();
	}

	queueFork(parent: SessionRuntimeState): void {
		this.pendingForks.push({
			activation: parent.pendingActivation ?? parent.activation,
			sessionRoute: { ...parent.sessionRoute },
			manualOverrides: { ...parent.manualOverrides },
			generation: parent.generation + 1,
			initialPromptHandled: true,
		});
	}

	consumeFork(sessionId: string, model?: Model<any>): SessionRuntimeState | undefined {
		const snapshot = this.pendingForks.shift();
		if (!snapshot) {
			return undefined;
		}

		const state = createInitialState(sessionId, model, new SessionLock());
		state.activation = snapshot.activation;
		state.sessionRoute = { ...snapshot.sessionRoute };
		state.manualOverrides = { ...snapshot.manualOverrides };
		state.generation = snapshot.generation;
		state.initialPromptHandled = snapshot.initialPromptHandled;
		this.states.set(sessionId, state);
		return state;
	}

	clear(): void {
		this.states.clear();
		this.pendingForks.length = 0;
	}

	get size(): number {
		return this.states.size;
	}
}
