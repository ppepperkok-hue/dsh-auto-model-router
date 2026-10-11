/**
 * A live view of the router's settings.
 *
 * The composition entry (this plugin's `Config`) is the base layer; the
 * `auto-model-router` settings section installed through `ctx.settings` is the
 * user layer on top of it. Every read happens through a getter, so an edit made
 * on the plugin settings page is honoured by the very next request — no reload,
 * no re-registration.
 *
 * @module dsh-auto-model-router/live-config
 */

/** Settings namespace name; must stay a lowercase-hyphenated identifier. */
export const SETTINGS_NAMESPACE = 'auto-model-router'

/**
 * Unwrap a value a Host may have wrapped in a reference object. Some loader
 * builds hand reactive config fields to plugins as `{ get() }` / `{ value }`
 * wrappers instead of primitives; reading them raw would make every comparison
 * fail silently, so unwrap before use.
 * @param value - the raw configured value.
 * @returns the primitive behind it, or the value itself.
 */
export function plain(value) {
  if (typeof value !== 'object' || value === null) return value
  if (typeof value.get === 'function') {
    try {
      return plain(value.get())
    } catch {
      return undefined
    }
  }
  if ('value' in value) return plain(value.value)
  return value
}

/**
 * Build the live view.
 * @param root0 - wiring.
 * @param root0.base - the composition entry (validated plugin config).
 * @param root0.provider - the router's own provider id.
 * @param root0.getSection - returns the current user section, or undefined while
 *   no settings provider is attached.
 * @returns an object whose getters always answer with the current values.
 */
export function createLiveConfig({ base, provider, getSection }) {
  const merged = (key) => plain({ ...base, ...(getSection?.() ?? {}) }[key])
  return {
    get provider() {
      return provider
    },
    get displayName() {
      return merged('displayName') ?? 'Auto Model Router'
    },
    get agentScope() {
      return merged('agentScope') ?? 'subagents'
    },
    get dryRun() {
      return merged('dryRun') === true
    },
    get defaultTier() {
      return merged('defaultTier') ?? 'standard'
    },
    get hysteresis() {
      const value = merged('hysteresis')
      return Number.isSafeInteger(value) && value >= 0 ? value : 1
    },
    get maxFallbacks() {
      const value = merged('maxFallbacks')
      return Number.isSafeInteger(value) && value >= 0 ? value : 2
    },
    get explain() {
      return merged('explain') !== false
    },
    get thresholds() {
      return merged('thresholds') ?? null
    },
    get tiers() {
      return merged('tiers') ?? []
    },
  }
}
