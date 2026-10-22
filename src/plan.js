/**
 * The `auto_route_plan` dry-run planner.
 *
 * Kept out of `index.js` so the tool's output can be tested without a Host or
 * the settings/tool packages: the scoring path is the same one the adapter
 * runs, while the route preview is the natural tier (hysteresis needs a
 * conversation history) filtered to providers registered at call time. The
 * thresholds, fallback cap and default tier are read at call time so the plan
 * follows the live router when the settings page changes them.
 *
 * @module dsh-auto-model-router/plan
 */

import { collectSignals, scoreSignals, tierForScore } from './classify.js'
import { AUTO_MODEL_ID, liveTiers, resolveThresholds, tierById } from './routes.js'

/** Coerce a character or tool count to a non-negative integer. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

/**
 * Resolve a lazy provider list without letting a Host that has no registry
 * break planning: an unavailable list means "do not filter", not "no routes".
 * @param source - an array, a getter, or undefined.
 * @returns the provider ids, or undefined when unknown.
 */
function providerIds(source) {
  if (Array.isArray(source)) return source
  if (typeof source !== 'function') return undefined
  try {
    const value = source()
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Score one task and resolve the tier the router would naturally choose.
 *
 * This is deliberately the natural tier: a dry run has no conversation history,
 * so it cannot reproduce the decider's hysteresis. Live provider filtering and
 * the default-tier fallback are applied because both are knowable at call time.
 *
 * @param root0 - scoring inputs.
 * @param root0.task - the task text to score.
 * @param root0.contextChars - extra context that will accompany the task, in characters.
 * @param root0.toolCount - how many tools will be offered with the request.
 * @param root0.thresholds - current tier cut-offs (any shape `resolveThresholds` accepts).
 * @param root0.tiers - normalized tier table.
 * @param root0.providers - registered provider ids, or a getter for them.
 * @param root0.selfProvider - the router's own provider id, never a candidate.
 * @param root0.defaultTier - tier used when the natural tier has no live route.
 * @returns the signals, score, natural tier id, and the resolved live tier.
 */
export function evaluateTask({
  task,
  contextChars = 0,
  toolCount = 0,
  thresholds,
  tiers,
  providers,
  selfProvider = 'auto',
  defaultTier = 'standard',
}) {
  const signals = collectSignals({
    messages: [{ role: 'user', content: [{ type: 'text', text: task }] }],
    tools: Array.from({ length: count(toolCount) }, () => ({})),
  })
  // `collectSignals` already counted the task text once; add only the extra
  // context that will accompany it, never the task itself a second time.
  signals.totalChars += count(contextChars)
  const { score, contributions } = scoreSignals(signals)
  const resolvedThresholds = resolveThresholds(thresholds)
  const naturalTierId = tierForScore(score, resolvedThresholds)
  const table = Array.isArray(tiers) ? tiers : []
  const live = Array.isArray(providers) ? liveTiers(table, providers, [selfProvider]) : table
  const tier = live.length === 0 ? undefined : tierById(live, naturalTierId, defaultTier)
  return { signals, score, contributions, thresholds: resolvedThresholds, naturalTierId, tier }
}

/**
 * Score one task the way the router would, without calling a model.
 * @param root0 - planning inputs.
 * @param root0.task - the task text to score.
 * @param root0.contextChars - extra context that will accompany the task, in characters.
 * @param root0.toolCount - how many tools will be offered with the request.
 * @param root0.thresholds - current tier cut-offs (any shape `resolveThresholds` accepts).
 * @param root0.tiers - normalized tier table.
 * @param root0.provider - the router's own provider id.
 * @param root0.providers - registered provider ids, or a getter for them.
 * @param root0.maxFallbacks - extra candidates the router would try.
 * @param root0.defaultTier - tier used when the natural tier has no live route.
 * @returns the human-readable plan.
 */
export function planRoute({
  task,
  contextChars = 0,
  toolCount = 0,
  thresholds,
  tiers,
  provider = 'auto',
  providers,
  maxFallbacks = 2,
  defaultTier = 'standard',
}) {
  const { score, contributions, naturalTierId, tier } = evaluateTask({
    task,
    contextChars,
    toolCount,
    thresholds,
    tiers,
    providers,
    selfProvider: provider,
    defaultTier,
  })
  if (tier === undefined) {
    const ids = (Array.isArray(tiers) ? tiers : []).map((entry) => entry.id).join(', ') || 'none'
    return `auto_route_plan: no candidate provider is registered right now (tiers: ${ids}).`
  }
  const extra = Number.isSafeInteger(maxFallbacks) && maxFallbacks >= 0 ? maxFallbacks : 2
  const attempts = Math.max(1, Math.min(tier.candidates.length, 1 + extra))
  const chain = tier.candidates.slice(0, attempts).map((entry, index) => `  ${index + 1}. ${entry.provider}/${entry.model}${entry.reasoningEffort === undefined ? '' : ` (${entry.reasoningEffort})`}`)
  const naturalNote = tier.id === naturalTierId ? '' : ` [natural ${naturalTierId} has no live candidate]`
  return [
    `tier: ${tier.id} (${tier.name})${naturalNote}`,
    `selection: natural tier; conversation hysteresis is not applied`,
    `score: ${score} — ${contributions.map((entry) => `${entry.label}${entry.value >= 0 ? '+' : ''}${entry.value}`).join(' ') || 'flat'}`,
    `context window assumed: ${tier.contextWindow}`,
    `fallback chain (${attempts} of ${tier.candidates.length}; maxFallbacks=${extra}):`,
    ...chain,
    ``,
    `dispatch it with provider "${provider}", model "${tier.id}" (or "${AUTO_MODEL_ID}" to let every step re-score).`,
  ].join('\n')
}

/**
 * Build the `auto_route_plan` tool definition.
 *
 * `config` is the live settings view, not a snapshot: `execute` resolves
 * `thresholds` on every call, exactly like the router's decider does.
 * @param root0 - wiring.
 * @param root0.config - live plugin config (`thresholds`, `maxFallbacks`, `defaultTier`).
 * @param root0.tiers - normalized tier table.
 * @param root0.provider - the router's own provider id.
 * @param root0.providers - registered provider ids, or a getter for them.
 * @returns the tool definition handed to `defineTool`.
 */
export function createPlanTool({ config, tiers, provider = 'auto', providers }) {
  return {
    name: 'auto_route_plan',
    description: `Explain the natural tier (before conversation hysteresis) the ${provider} router would score for a task, without calling any model. It filters to providers registered now and shows only the candidates the router would actually try. Pass the task text (and optionally the context size you expect) to see the tier, the scored reasons, and the attempted fallback chain. Use it before dispatching expensive work.`,
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
      return planRoute({
        task,
        contextChars: args?.contextChars,
        toolCount: args?.toolCount,
        // Read on every call: the settings page may have replaced these values.
        thresholds: config.thresholds,
        tiers,
        provider,
        providers: providerIds(providers),
        maxFallbacks: config.maxFallbacks,
        defaultTier: config.defaultTier,
      })
    },
  }
}
