export interface CircuitState {
	consecutiveFailures: number;
	retryAt?: number;
	lastStatus?: number;
}

export class CircuitBreaker {
	private readonly circuits = new Map<string, CircuitState>();

	record(targetId: string, status: number, now = Date.now(), retryAt?: number): void {
		if (status < 400) {
			this.circuits.delete(targetId);
			return;
		}
		const previous = this.circuits.get(targetId);
		const failures = (previous?.consecutiveFailures ?? 0) + 1;
		const cooldown = Math.min(60_000 * 2 ** (failures - 1), 10 * 60_000);
		this.circuits.set(targetId, {
			consecutiveFailures: failures,
			lastStatus: status,
			retryAt: Math.max(now + cooldown, retryAt ?? 0),
		});
	}

	isOpen(targetId: string, now = Date.now()): boolean {
		const retryAt = this.circuits.get(targetId)?.retryAt;
		return retryAt !== undefined && retryAt > now;
	}

	snapshot(): ReadonlyMap<string, CircuitState> {
		return this.circuits;
	}
}
