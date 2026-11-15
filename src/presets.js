/**
 * 预设 id 的两份名单 —— **唯一一份**。
 *
 * 宿主半区（index.js）与浏览器半区（adapter.js，构建时内联）都从这里取，
 * 不许各自再抄一遍：两份集合一定会漂移，而且漂移的方式很隐蔽 ——
 * 宿主下发了默认模式，客户端却判成「不可信」，界面显示「未读到默认」，
 * 而两边的测试各自看都是绿的。
 *
 * 为什么分成两份，而不是改成一个更大的「合法 id」集合：
 *
 *   - `PRESET_IDS` 是**内核自带**的四个预设。规则引擎的判据、词典里的显示名、
 *     能力差异表的基线列都锚在这四个 id 上（`cordis`、`ptc` 这些 id 本身就是
 *     能力事实的一部分）。它不能变宽 —— 变宽等于给没能力数据的 id 发合格证。
 *   - `isModeId` 只回答「这是不是一个像样的预设 id」。用户在
 *     「设置 → Agent 预设」里自定义出来的预设（比如 `doc-writer`）必须被接受，
 *     否则插件会对着用户明明选好的默认显示「未读到默认」—— 0.2.1 及以前就是
 *     这样：`readDefaultMode` 拿 `isPresetId` 过滤，自定义预设直接被丢掉。
 *
 *   两者不是替代关系：内置四个走精确名单，其余走形状校验，且最终是否采用还要
 *   看 roster（宿主实际装了哪些预设）。名单宽了，判据不能跟着宽。
 */
export const PRESET_IDS = Object.freeze(['minimal', 'standard', 'ptc', 'cordis'])

/**
 * 这个 id 是不是内核自带的内置预设。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isPresetId(id) {
  return typeof id === 'string' && PRESET_IDS.includes(id)
}

/**
 * id 形状：小写字母/数字开头，允许 `-` `_`，1–64 字符。
 *
 * 与宿主预设 id 的实际形态一致（`ptc`、`standard`、`minimal`、`cordis`）。
 * 只做形状校验，不做语义判断 —— 语义判断是 roster 的事：能列出来的才可信。
 *
 * 为什么必须有这道校验：默认模式最终会进 `agentPresets.select(id)`，也可能进
 * 提示词。空串、超长串、带换行或引号的串一旦混进来，轻则让模型输出被污染，
 * 重则让 displayName 之类的值冒充 id。
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isModeId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)
}
