/**
 * 内置预设白名单 —— **唯一一份**。
 *
 * 宿主半区（index.js）与浏览器半区（adapter.js，构建时内联）都从这里取，
 * 不许各自再抄一遍：两份集合一定会漂移，而且漂移的方式很隐蔽 ——
 * 宿主下发了默认模式，客户端却判成「不可信」，界面显示「未读到默认」，
 * 而两边的测试各自看都是绿的。
 *
 * 只列内置预设：能力矩阵只有这四列，别的 id 既没有能力数据、也不该被拿来
 * 推荐或切会话。用户自定义的预设 id 会在这里被拒绝，界面会诚实地标「未读到」，
 * 而不是拿一个没有能力数据的 id 冒充默认。
 */
export const PRESET_IDS = Object.freeze(['minimal', 'standard', 'ptc', 'cordis'])

/**
 * 这个 id 是不是可用的内置预设。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isPresetId(id) {
  return typeof id === 'string' && PRESET_IDS.includes(id)
}
