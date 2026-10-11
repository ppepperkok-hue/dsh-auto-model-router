/**
 * Integration test against the real `@deepseek-ai/dsh-llm` service.
 *
 * The unit suite stubs `ctx.llm.stream`. This one mounts the actual LlmRuntime
 * from the Host's own node_modules, registers a fake upstream adapter, mounts
 * this plugin on top and then streams through `provider: 'auto'`. It is the
 * closest thing to a live Host run that can be executed without restarting the
 * desktop application.
 *
 * Run with `node scripts/integration.mjs`.
 */

const PROFILES = 'file:///C:/Users/Administrator/.dsh/profiles/node_modules/@deepseek-ai'
const { Context } = await import(`${PROFILES}/cordis/lib/index.js`)
const dshLlm = await import(`${PROFILES}/dsh-llm/lib/index.js`)
const LlmRuntime = dshLlm.default ?? dshLlm.LlmRuntime
const plugin = await import('../index.js')

let behaviour = 'answer'
class FakeAdapter {
  providerInfo(id) {
    return { id, name: 'Fake Upstream' }
  }
  // Mandatory: `prepareRoutes` calls this unconditionally (dsh-llm/lib/index.js:1814).
  providerRetryPolicy() {
    return undefined
  }
  imageRequestPricing() {
    return undefined
  }
  listModels() {
    return Promise.resolve([{ id: 'cheap', name: 'cheap' }, { id: 'mid', name: 'mid' }, { id: 'strong', name: 'strong' }])
  }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128000 })
  }
  prepareCall(provider, model, signal) {
    return this.resolveModel(provider, model, signal).then((info) => ({ model: info, stream: (options) => this.stream(options) }))
  }
  async *stream(options) {
    if (behaviour === 'fail') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'fake upstream is rate limited' } } }
      return
    }
    yield { type: 'text-delta', text: `served by ${options.provider}/${options.model}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const app = new Context()
await app.plugin(LlmRuntime).await()
await app.plugin({
  name: 'fake-upstream',
  inject: ['llm'],
  apply(ctx) {
    ctx.llm.registerAdapter(['fake'], new FakeAdapter())
  },
}).await()
// cordis takes the config as the SECOND argument of plugin(); putting it on the
// plugin object silently falls back to the schema defaults.
await app.plugin({
  name: plugin.name,
  inject: plugin.inject,
  Config: plugin.Config,
  apply: plugin.apply,
}, {
  provider: 'auto',
  explain: true,
  tiers: [
    { id: 'tiny', name: 'Tiny', candidates: [{ provider: 'fake', model: 'cheap' }] },
    { id: 'standard', name: 'Standard', candidates: [{ provider: 'fake', model: 'mid' }] },
    { id: 'deep', name: 'Deep', candidates: [{ provider: 'fake', model: 'strong' }] },
    { id: 'max', name: 'Max', candidates: [{ provider: 'fake', model: 'strong' }] },
  ],
}).await()

/** Wait until cordis has finished applying every registered plugin. */
const settle = async (app) => {
  if (app.fiber !== undefined && typeof app.fiber.await === 'function') return app.fiber.await()
  if (typeof app.await === 'function') return app.await()
  if (app.lifecycle !== undefined && typeof app.lifecycle.flush === 'function') return new Promise((resolve) => app.lifecycle.flush(resolve))
  return undefined
}

await settle(app)

const assert = (await import('node:assert/strict')).default
const collect = async (options) => {
  const chunks = []
  for await (const chunk of app.llm.stream(options)) chunks.push(chunk)
  return chunks
}
const text = (chunks) => chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text ?? '').join('')
const request = (task) => ({
  provider: 'auto',
  model: 'auto',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
    { role: 'user', content: [{ type: 'text', text: task }] },
  ],
})

let passed = 0
const check = async (label, fn) => {
  await fn()
  passed += 1
  console.log(`ok  ${label}`)
}

await check('the router is registered as a provider', () => {
  const providers = app.llm.listProviders().map((entry) => entry.id)
  assert.equal(providers.includes('auto'), true, `providers=${providers.join(',')}`)
})

await check('the router adapter satisfies every method the registry calls', () => {
  const adapter = app.llm.adapters?.get?.('auto')?.adapter
  for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof adapter?.[method], 'function', `adapter.${method} must be a function`)
  }
})

await check('the picker sees the virtual models', async () => {
  const models = await app.llm.listModels('auto')
  assert.deepEqual(models.map((model) => model.id), ['auto', 'tiny', 'standard', 'deep', 'max'])
})

await check('a trivial request is served by the cheapest tier', async () => {
  const chunks = await collect(request('把这段 JSON 格式化一下'))
  assert.equal(text(chunks), 'served by fake/cheap')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

await check('an implementation request is served by the standard tier', async () => {
  const chunks = await collect(request('实现一个把 CSV 转成 XLSX 的函数，并补上单元测试。'))
  assert.equal(text(chunks), 'served by fake/mid')
})

await check('a pinned tier is honoured', async () => {
  const chunks = await collect({ ...request('随便一句话'), model: 'deep' })
  assert.equal(text(chunks), 'served by fake/strong')
})

await check('a tier falls back when its first candidate fails', async () => {
  behaviour = 'fail'
  const chunks = await collect({ ...request('把这段 JSON 格式化一下'), model: 'standard' })
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'RATE_LIMIT')
  behaviour = 'answer'
})

console.log(`\n${passed} integration checks passed`)
