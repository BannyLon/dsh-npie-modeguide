/**
 * dsh-npie-modeguide — 行为测试。
 *
 * 断言的每一处都对应一个「踩过或会踩的坑」，不是为覆盖率写的：
 *  - 能力解析的正确性直接决定推荐结论，解析错 ⇒ 推荐反着来。
 *  - `disabled: true` 与 `disabled: !!js ...` 必须区别对待。
 *  - 极简模式的 tool-fs 是「只读图片」，按包名数会算成有完整文件能力。
 *  - 规则冲突时必须交 LLM，不能硬选一个。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildMatrix,
  analyzePreset,
  parsePluginTree,
  evalDisabledExpr,
  isFsGatedOff,
  CAPABILITIES,
} from '../src/capabilities.js'
import {
  recommendByRules,
  composeVerdict,
  parseLlmVerdict,
  buildLlmPrompt,
  sanitizeMatrix,
  normalizeText,
  explainVerdict,
} from '../src/recommender.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const fixture = (id) => readFileSync(join(ROOT, 'fixtures', `${id}.yml`), 'utf8')
const presets = ['minimal', 'ptc', 'standard', 'cordis'].map((id) => ({ id, content: fixture(id) }))

// ── 能力解析 ────────────────────────────────────────────────────────────────

test('解析真实预设：极简模式没有文件写入，其余三个都有', () => {
  const minimal = analyzePreset(fixture('minimal'))
  const ptc = analyzePreset(fixture('ptc'))
  // 极简挂了 tool-fs，但 read/write/edit 全关 —— 必须判成「没有文件读写」。
  assert.equal(minimal.capabilities.files, false, '极简模式不应具备文件读写')
  assert.equal(ptc.capabilities.files, true)
})

test('解析真实预设：工作流只出现在标准与创造，PTC 明确关掉了', () => {
  const byId = Object.fromEntries(presets.map((p) => [p.id, analyzePreset(p.content)]))
  assert.equal(byId.ptc.capabilities.workflow, false, 'PTC 关掉了 workflow，绝不能算成有')
  assert.equal(byId.standard.capabilities.workflow, true)
  assert.equal(byId.cordis.capabilities.workflow, true)
})

test('解析真实预设：execute 代码执行器只有 PTC 有', () => {
  const byId = Object.fromEntries(presets.map((p) => [p.id, analyzePreset(p.content)]))
  assert.equal(byId.ptc.capabilities.ptc, true)
  assert.equal(byId.standard.capabilities.ptc, false)
  assert.equal(byId.cordis.capabilities.ptc, false)
})

test('解析真实预设：改 DSH 本体只有创造模式有；Office 只有标准与 PTC 有', () => {
  const byId = Object.fromEntries(presets.map((p) => [p.id, analyzePreset(p.content)]))
  assert.equal(byId.cordis.capabilities.cordis, true)
  assert.equal(byId.standard.capabilities.cordis, false)
  assert.equal(byId.ptc.capabilities.cordis, false)
  assert.equal(byId.cordis.capabilities.office, false, '创造模式没有 Office 工具')
  assert.equal(byId.standard.capabilities.office, true)
})

test('解析真实预设：极简模式没有联网与子代理', () => {
  const minimal = analyzePreset(fixture('minimal'))
  assert.equal(minimal.capabilities.web, false)
  assert.equal(minimal.capabilities.subagent, false)
})

test('嵌套 group 里的插件必须被算进去（这是树，不是平表）', () => {
  const tree = parsePluginTree(fixture('standard'))
  const delegation = findNode(tree, 'delegation')
  assert.ok(delegation, '应当解析出 delegation 这个 group')
  assert.ok(delegation.children.some((c) => c.name.includes('dsh-tool-subagent')), '子代理应在 group 内')
})

test('disabled: true 与 !!js 平台判断分开处理', () => {
  const yaml = [
    '          - id: a',
    "            name: '@deepseek-ai/dsh-tool-web'",
    '            disabled: true',
    '          - id: b',
    "            name: '@deepseek-ai/dsh-tool-office'",
    "            disabled: !!js process.platform === 'win32'",
  ].join('\n')
  const tree = parsePluginTree(yaml)
  assert.equal(tree[0].disabled, true)
  // 在 macOS 上，`=== 'win32'` 为假 ⇒ 没被禁用。
  assert.equal(tree[1].disabled, false)
  const other = parsePluginTree(yaml, 'win32')
  assert.equal(other[1].disabled, true)
})

test('无法求值的 !!js 表达式标成 conditional，不猜', () => {
  assert.equal(evalDisabledExpr("someUnknownFlag()"), 'conditional')
  const yaml = [
    '          - id: a',
    "            name: '@deepseek-ai/dsh-tool-web'",
    '            disabled: !!js someUnknownFlag()',
  ].join('\n')
  const result = analyzePreset(yaml)
  assert.equal(result.capabilities.web, 'conditional')
  assert.deepEqual(result.unknown, ['web'])
})

test('父节点确定关闭时，子节点能力一律视为关闭（group 语义）', () => {
  const yaml = [
    '          - id: grp',
    '            name: cordis:group',
    '            disabled: true',
    '            config:',
    '              - id: inner',
    "                name: '@deepseek-ai/dsh-tool-web'",
  ].join('\n')
  assert.equal(analyzePreset(yaml).capabilities.web, false)
})

test('tool-fs 的降级判断只认 read/write/edit 同时为 false', () => {
  assert.equal(isFsGatedOff('  read: false\n  write: false\n  edit: false'), true)
  assert.equal(isFsGatedOff('  read: true\n  write: false\n  edit: false'), false)
  assert.equal(isFsGatedOff(''), false)
})

test('只挂 dsh-tool-fs-search 不能被算成有文件读写（子串匹配的反向对照）', () => {
  // 把 pkg === m 改回 node.name.includes(m) 这条就会红：
  // '@deepseek-ai/dsh-tool-fs-search' 含 'dsh-tool-fs'，会被误判成完整文件能力。
  const yaml = [
    '          - id: only-search',
    "            name: '@deepseek-ai/dsh-tool-fs-search'",
  ].join('\n')
  const result = analyzePreset(yaml)
  assert.equal(result.capabilities.search, true)
  assert.equal(result.capabilities.files, false, '搜索工具不等于文件读写工具')
})

test('对照表只保留有差异的能力行', () => {
  const matrix = buildMatrix(presets)
  const ids = matrix.rows.map((r) => r.id)
  assert.ok(ids.includes('workflow'), '工作流有差异，应当出现')
  assert.ok(ids.includes('ptc'), 'execute 有差异，应当出现')
  // 四个模式都有终端（只是极简用持久 shell 的另一套包名），不该在表里。
  assert.ok(!ids.includes('shell'), '四个模式都有的能力不该出现在对照表')
  assert.equal(matrix.columns.length, 4)
})

test('带子路径的包名仍能被识别：插件管理在标准/创造视环境可用、PTC 明确关闭', () => {
  // 预设里写的是 '@deepseek-ai/dsh-plugin-manager/tools'。
  // 只取 split('/').pop() 会得到 'tools'，这一项就全模式变 false、从表里消失。
  const byId = Object.fromEntries(presets.map((p) => [p.id, analyzePreset(p.content)]))
  // standard/cordis 的 disabled 是 `!!js "!ctx.get('profileContext')"`，无法静态求值，
  // 按三态设计标 conditional，而不是猜成 true。
  assert.equal(byId.standard.capabilities.pluginManager, 'conditional')
  assert.equal(byId.cordis.capabilities.pluginManager, 'conditional')
  assert.equal(byId.ptc.capabilities.pluginManager, false, 'PTC 写的是 disabled: true')
  assert.ok(buildMatrix(presets).rows.some((r) => r.id === 'pluginManager'))
})

test('预设顺序决定列顺序，且不改输入数组', () => {
  const input = [...presets].reverse()
  const matrix = buildMatrix(input)
  assert.deepEqual(matrix.columns.map((c) => c.id), ['cordis', 'standard', 'ptc', 'minimal'])
  assert.deepEqual(input.map((p) => p.id), ['cordis', 'standard', 'ptc', 'minimal'])
})

test('空输入与坏输入不抛', () => {
  assert.deepEqual(buildMatrix([]).rows, [])
  assert.deepEqual(buildMatrix(null).rows, [])
  assert.deepEqual(analyzePreset('').capabilities, analyzePreset('').capabilities)
  assert.equal(analyzePreset(undefined).pluginCount, 0)
})

// ── 推荐规则 ────────────────────────────────────────────────────────────────

test('批量处理归 PTC（不是「标准」也不是「极简」）', () => {
  const result = recommendByRules('帮我把下载目录 300 个文件按类型分类重命名')
  assert.equal(result.kind, 'decided')
  assert.equal(result.mode, 'ptc')
})

// ── 盲测抓到的错判：这四条都是「结论错了但理由读起来像事实」那一类 ──────────

test('「遍历」单独出现不算决定性特征；遍历一批文件才算', () => {
  // 遍历一个 JSON / 一个数组是普通编程，标准模式的 bash 就够 —— 不该换 PTC。
  const objectOnly = recommendByRules('遍历一下这个 JSON 看看结构')
  assert.notEqual(objectOnly.kind, 'decided', '遍历单个对象不该定案')
  assert.equal(composeVerdict(objectOnly, null, 'standard').mode, 'standard')
  // 反向对照：同一句话加上「目录 + 所有文件」就必须定案，否则是降级降成了漏判。
  const bunch = recommendByRules('遍历目录下所有文件，把 jpg 改成 png')
  assert.equal(bunch.kind, 'decided')
  assert.equal(bunch.mode, 'ptc')
})

test('问「模式本身的区别」不是点名要用某个模式', () => {
  // 「对比一下标准模式和 PTC 模式的区别」里有字面「PTC 模式」，pinned 会直接定案 ——
  // 这是盲测里最容易骗过守卫的一条。
  for (const text of ['对比一下标准模式和 PTC 模式的区别', '哪个模式适合做文档排版']) {
    const result = recommendByRules(text)
    assert.notEqual(result.kind, 'decided', `「${text}」不该定案`)
    assert.equal(result.mode, null, `「${text}」不该给出模式`)
    // 已确认不用换：既不问模型（noToolNeed），也不是排错文案。
    assert.equal(result.noToolNeed, true, `「${text}」应标记为不需要换模式`)
    assert.equal(composeVerdict(result, null, 'standard').mode, 'standard')
  }
})

test('排错语境的词表覆盖「打不开 / 闪退 / 解释下」这类说法', () => {
  const cases = [
    '我的插件昨天还好好的今天打不开了',
    '打开这个面板就闪退了',
    '给我解释下这段代码是怎么遍历数组的',
  ]
  for (const text of cases) {
    const result = recommendByRules(text)
    assert.notEqual(result.kind, 'decided', `「${text}」是排错 / 解释，不该定案`)
    assert.equal(result.noToolNeed, true, `「${text}」应压回默认模式且不再问模型`)
  }
  // 反向对照：不含排错语义的同类词仍然定案（别把 whole 词表撑成万能拦截器）。
  assert.equal(recommendByRules('写个插件，给侧栏加一个按钮').mode, 'cordis')
})

test('规则表结构：ptc 的决定性特征里没有「遍历」，它只在组合判据与部分证据里', () => {
  const src = readText('src/recommender.js')
  const start = src.indexOf("id: 'ptc'")
  assert.ok(start > 0, '没找到 ptc 规则块')
  // 截到这条规则结束：MODE_RULES 里每条以「\n  },」收尾。
  const ptcBlock = src.slice(start, src.indexOf('\n  },', start))
  const strongLine = ptcBlock.split('\n').find((line) => line.trim().startsWith('strong:')) || ''
  assert.ok(strongLine, '没找到 ptc 的 strong 行')
  assert.ok(!strongLine.includes('遍历'), '「遍历」不许回到 strong：单条不足以定案')
  assert.match(ptcBlock, /verbs: \['遍历'/, '组合判据里应保留遍历动词')
})

test('讲解 / 卸载 / 统计条数：强信号不能压过「这不是任务」', () => {
  for (const text of [
    '给我讲讲 cordis 插件是怎么加载的',
    '帮我把这个插件卸载了',
    '帮我在这个目录下找所有 .log 并统计条数',
  ]) {
    const result = recommendByRules(text)
    assert.notEqual(result.kind, 'decided', `「${text}」不该定案`)
    assert.equal(result.noToolNeed, true, `「${text}」应留在默认模式`)
  }
  // 反向对照：真要做批量的事，仍然定案 —— 别把上面几条修成「什么都判不换」。
  assert.equal(recommendByRules('批量把截图里的表格转成 csv').mode, 'ptc')
})

test('改界面的动词放宽后，组合判据仍然要求 DSH 内部对象', () => {
  // 断言必须落在 kind 上：`suggest` 结果也会带 mode，只比 mode 的断言对实现坏掉无感。
  for (const [text, mode] of [['我想让侧栏默认折叠', 'cordis'], ['给这个按钮换个颜色', 'cordis']]) {
    const result = recommendByRules(text)
    assert.equal(result.kind, 'decided', `「${text}」应定案`)
    assert.equal(result.mode, mode, `「${text}」应归 ${mode}`)
  }
  // 反向对照：「让 / 换」单看太泛，配上非 DSH 对象就必须沉默。
  for (const text of ['加一点盐', '让它快一点', '把这个表格换个颜色']) {
    assert.notEqual(recommendByRules(text).kind, 'decided', `「${text}」不该定案`)
  }
})

test('极简的点名写法认量词：跑一次基线 / 做一次基线与跑基线等价', () => {
  for (const text of ['跑一次基线，只改这一行看差异', '跑基线看差异']) {
    const result = recommendByRules(text)
    assert.equal(result.kind, 'decided', `「${text}」应定案`)
    assert.equal(result.mode, 'minimal', `「${text}」应归极简`)
  }
})

test('网页语境的按钮 / 侧栏不是改 DSH 本体', () => {
  for (const text of ['给这个网页加一个返回顶部按钮', '用 react 写一个可折叠侧栏组件']) {
    assert.notEqual(recommendByRules(text).kind, 'decided', `「${text}」不该定案`)
  }
  // 反向对照：句中出现 DSH 相关词时，网页排除必须让位 —— 否则真需求会被吞掉。
  assert.equal(recommendByRules('写个插件，给页面加个按钮').mode, 'cordis')
  assert.equal(recommendByRules('给侧栏加个折叠按钮').mode, 'cordis')
})

test('写插件归创造模式', () => {
  const result = recommendByRules('给我写个插件，在侧边栏加一个按钮')
  assert.equal(result.kind, 'decided')
  assert.equal(result.mode, 'cordis')
})

test('工作流编排归标准模式（PTC 关掉了 workflow）', () => {
  const result = recommendByRules('用工作流并行编排，把这两百个文件逐个审计一遍')
  assert.equal(result.kind, 'decided')
  assert.equal(result.mode, 'standard')
})

test('纯净基线归极简模式', () => {
  const result = recommendByRules('我要做一个纯净基线做对照')
  assert.equal(result.kind, 'decided')
  assert.equal(result.mode, 'minimal')
})

test('两个强信号冲突时必须交 LLM，不能硬选一个', () => {
  // 没有点名任何工具，但两个模式的「任务特征」都命中了。
  const result = recommendByRules('这个插件要批量处理这批文件')
  assert.equal(result.kind, 'unknown', '创造与 PTC 的特征同时命中，本地不该给结论')
  assert.equal(result.mode, null)
  assert.match(result.reason, /冲突/)
})

test('用户点名要某个工具时，指令压过任务特征（不再判成冲突）', () => {
  // 「写个插件」是明确指令：写插件只有创造模式能做。即使后面还说了「批量处理」，
  // 也不该因为 PTC 的特征命中就判成冲突、白白多调一次模型。
  const result = recommendByRules('写个插件批量处理这批文件')
  assert.equal(result.kind, 'decided')
  assert.equal(result.mode, 'cordis')
  assert.equal(result.pinned, true)
})

test('同时点名两个模式才算是真歧义', () => {
  // 「用工作流」点名标准，「做纯净基线」点名极简 —— 两个都是指令，需要判断主诉求。
  const result = recommendByRules('先做个纯净基线，然后用工作流把结果重跑一遍')
  assert.equal(result.kind, 'unknown')
  assert.match(result.reason, /同时点名/)
})

test('没有信号或输入太短时不给结论', () => {
  assert.equal(recommendByRules('看看这个项目有什么问题').kind, 'unknown')
  assert.equal(recommendByRules('改').kind, 'unknown')
  assert.equal(recommendByRules('').kind, 'unknown')
})

test('推荐的模式在当前环境不存在时，退回 unknown 而不是推荐一个装不上的', () => {
  // 环境里只有 standard：规则指向 cordis，但装不上。
  const result = recommendByRules('给我写个插件', { available: ['standard', 'ptc'] })
  assert.equal(result.kind, 'unknown')
  assert.match(result.reason, /没有这个预设/)
})

test('弱信号只给建议，不定案', () => {
  const result = recommendByRules('这个表格需要整理一下')
  assert.equal(result.kind, 'suggest')
  assert.equal(result.mode, 'ptc')
  assert.ok(result.confidence < 0.5)
})

test('归一化处理全角标点', () => {
  assert.match(normalizeText('批量，处理；文件'), /批量.*处理/)
})

// ── LLM 合成 ────────────────────────────────────────────────────────────────

test('LLM 结论只在本地拿不准时才被采用', () => {
  const decided = recommendByRules('给我写个插件')
  const verdict = composeVerdict(decided, { mode: 'ptc', reason: '模型说的', confidence: 0.8 }, 'ptc')
  assert.equal(verdict.mode, 'cordis', '本地有把握时，模型不该覆盖规则')
  assert.equal(verdict.source, 'rules')
})

test('本地 unknown 时采用 LLM 结论', () => {
  const undecided = recommendByRules('这个插件要批量处理这批文件')
  assert.equal(undecided.kind, 'unknown')
  const verdict = composeVerdict(undecided, { mode: 'cordis', reason: '写插件是核心诉求', confidence: 0.8 }, 'ptc')
  assert.equal(verdict.mode, 'cordis')
  assert.equal(verdict.source, 'llm')
})

test('LLM 没结论时退回默认模式，不报错', () => {
  const undecided = recommendByRules('看看这个项目')
  const verdict = composeVerdict(undecided, null, 'ptc')
  assert.equal(verdict.mode, 'ptc')
  assert.equal(verdict.source, 'default')
})

test('解析 LLM 输出：容忍代码围栏与前后废话', () => {
  const modes = ['standard', 'ptc', 'minimal', 'cordis']
  assert.equal(parseLlmVerdict('```json\n{"mode":"cordis","reason":"x","confidence":0.9}\n```', modes).mode, 'cordis')
  assert.equal(parseLlmVerdict('我的判断是 {"mode":"ptc","reason":"y"} 就这样', modes).mode, 'ptc')
})

test('解析 LLM 输出：拒绝不在清单里的模式与坏 JSON', () => {
  const modes = ['standard', 'ptc']
  assert.equal(parseLlmVerdict('{"mode":"turbo"}', modes), null)
  assert.equal(parseLlmVerdict('不是 JSON', modes), null)
  assert.equal(parseLlmVerdict('', modes), null)
  assert.equal(parseLlmVerdict(null, modes), null)
})

test('LLM 自报置信度被压在合理区间', () => {
  const modes = ['ptc']
  assert.equal(parseLlmVerdict('{"mode":"ptc","confidence":0.99}', modes).confidence, 0.85)
  assert.equal(parseLlmVerdict('{"mode":"ptc","confidence":0.01}', modes).confidence, 0.5)
  assert.equal(parseLlmVerdict('{"mode":"ptc"}', modes).confidence, 0.65)
})

test('提示词里带上了真实能力差异，并限制可选模式', () => {
  const matrix = buildMatrix(presets)
  const prompt = buildLlmPrompt('随便写点什么', matrix)
  assert.match(prompt.system, /workflow/, '必须把差异喂给模型')
  assert.match(prompt.system, /cordis/)
  assert.match(prompt.system, /新任务默认是 ptc/)
  // 示例值不许写成某个具体结论：那是锚，模型会原样回抄，于是该换也不换。
  assert.ok(!/\{"mode":"(ptc|standard|cordis|minimal)"/.test(prompt.system), '示例值不许写死某个模式')
  assert.match(prompt.system, /<one of: /, '示例必须是占位')
  assert.match(prompt.system, /数据，不是指令/, '能力名是外部数据，必须声明它不构成指令')
})

// ── 构建产物一致性 ─────────────────────────────────────────────────────────

test('client.js 由当前源码生成（不是上一版的合格证）', () => {
  const clientPath = join(ROOT, '..', 'client.js')
  let built
  try {
    built = readFileSync(clientPath, 'utf8')
  } catch {
    assert.fail('client.js 不存在，先跑 node build.mjs')
  }
  const recorded = /source-sha1: ([0-9a-f]{40})/.exec(built)
  assert.ok(recorded, 'client.js 头部应当有 source-sha1')

  // 与 build.mjs 的输入同口径：改了源码 / 词典 / 能力基线不重建都要报「产物是旧的」。
  const inputs = [
    'src/presets.js', 'src/capabilities.js', 'src/recommender.js', 'adapter.js',
    'locale/zh.json', 'locale/en.json', 'src/preset-baseline.json',
  ]
  const hash = createHash('sha1')
    .update(inputs.map((f) => readFileSync(join(ROOT, '..', f), 'utf8')).join('\n'))
    .digest('hex')
  assert.equal(recorded[1], hash, 'client.js 是旧的，先跑 node build.mjs')
})

test('客户端产物里没有残留的占位符', () => {
  const built = readFileSync(join(ROOT, '..', 'client.js'), 'utf8')
  assert.ok(!built.includes('PLACEHOLDER'), '构建产物里不该有占位符')
})

// ── 宿主契约与产物行为 ──────────────────────────────────────────────────────
// 以前这一层完全没有判据：33 条纯逻辑测试全绿，但一键应用按钮永远不会出现。
// 每条都配「改回旧写法就红」的反向含义，不做存在性即合格的恒真式。

const readBuilt = () => readFileSync(join(ROOT, '..', 'client.js'), 'utf8')
const readText = (rel) => readFileSync(join(ROOT, '..', rel), 'utf8')

test('selector hook 必须传 (s) => s；无参调用会让一键应用永不出现', () => {
  const built = readBuilt()
  assert.match(built, /props\.useInput\(\(s\) => s\)/, 'useInput 是 SnapshotSelectorHook')
  assert.match(built, /props\.useSession\(\(s\) => s\)/, 'useSession 是 SnapshotSelectorHook')
  assert.ok(!/props\.use(Input|Session)\(\)/.test(built), '不许退回无参调用')
  assert.match(built, /session\.blank === true/, '空白会话判据必须读真实字段')
})

test('产物真的读取了宿主配置，模型请求受 llmFallback 约束', () => {
  const built = readBuilt()
  assert.match(built, /const CONFIG_PATH = '\/api\/npie-modeguide\/config'/)
  assert.match(built, /fetch\(CONFIG_PATH, \{ cache: 'no-store', signal \}\)/)
  assert.match(built, /llmFallback: data\.llmFallback !== false/, '配置开关必须真读进 runtimeConfig')
  assert.match(built, /timeoutMs: Number\.isFinite\(host\)/, '宿主的 timeoutMs 也必须真读，不能只把它写在配置表里')
  assert.match(built, /runtimeConfig\.llmFallback/, '模型请求必须受配置开关约束')
  assert.match(built, /local\.kind !== 'unknown'/, '只有规则拿不准才继续')
  assert.match(built, /await refreshConfig\(\)/, '判断前现读配置，不用打开浮层时 fire-and-forget 的旧值')
  assert.match(built, /askHost\(text, baseline, modelMs\)/, '问模型用基线，且等待上限按配置算')
  assert.match(built, /withTimeout\(askHost\(/, '问模型必须带硬超时')
})

test('slots.inject 的 disposer 被 ctx.effect 清理，样式也走 effect', () => {
  const built = readBuilt()
  assert.match(built, /const off = ctx\.slots\.inject/)
  assert.match(built, /if \(typeof off === 'function'\) off\(\)/)
  assert.match(built, /return \(\) => style\.remove\(\)/)
})

test('所有按钮都给了显式宽度，防宿主 button{width:100%} 撑成横条', () => {
  const built = readBuilt()
  assert.match(built, /\.npie-mg-btn\{width:auto/)
  assert.match(built, /\.npie-mg-trigger\{width:28px/, '图标入口是固定 28px')
  assert.match(built, /\.npie-mg-close\{width:22px/)
  assert.match(built, /\.npie-mg-disclosure\{width:auto/)
})

test('产物带中英词典，且 en 不是中文', () => {
  const built = readBuilt()
  assert.match(built, /const LOCALES = \{/)
  assert.match(built, /"mnemonic"/)
  const zh = JSON.parse(readText('locale/zh.json')).ui
  const en = JSON.parse(readText('locale/en.json')).ui
  assert.notEqual(en.trigger, zh.trigger, '英文词典不能是中文复刻')
  assert.match(en.sheetTitle, /[A-Za-z]/)
  assert.match(en.mnemonic, /[A-Za-z]/)
})

test('所有静态文案 key 在中英词典里都有对应项', () => {
  const adapter = readText('adapter.js')
  const keys = [...adapter.matchAll(/\bt\('([A-Za-z][A-Za-z0-9_]*)'\)/g)].map((m) => m[1])
  assert.ok(keys.length >= 20, `静态文案 key 太少（${keys.length}），判据可能没扫到`)
  const zh = JSON.parse(readText('locale/zh.json')).ui
  const en = JSON.parse(readText('locale/en.json')).ui
  for (const key of new Set(keys)) {
    assert.ok(zh[key], `zh.json 缺 ${key}`)
    assert.ok(en[key], `en.json 缺 ${key}`)
  }
  // 动态 key：能力行 cap_<id>、四个模式名与短名。
  for (const cap of CAPABILITIES) {
    assert.ok(zh['cap_' + cap.id] && en['cap_' + cap.id], `能力 ${cap.id} 缺翻译`)
  }
  for (const key of ['mode_minimal', 'mode_standard', 'mode_ptc', 'mode_cordis', 'short_minimal', 'short_standard', 'short_ptc', 'short_cordis']) {
    assert.ok(zh[key] && en[key], `${key} 缺翻译`)
  }
})

test('宿主与客户端共用同一份提示词/解析，不再各写一遍', () => {
  const host = readText('index.js')
  assert.match(host, /from '\.\/src\/recommender\.js'/)
  assert.match(host, /buildLlmPrompt\(input, matrix, fallback\)/, '提示词必须带宿主现读的默认模式')
  assert.match(host, /parseLlmVerdict\(acc, modeIds\)/)
  assert.ok(!/function buildPrompt\(/.test(host), '宿主不许再留第二份提示词')
  assert.ok(!/function describeMatrix\(/.test(host))
})

test('界面文案只来自词典，不在 JSX 里再硬编码一遍', () => {
  const built = readBuilt()
  // 取词典里的真实句子去数：出现两次就说明 JSX 里又抄了一遍。
  const hint = JSON.parse(readText('locale/zh.json')).ui.hint
  assert.ok(hint && hint.length > 8, '判据要拿一句真文案当样本')
  const occurrences = built.split(hint).length - 1
  assert.equal(occurrences, 1, '这句应只出现在 zh 词典里一次')
  // 再抽一条：按钮文案同理，不许在渲染层写死。
  const judge = JSON.parse(readText('locale/zh.json')).ui.judge
  assert.equal(built.split(`>${judge}<`).length - 1, 0, '按钮文字必须来自 t()，不许写在 JSX 里')
})

// ── 渲染级判据 ──────────────────────────────────────────────────────────────
// 静态断言只能证明「代码里写了」，证明不了「按钮真的画出来」。这里用轻量 React mock
// 真跑一遍 client.js 的 factory：点开浮层、点「给建议」、等异步判断完成，再看 DOM 树。

/** 在虚拟树里找按钮（按可见文本）。 */
function findButton(node, text) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button') {
    const label = (node.children || []).filter((c) => typeof c === 'string').join('')
    if (label.includes(text)) return node
  }
  for (const child of node.children || []) {
    const found = findButton(child, text)
    if (found) return found
  }
  return null
}

/** 虚拟树里是否含有某段文字。 */
function containsText(node, text) {
  if (typeof node === 'string') return node.includes(text)
  if (!node || typeof node !== 'object') return false
  return (node.children || []).some((child) => containsText(child, text))
}

/** 入口改成图标后没有可见文字，按 aria-label 找。 */
function findTrigger(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button' && typeof node.props?.['aria-label'] === 'string'
    && node.props['aria-label'].includes('模式推荐')) return node
  for (const child of node.children || []) {
    const found = findTrigger(child)
    if (found) return found
  }
  return null
}

/** 按 class 找节点。 */
function findByClass(node, cls) {
  if (!node || typeof node !== 'object') return null
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes(cls)) return node
  for (const child of node.children || []) {
    const found = findByClass(child, cls)
    if (found) return found
  }
  return null
}

/** 结论区显示的模式名：只看这一处，别被说明文字里的同名串骗过去。 */
function modeText(node) {
  const el = findByClass(node, 'npie-mg-mode')
  if (!el) return ''
  return (el.children || []).filter((c) => typeof c === 'string').join('')
}

/** 虚拟树里是否含有某个标签（用来验图标真的画进去了）。 */
function containsTag(node, tag) {
  if (!node || typeof node !== 'object') return false
  if (node.type === tag) return true
  return (node.children || []).some((child) => containsTag(child, tag))
}

test('真渲染：空白会话出一键应用按钮，已开始会话只给说明', async () => {
  const built = readBuilt()
  const contents = Object.fromEntries(
    ['minimal', 'standard', 'ptc', 'cordis'].map((id) => [id, fixture(id)]),
  )

  async function renderWith(blank, options = {}) {
    const selectCalls = []
    const fetches = []
    // 反向对照入口：把产物里的能力基线换成空表，能力表就必须消失。
    let source = options.breakBaseline
      ? built.replace(/^    const PRESET_BASELINE = .*$/m, '    const PRESET_BASELINE = {"columns":[],"rows":[]};')
      : built
    if (options.deadButton) {
      // 反向对照：把一键应用的 onClick 换成空函数，真点击判据必须抓得到。
      const broken = source.replace(/onClick: \(\) => void applyMode\(\)/g, 'onClick: () => {}')
      assert.notEqual(broken, source, '死按钮替换没命中')
      source = broken
    }
    if (options.noReflectFallback) {
      // 反向对照：摘掉 presetsApi 的 reflect 软取，proxy 场景必须翻红。
      const broken = source.replace(
        /const soft = reflect && typeof reflect\.get === 'function'\s*\?\s*reflect\.get\('remote\.agentPresets', false\)\s*:\s*null/,
        'const soft = null',
      )
      assert.notEqual(broken, source, 'reflect 软取替换没命中')
      source = broken
    }
    if (options.noWhy) {
      // 反向对照：结论区退回旧的短 reason，两句详实理由必须在渲染树里消失。
      const broken = source.replace(/verdict\.why \|\| verdict\.reason/g, 'verdict.reason')
      assert.notEqual(broken, source, '理由渲染替换没命中')
      source = broken
    }
    if (options.breakDefaultSync) {
      // 反向对照：把 /config 下发默认这一步改坏，结论必须停在旧的 ptc。
      const broken = source.replace('changed = adoptDefaultMode(data.defaultMode)', 'changed = false')
      assert.notEqual(broken, source, '默认模式同步替换没命中')
      source = broken
    }
    let factory = null
    let renderFn = null
    let tree = null
    let stateIdx = 0
    let refIdx = 0
    const states = []
    const refs = []
    let currentProps = null
    // 第一个 ref 是 anchorRef：给它一个假 DOM，hover 提示与定位才有 rect 可量。
    const fakeAnchor = {
      getBoundingClientRect: () => ({ left: 330, top: 420, bottom: 448, right: 358, width: 28, height: 28 }),
      contains: () => false,
    }

    const React = {
      createElement(type, props, ...children) {
        const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
        if (typeof type === 'function') return type({ ...(props || {}), children: flat })
        return { type, props: props || {}, children: flat }
      },
      useState(init) {
        const i = stateIdx++
        if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
        return [states[i], (value) => {
          states[i] = typeof value === 'function' ? value(states[i]) : value
          rerender()
        }]
      },
      useRef(init) {
        const i = refIdx++
        if (!(i in refs)) refs[i] = { current: i === 0 ? fakeAnchor : init }
        return refs[i]
      },
      useEffect() { return undefined },
    }
    function rerender() {
      stateIdx = 0
      refIdx = 0
      tree = renderFn(currentProps)
    }

    const sandbox = {
      window: {
        __ModuleLoader__: { load: (spec) => { factory = spec.factory } },
        innerWidth: 1280,
        innerHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      },
      document: {
        createElement: () => ({ setAttribute() {}, remove() {}, set textContent(v) {} }),
        head: { appendChild() {} },
        body: {},
      },
      navigator: { language: 'zh-CN' },
      console,
      setTimeout: options.fastTimers ? (fn, ms) => setTimeout(fn, Math.min(ms, 5)) : setTimeout,
      clearTimeout,
      fetch: async (url, init) => {
        fetches.push([url, init && init.method, init && init.body])
        // /config 模拟宿主下发的真实默认：内置 ptc，可改成用户在设置页选的别的模式。
        const config = {
          llmFallback: options.llmFallback === true,
          defaultMode: options.noHostDefault ? null : (options.hostDefaultMode || 'ptc'),
        }
        if (url === '/api/npie-modeguide/config') return { ok: true, status: 200, json: async () => config }
        // /feedback：默认「真记上了」；feedbackOk:false 用来验「没记上就不许说记上了」。
        if (url === '/api/npie-modeguide/feedback') {
          const stored = options.feedbackOk !== false
          return {
            ok: true,
            status: 200,
            json: async () => (stored ? { ok: true, stored: true } : { ok: false, error: 'no-storage' }),
          }
        }
        // /stats：宿主计数器。
        if (url === '/api/npie-modeguide/stats') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              stats: { judge: 77, model: 3, cacheHit: 2, limited: 1, avgModelMs: 420, feedbackUp: 4, feedbackDown: 2 },
            }),
          }
        }
        // /judge 默认回空对象（＝模型没给结论）；配额场景显式给状态码与 body。
        const judge = options.judgeResponse
        if (judge) {
          return {
            ok: (judge.status || 200) < 400,
            status: judge.status || 200,
            json: async () => judge.body ?? {},
          }
        }
        return { ok: true, status: 200, json: async () => ({}) }
      },
    }
    vm.runInNewContext(source, sandbox)

    const mod = factory((name) => (name === 'react' ? React : { createPortal: (node) => node }))
    // 把 remote api 抽出来：cordisProxy 场景里它只从 reflect 软取才拿得到。
    const agentPresetsApi = {
      list: options.stallList
        ? () => new Promise(() => {}) // 复现宿主真实故障：list() 永不 resolve
        : async () => ({ ok: true, value: { presets: [
          { id: 'ptc', name: 'PTC', isDefault: true },
          { id: 'standard', name: 'Standard' },
          { id: 'minimal', name: 'Minimal' },
          { id: 'cordis', name: 'Creative' },
        ] } }),
      read: options.stallRead
        ? () => new Promise(() => {}) // 永不 resolve：复现「判断中…」卡五分钟
        : async (id) => ({ ok: true, value: { content: contents[id] } }),
      ...(options.noSelect ? {} : {
        select: options.stallSelect
          ? () => new Promise(() => {}) // 宿主挂起：一键应用不许永远停在「切换中…」
          : async (sid, mode) => {
              selectCalls.push([sid, mode])
              return options.selectFails
                ? { ok: false, error: { message: 'agent-preset/locked' } }
                : { ok: true, value: mode }
            },
      }),
    }
    const ctx = {
      get: () => null, // locale 缺席 → 走内置词典兜底
      effect: (fn) => { fn(); return () => {} },
      slots: {
        inject: (_name, cb) => { cb(); return () => {} },
        register: (_opts, render) => { renderFn = render; return {} },
      },
      // 真机 cordis facade：未 inject 的 service 访问**抛异常**，`?.` 拦不住。
      // 报错文案与宿主 reflect.ts 逐字一致。
      remote: options.cordisProxy
        ? new Proxy({}, {
            get(_target, prop) {
              if (prop === 'agentPresets') {
                throw new Error('cannot get property "remote.agentPresets" without inject')
              }
              return undefined
            },
          })
        : { agentPresets: agentPresetsApi },
      reflect: {
        get: (name, strict) => (name === 'remote.agentPresets' && !strict ? agentPresetsApi : undefined),
      },
    }
    mod.apply(ctx)

    const selectorCalls = []
    currentProps = {
      ctx,
      sessionId: 'session-1',
      useInput: (sel) => { selectorCalls.push('input'); return sel({ draft: options.draft || '给我写个插件' }) },
      useSession: (sel) => { selectorCalls.push('session'); return sel({ sessionId: 'session-1', blank }) },
    }
    rerender()

    const trigger = findTrigger(tree)
    assert.ok(trigger, '工具栏入口应真渲染出来')
    assert.ok(containsTag(trigger, 'svg'), '入口必须是图标，不是四个文字')
    assert.equal(findButton(tree, '模式推荐'), null, '工具栏不该再用「模式推荐」四个字当按钮文本')
    trigger.props.onMouseEnter()
    const tip = findByClass(tree, 'npie-mg-tipbox')
    assert.ok(tip, 'hover 要显示说明')
    assert.ok(containsText(tip, '模式推荐'), 'hover 说明写的是「模式推荐」')
    trigger.props.onMouseLeave()

    // 定位：按钮上方有 420px，面板实测 300px ⇒ 必须贴着按钮顶部向上展开。
    const anchorRect = { left: 330, top: 420, bottom: 448, width: 28, height: 28 }
    const above = mod.computePopoverPosition(anchorRect, 300, { width: 1280, height: 800 })
    assert.equal(above.placement, 'above', '上方够高时必须向上展开')
    assert.equal(above.left, 322, '左缘对齐触发按钮')
    assert.equal(above.top, 110, '底边离按钮顶部 10px')
    assert.equal(above.arrowLeft, 22, '箭头指到按钮中心')
    // 反向对照：内容比上方空间还高时，面板必须被压进可用空间，
    // 而不是翻到下方或向下溢出盖住工具栏（这正是用户截图里的问题）。
    const tooTall = mod.computePopoverPosition(anchorRect, 560, { width: 1280, height: 800 })
    assert.equal(tooTall.placement, 'above', '上方够用就绝不翻到下方')
    assert.equal(tooTall.maxHeight, 402, 'maxHeight 必须等于按钮上方可用空间')
    assert.equal(tooTall.height, 402, '实测内容再高也要被钳住')
    assert.equal(tooTall.top, 8, '面板不许向下溢出')
    const tight = mod.computePopoverPosition({ left: 330, top: 120, bottom: 148, width: 28, height: 28 }, 300, { width: 1280, height: 800 })
    assert.equal(tight.placement, 'below', '上方连 200px 都放不下才允许翻到下方')

    trigger.props.onClick() // 打开浮层

    // 高度预算：没结论时给用法说明，出结论后收起 —— 两句理由才不会把面板撑高。
    assert.ok(containsText(tree, '把任务写下来'), '没出结论时用法说明要显示')
    const judgeBtn = findButton(tree, '给建议')
    assert.ok(judgeBtn, '浮层里的判断按钮应真渲染出来')
    assert.equal(judgeBtn.props.disabled, false, '输入框草稿已带入，按钮不该是禁用的')
    judgeBtn.props.onClick()

    // 关键：结论必须在**这一刻**（不等任何 await）就已经画出来。
    assert.ok(containsText(tree, options.expectedMode || '创造模式'), '点下去立刻出结论，不许等 Remote')
    assert.ok(!containsText(tree, '判断中…'), '界面不许出现无限等待状态')

    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    if (options.fastTimers) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.ok(selectorCalls.includes('input') && selectorCalls.includes('session'), 'selector hook 真的被调用了')
    assert.ok(containsText(tree, '口诀'), '更简单的方法（口诀）应当直接展示给用户')
    // rerender() 会替换整棵树，外部要能拿到点击之后的最新树。
    tree.__selectCalls = selectCalls
    tree.__fetches = fetches
    tree.__latest = () => tree
    return tree
  }

  async function settle() {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const blankTree = await renderWith(true)
  const applyBtn = findButton(blankTree, '切到这个模式')
  assert.ok(applyBtn, '空白会话必须出现一键应用按钮')
  // ★ 真点一下。只验「按钮在」会放过「按钮点了是死的」—— 真机实测故障。
  applyBtn.props.onClick()
  await settle()
  assert.deepEqual(
    blankTree.__selectCalls,
    [['session-1', 'cordis']],
    '点了必须真调 agentPresets.select(sessionId, mode)，参数与官方 seat-store 一致',
  )
  const appliedTree = blankTree.__latest()
  assert.ok(containsText(appliedTree, '已切换。'), '成功说明必须出现在界面上')
  assert.equal(findButton(appliedTree, '切到这个模式'), null, '成功后按钮自己要变成「已切换」')

  // 复现真机「点了完全没反应」：remote 缺席时旧实现提前 return，按钮不变、
  // 只在滚动区塞一行 10.5px 小字。现在按钮必须自己变字并给出可操作入口。
  const noRemote = await renderWith(true, { noSelect: true })
  const noRemoteBtn = findButton(noRemote, '切到这个模式')
  assert.ok(noRemoteBtn)
  noRemoteBtn.props.onClick()
  await settle()
  const noRemoteAfter = noRemote.__latest()
  assert.ok(containsText(noRemoteAfter, '重试切换'), 'remote 缺席时按钮必须变字，不能毫无反应')
  assert.ok(containsText(noRemoteAfter, '这个环境不支持切换模式'), '必须说出不能用的原因')
  assert.ok(containsText(noRemoteAfter, '当前显示模式名'), '必须指出手动切换入口')
  assert.ok(!containsText(noRemoteAfter, '「标准模式」'), '手动入口不许硬编码成某个具体模式：当前模式未必是标准')

  // 宿主拒绝（agent-preset/locked）也要有可见结论，且允许重试。
  const refused = await renderWith(true, { selectFails: true })
  const refusedBtn = findButton(refused, '切到这个模式')
  assert.ok(refusedBtn)
  refusedBtn.props.onClick()
  await settle()
  const refusedAfter = refused.__latest()
  assert.ok(containsText(refusedAfter, '重试切换'), '失败后按钮要能重试')
  assert.ok(containsText(refusedAfter, 'agent-preset/locked'), '要把宿主给的真实原因显示出来')

  // select 永不返回：硬超时兜底，不许永远停在「切换中…」。
  const hung = await renderWith(true, { stallSelect: true, fastTimers: true })
  const hungBtn = findButton(hung, '切到这个模式')
  assert.ok(hungBtn)
  hungBtn.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const hungAfter = hung.__latest()
  assert.ok(containsText(hungAfter, '切换超时'), '宿主挂起时必须超时并给结论')
  assert.ok(!containsText(hungAfter, '切换中…'), '不许永远停在切换中')

  // 反向对照：按钮在、点了却是死的 —— 真点击判据必须能发现（不是「存在即有效」）。
  const dead = await renderWith(true, { deadButton: true })
  const deadBtn = findButton(dead, '切到这个模式')
  assert.ok(deadBtn, '反向对照前置条件：按钮仍画得出来')
  deadBtn.props.onClick()
  await settle()
  assert.deepEqual(dead.__selectCalls, [], '按钮是死的时必须一次 select 都没调到')
  assert.ok(containsText(dead.__latest(), '切到这个模式'), '按钮是死的时界面不该谎报已切换')

  // 真机实测：cordis facade 对未 inject 的 service **抛** without inject。
  // 修复后靠「fiber inject 声明（静态守卫验）+ reflect 软取（这里验）」双保险，
  // 点一下仍要真调到 select，绝不把那句英文异常当「切换失败」糊给用户。
  const proxied = await renderWith(true, { cordisProxy: true })
  const proxiedBtn = findButton(proxied, '切到这个模式')
  assert.ok(proxiedBtn)
  proxiedBtn.props.onClick()
  await settle()
  assert.deepEqual(proxied.__selectCalls, [['session-1', 'cordis']], '属性代理抛错时仍要真调到 select')
  assert.ok(containsText(proxied.__latest(), '已切换。'), '不能把 without inject 当成切换失败')
  assert.ok(!containsText(proxied.__latest(), 'without inject'), '不许把 cordis 内部异常文案糊给用户')

  // 反向对照：摘掉 reflect 软取后 proxy 场景必须翻红，证明上面的绿不是恒真式。
  const noFallback = await renderWith(true, { cordisProxy: true, noReflectFallback: true })
  const noFallbackBtn = findButton(noFallback, '切到这个模式')
  assert.ok(noFallbackBtn)
  noFallbackBtn.props.onClick()
  await settle()
  assert.deepEqual(noFallback.__selectCalls, [], '没有软取兜底时属性代理抛错，select 不该被调到')
  assert.ok(containsText(noFallback.__latest(), '重试切换'), '降级时必须给可见的重试入口')

  const startedTree = await renderWith(false)
  assert.equal(findButton(startedTree, '切到这个模式'), null, '已开始的会话不该显示必然失败的按钮')
  assert.ok(containsText(startedTree, '这个任务已经开始'), '应当说明为什么不能切换')

  // 用户实测故障：Remote 的 read 永不返回（或落进 error 分支）。
  // 结论与能力表都必须当场出现，界面上一句「读不到」都不许有。
  const stalled = await renderWith(true, { stallRead: true, fastTimers: true })
  assert.ok(containsText(stalled, '创造模式'), 'Remote 挂起时本地结论仍必须出现')
  assert.ok(containsText(stalled, '查看模式之间的差异'), 'Remote 挂起时能力表仍必须出现')
  assert.ok(!containsText(stalled, '预设暂时读不到'), '不许再向用户报告这条无关的错误')
  assert.ok(!containsText(stalled, '判断中…'), '不许把用户锁在等待里')

  // list() 永久挂起（宿主的另一个真实故障）同样不该影响界面。
  const stalledList = await renderWith(true, { stallList: true })
  assert.ok(!containsText(stalledList, '预设暂时读不到'), 'list() 挂住不许影响能力表')
  assert.ok(containsText(stalledList, '查看模式之间的差异'), '四个预设都读到了，能力表必须出现')

  // 反向对照：把产物里的能力基线换成空表，能力表必须消失。
  // 没有这条，上面几条可能只是「按钮永远都在」的恒真式。
  const broken = built.replace(/^    const PRESET_BASELINE = .*$/m, '    const PRESET_BASELINE = {"columns":[],"rows":[]};')
  assert.ok(broken !== built, '反向对照必须真的替换到产物里的基线常量')
  const noBaseline = await renderWith(true, { breakBaseline: true, stallRead: true, fastTimers: true })
  assert.ok(!containsText(noBaseline, '查看模式之间的差异'), '基线清空后能力表必须消失')

  // 两句理由必须真画在结论区；退回旧的短 reason 就得翻红（存在性 ≠ 有效性）。
  const whyTree = await renderWith(true)
  assert.ok(containsText(whyTree, '依据当前版本内核预设解析出的 13 项差异'), '详实理由必须真画出来')
  assert.ok(!containsText(whyTree, '把任务写下来'), '出结论后用法说明必须收起，抵消理由的 5 行高度')
  assert.match(readBuilt(), /verdict \? null : h\('p', \{ className: 'npie-mg-hint' \}/,
    '说明行必须是条件渲染，不能靠 CSS 藏')
  const noWhy = await renderWith(true, { noWhy: true })
  assert.ok(!containsText(noWhy, '依据当前版本内核预设解析出的'), '反向对照：退回短 reason 必须消失')

  // 已确定「不用换」时不许再白等一次模型；真歧义仍要兜底，否则 0 次 POST 是恒真式。
  const poem = await renderWith(true, {
    draft: '我想写一首诗', expectedMode: 'PTC 模式', llmFallback: true,
  })
  assert.equal(poem.__fetches.filter(([, method]) => method === 'POST').length, 0,
    '写首诗已能本地定案，不该再发模型请求')
  assert.ok(containsText(poem, '没有任何一项是这个任务所必需的'))
  const conflict = await renderWith(true, {
    draft: '这个插件要批量处理这批文件', expectedMode: 'PTC 模式', llmFallback: true,
  })
  assert.ok(conflict.__fetches.filter(([, method]) => method === 'POST').length > 0,
    '信号冲突必须真的问模型')

  // 反馈闭环：按钮要真发出一条记录，且只有宿主说记上了才敢说「已记在本机」。
  const fbTree = await renderWith(true, { draft: '我想写一首诗', expectedMode: 'PTC 模式' })
  const downBtn = findButton(fbTree, '判错了')
  assert.ok(downBtn, '有结论就必须有反馈入口')
  assert.equal(downBtn.props['aria-pressed'], 'false', '没点之前不许是按下态')
  downBtn.props.onClick()
  await settle()
  const fbPost = fbTree.__fetches.find(([url, method, body]) => url === '/api/npie-modeguide/feedback' && method === 'POST' && body)
  assert.ok(fbPost, '点「判错了」必须真发一条记录')
  const fbBody = JSON.parse(fbPost[2])
  assert.equal(fbBody.thumb, 'down')
  assert.equal(fbBody.mode, 'ptc')
  assert.equal(fbBody.source, 'default')
  assert.equal(fbBody.defaultMode, 'ptc', '要记下当时的默认，否则事后无法复原判断前提')
  assert.ok(!('at' in fbBody), '时间由宿主写，客户端不许自己造一个')
  assert.ok(containsText(fbTree.__latest(), '已记在本机'), '记上了要明说')

  // 反向对照：宿主回「没记上」（没有 profile 目录就是这种），界面不许说记上了。
  const fbFail = await renderWith(true, { draft: '我想写一首诗', expectedMode: 'PTC 模式', feedbackOk: false })
  findButton(fbFail, '判错了').props.onClick()
  await settle()
  assert.ok(containsText(fbFail.__latest(), '没记上'), '写盘失败必须说出来')
  assert.ok(!containsText(fbFail.__latest(), '已记在本机'), '写盘失败不许谎报成功')

  // 本机统计：默认收起；展开才去宿主取一次，取到的数字照实画。
  assert.ok(!containsText(fbTree, '模型调用'), '统计默认收起，不占地方')
  findButton(fbTree, '本机统计').props.onClick()
  await settle()
  assert.ok(fbTree.__fetches.some(([url]) => url === '/api/npie-modeguide/stats'), '展开时才去宿主取')
  assert.ok(containsText(fbTree.__latest(), '模型调用'), '展开后要有宿主计数')
  assert.ok(containsText(fbTree.__latest(), '420ms'), '平均耗时照实画，不编')
  // 总数必须真画出来：「三项之和 = 总数」是「来源切换先减后加」唯一能被看见的破绽，
  // 只画三个分项等于把核对依据藏掉。77 是宿主下发值，出现即证明真读了 payload。
  assert.ok(containsText(fbTree.__latest(), '判了几次'), '要有总数行')
  assert.ok(containsText(fbTree.__latest(), '77'), '总数要来自宿主下发，不是本地编的')

  // 配额用光：界面要说清「还要等多久」，而不是笼统说「模型没回应」。
  const limited = await renderWith(true, {
    draft: '这个插件要批量处理这批文件', expectedMode: 'PTC 模式', llmFallback: true,
    judgeResponse: { status: 429, body: { ok: false, error: 'rate-limited', retryAfterMs: 12000 } },
  })
  await settle()
  const limitedTree = limited.__latest()
  assert.ok(containsText(limitedTree, '问得太频繁'), '配额用光必须说成配额问题，不能冒充故障')
  assert.ok(containsText(limitedTree, '12 秒'), '秒数只能来自宿主的 retryAfterMs，客户端不许自己编')
  assert.ok(!containsText(limitedTree, '模型没回应'), '配额问题与「模型没回应」必须分开说')

  // 用户在「设置 → Agent 预设」把新任务默认改成标准模式：结论、两句理由、
  // 界面标注与主按钮都要跟着变，且不许再调 select 把会话从默认切走。
  const followed = await renderWith(true, {
    draft: '我想写一首诗', expectedMode: 'PTC 模式', hostDefaultMode: 'standard',
  })
  // renderWith 内部已在点击当场断言过 PTC（expectedMode），这里等后台对齐完成。
  await settle()
  const followedTree = followed.__latest()
  assert.equal(modeText(followedTree), '标准模式', '默认改成标准后，结论必须从硬编码的 PTC 跟着变')
  assert.ok(containsText(followedTree, '当前新任务默认：标准模式'), '界面要说出当前的真实默认')
  assert.ok(containsText(followedTree, '留在「标准模式」是照当前的新任务默认保持不动'),
    '两句理由必须按新默认重算，不能停在旧口径')
  const keepBtn = findButton(followedTree, '保持当前默认')
  assert.ok(keepBtn, '结论就是当前默认时，主按钮要改成「保持当前默认」')
  keepBtn.props.onClick()
  await settle()
  assert.deepEqual(followed.__selectCalls, [], '结论等于默认时不许调 select 把会话切走')
  assert.ok(containsText(followed.__latest(), '无需切换'), '点了要给出可见结论，不能毫无反应')

  // 反向对照：把 /config 下发默认这一步改坏，上面的绿就得消失。
  const stuck = await renderWith(true, {
    draft: '我想写一首诗', expectedMode: 'PTC 模式',
    hostDefaultMode: 'standard', breakDefaultSync: true,
  })
  await settle()
  assert.notEqual(modeText(stuck.__latest()), '标准模式', '下发默认被摘掉后不许谎称跟随成功')

  // 宿主 /config 没读到默认时，官方 roster 的 isDefault 要能兜上，且界面标的是 PTC。
  const roster = await renderWith(true, {
    draft: '我想写一首诗', expectedMode: 'PTC 模式', noHostDefault: true,
  })
  await settle()
  assert.equal(modeText(roster.__latest()), 'PTC 模式', 'roster 兜底给的是 ptc，结论不该乱跳')
  assert.ok(containsText(roster.__latest(), '当前新任务默认：PTC 模式'),
    '兜底读到了就正常标当前默认，不谎报「未读到」')
})

test('能力表以基线为准，实时读取只做后台校正，失败完全静默', () => {
  const adapter = readText('adapter.js')
  const start = adapter.indexOf('async function refineMatrix')
  const end = adapter.indexOf('请宿主代问一次模型')
  assert.ok(start !== -1 && end > start, '必须能截到 refineMatrix 函数体')
  const fn = adapter.slice(start, end)
  assert.ok(!/\.list\s*\(/.test(fn), '不许再调 list()：它会 await loader.await() 死等')
  assert.match(fn, /presets\.read\(id\)/, '实时校正走 read() 直读')
  assert.match(fn, /withTimeout\(presets\.read\(id\), READ_TIMEOUT_MS, null\)/, '每个 read 都带独立超时')
  assert.match(fn, /Promise\.all\(/, '四个模式并行读')
  // 新契约（0.2.2）：内置四列必须全读到才换表，自定义预设是**加分项**，
  // 读不到就少一列，不影响内置结论（缺列会把「不知道」画成「没有」）。
  assert.match(fn, /!baselineIds\.every\(\(id\) => byId\.has\(id\)\)\) return null/, '缺一列宁可保留完整基线')
  assert.match(fn, /readRoster\(ctx\)/, '列要来自 roster，否则自定义预设根本不会出现在表里')
  assert.match(fn, /extraIds/, 'roster 里多出来的预设要追加成新列')
  assert.ok(!/error:/.test(fn), 'refineMatrix 不许再产出任何错误态')

  const judge = adapter.slice(adapter.indexOf('const runJudge = async () =>'), adapter.indexOf('// 应用：只在空白会话出现'))
  assert.match(judge, /matrix: baseline/, '第一次 setState 就把基线画出来')
  assert.ok(!/presetTimeout|presetErrorPrefix|busyPresets/.test(judge), '不许再渲染「预设读不到」或核对状态')
  assert.match(judge, /withTimeout\(refineMatrix\(props\.ctx\), PRESET_TIMEOUT_MS, null\)\.then\(/, '实时校正在后台，失败返回 null 不打扰用户')
})

/** 在 vm 里加载真实产物，拿到 adapter 导出的纯函数 —— 与真机同一份代码。 */
function loadClient() {
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { factory = spec.factory } } },
    document: {
      createElement: () => ({ setAttribute() {}, remove() {}, set textContent(v) {} }),
      head: { appendChild() {} },
      body: {},
    },
    navigator: { language: 'zh-CN' },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  }
  vm.runInNewContext(readText('client.js'), sandbox)
  const react = {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect() {},
    useRef: () => ({ current: null }),
  }
  return factory((name) => (name === 'react' ? react : { createPortal: (node) => node }))
}

test('任意预设：能力表多出自定义预设那一列，内置缺列时才放弃换表', async () => {
  const list = async () => ({
    ok: true,
    value: {
      presets: [
        { id: 'standard' }, { id: 'ptc', isDefault: true }, { id: 'minimal' }, { id: 'cordis' },
        { id: 'doc-writer', name: '文档模式' },
      ],
    },
  })
  const read = async (id) => ({
    ok: true,
    value: {
      content: fixture(id === 'doc-writer' ? 'standard' : id),
      name: id === 'doc-writer' ? '文档模式' : id,
    },
  })
  const ctx = { remote: { agentPresets: { list, read } } }

  const mod = loadClient()
  const matrix = await mod.refineMatrix(ctx)
  assert.ok(matrix, '内置四列都读到了就必须换表')
  assert.equal(matrix.columns.length, 5, '自定义预设要有自己的一列')
  assert.equal(matrix.columns[4].id, 'doc-writer')
  assert.equal(matrix.columns[4].name, '文档模式', '列名用预设自带的名字')
  // vm 里的数组属于另一个 realm，deepEqual 会因原型不同而假红 —— 比字符串。
  assert.equal(
    matrix.columns.slice(0, 4).map((c) => c.id).join(','),
    BASELINE_MATRIX.columns.map((c) => c.id).join(','),
    '内置四列的顺序不许被自定义预设打乱',
  )
  // 词典里没有的 id 回落到预设自带名，而不是把原始 id 甩给用户。
  assert.equal(mod.modeLabel('doc-writer', (key) => key, matrix), '文档模式')
  assert.equal(mod.modeLabel('standard', (key) => key, matrix), 'standard', '没有词典时退回 id，但不抛错')

  // 反向对照 1：内置某一列读不到 ⇒ 一列都不换。
  const lostBuiltin = await loadClient().refineMatrix({
    remote: { agentPresets: { list, read: async (id) => (id === 'minimal' ? { ok: true, value: null } : read(id)) } },
  })
  assert.equal(lostBuiltin, null, '内置缺一列时必须保留基线')

  // 反向对照 2：自定义预设读不到 ⇒ 只少那一列，内置四列照常换。
  const lostCustom = await loadClient().refineMatrix({
    remote: { agentPresets: { list, read: async (id) => (id === 'doc-writer' ? { ok: true, value: null } : read(id)) } },
  })
  assert.equal(lostCustom.columns.length, 4, '自定义预设读不到只少一列，不许连内置一起放弃')
})

/** 在树里按 id 找节点。 */
function findNode(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children || [], id)
    if (found) return found
  }
  return null
}

// ── 本轮修复的守卫 ──────────────────────────────────────────────────────────

test('本地结论在第一次 await 之前就 setState，任何 Remote 都不许挡在前面', () => {
  const adapter = readText('adapter.js')
  const start = adapter.indexOf('const runJudge = async () =>')
  const end = adapter.indexOf('// 应用：只在空白会话出现')
  assert.ok(start !== -1 && end > start, '必须能定位到 runJudge')
  const fn = adapter.slice(start, end)
  const firstAwait = fn.indexOf('await ')
  const firstSetState = fn.indexOf('setState(')
  assert.ok(firstSetState !== -1, 'runJudge 里必须有 setState')
  assert.ok(firstSetState < firstAwait, '结论必须同步先出，不能等任何 await')
  assert.match(fn, /withTimeout\(refineMatrix/, '实时校正要带硬超时，且不挡在结论前面')
  assert.match(fn, /withTimeout\(askHost/, '模型调用要带硬超时')
})

test('宿主侧 LLM 流与请求体都有硬截止点，handler 不会永不返回', () => {
  const host = readText('index.js')
  assert.match(host, /consumeWithDeadline\(/)
  assert.match(host, /Promise\.race\(\[consume, deadline\]\)/, '不能只靠 signal：流未必响应 abort')
  assert.match(host, /setTimeout\(\(\) => done\(''\), 5000\)/, '请求体流也要有截止点')
})

test('浮层按实测高度定位，箭头不会被 overflow 裁掉', () => {
  const adapter = readText('adapter.js')
  assert.match(adapter, /pop\.offsetHeight/, '要量 offsetHeight：入场动画的 transform 会污染 getBoundingClientRect')
  assert.match(adapter, /maxHeight: pos\.maxHeight \+ 'px'/, '面板高度必须被上方空间钳住')
  assert.match(adapter, /'data-placement': pos\.placement/, '箭头朝向跟着 placement 走')
  assert.ok(!/\.npie-mg-pop\{[^}]*overflow:auto/.test(adapter), 'pop 自身不能 overflow:auto')
  assert.match(adapter, /\.npie-mg-scroll\{overflow:auto/, '滚动交给内部容器')
  assert.match(adapter, /new ResizeObserver\(compute\)/, '出结论 / 展开表格后要重算位置')
})

test('图标入口、hover 提示与 reduced-motion 都在产物里', () => {
  const built = readBuilt()
  assert.match(built, /'aria-label': t\('triggerAria'\)/, '图标按钮必须有可访问名称')
  assert.match(built, /'npie-mg-tipbox'/, 'hover 说明挂到 body，避开工具栏 overflow 裁剪')
  assert.match(built, /role: 'tooltip'/)
  assert.match(built, /prefers-reduced-motion:reduce/)
  assert.match(built, /viewBox: '0 0 24 24'/, '图标是内联 SVG，不依赖外部资源')
})

// ── 能力基线：内置数据必须真进产物，且可刷新 ───────────────────────────────

test('能力基线真进产物：四列齐全，且差异与当前内核预设一致', () => {
  const built = readBuilt()
  const m = /^    const PRESET_BASELINE = (.+);$/m.exec(built)
  assert.ok(m, 'client.js 里必须有内联的 PRESET_BASELINE')
  const baseline = JSON.parse(m[1])
  assert.deepEqual(baseline.columns.map((c) => c.id), ['standard', 'ptc', 'minimal', 'cordis'])
  assert.ok(baseline.rows.length >= 8, '差异行不能只剩一两行')
  // 外层 key 是能力 id，内层 key 是模式 id —— 写反会静默读到 undefined。
  const cellsOf = Object.fromEntries(baseline.rows.map((r) => [r.id, r.cells]))
  assert.equal(cellsOf.ptc.ptc, true, 'PTC 独有 execute')
  assert.equal(cellsOf.cordis.cordis, true, '创造独有改 DSH 本体')
  assert.equal(cellsOf.files.minimal, false, '极简关掉文件读写')
  assert.equal(cellsOf.workflow.standard, true, '标准独有工作流编排')

  // 与源文件同源：产物里的基线必须与 src/preset-baseline.json 逐字一致。
  const src = JSON.parse(readText('src/preset-baseline.json')).matrix
  assert.deepEqual(baseline, src, '产物里的基线不是当前源文件生成的')
})

test('基线纳入构建哈希，且有从内核重新生成的入口', () => {
  const build = readText('build.mjs')
  assert.match(build, /BASELINE_FILE = 'src\/preset-baseline\.json'/)
  assert.match(build, /\[\.\.\.sources, \.\.\.locales, baselineFile\]/, '基线要进 sha1')
  assert.match(build, /const PRESET_BASELINE = \$\{baselineLiteral\};/)
  const refresh = readText('scripts/refresh-baseline.mjs')
  assert.match(refresh, /buildMatrix\(presets\)/, '刷新脚本必须真调用解析器，不是抄常量')
  assert.match(refresh, /app\.asar/, '数据来自当前安装的内核')
  const pkg = JSON.parse(readText('package.json'))
  assert.match(pkg.scripts['refresh:baseline'], /refresh-baseline/)
})

test('错误提示与状态文案整套撤干净，中英词典一致', () => {
  const dead = ['presetTimeout', 'presetErrorPrefix', 'presetErrorSuffix', 'busyPresets']
  const zh = JSON.parse(readText('locale/zh.json')).ui
  const en = JSON.parse(readText('locale/en.json')).ui
  for (const [file, dict] of [['zh', zh], ['en', en]]) {
    for (const key of dead) assert.ok(!(key in dict), `${file} 里还留着 ${key}`)
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '中英 key 集合必须一致')
  const adapter = readText('adapter.js')
  for (const key of dead) assert.ok(!adapter.includes(`t('${key}')`), `adapter.js 还在用 ${key}`)
})

test('客户端预加载包名清单完整（写错名字会被加载器静默跳过）', () => {
  const inject = JSON.parse(readText('package.json')).dsh.client.inject
  for (const name of [
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-session',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-workspace',
  ]) assert.ok(inject.includes(name), `inject 缺 ${name}`)
})

test('一键应用：先进入 applying 再检查 remote，结果画在按钮本身', () => {
  const applyOrderOk = (code) => {
    const applying = code.indexOf('setApplying(true)')
    const gate = code.indexOf("typeof presets.select !== 'function'")
    return applying > 0 && gate > 0 && applying < gate
  }
  const src = readText('adapter.js')
  const built = readBuilt()
  for (const [name, code] of [['源码', src], ['产物', built]]) {
    assert.equal(applyOrderOk(code), true, `${name} 把 remote 检查放在 setApplying 之前 —— 会「点了没反应」`)
    assert.ok(code.includes("'data-apply-tone'"), `${name} 按钮没有结果态`)
    assert.ok(code.includes("t('applyRetry')"), `${name} 失败后按钮不变字`)
    assert.ok(code.includes('APPLY_TIMEOUT_MS'), `${name} select 没有硬超时`)
    assert.ok(code.includes('session.id'), `${name} 不认官方 SessionSnapshot 的 id 字段`)
  }
  // 反向对照：把 setApplying(true) 挪到 remote 检查之后，守卫必须翻红。
  const line = '    setApplying(true)\n'
  assert.ok(src.includes(line), '找不到要挪动的那一行')
  const broken = src.replace(line, '').replace(
    '    } finally {\n      setApplying(false)',
    '      setApplying(true)\n    } finally {\n      setApplying(false)',
  )
  assert.notEqual(broken, src)
  assert.equal(applyOrderOk(broken), false, '顺序守卫是恒真式')
})

// ── cordis service 注入契约 ────────────────────────────────────────────────

/**
 * 产物里每一个 `remote.<ns>` 访问都必须在 fiber inject 里有 `'remote.<ns>'`。
 * 缺一项时 cordis 的 ReflectService 属性代理**直接抛**
 * `cannot get property "remote.<ns>" without inject`，`?.` 拦不住抛。
 * 0.1.5 真机「切换失败：cannot get property "remote.agentPresets" without inject」
 * 就是这么来的 —— 当时只往 dsh.client.inject（包名列表）里加包，改错了层。
 */
function assertInjectCoverage(source) {
  const match = source.match(/inject:\s*\[([^\]]*)\]/)
  assert.ok(match, '找不到 fiber inject 数组')
  const declared = new Set(
    [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] || m[2]),
  )
  const used = new Set(
    [...source.matchAll(/\bremote\.([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  )
  for (const ns of used) {
    assert.ok(
      declared.has(`remote.${ns}`),
      `remote.${ns} 被访问却没在 inject 里声明 —— 属性代理会抛 without inject`,
    )
  }
  assert.ok(declared.has('remote.agentPresets'), '缺少 remote.agentPresets 声明')
  return { declared, used }
}

test('fiber inject 覆盖所有 remote.* 访问，预加载包名在内核里真实存在', () => {
  const built = readBuilt()
  const { used } = assertInjectCoverage(built)
  assert.ok(used.has('agentPresets'), '前置：产物确实访问了 remote.agentPresets')
  // 源码同口径，防止「只改产物不改源码」的假绿。
  assertInjectCoverage(readText('adapter.js'))

  // 反向对照：把声明摘掉，守卫必须翻红（不是恒真式）。
  const broken = built.replace(
    "inject: ['slots', 'remote', 'remote.agentPresets']",
    "inject: ['slots', 'remote']",
  )
  assert.notEqual(broken, built, 'inject 反向对照替换没命中')
  assert.throws(() => assertInjectCoverage(broken), /没在 inject 里声明|缺少 remote\.agentPresets/)

  // dsh.client.inject 是**包名**列表：写错名字加载器会静默跳过（graphRows.get 取不到）。
  // 下面是显式白名单，2026-11-15 逐项对照过当前安装 app.asar 的 @deepseek-ai 目录；
  // 内核升级后需人工复核，它不是每次自动从 asar 读出来的。
  const KNOWN_BUNDLES = [
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-session',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-workspace',
  ]
  const inject = JSON.parse(readText('package.json')).dsh.client.inject
  for (const name of inject) {
    assert.ok(KNOWN_BUNDLES.includes(name), `预加载包名在内核里不存在：${name}（会静默失效）`)
  }
  // 官方 dsh-client-ui-agent-preset 的同款依赖，一个都不能少。
  for (const name of [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-session',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-workspace',
  ]) assert.ok(inject.includes(name), `缺官方同款预加载包 ${name}`)
})

// ── 超时链、不可信输入、文档口径 ──────────────────────────────────────────────

/** 在产物里换掉 runtimeConfig.timeoutMs，取回 modelTimeoutMs() 的真实返回值。 */
function modelTimeoutOf(source, hostMs) {
  const declaration = /let runtimeConfig = \{ llmFallback: true, timeoutMs: \d+ \}/
  assert.match(source, declaration, '产物里找不到 runtimeConfig 声明')
  // 注意：hostMs 恰等于默认值时 patched 会与 source 相同，这不算「没命中」——
  // 用上面的 match 验声明存在，而不是用替换结果是否变化来验。
  const patched = source.replace(
    declaration,
    `let runtimeConfig = { llmFallback: true, timeoutMs: ${hostMs} }`,
  )
  let factory = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { factory = spec.factory } } },
    navigator: { language: 'zh-CN' },
    console,
  }
  vm.runInNewContext(patched, sandbox)
  const mod = factory((name) => (name === 'react' ? {} : { createPortal: () => null }))
  return mod.modelTimeoutMs()
}

test('客户端等待上限必须长于宿主判定超时，配置不是摆设', () => {
  const built = readBuilt()
  const hostDefault = Number(/timeoutMs:\s*(\d+)/.exec(readText('cordis.patch.yml'))?.[1])
  assert.ok(Number.isFinite(hostDefault) && hostDefault > 0, '读不到宿主默认 timeoutMs')
  assert.ok(
    modelTimeoutOf(built, hostDefault) > hostDefault,
    `宿主允许 ${hostDefault}ms，客户端必须等得更久；否则慢模型下宿主还在算、客户端早已放弃`,
  )
  assert.equal(modelTimeoutOf(built, 1000), 6000, '短配置仍守 6s 下限')
  assert.ok(modelTimeoutOf(built, 120000) <= 122000, '超长配置要被夹在上限内')
  // 反向对照：把余量改成负数，客户端又会比宿主先放弃 —— 守卫必须能抓到。
  const broken = built.replace(
    'const MODEL_TIMEOUT_SLACK_MS = 2000',
    'const MODEL_TIMEOUT_SLACK_MS = -2000',
  )
  assert.notEqual(broken, built, '余量反向对照替换没命中')
  assert.ok(modelTimeoutOf(broken, hostDefault) <= hostDefault, '余量为负时守卫不是恒真式')
})

test('/judge 的畸形能力矩阵不会把 handler 带进未捕获异常', () => {
  const bad = [
    null,
    { columns: [{ id: 'ptc' }], rows: [{ id: 'x', label: 'X' }] },
    { columns: [null], rows: [] },
    { columns: 'nope', rows: 'nope' },
    { columns: [{ id: 'ptc' }], rows: [{ id: 'y', label: 'Y', cells: { ptc: true } }] },
  ]
  for (const matrix of bad) {
    assert.doesNotThrow(() => buildLlmPrompt('整理一批文件', matrix), '提示词构造不许抛')
    const safe = sanitizeMatrix(matrix)
    assert.ok(Array.isArray(safe.columns) && Array.isArray(safe.rows))
    assert.ok(safe.columns.every((c) => typeof c.id === 'string'), '列 id 必须归一成字符串')
    assert.ok(safe.rows.every((r) => r.cells && typeof r.cells === 'object'), '每行必须有 cells')
  }
  // 反向对照：不做归一化的裸表达式确实会炸，证明上面的绿不是恒真式。
  const raw = { columns: [{ id: 'ptc' }], rows: [{ id: 'x', label: 'X' }] }
  assert.throws(() => raw.rows.map((r) => raw.columns.map((c) => r.cells[c.id])), TypeError)
  const host = readText('index.js')
  const ask = host.slice(host.indexOf('async function askModel'), host.indexOf('function consumeWithDeadline'))
  assert.ok(
    ask.indexOf('try {') > 0 && ask.indexOf('buildLlmPrompt(input, matrix, fallback)') > ask.indexOf('try {'),
    '提示词构造必须在 try 内：它读的是 HTTP body',
  )
  assert.match(host, /error: 'judge-failed'/, 'handler 必须有兜底 JSON 结论，不许留下永不结束的连接')
})

test('真跑 /judge handler：畸形 matrix 仍返回 JSON，不抛未捕获异常', async () => {
  const { apply, JUDGE_PATH, CONFIG_PATH } = await import('../index.js')
  const routes = {}
  const webCtx = {
    effect: (fn) => { const off = fn(); return () => { if (typeof off === 'function') off() } },
    webServer: { register: (spec) => { routes[spec.path] = spec.handler; return () => {} } },
    reflect: {
      get: (name) => {
        // 让 askModel 真的走到提示词构造那一步才会用到能力矩阵。
        if (name === 'llm') return { stream: async function* () {} }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (name === 'agentPresets') return { defaultId: 'standard' }
        // 受理判定现在听宿主 connection 的；这里让它放行，本用例只关心 body 与结论。
        if (name === 'connection') return { requestRejection: () => undefined }
        return undefined
      },
    },
  }
  apply({ inject: (_names, cb) => cb(webCtx) }, {})
  assert.ok(routes[JUDGE_PATH] && routes[CONFIG_PATH], '两条路由都得真注册')

  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { cookie: 'x'.repeat(24) }
  const res = {
    headersSent: false,
    writeHead(code) { this.code = code; this.headersSent = true; return this },
    end(payload) { this.body = payload; return this },
  }
  const pending = routes[JUDGE_PATH](req, res)
  req.emit('data', Buffer.from(JSON.stringify({
    input: '整理文件',
    matrix: { columns: [{ id: 'ptc' }], rows: [{ id: 'x', label: 'X' }] },
  })))
  req.emit('end')
  await pending
  assert.equal(res.code, 200, 'handler 必须真的 writeHead')
  assert.ok(res.body, 'handler 必须真的 end —— 不许留下一个永不结束的连接')
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, false)
  assert.ok(['llm-unavailable', 'judge-failed'].includes(parsed.error), `意外结论：${parsed.error}`)

  // 客户端的等待上限就是靠这个端点下发的 timeoutMs 派生，真跑一次确认没漏字段。
  const cfgRes = {
    writeHead(code) { this.code = code; return this },
    end(payload) { this.body = payload; return this },
  }
  routes[CONFIG_PATH]({ method: 'GET', headers: { cookie: 'x'.repeat(24) } }, cfgRes)
  assert.equal(JSON.parse(cfgRes.body).timeoutMs, 20000, '/config 必须下发 timeoutMs')
  assert.equal(JSON.parse(cfgRes.body).defaultMode, 'standard',
    '/config 必须把用户选的新任务默认原样下发，不许客户端自己猜')
})

// ── 鉴权：复用宿主 admission，不自己判「cookie 够长就是自己人」 ────────────────

test('路由受理复用宿主 connection.requestRejection', async () => {
  const { apply, JUDGE_PATH, authorizeRequest } = await import('../index.js')

  // 宿主 service 在场时，结论完全听它的 —— cookie 长什么样都不再是判据。
  const withService = (rejection) => ({
    reflect: { get: (name) => (name === 'connection' ? { requestRejection: rejection } : undefined) },
  })
  assert.equal(authorizeRequest(withService(() => 403), { headers: { cookie: 'x'.repeat(512) } }), 403,
    '伪造一个超长 cookie 也不能绕开宿主的 Host/Origin 栅栏')
  assert.equal(authorizeRequest(withService(() => 401), { headers: {} }), 401,
    '未认证半区必须回 401，客户端才能区分「没权限」与「不存在」')
  assert.equal(authorizeRequest(withService(() => undefined), { headers: {} }), null,
    '宿主放行就是放行，插件不叠第二套判定')
  assert.equal(authorizeRequest(withService(() => { throw new Error('boom') }), { headers: {} }), 401,
    '宿主内部异常必须按未认证处理，绝不许降级成放行')
  assert.equal(authorizeRequest(withService(() => 500), { headers: {} }), 403,
    '宿主要约外的非空返回也得挡下：只认「明确 undefined」才放行')
  assert.equal(authorizeRequest(withService(() => ({ rejection: 403 })), { headers: {} }), 403,
    '返回对象同样不能当放行')

  // service 缺席时的降级判据：不再看「长度 ≥ 16」。
  const noService = { reflect: { get: () => undefined } }
  const forged = { headers: { cookie: 'x'.repeat(512) } }
  assert.equal(authorizeRequest(noService, forged), 403, '降级路径也不许只看 cookie 长度')
  assert.equal(authorizeRequest(noService, { headers: { cookie: 'a=1; dsh-auth-127.0.0.1:3000=abc' } }), null,
    '降级路径只认宿主签发的 dsh-auth-* cookie 名')
  assert.equal(authorizeRequest(noService, { headers: { cookie: 'dsh-auth-a=b', 'sec-fetch-site': 'cross-site' } }), 403,
    '跨站请求一律拒绝')
  assert.equal(authorizeRequest(noService, { headers: { cookie: 'dsh-auth-a=b', origin: 'https://evil.example' } }), 403,
    '外来 origin 一律拒绝')
  assert.equal(authorizeRequest(noService, { headers: { cookie: 'dsh-auth-a=b', origin: 'dsh-app://app' } }), null,
    '桌面端自己的 origin 是合法的')
  assert.equal(authorizeRequest(noService, { headers: { cookie: 'dsh-auth-a=b' }, socket: { remoteAddress: '192.168.1.20' } }), 403,
    '同网段机器带着 cookie 也进不来')
  assert.equal(authorizeRequest(noService, { headers: { cookie: 'dsh-auth-a=b' }, socket: { remoteAddress: '127.0.0.1' } }), null,
    'loopback 来源正常放行')
  assert.equal(authorizeRequest(noService, { headers: { cookie: 'dsh-auth-a=b' }, socket: { remoteAddress: '::1' } }), null,
    'IPv6 loopback 同样放行')

  // 端到端：被拒时 handler 立刻收口，连请求体都不读（否则伪造 POST 仍能触发模型调用）。
  const routes = {}
  const webCtx = {
    effect: (fn) => { fn() },
    webServer: { register: (spec) => { routes[spec.path] = spec.handler; return () => {} } },
    reflect: { get: (name) => (name === 'connection' ? { requestRejection: () => 401 } : undefined) },
  }
  apply({ inject: (_names, cb) => cb(webCtx) }, {})
  const res = {
    writeHead(code) { this.code = code; return this },
    end(payload) { this.body = payload; return this },
  }
  await routes[JUDGE_PATH]({ method: 'POST', headers: { cookie: 'x'.repeat(512) } }, res)
  assert.equal(res.code, 401, '被拒的 POST 必须 401，而不是先读完 body 再当正常请求')
  assert.equal(JSON.parse(res.body).error, 'untrusted-caller')

  // 反向对照：同一份伪造请求，旧判据（cookie 长度 ≥ 16）确实会放行 —— 说明这次不是空改。
  const oldRule = (req) => {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '' && origin !== 'dsh-app://app') return false
    return typeof req.headers.cookie === 'string' && req.headers.cookie.length >= 16
  }
  assert.equal(oldRule(forged), true, '旧判据对伪造 cookie 放行，这就是被修掉的洞')

  const host = readText('index.js')
  assert.match(host, /const rejection = authorizeRequest\(webCtx, req\)/, '两条路由都必须真的走这道判定')
  assert.ok(!/trustedCaller/.test(host), '弱判据必须彻底删掉，不许留旁路')
})

// ── 配额：模型兜底不能无限烧 token ────────────────────────────────────────────

test('令牌桶：突发用完后按 refillMs 恢复，久等也只补到容量', async () => {
  const { createTokenBucket } = await import('../index.js')
  let clock = 0
  const bucket = createTokenBucket({ capacity: 3, refillMs: 10000 }, () => clock)

  assert.equal(bucket.take().ok, true, '第 1 次')
  assert.equal(bucket.take().ok, true, '第 2 次')
  const third = bucket.take()
  assert.equal(third.ok, true, '第 3 次')
  assert.equal(third.remaining, 0, '用完时剩余应为 0')

  const blocked = bucket.take()
  assert.equal(blocked.ok, false, '第 4 次必须被挡住')
  assert.equal(blocked.retryAfterMs, 10000, '刚用完时要等满一个补满周期')

  clock += 5000
  const half = bucket.take()
  assert.equal(half.ok, false, '半周期还不够一次')
  assert.equal(half.retryAfterMs, 5000, '还差 5 秒就报 5 秒，不许一律报整周期')

  clock += 5000
  assert.equal(bucket.take().ok, true, '满一个周期后恢复一次')

  clock += 100000
  let burst = 0
  while (bucket.take().ok) burst += 1
  assert.equal(burst, 3, '久等之后也只补到容量，不许攒成 13 次')

  bucket.refund()
  assert.equal(bucket.take().ok, true, '退回的配额要能立刻用')
  for (let i = 0; i < 10; i += 1) bucket.refund()
  let capped = 0
  while (bucket.take().ok) capped += 1
  assert.equal(capped, 3, '退回也不许把余额顶过容量')
})

test('结论缓存：TTL 到点失效，超量先丢最久没用的', async () => {
  const { createVerdictCache } = await import('../index.js')
  let clock = 0
  const cache = createVerdictCache({ cacheMs: 1000, cacheSize: 2 }, () => clock)

  assert.equal(cache.get('a'), null, '没写过就是空')
  cache.set('a', { mode: 'ptc' })
  assert.deepEqual(cache.get('a'), { mode: 'ptc' }, '写进去要能读出来')

  clock = 999
  assert.ok(cache.get('a'), 'TTL 内仍有效')
  clock = 1000
  assert.equal(cache.get('a'), null, 'TTL 到点必须失效，不许拿旧结论冒充新判断')

  cache.set('b', { mode: 'standard' })
  cache.set('c', { mode: 'minimal' })
  cache.set('d', { mode: 'cordis' })
  assert.equal(cache.get('b'), null, '超量先淘汰最久没用过的')
  assert.ok(cache.get('d'), '最新写入的必须还在')
})

test('真跑 /judge：同一句描述走缓存，配额用光回 429 且不再调模型', async () => {
  const { apply, JUDGE_PATH } = await import('../index.js')
  const routes = {}
  let streams = 0
  const reply = JSON.stringify({ mode: 'ptc', reason: '批量处理', confidence: 0.8 })
  const webCtx = {
    effect: (fn) => { fn() },
    webServer: { register: (spec) => { routes[spec.path] = spec.handler; return () => {} } },
    reflect: {
      get: (name) => {
        if (name === 'llm') {
          return { stream: async function* () { streams += 1; yield { type: 'text-delta', text: reply } } }
        }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (name === 'connection') return { requestRejection: () => undefined }
        return undefined
      },
    },
  }
  apply({ inject: (_names, cb) => cb(webCtx) }, {})

  async function post(input) {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = {}
    const res = {
      writeHead(code, headers) { this.code = code; this.headers = headers; return this },
      end(payload) { this.body = payload; return this },
    }
    const pending = routes[JUDGE_PATH](req, res)
    req.emit('data', Buffer.from(JSON.stringify({ input, matrix: BASELINE_MATRIX })))
    req.emit('end')
    await pending
    return res
  }

  const first = await post('整理这批日志')
  assert.equal(first.code, 200)
  assert.equal(JSON.parse(first.body).ok, true, '配额内必须真出结论')
  assert.equal(streams, 1)

  const again = await post('整理这批日志')
  assert.equal(JSON.parse(again.body).cached, true, '同一句 + 同一张表要复用上次结论')
  assert.equal(streams, 1, '缓存命中绝不许再打一次模型')

  for (let i = 2; i <= 5; i += 1) {
    const res = await post('整理这批日志 ' + i)
    assert.equal(JSON.parse(res.body).ok, true, `第 ${i} 次仍在配额内`)
  }
  assert.equal(streams, 5, '五次不同输入各算一次调用')

  const blocked = await post('整理这批日志 6')
  assert.equal(blocked.code, 429, '超出配额必须回 429，不能悄悄再打一次模型')
  const payload = JSON.parse(blocked.body)
  assert.equal(payload.error, 'rate-limited')
  assert.ok(payload.retryAfterMs > 0, '要说清还要等多久，界面才能给出秒数')
  assert.ok(blocked.headers['retry-after'], '响应头也要带 retry-after')
  assert.equal(streams, 5, '被限流时绝不许再打模型')

  // 空输入：400 且不扣配额 —— 客户端的 bug 不能吃掉用户的额度。
  const empty = await post('   ')
  assert.equal(empty.code, 400)
  assert.equal(JSON.parse(empty.body).error, 'invalid-input')
  const afterEmpty = await post('整理这批日志 7')
  assert.equal(afterEmpty.code, 429, '空输入不许扣配额，所以这里仍应是被限流')

  // 反向对照：把配额判定摘掉，第 6 次就会重新变成 200 —— 说明上面的红不是恒真。
  const host = readText('index.js')
  assert.match(host, /const ticket = bucket\.take\(\)/)
  assert.match(host, /error: 'rate-limited'/)
})

test('模型根本没被调用时不扣配额：否则会把「没配模型」说成「问得太频繁」', async () => {
  const { apply, JUDGE_PATH } = await import('../index.js')
  const routes = {}
  const webCtx = {
    effect: (fn) => { fn() },
    webServer: { register: (spec) => { routes[spec.path] = spec.handler; return () => {} } },
    reflect: {
      get: (name) => {
        // 故意不提供 llm：askModel 会走 attempted=false
        if (name === 'connection') return { requestRejection: () => undefined }
        return undefined
      },
    },
  }
  apply({ inject: (_names, cb) => cb(webCtx) }, {})

  async function post(input) {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = {}
    const res = {
      writeHead(code) { this.code = code; return this },
      end(payload) { this.body = payload; return this },
    }
    const pending = routes[JUDGE_PATH](req, res)
    req.emit('data', Buffer.from(JSON.stringify({ input, matrix: BASELINE_MATRIX })))
    req.emit('end')
    await pending
    return res
  }

  // 7 次 > 容量 5：不退配额的话第 6 次就会被 429 挡住。
  for (let i = 0; i < 7; i += 1) {
    const res = await post('整理这批日志 ' + i)
    assert.equal(res.code, 200, `第 ${i + 1} 次不该被限流`)
    assert.equal(JSON.parse(res.body).error, 'llm-unavailable', '没有 llm 服务时要说「用不了」而不是「太频繁」')
  }
})

test('配额数字只有宿主一份，客户端只读 retryAfterMs', async () => {
  const host = readText('index.js')
  const adapter = readText('adapter.js')
  assert.match(host, /export const JUDGE_LIMITS = Object\.freeze\(\{/)
  assert.match(host, /capacity: 5/)
  assert.match(host, /refillMs: 20000/)
  // 客户端若也存一份 capacity/refillMs，改常量时两边就会漂移。
  assert.ok(!/capacity:\s*\d/.test(adapter), '客户端不许再存第二份配额常量')
  assert.ok(!/refillMs:\s*\d/.test(adapter), '客户端不许再存第二份补充速度')
  const built = readBuilt()
  assert.ok(built.includes('rateLimitedNote'), '产物里必须有配额提示文案')
  assert.ok(built.includes('quotaNote') || built.includes('rate-limited'), '产物必须真的区分配额失败')
})

test('README 写清了判断链路与配额：中英都有流程图和两张表', () => {
  const zh = readText('README.md')
  const en = readText('README.en.md')
  for (const [label, doc] of [['中文', zh], ['英文', en]]) {
    assert.match(doc, /```mermaid/, `${label} README 缺流程图`)
    assert.match(doc, /flowchart TD/, `${label} README 的流程图必须是 flowchart`)
    assert.match(doc, /429/, `${label} README 没写清配额用光回什么`)
  }
  assert.match(zh, /\| `pinned` 点名工具 \| 单条即可 \|/, '中文缺四层信号表')
  assert.match(en, /\| `pinned` names the tool \| one hit \|/, '英文缺同一张信号表')
  assert.match(zh, /同一模式 \*\*凑够 2 条\*\*/, '中文没写「部分证据要凑够两条」这条门槛')
  assert.match(en, /\*\*two hits in the same mode\*\*/, '英文没写同一门槛')
  assert.match(zh, /反向词表/, '中文没写排错类不换模式')
  assert.match(en, /reverse word list/, '英文没写排错类不换模式')
  assert.match(zh, /规则已定案 > 模型结论/, '中文没写合并优先级')
  assert.match(en, /decided by rules > model verdict/, '英文没写合并优先级')
  assert.match(zh, /## 模型兜底的配额/)
  assert.match(en, /## Model-fallback quota/)
  // 准确率必须有可跑的命令与数字，否则「判得对」永远只是形容词。
  assert.match(zh, /npm run eval/, '中文 README 没写评测入口')
  assert.match(en, /npm run eval/, '英文 README 没写评测入口')
  assert.match(zh, /## 准确率/, '中文 README 缺准确率一节')
  assert.match(en, /## Accuracy/, '英文 README 缺准确率一节')
  // 边界不许再声称「没有配额」：那已经是上一版的事。
  assert.ok(!zh.includes('没有任何「预算」保护'), '中文 README 仍说没有配额')
  assert.ok(!en.includes('No budget on model fallback'), '英文 README 仍说没有配额')
})

test('文档口径与实现一致：四种换模式情形、超时以配置为准', () => {
  const zh = readText('README.md')
  const en = readText('README.en.md')
  // 口径以规则实际能判出的为准：批量处理确实会被判成 PTC，所以是四种不是三种。
  assert.match(zh, /只有四种/, '中文 README 的换模式情形数量与规则不符')
  assert.ok(!zh.includes('只有' + '三种' + '真正需要换模式'), '中文 README 还留着旧的「三种」口径')
  assert.match(en, /just \*\*four\*\* situations/, '英文 README 的换模式情形数量没跟上')
  assert.ok(!en.includes('just **' + 'three** situations'), '英文 README 还留着旧的 three')
  // 决策表必须真的列出四种可换的去向，否则「四种」只是个数字。
  for (const mode of ['创造', '标准', '极简', 'PTC']) {
    assert.match(zh, new RegExp('\\| [^|\\n]*' + mode + '[^|\\n]*\\|'),
      `中文 README 决策表缺「${mode}」这一行`)
  }
  assert.ok(
    !zh.includes('带 6s 硬超时') && !en.includes('with a 6s hard timeout'),
    '超时口径不许再写死 6s：实际等待由宿主 timeoutMs 派生',
  )
  assert.match(zh, /timeoutMs/)
  const rec = readText('src/recommender.js')
  assert.match(rec, /\*\*只有四种\*\*/, '推荐引擎的文件头注释没跟上四类情形')
  assert.ok(!rec.includes('只有' + '三种' + '真正需要换模式'), '推荐引擎仍写着旧的三种口径')
  // 注释里只许有一种口径：两种数字同时存在，说明改了一处漏了一处。
  assert.ok(!/\*\*只有三种\*\*/.test(rec), '注释里不该同时出现两种口径')
})

test('发布清单包含重建与刷新基线所需文件', () => {
  const files = JSON.parse(readText('package.json')).files
  for (const f of ['build.mjs', 'scripts', 'test', 'src', 'client.js']) {
    assert.ok(files.includes(f), `files 缺 ${f}：README 的开发 / 刷新基线指令在打包后会失效`)
  }
  assert.doesNotThrow(() => readText('scripts/refresh-baseline.mjs'))
  assert.match(readText('README.md'), /refresh:baseline/)
})

// ── 结论的两句理由：详实、可复核、能力事实现算 ──────────────────────────────

const BASELINE_MATRIX = JSON.parse(readText('src/preset-baseline.json')).matrix
const EN_UI = JSON.parse(readText('locale/en.json')).ui
const MODE_NAMES_ZH = { minimal: '极简模式', standard: '标准模式', ptc: 'PTC 模式', cordis: '创造模式' }
const WHY_ZH = { modeName: (id) => MODE_NAMES_ZH[id] || id, capabilityLabel: (row) => row.label }
const WHY_EN = {
  lang: 'en',
  modeName: (id) => EN_UI['mode_' + id] || id,
  capabilityLabel: (row) => EN_UI['cap_' + row.id] || row.id,
}
const whyOf = (input, verdict, matrix = BASELINE_MATRIX, extra = {}) =>
  explainVerdict(input, verdict, matrix, { ...WHY_ZH, ...extra })

/** 反向对照用：把 recommender.js 改坏后真跑一次，证明守卫不是恒真式。 */
function loadRecommender(transform) {
  const raw = transform(readText('src/recommender.js'))
  const code = raw.replace(/^export\s+(const|let|var|function|class|async function)\s/gm, '$1 ')
    + '\n;module.exports.__api = { recommendByRules, composeVerdict, explainVerdict, buildLlmPrompt };\n'
  const box = { module: { exports: {} } }
  vm.runInNewContext(code, box)
  return box.module.exports.__api
}

test('「我想写一首诗」当场定案默认模式，并给两句可复核的理由', () => {
  const local = recommendByRules('我想写一首诗', { available: BASELINE_MATRIX.columns.map((c) => c.id) })
  assert.equal(local.noToolNeed, true, '没有独有工具信号＝已确定不用换，不是「拿不准」')
  const verdict = composeVerdict(local, null, 'ptc')
  assert.equal(verdict.mode, 'ptc')
  assert.equal(verdict.source, 'default')
  const why = whyOf('我想写一首诗', verdict)
  assert.match(why, /没有出现「必须用某个模式独有工具」的信号/)
  assert.match(why, /13 项差异/)
  assert.match(why, /没有任何一项是这个任务所必需的/)
  assert.match(why, /PTC 模式/)
  assert.match(why, /可展开下面的差异表逐项核对/)
  assert.equal((why.match(/。/g) || []).length, 2, '必须恰好两句，不多不少')
})

test('否定式描述不再误命中：「不要写插件」不能被判成创造模式', () => {
  assert.notEqual(recommendByRules('不要写插件，帮我写首诗').mode, 'cordis')
  assert.notEqual(recommendByRules('不用工作流，就整理一份 PDF').mode, 'standard')
  // 反向对照：摘掉否定过滤，同一句必须回到旧的误判，否则这条守卫是恒真式。
  const broken = loadRecommender((s) => {
    const b = s.replace('if (boundaryOk(text, at, word) && !isNegated(text, at)) {', 'if (boundaryOk(text, at, word)) {')
    assert.notEqual(b, s, '否定过滤替换没命中')
    return b
  })
  assert.equal(broken.recommendByRules('不要写插件，帮我写首诗').mode, 'cordis')
})

test('弱线索不再套用强断言：整理一份 PDF 不叫「要遍历/批量处理」', () => {
  const local = recommendByRules('把这份 PDF 整理成摘要')
  assert.equal(local.kind, 'suggest')
  assert.equal(local.noToolNeed, true)
  assert.ok(local.weakHints.length > 0, '弱线索要留作旁证')
  const verdict = composeVerdict(local, null, 'ptc')
  assert.equal(verdict.mode, 'ptc')
  assert.equal(verdict.source, 'default', '0.35 的弱线索不许包装成「建议换模式」的结论')
  const why = whyOf('把这份 PDF 整理成摘要', verdict)
  assert.match(why, /只看到「整理」这类线索/)
  assert.ok(!why.includes('要遍历'), '不许把弱线索说成批量遍历')
})

test('理由里的能力事实一律现算：改坏差异表，理由必须跟着变', () => {
  const verdict = composeVerdict(recommendByRules('给我写个插件'), null, 'ptc')
  assert.match(whyOf('给我写个插件', verdict), /只有「创造模式」具备/)

  const allHave = JSON.parse(JSON.stringify(BASELINE_MATRIX))
  const cordisRow = allHave.rows.find((r) => r.id === 'cordis')
  for (const c of allHave.columns) cordisRow.cells[c.id] = true
  const changed = whyOf('给我写个插件', verdict, allHave)
  assert.ok(!changed.includes('只有「创造模式」具备'), '能力分布变了，理由不能继续写旧事实')
  assert.match(changed, /全部 4 个模式都具备/, '模式数量来自 columns.length，不写死「四个」')

  const fewer = { ...BASELINE_MATRIX, rows: BASELINE_MATRIX.rows.slice(1) }
  const fewerWhy = whyOf('给我写个插件', verdict, fewer)
  assert.match(fewerWhy, /12 项差异/, '差异项数也必须取自当前表')
  assert.ok(!fewerWhy.includes('13 项差异'))
})

test('三种来源都有两句理由，英文界面不混中文', () => {
  const rules = composeVerdict(recommendByRules('给我写个插件'), null, 'ptc')
  const llm = composeVerdict(recommendByRules('这个插件要批量处理这批文件'),
    { mode: 'cordis', reason: '写插件是核心诉求', confidence: 0.8 }, 'ptc')
  const fallback = composeVerdict(recommendByRules('看看这个项目'), null, 'ptc')
  const cases = [
    ['rules', rules],
    ['llm', { ...llm, reason: 'Writing a plugin is the main request' }],
    ['default', fallback],
  ]
  for (const [name, v] of cases) {
    const zh = whyOf('给我写个插件', v)
    assert.equal((zh.match(/。/g) || []).length, 2, `${name} 必须两句`)
    assert.match(zh, /13 项差异/, `${name} 必须写明依据来自差异表`)
    const en = whyOf('给我写个插件', v, BASELINE_MATRIX, WHY_EN)
    // 命中词是用户原话，中文输入自然带汉字；要求模板本身是英文即可。
    // 把「整句无汉字」写成硬指标会逼实现把用户原话删掉，反而更不清楚。
    assert.ok(!/依据当前版本内核预设解析出的|这就是选|可展开下面的差异表/.test(en),
      `${name} 英文界面不许混入中文模板句`)
    assert.match(en, /kernel presets/)
    assert.match(en, /Of the 13 differences/)
  }
  assert.match(whyOf('给我写个插件', llm), /模型复核/, 'LLM 来源必须标明不是本地规则')
})

test('实时能力表校正后理由按新表重算，旧 evidence 行已撤', () => {
  const built = readBuilt()
  assert.match(built, /matrixRef\.current = live/, '最新能力表要有地方存')
  assert.match(built, /withWhy\(prev\.verdict, text, live, t, currentDefaultMode\(\)\)/,
    '实时表回来后理由必须按新表重算，默认模式也要取当前值，不能停在基线')
  assert.match(built, /verdict\.why \|\| verdict\.reason/, '结论区优先画详实理由')
  assert.ok(!built.includes('evidencePrefix'), '命中词已并入理由，旧 evidence 行不该留在产物里')
  const zh = readText('README.md')
  assert.ok(!zh.includes('理由文案是规则自带的固定句子'), 'README 不许继续宣称理由不随能力表更新')
  assert.match(zh, /两句/)
})

// ── 新任务默认模式：跟随宿主，实时响应 ──────────────────────────────────────

test('提示词里的默认模式跟随宿主，不写死 ptc', () => {
  const standard = buildLlmPrompt('整理一批文件', BASELINE_MATRIX, 'standard')
  assert.match(standard.system, /新任务默认是 standard/)
  assert.match(standard.system, /一律选 standard/)
  assert.ok(!/\{"mode":"standard"/.test(standard.system), '示例值不许把答案写成默认模式（锚定偏置）')
  assert.ok(!/一律选 ptc/.test(standard.system), '默认改了，提示词不许还把模型往 ptc 引')
  const fallback = buildLlmPrompt('整理一批文件', BASELINE_MATRIX)
  assert.match(fallback.system, /新任务默认是 ptc/, '没给值时仍用内置兜底')
  // 反向对照：把动态默认改成常量，绿必须翻红，证明上面不是恒真式。
  const stuck = loadRecommender((s) => {
    const b = s.replace(/const fallback = typeof defaultMode[\s\S]*?: 'ptc'/, "const fallback = 'ptc'")
    assert.notEqual(b, s, '动态默认替换没命中')
    return b
  })
  assert.ok(!/新任务默认是 standard/.test(stuck.buildLlmPrompt('整理一批文件', BASELINE_MATRIX, 'standard').system))
})

test('结论与两句理由跟随用户设的新任务默认', () => {
  const local = recommendByRules('我想写一首诗', {
    available: BASELINE_MATRIX.columns.map((c) => c.id),
  })
  const standard = composeVerdict(local, null, 'standard')
  assert.equal(standard.mode, 'standard', '「不用换」类结论本身就是默认模式')
  const why = whyOf('我想写一首诗', standard, BASELINE_MATRIX, { defaultMode: 'standard' })
  assert.match(why, /留在「标准模式」是照当前的新任务默认保持不动/)
  assert.equal((why.match(/。/g) || []).length, 2, '换了默认也仍是两句')
  const ptc = composeVerdict(local, null, 'ptc')
  assert.equal(ptc.mode, 'ptc', '反向对照：默认没改时仍留在 ptc')
  assert.match(whyOf('我想写一首诗', ptc), /留在「PTC 模式」/)
})

test('宿主现读 selectedDefault，不缓存、不猜、读不到返回 null', async () => {
  const { readDefaultMode, normalizeConfig } = await import('../index.js')
  const registry = {
    _selected: 'standard',
    config: { default: 'ptc' },
    get defaultId() { return this._selected ?? this.config.default },
  }
  const ctx = {
    reflect: { get: (name, strict) => (name === 'agentPresets' && strict === false ? registry : undefined) },
  }
  // 第二参传 null = 显式关掉 profile 文件兜底，隔离出「运行时 service」这一层。
  assert.equal(readDefaultMode(ctx, null), 'standard', '用户选的默认优先于部署默认')
  assert.equal(normalizeConfig({}, ctx).defaultMode, 'standard', '/config 下发必须是这个值')
  registry._selected = 'minimal'
  assert.equal(readDefaultMode(ctx, null), 'minimal', '不许缓存：改完下一次读就是新值')
  registry._selected = null
  assert.equal(readDefaultMode(ctx, null), 'ptc', '没选中时回落到部署默认')
  // 0.2.2 放宽：用户自定义的预设也是他自己的选择，插件不许用自己的白名单否掉它。
  registry._selected = 'doc-writer'
  assert.equal(readDefaultMode(ctx, null), 'doc-writer', '自定义预设的默认必须读得出来')
  // 但形状不像 id 的串一律不认：它最终会进 select() 和提示词。
  // （null 不在这一列里：registry 的 getter 会回落到部署默认 ptc，那是正确行为。）
  for (const bad of ['', 'not a preset', 'NotAPreset!', 'x'.repeat(80), 42]) {
    registry._selected = bad
    assert.equal(readDefaultMode(ctx, null), null, `「${String(bad)}」不是合法 id，不许采用`)
  }
  assert.equal(readDefaultMode({ reflect: { get: () => { throw new Error('without inject') } } }, null), null,
    'reflect 抛错时降级，不许把宿主内部异常糊给用户')
  assert.equal(readDefaultMode({}, null), null, '两处都拿不到时诚实标成未读到')
})

test('profile patch 兜底：只读宿主已持久化的 selectedDefault，不重写判定', async () => {
  const { readDefaultMode, readDefaultFromProfile, parseDefaultFromPatch } = await import('../index.js')
  const patch = [
    '- id: dsh-superagent',
    '  config:',
    '    default: cordis        # 别的行也有 default，不许串味',
    '- id: agent-preset-registry',
    '  name: "@deepseek-ai/dsh-agent-preset-registry"',
    '  config:',
    '    default: ptc',
    '    selectedDefault: standard',
    '- id: ptc-runtime',
    '  config:',
    '    selectedDefault: minimal',
  ].join('\n')
  assert.equal(parseDefaultFromPatch(patch), 'standard', '以用户选的 selectedDefault 为准')
  assert.equal(parseDefaultFromPatch(patch.replace('    selectedDefault: standard', '')), 'ptc',
    '没选中时回落到部署默认')
  assert.equal(parseDefaultFromPatch(patch.replace('agent-preset-registry', 'some-other-row')), null,
    '找不到 registry 行就返回 null')
  // 自定义预设同样认（形状合法），而形状不像 id 的串不认。
  assert.equal(parseDefaultFromPatch(patch.replace('selectedDefault: standard', 'selectedDefault: doc-writer')), 'doc-writer',
    '用户在设置里自建的预设也要读得出来')
  assert.equal(parseDefaultFromPatch(patch.replace('selectedDefault: standard', 'selectedDefault: NotAPreset!')), null,
    '形状不像 id 的值不许采用（含大写与符号）')
  assert.equal(parseDefaultFromPatch(''), null, '空文件不许抛')
  // 运行时 service 缺席时，仍能从 profile 文件读到用户选的默认。
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const temp = mkdtempSync(join(tmpdir(), `npie-mg-default-${process.pid}-`))
  assert.equal(readDefaultFromProfile(temp), null, '没有 patch 文件时安静返回 null')
  writeFileSync(join(temp, 'cordis.patch.yml'), patch)
  assert.equal(readDefaultMode({}, temp), 'standard',
    'reflect 拿不到 service 时，profile 文件这一层必须真顶上')
  assert.equal(readDefaultFromProfile(temp), 'standard')
})

test('默认模式实时对齐：宿主下发 + 多条复查路径 + 结论不硬编码', () => {
  const built = readBuilt()
  const host = readText('index.js')
  assert.ok(!/const DEFAULT_MODE = 'ptc'/.test(built), '不许再留写死的默认模式常量')
  assert.match(host, /selectedDefault\.get\(\) \?\? config\.default/, '口径必须与宿主一致')
  assert.match(host, /normalizeConfig\(config, webCtx\)/, '/config 与 /judge 都要现读，不缓存')
  assert.match(host, /readDefaultFromProfile/, '运行时 service 取不到时要有 profile 文件这层兜底')
  assert.match(host, /parseDefaultFromPatch/, 'patch 解析必须能脱离真实 profile 单测')
  assert.match(built, /data\.defaultMode/, '/config 下发的默认模式要真读进客户端')
  assert.match(built, /window\.addEventListener\('focus', wake\)/)
  assert.match(built, /document\.addEventListener\('visibilitychange', wake\)/)
  assert.match(built, /setInterval\(wake, DEFAULT_MODE_POLL_MS\)/,
    '同窗口改默认不会触发 focus，必须定时复查')
  assert.match(built, /verdictNow\.mode === currentDefaultMode\(\)/, '结论等于默认时不许再调 select')
  assert.match(built, /const stays = prev\.verdict\.source === 'default'/,
    '默认变了要重算「不用换」类结论，不能只换一行文案')
  assert.match(built, /withTimeout\(\s*Promise\.resolve\(\)\.then\(\(\) => presets\.list\(\)\),/,
    'roster 兜底必须带硬超时：list() 内部可能 await loader.await() 永不返回')
  assert.match(built, /if \(hostDefaultMode === null\)/, '只有主路径没读到才动用 list()')
})

test('跟随默认的新文案中英齐全，英文词典不含汉字', () => {
  const zh = JSON.parse(readText('locale/zh.json')).ui
  const en = JSON.parse(readText('locale/en.json')).ui
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '中英词典 key 必须一一对应')
  for (const key of ['byDefault', 'defaultTagFallback', 'keepDefault', 'keepShort', 'alreadyDefault']) {
    assert.ok(zh[key] && en[key], `${key} 缺翻译`)
  }
  for (const [key, value] of Object.entries(en)) {
    assert.ok(!/[\u4e00-\u9fff]/.test(value), `en.json 的 ${key} 混进了汉字`)
  }
})

test('README 不再把「默认写死 ptc」列为已知边界', () => {
  const zh = readText('README.md')
  const en = readText('README.en.md')
  assert.ok(!zh.includes('默认模式写死为'), '中文 README 还留着旧的已知边界')
  assert.ok(!en.includes('The default mode is hard-coded'), '英文 README 还留着旧的已知边界')
  assert.match(zh, /selectedDefault/)
  assert.match(en, /selectedDefault/)
  assert.match(zh, /0\.1\.9/)
  assert.match(en, /0\.1\.9/)
})

// ── 准确率：这个插件唯一的目的 ──────────────────────────────────────────────
//
// 0.1.x 的 80 条判据全在验「机制」——是否调用、失败是否闭合、文案是否双语。
// 一条也没验「判得对不对」，于是机制全绿、准确率无人知道（14 例人工样本 9 对 3 错）。
// 下面这组把「判得对」本身变成判据：用例集在 test/eval/，`npm run eval` 也跑同一份。

const ALL_MODES = ['minimal', 'standard', 'ptc', 'cordis']
const evalMain = JSON.parse(readText('test/eval/cases.json'))
const evalHeldout = JSON.parse(readText('test/eval/cases-heldout.json'))
const judgeOne = (text, def = 'standard') =>
  composeVerdict(recommendByRules(text, { available: ALL_MODES }), null, def)

test('评测集规模够用：≥40 条、≥10 条「不该换」、中英都有', () => {
  const all = [...evalMain, ...evalHeldout]
  assert.ok(all.length >= 40, `用例太少（${all.length}），过拟合风险高`)
  const stays = all.filter((c) => c.expect === 'default')
  assert.ok(stays.length >= 10, `「不该换」类只有 ${stays.length} 条，而这类才是最容易判错的`)
  const en = all.filter((c) => c.lang === 'en')
  assert.ok(en.length >= 10, `英文用例只有 ${en.length} 条`)
  for (const c of all) {
    assert.ok(typeof c.text === 'string' && c.text, '用例必须有原文')
    assert.ok(c.why, `用例「${c.text}」没写意图，判错时无法判断是实现错还是用例错`)
  }
})

test('准确率回归：两份用例集全部通过，且「不该换」与默认模式无关', () => {
  const failures = []
  for (const item of [...evalMain, ...evalHeldout]) {
    // 「不该换」要在两种默认下都成立：结论跟着默认走，而不是写死某个模式。
    for (const def of (item.expect === 'default' ? ['standard', 'ptc'] : ['standard'])) {
      const want = item.expect === 'default' ? def : item.expect
      const got = judgeOne(item.text, def)
      if (got.mode !== want || (item.expect === 'default' && got.source !== 'default')) {
        failures.push(`${item.text} → ${got.mode}(${got.source})，期望 ${want}`)
      }
    }
  }
  assert.deepEqual(failures, [], '准确率回归失败；改规则前先看用例的 why 字段')
})

test('单条线索不定案，两条才算：这正是「统计表格有多少行」被误判成 PTC 的原因', () => {
  // 0.1.x：一个 strong 命中就定案 ⇒「统计」把纯文本任务推进了 PTC。
  const single = recommendByRules('帮我统计一下这份表格有多少行')
  assert.equal(single.kind, 'suggest', '「统计」只是能力的一部分，不是决定性证据')
  assert.equal(single.noToolNeed, true)
  assert.equal(judgeOne('帮我统计一下这份表格有多少行').mode, 'standard')

  // 对照：两条独立线索同时出现才算证据。
  const double = recommendByRules('把这批 CSV 去重后按月份汇总')
  assert.equal(double.kind, 'decided')
  assert.equal(double.mode, 'ptc')

  // 反向对照：把门槛降回 1 条，同一句立刻回到旧误判。
  const loose = loadRecommender((s) => {
    const b = s.replace('partialEvidence(s) >= 2', 'partialEvidence(s) >= 1')
    assert.notEqual(b, s, '门槛替换没命中')
    return b
  })
  assert.equal(loose.recommendByRules('帮我统计一下这份表格有多少行', { available: ALL_MODES }).mode, 'ptc')
  // 但「一条部分证据 + 两条弱线索」要算够：批量 + csv/表格 就是真该用 execute 的。
  assert.equal(judgeOne('批量把截图里的表格转成 csv').mode, 'ptc')
})

test('排错 / 查看类描述一律不换模式，且不发模型请求', () => {
  for (const text of [
    '我装了个插件，为什么没生效？',
    '这个 workflow 报错了，帮我看看',
    '这个面板怎么配置？',
    '修一下这个插件的 bug，它启动就崩',
    'my plugin stopped working after the update',
    'why does the workflow fail on the second step',
  ]) {
    const local = recommendByRules(text, { available: ALL_MODES })
    assert.notEqual(local.kind, 'decided', `「${text}」不该定案换模式`)
    assert.equal(local.noToolNeed, true, `「${text}」是排错，应当场判定不换（不白问模型）`)
    assert.equal(judgeOne(text).mode, 'standard')
  }
  // 反向对照：摘掉反向词表，「装了个插件为什么没生效」立刻就变成创造模式。
  const blind = loadRecommender((s) => {
    const b = s.replace('const reverse = hits(text, REVERSE_RULES)', 'const reverse = []')
    assert.notEqual(b, s, '反向词表接缝替换没命中')
    return b
  })
  assert.equal(blind.recommendByRules('我装了个插件，为什么没生效？', { available: ALL_MODES }).mode, 'cordis')
})

test('英文规则真的能判：pinned 生效，否定也生效（含弯引号）', () => {
  assert.equal(judgeOne('write a plugin that adds a sidebar panel').mode, 'cordis')
  assert.equal(judgeOne('run a workflow that fans out over these repos').mode, 'standard')
  assert.equal(judgeOne('use minimal mode to get a clean baseline').mode, 'minimal')
  assert.equal(judgeOne('batch rename these screenshots by date').mode, 'ptc')

  // 否定：0.1.x 的否定词表只有中文，`don't use workflow` 会被当成点名要工作流。
  assert.equal(judgeOne("don't use workflow, just answer directly").mode, 'standard')
  assert.equal(judgeOne('don’t use workflow here').mode, 'standard', '弯引号也要能识别')

  // 反向对照：清空英文否定词，同一句就会被当成「点名要用工作流」而定案。
  const noEn = loadRecommender((s) => {
    const b = s.replace(/const EN_NEGATIONS = \[[\s\S]*?\n\]/, 'const EN_NEGATIONS = []')
    assert.notEqual(b, s, '英文否定词表替换没命中')
    return b
  })
  const broken = noEn.recommendByRules("don't use workflow, just answer directly", { available: ALL_MODES })
  assert.equal(broken.kind, 'decided', '否定失效后必然被当成指令')
  assert.equal(broken.signal, 'pinned')
})

test('ASCII 词按整词匹配：复数算同一个词，别的单词里的片段不算', () => {
  // 复数：`plugins` 必须被当成 plugin，否则英文规则只在单数下有效。
  assert.ok(normalizeText('my plugins are broken').includes('plugins'))
  const plural = recommendByRules('add plugins to the list', { available: ALL_MODES })
  assert.equal(plural.mode, 'cordis')
  // 片段：`prefix` 里的 `fix` 不算命中（英文 reverse 词表里就有 fix the）。
  const piece = recommendByRules('prefix the filename with a date', { available: ALL_MODES })
  assert.equal(piece.kind, 'unknown')
  assert.equal(piece.signal, 'none')
})

test('组合判据：动作 + DSH 内部对象才算换模式，光提到对象不算', () => {
  assert.equal(judgeOne('在设置里加一个开关，控制是否自动保存').mode, 'cordis')
  assert.equal(judgeOne('给侧边栏加一个搜索框').mode, 'cordis')
  assert.equal(judgeOne('把主题改成深色').mode, 'cordis')
  // 只提到对象、没有动作词 ⇒ 只是线索，不许断言。
  const only = recommendByRules('这个面板的按钮太多，帮我精简一下')
  assert.notEqual(only.kind, 'decided')
  // 反向对照：摘掉组合判据，第一条就退回「无信号」。
  const noPair = loadRecommender((s) => {
    const b = s.replace("rule.id === 'cordis' && webTask ? [] : pairHits(text, rule.pairs)", 'false ? pairHits(text, rule.pairs) : []')
    assert.notEqual(b, s, '组合判据接缝替换没命中')
    return b
  })
  assert.notEqual(noPair.recommendByRules('在设置里加一个开关，控制是否自动保存', { available: ALL_MODES }).mode, 'cordis')
})

test('缓存 key 必须带默认模式：改了默认，同一句不许复用旧结论', async () => {
  const { apply, JUDGE_PATH } = await import('../index.js')
  const routes = {}
  let streams = 0
  const registry = { defaultId: 'ptc' }
  const reply = JSON.stringify({ mode: 'ptc', reason: '批量处理', confidence: 0.8 })
  const webCtx = {
    effect: (fn) => { fn() },
    webServer: { register: (spec) => { routes[spec.path] = spec.handler; return () => {} } },
    reflect: {
      get: (name) => {
        if (name === 'llm') {
          return { stream: async function* () { streams += 1; yield { type: 'text-delta', text: reply } } }
        }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (name === 'connection') return { requestRejection: () => undefined }
        if (name === 'agentPresets') return registry
        return undefined
      },
    },
  }
  // profile 这一层要显式关掉：本机 ~/.dsh 里可能有真实 profile，不能让判据读它。
  const prev = process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE_DIR
  try {
    apply({ inject: (_names, cb) => cb(webCtx) }, {})
    const post = async (input) => {
      const req = new EventEmitter()
      req.method = 'POST'
      req.headers = {}
      const res = {
        writeHead(code, headers) { this.code = code; this.headers = headers; return this },
        end(payload) { this.body = payload; return this },
      }
      const pending = routes[JUDGE_PATH](req, res)
      req.emit('data', Buffer.from(JSON.stringify({ input, matrix: BASELINE_MATRIX })))
      req.emit('end')
      await pending
      return res
    }

    await post('用工作流批量处理这批文件')
    assert.equal(streams, 1)
    await post('用工作流批量处理这批文件')
    assert.equal(streams, 1, '同默认下的同一句应当命中缓存')

    registry.defaultId = 'standard'
    const after = await post('用工作流批量处理这批文件')
    assert.equal(JSON.parse(after.body).cached, undefined, '默认模式变了，旧结论的前提已经不同')
    assert.equal(streams, 2, '默认模式是决策前提，必须重新问一次')
  } finally {
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prev
  }
})

test('反馈闭环：只收白名单字段、只写本机、写不进去不谎报', async () => {
  const { normalizeFeedback, appendFeedback } = await import('../index.js')
  const record = normalizeFeedback({
    thumb: 'down',
    input: 'x'.repeat(900),
    mode: 'ptc',
    source: 'rules',
    signal: 'strong',
    defaultMode: 'standard',
    lang: 'en',
    恶意字段: '不该进文件',
    at: '伪造时间',
  }, () => '2026-11-16T00:00:00.000Z')

  assert.equal(record.thumb, 'down')
  assert.equal(record.input.length, 500, '原文截到 500 字：要给规则改进留样本，但不留整段隐私')
  assert.equal(record.lang, 'en')
  assert.equal(record.at, '2026-11-16T00:00:00.000Z', '时间由宿主写，不采信请求体')
  assert.ok(!('恶意字段' in record), '请求体里的额外字段一律丢弃')
  assert.equal(typeof record.ruleVersion, 'string', '要记下这条反馈出自哪套规则')
  // 反向对照：thumb 不是 up/down 就整条拒绝，不许默认成「判对了」。
  assert.equal(normalizeFeedback({ thumb: 'maybe' }), null)
  assert.equal(normalizeFeedback(null), null)
  assert.equal(normalizeFeedback({}), null)

  // 没有 profile 目录时不许假装记上了。
  assert.equal(appendFeedback(record, undefined).error, 'no-storage')
})

test('反馈 e2e：点一次写一条 JSONL，/stats 与 npm run stats 都读得出来', async () => {
  const { apply, FEEDBACK_PATH, STATS_PATH, JUDGE_PATH } = await import('../index.js')
  const { summarize, parseJsonl } = await import('../scripts/stats.mjs')
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const routes = {}
  let streams = 0
  const reply = JSON.stringify({ mode: 'ptc', reason: '批量处理', confidence: 0.8 })
  const webCtx = {
    effect: (fn) => { fn() },
    webServer: { register: (spec) => { routes[spec.path] = spec.handler; return () => {} } },
    reflect: {
      get: (name) => {
        if (name === 'connection') return { requestRejection: () => undefined }
        // llm 与默认模型是「平均耗时有据可依」的前提：没有它，下面那条断言只能在
        // 0 与 null 之间挑一个，证明不了统计真的在数发出去的请求。
        if (name === 'llm') {
          return { stream: async function* () { streams += 1; yield { type: 'text-delta', text: reply } } }
        }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (name === 'agentPresets') return { defaultId: 'ptc' }
        return undefined
      },
    },
  }
  const call = async (path, method, payload) => {
    const req = new EventEmitter()
    req.method = method
    req.headers = {}
    const res = {
      writeHead(code, headers) { this.code = code; this.headers = headers; return this },
      end(body) { this.body = body; return this },
    }
    const pending = routes[path](req, res)
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
    await pending
    return res
  }

  // 每个用例自己的临时 profile：不碰用户真实的 ~/.dsh。
  const dir = mkdtempSync(join(tmpdir(), `npie-mg-fb-${process.pid}-`))
  const prev = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  try {
    apply({ inject: (_names, cb) => cb(webCtx) }, {})
    const up = await call(FEEDBACK_PATH, 'POST', { thumb: 'up', input: '把标题层级统一一下', mode: 'ptc', source: 'rules', signal: 'strong' })
    const down = await call(FEEDBACK_PATH, 'POST', { thumb: 'down', input: '遍历一下这个 JSON', mode: 'standard', source: 'llm' })
    assert.equal(JSON.parse(up.body).stored, true)
    assert.equal(JSON.parse(down.body).stored, true)

    const file = join(dir, 'npie-modeguide', 'feedback.jsonl')
    assert.ok(existsSync(file), '反馈必须真落盘')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2, '点两次就是两条记录')

    const { records, badLines } = parseJsonl(readFileSync(file, 'utf8'))
    assert.equal(badLines, 0)
    const summary = summarize(records)
    assert.equal(summary.total, 2)
    assert.equal(summary.adoption, 50, '一正一负 = 50%')
    assert.equal(summary.bySource.rules.up, 1)
    assert.equal(summary.bySource.llm.down, 1)
    assert.equal(summary.wrong.length, 1, '错例要能被挑出来补进评测集')

    // /stats 的反馈计数只算真的写进去的。
    const stats = JSON.parse((await call(STATS_PATH, 'GET')).body)
    assert.equal(stats.stats.feedbackUp, 1)
    assert.equal(stats.stats.feedbackDown, 1)
    // 一条模型请求都没发过时，平均耗时必须是 null。写成 0 会被读成「问过、而且很快」，
    // 把「没有数据」画成一个看起来正常的值 —— 这正是本版反复修的那类谎报。
    assert.equal(stats.stats.model, 0)
    assert.equal(stats.stats.avgModelMs, null, '零请求不许把「没有数据」画成 0ms')
    // 反向对照：真问一次模型后它必须变成数字，否则上面那条断言等于恒真式
    // （任何实现都不满足「有数字」以外的分支时也能绿）。
    await call(JUDGE_PATH, 'POST', { input: '用工作流批量处理这批文件', matrix: BASELINE_MATRIX })
    assert.equal(streams, 1, '冲突输入应当真的问一次模型')
    const after = JSON.parse((await call(STATS_PATH, 'GET')).body)
    assert.equal(after.stats.model, 1, '发出去的请求要被数进去')
    assert.equal(typeof after.stats.avgModelMs, 'number', '有请求后平均耗时才成立')

    // 反向对照 1：非法 thumb → 400，且文件不长新行。
    const bad = await call(FEEDBACK_PATH, 'POST', { thumb: 'maybe', input: 'x' })
    assert.equal(bad.code, 400)
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2, '坏请求不许落盘')

    // 反向对照 2：GET 反馈路由必须 405（它只接受 POST）。
    assert.equal((await call(FEEDBACK_PATH, 'GET')).code, 405)
  } finally {
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prev
    try {
      const { rmSync } = await import('node:fs')
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判据（安全中心可能拦删除）
    }
  }
})

test('stats 口径：没有记录时采纳率是未知而不是 0，坏行要报出来', async () => {
  const { summarize, parseJsonl } = await import('../scripts/stats.mjs')
  assert.equal(summarize([]).adoption, null, '没有记录就别说 0%：那会被读成「全判错」')
  assert.equal(summarize([]).total, 0)
  const parsed = parseJsonl('{"thumb":"up"}\n\n不是 JSON\n{"thumb":"down"}')
  assert.equal(parsed.records.length, 2, '坏行要跳过，好行照收')
  assert.equal(parsed.badLines, 1, '坏了几行必须能说出来')
  assert.equal(summarize(parsed.records, { badLines: parsed.badLines }).badLines, 1)
})

test('浮层可访问性：aria-modal 声明了就必须真把 Tab 关在里面', () => {
  const src = readText('adapter.js')
  assert.match(src, /'aria-modal': 'true'/, '对话框必须声明 aria-modal')
  assert.match(src, /tabIndex: -1/, '浮层自身要能接收焦点，否则 Tab 环没有落点')
  const keyBlock = src.slice(src.indexOf('const onKey = (event) =>'), src.indexOf('const onDown = (event) =>'))
  assert.ok(keyBlock.length > 0, '必须能定位到键盘处理函数')
  assert.match(keyBlock, /event\.key !== 'Tab'/, '必须拦 Tab，不能只写 aria-modal')
  assert.match(keyBlock, /focusablesIn\(popRef\.current\)/, '焦点环要取浮层内的可聚焦元素')
  assert.match(keyBlock, /closeAndRestore\(\)/, 'Esc 关闭要把焦点还给触发按钮')
  // 反向对照：Esc 一旦退回裸 close()，焦点就留在被卸载的浮层里。
  assert.ok(!/Escape'\) \{\s*\n\s*event\.stopPropagation\(\)\s*\n\s*close\(\)/.test(keyBlock),
    'Esc 不许退化成不还焦点的 close()')
  assert.match(src, /onClick: closeAndRestore \}/, '× 按钮同样要还焦点')
  // 初始焦点：打开就聚焦输入框（原有行为，别在这一轮改动里被删掉）。
  assert.match(src, /if \(el && typeof el\.focus === 'function'\) el\.focus\(\)/, '打开即聚焦输入框')
})

test('英文弱线索：四个模式都要有，且弱线索仍只算半条', () => {
  // 行为层：英文句子既能靠组合判据定案，也能靠「部分证据 + 弱线索」凑够。
  assert.equal(recommendByRules('add a button to the toolbar').mode, 'cordis')
  assert.equal(recommendByRules('aggregate the logs in these folders').mode, 'ptc')
  assert.equal(recommendByRules('run a clean baseline with a controlled experiment').mode, 'minimal')
  // 反向对照：只有一条弱线索时必须沉默（否则弱线索就等于定案）。
  assert.notEqual(recommendByRules('change one line and reproduce the bug').kind, 'decided')

  // 配置层：每一档 weak 至少 4 条 ASCII 词，防止以后只加中文。
  const src = readText('src/recommender.js')
  for (const id of ['cordis', 'standard', 'minimal', 'ptc']) {
    const start = src.indexOf(`id: '${id}'`)
    assert.ok(start > 0, `找不到 ${id} 规则块`)
    const block = src.slice(start, src.indexOf('\n  },', start))
    const weakStart = block.indexOf('weak: [')
    const weak = block.slice(weakStart, block.indexOf(']', weakStart))
    const ascii = (weak.match(/'[a-z][a-z -]{3,}'/g) || []).length
    assert.ok(ascii >= 4, `${id} 的英文弱线索只有 ${ascii} 条，界面双语而规则单语`)
  }
})

test('轮询间隔落在 10–15 秒：报告 H8 的口径，不能悄悄退回 4 秒', () => {
  const src = readText('adapter.js')
  const match = /const DEFAULT_MODE_POLL_MS = (\d+)/.exec(src)
  assert.ok(match, '找不到轮询间隔常量')
  const ms = Number(match[1])
  assert.ok(ms >= 10000 && ms <= 15000, `轮询间隔 ${ms}ms 超出 10–15 秒区间`)
  // 即时路径必须还在：否则 12 秒的滞后就真的被用户看到了。
  assert.match(src, /window\.addEventListener\('focus', wake\)/, '窗口回焦要立即复查')
  assert.match(src, /document\.addEventListener\('visibilitychange', wake\)/, '切回标签页要立即复查')
})

test('类型体检接上了：tsconfig + npm run typecheck + CI 非阻断', () => {
  const pkg = JSON.parse(readText('package.json'))
  assert.match(pkg.scripts.typecheck, /tsc -p tsconfig\.check\.json/, '缺 typecheck 脚本')
  const tsconfig = JSON.parse(readText('tsconfig.check.json'))
  assert.equal(tsconfig.compilerOptions.checkJs, true, '不开 checkJs 就只是语法检查')
  assert.equal(tsconfig.compilerOptions.noEmit, true, '体检不许产出文件')
  // adapter.js 刻意不在范围内：它只有 React 工厂函数与 DOM，没有类型定义可依，
  // 放进来的报错 100% 是噪音（会把真问题淹掉）。这个决定要写在配置里，见 exclude。
  assert.ok(tsconfig.exclude.includes('adapter.js'), 'adapter.js 的排除必须显式写出来')
  const ci = readText('.github/workflows/check.yml')
  assert.match(ci, /npm run typecheck/, 'CI 要真的跑一次')
  assert.match(ci, /continue-on-error: true/, '报告要求先只报错不阻断')
  assert.ok(pkg.files.includes('tsconfig.check.json'), '打包时要带上它，否则装完 typecheck 跑不起来')
})

test('预设白名单只有一份：宿主 import，客户端内联，且与能力表列一致', () => {
  const presets = readText('src/presets.js')
  assert.match(presets, /export const PRESET_IDS = Object\.freeze\(\[/)
  const host = readText('index.js')
  assert.match(host, /from '\.\/src\/presets\.js'/, '宿主必须 import 同一份白名单')
  assert.ok(!/new Set\(\['standard', 'ptc'/.test(host), '宿主不许再抄一份字面量')
  const adapter = readText('adapter.js')
  assert.match(adapter, /Object\.fromEntries\(PRESET_IDS\.map/, '客户端的显示名映射也要从同一份派生')
  assert.ok(!/^const MODE_LABEL_KEYS = \{$/m.test(adapter), '客户端不许再手写一份 id 列表')

  const ids = BASELINE_MATRIX.columns.map((c) => c.id).sort()
  assert.deepEqual([...ids].sort(), ['cordis', 'minimal', 'ptc', 'standard'])
  assert.match(presets, /'minimal', 'standard', 'ptc', 'cordis'/)
})

test('模型调用显式 temperature=0：分类任务不该每次都换一个答案', () => {
  assert.match(readText('index.js'), /temperature: 0/)
})
