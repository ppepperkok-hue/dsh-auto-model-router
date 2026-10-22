/**
 * Settings-page plumbing test.
 *
 * Mounts the plugin against a mock Host that provides the `settings` service,
 * then asserts the contract the desktop's plugin page depends on:
 * `installSection` is called for the plugin's namespace, and whatever the
 * section resolves to from then on drives routing on the NEXT request — no
 * reload, no re-registration.
 *
 * Run from an installed copy (it imports ../index.js, which needs schemastery):
 *   node scripts/settings.test.mjs
 */

import assert from 'node:assert/strict'

// Load cordis first: some loader builds patch the schema prototype at runtime,
// and the config check below must run against the same schema the Host sees.
await import('file:///C:/Users/Administrator/.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js').catch(() => undefined)

import * as plugin from '../index.js'
import { SETTINGS_NAMESPACE, plain } from '../src/live-config.js'

const makeEmitter = () => {
  const listeners = new Map()
  return {
    async fire(name, payload) {
      const list = listeners.get(name) ?? []
      if (list.length === 0) throw new Error(`no listener for ${name}`)
      return Promise.all(list.map((fn) => fn(payload, undefined)))
    },
    pick(name) {
      const list = listeners.get(name) ?? []
      if (list.length !== 1) throw new Error(`expected one ${name} listener, found ${list.length}`)
      return list[0]
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

const makeCtx = (providers) => {
  const emitter = makeEmitter()
  const sections = []
  const tools = []
  return {
    ...emitter,
    sections,
    tools,
    llm: {
      registerAdapter() {},
      listProviders: () => providers.map((id) => ({ id })),
      resolveCallConfig: async (config) => config,
    },
    logger: { info() {}, warn() {}, debug() {} },
    inject(names, callback) {
      if (names.includes('settings')) {
        callback({
          settings: {
            installSection(owner, ns, schema, entry, hooks) {
              sections.push({ ns, entry, hooks })
            },
          },
        })
      }
      if (names.includes('tools')) {
        callback({ tools: { defineTool: (spec) => { tools.push(spec) } } })
      }
    },
    effect(callback) {
      return callback()
    },
  }
}

const makeAgent = (id, depth) => {
  const agent = { id, options: { subagentDepth: depth }, session: { header: { delegationDepth: depth } } }
  agent.ctx = makeEmitter()
  return agent
}

let passed = 0
const check = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`ok  ${label}`)
}

const tiers = [
  { id: 'tiny', name: 'Tiny', candidates: [{ provider: 'cheap', model: 'cheap-1' }] },
  { id: 'standard', name: 'Standard', candidates: [{ provider: 'mid', model: 'mid-1' }] },
  { id: 'deep', name: 'Deep', candidates: [{ provider: 'strong', model: 'strong-1' }] },
  { id: 'max', name: 'Max', candidates: [{ provider: 'strongest', model: 'strongest-1' }] },
]

await check('the validated config yields primitives, not wrapped references', () => {
  const resolved = plugin.Config({})
  assert.equal(resolved.agentScope, 'subagents', 'the default scope must be a plain string')
  assert.equal(typeof resolved.agentScope, 'string')
  assert.equal(resolved.dryRun, false)
  assert.equal(typeof resolved.dryRun, 'boolean')
  assert.equal(resolved.defaultTier, 'standard')
  assert.equal(resolved.hysteresis, 1)
  // And the live view must unwrap anything a loader decides to wrap.
  assert.equal(plain({ get: () => 'all' }), 'all')
  assert.equal(plain({ value: true }), true)
  assert.equal(plain('subagents'), 'subagents')
})

await check('the plugin installs its settings section under its own namespace', () => {
  const ctx = makeCtx(['cheap', 'mid'])
  plugin.apply(ctx, { provider: 'auto', tiers, agentScope: 'subagents' })
  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.sections[0].ns, SETTINGS_NAMESPACE)
  assert.equal(ctx.sections[0].ns, 'auto-model-router')
  assert.equal(ctx.sections[0].entry.agentScope, 'subagents', 'the composition entry is the base layer')
  assert.equal(typeof ctx.sections[0].hooks.setSource, 'function')
})

await check('a settings edit changes routing on the next request', async () => {
  const ctx = makeCtx(['cheap', 'mid', 'strong', 'strongest'])
  plugin.apply(ctx, { provider: 'auto', tiers, agentScope: 'subagents' })
  const section = ctx.sections[0]

  // Nothing attached yet: the composition entry decides, so a top-level agent
  // is out of scope.
  const top = makeAgent('top', 0)
  await ctx.fire('agent/created', { agent: top })
  await top.ctx.fire('agent/pre-step', { agent: top, step: 1, messages: [{ role: 'user', content: [{ type: 'text', text: '把这段 JSON 格式化一下' }] }] })
  const before = await top.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(before.provider, 'mid')

  // The settings page writes the user layer; the plugin must notice at once.
  section.hooks.setSource(() => ({ agentScope: 'all' }))
  const after = await top.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(after.provider, 'cheap', 'scope "all" from the settings section must reroute the main agent')
  assert.equal(after.model, 'cheap-1')

  // And disarming it works the same way.
  section.hooks.setSource(() => ({ agentScope: 'off' }))
  const disarmed = await top.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(disarmed.provider, 'mid')
})

await check('dryRun from the settings section scores without rerouting', async () => {
  const ctx = makeCtx(['cheap', 'mid'])
  plugin.apply(ctx, { provider: 'auto', tiers, agentScope: 'subagents' })
  ctx.sections[0].hooks.setSource(() => ({ agentScope: 'all', dryRun: true }))
  const agent = makeAgent('a2', 0)
  await ctx.fire('agent/created', { agent })
  await agent.ctx.fire('agent/pre-step', { agent, step: 1, messages: [{ role: 'user', content: [{ type: 'text', text: '格式化' }] }] })
  const result = await agent.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(result.provider, 'mid')
})

await check('a thresholds edit re-tiers the same prompt', async () => {
  const ctx = makeCtx(['cheap', 'mid'])
  plugin.apply(ctx, { provider: 'auto', tiers, agentScope: 'all' })
  const agent = makeAgent('a3', 0)
  await ctx.fire('agent/created', { agent })
  const task = '实现一个解析器，并补上单元测试'
  await agent.ctx.fire('agent/pre-step', { agent, step: 1, messages: [{ role: 'user', content: [{ type: 'text', text: task }] }] })
  const normal = await agent.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(normal.provider, 'mid', 'expected the standard tier by default')
  // Raising the cut-offs alone would only move one tier, which the conversation's
  // hysteresis absorbs on purpose — so this check also disables it.
  ctx.sections[0].hooks.setSource(() => ({ agentScope: 'all', hysteresis: 0, thresholds: { standard: 99, deep: 199, max: 299 } }))
  const raised = await agent.ctx.pick('agent/request')({}, async () => ({ provider: 'mid', model: 'mid-1' }))
  assert.equal(raised.provider, 'cheap', 'raising the cut-offs must drop the same prompt to the cheapest tier')
})

await check('the planning tool re-resolves thresholds after a settings edit', () => {
  const ctx = makeCtx(['cheap', 'mid'])
  plugin.apply(ctx, { provider: 'auto', tiers, agentScope: 'subagents' })
  assert.equal(ctx.tools.length, 1, 'the plan tool must still be registered')
  const task = '实现一个解析器，并补上单元测试'
  assert.match(ctx.tools[0].execute({ task }), /^tier: standard /)
  ctx.sections[0].hooks.setSource(() => ({ thresholds: { standard: 99, deep: 199, max: 299 } }))
  assert.match(ctx.tools[0].execute({ task }), /^tier: tiny /, 'a settings edit must reach the planning tool on the next call')
})

console.log(`\n${passed} settings checks passed`)
