# Pi Auto Model

Native, explainable automatic model routing for the [Pi coding agent](https://github.com/earendil-works/pi).

Pi Auto Model chooses an authenticated Pi model for each task based on task complexity, model capability, context size, vision support, cost, health, policy, and explicit feedback. It uses Pi's native model selection and a virtual `streamSimple` proxy that delegates to the real provider and can fail over within the same request.

## Why use it

- Use one automatic entry from Pi's built-in `/model` selector.
- Prefer lower-cost models for simple tasks.
- Escalate debugging, reasoning, long-context, and vision tasks when needed.
- Keep manual model selection authoritative.
- Avoid unnecessary model switches with cache-aware stickiness that quantifies prompt-cache write tax against warm-read savings.
- Avoid unhealthy models with circuit breaking.
- Fail over to an untried target on a later eligible task, or within the same request before substantive output.
- Use explicit catalog capability priors, or opt into bundled Ramp SWE-Bench / Artificial Analysis scores.
- Prefer Providers with lower configured quota pressure.
- See why a model was selected.
- Preview a route without sending a request or incurring model cost.
- Inspect local success, latency, cost, quota, budget, and hourly trend metrics.
- Use the core API to resolve routes programmatically from other extensions.

## What it is not

Pi Auto Model is a routing extension, not a new model provider.

- `pi-auto-model/auto` is a virtual control model, not an LLM endpoint.
- The virtual model's `streamSimple` handler proxies the real provider's stream internally and can fail over to another target within the same request before any substantive output reaches the user. Once text or tool-call content has been flushed, failover is never attempted.
- Estimated cost is calculated from Pi model pricing metadata. Each dispatched attempt reserves budget, including retries and tool-loop continuations. Positive reported cost reconciles that reservation and is attributed to the actual target; routing cost calibration uses these samples. Subscription/OAuth responses that report zero cost remain "unknown" and retain their reservation. Local UVI is not a provider invoice or billing-balance reading.

## Requirements

- Pi coding agent `>=0.74.0` (load-tested against the earliest published `0.74.0` and developed against `0.85.1`; no maximum version is imposed)
- Node.js `>=22.19.0`
- At least one authenticated Pi model

The extension uses runtime capability probes to gracefully degrade when Pi APIs are unavailable on older or alternative runtimes (e.g. Oh My Pi). Required APIs (`on`, `setModel`, `setThinkingLevel`, `registerProvider`, `scopedModels`, `modelRegistry`) are checked at startup; optional APIs (`isProjectTrusted`, `getContextUsage`) fall back safely when missing.

## Install

Install from npm:

```bash
pi install npm:pi-auto-model
```

Update an existing installation:

```bash
pi update npm:pi-auto-model
```

Try the extension without installing it:

```bash
pi -e npm:pi-auto-model
```

Install a local checkout:

```bash
pi install /absolute/path/to/pi-auto-model
```

## Quick start

1. Configure and authenticate at least one model in Pi. Two or more models are recommended for useful routing and failover.
2. Start Pi with Pi Auto Model installed.
3. New sessions start in automatic mode by default.
4. To enable it explicitly, run `/model` and select:

   ```text
   pi-auto-model/auto
   ```

5. Send a task.
6. Inspect the route:

   ```text
   /auto-model status
   /auto-model why
   /auto-model plan Review this architecture and propose a migration plan
   ```

Pi Auto Model plans a concrete target before the task starts. Pi's selected model remains `pi-auto-model/auto`; the status line and routing diagnostics show the real target, including same-request failover.

### Inline prefix pins

On the **first user turn** of a new conversation, you may pin the initial capability mode or exact model with a leading prefix:

```text
@low summarize this file
@medium implement this small change
@high debug this failing test
@ultra review this architecture
@model:anthropic/claude-opus-5 use this exact model
```

The prefix is stripped before the model receives the prompt. Later-turn prefixes are ignored because they would carry the existing session context into a new model and lose its prompt cache.

An exact pin that is unavailable or violates hard constraints blocks the request. The router does not silently substitute an unrelated model.

## Automatic and manual mode

Pi Auto Model uses a virtual model as the automatic-mode switch:

```text
pi-auto-model/auto
```

Selecting that entry enables automatic routing for the current session.

Selecting a concrete model from `/model` or cycling models disables automatic routing for the current session. Pi Auto Model shows a notification explaining how to enable it again:

```text
/model
# Select pi-auto-model/auto
```

Automatic model changes made internally by the router do not disable automatic mode.

The setting is session-scoped:

- A new session starts according to `enabled`, which defaults to `true`.
- `/auto-model off` disables routing only for the current session.
- Manual concrete-model selection also disables routing only for the current session.
- `/auto-model on` re-enables routing for the current session.

## Status bar

Pi Auto Model adds a compact footer status such as:

```text
Auto ON · anthropic/claude-sonnet · balanced · anthropic/claude-sonnet
```

The fields are:

1. Automatic mode: `ON`, `OFF`, or `OFF (manual)`.
2. Last routed target.
3. Active routing policy.
4. Current Pi model.

For the full state, use:

```text
/auto-model status
```

## Commands

All commands use the `/auto-model` namespace.

| Command | Purpose |
| --- | --- |
| `/auto-model on` | Enable automatic routing for this session |
| `/auto-model off` | Disable automatic routing for this session |
| `/auto-model status` | Show activation, current model, last route, policy, and pool |
| `/auto-model why` | Explain the latest routing decision |
| `/auto-model models` | List eligible models |
| `/auto-model providers` | List eligible providers |
| `/auto-model history` | Show recent routing decisions |
| `/auto-model metrics` | Show aggregate success rate, latency, and estimated cost |
| `/auto-model quota` | Show Provider quota and UVI status |
| `/auto-model budget` | Show daily, monthly, and Provider budget usage |
| `/auto-model pool` | Show the active pool and configured pools |
| `/auto-model pool <name>` | Use a configured weighted pool for this session |
| `/auto-model pool off` | Clear the session pool override |
| `/auto-model export [json|jsonl]` | Export the local unified event history |
| `/auto-model doctor` | Diagnose candidates, authentication, capabilities, circuits, and feedback |
| `/auto-model mode balanced` | Balance capability, cost, and target stickiness |
| `/auto-model mode best` | Prefer capability and quality |
| `/auto-model mode cost` | Prefer lower-cost eligible models |
| `/auto-model mode fast` | Prefer a stable current target |
| `/auto-model pin provider/model` | Pin a target for this session |
| `/auto-model unpin` | Clear the target pin |
| `/auto-model thinking auto` | Let Pi Auto Model choose thinking level |
| `/auto-model thinking pi` | Keep Pi's current thinking level |
| `/auto-model thinking fixed high` | Force a thinking level |
| `/auto-model feedback good` | Give positive feedback for the latest decision |
| `/auto-model feedback bad too shallow` | Give negative feedback with a reason |
| `/auto-model feedback bad provider/model reason` | Give feedback for an explicit target |

`/auto-model mode ...` also saves the selected mode as the global default for future sessions. Legacy `price` values remain accepted as an alias for `cost`.

Running `/auto-model mode` or `/auto-model thinking` without an argument opens an interactive selector instead of requiring typed input. Typed arguments also support completion: press Tab after `/auto-model mode ` (trailing space) to show the four policies; after `/auto-model thinking ` to show the modes; or after `/auto-model thinking fixed ` to show the levels. Choices can be picked from the list rather than typed from memory.

Feedback changes a target/task-kind preference by `0.02` per vote, caps the learned offset at `-0.10` to `+0.10`, and decays with a 30-day half-life.

## Doctor and diagnostics

Run:

```text
/auto-model doctor
```

Doctor reports:

- Current activation state and current model.
- Pi model scope.
- Current context usage.
- Candidate model count.
- Authentication availability.
- Constraint exclusion reasons.
- Context window size.
- Vision support.
- Circuit breaker state.
- Per-target success, latency, and estimated cost when available.
- Decision history and feedback preferences.
- Whether Pi exposes a current-request retry hook.

Common outcomes:

- `scope-empty`: Pi has no models in the current scope.
- `auth-unavailable`: scoped models have no configured authentication.
- `filtered-by-constraints`: authentication exists, but configuration excludes every candidate.
- `circuit open`: a target recently returned repeated `429` or `5xx` responses.

## Configuration

Pi Auto Model reads the global configuration:

```text
~/.pi/agent/auto-model.json
```

When the project is trusted by Pi, it also reads:

```text
<project>/.pi/auto-model.json
```

The project configuration is merged over the global configuration. Invalid or unreadable configuration fails open and does not prevent Pi from starting.

Example:

```json
{
  "enabled": true,
  "policy": "balanced",
  "pool": "general",
  "constraints": {
    "providerAllow": [
      "anthropic",
      "openai"
    ],
    "modelExclude": [
      "*experimental*"
    ]
  },
  "aliases": {
    "gateway/deepseek/deepseek-v4": "deepseek:deepseek-v4",
    "deepseek/deepseek-v4": "deepseek:deepseek-v4"
  },
  "quota": {
    "enabled": true,
    "windowMs": 86400000,
    "providers": {
      "anthropic": {
        "maxUsd": 10,
        "maxRequests": 100,
        "warningUvi": 0.8,
        "blockUvi": 1
      },
      "openai": {
        "maxRequests": 500,
        "windowMs": 3600000
      }
    }
  },
  "budget": {
    "maxUsdPerTask": 0.05,
    "sessionUsd": 1,
    "dailyUsd": 5,
    "monthlyUsd": 100,
    "onExceed": "downgrade",
    "providers": {
      "anthropic": {
        "dailyUsd": 2,
        "monthlyUsd": 50
      }
    }
  },
  "failover": {
    "maxAttempts": 3
  },
  "pools": {
    "general": {
      "windowHours": 24,
      "allocation": "rolling",
      "fallback": "any",
      "targets": [
        { "id": "openai/gpt-5", "weight": 6 },
        { "id": "anthropic/claude-sonnet", "weight": 4 }
      ]
    }
  },
  "classifier": {
    "enabled": false,
    "confidenceThreshold": 0.5,
    "timeoutMs": 400
  },
  "capabilitySource": "ramp",
  "benchmarkOverrides": {
    "openai/gpt-5": { "ramp": 0.90 }
  },
  "cacheAware": {
    "enabled": true
  },
  "shadow": {
    "enabled": false
  }
}
```

### Configuration fields

#### `enabled`

Controls automatic activation for new sessions.

- `true` (default): start new sessions in automatic mode.
- `false`: keep automatic mode off until `/auto-model on`.

#### `policy`

Supported values:

| Policy | Behavior |
| --- | --- |
| `balanced` | Balance capability, cost, and keeping the current target |
| `best` | Strongly prioritize capability and quality |
| `cost` | Prefer the lowest-cost model that meets the quality floor |
| `fast` | Prefer target stickiness and fewer model switches |

#### `pool`

`pool` selects a configured weighted pool by default. A session can override it with:

```text
/auto-model pool general
/auto-model pool off
```

Each pool contains model targets and positive relative weights:

```json
{
  "pools": {
    "general": {
      "windowHours": 24,
      "allocation": "rolling",
      "fallback": "any",
      "targets": [
        { "id": "openai/gpt-5", "weight": 6 },
        { "id": "anthropic/claude-sonnet", "weight": 4 }
      ]
    }
  }
}
```

Pool routing is weighted-fair, not random. `targets` define a model pool and `providers` can define a Provider pool. `allocation` can be `rolling`, `fixed`, or `daily`; `fallback: "any"` allows non-member candidates when all pool members are unavailable. Allocation combines with capability, cost, latency, stickiness, quota, quality learning, and feedback. A pool never bypasses context, vision, quota, or circuit-breaker checks.

#### `constraints`

- `modelInclude`: only include matching model IDs.
- `modelExclude`: exclude matching model IDs.
- `providerAllow`: only include matching providers.
- `providerDeny`: exclude matching providers.

Constraints are applied after Pi's own scope and authentication checks.

#### `aliases`

Aliases declare that targets from different providers represent the same logical model. The value uses:

```text
provider:model-id
```

Aliases are explicit. Pi Auto Model does not guess that similarly named models are equivalent.

#### `quota`

Quota rules are optional local policy hints. They do not call Provider billing APIs.

- `enabled`: enable quota-aware routing. Default: `true`.
- `windowMs`: local usage window in milliseconds. The window resets after this duration. Default: 24 hours.
- `staleAfterMs`: maximum age for observed Provider headers before they become unknown. Default: 1 hour.
- `providers.<name>.maxUsd`: estimated USD limit for the window.
- `providers.<name>.maxRequests`: request limit for the window.
- `providers.<name>.windowMs`: optional Provider-specific quota window.
- `providers.<name>.warningUvi`: UVI level at which the Provider is marked `warning`. Default: `0.8`.
- `providers.<name>.blockUvi`: actual configured usage level at which the Provider is avoided when another healthy Provider exists. Default: `1.0`. A fast burn rate alone produces `warning`, not `blocked`.

Provider names must match Pi's model `provider` field, for example `anthropic`, `openai`, or `openrouter`.

UVI is calculated as:

```text
usageUvi = max(estimated cost / maxUsd, request count / maxRequests)
velocityUvi = usageUvi / elapsed window fraction
UVI = max(usageUvi, velocityUvi, observed header UVI)
```

If only one limit is configured, only that limit contributes. If no limit is configured, the Provider remains `quota unknown` and is not penalized.

The local UVI is not an invoice, account balance, or guaranteed Provider quota. It is a routing signal based on Pi model pricing metadata and observed requests.

The built-in adapters read standard, OpenAI, and Anthropic rate-limit headers. They do not make billing or quota API requests. Adapter observations become stale after `staleAfterMs`.

#### `budget`

- `maxUsdPerTask`: cumulative reserved/reconciled cost allowance for a task, including its classifier and tool-loop requests. A compaction is accounted as a separate task, including both summaries for a split turn.
- `sessionUsd`: estimated budget for the current Pi session.
- `dailyUsd`: estimated budget for the current system-local day across all Providers.
- `monthlyUsd`: estimated budget for the current system-local month across all Providers.
- `onExceed`: `warn`, `avoid`, `downgrade`, or `block`.
- `providers.<name>.dailyUsd`: estimated daily budget for one Provider.
- `providers.<name>.monthlyUsd`: estimated monthly budget for one Provider.
- `providers.<name>.onExceed`: optional action override for one Provider.

When a global or Provider budget is exceeded, `avoid` skips the affected target, `downgrade` tries a cheaper eligible target when possible, `warn` permits the request, and `block` prevents dispatch. `downgrade` and `warn` are soft limits; use `block` for a hard local gate. Zero is a valid limit.

Planning uses context and expected output size. Immediately before each provider call, the router rechecks the full request context and reserves against its actual output allowance (the caller's `maxTokens`, capped by the model limit, or the model limit by default). This does not truncate output to the task-size heuristic. Consequently a preview can fit while the larger dispatch reservation is rejected. Known positive usage cost replaces the reservation before the next call; missing/zero usage, interrupted streams, and failed reconciliation retain the estimate. Ledger updates use the original session and system-local daily and monthly accounting windows under a cross-process lock.

Input token counts remain heuristic, especially for images and tool schemas. This is a conservative local guard, not a guaranteed provider billing cap; actual charges can exceed estimates. Configure provider-side spending limits when a billing hard stop is required.

#### `failover`

`maxAttempts` bounds next-task failover attempts. Same-request failover is handled separately by the stream proxy, which iterates through the ranked target list within a single request before any substantive output is flushed. A response that has already streamed content or invoked tools is marked unsafe and is not automatically replayed.

`firstOutputTimeoutMs` adds an optional fail-safe on top of `maxAttempts`: when a target produces no substantive output (text or tool call) within the window, the stream proxy treats it as a pre-output failure and fails over to the next ranked target. It is off by default, because reasoning-capable models may legitimately think for a long time before the first token; set it explicitly to cap silent hangs, for example `"failover": { "maxAttempts": 3, "firstOutputTimeoutMs": 120000 }`. The guard never fires after output has reached the user.

#### `classifier`

The optional classifier is disabled by default. When enabled, it is used only when local task analysis has low confidence.

- `enabled`: enable classifier calls.
- `confidenceThreshold`: confidence below which classification may run.
- `timeoutMs`: classifier timeout, capped internally at two seconds.

Only a short prompt excerpt is sent when this feature is enabled. Failures fall back to local analysis. The classifier returns structured output: `complexity`, `kind`, `kinds`, `minTier`, `requiresReasoning`, `requiresVision`, and `highRisk`. Only fields present and valid in the response override the local heuristic.

Classifier candidates obey the same authenticated scope and provider allow/deny rules as task routing. Calls reserve budget and receive an abort signal on timeout. `/auto-model plan` reuses live planning constraints, including pins, pool and budget, but never invokes the classifier or reserves spend; with classification enabled it is explicitly a local estimate.

#### `capabilitySource`

Selects the external benchmark source for capability tier classification.

| Source | Data | Default |
| --- | --- | --- |
| unset | Explicit catalog priors; unknown IDs remain unknown | yes |
| `ramp` | SWE-Bench resolve rate | no |
| `aa` | Artificial Analysis Intelligence Index | no |

When set, `deriveCapabilityPrior` prefers benchmark-backed tier classification (confidence: `high`) over hand-tuned catalog priors. Sources are never mixed. Models without benchmark data fall back to catalog priors.

Route explanations include the capability tier, source (`catalog`, `ramp`, `aa`, or `unknown`) and confidence. Catalog tiers are coarse heuristics, not newly measured benchmark results. Recognized OAuth provider aliases share capability lookup only; they remain separate routing and billing identities.

Bundled scores record their source and retrieval date in code: [Ramp SWE-Bench](https://labs.ramp.com/swebench) and [Artificial Analysis](https://artificialanalysis.ai/leaderboards/models), retrieved 2026-09-11. They are routing priors rather than live benchmark feeds; use `benchmarkOverrides` when newer verified results are available.

| Tier | Ramp resolve rate | AA Intelligence Index |
| --- | --: | --: |
| `frontier` | >= 85% | >= 52 |
| `strong` | 80–<85% | 47–<52 |
| `mid` | 75–<80% | 40–<47 |
| `light` | < 75% | < 40 |

#### `benchmarkOverrides`

User-supplied benchmark score overrides, keyed by `provider/model`. Each entry can contain `ramp` and/or `aa` scores. Overrides are merged over bundled data on a per-field basis.

```json
{
  "benchmarkOverrides": {
    "openai/gpt-5": { "ramp": 0.90, "aa": 55 },
    "custom/my-model": { "ramp": 0.78 }
  }
}
```

#### `cacheAware`

Controls prompt-cache-aware stickiness economics.

- `enabled` (default `true`): when on, the router quantifies cache-write tax and warm-read savings to avoid cache-invalidating model switches. Upgrades are never penalized; only downgrades and lateral moves pay the cache-write tax.

#### `shadow`

- `enabled` (default `false`): compute and record the automatic choice while keeping the current concrete model. This supports low-risk routing evaluation before enabling automatic mode. Pins remain authoritative, and hard context, output, vision, health, quota, and budget rules still apply.

## Model scope

Pi Auto Model only considers models that:

- are available in Pi's current scope,
- have configured authentication,
- are not excluded by constraints,
- meet the minimum capability tier when a prefix mode pin (`@low`/`@medium`/`@high`/`@ultra`) is active,
- are the exact pinned target when a `@model:provider/model` prefix is active,
- fit the task's context and output requirements,
- support vision when the task includes images,
- do not have an open circuit.

If Pi was started with `--models` or `enabledModels`, include the virtual model if you want it in the `/model` selector:

```text
pi-auto-model/auto
```

The virtual model is always excluded from routing candidates.

## Routing, health, and failover

Before a task starts, Pi Auto Model:

1. Parses inline prefix pins (`@low`, `@medium`, `@high`, `@ultra`, `@model:...`) from the first user prompt only.
2. Analyzes the task locally, optionally refining with the structured classifier when confidence is low.
3. Resolves scoped and authenticated candidates.
4. Applies constraints and prefix mode/model filters.
5. Removes open circuits.
6. Avoids quota-blocked or rate-limited Providers when another eligible Provider exists.
7. Filters context, output, and vision incompatibilities.
8. Restricts candidates to the configured pool when one is active.
9. Scores capability (benchmark-backed or catalog prior), cost, latency, reliability learning, cache-aware stickiness, quota pressure, pool fairness, policy, and feedback.
10. Selects a thinking level.
11. Stores the ranked target list for the stream proxy. The model stays as `pi-auto-model/auto`; the proxy calls the real provider's `streamSimple` internally and fails over to the next ranked target when an error occurs before substantive output.

Manual target pins take precedence over pool membership and prefix pins. The pool only influences automatic selection and uses local hourly target-attempt counts, so no request content leaves the machine.

### Cache-aware stickiness

When `cacheAware.enabled` is `true` (default), the router quantifies the economics of switching models:

- **Staying on the current model** earns a bonus proportional to warm-read savings (paying cache-read instead of full input on the cached context).
- **Switching to a less capable model** (downgrade) pays a penalty proportional to the cache-write tax (the one-time cost of writing the full conversation into the new model's cache).
- **Switching to a more capable model** (upgrade) pays no penalty, so capability upgrades are never blocked by cache economics.

This avoids cache-invalidating switches on every turn while still allowing necessary upgrades.

### Same-request failover

The stream proxy iterates through the pre-planned target list within a single request. If the first target errors before any substantive output (text delta or tool call) has been flushed to the user, the proxy transparently retries the next target. The selected plan remains available for every provider call in the same agent/tool loop and is cleared only when the agent settles. Once any substantive event has been forwarded, failover is never attempted, preventing duplicate tool-call execution and inconsistent output. After two tool execution errors in one task, the next model call is upgraded to the strongest eligible candidate; tools themselves are never replayed.

### Fail-safe: preserve routing boundaries

An internal planning exception can use a minimal eligible fallback plan (last known-good route first, bounded by `failover.maxAttempts`). That fallback retains authenticated scope, provider constraints, exact pins, pool restrictions and hard model compatibility. Only a pool explicitly configured with `fallback: "any"` may use non-members.

Intentional stops are never overridden:

- No approved candidates, an unmatched pin, an empty restricted pool, incompatible context/vision/output, exhausted failover attempts, or a blocking budget decision stop the request.
- If a dispatch policy/budget check throws, the target is not called. Missing or broken route state does not trigger unrestricted registry enumeration or direct pass-through.

Telemetry failures are isolated from provider delivery; accounting failures retain the reservation. Three consecutive internal routing failures use the constrained fallback planner for 60 seconds, not an unrestricted provider call. User cancellation and ordinary non-retryable client errors stop immediately. An abandoned stream after text or tool-call output is an error, never a reason to replay the request on another model.

### Next-task failover

HTTP `429` and `5xx` responses are classified as retryable and recorded against the active target. Client, auth, and not-found errors do not open the circuit. Repeated retryable failures open a circuit with exponential cooldown.

When a response includes `Retry-After`, `X-RateLimit-Reset`, or `X-RateLimit-Reset-After`, Pi Auto Model records the reset time as a Provider cooldown. A cooldown is treated as quota pressure until it expires. A fast local burn rate only demotes a Provider; an actual configured limit or an observed zero-remaining header is required for `blocked`. If every candidate is under quota pressure, routing continues with the remaining non-circuit-open candidates instead of blocking Pi completely.

The next eligible task carries the failed target and attempted-target history forward, subject to the configured failover attempt budget. It prefers an untried target representing the same logical model, then falls back to another healthy candidate. `/auto-model doctor` reports whether the installed Pi exposes a current-request retry hook. Streamed responses and tool-call tasks are marked unsafe and are not automatically replayed on the next task. Pi Auto Model does not silently replay the failed request on the next task when that hook is unavailable.

During compaction, the extension calls Pi's native compaction function through an authenticated, scoped, provider-allowed, context-fitting lower-cost target with thinking disabled. Each summary request is budget checked and reconciled independently. The returned result preserves Pi's split-turn and file-operation handling; the selected session model is never changed. If no approved target or budget is available, or summarization fails, compaction is cancelled rather than silently using the virtual model or saving a partial summary.

Forked sessions inherit activation and session settings, but not an in-flight task.

## Core API

Other Pi extensions or external tooling can resolve a model route programmatically without a Pi `ExtensionContext`:

```typescript
import { resolveRoute } from "pi-auto-model/core";

const selection = resolveRoute({
  models: availableModels.map((model) => ({ model, authenticated: true })),
  prompt: "Debug this failing test",
  contextTokens: 12_000,
});

// selection.target   → { id, model }
// selection.thinking → "high"
// selection.reason   → ["debug", "high complexity"]
// selection.rankedTargets → [best, second, ...]
```

The core API uses package defaults and bundled benchmark data. It does not load user-level configuration or perform classifier calls, circuit-breaker checks, quota lookups, or budget enforcement — those require live session state. Use the full extension for production routing with health and budget.

A convenience wrapper is available for raw `Model` objects:

```typescript
import { resolveRouteFromModels } from "pi-auto-model/core";

const selection = resolveRouteFromModels(models, "explain this function", {
  policy: "cost",
});
```

## Metrics and privacy

Metrics are stored locally:

```text
~/.pi/agent/auto-model/metrics.json
```

Decision and feedback records are stored locally:

```text
~/.pi/agent/auto-model/decisions.jsonl
~/.pi/agent/auto-model/feedback.jsonl
```

Global budget usage is stored locally:

```text
~/.pi/agent/auto-model/budget.json
```

Unified request, route, provider response, quota, budget, failover, and feedback events are stored locally:

```text
~/.pi/agent/auto-model/events.jsonl
~/.pi/agent/auto-model/quality.json
```

Stored metrics include:

- per-target attempts,
- success and failure counts,
- response status,
- latency,
- estimated cost,
- latency p50 and p95,
- aggregate Provider statistics.
- hourly attempts by target, success rate, latency, cost, rate limits, and failovers.

Metrics and learned quality updates use a cross-process file lock so concurrent Pi sessions merge their deltas instead of overwriting one another. Learned success is recorded when the whole agent turn settles, including tool-call errors, rather than when an intermediate provider stream finishes.

Provider quota/UVI state is derived from these local metrics and recent rate-limit response headers. Run `/auto-model quota` or `/auto-model doctor` to inspect it.
Run `/auto-model metrics` for the last 24 hourly buckets and `/auto-model budget` for the current budget ledger.

Per-model and per-provider metrics also report TTFT p50/p95 when samples are available. Here TTFT means time from provider invocation to the first text or tool-call output; buffered thinking is not counted as first output. Main-task cost events carry a unique attempt ID and the actual target, so failed and successful failover attempts are not lumped under the initial planned model.
Run `/auto-model history` for persisted route decisions and `/auto-model export json` to export unified events.

The extension does not send remote telemetry. Records do not contain full prompts, repository contents, tool output, or authentication secrets. When the optional classifier is enabled, only a short prompt excerpt is sent through the selected authenticated Pi model.

## Development

Install dependencies:

```bash
npm install
```

Run the complete local check:

```bash
npm run check
```

Preview the npm package:

```bash
npm run pack:check
```

Run the Pi load smoke test without saving a session:

```bash
pi --no-extensions \
  --extension ./extensions/auto-model.ts \
  --no-session \
  --no-tools \
  --print "/auto-model status"
```

`npm publish` runs `prepublishOnly`, which executes the type check, test suite, and package preview first.

CI runs the same checks on pushes and pull requests. The test suite includes a provenance-labeled deterministic routing gate, cross-process budget reconciliation, constrained fallback, cancellation/partial-stream safety, tool-loop accounting, native split compaction, and preview consistency checks. The routing gate's selection accuracy and catalog-cost index are synthetic regression checks, not measured answer quality or real billing savings. See [the evaluation protocol](test/fixtures/routing-eval.PROVENANCE.md) before making production-quality claims.

## Project structure

```text
extensions/auto-model.ts      Pi extension entry point
src/core.ts                   Core API for programmatic route resolution
src/routing/                  Candidate resolution, planning, failover, feedback, quality learning
src/observability/            Unified local event store and export
src/task/                     Local analyzer, optional classifier, prefix pin parser
src/models/                   Model identity, capability logic, and benchmark data
src/pi/                       Pi API adapters, lifecycle, stream proxy, compaction, fork
src/health/                   Circuit breaker and provider error classification
src/metrics/                  Local latency, success, and cost metrics
src/budget/                   Cost estimation and budget policy
src/quota/                    Provider quota UVI calculation and rate-limit header adapters
src/compat/                   Cross-API thinking compatibility guards
src/config/                   Defaults and configuration loading
src/storage/                  JSONL persistence
src/ui/                       /auto-model commands and status bar
test/                         Unit tests
```

## License

MIT. See [LICENSE](./LICENSE).
