/**
 * Three-state circuit breaker: closed → open → half-open → closed/open.
 *
 * - **closed**: target is healthy; requests pass normally.
 * - **open**: target is failing; requests are blocked until `retryAt`.
 * - **half-open**: cooldown has expired; one probe request is allowed to
 *   test recovery. If the probe succeeds, the circuit closes. If it fails,
 *   the circuit re-opens with continued exponential backoff.
 *
 * The `probeInFlight` flag prevents multiple sessions from probing the same
 * half-open target concurrently.
 */
export type CircuitStatus = "closed" | "open" | "half-open";

export interface CircuitState {
	consecutiveFailures: number;
	retryAt?: number;
	lastStatus?: number;
	status: CircuitStatus;
	probeInFlight?: boolean;
}

export class CircuitBreaker {
	private readonly circuits = new Map<string, CircuitState>();

	record(targetId: string, status: number, now = Date.now(), retryAt?: number): void {
		if (status < 400) {
			// Success: close the circuit and clear any probe state.
			this.circuits.delete(targetId);
			return;
		}
		if (status !== 429 && status < 500) {
			return;
		}
		const previous = this.circuits.get(targetId);
		const failures = (previous?.consecutiveFailures ?? 0) + 1;
		const cooldown = Math.min(60_000 * 2 ** (failures - 1), 10 * 60_000);
		this.circuits.set(targetId, {
			consecutiveFailures: failures,
			lastStatus: status,
			status: "open",
			retryAt: Math.max(now + cooldown, retryAt ?? 0),
			probeInFlight: false,
		});
	}

	isOpen(targetId: string, now = Date.now()): boolean {
		const state = this.circuits.get(targetId);
		if (!state) {
			return false;
		}
		if (state.status === "closed" || state.status === "half-open") {
			return false;
		}
		// status === "open": check if cooldown has expired.
		if (state.retryAt === undefined || state.retryAt <= now) {
			// Cooldown expired: transition to half-open, allowing one probe.
			state.status = "half-open";
			state.probeInFlight = false;
			return false;
		}
		return true;
	}

	/**
	 * Attempts to acquire a probe slot for a half-open target.
	 * Returns `true` if the target is half-open and no probe is in flight.
	 * Returns `false` if the target is closed (no probe needed) or if a
	 * probe is already in flight (caller should skip this target).
	 *
	 * Callers that receive `true` must eventually call `record()` (on
	 * success or failure) or `releaseProbe()` (if skipping before
	 * attempting a request) to release the slot.
	 */
	tryAcquireProbe(targetId: string, now = Date.now()): boolean {
		this.isOpen(targetId, now); // Trigger open → half-open transition.
		const state = this.circuits.get(targetId);
		if (!state || state.status !== "half-open") {
			return false;
		}
		if (state.probeInFlight) {
			return false;
		}
		state.probeInFlight = true;
		return true;
	}

	/**
	 * Releases a probe slot without recording a result. Use when a target
	 * is skipped before a request is attempted (e.g. auth not configured).
	 */
	releaseProbe(targetId: string): void {
		const state = this.circuits.get(targetId);
		if (state) {
			state.probeInFlight = false;
		}
	}

	/**
	 * Returns the current circuit status, triggering the open → half-open
	 * transition if the cooldown has expired.
	 */
	getState(targetId: string, now = Date.now()): CircuitStatus {
		this.isOpen(targetId, now);
		return this.circuits.get(targetId)?.status ?? "closed";
	}

	snapshot(): ReadonlyMap<string, CircuitState> {
		return this.circuits;
	}
}
