/**
 * Tier table for the auto model router.
 *
 * A tier is an ordered candidate list, not a single model: the router walks it
 * until one route answers, so a rate-limited or expired account degrades to the
 * next-best model instead of failing the task.
 *
 * The defaults below are measured against this machine's own gateway catalogue
 * (the 2026-10-12 smoke probe of 221 routes: 92 answered). Edit `tiers` in the
 * plugin config to change them; nothing here is baked into the code path.
 *
 * @module dsh-auto-model-router/routes
 */

/** Tier ids ordered from cheapest to strongest. */
export const TIER_ORDER = ['tiny', 'standard', 'deep', 'max']

/** Score cut-offs that separate the tiers. */
export const DEFAULT_THRESHOLDS = { standard: 2, deep: 4.5, max: 8 }

/**
 * Resolve thresholds defensively: a partially specified object keeps the
 * built-in cut-offs for the keys it omits, so a settings-page edit cannot
 * silently zero a tier boundary.
 * @param raw - whatever the config carries for `thresholds`.
 * @returns a complete threshold triple.
 */
export function resolveThresholds(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {}
  const pick = (key) => (typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : DEFAULT_THRESHOLDS[key])
  return { standard: pick('standard'), deep: pick('deep'), max: pick('max') }
}

/** Virtual model ids advertised by the router's own provider. */
export const AUTO_MODEL_ID = 'auto'

/**
 * Default tier table. Candidate order is "best value that actually answers on
 * this machine": the 2026-10-12 smoke probe (`D:\dsh插件\.model-probe\全模型实测报告.md`)
 * decided which routes exist at all, and the capability research decided the
 * ranking inside each tier.
 */
export const DEFAULT_TIERS = [
  {
    id: 'tiny',
    name: 'Auto · Tiny',
    description: 'Mechanical edits, extraction, short lookups. Nothing here costs real money: DeepSeek V4.1 Flash is the cheapest 1M-context route with vision and 2500-way concurrency, and the Kilo free lane costs nothing at all.',
    contextWindow: 200000,
    candidates: [
      { provider: 'buddy', model: 'deepseek-v4-flash' },
      { provider: 'our-free-model', model: 'stepfun/step-5-preview-free' },
      { provider: 'qodercn', model: 'qfmodel' },
      { provider: 'lobsterai', model: 'deepseek-flash' },
      { provider: 'deepseek-account', model: 'deepseek-flash' },
    ],
  },
  {
    id: 'standard',
    name: 'Auto · Standard',
    description: 'Everyday implementation inside one or two files. Step 5 Preview is the value sweet spot (AA 44, open-source top 2, ~$1/$2.70); GLM-5.3-Flash is the cheap text fallback.',
    contextWindow: 200000,
    candidates: [
      { provider: 'our-free-model', model: 'stepfun/step-5-preview-free' },
      { provider: 'buddy', model: 'deepseek-v4.1-flash' },
      { provider: 'buddy', model: 'glm-5.3-flash' },
      { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash' },
      { provider: 'loomy', model: 'DeepSeek-V4.1-Flash' },
    ],
  },
  {
    id: 'deep',
    name: 'Auto · Deep',
    description: 'Multi-file refactors, terminal/CI work, long agent loops. GLM-5.3 leads Terminal-Bench 3.0 (28.3) and DeepSWE (66.9); Kimi K3 owns long-horizon coding (1,048,576 context, Arena frontend #1) but only when thinking records are replayed in full.',
    contextWindow: 262144,
    candidates: [
      { provider: 'buddy', model: 'glm-5.3' },
      { provider: 'buddy', model: 'kimi-k3-1' },
      { provider: 'zcode', model: 'GLM-5.3' },
      { provider: 'raccoon', model: 'sn-kimi-k3' },
      { provider: 'buddy', model: 'deepseek-v4-pro' },
    ],
  },
  {
    id: 'max',
    name: 'Auto · Max',
    description: 'Open-ended research, whole-repo work, hardest reasoning, computer use. GLM-5.3 has the best measured security-reasoning score on this list (CyberGym 84.5%) and the free lane carries a 1M-context twin; GPT-6 Astra is the computer-use specialist but is metered and rate-limited.',
    contextWindow: 1000000,
    candidates: [
      { provider: 'buddy', model: 'glm-5.3' },
      { provider: 'our-free-model', model: 'moonshotai/kimi-k3' },
      { provider: 'our-free-model', model: 'z-ai/glm-5.3' },
      { provider: 'buddy', model: 'kimi-k3-1' },
      { provider: 'workbuddy', model: 'gpt-6-astra' },
      { provider: 'buddy', model: 'hy4-preview' },
    ],
  },
]

/**
 * Facts a routing table must not ignore. Kept as data so the README, the
 * planning tool and future tier edits all quote the same sentences.
 */
export const CONSTRAINTS = [
  'Claude models cap output at 128K; never route long-output jobs there, and leave the "max" effort off — it was measured burning the whole 128K budget on reasoning.',
  'Gemini 3.8 Flash and Qwen 3.7 Plus stop at ~65-66K output: not for generation-heavy work.',
  'Kimi K3 degrades when a framework fails to replay its prior thinking blocks; keep the route stable inside one conversation (the router already does, via hysteresis).',
  'DeepSeek charges peak/off-peak rates (UTC Mon-Fri 01:00-04:00 and 06:00-10:00 are peak, double price): batch work belongs in the off-peak window.',
  'MiMo V2.6 Flash is cheap but decodes at ~6 chars/s: only for non-interactive batches.',
  'WorkBuddy rejects any request whose first message is not a system prompt, and rate-limits an account per model.',
]

/** Normalize a user-supplied tier table, filling ids and dropping junk entries. */
export function normalizeTiers(tiers) {
  const source = Array.isArray(tiers) && tiers.length > 0 ? tiers : DEFAULT_TIERS
  const seen = new Set()
  const normalized = []
  for (const tier of source) {
    if (typeof tier !== 'object' || tier === null) continue
    const id = typeof tier.id === 'string' ? tier.id.trim() : ''
    if (id.length === 0 || seen.has(id)) continue
    const candidates = (Array.isArray(tier.candidates) ? tier.candidates : [])
      .filter((entry) => typeof entry === 'object' && entry !== null
        && typeof entry.provider === 'string' && entry.provider.length > 0
        && typeof entry.model === 'string' && entry.model.length > 0)
      .map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        ...typeof entry.reasoningEffort === 'string' && entry.reasoningEffort.length > 0
          ? { reasoningEffort: entry.reasoningEffort }
          : {},
      }))
    if (candidates.length === 0) continue
    seen.add(id)
    normalized.push({
      id,
      name: typeof tier.name === 'string' && tier.name.length > 0 ? tier.name : `Auto · ${id}`,
      description: typeof tier.description === 'string' ? tier.description : '',
      contextWindow: Number.isSafeInteger(tier.contextWindow) && tier.contextWindow > 0 ? tier.contextWindow : 200000,
      candidates,
    })
  }
  return normalized.length > 0 ? normalized : DEFAULT_TIERS
}

/** Tier ids in table order. */
export function tierOrderOf(tiers) {
  return tiers.map((tier) => tier.id)
}

/**
 * Keep only candidates whose provider the Host actually registered right now.
 * Unknown providers are dropped rather than left to fail at dispatch time.
 * @param tiers - normalized tier table.
 * @param providers - registered provider ids.
 * @param exclude - provider ids to ignore (the router's own).
 * @returns the tiers with live candidates only.
 */
export function liveTiers(tiers, providers, exclude = []) {
  const known = new Set(providers)
  return tiers
    .map((tier) => ({
      ...tier,
      candidates: tier.candidates.filter((entry) => known.has(entry.provider) && !exclude.includes(entry.provider)),
    }))
    .filter((tier) => tier.candidates.length > 0)
}

/** Pick one tier by id, falling back to the caller's default. */
export function tierById(tiers, id, fallbackId) {
  return tiers.find((tier) => tier.id === id)
    ?? tiers.find((tier) => tier.id === fallbackId)
    ?? tiers[0]
}
