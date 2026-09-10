export function applyFeedback(current: number, feedback: "good" | "bad"): number {
	const delta = feedback === "good" ? 0.02 : -0.02;
	return Math.max(-0.1, Math.min(0.1, current + delta));
}
