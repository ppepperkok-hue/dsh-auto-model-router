/**
 * Difficulty scoring for the auto model router.
 *
 * The router sees the whole request that the agent loop is about to send, so
 * the score is computed from what the model would actually have to read: the
 * newest user instruction, the accumulated context, the tools on offer and the
 * tool results already in flight. Everything here is pure so it can be unit
 * tested without a live Host.
 *
 * @module dsh-auto-model-router/classify
 */

/** Signals that suggest a cheap, mechanical request. */
const TRIVIAL_HINTS = [
  '格式化', '排序', '重命名', '列出', '提取', '转换成', '改成', '翻译', '查一下', '是什么',
  'format', 'rename', 'sort', 'list ', 'extract', 'convert', 'translate', 'tidy', 'lint',
]

/** Signals that suggest real engineering work. */
const DEEP_HINTS = [
  '重构', '实现', '迁移', '审计', '性能', '并发', '算法', '优化', '调试', '修复', '设计', '架构',
  '测试', '端到端', '插件', '编译', '部署', '排查', '定位', '内存', '协议',
  'refactor', 'implement', 'migrate', 'audit', 'performance', 'concurrency', 'algorithm',
  'optimiz', 'debug', 'fix ', 'design', 'architect', 'test', 'deploy', 'profile',
]

/** Signals that suggest the hardest tier: open-ended research and whole-repo work. */
const MAX_HINTS = [
  '论文', '科研', '定理', '证明', '从零', '整体设计', '全库', '全部重写', '为什么要', '权衡', '综述',
  'research', 'thesis', 'theorem', 'prove', 'from scratch', 'end-to-end', 'trade-off', 'survey',
]

/** Count non-overlapping occurrences of every needle in one haystack. */
function countHits(haystack, needles) {
  let hits = 0
  for (const needle of needles) {
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      hits += 1
      from = at + needle.length
    }
  }
  return hits
}

/**
 * Count how many DISTINCT needles appear. Difficulty is about which kinds of
 * work a request mentions, not how often it repeats them — frequency counting
 * turned a restated one-liner into a "deep" request.
 */
function countDistinct(haystack, needles) {
  let hits = 0
  for (const needle of needles) if (haystack.includes(needle)) hits += 1
  return hits
}

/** Flatten one message's text blocks, ignoring images, files and tool payloads. */
function messageText(message) {
  if (typeof message !== 'object' || message === null) return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  let text = ''
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string') text += `${block.text}\n`
  }
  return text
}

/**
 * Reduce a request to the countable signals the score is built from.
 * @param root0 - request-facing inputs.
 * @param root0.messages - canonical messages about to be sent.
 * @param root0.tools - tool definitions offered with the request.
 * @returns the raw signal vector.
 */
export function collectSignals({ messages = [], tools = [] } = {}) {
  let totalChars = 0
  let lastUserChars = 0
  let toolResults = 0
  let codeFences = 0
  const userTexts = []
  for (const message of messages) {
    const text = messageText(message)
    totalChars += text.length
    codeFences += countHits(text, ['```'])
    if (message?.role === 'user') {
      userTexts.push(text)
    } else if (message?.role === 'tool') {
      toolResults += 1
    }
  }
  lastUserChars = userTexts.length > 0 ? userTexts[userTexts.length - 1].length : 0
  const instruction = userTexts.slice(-3).join('\n').toLowerCase()
  const all = `${instruction}\n${messages.map(messageText).join('\n').toLowerCase()}`
  return {
    messageCount: messages.length,
    totalChars,
    lastUserChars,
    toolCount: Array.isArray(tools) ? tools.length : 0,
    toolResults,
    codeFences,
    trivialHits: countDistinct(instruction, TRIVIAL_HINTS),
    deepHits: countDistinct(all, DEEP_HINTS),
    maxHits: countDistinct(all, MAX_HINTS),
  }
}

/**
 * Turn a signal vector into a difficulty score and a human-readable breakdown.
 * @param signals - the vector from {@link collectSignals}.
 * @returns the score plus the contributions that produced it.
 */
export function scoreSignals(signals) {
  const contributions = []
  const add = (label, value) => {
    if (value === 0) return
    contributions.push({ label, value })
  }

  if (signals.lastUserChars >= 1500) add('long-instruction', 2.5)
  else if (signals.lastUserChars >= 400) add('medium-instruction', 1)
  if (signals.totalChars >= 60000) add('large-context', 2.5)
  else if (signals.totalChars >= 20000) add('context', 1)
  if (signals.toolCount >= 10) add('many-tools', 0.5)
  if (signals.toolResults >= 8) add('tool-churn', 1)
  if (signals.codeFences >= 3) add('code-heavy', 1)

  add('deep-keywords', Math.min(signals.deepHits * 1.2, 6))
  add('max-keywords', Math.min(signals.maxHits * 2.5, 7))
  add('trivial-keywords', -Math.min(signals.trivialHits * 1, 3))

  const score = contributions.reduce((sum, entry) => sum + entry.value, 0)
  return { score: Math.max(0, Number(score.toFixed(2))), contributions }
}

/**
 * Map a score onto a tier id.
 * @param score - the score from {@link scoreSignals}.
 * @param thresholds - ascending cut-offs, e.g. `{ standard: 1.5, deep: 4.5, max: 8 }`.
 * @returns the tier id.
 */
export function tierForScore(score, thresholds) {
  const order = [
    ['max', thresholds.max],
    ['deep', thresholds.deep],
    ['standard', thresholds.standard],
  ]
  for (const [tier, cut] of order) {
    if (typeof cut === 'number' && score >= cut) return tier
  }
  return 'tiny'
}

/**
 * Pick the tier for one request, damping flapping inside a conversation.
 * @param root0 - decision inputs.
 * @param root0.score - the difficulty score.
 * @param root0.thresholds - tier cut-offs.
 * @param root0.previousTier - the tier this conversation used last time, if any.
 * @param root0.hysteresis - how many tiers of drift to absorb (0 disables).
 * @param root0.tierOrder - ascending tier ids.
 * @returns the chosen tier id.
 */
export function chooseTier({ score, thresholds, previousTier, hysteresis = 1, tierOrder }) {
  const natural = tierForScore(score, thresholds)
  if (previousTier === undefined || hysteresis <= 0) return natural
  const previousIndex = tierOrder.indexOf(previousTier)
  const naturalIndex = tierOrder.indexOf(natural)
  if (previousIndex < 0 || naturalIndex < 0) return natural
  return Math.abs(naturalIndex - previousIndex) <= hysteresis ? previousTier : natural
}

/** Exported for tests and documentation. */
export const HINTS = { TRIVIAL_HINTS, DEEP_HINTS, MAX_HINTS }
