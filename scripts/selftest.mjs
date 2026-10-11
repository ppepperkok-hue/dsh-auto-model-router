/**
 * Offline self-test for the router's decision engine.
 *
 * Runs without a Host: it feeds synthetic requests through the same classifier,
 * tier chooser and fallback walker the adapter uses, and asserts the outcomes
 * the plugin promises. Run with `node scripts/selftest.mjs`.
 */

import assert from 'node:assert/strict'
import { collectSignals, scoreSignals, tierForScore, chooseTier } from '../src/classify.js'
import { DEFAULT_THRESHOLDS, TIER_ORDER, normalizeTiers, liveTiers, tierById } from '../src/routes.js'
import { conversationKey, createDecider, streamRouted } from '../src/router.js'

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`ok  ${label}`)
}

const request = (text, options = {}) => ({
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
    { role: 'user', content: [{ type: 'text', text }] },
  ],
  tools: options.tools ?? [],
  sessionId: options.sessionId ?? 'session-test',
})

const decide = (text, options = {}) => {
  const signals = collectSignals(request(text, options))
  return { signals, ...scoreSignals(signals) }
}

check('a mechanical one-liner lands in the cheapest tier', () => {
  const { score, contributions } = decide('把这段 JSON 格式化一下')
  const tier = tierForScore(score, DEFAULT_THRESHOLDS)
  assert.equal(tier, 'tiny', `score=${score} contributions=${JSON.stringify(contributions)}`)
})

check('an ordinary implementation request lands in standard', () => {
  const { score } = decide('实现一个把 CSV 转成 XLSX 的函数，并补上单元测试。'.repeat(3))
  const tier = tierForScore(score, DEFAULT_THRESHOLDS)
  assert.equal(tier, 'standard', `score=${score}`)
})

check('a multi-file refactor lands in deep', () => {
  const { score } = decide('把插件里的模型路由重构一遍：审计现有 provider、实现新的 fallback 链、设计并发与性能测试，最后端到端验证。'.repeat(6))
  const tier = tierForScore(score, DEFAULT_THRESHOLDS)
  assert.ok(tier === 'deep' || tier === 'max', `score=${score} tier=${tier}`)
})

check('open-ended research lands in max', () => {
  const { score } = decide('从零设计整套模型路由架构，综述各家研究，证明 trade-off，并给出全库改造方案。'.repeat(8))
  const tier = tierForScore(score, DEFAULT_THRESHOLDS)
  assert.equal(tier, 'max', `score=${score}`)
})

check('a long context alone raises the tier', () => {
  const short = decide('继续')
  const long = decide('继续', {})
  const longSignals = collectSignals({ messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }, { role: 'tool', content: [{ type: 'text', text: 'x'.repeat(70000) }] }], tools: [] })
  const longScore = scoreSignals(longSignals).score
  assert.ok(longScore > short.score, `${longScore} should exceed ${short.score}`)
  assert.equal(scoreSignals(longSignals).contributions.some((entry) => entry.label === 'large-context'), true)
  void long
})

check('hysteresis keeps a conversation on its tier', () => {
  const natural = tierForScore(99, DEFAULT_THRESHOLDS)
  assert.equal(natural, 'max')
  const damped = chooseTier({ score: 99, thresholds: DEFAULT_THRESHOLDS, previousTier: 'deep', hysteresis: 1, tierOrder: TIER_ORDER })
  assert.equal(damped, 'deep')
  const jumped = chooseTier({ score: 99, thresholds: DEFAULT_THRESHOLDS, previousTier: 'tiny', hysteresis: 1, tierOrder: TIER_ORDER })
  assert.equal(jumped, 'max')
})

check('conversation keys are stable across a growing history', () => {
  const first = conversationKey(request('第一句话'))
  const later = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '第一句话' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ],
    sessionId: 'session-test',
  }
  assert.equal(first, conversationKey(later))
})

check('the tier table survives junk and keeps ids unique', () => {
  const tiers = normalizeTiers([
    { id: 'a', candidates: [{ provider: 'p', model: 'm' }] },
    { id: 'a', candidates: [{ provider: 'p', model: 'm' }] },
    { id: '', candidates: [{ provider: 'p', model: 'm' }] },
    { id: 'b', candidates: [] },
    { id: 'c', candidates: [{ provider: '', model: 'm' }, { provider: 'p', model: 'q' }] },
  ])
  assert.deepEqual(tiers.map((tier) => tier.id), ['a', 'c'])
  assert.deepEqual(tiers[1].candidates, [{ provider: 'p', model: 'q' }])
})

check('tiers drop providers the Host never registered', () => {
  const tiers = normalizeTiers([
    { id: 'a', candidates: [{ provider: 'buddy', model: 'm1' }, { provider: 'ghost', model: 'm2' }] },
    { id: 'b', candidates: [{ provider: 'ghost', model: 'm3' }] },
  ])
  const live = liveTiers(tiers, ['buddy'], ['auto'])
  assert.deepEqual(live.map((tier) => tier.id), ['a'])
  assert.deepEqual(live[0].candidates, [{ provider: 'buddy', model: 'm1' }])
})

check('the decider remembers a conversation and honours a pinned tier', () => {
  const tiers = normalizeTiers([
    { id: 'tiny', candidates: [{ provider: 'p', model: 'cheap' }] },
    { id: 'standard', candidates: [{ provider: 'p', model: 'mid' }] },
    { id: 'deep', candidates: [{ provider: 'p', model: 'strong' }] },
    { id: 'max', candidates: [{ provider: 'p', model: 'strongest' }] },
  ])
  const decider = createDecider({
    tiers,
    config: { thresholds: DEFAULT_THRESHOLDS, hysteresis: 1, defaultTier: 'standard' },
    pinnedModel: undefined,
    providers: ['p'],
    selfProvider: 'auto',
  })
  const first = decider.decide(request('把 JSON 格式化'))
  assert.equal(first.tierId, 'tiny')
  const second = decider.decide(request('把 JSON 格式化'))
  assert.equal(second.reason, 'scored')
  const pinned = createDecider({
    tiers,
    config: { thresholds: DEFAULT_THRESHOLDS, hysteresis: 0, defaultTier: 'standard' },
    pinnedModel: 'deep',
    providers: ['p'],
    selfProvider: 'auto',
  }).decide(request('随便一句话'))
  assert.equal(pinned.tierId, 'deep')
  assert.equal(pinned.reason, 'pinned')
})

check('a live settings change is picked up without rebuilding the decider', () => {
  const tiers = normalizeTiers([
    { id: 'tiny', candidates: [{ provider: 'p', model: 'cheap' }] },
    { id: 'standard', candidates: [{ provider: 'p', model: 'mid' }] },
    { id: 'deep', candidates: [{ provider: 'p', model: 'strong' }] },
    { id: 'max', candidates: [{ provider: 'p', model: 'strongest' }] },
  ])
  const config = { thresholds: DEFAULT_THRESHOLDS, hysteresis: 0, defaultTier: 'standard' }
  const decider = createDecider({ tiers, config, pinnedModel: undefined, providers: ['p'], selfProvider: 'auto' })
  assert.equal(decider.decide(request('实现一个解析器，并补上单元测试')).tierId, 'standard')
  // The plugin settings page rewrites this object; the same decider must obey it.
  config.thresholds = { standard: 99, deep: 199, max: 299 }
  assert.equal(decider.decide(request('实现一个解析器，并补上单元测试')).tierId, 'tiny')
})

check('an unknown tier id falls back to the default', () => {
  const tiers = normalizeTiers([{ id: 'tiny', candidates: [{ provider: 'p', model: 'm' }] }])
  assert.equal(tierById(tiers, 'nope', 'tiny').id, 'tiny')
})

check('a failing candidate falls through to the next one', async () => {
  const calls = []
  const llm = {
    stream(options) {
      calls.push(`${options.provider}/${options.model}`)
      if (options.model === 'dead') {
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'nope' } } }
        })()
      }
      return (async function* () {
        yield { type: 'text-delta', text: 'hello' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const chunks = []
  for await (const chunk of streamRouted({
    llm,
    options: { messages: [], provider: 'auto', model: 'tiny' },
    candidates: [{ provider: 'p', model: 'dead' }, { provider: 'p', model: 'alive' }],
    maxFallbacks: 2,
  })) chunks.push(chunk)
  assert.deepEqual(calls, ['p/dead', 'p/alive'])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(chunks[0].text, 'hello')
})

check('every candidate failing yields one terminal error', async () => {
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED', message: 'empty' } } }
      })()
    },
  }
  const chunks = []
  for await (const chunk of streamRouted({
    llm,
    options: { messages: [], provider: 'auto', model: 'tiny' },
    candidates: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }],
    maxFallbacks: 5,
  })) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'QUOTA_EXCEEDED')
})

check('a failure after visible output is not retried', async () => {
  let calls = 0
  const llm = {
    stream() {
      calls += 1
      return (async function* () {
        yield { type: 'text-delta', text: 'partial' }
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'reset' } } }
      })()
    },
  }
  const chunks = []
  for await (const chunk of streamRouted({
    llm,
    options: { messages: [], provider: 'auto', model: 'tiny' },
    candidates: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }],
    maxFallbacks: 2,
  })) chunks.push(chunk)
  assert.equal(calls, 1, 'must not replay a partially delivered answer')
  assert.equal(chunks.at(-1).reason.kind, 'error')
})

console.log(`\n${passed} checks passed`)
