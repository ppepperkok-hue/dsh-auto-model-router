/**
 * The sanctioned routing seam: a per-request `agent/request` listener.
 *
 * `agent/request` is the only place a plugin may rewrite provider/model before
 * dispatch (`dsh-agent-loop/lib/index.js:1143-1153`), and the Host's own model
 * selection uses exactly this pattern
 * (`dsh-agent/lib/types/model-selection.js:62-76`). Unlike a virtual provider,
 * a route chosen here lands in `request/header` and in the session projection,
 * so the logged model is the model that actually ran.
 *
 * Difficulty is read from the messages the step was offered, which arrive on the
 * sibling `agent/pre-step` waterfall (`{agent, messages, signal, step}`).
 *
 * @module dsh-auto-model-router/host-hook
 */

import { createDecider } from './router.js'

/** Delegation depth of an agent, treating absence as a top-level agent. */
export function delegationDepthOf(agent) {
  const runtime = agent?.options?.subagentDepth
  const header = agent?.session?.header?.delegationDepth
  const values = [header, runtime].filter((value) => typeof value === 'number' && Number.isFinite(value))
  return values.length === 0 ? 0 : Math.max(...values)
}

/**
 * Decide whether this agent is in the router's scope.
 * @param agent - the live agent.
 * @param scope - `'subagents'` (delegated children only) or `'all'`.
 * @returns whether routing applies.
 */
export function inScope(agent, scope) {
  if (scope === 'all') return true
  return delegationDepthOf(agent) > 0
}

/**
 * Install routing on one live agent.
 * @param agent - the agent to route.
 * @param root0 - routing inputs.
 * @param root0.ctx - the plugin context (for `llm.resolveCallConfig`).
 * @param root0.config - resolved plugin config.
 * @param root0.tiers - normalized tier table.
 * @param root0.logger - optional logger.
 * @returns a disposer that removes both listeners.
 */
export function installAgentRouting(agent, { ctx, config, tiers, logger }) {
  const decider = createDecider({
    tiers,
    config,
    // A pinned tier id is not meaningful here: the Host's own selection owns it.
    pinnedModel: undefined,
    providers: ctx.llm.listProviders().map((entry) => entry.id),
    selfProvider: config.provider,
    logger,
  })
  /** Latest messages offered to this agent's step; the scoring input. */
  let offered = []
  let seen = 0

  const disposePreStep = agent.ctx.on('agent/pre-step', ({ messages }) => {
    if (Array.isArray(messages)) offered = messages
    seen += 1
  })

  const disposeRequest = agent.ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    // Scope and dry-run are read live, so flipping them on the settings page
    // applies to the very next request of an already-running agent.
    if (!inScope(agent, config.agentScope ?? 'off')) return resolved
    const decision = decider.decide({
      messages: offered,
      sessionId: agent.id,
      // Context pressure is approximated from the step count: each step adds a
      // tool result to the same conversation, which is what grading should notice.
      tools: Array.from({ length: Math.min(seen, 12) }, () => ({})),
    })
    const route = decision.candidates[0]
    if (route === undefined) {
      logger?.debug?.(`auto-model-router: no live candidate for ${agent.id} (${decision.reason}); keeping ${resolved.provider}/${resolved.model}`)
      return resolved
    }
    if (config.dryRun === true) {
      logger?.info?.(`auto-model-router (dry run): ${agent.id} would use ${route.provider}/${route.model} (tier ${decision.tierId}, score ${decision.score})`)
      return resolved
    }
    const { reasoningEffort: inheritedEffort, ...withoutInheritedEffort } = resolved
    const wanted = {
      ...withoutInheritedEffort,
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
    }
    if (wanted.provider === resolved.provider && wanted.model === resolved.model) return resolved
    try {
      // Validate through the Host's own resolver before committing the route,
      // which is what the official selection listener does.
      const checked = await ctx.llm.resolveCallConfig(wanted, payload?.signal)
      logger?.info?.(`auto-model-router: ${agent.id} → ${checked.provider}/${checked.model} (tier ${decision.tierId}, score ${decision.score})`)
      return checked
    } catch (error) {
      logger?.warn?.(`auto-model-router: keeping ${resolved.provider}/${resolved.model}; ${route.provider}/${route.model} was rejected (${String(error?.message ?? error)})`)
      return resolved
    }
  })

  return () => {
    disposePreStep()
    disposeRequest()
  }
}

/**
 * Follow the agent registry and install routing on every live agent.
 *
 * The listeners are installed unconditionally and the scope is evaluated per
 * request, so switching `agentScope` on the settings page changes behaviour
 * immediately for agents that are already running.
 *
 * @param ctx - the plugin context.
 * @param root0 - routing inputs (see {@link installAgentRouting}).
 * @returns a disposer for the registry listeners and every installed agent.
 */
export function followAgents(ctx, { config, tiers, logger }) {
  const installed = new Map()

  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    if (agent === undefined || agent === null) return
    installed.set(agent.id, installAgentRouting(agent, { ctx, config, tiers, logger }))
  })

  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const dispose = installed.get(agent?.id)
    if (dispose === undefined) return
    installed.delete(agent.id)
    dispose()
  })

  return () => {
    disposeCreated()
    disposeDisposed()
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }
}
