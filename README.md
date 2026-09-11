# Pi Auto Model

Native, explainable automatic model routing for the [Pi coding agent](https://github.com/earendil-works/pi).

Pi Auto Model chooses an authenticated Pi model for each task based on task complexity, model capability, context size, vision support, cost, health, policy, and explicit feedback. It uses Pi's native model selection and provider request path.

## Why use it

- Use one automatic entry from Pi's built-in `/model` selector.
- Prefer lower-cost models for simple tasks.
- Escalate debugging, reasoning, long-context, and vision tasks when needed.
- Keep manual model selection authoritative.
- Avoid unhealthy models with circuit breaking.
- Fail over to an untried target on a later eligible task.
- See why a model was selected.
- Inspect local success, latency, and estimated cost metrics.

## What it is not

Pi Auto Model is a routing extension, not a new model provider.

- `pi-auto-model/auto` is a virtual control model, not an LLM endpoint.
- Model requests continue through Pi's native provider path.
- The extension does not proxy streams.
- The extension does not silently replay a failed request.
- Estimated cost is calculated from Pi model pricing metadata. It is not a provider invoice or quota reading.

## Requirements

- Pi coding agent `>=0.85.1 <0.86.0`
- Node.js `>=22.19.0`
- At least one authenticated Pi model

The project is tested with Pi `0.85.1` and Node.js `22.19.0`. Other Pi versions are not currently in the supported range.

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
   ```

Pi Auto Model selects a concrete model before the task starts. The selected model remains visible through Pi's native model state.

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
| `/auto-model status` | Show activation, current model, last route, and policy |
| `/auto-model why` | Explain the latest routing decision |
| `/auto-model models` | List eligible models |
| `/auto-model providers` | List eligible providers |
| `/auto-model history` | Show recent routing decisions |
| `/auto-model metrics` | Show aggregate success rate, latency, and estimated cost |
| `/auto-model doctor` | Diagnose candidates, authentication, capabilities, circuits, and feedback |
| `/auto-model mode balanced` | Balance capability, cost, and target stickiness |
| `/auto-model mode best` | Prefer capability and quality |
| `/auto-model mode price` | Prefer lower-cost eligible models |
| `/auto-model mode fast` | Prefer a stable current target |
| `/auto-model pin provider/model` | Pin a target for this session |
| `/auto-model unpin` | Clear the target pin |
| `/auto-model thinking auto` | Let Pi Auto Model choose thinking level |
| `/auto-model thinking pi` | Keep Pi's current thinking level |
| `/auto-model thinking fixed high` | Force a thinking level |
| `/auto-model feedback good` | Give positive feedback for the latest decision |
| `/auto-model feedback bad too shallow` | Give negative feedback with a reason |
| `/auto-model feedback bad provider/model reason` | Give feedback for an explicit target |

Feedback changes a target preference by `0.02` per vote and caps it at `-0.10` to `+0.10`.

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
  "budget": {
    "maxUsdPerTask": 0.05,
    "onExceed": "warn"
  },
  "classifier": {
    "enabled": false,
    "confidenceThreshold": 0.5,
    "timeoutMs": 400
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
| `price` | Prefer the lowest-cost model that meets the quality floor |
| `fast` | Prefer target stickiness and fewer model switches |

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

#### `budget`

- `maxUsdPerTask`: estimated maximum cost for one task.
- `onExceed`: `warn`, `downgrade`, or `block`.

The estimate uses Pi's model pricing metadata, context tokens, and the task's expected output size. It is not actual provider billing.

#### `classifier`

The optional classifier is disabled by default. When enabled, it is used only when local task analysis has low confidence.

- `enabled`: enable classifier calls.
- `confidenceThreshold`: confidence below which classification may run.
- `timeoutMs`: classifier timeout, capped internally at two seconds.

Only a short prompt excerpt is sent when this feature is enabled. Failures fall back to local analysis.

## Model scope

Pi Auto Model only considers models that:

- are available in Pi's current scope,
- have configured authentication,
- are not excluded by constraints,
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

1. Analyzes the task locally.
2. Resolves scoped and authenticated candidates.
3. Applies constraints.
4. Removes open circuits.
5. Filters context, output, and vision incompatibilities.
6. Scores capability, cost, stickiness, policy, and feedback.
7. Selects a thinking level.
8. Applies the route through Pi's native `setModel()` and `setThinkingLevel()` APIs.

HTTP `429` and `5xx` responses are recorded against the active target. Repeated failures open a circuit with exponential cooldown.

The next eligible task carries the failed target and attempted-target history forward. It prefers an untried target representing the same logical model, then falls back to another healthy candidate. Pi Auto Model does not silently replay the failed request.

During compaction, the extension may temporarily use an authenticated, context-fitting, lower-cost model with thinking disabled. It restores the previous model after compaction succeeds or fails.

Forked sessions inherit activation and session settings, but not an in-flight task.

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

Stored metrics include:

- per-target attempts,
- success and failure counts,
- response status,
- latency,
- estimated cost,
- aggregate Provider statistics.

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

## Project structure

```text
extensions/auto-model.ts      Pi extension entry point
src/routing/                  Candidate resolution, planning, failover, feedback
src/task/                     Local analyzer and optional classifier
src/models/                   Model identity and capability logic
src/pi/                       Pi API adapters and lifecycle handling
src/health/                   Circuit breaker
src/metrics/                  Local latency, success, and cost metrics
src/budget/                   Cost estimation and budget policy
src/config/                   Defaults and configuration loading
src/storage/                  JSONL persistence
src/ui/                      /auto-model commands and status bar
test/                         Unit tests
```

## License

MIT. See [LICENSE](./LICENSE).
