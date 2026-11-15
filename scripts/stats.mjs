#!/usr/bin/env node
/**
 * npm run stats — 读本机反馈记录，算「判断准不准」。
 *
 * 这是反馈闭环的另一半：👎 只把「哪句话被判成什么」记进本机 JSONL，
 * 这个脚本把它折成可读的数字 —— 采纳率、按来源分、按模式分、最近的错例。
 *
 * 用法：
 *   npm run stats                        # 用宿主注入的 DSH_PROFILE_DIR
 *   npm run stats -- --file /path/x.jsonl
 *   npm run stats -- --json              # 给别的脚本吃
 *   npm run stats -- --recent 20          # 多看几条错例
 *   npm run stats -- --cluster            # 错例聚类 + 归因（该改哪条规则）
 *
 * 它不联网，也不读除这份文件以外的任何东西。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 把一组反馈记录折成统计。
 *
 * 容忍坏行：JSONL 是只追加文件，写到一半断电会留下半行。**数一下坏了几行并报出来**，
 * 而不是静默跳过 —— 静默跳过会让采纳率看起来比实际更可信。
 *
 * @param {object[]} records
 * @param {{badLines?: number}} [meta]
 * @returns {object}
 */
export function summarize(records, meta = {}) {
  const list = Array.isArray(records) ? records : []
  const blank = () => ({ up: 0, down: 0 })
  const bySource = {}
  const byMode = {}
  const byVersion = {}
  let up = 0
  let down = 0
  const wrong = []

  for (const item of list) {
    if (!item || (item.thumb !== 'up' && item.thumb !== 'down')) continue
    const isUp = item.thumb === 'up'
    if (isUp) up += 1
    else down += 1

    const source = typeof item.source === 'string' && item.source ? item.source : 'unknown'
    bySource[source] = bySource[source] || blank()
    bySource[source][isUp ? 'up' : 'down'] += 1

    const mode = typeof item.mode === 'string' && item.mode ? item.mode : 'unknown'
    byMode[mode] = byMode[mode] || blank()
    byMode[mode][isUp ? 'up' : 'down'] += 1

    const version = typeof item.ruleVersion === 'string' && item.ruleVersion ? item.ruleVersion : 'unknown'
    byVersion[version] = byVersion[version] || blank()
    byVersion[version][isUp ? 'up' : 'down'] += 1

    if (!isUp) {
      wrong.push({
        at: item.at || null,
        input: typeof item.input === 'string' ? item.input : '',
        mode: item.mode || null,
        source: item.source || null,
        signal: item.signal || null,
        // 老记录（0.2.2 之前）没有 hits：聚类会退回按信号分，别当成本条错例损坏。
        hits: Array.isArray(item.hits) ? item.hits.filter((w) => typeof w === 'string') : [],
        defaultMode: item.defaultMode || null,
        ruleVersion: item.ruleVersion || null,
      })
    }
  }

  const total = up + down
  return {
    total,
    up,
    down,
    // 采纳率：判对了多少。没有记录时是 null，而不是 0 —— 0 会被读成「全判错」。
    adoption: total ? Math.round((up / total) * 1000) / 10 : null,
    badLines: meta.badLines || 0,
    bySource,
    byMode,
    byVersion,
    wrong: wrong.reverse(),
  }
}

/**
 * 错例聚类 + 归因。
 *
 * 为什么需要它：`--recent` 只把错例原文列出来，看完仍然不知道「该改哪一条规则」。
 * 归因的前提是**把同类错法合并**：三条都被同一个「插件」带跑的错，是一个 bug，
 * 不是三个。
 *
 * 聚类的键是「判出的模式 + 第一个命中词」，没有命中词时退回「模式 + 信号」。
 * 归因（`because`）用的是**能落到规则改动上**的说法，不是「模型不准」这种废话：
 *
 *   - `宾语被当成动作证据` → 那个词要降级（strong → 对象名）
 *   - `只有一条线索就定案` → 门槛太低，或该词该降级
 *   - `该换却没换：无信号` → 缺词，需要按这一类说法补
 *   - `排错语境被当成需求` → 反向词表漏了这类说法
 *   - `否定没识别` → 否定词表漏词
 *   - `与该模式默认值相同` → 不是错判换模式，而是用户不认同默认值 → 不改规则
 *
 * @param {object[]} wrong `summarize().wrong`
 * @returns {{key: string, mode: string|null, trigger: string|null, signal: string|null,
 *   count: number, because: string, action: string, examples: object[]}[]}
 */
export function clusterWrong(wrong) {
  const list = Array.isArray(wrong) ? wrong : []
  const buckets = new Map()

  /** 「宾语类」词：出现只能说明话题，不能说明要动手。 */
  const OBJECT_WORDS = ['插件', 'plugin', '面板', 'panel', '侧栏', 'sidebar', '主题', 'theme', '预设', 'preset', 'skill', '技能']
  const NEGATION = /(不|别|没|勿|无需|不用)/

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const hits = Array.isArray(item.hits) ? item.hits.filter((w) => typeof w === 'string' && w) : []
    const trigger = hits[0] || null
    const mode = item.mode || null
    const signal = item.signal || null
    const key = trigger ? `${mode || '?'}+${trigger}` : `${mode || '?'}+${signal || 'none'}`
    if (!buckets.has(key)) buckets.set(key, { key, mode, trigger, signal, count: 0, examples: [] })
    const bucket = buckets.get(key)
    bucket.count += 1
    if (bucket.examples.length < 2) {
      bucket.examples.push({ input: String(item.input || '').slice(0, 60), defaultMode: item.defaultMode || null })
    }
  }

  const out = []
  for (const bucket of buckets.values()) {
    const sample = bucket.examples[0] || { input: '', defaultMode: null }
    let because = '其它：需要人工看原文归因'
    let action = '看下面两条原文，判断是缺词还是语义读错'
    if (bucket.mode && sample.defaultMode && bucket.mode === sample.defaultMode) {
      // 「判成默认」在记录里等于「没换模式」——那是用户不认同默认值，不是规则错。
      because = '与该模式默认值相同：结论是「不换」'
      action = '别改规则；看是默认值不合适，还是用户以为该换'
    } else if (bucket.signal === 'reverse') {
      because = '排错语境被当成了需求'
      action = '把这类说法补进 REVERSE_RULES'
    } else if (bucket.trigger && NEGATION.test(bucket.trigger)) {
      because = '否定没识别'
      action = '检查 verbPresent 的否定窗口'
    } else if (bucket.signal === 'strong' && bucket.trigger && OBJECT_WORDS.includes(bucket.trigger)) {
      because = `宾语被当成动作证据（「${bucket.trigger}」单独出现就定案）`
      action = `把「${bucket.trigger}」从 strong 降成对象名，只留「动作 + 对象」组合`
    } else if (bucket.signal === 'weak' || bucket.signal === 'strong') {
      because = '只有一条线索就给了结论'
      action = '提高门槛（要两条证据），或把这个词降级'
    } else if (bucket.signal === 'none') {
      because = '该换却没换：没有任何信号'
      action = '按这两条原文补词（注意别把纯文本任务也带进去）'
    }
    out.push({ ...bucket, because, action })
  }
  // 多的排前面：改一条能少错很多次的优先。
  return out.sort((a, b) => b.count - a.count)
}

/**
 * 解析 JSONL 文本。返回记录与坏行数（坏行不抛）。
 * @param {string} text
 * @returns {{records: object[], badLines: number}}
 */
export function parseJsonl(text) {
  const records = []
  let badLines = 0
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') records.push(parsed)
      else badLines += 1
    } catch {
      badLines += 1
    }
  }
  return { records, badLines }
}

/** 命令行里 `--flag value` 取值。 */
function flagValue(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  return typeof value === 'string' && !value.startsWith('--') ? value : ''
}

/** 默认路径：宿主注入的 profile 目录下的反馈文件。 */
export function defaultFeedbackFile(env = process.env) {
  const dir = env && typeof env.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR : ''
  return dir ? join(dir, 'npie-modeguide', 'feedback.jsonl') : null
}

function pct(value) {
  return value === null ? '—' : `${value}%`
}

function printReport(summary, file) {
  console.log(`[stats] ${file}`)
  if (!summary.total) {
    console.log('  还没有反馈记录。点一次浮层里的「判对了 / 判错了」就会写一条。')
    return
  }
  console.log(`  总计 ${summary.total} 条 · 判对 ${summary.up} · 判错 ${summary.down} · 采纳率 ${pct(summary.adoption)}`)
  if (summary.badLines) console.log(`  另有 ${summary.badLines} 行解析失败（文件被截断或手改过）`)
  const group = (title, map) => {
    const rows = Object.entries(map).sort((a, b) => (b[1].up + b[1].down) - (a[1].up + a[1].down))
    if (!rows.length) return
    console.log(`  ${title}`)
    for (const [key, value] of rows) {
      const total = value.up + value.down
      console.log(`    ${key.padEnd(12)} ${String(total).padStart(3)} 条 · 对 ${value.up} · 错 ${value.down}`)
    }
  }
  group('按来源', summary.bySource)
  group('按判出的模式', summary.byMode)
  group('按规则版本', summary.byVersion)
  if (summary.wrong.length) {
    console.log('  最近的错例（拿去补进 test/eval/cases.json；想看「该改哪条规则」加 --cluster）：')
    for (const item of summary.wrong.slice(0, 5)) {
      console.log(`    · [${item.mode || '?'}] ${item.input.slice(0, 60)}`)
    }
  }
}

/** `--cluster` 的输出：按「一类错法」打印，每条带归因和该改什么。 */
function printClusters(summary) {
  const clusters = clusterWrong(summary.wrong)
  if (!clusters.length) {
    console.log('  没有错例可聚类。')
    return
  }
  console.log(`  错例聚类（${summary.wrong.length} 条 → ${clusters.length} 类）`)
  for (const item of clusters) {
    const head = `${item.count} 次 · 判成 ${item.mode || '?'}`
    const trigger = item.trigger ? ` · 触发词「${item.trigger}」` : ''
    console.log(`    ${head}${trigger}`)
    console.log(`      归因：${item.because}`)
    console.log(`      怎么改：${item.action}`)
    for (const example of item.examples) {
      console.log(`      例：${example.input}`)
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv : []
  const explicit = flagValue(args, '--file')
  const file = explicit || defaultFeedbackFile()
  if (!file) {
    console.error('[stats] 没有 DSH_PROFILE_DIR，也没有 --file：找不到反馈文件。')
    return 2
  }
  if (!existsSync(file)) {
    // 显式指定却不存在 = 路径写错了，要报错；默认路径不存在 = 还没用过，正常。
    if (explicit) {
      console.error(`[stats] 文件不存在：${file}`)
      return 1
    }
    console.log(`[stats] ${file}`)
    console.log('  还没有反馈记录。点一次浮层里的「判对了 / 判错了」就会写一条。')
    return 0
  }
  const { records, badLines } = parseJsonl(readFileSync(file, 'utf8'))
  const summary = summarize(records, { badLines })
  if (args.includes('--json')) {
    const recent = Number(flagValue(args, '--recent'))
    const limit = Number.isFinite(recent) && recent > 0 ? recent : 5
    console.log(JSON.stringify({ file, ...summary, wrong: summary.wrong.slice(0, limit) }, null, 2))
    return 0
  }
  printReport(summary, file)
  // 聚类单独一段，不挤掉总数与分布：先看「错了多少」，再看「该改哪条」。
  if (args.includes('--cluster')) printClusters(summary)
  return 0
}

// 只有直接运行时才执行：被测试 import 时不该打印任何东西。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
