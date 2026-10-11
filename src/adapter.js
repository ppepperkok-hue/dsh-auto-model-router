/**
 * The router's LLM adapter.
 *
 * It is deliberately a duck-typed adapter: `@deepseek-ai/dsh-llm` only requires
 * `stream()` (every other member of the base class has a working default), and
 * the registry calls `providerInfo` / `listModels` / `resolveModel` /
 * `prepareCall` on whatever object is handed to `ctx.llm.registerAdapter`.
 * Skipping the base class keeps this plugin free of a hard import on a package
 * whose patch version moves with the Host.
 *
 * @module dsh-auto-model-router/adapter
 */

import { AUTO_MODEL_ID } from './routes.js'
import { createDecider, streamRouted } from './router.js'

/** Largest context window any reachable tier declares. */
function widestWindow(tiers, fallback = 200000) {
  let widest = fallback
  for (const tier of tiers) if (Number.isSafeInteger(tier.contextWindow) && tier.contextWindow > widest) widest = tier.contextWindow
  return widest
}

/**
 * Build the adapter for one registered provider id.
 * @param root0 - wiring.
 * @param root0.ctx - the plugin context (carries `llm`).
 * @param root0.config - resolved plugin config.
 * @param root0.tiers - normalized tier table.
 * @param root0.provider - the router's own provider id.
 * @param root0.logger - optional logger.
 * @returns an adapter object accepted by `ctx.llm.registerAdapter`.
 */
export function createAutoAdapter({ ctx, config, tiers, provider, logger }) {
  const deciderFor = (pinnedModel) => createDecider({
    tiers,
    config,
    pinnedModel,
    providers: ctx.llm.listProviders().map((entry) => entry.id),
    selfProvider: provider,
    logger,
  })

  const decisionDescription = (decision) => {
    const route = decision.candidates[0]
    return `auto → ${decision.tierId} → ${route.provider}/${route.model}`
  }

  return {
    /** Display metadata; the id must equal the id used at registration. */
    providerInfo(id) {
      return {
        id,
        name: config.displayName ?? 'Auto Model Router',
      }
    },

    /** The router owns no retry policy of its own; tiers do the falling back. */
    providerRetryPolicy() {
      return undefined
    },

    /** No provider-side image pricing to declare. */
    imageRequestPricing() {
      return undefined
    },

    /**
     * Advertise the virtual models: one per tier, plus the scoring entry point.
     * The registry validates every row (`model.provider` must equal the route it
     * was asked about), so the provider id is stamped onto each one.
     * @param provider - the router's own provider id.
     * @returns the catalogue rows shown in the model picker.
     */
    listModels(provider) {
      const widest = widestWindow(tiers)
      return Promise.resolve([
        {
          provider,
          id: AUTO_MODEL_ID,
          name: 'Auto (scored)',
          description: 'Score the request and pick the cheapest tier that fits.',
          contextWindow: widest,
        },
        ...tiers.map((tier) => ({
          provider,
          id: tier.id,
          name: tier.name,
          ...tier.description === '' ? {} : { description: tier.description },
          contextWindow: tier.contextWindow,
        })),
      ])
    },

    /**
     * Metadata for one virtual model. Unknown ids still resolve, so a pinned
     * tier whose routes vanished from the Host fails at dispatch, not here.
     * @param id - the router provider id.
     * @param model - the virtual model id requested.
     * @returns resolved model metadata.
     */
    async resolveModel(id, model) {
      const tier = tiers.find((entry) => entry.id === model)
      return {
        provider: id,
        id: model,
        name: tier?.name ?? (model === AUTO_MODEL_ID ? 'Auto (scored)' : model),
        ...tier === undefined ? {} : { description: tier.description },
        contextWindow: tier?.contextWindow ?? widestWindow(tiers),
      }
    },

    /**
     * Bind one dispatch. The pinned virtual model travels with the call so
     * `stream()` knows whether the caller asked for scoring or a fixed tier.
     */
    async prepareCall(id, model, signal) {
      const resolved = await this.resolveModel(id, model, signal)
      return {
        model: resolved,
        stream: (options) => this.stream(options),
      }
    },

    /**
     * Score the request and stream from the winning route, falling back inside
     * the tier when a candidate fails before it produces any output.
     * @param options - the request the Host built for this call.
     * @yields the chosen provider's chunks, unchanged.
     */
    async *stream(options) {
      const decider = deciderFor(options?.model)
      const decision = decider.decide(options)
      if (decision.candidates.length === 0) {
        logger?.warn?.('auto-model-router: no tier has a candidate whose provider is registered; refusing the call instead of guessing')
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'NO_ADAPTER',
              message: `auto-model-router: none of the configured candidate providers is registered (tiers: ${tiers.map((tier) => tier.id).join(', ')})`,
            },
          },
        }
        return
      }
      logger?.info?.(`auto-model-router: ${decisionDescription(decision)}${config.explain ? ` | score ${decision.score} (${decision.contributions.map((c) => `${c.label}${c.value >= 0 ? '+' : ''}${c.value}`).join(' ') || 'flat'})` : ''}`)
      yield* streamRouted({
        llm: ctx.llm,
        options,
        candidates: decision.candidates,
        maxFallbacks: config.maxFallbacks,
        logger,
      })
    },
  }
}
