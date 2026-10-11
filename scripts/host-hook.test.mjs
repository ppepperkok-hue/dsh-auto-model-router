/**
 * Contract test for the `agent/request` hook, without a live Host.
 *
 * It builds the two things the hook actually talks to — a cordis-like emitter
 * (`on(name, listener)` returning a disposer) and an agent carrying its own
 * scoped ctx — then asserts the exact behaviour the Host's model selection
 * relies on: read the offered messages, validate the chosen route through
 * `llm.resolveCallConfig`, and keep the previous route when validation fails.
 *
 * Run with `node scripts/host-hook.test.mjs`.
 */

import assert from 'node:assert/strict'
import { followAgents, inScope, delegationDepthOf } from '../src/host-hook.js'
import { normalizeTiers } from '../src/routes.js'
import { DEFAULT_THRESHOLDS } from '../src/routes.js'

const makeEmitter = () => {
  const listeners = new Map()
  return {
    /** Fire every listener registered for one event name. */
    fire(name, payload) {
      const list = listeners.get(name) ?? []
      if (list.length === 0) throw new Error(`no listener registered for ${name}`)
      return Promise.all(list.map((fn) => fn(payload, undefined)))
    },
    /** The single listener registered for one name, for direct invocation. */
    pick(name) {
      const list = listeners.get(name) ?? []
      if (list.length !== 1) throw new Error(`expected exactly one ${name} listener, found ${list.length}`)
      return list[0]
    },
    has(name) {
      return (listeners.get(name) ?? []).length > 0
    },
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(fn)
        if (index >= 0) current.splice(index, 1)
      }
    },
  }
}

const makeAgent = (id, depth) => {
  const agent = {
    id,
    options: { subagentDepth: depth },
    session: { header: { delegationDepth: depth } },
  }
  agent.ctx = makeEmitter()
  return agent
}

const tiers = normalizeTiers([
  { id: 'tiny', candidates: [{ provider: 'cheap', model: 'cheap-1' }] },
  { id: 'standard', candidates: [{ provider: 'mid', model: 'mid-1' }] },
  { id: 'deep', candidates: [{ provider: 'strong', model: 'strong-1' }] },
  { id: 'max', candidates: [{ provider: 'strongest', model: 'strongest-1' }] },
])

const config = {
  provider: 'auto',
  agentScope: 'subagents',
  defaultTier: 'standard',
  hysteresis: 1,
  dryRun: false,
  thresholds: DEFAULT_THRESHOLDS,
  displayName: 'Auto',
}
let passed = 0
const check = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`ok  ${label}`)
}

await check('delegation depth comes from either the header or the options', () => {
  assert.equal(delegationDepthOf({ options: {}, session: { header: {} } }), 0)
  assert.equal(delegationDepthOf({ options: { subagentDepth: 2 }, session: { header: { delegationDepth: 1 } } }), 2)
  assert.equal(delegationDepthOf({ options: {}, session: { header: { delegationDepth: 1 } } }), 1)
})

await check('scope decides who is routed', () => {
  assert.equal(inScope(makeAgent('top', 0), 'subagents'), false)
  assert.equal(inScope(makeAgent('child', 1), 'subagents'), true)
  assert.equal(inScope(makeAgent('top', 0), 'all'), true)
})

await check('the hook is installed for every agent, and scope decides per request', async () => {
  const ctx = makeEmitter()
  ctx.llm = { listProviders: () => [{ id: 'cheap' }, { id: 'mid' }], resolveCallConfig: async (c) => c }
  ctx.logger = { info() {}, warn() {}, debug() {} }
  const dispose = followAgents(ctx, { config, tiers, logger: ctx.logger })
  const top = makeAgent('top', 0)
  await ctx.fire('agent/created', { agent: top })
  assert.equal(top.ctx.has('agent/request'), true, 'listeners are installed even for a top-level agent')
  await top.ctx.fire('agent/pre-step', { agent: top, step: 1, messages: [{ role: 'user', content: [{ type: 'text', text: '把这段 JSON 格式化一下' }] }] })
  const kept = await top.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(kept.provider, 'mid', 'scope "subagents" must leave a top-level agent alone')
  // Same running agent, same decider: flipping the scope takes effect at once.
  config.agentScope = 'all'
  const routed = await top.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(routed.provider, 'cheap', 'scope "all" must route the main agent on the next request')
  assert.equal(routed.model, 'cheap-1')
  config.agentScope = 'subagents'
  dispose()
})

await check('a delegated agent gets its route rewritten from its instruction', async () => {
  const calls = []
  const ctx = makeEmitter()
  ctx.llm = {
    listProviders: () => [{ id: 'cheap' }, { id: 'mid' }, { id: 'strong' }, { id: 'strongest' }],
    resolveCallConfig: async (candidate) => {
      calls.push(candidate)
      return { ...candidate, maxTokens: 4096 }
    },
  }
  ctx.logger = { info() {}, warn() {}, debug() {} }
  const dispose = followAgents(ctx, { config, tiers, logger: ctx.logger })
  const child = makeAgent('child-1', 1)
  await ctx.fire('agent/created', { agent: child })

  await child.ctx.fire('agent/pre-step', {
    agent: child,
    step: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: '把这段 JSON 格式化一下' }] }],
  })
  const result = await child.ctx.pick('agent/request')({ turn: 1, step: 1 }, async () => ({ provider: 'mid', model: 'mid-1', reasoningEffort: 'high' }))
  assert.equal(result.provider, 'cheap')
  assert.equal(result.model, 'cheap-1')
  assert.equal(result.maxTokens, 4096, 'the Host resolver owns the adapter defaults')
  assert.equal(result.reasoningEffort, undefined, 'an inherited effort must not leak onto the new route')
  assert.equal(calls.length, 1)
  dispose()
})

await check('a rejected route keeps the Host selection', async () => {
  const ctx = makeEmitter()
  ctx.llm = {
    listProviders: () => [{ id: 'cheap' }, { id: 'mid' }],
    resolveCallConfig: async () => {
      throw new Error('no adapter registered for provider "cheap"')
    },
  }
  const warnings = []
  ctx.logger = { info() {}, warn: (message) => warnings.push(message), debug() {} }
  const dispose = followAgents(ctx, { config, tiers, logger: ctx.logger })
  const child = makeAgent('child-2', 1)
  await ctx.fire('agent/created', { agent: child })
  await child.ctx.fire('agent/pre-step', { agent: child, step: 1, messages: [{ role: 'user', content: [{ type: 'text', text: '格式化' }] }] })
  const result = await child.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(result.provider, 'mid')
  assert.equal(result.model, 'mid-1')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /keeping mid\/mid-1/)
  dispose()
})

await check('dryRun scores without touching the route', async () => {
  const ctx = makeEmitter()
  ctx.llm = { listProviders: () => [{ id: 'cheap' }, { id: 'mid' }], resolveCallConfig: async (c) => c }
  ctx.logger = { info() {}, warn() {}, debug() {} }
  const dispose = followAgents(ctx, { config: { ...config, dryRun: true }, tiers, logger: ctx.logger })
  const child = makeAgent('child-3', 1)
  await ctx.fire('agent/created', { agent: child })
  await child.ctx.fire('agent/pre-step', { agent: child, step: 1, messages: [{ role: 'user', content: [{ type: 'text', text: '格式化' }] }] })
  const result = await child.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(result.provider, 'mid')
  dispose()
})

await check('disposal removes the listeners of a disposed agent', async () => {
  const ctx = makeEmitter()
  ctx.llm = { listProviders: () => [{ id: 'cheap' }, { id: 'mid' }], resolveCallConfig: async (c) => c }
  ctx.logger = { info() {}, warn() {}, debug() {} }
  const dispose = followAgents(ctx, { config, tiers, logger: ctx.logger })
  const child = makeAgent('child-4', 1)
  await ctx.fire('agent/created', { agent: child })
  assert.equal(child.ctx.has('agent/request'), true)
  await ctx.fire('agent/disposed', { agent: child })
  assert.equal(child.ctx.has('agent/request'), false)
  dispose()
})

await check('an unknown route with no candidates leaves the request alone', async () => {
  const ctx = makeEmitter()
  ctx.llm = { listProviders: () => [{ id: 'mid' }], resolveCallConfig: async (c) => c }
  ctx.logger = { info() {}, warn() {}, debug() {} }
  const narrowed = normalizeTiers([{ id: 'standard', candidates: [{ provider: 'mid', model: 'mid-1' }] }])
  const dispose = followAgents(ctx, { config: { ...config, defaultTier: 'standard' }, tiers: narrowed, logger: ctx.logger })
  const child = makeAgent('child-5', 1)
  await ctx.fire('agent/created', { agent: child })
  await child.ctx.fire('agent/pre-step', { agent: child, step: 1, messages: [{ role: 'user', content: [{ type: 'text', text: '实现一个解析器，并补上测试' }] }] })
  const result = await child.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(result.provider, 'mid')
  assert.equal(result.model, 'mid-1')
  dispose()
})

console.log(`\n${passed} host-hook checks passed`)
