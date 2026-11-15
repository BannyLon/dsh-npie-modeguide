/**
 * build.mjs — 把 `src/capabilities.js` + `src/recommender.js` + `adapter.js` 内联成 `client.js`。
 *
 * 为什么要有这一步：判断逻辑必须**只有一份**。宿主半区（index.js）与浏览器半区
 * 各自抄一遍，两边迟早漂移 —— 本项目有实测教训：同一判据在两处各写一遍，两个数字
 * 对不上，而且没有任何测试能发现，因为每一侧单独看都是「对的」。
 *
 * 这里做的就是把 ESM 的 import/export 剥掉、按顺序拼进同一个作用域，再套上 Web
 * 加载器要的 `window.__ModuleLoader__.load({ id, factory })` 外壳。
 *
 * 适配层从 `adapter.js` **读文件**，不写成模板字符串：模板串里只要出现一个反引号
 * （比如注释里给某个函数名加个反引号），字符串就提前闭合，产物变成一段语法合法的
 * 减法链 —— 构建能过、用例全绿、App 起不来。
 *
 * 零依赖：不装 esbuild，也不借用别的包的 node_modules。
 *
 * 产物头部写一行 `source-sha1`，测试据此判断 client.js 是不是拿旧源码生成的
 * （不重建就跑测试 ⇒ 断言在给上一版代码发合格证）。
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PKG = 'dsh-npie-modeguide'
/**
 * 内联顺序 = 依赖顺序。`presets.js` 必须排在 `adapter.js` 前面：适配层在模块
 * 顶层就用 `PRESET_IDS` 生成显示名映射，晚于它出现会 ReferenceError。
 */
const MODULES = ['src/presets.js', 'src/capabilities.js', 'src/recommender.js']
const ADAPTER_FILE = 'adapter.js'

/**
 * 剥掉模块语法，让文件内容能直接拼进同一个函数作用域。
 * @param {string} source - 一个 ESM 源文件的内容。
 * @returns {string} 去掉 `import` 行与 `export` 关键字的等价代码。
 */
function inlineModule(source) {
  return source
    .replace(/^import\s[^\n]*?from\s*['"][^'"]+['"]\s*;?[ \t]*$/gm, '')
    .replace(/^export\s+(const|let|var|function|class|async function)\s/gm, '$1 ')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .trim()
}

/** 缩进两格，空行保持为空。 */
function indent(text) {
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n')
}

const LOCALE_FILES = ['locale/zh.json', 'locale/en.json']
const BASELINE_FILE = 'src/preset-baseline.json'
const INPUTS = [...MODULES, ADAPTER_FILE]
const sources = INPUTS.map((name) => ({ name, text: readFileSync(join(ROOT, name), 'utf8') }))
const locales = LOCALE_FILES.map((name) => ({ name, text: readFileSync(join(ROOT, name), 'utf8') }))
const baselineFile = { name: BASELINE_FILE, text: readFileSync(join(ROOT, BASELINE_FILE), 'utf8') }

// 界面文案必须一起进产物：浏览器半区读不到插件目录里的 json 文件。
// 只取 ui 段；meta 段由宿主的插件详情页自己读 locale/*.json。
const dictionaries = Object.fromEntries(locales.map((file) => [
  file.name.split('/').pop().replace(/\.json$/, ''),
  JSON.parse(file.text).ui,
]))
const localeLiteral = JSON.stringify(dictionaries)

// 能力基线同样内联：client 半区拿不到插件目录，也没有稳定的 Remote 通道可用。
// 它是从当前内核 presets/*.patch.yml 真解析出来的，不是手写的四列常量。
const baseline = JSON.parse(baselineFile.text)
if (!baseline || !Array.isArray(baseline.matrix?.columns) || baseline.matrix.columns.length !== 4) {
  throw new Error('[build] 预设基线必须含四个模式的列，先跑 npm run refresh:baseline')
}
const baselineLiteral = JSON.stringify(baseline.matrix)

// 词典与基线会被插值进下面的模板字符串。文案里一旦出现反引号或 ${，生成物会提前
// 闭合 / 二次插值，语法还合法、App 却起不来 —— 构建阶段直接拦掉。
for (const [label, literal] of [['locale', localeLiteral], ['baseline', baselineLiteral]]) {
  if (/[\x60]|\$\{/.test(literal)) {
    throw new Error(`[build] ${label} 文案含反引号或 \${，请改写文案后重建`)
  }
}

// 哈希覆盖全部输入（含词典与基线）：改了任一项不重建，测试应当报「产物是旧的」。
const hash = createHash('sha1')
  .update([...sources, ...locales, baselineFile].map((file) => file.text).join('\n'))
  .digest('hex')

const body = sources
  .map((file) => `  // ── ${file.name} ──\n${indent(inlineModule(file.text))}`)
  .join('\n\n')

const output = `/**
 * ${PKG} — 浏览器半区（由 build.mjs 生成，不要手改）。
 * source-sha1: ${hash}
 *
 * 改逻辑请改 src/capabilities.js / src/recommender.js / adapter.js，然后 node build.mjs。
 */
window.__ModuleLoader__.load({
  id: "${PKG}",
  factory: (require) => {
    const React = require('react');
    const { createPortal } = require('react-dom');
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const LOCALES = ${localeLiteral};
    const PRESET_BASELINE = ${baselineLiteral};

${body}

    return module.exports;
  }
});
`

writeFileSync(join(ROOT, 'client.js'), output)
console.log(`[build] client.js written (source-sha1 ${hash})`)
