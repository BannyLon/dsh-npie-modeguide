/**
 * dsh-npie-modeguide — 浏览器半区。
 *
 * 在输入框工具栏放一个图标入口：把任务写成一句话，插件判断该用哪个 Agent 预设，
 * 并给出理由；新会话可以直接应用。
 *
 * 九个刻意的设计决定，写在这里免得以后被「优化」掉：
 *
 * 1. **不做成模型能看见的工具。** 选模式是用户自己的决定。做成 tool 之后模型会
 *    自作主张地调它，用户反而失去控制权。所以整条链路只对人类可见。
 *
 * 2. **能力对照表以构建期基线为准，实时读取只做可选校正。** DSH 每次升级都会改
 *    预设组成，所以基线由 refresh-baseline.mjs 从当前 app.asar 的四份
 *    presets/*.patch.yml 真解析生成、由 build.mjs 内联，不是手写的常量。
 *    `agentPresets.read()` 只在后台静默校正：四个都成功才替换，失败不打扰用户。
 *    把这张锦上添花的表放进出结论的关键路径，正是 0.1.3「预设读不到」的根源。
 *
 * 3. **浮层挂到 document.body，不挂在工具栏里。** 工具栏在 docked composer 内部，
 *    有 overflow 裁剪，就地展开会被切掉半截（tooltip 同理，也得挂出去）。
 *
 * 4. **一键应用只在空白会话出现。** `agentPresets.select` 对已开始的会话会拒绝
 *    （`agent-preset/locked`），所以进行中的任务只给建议、不显示应用按钮。
 *
 * 5. **`useInput` / `useSession` 是 selector hook，必须传 `(s) => s`。** 官方契约是
 *    `SnapshotSelectorHook<T> = <S>(sel: (s: T) => S) => S`。无参调用会拿到 undefined
 *    或直接抛错，结果是「切到这个模式」永远不出现 —— 而纯逻辑测试全绿，一点都看不出来。
 *
 * 6. **可见文案走宿主 locale 服务，接不上就退回内置词典。** 官方 UI 插件规范要求
 *    「Route visible UI text through the Client locale service」；en 词典必须是英文。
 *
 * 7. **本地规则结论同步先出，任何远程调用都不许挡在它前面。** 曾经把
 *    `await loadPresets()` 放在 runJudge 第一行，Remote 的 `read()` 一旦不 resolve，
 *    「判断中…」就永远不结束 —— 而那条任务本地规则本来一毫秒就能判完。
 *    预设表与 LLM 复核都只是**可选的增强**，全部放到后台并带硬超时。
 *
 * 8. **浮层贴触发按钮的上方，且高度被上方空间钳住。** 结论出现后面板会变高；
 *    只算一次位置就会向下长出去、盖住工具栏。所以按 `offsetHeight` 实测，
 *    内容变化重算，并把 `maxHeight` 压进按钮上方可用空间里。
 *
 * 9. **一屏只留一个主按钮。** 有结论时「给建议」降为次要，「切到这个模式」才是主按钮。
 *
 * 10. **默认模式向宿主实时对齐，绝不写死。** 用户在「设置 → Agent 预设」改了新任务
 *     默认，/config 现读 `agentPresets.defaultId` 下发；浮层打开、窗口回焦、后台切回、
 *     定时复查与每次判断都会重新对齐。变了就用新默认重算结论和两句理由；结论正好
 *     等于当前默认时，主按钮不再调 `select()`，免得把会话从用户选的默认切走。
 *     读不到就标「内置兜底」，不把 ptc 冒充成用户的选择。
 *
 * 本文件由 build.mjs 内联进 client.js，与 src/capabilities.js、src/recommender.js
 * 共享同一个作用域，所以可以直接引用 buildMatrix / recommendByRules / composeVerdict；
 * LOCALES 也由 build.mjs 从 locale/*.json 注入到同一作用域。
 */

const PKG = 'dsh-npie-modeguide'
const JUDGE_PATH = '/api/npie-modeguide/judge'
const CONFIG_PATH = '/api/npie-modeguide/config'

/** 后台实时校正的硬超时；到点就放弃，界面早已用基线画好，没有任何等待态。 */
const PRESET_TIMEOUT_MS = 2500
const APPLY_TIMEOUT_MS = 2500
/** 单个预设 read 的独立超时：一个模式挂住不许拖垮另外三个。 */
const READ_TIMEOUT_MS = 1200
const CONFIG_TIMEOUT_MS = 2500
/** 模型等待下限；实际等待 = max(下限, 宿主 timeoutMs + 余量)。 */
const MODEL_TIMEOUT_FLOOR_MS = 6000
/** 留给宿主收尾与网络往返的余量：客户端必须比宿主晚放弃。 */
const MODEL_TIMEOUT_SLACK_MS = 2000

/** 浮层几何参数：与下面的 CSS 保持一致。 */
const POP_GAP = 10
const POP_WIDTH = 380
const POP_MAX_HEIGHT = 520
const POP_MIN_HEIGHT = 200

/**
 * 只是「宿主没给默认模式」时的兜底，**不是**用户的新任务默认。
 *
 * 真实值由 /config 从宿主 `agentPresets.defaultId`
 * （`config.selectedDefault.get() ?? config.default`）现读；用户可以在
 * 「设置 → Agent 预设」随时改。读不到时界面标「内置兜底」，绝不把 ptc
 * 冒充成用户的选择（这是 0.1.8 及以前的已知错误）。
 */
const BUILTIN_DEFAULT_MODE = 'ptc'
/** 浮层开着时复查默认的间隔：设置页与浮层同窗口，改完不会触发 focus。
 *  4 秒是刻意的：用户改完默认回来要立刻看到结论变化。为此宿主侧读过 profile
 *  会按 mtime 缓存解析结果，轮询不再是「每 4 秒同步读一次盘」。 */
const DEFAULT_MODE_POLL_MS = 4000
/** 官方 list() 兜底读取的上限：它内部可能 await loader.await() 永不返回。 */
const DEFAULT_LIST_TIMEOUT_MS = 1200

/**
 * 内置模式显示名对应的词典 key。
 *
 * 名单来自 `src/presets.js` 的 PRESET_IDS（构建时内联进同一个作用域）：
 * 宿主的默认模式白名单用的是同一份。两处各写一遍的话，一旦一边漏改，
 * 宿主下发了合法默认、客户端却判成「不可信」，界面会显示「未读到默认」，
 * 而两边的测试各自看都是绿的。
 */
const MODE_LABEL_KEYS = Object.fromEntries(PRESET_IDS.map((id) => [id, 'mode_' + id]))

/** 表格列头用的短名对应的词典 key。 */
const MODE_SHORT_KEYS = Object.fromEntries(PRESET_IDS.map((id) => [id, 'short_' + id]))

/**
 * 位置计算：纯函数，导出给判据直接验，不依赖 DOM。
 *
 * 旧实现拿 `max-height`(560) 去估面板高度，按钮上方明明有空间却判定「放不下」，
 * 于是浮层翻到输入框下面；后来又只算一次，结论出现后面板变高就向下溢出盖住工具栏。
 * 现在：优先向上 + 用实测高度 + 把 maxHeight 钳进上方可用空间。
 */
function computePopoverPosition(anchor, popHeight, viewport) {
  const vw = Math.max(320, viewport.width || 1280)
  const vh = Math.max(320, viewport.height || 800)
  const width = Math.min(POP_WIDTH, vw - 24)
  const left = Math.max(8, Math.min(anchor.left - 8, vw - width - 8))
  const arrowLeft = Math.max(18, Math.min(anchor.left + anchor.width / 2 - left, width - 18))
  const aboveRoom = anchor.top - POP_GAP - 8
  const belowRoom = vh - anchor.bottom - POP_GAP - 8
  // 只要上方还能放下一个最小可用面板就向上；只有真的放不下才翻到下方。
  const placement = aboveRoom >= POP_MIN_HEIGHT ? 'above' : 'below'
  const room = placement === 'above' ? aboveRoom : belowRoom
  const maxHeight = Math.max(POP_MIN_HEIGHT, Math.min(POP_MAX_HEIGHT, room))
  const height = Math.max(0, Math.min(popHeight || 320, maxHeight))
  const top = placement === 'above'
    ? Math.max(8, anchor.top - height - POP_GAP)
    : Math.min(Math.max(8, anchor.bottom + POP_GAP), Math.max(8, vh - height - 8))
  return { left, top, width, height, maxHeight, arrowLeft, placement }
}

/**
 * 给 Promise 装一个不会抛的硬超时。超时返回 fallback，原 Promise 仍可能在后台挂着，
 * 但**不再阻塞界面**（Remote 调用没有可取消的接口，只能这样隔离）。
 */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => done(fallback), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); done(value) },
      () => { clearTimeout(timer); done(fallback) },
    )
  })
}

/** 生成一个可取消的 fetch 信号；老宿主没有 AbortController 时退回无信号。 */
function abortAfter(ms) {
  if (typeof AbortController === 'undefined') return { signal: undefined, cancel: () => {} }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) }
}

/** 样式（作用域前缀 npie-mg-，避免泄漏到宿主）。所有 button 都给显式宽度：
 *  宿主给裸 button 兜了 width:100%，进了 flex 行会变成整列宽横条。 */
const CSS = `
.npie-mg-root{position:relative;display:inline-flex;align-items:center;min-width:0}
.npie-mg-trigger{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;padding:0;border:0;border-radius:8px;background:rgba(109,59,245,.09);color:#6d3bf5;cursor:pointer;outline:none;transition:background-color 160ms ease,transform 160ms ease}
@media (hover:hover){.npie-mg-trigger:hover{background:rgba(109,59,245,.17)}}
.npie-mg-trigger:active{transform:scale(.94)}
.npie-mg-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#6d3bf5)}
.npie-mg-trigger[data-armed="true"]{background:rgba(109,59,245,.2)}
.npie-mg-tipbox{position:fixed;z-index:2147483100;transform:translate(-50%,-100%);padding:4px 8px;border-radius:6px;background:#252232;color:#f7f5ff;font-size:11px;line-height:1.4;white-space:nowrap;pointer-events:none;box-shadow:0 4px 14px rgba(20,16,36,.22);animation:npie-mg-fade 140ms ease-out both}
@keyframes npie-mg-fade{from{opacity:0}to{opacity:1}}
.npie-mg-pop{position:fixed;z-index:2147483000;width:min(380px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 48px));display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1,rgba(120,110,150,.2));border-radius:13px;background:var(--dsw-alias-bg-layer-1,#fdfcff);color:var(--dsw-alias-label-primary,#1c1a24);box-shadow:0 1px 2px rgba(24,20,40,.05),0 14px 38px rgba(24,20,40,.13);font:inherit;font-size:12.5px;line-height:1.5;animation:npie-mg-in 180ms cubic-bezier(.22,1,.36,1) both}
@keyframes npie-mg-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.npie-mg-pop::after{content:"";position:absolute;left:var(--mg-arrow-x,24px);width:9px;height:9px;margin-left:-5px;transform:rotate(45deg);background:var(--dsw-alias-bg-layer-1,#fdfcff);border:1px solid var(--dsw-alias-border-l1,rgba(120,110,150,.2))}
.npie-mg-pop[data-placement="above"]::after{bottom:-6px;border-top:0;border-left:0}
.npie-mg-pop[data-placement="below"]::after{top:-6px;border-bottom:0;border-right:0}
.npie-mg-head{display:flex;align-items:center;gap:8px;padding:8px 12px 7px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(120,110,150,.14))}
.npie-mg-mark{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:0 0 auto;border-radius:6px;background:rgba(109,59,245,.1);color:#6d3bf5}
.npie-mg-head-title{flex:1;min-width:0;font-size:12.5px;font-weight:650;letter-spacing:.01em}
.npie-mg-close{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6c6879);font-size:16px;line-height:1;cursor:pointer;outline:none}
@media (hover:hover){.npie-mg-close:hover{background:rgba(127,127,127,.1)}}
.npie-mg-close:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#6d3bf5)}
.npie-mg-scroll{overflow:auto;overscroll-behavior:contain;min-height:0;padding:9px 12px 10px;display:flex;flex-direction:column;gap:6px}
.npie-mg-hint{margin:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#6c6879)}
.npie-mg-input{width:100%;box-sizing:border-box;min-height:46px;max-height:120px;resize:vertical;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1,rgba(120,110,150,.24));border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:12.5px;line-height:1.5;outline:none;transition:border-color 160ms ease,box-shadow 160ms ease}
.npie-mg-input:focus{border-color:#6d3bf5;box-shadow:0 0 0 3px rgba(109,59,245,.1)}
.npie-mg-input::placeholder{color:var(--dsw-alias-label-secondary,#9a96a8)}
.npie-mg-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.npie-mg-btn{width:auto;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:27px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(120,110,150,.28));border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:11.5px;font-weight:550;cursor:pointer;outline:none;transition:background-color 150ms ease,filter 150ms ease}
@media (hover:hover){.npie-mg-btn:hover:not(:disabled){background:rgba(127,127,127,.08)}}
.npie-mg-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#6d3bf5)}
.npie-mg-btn:disabled{opacity:.45;cursor:default}
.npie-mg-btn[data-primary="true"]{border-color:transparent;background:#6d3bf5;color:#fff}
@media (hover:hover){.npie-mg-btn[data-primary="true"]:hover:not(:disabled){filter:brightness(1.08);background:#6d3bf5}}
/* 一键应用的结果必须画在按钮本身：滚动区里的小字用户根本看不到（真机实测）。 */
button.npie-mg-btn[data-apply-tone="ok"]{background:#128a54;border-color:transparent;color:#fff}
button.npie-mg-btn[data-apply-tone="warn"]{background:#a8610b;border-color:transparent;color:#fff}
@media (hover:hover){button.npie-mg-btn[data-apply-tone="ok"]:hover:not(:disabled){background:#128a54}button.npie-mg-btn[data-apply-tone="warn"]:hover:not(:disabled){background:#a8610b}}
.npie-mg-status{margin-inline-start:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b8798);white-space:nowrap}
.npie-mg-result{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:9px;border-inline-start:3px solid #6d3bf5;background:rgba(109,59,245,.055)}
.npie-mg-result[data-source="llm"]{border-inline-start-color:#0f6fe8}
.npie-mg-result[data-source="default"]{border-inline-start-color:var(--dsw-alias-label-secondary,#9a96a8)}
.npie-mg-result-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.npie-mg-result-head .npie-mg-btn{margin-inline-start:auto}
.npie-mg-mode{font-size:14px;font-weight:680;letter-spacing:.01em}
.npie-mg-source{font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b8798)}
.npie-mg-reason{margin:0;font-size:11.5px;line-height:1.55;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#1c1a24)}
.npie-mg-evidence{margin:0;font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,#8b8798);overflow-wrap:anywhere}
.npie-mg-note{margin:0;font-size:10.5px;line-height:1.45;color:var(--dsw-alias-state-warn-primary,#a8610b)}
.npie-mg-mnemonic{margin:0;padding:1px 0 1px 9px;border-inline-start:2px solid rgba(109,59,245,.45);background:transparent;font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6c6879)}
.npie-mg-disclosure{width:auto;padding:0;border:0;background:transparent;color:#6d3bf5;font:inherit;font-size:10.5px;cursor:pointer;outline:none;text-align:start}
.npie-mg-disclosure:hover{text-decoration:underline}
.npie-mg-disclosure:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#6d3bf5)}
.npie-mg-table{width:100%;border-collapse:collapse;font-size:10.5px;margin-top:4px}
.npie-mg-table th,.npie-mg-table td{padding:4px 5px;text-align:center;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(120,110,150,.12))}
.npie-mg-table th:first-child,.npie-mg-table td:first-child{text-align:left;white-space:nowrap}
.npie-mg-table thead th{color:var(--dsw-alias-label-secondary,#8b8798);font-weight:600}
.npie-mg-yes{color:#128a54;font-weight:650}
.npie-mg-no{color:var(--dsw-alias-label-secondary,#b0adba)}
.npie-mg-cond{color:var(--dsw-alias-state-warn-primary,#a8610b)}
.npie-mg-legend{margin:4px 0 0;font-size:10px;line-height:1.45;color:var(--dsw-alias-label-secondary,#8b8798)}
@media (prefers-reduced-motion:reduce){.npie-mg-pop,.npie-mg-tipbox{animation:none}.npie-mg-trigger,.npie-mg-input,.npie-mg-btn{transition:none}}
@media (prefers-color-scheme:dark){.npie-mg-trigger{background:rgba(167,139,250,.14);color:#a78bfa}.npie-mg-trigger[data-armed="true"]{background:rgba(167,139,250,.24)}.npie-mg-mark{background:rgba(167,139,250,.15);color:#a78bfa}.npie-mg-btn[data-primary="true"]{background:#7c4df0}.npie-mg-result{background:rgba(167,139,250,.09);border-inline-start-color:#a78bfa}.npie-mg-mnemonic{border-inline-start-color:rgba(167,139,250,.5)}.npie-mg-disclosure{color:#a78bfa}.npie-mg-input:focus{border-color:#a78bfa;box-shadow:0 0 0 3px rgba(167,139,250,.16)}}
`

/** 客户端拿不到 apply 的 config，配置由宿主 /api/npie-modeguide/config 现读。
 *  取不到就沿用默认值 —— 配置读失败不该让判断停摆。 */
let runtimeConfig = { llmFallback: true, timeoutMs: 20000 }

/**
 * 宿主现读的新任务默认模式。null = 没读到，界面必须诚实标「内置兜底」。
 * 这是唯一一份可变状态：结论、两句理由、按钮文案全从它派生，不许各自再记一份。
 */
let hostDefaultMode = null

/** 只认四个内置预设：能力表只有这四列，别的 id 不拿来切会话。 */
function trustedDefaultMode(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MODE_LABEL_KEYS, id) ? id : null
}

function currentDefaultMode() {
  return hostDefaultMode || BUILTIN_DEFAULT_MODE
}

/** 只在值真的变了时返回 true：定时复查不该每轮都触发一次重渲染。 */
function adoptDefaultMode(id) {
  const safe = trustedDefaultMode(id)
  if (!safe || safe === hostDefaultMode) return false
  hostDefaultMode = safe
  return true
}

/**
 * @returns {Promise<boolean>} 默认模式是否发生变化（调用方据此重算结论）。
 */
async function refreshConfig() {
  let changed = false
  const { signal, cancel } = abortAfter(CONFIG_TIMEOUT_MS)
  try {
    const res = await fetch(CONFIG_PATH, { cache: 'no-store', signal })
    if (!res.ok) return false
    const data = await res.json()
    if (data && typeof data === 'object') {
      const host = Number(data.timeoutMs)
      runtimeConfig = {
        llmFallback: data.llmFallback !== false,
        timeoutMs: Number.isFinite(host) && host > 0 ? Math.min(120000, host) : 20000,
      }
      changed = adoptDefaultMode(data.defaultMode)
    }
  } catch {
    // 保留上一次的值
  } finally {
    cancel()
  }
  return changed
}

/**
 * 主路径读不到默认时的第二来源：官方 `agentPresets.list()` 的 roster 里每项带
 * `isDefault`（宿主 `remoteExportList()` 当场用 `defaultId` 标出来）。
 *
 * 只在 /config 没给值时调，且带独立硬超时：list() 内部会 `await loader.await()`，
 * 历史上就是「预设读不到 / 判断中五分钟」的根源，绝不许进关键路径。
 */
async function readDefaultFromRoster(ctx) {
  const presets = presetsApi(ctx)
  if (!presets || typeof presets.list !== 'function') return null
  let res
  try {
    res = await withTimeout(
      Promise.resolve().then(() => presets.list()),
      DEFAULT_LIST_TIMEOUT_MS,
      null,
    )
  } catch {
    return null
  }
  const rows = res && res.ok && res.value && Array.isArray(res.value.presets) ? res.value.presets : []
  const hit = rows.find((row) => row && row.isDefault === true && trustedDefaultMode(row.id))
  return hit ? hit.id : null
}

/**
 * 客户端等待上限必须**大于**宿主的单次判定超时。
 * 旧实现把客户端写死 6s、宿主配置却允许 20s：慢模型下宿主还在算，客户端早已
 * abort 并把结果丢掉 —— 模型兜底永远拿不到结论，配置里的 timeoutMs 形同虚设。
 * 结论在点击当场就已同步画出，这里等的是后台增强，不阻塞界面。
 */
function modelTimeoutMs() {
  const host = Number(runtimeConfig.timeoutMs)
  const safeHost = Number.isFinite(host) && host > 0 ? Math.min(120000, host) : 20000
  return Math.max(MODEL_TIMEOUT_FLOOR_MS, safeHost + MODEL_TIMEOUT_SLACK_MS)
}

/** 内置词典兜底：按页面语言选 zh / en。 */
function fallbackText(key) {
  const dicts = typeof LOCALES === 'undefined' ? {} : LOCALES
  const lang = typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const dict = dicts[lang] || dicts.zh || {}
  return dict[key] || (dicts.zh && dicts.zh[key]) || key
}

/**
 * 组装翻译函数。优先宿主 locale 服务；缺席或注册失败时退回内置词典，
 * 保证界面永远有可读文案，而不是抛错让整个浮层打不开。
 */
function makeTranslator(ctx) {
  let locale = null
  try {
    locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null
  } catch {
    locale = null
  }
  try {
    if (locale && typeof LOCALES !== 'undefined' && typeof locale.register === 'function' && typeof locale.bind === 'function') {
      locale.register(PKG, { zh: LOCALES.zh, en: LOCALES.en })
      const bound = locale.bind(PKG)
      if (typeof bound === 'function') {
        return (key) => {
          try {
            const value = bound(key)
            return typeof value === 'string' && value ? value : fallbackText(key)
          } catch {
            return fallbackText(key)
          }
        }
      }
    }
  } catch {
    // 宿主不认这个命名空间：用内置词典
  }
  return fallbackText
}

/**
 * 读取能力矩阵：从真实预设 YAML 解析，不写死。**只用于后台增强**，调用方必须包超时。
 *
 * 能力表的数据分两层：
 *   ① 基线 `PRESET_BASELINE`：构建时从当前内核 presets/*.patch.yml 真解析出的四列
 *      能力矩阵，随 client.js 一起发布，点击当场就能画，不依赖任何 IPC；
 *   ② 实时校正：后台尝试 `agentPresets.read()`，四个全读到才替换基线。
 *
 * 为什么不把能力表放在 Remote 的关键路径上：
 *   ① `ctx.remote.agentPresets` 是**独立的 cordis service**，fiber 的 inject 必须
 *      单独列 `'remote.agentPresets'`（官方 dsh-client-ui-agent-preset 就是这么写的）。
 *      缺这一项时属性代理直接抛 `cannot get property "remote.agentPresets" without inject`，
 *      `?.` 拦不住抛 —— 0.1.5 之前「切到这个模式」报错、实时校正静默失效都源于此。
 *      它与 `dsh.client.inject` 里的**包名列表**是两层，不是同一件事。
 *   ② 即便声明齐了，unary 调用还要过 gateway carrier；离线时折进 RemoteResult 的
 *      error 分支（宿主规范明写「不抛异常」），四次 read 仍可能全拿不到内容。
 *   ③ `agentPresets.list()` 会 `await loader.await()` 死等，绝对不调。
 * 结论：能力表用构建期基线当场画，实时读取只做后台静默校正，失败完全不打扰用户。
 */

/**
 * 取 `remote.agentPresets`。两个调用点共用，不许各写一份。
 *
 * 正式修法是在 module.exports.inject 里声明该 service；这里再兜一层 reflect
 * 软取：万一宿主换了声明方式或该 service 尚未 mount，插件只是降级、不会抛。
 */
function presetsApi(ctx) {
  const usable = (api) => api && (typeof api.read === 'function' || typeof api.select === 'function') ? api : null
  try {
    const direct = ctx && ctx.remote && ctx.remote.agentPresets
    if (usable(direct)) return direct
  } catch {
    // 属性代理拒绝访问（without inject）：走下面的软取
  }
  try {
    const reflect = ctx && ctx.reflect
    const soft = reflect && typeof reflect.get === 'function'
      ? reflect.get('remote.agentPresets', false)
      : null
    if (usable(soft)) return soft
  } catch {
    // 软取也不该抛；真抛了就当这个环境没有该服务
  }
  return null
}

async function refineMatrix(ctx) {
  const presets = presetsApi(ctx)
  if (!presets || typeof presets.read !== 'function') return null
  const ids = PRESET_BASELINE.columns.map((c) => c.id)
  const docs = await Promise.all(ids.map(async (id) => {
    try {
      const doc = await withTimeout(presets.read(id), READ_TIMEOUT_MS, null)
      const value = doc && doc.ok ? doc.value : null
      if (!value || typeof value.content !== 'string') return null
      return { id, name: value.name || id, content: value.content }
    } catch {
      return null
    }
  }))
  const usable = docs.filter(Boolean)
  // 少一列的表不如完整的基线：要么四列全换，要么一列不换。
  return usable.length === ids.length ? buildMatrix(usable) : null
}

/**
 * 请宿主代问一次模型。
 *
 * 不把「没结论」压成一个 null：「模型没回应」和「问得太频繁」对用户是两件事 ——
 * 后者要说出还要等几秒，否则界面只能笼统写一句失败，用户会以为插件坏了。
 * 所以统一回 `{verdict?, error?, retryAfterMs?}`，调用方据此选文案。
 *
 * @returns {Promise<{verdict?: object, error?: string, retryAfterMs?: number}>}
 */
async function askHost(input, matrix, timeoutMs) {
  const { signal, cancel } = abortAfter(timeoutMs)
  try {
    const res = await fetch(JUDGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input, matrix }),
      signal,
    })
    // 429 也带 JSON body（retryAfterMs），必须在 !ok 之前先读出来，否则就只剩
    // 一个状态码，界面对「还要等多久」一无所知。
    let data = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    if (data && data.ok && data.verdict) return { verdict: data.verdict }
    if (data && typeof data.error === 'string') {
      const retry = Number(data.retryAfterMs)
      // 秒数只从宿主的 retryAfterMs 来：客户端不存第二份配额数字，免得某个版本
      // 改了常量，界面却还按旧数报「20 秒」。
      return { error: data.error, retryAfterMs: Number.isFinite(retry) && retry > 0 ? retry : 0 }
    }
    return { error: res.ok ? 'llm-unavailable' : 'http-' + res.status }
  } catch {
    return { error: 'network' }
  } finally {
    cancel()
  }
}

/**
 * 配额用光时的那句说明。秒数只来自宿主 429 的 `retryAfterMs`；拿不到就退成
 * 「稍后再问」，不编一个数字冒充精确。
 * @returns {string|null} 不是配额问题就返回 null，交给调用方用兜底文案。
 */
function quotaNote(answer, t) {
  if (!answer || answer.error !== 'rate-limited') return null
  const seconds = Math.ceil((Number(answer.retryAfterMs) || 0) / 1000)
  return seconds > 0
    ? t('rateLimitedNote').replace('{s}', String(seconds))
    : t('rateLimitedNoteSoon')
}

/** 能力名走词典；未知能力（自定义预设解析出的新行）回退到解析出的中文 label。 */
function capLabel(row, t) {
  const key = 'cap_' + row.id
  const value = t(key)
  return value && value !== key ? value : row.label
}

/** 用一条已知含汉字的词条反查界面语言，不猜宿主 locale 服务的 API。 */
function uiLang(t) {
  return /[\u4e00-\u9fff]/.test(t('mode_ptc')) ? 'zh' : 'en'
}

/**
 * 把两句详实理由挂到结论上。**能力表一变就必须重算**：实时校正拿回新表后，
 * 理由里的差异项数和分布若还停在基线，那句「可展开差异表核对」就是骗人的。
 */
function withWhy(verdict, input, matrix, t, defaultMode) {
  if (!verdict) return verdict
  return {
    ...verdict,
    why: explainVerdict(input, verdict, matrix, {
      lang: uiLang(t),
      defaultMode,
      modeName: (id) => t(MODE_LABEL_KEYS[id] || '') || id,
      capabilityLabel: (row) => capLabel(row, t),
    }),
  }
}

/** 用户给的三节点环形图标：三个圆 + 三条弧，紫色描边。 */
function ModeIcon(props) {
  const h = React.createElement
  const size = (props && props.size) || 18
  return h('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
    stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
    style: { display: 'block' },
  },
    h('path', { d: 'M13.9 7.5 C16.4 9.1 17.8 11.7 17.6 14.9' }),
    h('path', { d: 'M10.1 7.5 C7.6 9.1 6.2 11.7 6.4 14.9' }),
    h('path', { d: 'M7.9 17 C9.9 18 14.1 18 16.1 17' }),
    h('circle', { cx: '12', cy: '5.5', r: '2.1' }),
    h('circle', { cx: '5.5', cy: '17.1', r: '2.1' }),
    h('circle', { cx: '18.5', cy: '17.1', r: '2.1' }),
  )
}

/**
 * 组件：工具栏图标入口 + 浮层。
 */
function ModeGuide(props) {
  const h = React.createElement
  const t = props.t || fallbackText
  const [open, setOpen] = React.useState(false)
  const [input, setInput] = React.useState('')
  // 状态只留真正会被渲染的字段：曾经还有 status / error，两者全库 0 引用，
  // 只是让每次 setState 多背两个字段。
  const [state, setState] = React.useState({ verdict: null, matrix: null, busy: '', note: null })
  // 用户的新任务默认由宿主下发、随时可改。结论、两句理由、按钮文案全从这两项派生。
  const [defaultMode, setDefaultMode] = React.useState(() => currentDefaultMode())
  const [defaultKnown, setDefaultKnown] = React.useState(() => hostDefaultMode !== null)
  const [applying, setApplying] = React.useState(false)
  const [applyNote, setApplyNote] = React.useState(null)
  const [matrixOpen, setMatrixOpen] = React.useState(false)
  const [tip, setTip] = React.useState(false)
  const [tipPos, setTipPos] = React.useState({ left: 0, top: 0 })
  const anchorRef = React.useRef(null)
  const popRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const judgeSeq = React.useRef(0)
  // 异步回调里读不到最新的 state.matrix；用 ref 保证理由始终按最新的能力表重算。
  const matrixRef = React.useRef(PRESET_BASELINE)
  // 最后一次判断的原文：默认模式改了要按新值重算两句理由，不能拿空输入框去算。
  const judgedTextRef = React.useRef('')
  const [pos, setPos] = React.useState({ left: 8, top: 8, arrowLeft: 24, maxHeight: 400, placement: 'above' })

  // 这两个 hook 是 selector hook，必须传 (s) => s。详见文件头第 5 条。
  const inputState = typeof props.useInput === 'function' ? props.useInput((s) => s) : undefined
  const draft = inputState && typeof inputState.draft === 'string' ? inputState.draft : ''
  const session = typeof props.useSession === 'function' ? props.useSession((s) => s) : undefined
  // 官方 SessionSnapshot 的身份字段是 id；slot 有时直接给 sessionId。两个都认，
  // 只认一个会让 sessionId 变成 undefined —— 一键应用按钮直接消失或 select 找不到 Agent。
  const sessionId = props.sessionId || (session && (session.sessionId || session.id))
  // 只有空白会话能切换预设：agentPresets.select 对已开始的会话会拒绝。
  const canApply = Boolean(sessionId) && Boolean(session && session.blank === true)

  const openSheet = () => {
    setInput((prev) => (prev.trim() ? prev : draft))
    setTip(false)
    setOpen(true)
  }
  const close = () => {
    judgeSeq.current += 1 // 作废在飞的判断，避免关闭后再 setState
    setOpen(false)
  }

  const showTip = () => {
    const el = anchorRef.current
    if (open || !el || typeof el.getBoundingClientRect !== 'function') return
    const rect = el.getBoundingClientRect()
    setTipPos({ left: Math.max(8, Math.min(rect.left + rect.width / 2, window.innerWidth - 8)), top: Math.max(8, rect.top - 8) })
    setTip(true)
  }

  /**
   * 复查宿主的新任务默认。变了就要重算结论与两句理由：
   *   - 「不用换」类（noToolNeed / source=default）的结论**本身就是默认模式**，
   *     用户把默认从 PTC 改成标准，结论必须跟着从「PTC 模式」变成「标准模式」；
   *   - 规则 / 模型定案的模式不动，但理由仍按新默认重算，口径不许停在旧值。
   * 全程 fire-and-forget：结论在点击当场已经画好，这里只是后台校正。
   */
  const syncDefaultMode = async () => {
    let changed = await refreshConfig()
    // /config 没读到时才动用官方 roster，且带独立硬超时（list 可能永不返回）。
    if (hostDefaultMode === null) {
      changed = adoptDefaultMode(await readDefaultFromRoster(props.ctx)) || changed
    }
    if (!changed) return
    const fresh = currentDefaultMode()
    setDefaultMode(fresh)
    setDefaultKnown(true)
    setState((prev) => {
      if (!prev.verdict) return prev
      const local = prev.verdict.local
      const stays = prev.verdict.source === 'default' || (local && local.noToolNeed === true)
      const base = stays ? composeVerdict(local, null, fresh) : prev.verdict
      return { ...prev, verdict: withWhy(base, judgedTextRef.current, matrixRef.current, t, fresh) }
    })
  }

  // 打开时现读一次配置：llmFallback 关掉后客户端连那次请求都不发，默认模式也要现读。
  // 焦点回到窗口 / 从后台切回 / 定时复查都要再读一次：「设置 → Agent 预设」与浮层
  // 在同一个窗口，用户改完默认回来不会触发 focus，只有轮询能兜住这个场景。
  React.useEffect(() => {
    if (!open) return undefined
    const wake = () => { void syncDefaultMode() }
    void syncDefaultMode()
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    const timer = setInterval(wake, DEFAULT_MODE_POLL_MS)
    return () => {
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
      clearInterval(timer)
    }
  }, [open])

  // 位置：贴触发按钮上方；用 offsetHeight 量真实高度（不受入场动画 transform 影响），
  // 内容变化重算，并把 maxHeight 钳进上方空间，面板绝不向下溢出盖住工具栏。
  React.useEffect(() => {
    if (!open) return undefined
    const compute = () => {
      const el = anchorRef.current
      if (!el || typeof el.getBoundingClientRect !== 'function') return
      const pop = popRef.current
      let popH = 320
      if (pop) {
        // 优先 offsetHeight：getBoundingClientRect 会把 scale/translate 算进去，量歪 10px。
        popH = pop.offsetHeight || (typeof pop.getBoundingClientRect === 'function'
          ? pop.getBoundingClientRect().height : 320)
      }
      const next = computePopoverPosition(
        el.getBoundingClientRect(), popH,
        { width: window.innerWidth, height: window.innerHeight },
      )
      setPos((prev) => (
        prev.left === next.left && prev.top === next.top && prev.placement === next.placement
          && prev.arrowLeft === next.arrowLeft && prev.maxHeight === next.maxHeight
          ? prev : next
      ))
    }
    compute()
    let raf = 0
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(compute)
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    let observer = null
    if (typeof ResizeObserver !== 'undefined' && popRef.current) {
      observer = new ResizeObserver(compute)
      observer.observe(popRef.current)
    }
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
      if (observer) observer.disconnect()
    }
  }, [open, state.verdict, state.matrix, state.note, state.busy, matrixOpen])

  // 打开就把焦点给输入框：这是浮层里唯一要做的事，不该让键盘用户 Tab 好几次。
  React.useEffect(() => {
    if (!open) return undefined
    const el = inputRef.current
    if (el && typeof el.focus === 'function') el.focus()
    return undefined
  }, [open])

  // Esc 关闭；点浮层与触发按钮之外也关闭。
  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    const onDown = (event) => {
      const pop = popRef.current
      const anchor = anchorRef.current
      if (pop && pop.contains(event.target)) return
      if (anchor && anchor.contains(event.target)) return
      close()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [open])

  /**
   * 判断。结论、两句理由与能力表都在点击当场同步出现，不依赖任何远程调用：
   *   ① 本地规则 + 构建时的能力基线 → 立刻渲染；
   *   ② 后台静默尝试实时预设校正（成功才替换表，理由也按新表重算，失败无感）；
   *   ③ 只有信号冲突 / 信息不足才问模型，带硬超时；失败保留结论并说明原因。
   */
  const runJudge = async () => {
    const text = input.trim()
    if (!text) return
    const seq = ++judgeSeq.current
    setApplyNote(null)
    judgedTextRef.current = text

    const baseline = PRESET_BASELINE
    const available = baseline.columns.map((c) => c.id)
    const local = recommendByRules(text, { available })
    matrixRef.current = baseline
    const shownDefault = defaultMode
    setState({
      verdict: withWhy(composeVerdict(local, null, shownDefault), text, baseline, t, shownDefault),
      matrix: baseline,
      busy: '',
      note: null,
    })

    // 默认模式的复查也在后台，绝不挡在上面已经画好的结论前面。
    // 结论先出、后台校正，是「判断中…」卡五分钟那条老毛病的关键防线。
    const configSync = syncDefaultMode()

    // 实时校正完全在后台：成功是加分，失败不许在界面上留下一句话。
    withTimeout(refineMatrix(props.ctx), PRESET_TIMEOUT_MS, null).then((live) => {
      if (seq !== judgeSeq.current || !live) return
      matrixRef.current = live
      setState((prev) => ({
        ...prev,
        matrix: live,
        verdict: prev.verdict ? withWhy(prev.verdict, text, live, t, currentDefaultMode()) : prev.verdict,
      }))
    })

    // 「没有出现任何独有工具信号」是**已确定不用换**，不是拿不准 —— 写首诗不该
    // 白等一次模型调用。只有真歧义（信号冲突 / 描述太短 / 装不上）才继续。
    if (local.kind !== 'unknown' || local.noToolNeed) return
    // 等上面那次现读结束：llmFallback / timeoutMs / 默认模式都必须是新鲜值。
    // 旧实现只在打开浮层时 fire-and-forget 读一次，立刻点「给建议」会用到旧配置。
    // 结论早已同步画出，这一步只影响后台增强，不阻塞用户。
    await configSync
    if (seq !== judgeSeq.current || !runtimeConfig.llmFallback) return
    const modelMs = modelTimeoutMs()
    setState((prev) => ({ ...prev, busy: 'model' }))
    const answer = await withTimeout(askHost(text, baseline, modelMs), modelMs, null)
    if (seq !== judgeSeq.current) return
    const llm = answer && answer.verdict ? answer.verdict : null
    const freshDefault = currentDefaultMode()
    setState((prev) => ({
      ...prev,
      busy: '',
      verdict: withWhy(composeVerdict(local, llm, freshDefault), text, matrixRef.current, t, freshDefault),
      // 配额用光与模型没回应必须说成两句不同的话：前者用户等一会儿就能再问，
      // 后者是能力问题。混成一句「模型没回应」会把「你点太快了」说成故障。
      note: llm ? prev.note : (quotaNote(answer, t) || t('fallbackNote')),
    }))
  }

  // 应用：只在空白会话出现。
  // ★ 用户实测「点了完全没反应」：旧实现在 remote 缺席时**提前 return**，
  //   setApplying 根本没跑，按钮文字不变，只在滚动区塞一行 10.5px 小字 —— 看不见。
  //   现在任何一条路径都先进入 applying，再让按钮本身变字说出结论；
  //   select 也加硬超时，宿主挂起时不会永远停在「切换中…」。
  const applyMode = async () => {
    const verdictNow = state.verdict
    if (!verdictNow || !canApply || applying) return
    // 结论就是用户自己设的新任务默认：再 select 一次不但多余，还可能把会话
    // 从默认切走。0.1.8 把默认写死 ptc 时，用户选了标准模式就会中这一刀。
    if (verdictNow.mode === currentDefaultMode()) {
      setApplyNote({ tone: 'ok', kind: 'keep', text: t('alreadyDefault') })
      return
    }
    setApplying(true)
    setApplyNote(null)
    try {
      const presets = presetsApi(props.ctx)
      if (!presets || typeof presets.select !== 'function') {
        setApplyNote({ tone: 'warn', text: t('noRemote') + t('manualHint') })
        return
      }
      const res = await withTimeout(
        Promise.resolve().then(() => presets.select(sessionId, verdictNow.mode)),
        APPLY_TIMEOUT_MS,
        null,
      )
      if (res === null) {
        setApplyNote({ tone: 'warn', text: t('applyTimeout') + t('manualHint') })
        return
      }
      if (res && res.ok) {
        setApplyNote({ tone: 'ok', text: t('applied') })
        return
      }
      const reason = res && res.error
        ? (res.error.details && res.error.details.reason) || res.error.message
        : t('unknownReason')
      setApplyNote({ tone: 'warn', text: t('applyFailedPrefix') + reason + t('manualHint') })
    } catch (error) {
      setApplyNote({ tone: 'warn', text: t('applyFailedPrefix') + ((error && error.message) || error) + t('manualHint') })
    } finally {
      setApplying(false)
    }
  }

  const verdict = state.verdict
  const matrix = state.matrix

  const trigger = h('button', {
    type: 'button',
    ref: anchorRef,
    className: 'npie-mg-trigger',
    'data-armed': String(open),
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-label': t('triggerAria'),
    onMouseEnter: showTip,
    onMouseLeave: () => setTip(false),
    onFocus: showTip,
    onBlur: () => setTip(false),
    onClick: () => (open ? close() : openSheet()),
  }, h(ModeIcon, { size: 18 }))

  const tipNode = tip && !open
    ? h('div', { className: 'npie-mg-tipbox', role: 'tooltip', style: { left: tipPos.left, top: tipPos.top } }, t('trigger'))
    : null

  if (!open) {
    return h('div', { className: 'npie-mg-root' }, trigger, tipNode ? createPortal(tipNode, document.body) : null)
  }

  const pop = h('div', {
    ref: popRef,
    className: 'npie-mg-pop',
    role: 'dialog',
    'aria-label': t('sheetTitle'),
    'data-placement': pos.placement,
    style: {
      left: pos.left,
      top: pos.top,
      maxHeight: pos.maxHeight + 'px',
      '--mg-arrow-x': pos.arrowLeft + 'px',
    },
  },
  h('div', { className: 'npie-mg-head' },
    h('span', { className: 'npie-mg-mark' }, h(ModeIcon, { size: 14 })),
    h('span', { className: 'npie-mg-head-title' }, t('sheetTitle')),
    h('button', { type: 'button', className: 'npie-mg-close', 'aria-label': t('close'), onClick: close }, '×'),
  ),
  h('div', { className: 'npie-mg-scroll' },
    // 出了结论后这行用法说明就没用了：收起它，正好抵消两句详实理由带来的高度。
    verdict ? null : h('p', { className: 'npie-mg-hint' }, t('hint')),
    h('textarea', {
      className: 'npie-mg-input',
      ref: inputRef,
      value: input,
      placeholder: t('placeholder'),
      'aria-label': t('inputAria'),
      onChange: (event) => setInput(event.target.value),
      onKeyDown: (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          void runJudge()
        }
      },
    }),
    h('div', { className: 'npie-mg-actions' },
      h('button', {
        type: 'button',
        className: 'npie-mg-btn',
        'data-primary': String(!verdict), // 有结论后降为次要，一屏只留一个主按钮
        disabled: !input.trim(),
        onClick: () => void runJudge(),
      }, t('judge')),
      draft && input.trim() !== draft.trim()
        ? h('button', { type: 'button', className: 'npie-mg-btn', onClick: () => setInput(draft) }, t('useDraft'))
        : null,
      state.busy === 'model'
        ? h('span', { className: 'npie-mg-status', 'aria-live': 'polite' }, t('busyModel'))
        : null,
    ),

    verdict
      ? h('div', {
          className: 'npie-mg-result',
          'data-source': verdict.source,
          'aria-live': 'polite',
        },
        h('div', { className: 'npie-mg-result-head' },
          h('span', { className: 'npie-mg-mode' }, t(MODE_LABEL_KEYS[verdict.mode] || '') || verdict.mode),
          verdict.source === 'llm' ? h('span', { className: 'npie-mg-source' }, t('byLlm')) : null,
          verdict.source === 'rules' ? h('span', { className: 'npie-mg-source' }, t('byRules')) : null,
          verdict.source === 'default'
            ? h('span', { className: 'npie-mg-source' }, defaultKnown
                ? t('byDefault') + (t(MODE_LABEL_KEYS[defaultMode] || '') || defaultMode)
                : t('defaultTagFallback'))
            : null,
          canApply
            ? h('button', {
                type: 'button',
                className: 'npie-mg-btn',
                'data-primary': 'true',
                'data-apply-tone': applyNote ? applyNote.tone : '',
                'aria-live': 'polite',
                title: applyNote ? applyNote.text : '',
                disabled: applying,
                onClick: () => void applyMode(),
              }, applying ? t('applying')
                : applyNote && applyNote.tone === 'ok'
                  ? (applyNote.kind === 'keep' ? t('keepShort') : t('appliedShort'))
                  : applyNote && applyNote.tone === 'warn' ? t('applyRetry')
                    : verdict.mode === defaultMode ? t('keepDefault')
                      : t('apply'))
            : null,
        ),
        // 命中词已经并进理由第一句，不再单独占一行：两句详实理由要换来高度，
        // 就把旧的 evidence 行撤掉，净增高控制在一行以内。
        h('p', { className: 'npie-mg-reason' }, verdict.why || verdict.reason),
        !canApply ? h('p', { className: 'npie-mg-evidence' }, t('lockedHint')) : null,
        applyNote
          ? h('p', {
              className: 'npie-mg-evidence',
              style: { color: applyNote.tone === 'warn' ? 'var(--dsw-alias-state-warn-primary,#a8610b)' : 'var(--dsw-alias-state-success-primary,#128a54)' },
            }, applyNote.text)
          : null,
      )
      : null,

    state.note ? h('p', { className: 'npie-mg-note' }, state.note) : null,

    h('p', { className: 'npie-mg-mnemonic' }, t('mnemonic')),

    matrix && matrix.rows.length
      ? h('div', null,
          h('button', {
            type: 'button',
            className: 'npie-mg-disclosure',
            'aria-expanded': String(matrixOpen),
            onClick: () => setMatrixOpen((prev) => !prev),
          }, t(matrixOpen ? 'matrixToggleHide' : 'matrixToggle')),
          matrixOpen
            ? h('div', null,
                h('table', { className: 'npie-mg-table' },
                  h('thead', null, h('tr', null,
                    h('th', null, t('capability')),
                    matrix.columns.map((c) => h('th', { key: c.id }, t(MODE_SHORT_KEYS[c.id] || '') || c.id)),
                  )),
                  h('tbody', null, matrix.rows.map((row) => h('tr', { key: row.id },
                    h('td', { title: row.hint }, capLabel(row, t)),
                    matrix.columns.map((c) => {
                      const value = row.cells[c.id]
                      if (value === true) return h('td', { key: c.id, className: 'npie-mg-yes' }, '✓')
                      if (value === 'conditional') return h('td', { key: c.id, className: 'npie-mg-cond', title: t('conditional') }, '?')
                      return h('td', { key: c.id, className: 'npie-mg-no' }, '·')
                    }),
                  ))),
                ),
                h('p', { className: 'npie-mg-legend' }, t('legend')),
              )
            : null,
        )
      : null,
  ),
  )

  // 浮层挂到 body：工具栏有 overflow 裁剪，就地展开会被切掉。
  return h('div', { className: 'npie-mg-root' }, trigger, createPortal(pop, document.body))
}

module.exports = {
  // 'remote.agentPresets' 是独立的 cordis service，不是 'remote' 的附属属性：
  // 少这一项时 ctx.remote.agentPresets 会抛 "cannot get property ... without inject"。
  // 与官方 dsh-client-ui-agent-preset/src/client/index.ts 的 inject 声明对齐。
  inject: ['slots', 'remote', 'remote.agentPresets'],
  // 纯函数挂出来给判据直接验：面板锚定、以及「客户端等待必须长于宿主判定超时」。
  computePopoverPosition,
  modelTimeoutMs,
  currentDefaultMode,
  apply(ctx) {
    const t = makeTranslator(ctx)

    ctx.effect(() => {
      const style = document.createElement('style')
      style.setAttribute('data-plugin', PKG)
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }, 'dsh-npie-modeguide: styles')

    // slots.inject 立即安装并返回 disposer。交给 ctx.effect 统一清理，
    // 否则插件卸载 / 热更新后旧注册会残留在工具栏里。
    ctx.effect(() => {
      const off = ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'npie-modeguide',
        order: 40,
      }, (props) => React.createElement(ModeGuide, { ...props, ctx, t })))
      return () => {
        if (typeof off === 'function') off()
      }
    }, 'dsh-npie-modeguide: composer slot')
  },
}
