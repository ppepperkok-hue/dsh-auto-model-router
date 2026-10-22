/**
 * Dry-run one task description through the scorer from the terminal.
 *
 *   node scripts/plan.mjs "把这段 JSON 格式化一下"
 *   node scripts/plan.mjs --context 80000 "全库重构，并补上端到端测试"
 *   node scripts/plan.mjs --table
 *
 * No model is called and nothing is mounted: this is the same pure scoring the
 * adapter runs inside a live request.
 */

import { evaluateTask } from '../src/plan.js'
import { CONSTRAINTS, DEFAULT_THRESHOLDS, TIER_ORDER, normalizeTiers } from '../src/routes.js'

const argv = process.argv.slice(2)
const table = argv.includes('--table')
const constraintsOnly = argv.includes('--constraints')
const contextAt = argv.indexOf('--context')
const contextChars = contextAt >= 0 ? Number(argv[contextAt + 1]) : 0
// Only drop the argument that belongs to `--context`; with no flag, `contextAt`
// is -1 and a naive `index !== contextAt + 1` would eat the task text itself.
const words = argv.filter((arg, index) => !arg.startsWith('--') && (contextAt < 0 || index !== contextAt + 1))
const task = words.join(' ')

const tiers = normalizeTiers()

if (constraintsOnly) {
  for (const line of CONSTRAINTS) console.log(`- ${line}`)
  process.exit(0)
}

if (table) {
  for (const tier of tiers) {
    console.log(`\n${tier.id} — ${tier.name} (ctx ${tier.contextWindow})\n  ${tier.description}`)
    for (const [index, candidate] of tier.candidates.entries()) console.log(`  ${index + 1}. ${candidate.provider}/${candidate.model}`)
  }
  console.log('\nconstraints:')
  for (const line of CONSTRAINTS) console.log(`- ${line}`)
  process.exit(0)
}

if (task.length === 0) {
  console.error('usage: node scripts/plan.mjs [--context <chars>] "<task text>" | --table')
  process.exit(2)
}

// Same scorer and same character accounting as the `auto_route_plan` tool, so
// a threshold decision cannot drift by the one newline `collectSignals` adds.
const { score, contributions, tier } = evaluateTask({
  task,
  contextChars: Number.isFinite(contextChars) ? contextChars : 0,
  thresholds: DEFAULT_THRESHOLDS,
  tiers,
})

console.log(`task      : ${task}`)
console.log(`score     : ${score}  (${contributions.map((entry) => `${entry.label}${entry.value >= 0 ? '+' : ''}${entry.value}`).join(' ') || 'flat'})`)
console.log(`tier      : ${tier.id} (${tier.name})  [order: ${TIER_ORDER.join(' < ')}]`)
console.log(`thresholds: ${JSON.stringify(DEFAULT_THRESHOLDS)}`)
console.log('chain     :')
for (const [index, candidate] of tier.candidates.entries()) console.log(`  ${index + 1}. ${candidate.provider}/${candidate.model}`)
