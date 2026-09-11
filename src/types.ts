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
	utility: number;
}

export interface RoutePlan {
	target: RouteTarget;
	thinking: ThinkingLevel;
	policy: RoutingPolicy;
	score: RouteScore;
	reason: string[];
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
	};
}

export interface CandidateConstraints {
	modelInclude?: readonly string[];
	modelExclude?: readonly string[];
	providerAllow?: readonly string[];
	providerDeny?: readonly string[];
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
	startedAt: number;
	lastActivityAt: number;
	phase: TaskPhase;
	routeTargetId?: string;
	thinking?: ThinkingLevel;
	profile?: TaskProfile;
	attemptedTargetIds: string[];
	lastFailure?: RouteFailure;
	estimatedCostUsd?: number;
	resultRecorded?: boolean;
}

export interface LastFailedRoute {
	targetId: string;
	status: number;
	at: number;
	attemptedTargetIds: string[];
}

export interface SessionOverrides {
	pinnedTargetId?: string;
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
	sessionRoute: SessionRouteState;
	activeTask?: TaskRoutingState;
	lastFailedRoute?: LastFailedRoute;
	manualOverrides: SessionOverrides;
	compactionSuspend?: {
		savedTargetId: string;
		savedThinking: ThinkingLevel;
	};
	inFlightSelfSet: number;
	lastDecision?: RecordedDecision;
	decisionHistory: RecordedDecision[];
	feedbackPreferences: Record<string, number>;
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
		inFlightSelfSet: 0,
		createdAt: now,
		updatedAt: now,
		lock,
	};
}
