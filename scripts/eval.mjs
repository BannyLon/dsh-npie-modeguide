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
 * ── 两层分数线（0.2.3）─────────────────────────────────────────────────────
 *
 * 三份用例集，**只有前两份卡线**：
 *
 * | 集 | 文件 | 谁写的 | 卡线 | 用途 |
 * |---|---|---|---|---|
 * | main | `test/eval/cases.json` | 我们，调规则时反复看 | ✅ | 回归，必须 100% |
 * | heldout | `test/eval/cases-heldout.json` | 我们，另写一遍不参与调参 | ✅ | 自建泛化 |
 * | external | `test/eval/external.json` | **输入来自真实会话日志**，不是为评测写的 | ❌ | 只公布 |
 *
 * 为什么 external 不卡线：它的价值是**量出真实世界的错误率**。一旦拿它卡线，
 * 每次失败都要改规则，改完这条就不再是「没见过的说法」，分数重新变成 100% 而
 * 世界并没变好 —— 那是把体温计拿去加热。卡线集与公布集分开，才能同时保住
 * 「回归不许退」与「真实错误率是个不会被我自己擦掉的数字」。
 *
 * 要把 external 也变成卡线集（例如以后外部说法足够多、冻结成回归集），
 * 显式加 `--gate-external`；默认不卡。
 *
 * 用法：npm run eval [-- --verbose] [-- --gate-external]
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recommendByRules, composeVerdict } from '../src/recommender.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODES = ['minimal', 'standard', 'ptc', 'cordis']
/** 默认模式不是常量（用户可以在设置里改），所以两种都要跑。 */
const DEFAULTS = ['standard', 'ptc']

const readSet = (file, set, gating) => {
  const path = join(ROOT, file)
  if (!existsSync(path)) return []
  const rows = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(rows)) throw new Error(`${file} 必须是数组`)
  return rows.map((c) => ({ ...c, set, gating }))
}

const cases = [
  // 开发规则时用的那批（会反复看，容易过拟合）
  ...readSet('test/eval/cases.json', 'main', true),
  // 另写的一批：用完全不同的说法，**不参与调规则**，只用来验泛化
  ...readSet('test/eval/cases-heldout.json', 'heldout', true),
  // 真实会话日志里抽的说法：输入不是我们写的，标注是我们做的
  ...readSet('test/eval/external.json', 'external', false),
  // 第二批：在改规则**之前**就按「补齐未覆盖意图」选好并冻结，用来量修完之后
  // 还剩多少错。批次一已经拿来调过规则，它的分数只能证明「那些错法被修掉了」，
  // 不能当作泛化能力；这一批才算。
  ...readSet('test/eval/external-2.json', 'external2', false),
  // 第三批：前两批都被拿来调过规则了，所以又冻了一批没碰过的。这一批跑完
  // **不再调规则** —— 一旦按它的结果改，它也就变成了调参集。
  ...readSet('test/eval/external-3.json', 'external3', false),
]
const verbose = process.argv.includes('--verbose')
const gateExternal = process.argv.includes('--gate-external')

const failures = []
const bySet = {}
let checks = 0

for (const item of cases) {
  const text = typeof item.text === 'string' ? item.text : ''
  const expect = item.expect
  // 外部集的坏条目不该让整份报告消失（它是公布项，不是回归项），但必须被看见。
  const invalid = !text || (expect !== 'default' && !MODES.includes(expect))
  if (invalid) {
    const msg = `${JSON.stringify(text)}: 用例本身不合法（expect=${expect}）`
    if (item.gating) failures.push(msg)
    else {
      bySet[item.set] = bySet[item.set] || { total: 0, bad: 0 }
      bySet[item.set].total += 1
      bySet[item.set].bad += 1
      failures.push(`[${item.set}] ${msg}`)
    }
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
    const line = `${text}\n      期望 ${want}${expect === 'default' ? `（保持默认 ${def}）` : ''}`
      + `，实际 ${verdict.mode}（source=${verdict.source}, kind=${local.kind},`
      + ` signal=${local.signal}, 命中=${JSON.stringify(local.evidence)}）\n`
      + `      用例意图：${item.why || ''}`
    failures.push(item.gating ? line : `[${item.set}] ${line}`)
  }
}

const stat = (name) => {
  const s = bySet[name] || { total: 0, bad: 0 }
  return { ...s, pass: s.total - s.bad }
}

const gatingSets = ['main', 'heldout']
const gatingTotal = gatingSets.reduce((sum, n) => sum + stat(n).total, 0)
const gatingPass = gatingSets.reduce((sum, n) => sum + stat(n).pass, 0)
// external 的失败行不参与卡线计数：卡线只认 gating 集自己的失败。
const EXTERNAL_SETS = ['external', 'external2', 'external3']
const externalStats = EXTERNAL_SETS
  .map((name) => ({ name, ...stat(name) }))
  .filter((s) => s.total > 0)
// 外部集全部失败行都带 `[external]` / `[external2]` 前缀，卡线只看不带前缀的行。
const externalFailures = failures.filter((line) => EXTERNAL_SETS.some((n) => line.startsWith(`[${n}]`)))
const gatingFailures = failures.filter((line) => !externalFailures.includes(line))

const pct = (pass, total) => (total ? Math.round((pass / total) * 1000) / 10 : 0)
const sets = gatingSets
  .map((name) => `${name} ${stat(name).pass}/${stat(name).total}`)
  .join(' · ')

console.log(`[eval] ${gatingPass}/${gatingTotal} 通过（${pct(gatingPass, gatingTotal)}%），卡线用例 ${gatingTotal} 次断言 · ${sets}`)

for (const s of externalStats) {
  // 每个外部集单独一行、单独口径：把两层分数混在一个百分比里，等于让读者以为外部也 100%。
  console.log(`[eval:${s.name}] ${s.pass}/${s.total} 通过（${pct(s.pass, s.total)}%）· ${s.bad} 条错判 · 输入来自真实会话日志，标注由作者补`)
}

if (gatingFailures.length) {
  console.log('')
  for (const line of gatingFailures) console.log(`  FAIL ${line}`)
  console.log('')
  console.log('[eval] 有失败用例。这个插件的唯一目的是判断必须对，所以卡线集不设容忍度。')
  process.exit(1)
}

if (externalFailures.length) {
  console.log('')
  console.log(`  外部集错判 ${externalFailures.length} 条（不卡线，照实公布）：`)
  for (const line of externalFailures) console.log(`  MISS ${line}`)
  console.log('')
  console.log('[eval] 外部集不参与卡线：改规则可以让它变绿，但那样它就不再是「没见过的说法」。')
  console.log('       要把它冻结成回归集，先确保它是你自己之外的说法，再加 --gate-external。')
  if (gateExternal) process.exit(1)
}
