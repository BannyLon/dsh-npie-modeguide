/**
 * dsh-npie-modeguide — 能力解析层（纯逻辑，不碰 DOM / 不碰宿主 API）。
 *
 * 这一层回答一个问题：**这几个 Agent 预设在能力上到底差在哪？**
 *
 * 为什么不在代码里写死四个模式的差异：DSH 每次升级都会改 `presets/*.patch.yml`。
 * 一写死，内核一升级，插件给的对照表就是错的 —— 而且错得很隐蔽（界面还是好的，
 * 只是数字不对）。所以这里真的去读 `agentPresets.read` 回来的 YAML 子项列表，
 * 从里面数出每个预设挂了哪些插件，再折成给人看的能力表。
 *
 * 四个容易写错的地方，都在这里兜住：
 *
 *   1. **插件是树，不是平表。** `delegation`、`planning`、`compaction` 是
 *      `cordis:group`，真正提供能力的 `tool-workflow`、`plan-mode` 嵌在它们的
 *      `config` 列表里，缩进更深。只扫顶层会漏掉「工作流编排」「计划模式」
 *      「子代理」—— 而这三项恰恰是选模式的关键依据。所以这里按缩进建树再递归。
 *
 *   2. **`disabled` 有三种值。** `true` 是确定关掉；`!!js <表达式>` 要在宿主里
 *      求值才知道。对表达式不猜，但能认两个最常见的平台模式（`=== 'win32'` /
 *      `!== 'win32'`），其余标成「视环境而定」，UI 上单独标出。
 *
 *   3. **`@deepseek-ai/dsh-tool-fs` 同名不同能力。** 极简模式也挂 tool-fs，
 *      但把 `read`/`write`/`edit` 全关了、只留 `readImage`。按包名数数会把极简
 *      模式算成有完整文件能力 —— 这是最容易让推荐结论反转的一处。
 *
 *   4. **能力不是布尔。** 一个能力在 mac 上有、在 Windows 上可能没有。所以能力
 *      值是 `true` / `false` / `'conditional'` 三态，不是布尔。
 */

/** 顶层插件行的缩进（`plugins:` 下每项前面是 10 个空格）。 */
const TOP_LEVEL_INDENT = 10

/**
 * 能力清单。`matches` 按**包名主体精确比较**，不用子串。
 *
 * 为什么不能写 `name.includes('dsh-tool-fs')`：`@deepseek-ai/dsh-tool-fs-search`
 * 也含这个子串。只挂了搜索工具、没挂读写工具的预设会被误算成「有完整文件读写」，
 * 而这恰恰是极简模式与其它模式最关键的区别 —— 一处误判就足以让推荐结论反过来。
 * `fsGated` 标记「同名但可能被降级」的那一项，由专门逻辑判断。
 */
export const CAPABILITIES = Object.freeze([
  {
    id: 'files',
    label: '文件读写',
    hint: '读、写、编辑工作区文件',
    matches: ['dsh-tool-fs'],
    fsGated: true,
  },
  { id: 'search', label: '文件搜索', hint: '按名找文件、按内容搜索', matches: ['dsh-tool-fs-search'] },
  // 同一能力有多种包名：极简模式挂持久 shell 那一套（terminal-* / *-persistent），
  // 其余模式挂 dsh-tool-bash / pwsh。只认一种会把「四模式都有终端」误算成有差异。
  { id: 'shell', label: '终端命令', hint: '跑 bash / pwsh 命令', matches: [
    'dsh-tool-bash', 'dsh-tool-pwsh', 'dsh-terminal-bash', 'dsh-terminal-pwsh',
    'dsh-tool-bash-persistent', 'dsh-tool-pwsh-persistent',
  ] },
  { id: 'web', label: '联网检索', hint: '网页搜索与抓取', matches: ['dsh-tool-web'] },
  { id: 'subagent', label: '子代理', hint: '派生子代理并行干活', matches: ['dsh-tool-subagent'] },
  { id: 'workflow', label: '工作流编排', hint: '多阶段大扇出编排', matches: ['dsh-tool-workflow'] },
  { id: 'plan', label: '计划模式', hint: '先出方案再动手', matches: ['dsh-plan-mode'] },
  { id: 'skill', label: '技能', hint: '加载并使用 Skill', matches: ['dsh-tool-skill'] },
  { id: 'goal', label: '目标', hint: '跨轮持续推进一个目标', matches: ['dsh-tool-goal'] },
  { id: 'todo', label: '任务清单', hint: '给多步任务记进度', matches: ['dsh-tool-todo'] },
  { id: 'ptc', label: 'execute 代码执行', hint: '写一段 JS 批量调工具，只回结果', matches: ['dsh-tool-executor-ptc'] },
  { id: 'office', label: 'Office 文档', hint: '读写 Word / Excel / PPT', matches: ['dsh-tool-office'] },
  { id: 'cordis', label: '改 DSH 本体', hint: '写插件、改预设、加界面', matches: ['dsh-tool-cordis'] },
  { id: 'pluginManager', label: '插件管理', hint: '装、卸、启停插件', matches: ['dsh-plugin-manager'] },
])

/** 取一行的缩进。 */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * 取包名主体，用于精确匹配能力。
 *
 * 预设里的 name 有两种写法：`@deepseek-ai/dsh-tool-fs` 与
 * `@deepseek-ai/dsh-plugin-manager/tools`。只取 split('/').pop() 会把后者折成
 * `tools`，什么都匹配不上；只取 split('/')[1] 又会在裸包名上错位。
 * @param {string} name
 * @returns {string}
 */
function packageId(name) {
  const parts = String(name || '').split('/')
  return parts[0].startsWith('@') ? (parts[1] || '') : (parts[0] || '')
}

/**
 * 判断 `disabled` 表达式的取值。
 *
 * `disabled: !!js <expr>` 的语义是「expr 为真时这一项被禁用」。这里只认真实出现
 * 过的那两个平台判断，其余标 conditional —— 不求值，因为求值要宿主 Context，
 * 而这一层必须能脱离宿主跑测试。
 *
 * @param {string} expr - `!!js` 之后的表达式文本。
 * @param {string} platform - `process.platform` 的值。
 * @returns {boolean|'conditional'} 禁用与否。
 */
export function evalDisabledExpr(expr, platform = 'darwin') {
  const text = String(expr || '').trim()
  const eq = /process\.platform\s*===\s*['"](\w+)['"]/.exec(text)
  if (eq) return platform === eq[1]
  const ne = /process\.platform\s*!==\s*['"](\w+)['"]/.exec(text)
  if (ne) return platform !== ne[1]
  return 'conditional'
}

/**
 * 判断一个 tool-fs 节点是否被降级成「只读图片」。
 *
 * 极简模式写法：read/write/edit 全 false，只留 readImage: true。
 * 这时它没有完整文件读写能力，不能按包名算成有。
 * @param {string} body
 * @returns {boolean}
 */
export function isFsGatedOff(body) {
  if (typeof body !== 'string') return false
  return /^\s+read:\s*false\s*$/m.test(body)
    && /^\s+write:\s*false\s*$/m.test(body)
    && /^\s+edit:\s*false\s*$/m.test(body)
}

/**
 * 把 entry-list YAML 解析成插件树。
 *
 * 只做这件事需要的那点 YAML 解析：不引 js-yaml（插件要零依赖），因为要读的结构
 * 很规整 —— 每个节点是 `- id: xxx`，属性（`name` / `disabled` / `config`）缩进
 * 更深，子节点是缩进更深的 `- id:`。
 *
 * @param {string} content - `agentPresets.read` 的 content。
 * @param {string} platform - 平台，用于求值 `!!js` 平台判断。
 * @returns {Array<{id: string, name: string, disabled: boolean|'conditional'|null, body: string, depth: number, children: Array<object>}>}
 */
export function parsePluginTree(content, platform = 'darwin') {
  if (typeof content !== 'string' || !content.trim()) return []
  const lines = content.split('\n')
  const roots = []
  const stack = []

  /**
   * 收尾一个节点：把它的属性区解析成 name / disabled。
   *
   * 属性区必须**挂在节点自己身上**（`node.bodyLines`）。用一份共享的 buffer 会
   * 被「创建子节点」这个动作清空，父节点的 `disabled` 就这样静默消失 ——
   * 表现是 group 明明写了 `disabled: true`，里面的工具却被算成能用。
   */
  const finalize = (node) => {
    node.body = node.bodyLines.join('\n')
    delete node.bodyLines
    const nameMatch = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(node.body)
    node.name = nameMatch ? nameMatch[1] : ''
    const disabledMatch = /^\s+disabled:\s*(.+?)\s*$/m.exec(node.body)
    if (!disabledMatch) {
      node.disabled = null
    } else if (disabledMatch[1] === 'true') {
      node.disabled = true
    } else if (disabledMatch[1] === 'false') {
      node.disabled = false
    } else if (disabledMatch[1].startsWith('!!js')) {
      node.disabled = evalDisabledExpr(disabledMatch[1].slice(4), platform)
    } else {
      node.disabled = 'conditional'
    }
  }

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = indentOf(line)
    const itemMatch = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (itemMatch) {
      // 关掉所有深度 >= 自己的开放节点：它们已经结束了。
      while (stack.length && stack[stack.length - 1].depth >= indent) {
        finalize(stack.pop())
      }
      const node = {
        id: itemMatch[1],
        name: '',
        disabled: null,
        body: '',
        bodyLines: [],
        depth: indent,
        children: [],
      }
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(node)
      else roots.push(node)
      stack.push(node)
      continue
    }
    const top = stack[stack.length - 1]
    if (top) top.bodyLines.push(line)
  }
  while (stack.length) finalize(stack.pop())
  return roots
}

/**
 * 遍历插件树（含嵌套），对每个节点回调。
 * @param {Array<object>} nodes
 * @param {(node: object, parentDisabled: boolean|'conditional'|null) => void} visit
 * @param {boolean|'conditional'|null} parentDisabled
 */
function walk(nodes, visit, parentDisabled = null) {
  for (const node of nodes) {
    visit(node, parentDisabled)
    // 父节点确定关闭时，子节点一律视为关闭 —— 挂在一个没装上的 group 里的
    // 工具不会存在。这是 group 语义，不是猜测。
    const inherited = parentDisabled === true || node.disabled === true
      ? true
      : parentDisabled === 'conditional' || node.disabled === 'conditional'
        ? 'conditional'
        : null
    if (node.children.length) walk(node.children, visit, inherited)
  }
}

/**
 * 把一个预设的 YAML 内容折成能力表。
 *
 * @param {string} content - `agentPresets.read` 的 content。
 * @param {string} platform
 * @returns {{capabilities: Record<string, boolean|'conditional'>, pluginCount: number, names: string[], unknown: string[]}}
 *   `capabilities` 值为 true / false / 'conditional'；`unknown` 是值为 conditional 的能力 id。
 */
export function analyzePreset(content, platform = 'darwin') {
  const roots = parsePluginTree(content, platform)
  // 每个能力收集两类证据：确定启用 / 条件启用。确定启用优先。
  const enabled = new Set()
  const conditional = new Set()

  walk(roots, (node, inheritedDisabled) => {
    const disabled = node.disabled === true || inheritedDisabled === true
      ? true
      : node.disabled === 'conditional' || inheritedDisabled === 'conditional'
        ? 'conditional'
        : false
    if (disabled === true) return
    // 只取包名主体做精确比较：`dsh-tool-fs-search` 不能算成 dsh-tool-fs，
    // 但 `dsh-plugin-manager/tools` 仍要算成 dsh-plugin-manager。
    const pkg = packageId(node.name)
    if (!pkg) return
    for (const cap of CAPABILITIES) {
      if (!cap.matches.some((m) => pkg === m)) continue
      if (cap.fsGated && isFsGatedOff(node.body)) continue
      if (disabled === 'conditional') conditional.add(cap.id)
      else enabled.add(cap.id)
    }
  })

  const capabilities = {}
  const unknown = []
  for (const cap of CAPABILITIES) {
    if (enabled.has(cap.id)) capabilities[cap.id] = true
    else if (conditional.has(cap.id)) {
      capabilities[cap.id] = 'conditional'
      unknown.push(cap.id)
    } else capabilities[cap.id] = false
  }

  // 顶层启用项数（给人一个「这个模式有多重」的直观量）。
  const pluginCount = countEnabled(roots)

  return {
    capabilities,
    pluginCount,
    names: roots.map((r) => r.name || r.id),
    unknown,
  }
}

/**
 * 数出确定启用的节点数（含嵌套），跳过确定关闭的整棵子树。
 * @param {Array<object>} nodes
 * @returns {number}
 */
export function countEnabled(nodes) {
  let total = 0
  for (const node of nodes) {
    if (node.disabled === true) continue
    total += 1
    if (node.children.length) total += countEnabled(node.children)
  }
  return total
}

/**
 * 把若干个预设的能力表拼成对照矩阵。
 *
 * 只保留「至少有一个模式不一样」的能力行：全都一样的能力对选择没有帮助，
 * 留着只会让表变长、把真正的差异埋掉。
 *
 * @param {Array<{id: string, name?: string, content: string}>} presets
 * @param {string} platform
 * @returns {{columns: Array<{id: string, name: string}>, rows: Array<object>}}
 */
export function buildMatrix(presets, platform = 'darwin') {
  const list = Array.isArray(presets) ? presets.filter((p) => p && typeof p.content === 'string') : []
  const analyzed = list.map((p) => ({ id: p.id, name: p.name || p.id, ...analyzePreset(p.content, platform) }))

  const rows = CAPABILITIES.map((cap) => {
    const cells = {}
    for (const a of analyzed) cells[a.id] = a.capabilities[cap.id]
    return { id: cap.id, label: cap.label, hint: cap.hint, cells }
  }).filter((row) => {
    const values = analyzed.map((a) => row.cells[a.id])
    return values.some((v) => v !== values[0])
  })

  return {
    columns: analyzed.map((a) => ({ id: a.id, name: a.name })),
    rows,
  }
}
