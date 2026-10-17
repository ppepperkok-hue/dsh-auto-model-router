<div align="center">

# dsh-auto-model-router

<!-- moe-counter:start -->
<a href="https://github.com/journey-ad/Moe-Counter"><img src="https://count.getloli.com/get/@ppepperkok-hue.dsh-auto-router?theme=asoul" alt="README views" width="360" /></a>
<br /><sub>README views · image requests, not unique visitors</sub>
<!-- moe-counter:end -->

</div>

Route a DSH request to the model that fits the job. The plugin scores each
request from the live prompt — length, context size, tool churn, intent keywords
— maps it onto four tiers, and dispatches to the cheapest tier that can do the
work, falling back inside the tier when an account is rate-limited or out of
credit.

Two mechanisms ship together and can be used independently:

- **A virtual provider (`auto`)** — pick `auto/auto` in the model picker and
  every request is scored; pick `auto/<tier>` to pin a tier. Works for the main
  agent, subagents, workflows and teammates alike, because it is just another
  provider on the registry.
- **An `agent/request` hook** — the sanctioned per-request rewrite point
  (`dsh-agent-loop/lib/index.js:1143-1153`). **On by default for delegated
  agents**: a subagent or workflow child is scored and sent to the tier its task
  deserves. The main agent is left alone unless you set `agentScope: all` or pick
  the `auto` provider in the model selector. Because the route is chosen before
  dispatch, the log records the model that actually ran.

## Tiers

| tier | for | example chain |
| --- | --- | --- |
| `tiny` | formatting, extraction, short lookups | `buddy/deepseek-v4-flash` → free lane → `qodercn/qfmodel` |
| `standard` | everyday implementation, one or two files | `Step 5 Preview` → `buddy/deepseek-v4.1-flash` → `glm-5.3-flash` |
| `deep` | multi-file refactors, terminal/CI work, long agent loops | `buddy/glm-5.3` → `buddy/kimi-k3-1` → `zcode/GLM-5.3` |
| `max` | open-ended research, whole-repo work, computer use | `buddy/glm-5.3` → free-lane `kimi-k3` → `workbuddy/gpt-6-astra` |

The default table is measured, not guessed: the 2026-10-12 smoke probe of this
machine's gateway (`221 routes, 92 answering`) decided which candidates exist at
all, and the capability research decided their order. Hard constraints that must
not be routed around are exported as `CONSTRAINTS` from `./routes` and printed by
`node scripts/plan.mjs --constraints`.

## Install

The desktop application owns the `desktop` profile, so the CLI refuses it
(`profile "desktop" is managed exclusively by the Electron application`). Install
by hand, exactly like any other profile bundle:

1. copy this directory to `<DSH_HOME>/profiles/<profile>/node_modules/dsh-auto-model-router`
2. add `"dsh-auto-model-router": "0.1.0"` to that profile's `dependencies`
3. append `"dsh-auto-model-router"` to `dsh.profile.bundles`
4. do **not** add a row to `cordis.patch.yml`: the bundle carries its own patch
   (`cordis.patch.yml`), and registering both raises
   `duplicate loader entry id`.
5. restart the application.

## Configure

Two layers, and the user layer wins:

1. **The plugin settings page** — the plugin installs the `auto-model-router`
   settings section, which the desktop renders under **Settings → Plugins**
   (the same place the built-in 子智能体 page lives). Everything there is read on
   the next request, so no restart is needed:

   | field | default | meaning |
   | --- | --- | --- |
   | `agentScope` | `subagents` | `off` / `subagents` / `all` |
   | `dryRun` | `false` | score and log, never reroute |
   | `defaultTier` | `standard` | tier used when nothing scores |
   | `hysteresis` | `1` | tiers of drift absorbed inside one conversation |
   | `maxFallbacks` | `2` | extra candidates tried before giving up |
   | `explain` | `true` | put the score breakdown in the log line |
   | `thresholds` | `{2, 4.5, 8}` | the score cut-offs |

2. **The composition entry** — the profile's `cordis.patch.yml` row. It is the
   base layer, and it is where a deployment pins defaults:

```yaml
- id: auto-model-router
  config:
    provider: auto            # the virtual provider id
    agentScope: subagents     # off | subagents | all
    defaultTier: standard
    thresholds: { standard: 2, deep: 4.5, max: 8 }
    tiers:                    # omit to keep the measured defaults
      - id: standard
        name: Auto · Standard
        candidates:
          - { provider: buddy, model: deepseek-v4.1-flash }
          - { provider: our-free-model, model: stepfun/step-5-preview-free }
```

`agentScope` is the switch that matters:

- `subagents` (default) — every delegated child agent is scored and routed. This
  is the "dispatch the task package to the right model" mode.
- `off` — nothing is rerouted; only the virtual provider remains, reachable by
  picking `auto/...` in the model selector.
- `all` — the main agent is rerouted per request too.

`dryRun: true` keeps the scoring and the log line but leaves routes alone — the
cheapest way to see what the router *would* do.

Tier tables (`tiers`) are fixed at load: changing the candidate chains needs a
reload, while every field above applies immediately.

## Verify

```bash
node scripts/selftest.mjs        # 15 checks: scoring, tiers, hysteresis, fallback
node scripts/host-hook.test.mjs  #  8 checks: agent/request contract, scope, disposal
node scripts/settings.test.mjs   #  4 checks: settings section, live reconfiguration
node scripts/integration.mjs     #  7 checks against the REAL @deepseek-ai/dsh-llm
node scripts/plan.mjs "把这段 JSON 格式化一下"
node scripts/plan.mjs --table
```

`settings.test.mjs` and `integration.mjs` import `../index.js`, so they need a
copy that can resolve `@deepseek-ai/schemastery` — i.e. an installed plugin
inside a profile — while `selftest.mjs`, `host-hook.test.mjs` and `plan.mjs` run
straight from a checkout.

`integration.mjs` mounts the Host's own `LlmRuntime` (resolved from the installed
profile), registers a fake upstream plus this plugin, and streams through
`provider: 'auto'`. It is the closest thing to a live Host run that does not need
an application restart. It also pins the adapter surface the registry actually
calls — `providerInfo`, `providerRetryPolicy`, `imageRequestPricing`,
`listModels`, `resolveModel`, `prepareCall`, `stream` — each of which was
discovered the hard way.

## Known limits

- The `llm/stream` waterfall is **not** a routing seam: the main loop prepares
  its call first, and changing provider/model there raises
  `INVALID_PREPARED_CALL` (`dsh-llm/lib/index.js:2166`, `:2241`). That is why the
  hook uses `agent/request` instead.
- The virtual-provider path logs `auto/<tier>` as the request model, so per-model
  usage statistics are attributed to the router, not to the upstream that served
  the request. The `agent/request` path does not have this problem.
- Routing is decided per request, never mid-stream, and never rewrites an
  already-prepared call.
- Hysteresis keeps a conversation on its tier for ±1 tier of drift, because
  flapping between providers destroys KV-cache reuse.
