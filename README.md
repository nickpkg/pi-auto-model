# Pi Autoroute

Automatic model routing for the [Pi coding agent](https://github.com/earendil-works/pi).

Autoroute selects a suitable model, provider, and thinking level before each new task. It considers task complexity, capability, cost, context limits, health, user policy, and explicit feedback while preserving Pi's native model and session behavior.

## Status

This project is a working v1 extension.

Implemented:

- Per-task model and provider routing
- Thinking-level selection
- `scopedModels`, authentication, project trust, and allow/deny constraints
- Cost-aware policies and per-task budget checks
- Provider failure tracking and circuit breaking
- Same-logical-model-first failover
- Compaction routing to a cheap model, followed by restoration
- Fork state inheritance
- Cross-provider thinking compatibility protection
- Explainable routing decisions and bounded history
- Optional low-cost task classifier
- Conservative explicit-feedback learning

Intentionally not implemented:

- Virtual Provider or a virtual `autoroute/auto` model
- Stream proxying or transparent mid-task model replacement
- Online Bayesian quality learning
- Shadow routing and model exploration

Autoroute does not replace Pi's `/model` command. Explicit user model selection remains authoritative.

## Requirements

- Pi coding agent
- Node.js with TypeScript support
- A Pi version compatible with the extension API
- At least one authenticated Pi model

The current development setup is tested with Pi `0.85.1`.

## Installation

### Install from npm

```bash
pi install npm:pi-autoroute
```

### Install from GitHub

```bash
pi install git:github.com/nickpkg/pi-autoroute
```

Pi will add the package to its extension settings. Autoroute is enabled automatically by default when Pi starts.

Check the current state with:

```text
/route status
```

To load the extension temporarily without installing it:

```bash
pi --extension ./extensions/autoroute.ts
```

## Quick start

1. Configure and authenticate at least two models in Pi.
2. Start Pi with Autoroute installed. It starts enabled by default.
3. Inspect the current state:

   ```text
   /route status
   ```

4. Send a task.
5. Inspect the decision:

   ```text
   /route why
   /route history
   ```

Turn routing off for the current session with:

```text
/route off
```

Autoroute is session-scoped. `/route off` disables it for the current session only. A later session starts according to the `enabled` configuration setting.

## Commands

All commands use the `/route` namespace.

| Command | Description |
| --- | --- |
| `/route on` | Enable Autoroute for the current session |
| `/route off` | Disable Autoroute for the current session |
| `/route status` | Show activation and current route state |
| `/route why` | Explain the most recent routing decision |
| `/route models` | List eligible models |
| `/route providers` | List eligible providers |
| `/route history` | Show recent routing decisions |
| `/route doctor` | Show candidate, compatibility, and feedback diagnostics |
| `/route mode balanced` | Use balanced routing |
| `/route mode best` | Prefer capability and quality |
| `/route mode price` | Prefer lower-cost models that meet the quality floor |
| `/route mode fast` | Prefer keeping a stable current target while retaining reasonable quality |
| `/route pin provider/model` | Pin a target for the session |
| `/route unpin` | Clear the active target pin |
| `/route thinking auto` | Let Autoroute choose thinking level |
| `/route thinking pi` | Keep Pi's current thinking level |
| `/route thinking fixed high` | Force a thinking level |
| `/route feedback good` | Give positive feedback for the latest decision |
| `/route feedback bad too shallow` | Give negative feedback with a reason |
| `/route feedback bad provider/model reason` | Give feedback for an explicit target |

Feedback changes a target's preference by `0.02` per vote and is capped at `-0.10` to `+0.10`.

## Configuration

Autoroute reads configuration from:

```text
~/.pi/agent/autoroute.json
```

When the project is trusted by Pi, it also reads:

```text
<project>/.pi/autoroute.json
```

The project configuration is merged over the global configuration. Invalid or unreadable configuration fails open and does not prevent Pi from starting.

### Model availability and allowlists

Models do not need to be registered separately in Autoroute. By default, it discovers models from Pi's current scope and only considers models that:

- are included in Pi's `scopedModels` scope, when a scope is configured
- have available provider authentication
- can satisfy the task's context, output, and vision requirements

For example, if Pi was started with a restricted model scope, Autoroute will not route outside that scope.

Use `modelInclude` when you want a strict model whitelist:

```json
{
  "constraints": {
    "modelInclude": [
      "cc-switch-open-router/openrouter/free",
      "cc-switch-open-router/openai/gpt-5.6-luna"
    ]
  }
}
```

Use `modelExclude` to remove matching models:

```json
{
  "constraints": {
    "modelExclude": [
      "*experimental*",
      "*deprecated*"
    ]
  }
}
```

Use `providerAllow` or `providerDeny` to restrict providers:

```json
{
  "constraints": {
    "providerAllow": [
      "cc-switch-open-router",
      "deepseek"
    ],
    "providerDeny": [
      "another-provider"
    ]
  }
}
```

Example:

```json
{
  "enabled": true,
  "policy": "balanced",
  "constraints": {
    "providerAllow": [
      "cc-switch-open-router",
      "deepseek"
    ],
    "modelExclude": [
      "*experimental*"
    ]
  },
  "aliases": {
    "cc-switch-open-router/deepseek/deepseek-v4-flash-0731": "deepseek:deepseek-v4-flash",
    "deepseek/deepseek-v4-flash": "deepseek:deepseek-v4-flash"
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

Controls automatic activation when a Pi session starts.

- `true` (default): activate Autoroute automatically
- `false`: keep Autoroute disabled until `/route on` is used

`/route off` always remains available as a per-session override.

#### `policy`

The default is `balanced`.

| Policy | Behavior |
| --- | --- |
| `balanced` | Default. Balances capability, cost, and keeping the current target |
| `best` | Strongly prioritizes model capability and task quality |
| `price` | Prefers the lowest-cost eligible model that reaches the quality floor |
| `fast` | Gives more weight to target stickiness, reducing unnecessary model switches |

Only the four policies listed above are supported. `economy` is not a supported policy name.

You can set the default in `autoroute.json`:

```json
{
  "policy": "price"
}
```

You can also change it for the current session:

```text
/route mode best
```

#### `constraints`

- `modelInclude`: only include matching model IDs
- `modelExclude`: exclude matching model IDs
- `providerAllow`: only include these providers
- `providerDeny`: exclude these providers

These constraints are applied in addition to Pi's own model scope and authentication checks.

#### `aliases`

Aliases declare that targets from different providers represent the same logical model. This is useful for failover across a gateway and a direct provider.

The value uses the form:

```text
provider:model-id
```

Aliases are explicit. Autoroute does not guess that two similarly named models are equivalent.

#### `budget`

- `maxUsdPerTask`: estimated maximum cost for one task
- `onExceed`: `warn` or `block`

With `warn`, routing continues and the decision includes a budget warning. With `block`, the current model is left unchanged.

#### `classifier`

The classifier is disabled by default. When enabled, it is used only for low-confidence local task analysis.

- `enabled`: enable or disable classifier calls
- `confidenceThreshold`: local confidence below which classification may run
- `timeoutMs`: classifier timeout, capped internally at two seconds

Only a short prompt excerpt is sent. Timeout, authentication errors, invalid output, and provider errors silently fall back to the local analyzer.

## How routing works

Before a new agent task starts, Autoroute:

1. Analyzes the task locally.
2. Resolves candidates from Pi's scoped and authenticated models.
3. Applies provider/model constraints.
4. Removes models with open circuits.
5. Rejects models that cannot satisfy vision, context, or output requirements.
6. Scores capability, cost, stickiness, policy, and explicit feedback.
7. Selects a thinking level.
8. Applies the decision through Pi's native `setModel()` and `setThinkingLevel()` APIs.

The extension does not proxy model streams. Model calls continue through Pi's native provider path.

### Failover and health

HTTP `429` and `5xx` responses are recorded against the active target. Repeated failures open a circuit with an exponential cooldown. A later task can choose an untried failover target, preferring an explicitly aliased logical model when available.

Autoroute does not sleep or perform its own retry loop.

### Compaction and forks

During compaction, Autoroute may temporarily switch to an authenticated, context-fitting, lower-cost model with thinking disabled. It restores the previous model and thinking level after successful or failed compaction.

Forked sessions inherit activation and session settings, but not an in-flight task.

## Storage and privacy

Autoroute stores local JSONL records under:

```text
~/.pi/agent/autoroute/decisions.jsonl
~/.pi/agent/autoroute/feedback.jsonl
```

Decision records contain routing metadata such as target, policy, thinking level, scores, reasons, and task kinds. They do not contain the full prompt, repository contents, or tool output.

Feedback reasons are stored when supplied by the user. The optional classifier sends a short prompt excerpt to the selected authenticated model only when explicitly enabled.

There is no remote telemetry implemented by this extension.

## Development

Install dependencies, then run:

```bash
npm install
npm run typecheck
npm test
```

The test suite uses Node's built-in test runner and currently covers candidate resolution, model identity, task analysis, route planning, failover, compatibility, budget, configuration, classifier boundaries, and explicit feedback.

To run a local Pi load smoke test without saving a session:

```bash
pi --no-extensions \
  --extension ./extensions/autoroute.ts \
  --no-session \
  --no-tools \
  --print "/route status"
```

## Project structure

```text
extensions/autoroute.ts       Pi extension entry point
src/routing/                  Candidate resolution, planning, failover, feedback
src/task/                    Local analyzer and optional classifier
src/models/                  Model identity and capability logic
src/pi/                      Pi API adapters and lifecycle handling
src/health/                  Circuit breaker
src/budget/                  Cost estimation and budget policy
src/config/                  Defaults and configuration loading
src/storage/                 JSONL persistence
src/ui/                      /route commands
test/                        Unit tests
```

## License

No license has been declared yet. Add a `LICENSE` file before distributing this project publicly.
