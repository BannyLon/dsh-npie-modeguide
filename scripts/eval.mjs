/**
 * scripts/eval.mjs — 准确率评测。**这是这个插件的验收线，不是可选工具。**
 *
 * 为什么必须有一个独立的评测入口：0.1.x 的 80 多条判据全在验「机制对不对」
 * （是否调用、失败是否闭合、文案是否双语），没有一条在验「判得对不对」。
 * 结果是：点击、超时、配额都做得很扎实，而核心承诺 ——「告诉你该用哪个模式」——
 * 在一个 14 例人工样本上是 9 对 3 错 2 侥幸，谁都不知道。
 *
 * 每条用例断言两件事：
 *   1. `expect` 是具体模式时，本地规则必须**当场定案**到该模式（source=rules）；
 *   2. `expect` 是 `default` 时，结论必须是「不换」，而且**不依赖默认模式是哪个** ——
 *      同一句用例会在两种默认下各跑一遍。这一条比前一条更重要：
 *      宁可不动，不可乱动。
 *
 * 任何一条不过 ⇒ 退出码 1。CI 与 `npm run check` 都按这个门槛卡。
 *
 * 用法：npm run eval [-- --verbose]
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recommendByRules, composeVerdict } from '../src/recommender.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODES = ['minimal', 'standard', 'ptc', 'cordis']
/** 默认模式不是常量（用户可以在设置里改），所以两种都要跑。 */
const DEFAULTS = ['standard', 'ptc']

const cases = [
  // 开发规则时用的那批（会反复看，容易过拟合）
  ...JSON.parse(readFileSync(join(ROOT, 'test/eval/cases.json'), 'utf8')).map((c) => ({ ...c, set: 'main' })),
  // 另写的一批：用完全不同的说法，**不参与调规则**，只用来验泛化
  ...JSON.parse(readFileSync(join(ROOT, 'test/eval/cases-heldout.json'), 'utf8')).map((c) => ({ ...c, set: 'heldout' })),
]
const verbose = process.argv.includes('--verbose')

const failures = []
const bySet = {}
let checks = 0

for (const item of cases) {
  const text = typeof item.text === 'string' ? item.text : ''
  const expect = item.expect
  if (!text || (expect !== 'default' && !MODES.includes(expect))) {
    failures.push(`${JSON.stringify(text)}: 用例本身不合法（expect=${expect}）`)
    continue
  }
  // 「不换」类用例在两个默认下都必须不换；「换」类用例跑一次就够
  // （结论与默认无关，跑两次只是重复）。
  for (const def of (expect === 'default' ? DEFAULTS : [DEFAULTS[0]])) {
    checks += 1
    bySet[item.set] = bySet[item.set] || { total: 0, bad: 0 }
    bySet[item.set].total += 1
    const local = recommendByRules(text, { available: MODES })
    const verdict = composeVerdict(local, null, def)
    const want = expect === 'default' ? def : expect
    const ok = verdict.mode === want
    if (ok) {
      if (verbose) console.log(`  ok   ${expect === 'default' ? `[默认 ${def}]` : ''} ${text}`)
      continue
    }
    bySet[item.set].bad += 1
    failures.push(
      `${text}\n      期望 ${want}${expect === 'default' ? `（保持默认 ${def}）` : ''}`
      + `，实际 ${verdict.mode}（source=${verdict.source}, kind=${local.kind},`
      + ` signal=${local.signal}, 命中=${JSON.stringify(local.evidence)}）\n`
      + `      用例意图：${item.why || ''}`,
    )
  }
}

const total = checks
const passed = total - failures.length
const pct = total ? Math.round((passed / total) * 1000) / 10 : 0

const sets = Object.entries(bySet).map(([name, s]) => {
  const p = s.total - s.bad
  return `${name} ${p}/${s.total}`
})
console.log(`[eval] ${passed}/${total} 通过（${pct}%），用例 ${cases.length} 条 · ${sets.join(' · ')}`)
if (failures.length) {
  console.log('')
  for (const line of failures) console.log(`  FAIL ${line}`)
  console.log('')
  console.log('[eval] 有失败用例。这个插件的唯一目的是判断必须对，所以这里不设容忍度。')
  process.exit(1)
}
