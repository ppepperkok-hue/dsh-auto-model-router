/**
 * dsh-auto-model-router 鈥?entry point (Host half).
 *
 * Registers one virtual LLM provider whose adapter scores each request from the
 * live prompt and dispatches it to the cheapest tier that fits, walking that
 * tier's candidate list when an account is rate-limited or out of credit.
 *
 * Wiring: `ctx.llm.registerAdapter([provider], adapter)` puts the router on the
 * same registry every other adapter lives on, so the picker, the agent loop,
 * subagents and workflows all reach it by naming `provider`/`model` like any
 * other route. An optional `auto_route_plan` tool exposes the same scoring as a
 * dry run, so a Lead agent can ask what a task would cost before dispatching it.
 *
 * @module dsh-auto-model-router
 */

import z from '@deepseek-ai/schemastery'
import { createAutoAdapter } from './src/adapter.js'
import { followAgents } from './src/host-hook.js'
import { SETTINGS_NAMESPACE, createLiveConfig } from './src/live-config.js'
import { AUTO_MODEL_ID, normalizeTiers, resolveThresholds } from './src/routes.js'
import { collectSignals, scoreSignals, tierForScore } from './src/classify.js'

const name = 'auto-model-router'
const inject = ['llm']

/** Plugin configuration. Every field is optional; the defaults are this machine's measured routes. */
const Config = z.object({
  provider: z.string().default('auto'),
  displayName: z.string().default('Auto Model Router'),
  enabled: z.boolean().default(true),
  /**
   * Where the `agent/request` hook may rewrite routes. `subagents` is the
   * default: delegated task packages get the model their difficulty deserves.
   * `all` also reroutes the main agent; `off` leaves every route untouched.
   * Also editable on the plugin settings page: the settings section installed
   * below is read on every request, so a change applies without a reload.
   */
  agentScope: z.union(['off', 'subagents', 'all']).default('subagents'),
  /** Score and log the decision without changing the route. */
  dryRun: z.boolean().default(false),
  defaultTier: z.string().default('standard'),
  hysteresis: z.natural().max(4).default(1),
  maxFallbacks: z.natural().max(8).default(2),
  explain: z.boolean().default(true),
  /**
   * Optional overrides. Both are validated by this plugin's own normalizers
   * (`normalizeTiers`, `resolveThresholds`) rather than by a nested schema, so a
   * partially specified tier keeps its defaults instead of being dropped whole.
   * The threshold object is live: editing it takes effect on the next request.
   */
  thresholds: z.any().default(null),
  tiers: z.array(z.any()).default([]),
})

/** Resolve thresholds defensively: see `resolveThresholds` in ./src/routes.js. */

/** The user layer the plugin settings page edits, on top of {@link Config}. */
const SettingsSection = z.object({
  agentScope: z.union(['off', 'subagents', 'all']).default('subagents'),
  dryRun: z.boolean().default(false),
  defaultTier: z.string().default('standard'),
  hysteresis: z.natural().max(4).default(1),
  maxFallbacks: z.natural().max(8).default(2),
  explain: z.boolean().default(true),
  thresholds: z.any().default(null),
})

/** The composition entry, normalized into the settings section's shape. */
function sectionEntry(config) {
  return {
    agentScope: config.agentScope ?? 'subagents',
    dryRun: config.dryRun === true,
    defaultTier: config.defaultTier ?? 'standard',
    hysteresis: Number.isSafeInteger(config.hysteresis) ? config.hysteresis : 1,
    maxFallbacks: Number.isSafeInteger(config.maxFallbacks) ? config.maxFallbacks : 2,
    explain: config.explain !== false,
    thresholds: config.thresholds ?? null,
  }
}

/**
 * Mount the router.
 * @param ctx - the plugin context; `llm` is guaranteed by `inject`.
 * @param config - resolved {@link Config}.
 */
export function apply(ctx, config) {
  if (config.enabled === false) {
    ctx.logger?.info?.('auto-model-router: disabled by config')
    return
  }

  const provider = typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : 'auto'
  if (/[^a-z0-9-]/i.test(provider)) {
    throw new Error(`auto-model-router: provider id ${JSON.stringify(provider)} must be url-safe (letters, digits, dashes)`)
  }

  // Every knob is read through this view, so an edit on the plugin settings page
  // takes effect on the next request instead of the next restart.
  let settingsSource
  const live = createLiveConfig({ base: config, provider, getSection: () => settingsSource?.() })

  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, SettingsSection, sectionEntry(config), {
        setSource: (source) => { settingsSource = source },
        onChange: () => {},
      })
      ctx.logger?.info?.(`auto-model-router: settings section "${SETTINGS_NAMESPACE}" installed (edit it under Settings 鈫?Plugins)`)
    } catch (error) {
      ctx.logger?.warn?.(`auto-model-router: settings section unavailable (${String(error?.message ?? error)}); the composition entry stays authoritative`)
    }
  })

  const tiers = normalizeTiers(Array.isArray(live.tiers) && live.tiers.length > 0 ? live.tiers : undefined)

  const adapter = createAutoAdapter({
    ctx,
    config: live,
    tiers,
    provider,
    logger: ctx.logger,
  })

  try {
    ctx.llm.registerAdapter([provider], adapter)
  } catch (error) {
    ctx.logger?.warn?.(`auto-model-router: could not register provider "${provider}": ${String(error?.message ?? error)}`)
    return
  }

  ctx.logger?.info?.(`auto-model-router: provider "${provider}" ready with tiers ${tiers.map((tier) => `${tier.id}(${tier.candidates.length})`).join(' ')}; select ${provider}/${AUTO_MODEL_ID} to let it score, or ${provider}/<tier> to pin one`)

  // Always follow the registry: `agentScope` is evaluated per request, so the
  // settings page can arm or disarm routing without a reload.
  ctx.effect(() => followAgents(ctx, { config: live, tiers, logger: ctx.logger }))
  ctx.logger?.info?.(`auto-model-router: agent/request hook armed (scope "${live.agentScope}"; the main agent is only rerouted when scope is "all", or when you pick ${provider}/${AUTO_MODEL_ID} in the model selector)`)

  registerPlanTool(ctx, { provider, tiers, thresholds: resolveThresholds(live.thresholds) })
}

/**
 * Register the dry-run planning tool when a tool registry is present. Absence of
 * `@deepseek-ai/dsh-tools` (or of the service) degrades to "no tool" instead of
 * failing the plugin.
 */
function registerPlanTool(ctx, { provider, tiers, thresholds }) {
  ctx.inject(['tools'], (toolCtx) => {
    let defineTool
    try {
      // Resolved lazily so a deployment without the tool package still mounts the router.
      defineTool = toolCtx.tools?.defineTool
    } catch {
      defineTool = undefined
    }
    if (typeof defineTool !== 'function') return

    defineTool({
      name: 'auto_route_plan',
      description: `Explain which model the ${provider} router would pick for a task, without calling any model. Pass the task text (and optionally the context size you expect) to see the tier, the scored reasons, and the ordered fallback chain. Use it before dispatching expensive work.`,
      parameters: {
        task: { type: 'string', required: true, description: 'The task text to score, e.g. a subagent prompt.' },
        contextChars: { type: 'number', description: 'Rough size of the context that will accompany the task, in characters.' },
        toolCount: { type: 'number', description: 'How many tools will be offered with the request.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, result) => [{ type: 'text', text: result }],
      },
      execute(args) {
        const task = typeof args?.task === 'string' ? args.task : ''
        if (task.length === 0) return 'auto_route_plan: `task` must be a non-empty string.'
        const contextChars = Number.isFinite(args?.contextChars) ? Math.max(0, Math.trunc(args.contextChars)) : task.length
        const toolCount = Number.isFinite(args?.toolCount) ? Math.max(0, Math.trunc(args.toolCount)) : 0
        const signals = collectSignals({
          messages: [{ role: 'user', content: [{ type: 'text', text: task }] }],
          tools: Array.from({ length: toolCount }, () => ({})),
        })
        signals.totalChars = contextChars + task.length
        const { score, contributions } = scoreSignals(signals)
        const tierId = tierForScore(score, thresholds)
        const tier = tiers.find((entry) => entry.id === tierId) ?? tiers[0]
        const chain = tier.candidates.map((entry, index) => `  ${index + 1}. ${entry.provider}/${entry.model}${entry.reasoningEffort === undefined ? '' : ` (${entry.reasoningEffort})`}`)
        return [
          `tier: ${tier.id} (${tier.name})`,
          `score: ${score} 鈥?${contributions.map((entry) => `${entry.label}${entry.value >= 0 ? '+' : ''}${entry.value}`).join(' ') || 'flat'}`,
          `context window assumed: ${tier.contextWindow}`,
          `fallback chain:`,
          ...chain,
          ``,
          `dispatch it with provider "${provider}", model "${tier.id}" (or "${AUTO_MODEL_ID}" to let every step re-score).`,
        ].join('\n')
      },
    })
  })
}

export { Config, inject, name }
