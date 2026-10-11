/**
 * Decision engine and fallback streaming for the auto model router.
 *
 * Two responsibilities, kept apart from the adapter so both are testable:
 * choosing a tier from the live request, and walking that tier's candidate list
 * until one provider actually answers.
 *
 * @module dsh-auto-model-router/router
 */

import { AUTO_MODEL_ID, liveTiers, resolveThresholds, tierById, tierOrderOf } from './routes.js'
import { chooseTier, collectSignals, scoreSignals } from './classify.js'

/** Stable 32-bit hash of a string, used to remember a conversation's tier. */
function hash(text) {
  let value = 5381
  for (let index = 0; index < text.length; index += 1) value = ((value * 33) ^ text.charCodeAt(index)) >>> 0
  return value.toString(36)
}

/**
 * Identify the conversation a request belongs to, so tier decisions stay put
 * for its whole lifetime instead of flapping with every tool result.
 * @param options - the request handed to the adapter.
 * @returns an opaque conversation key.
 */
export function conversationKey(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  let firstUser = ''
  for (const message of messages) {
    if (message?.role !== 'user') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') { firstUser += block.text; break }
    }
    if (firstUser.length > 0) break
  }
  const session = typeof options?.sessionId === 'string' ? options.sessionId : ''
  return `${session}#${hash(firstUser.slice(0, 512))}`
}

/**
 * Build the tier decider.
 *
 * `config` is read at decision time rather than captured, so a settings-page
 * edit (a `.volatile()` field) is honoured by the very next request instead of
 * only after a reload.
 *
 * @param root0 - configuration.
 * @param root0.tiers - normalized tier table.
 * @param root0.config - live plugin config (thresholds, hysteresis, defaultTier).
 * @param root0.pinnedModel - virtual model id requested; a tier id pins that tier.
 * @param root0.providers - currently registered provider ids.
 * @param root0.selfProvider - the router's own provider id, never a candidate.
 * @param root0.logger - optional logger.
 * @returns the decider.
 */
export function createDecider({
  tiers,
  config,
  pinnedModel,
  providers,
  selfProvider,
  logger,
}) {
  const order = tierOrderOf(tiers)
  const memory = new Map()
  const resolved = liveTiers(tiers, providers, [selfProvider])

  return {
    /** Which tiers survived adapter filtering, for diagnostics. */
    table: resolved,
    /**
     * Choose a tier for one request.
     * @param options - the request handed to the adapter.
     * @returns the decision record.
     */
    decide(options) {
      // Live settings, read per request so the settings page takes effect at once.
      const thresholds = resolveThresholds(config.thresholds)
      const hysteresis = config.hysteresis ?? 1
      const defaultTier = config.defaultTier ?? 'standard'
      const requested = typeof pinnedModel === 'string' && pinnedModel.length > 0 && pinnedModel !== AUTO_MODEL_ID
        ? pinnedModel
        : undefined
      const key = conversationKey(options)
      const previous = memory.get(key)
      const signals = collectSignals({ messages: options?.messages, tools: options?.tools })
      const { score, contributions } = scoreSignals(signals)

      // No candidate survives adapter filtering: report it instead of routing to
      // a provider the Host never registered.
      if (resolved.length === 0) {
        return { tier: undefined, tierId: undefined, reason: 'no-live-routes', score, contributions, signals, candidates: [] }
      }

      let tier
      let reason
      if (requested !== undefined) {
        tier = tierById(resolved, requested, defaultTier)
        reason = 'pinned'
      } else {
        const chosenId = chooseTier({ score, thresholds, previousTier: previous, hysteresis, tierOrder: order })
        tier = tierById(resolved, chosenId, defaultTier)
        reason = previous === undefined ? 'scored' : chosenId === tier.id ? 'scored' : 'sticky'
      }
      memory.set(key, tier.id)
      if (memory.size > 256) memory.delete(memory.keys().next().value)
      logger?.debug?.(`auto-model-router: tier=${tier.id} reason=${reason} score=${score} (${contributions.map((c) => `${c.label}${c.value >= 0 ? '+' : ''}${c.value}`).join(' ') || 'flat'})`)
      return {
        tier,
        tierId: tier.id,
        reason,
        score,
        contributions,
        signals,
        candidates: tier.candidates,
      }
    },
  }
}

/**
 * Walk a tier's candidates, re-dispatching when a candidate fails terminally
 * before emitting anything the caller could have seen.
 * @param root0 - dispatch inputs.
 * @param root0.llm - the `ctx.llm` service.
 * @param root0.options - the original request (already frozen by the loop).
 * @param root0.candidates - ordered routes to try.
 * @param root0.maxFallbacks - how many extra routes to try after the first.
 * @param root0.logger - optional logger.
 * @yields the winning candidate's stream chunks.
 */
export async function* streamRouted({ llm, options, candidates, maxFallbacks, logger }) {
  const attempts = Math.max(1, Math.min(candidates.length, 1 + Math.max(0, maxFallbacks)))
  let lastFailure
  for (let index = 0; index < attempts; index += 1) {
    const candidate = candidates[index]
    const forwarded = {
      ...options,
      provider: candidate.provider,
      model: candidate.model,
      ...candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort },
    }
    let visible = false
    let failed = false
    try {
      for await (const chunk of llm.stream(forwarded)) {
        if (chunk?.type === 'finish' && chunk.reason?.kind !== 'stop' && !visible) {
          lastFailure = chunk.reason?.failure
          failed = true
          break
        }
        visible = true
        yield chunk
      }
    } catch (error) {
      if (visible) throw error
      lastFailure = error
      failed = true
    }
    if (!failed) return
    logger?.warn?.(`auto-model-router: ${candidate.provider}/${candidate.model} failed before producing output${lastFailure?.code === undefined ? '' : ` (${lastFailure.code})`}; trying the next candidate`)
  }
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: lastFailure ?? {
        code: 'NO_ADAPTER',
        message: 'auto-model-router: every candidate route in the chosen tier failed',
      },
    },
  }
}
