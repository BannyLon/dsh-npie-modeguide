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
    console.log('  最近的错例（拿去补进 test/eval/cases.json）：')
    for (const item of summary.wrong.slice(0, 5)) {
      console.log(`    · [${item.mode || '?'}] ${item.input.slice(0, 60)}`)
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
  return 0
}

// 只有直接运行时才执行：被测试 import 时不该打印任何东西。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
