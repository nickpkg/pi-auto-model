import type { Model } from "@earendil-works/pi-ai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AutoActivationState = "active" | "suspended-by-user" | "disabled";

export type TaskPhase = "applied" | "running" | "settled";

export interface RouteTarget {
	model: Model<any>;
	id: string;
}

export type IdentityConfidence = "exact" | "declared" | "unknown";
export type IdentitySource = "user" | "catalog" | "canonical" | "isolated";
export type CapabilityTier = "frontier" | "strong" | "mid" | "light" | "unknown";
export type TaskKind =
	| "explain"
	| "code-edit"
	| "generate"
	| "debug"
	| "refactor"
	| "review"
	| "test"
	| "plan"
	| "architecture"
	| "ops"
	| "research"
	| "mixed";

export interface ModelIdentity {
	logicalModelId: string;
	confidence: IdentityConfidence;
	source: IdentitySource;
}

export interface ModelCapabilityPrior {
	source?: "catalog" | "ramp" | "aa" | "unknown";
	overall: CapabilityTier;
	coding?: CapabilityTier;
	reasoning?: CapabilityTier;
	toolUse?: CapabilityTier;
	instructionFollowing?: CapabilityTier;
	confidence: "high" | "medium" | "low";
}

export interface LogicalModel {
	id: string;
	displayName: string;
	identity: ModelIdentity;
	capabilityPrior: ModelCapabilityPrior;
	targets: RouteTarget[];
}

export type RoutingPolicy = "balanced" | "best" | "price" | "fast";

export function normalizeRoutingPolicy(value: unknown): RoutingPolicy | undefined {
	switch (value) {
		case "balanced":
		case "best":
		case "price":
		case "fast":
			return value;
		default:
			return undefined;
	}
}

export interface RouteScore {
	targetId: string;
	quality: number;
	cost: number;
	stickiness: number;
	latency?: number;
	reliability?: number;
	quota?: number;
	pool?: number;
	utility: number;
}

export interface RoutePlan {
	target: RouteTarget;
	thinking: ThinkingLevel;
	policy: RoutingPolicy;
	score: RouteScore;
	reason: string[];
	/** All eligible targets in utility order (best first), for same-request failover. */
	rankedTargets: RouteTarget[];
}

export interface RecordedDecision {
	id: string;
	targetId: string;
	thinking: ThinkingLevel;
	policy: RoutingPolicy;
	reason: string[];
	score: RouteScore;
	taskKinds: TaskKind[];
	createdAt: number;
}
export interface TaskProfile {
	taskId: string;
	kinds: TaskKind[];
	complexity: number;
	demand: {
		coding: number;
		reasoning: number;
		toolUse: number;
		instructionFollowing: number;
		context: number;
		vision: number;
	};
	semantic: {
		debugging: number;
		planning: number;
		architecture: number;
		review: number;
		generation: number;
		explanation: number;
	};
	risk: number;
	latencySensitivity: number;
	costSensitivity: number;
	confidence: number;
	constraints: {
		requiresVision: boolean;
		requiredContextTokens: number;
		requiredOutputTokens: number;
		minimumTier?: CapabilityTier;
	};
}

export interface CandidateConstraints {
	modelInclude?: readonly string[];
	modelExclude?: readonly string[];
	providerAllow?: readonly string[];
	providerDeny?: readonly string[];
}

export interface ProviderQuotaRule {
	maxUsd?: number;
	maxRequests?: number;
	warningUvi?: number;
	blockUvi?: number;
	windowMs?: number;
}

export interface ProviderQuotaConfig {
	enabled: boolean;
	windowMs: number;
	staleAfterMs?: number;
	providers: Record<string, ProviderQuotaRule>;
}

export interface WeightedPoolTarget {
	id: string;
	weight: number;
}

export interface WeightedPoolConfig {
	targets?: WeightedPoolTarget[];
	providers?: WeightedPoolTarget[];
	windowHours?: number;
	allocation?: "rolling" | "fixed" | "daily";
	fallback?: "none" | "any";
}

export type ProviderQuotaStatus = "unknown" | "healthy" | "warning" | "blocked" | "cooldown";

export interface ProviderUsageSnapshot {
	provider: string;
	windowStartedAt: number;
	attempts: number;
	successes: number;
	failures: number;
	estimatedCostUsd: number;
	lastStatus?: number;
	lastRetryAt?: number;
	observedUvi?: number;
	observedAt?: number;
	observedSource?: string;
}

export interface ProviderQuotaObservation {
	uvi?: number;
	retryAt?: number;
	source: string;
}

export interface FailoverConfig {
	maxAttempts: number;
	/**
	 * Optional fail-safe: fail over when a target produces no substantive
	 * output within this many milliseconds. Defaults to off (undefined) to
	 * avoid cutting off slow-thinking models. Only safe to fail over before
	 * any output reaches the user, so this guard applies to the first output
	 * only.
	 */
	firstOutputTimeoutMs?: number;
}

export interface ProviderQuotaSignal {
	provider: string;
	status: ProviderQuotaStatus;
	uvi?: number;
	burnRateUsdPerHour?: number;
	usageUsd: number;
	usageRequests: number;
	maxUsd?: number;
	maxRequests?: number;
	retryAt?: number;
	source: "configured" | "adapter" | "rate-limit" | "unknown";
}

export type CandidateFailureReason =
	| "scope-empty"
	| "auth-unavailable"
	| "filtered-by-constraints";

export interface CandidateFailure {
	reason: CandidateFailureReason;
	message: string;
	models: string[];
}

export interface CandidateDiagnostic {
	id: string;
	authenticated: boolean;
	eligible: boolean;
	reasons: string[];
}

export interface CandidateResolution {
	targets: RouteTarget[];
	diagnostics: CandidateDiagnostic[];
	failure?: CandidateFailure;
}

export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: string;
}

export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	reason: "manual" | "threshold" | "overflow";
	errorMessage?: string;
	aborted: boolean;
	willRetry: boolean;
	fromExtension: boolean;
}

export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

export interface SessionRouteState {
	provider?: string;
	modelId?: string;
	thinking?: ThinkingLevel;
	apisUsed?: string[];
}

export interface RouteFailure {
	status: number;
	at: number;
}

export interface TaskRoutingState {
	requestId: string;
	startedAt: number;
	lastActivityAt: number;
	phase: TaskPhase;
	routeTargetId?: string;
	thinking?: ThinkingLevel;
	profile?: TaskProfile;
	attemptedTargetIds: string[];
	lastFailure?: RouteFailure;
	estimatedCostUsd?: number;
	inputTokens?: number;
	budgetSpentUsd?: number;
	resultRecorded?: boolean;
	quotaObservation?: ProviderQuotaObservation;
	failover?: boolean;
	streamStarted?: boolean;
	toolCallCount?: number;
	toolCallErrors?: number;
	stageEscalated?: boolean;
	finalAttemptSuccess?: boolean;
	actualUsage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		costUsd: number;
		costKnown: boolean;
	};
}

export interface LastFailedRoute {
	targetId: string;
	status: number;
	at: number;
	attemptedTargetIds: string[];
}

export interface SessionOverrides {
	pinnedTargetId?: string;
	pool?: string;
	policy?: RoutingPolicy;
	thinkingMode?: "auto" | "pi" | "fixed";
	fixedThinking?: ThinkingLevel;
}

export interface SessionRuntimeState {
	sessionId: string;
	generation: number;
	activation: AutoActivationState;
	pendingActivation?: AutoActivationState;
	routingPolicy?: RoutingPolicy;
	routingPool?: string;
	sessionRoute: SessionRouteState;
	activeTask?: TaskRoutingState;
	lastFailedRoute?: LastFailedRoute;
	manualOverrides: SessionOverrides;
	inFlightSelfSet: number;
	lastDecision?: RecordedDecision;
	decisionHistory: RecordedDecision[];
	feedbackPreferences: Record<string, number>;
	initialPromptHandled: boolean;
	createdAt: number;
	updatedAt: number;
	lock: import("./pi/session-lock.ts").SessionLock;
}

export function modelTargetId(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

export function createInitialState(
	sessionId: string,
	model: Model<any> | undefined,
	lock: SessionRuntimeState["lock"],
): SessionRuntimeState {
	const now = Date.now();
	return {
		sessionId,
		generation: 0,
		activation: "disabled",
		sessionRoute: model
			? {
					provider: model.provider,
					modelId: model.id,
					apisUsed: [model.api],
				}
			: {},
		manualOverrides: {},
		decisionHistory: [],
		feedbackPreferences: {},
		initialPromptHandled: false,
		inFlightSelfSet: 0,
		createdAt: now,
		updatedAt: now,
		lock,
	};
}
