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

/**
 * 宿主 loader 里的行 id，也就是设置命名空间的名字。
 *
 * `cordis.patch.yml` 里那条 `- id: npie-modeguide` 是**契约**：宿主按 entry.id 服务
 * 设置命名空间，客户端 `configForms.get(entryId)` 认的也是它。两处任何一个改了，
 * 设置卡片会静默消失（`get()` 返回 unavailable），不会报错。
 */
const ROW_ID = 'npie-modeguide'

/** 插件页里「这一行」的配置卡 key：`<包名>#<行 id>`，与先例一致。 */
const ROW_CONFIG_KEY = `${PKG}#${ROW_ID}`
const JUDGE_PATH = '/api/npie-modeguide/judge'
const CONFIG_PATH = '/api/npie-modeguide/config'
const FEEDBACK_PATH = '/api/npie-modeguide/feedback'
const STATS_PATH = '/api/npie-modeguide/stats'

/**
 * 会话内计数：面板底部「本机统计」的左半边。
 *
 * 用模块级对象而不是 state：它只被统计区读，不需要触发重渲染；放进 state 反而
 * 会让每次判定多一次渲染，而判定本来就是「当场出结论」这条链上最贵的一步。
 */
const sessionCounts = { judged: 0, rules: 0, llm: 0, default: 0 }

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
/**
 * 浮层开着时复查默认的间隔。设置页与浮层在同一个窗口，改完默认不会触发 focus，
 * 只有轮询能兜住这个场景。
 *
 * 12 秒是权衡后的值（报告建议 10–15s）：三条**即时**路径本来就会刷新 ——
 * 每次判断、窗口回焦、标签页切回；轮询只是兜底。宿主侧读 profile 还有 mtime 缓存，
 * 所以这个间隔的差别不在读盘成本，而在「面板长开时一小时问宿主多少次」。
 */
const DEFAULT_MODE_POLL_MS = 12000

/**
 * 「输入即显示」的防抖窗口。
 *
 * 打字时每一键都判一次会把 CPU 烧在没人看的地方；停手 500ms 才判，用户根本察觉不到
 * 延迟（他本来也不会在打第一个字时看工具条）。
 */
const INPUT_HINT_DEBOUNCE_MS = 500

/**
 * 太短的草稿不出徽标。
 *
 * 「帮我」「改一下」这类半句在任何模式下都成立，给它们挂一个「建议：创造」只会
 * 制造噪声 —— 而且噪声会训练用户无视徽标，那比没有徽标更糟。
 */
const INPUT_HINT_MIN_CHARS = 8
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
/* 有建议时按钮变宽：图标 + 一句话。宽度靠内容，不写死，中文英文都放得下。 */
.npie-mg-trigger[data-hint="true"]{width:auto;gap:4px;padding:0 9px 0 5px}
/* 拿不准时只给入口、不给结论：去掉紫底、文字降一档，避免被读成「已经判好了」。 */
.npie-mg-trigger[data-level="ask"]{background:rgba(120,110,150,.10);color:var(--dsw-alias-label-secondary,#6b6579)}
@media (hover:hover){.npie-mg-trigger[data-level="ask"]:hover{background:rgba(120,110,150,.18)}}
.npie-mg-badge{font-size:11px;line-height:1;font-weight:600;white-space:nowrap;letter-spacing:.2px}
.npie-mg-badge[data-level="ask"]{font-weight:500;opacity:.9}
/* 设置卡：宿主插件页里的表单，尺寸交给宿主，这里只管对齐与行距。 */
.npie-mg-card{display:flex;flex-direction:column;gap:8px;padding:4px 0}
.npie-mg-card-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.5}
.npie-mg-card-row input[type="number"]{width:88px;padding:2px 6px;border:1px solid rgba(109,59,245,.28);border-radius:6px;background:transparent;color:inherit;font:inherit}
.npie-mg-card-note{margin:0;font-size:11px;line-height:1.5;opacity:.72;color:var(--dsw-alias-label-secondary,#6b6579)}
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
/* 反馈按钮必须显式 width:auto：宿主给裸 button 兜了 width:100%，进 flex 行会变横条。 */
.npie-mg-fb{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}
.npie-mg-fb-ask{font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b8798)}
.npie-mg-fb-btn{width:auto;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(120,110,150,.28));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:10.5px;cursor:pointer;outline:none;transition:background-color 150ms ease,border-color 150ms ease}
@media (hover:hover){.npie-mg-fb-btn:hover:not(:disabled){background:rgba(127,127,127,.08)}}
.npie-mg-fb-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#6d3bf5)}
.npie-mg-fb-btn:disabled{opacity:.55;cursor:default}
.npie-mg-fb-btn[data-chosen="true"]{border-color:#6d3bf5;color:#6d3bf5;background:rgba(109,59,245,.08)}
.npie-mg-fb-note{font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b8798)}
.npie-mg-fb-note[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,#a8610b)}
.npie-mg-stats{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.npie-mg-stats ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.npie-mg-stats li{display:flex;align-items:baseline;justify-content:space-between;gap:6px;padding:2px 0;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b8798);border-bottom:1px dashed var(--dsw-alias-border-l1,rgba(120,110,150,.16))}
.npie-mg-stats b{font-weight:650;color:var(--dsw-alias-label-primary,#1c1a24)}
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
@media (prefers-color-scheme:dark){.npie-mg-trigger{background:rgba(167,139,250,.14);color:#a78bfa}.npie-mg-trigger[data-armed="true"]{background:rgba(167,139,250,.24)}.npie-mg-mark{background:rgba(167,139,250,.15);color:#a78bfa}.npie-mg-btn[data-primary="true"]{background:#7c4df0}.npie-mg-result{background:rgba(167,139,250,.09);border-inline-start-color:#a78bfa}.npie-mg-mnemonic{border-inline-start-color:rgba(167,139,250,.5)}.npie-mg-disclosure{color:#a78bfa}.npie-mg-input:focus{border-color:#a78bfa;box-shadow:0 0 0 3px rgba(167,139,250,.16)}.npie-mg-fb-btn[data-chosen="true"]{border-color:#a78bfa;color:#a78bfa;background:rgba(167,139,250,.12)}}
`

/** 客户端拿不到 apply 的 config，配置由宿主 /api/npie-modeguide/config 现读。
 *  取不到就沿用默认值 —— 配置读失败不该让判断停摆。 */
let runtimeConfig = { llmFallback: true, timeoutMs: 20000 }

/**
 * 宿主现读的新任务默认模式。null = 没读到，界面必须诚实标「内置兜底」。
 * 这是唯一一份可变状态：结论、两句理由、按钮文案全从它派生，不许各自再记一份。
 */
let hostDefaultMode = null

/**
 * 认一个可信的预设 id：**形状**校验，内置四个与用户自定义一视同仁。
 *
 * 0.2.1 及以前这里只认 `PRESET_IDS` 里的四个，于是用户在「设置 → Agent 预设」
 * 里自建一个 `doc-writer` 并设为默认后，插件一边显示「未读到默认」、一边继续
 * 拿内置 ptc 当兜底 —— 明明读到了，只是被自己的白名单否掉了。
 *
 * 放宽到形状校验后，「这个 id 到底存不存在」由 roster（agentPresets.list）确认；
 * 默认模式读到了但 roster 里没有，仍然采用（那是宿主的权威值），只是切会话时
 * 可能失败 —— `select()` 会拒绝，界面会明说原因。
 */
function trustedDefaultMode(id) {
  return isModeId(id) ? id : null
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
 * 宿主实际装了哪些预设（roster）。**只有它知道有没有第五个模式。**
 *
 * `agentPresets.list()` 是唯一来源，但它内部会 `await loader.await()`，历史上就是
 * 「预设读不到 / 判断中五分钟」的根源，所以这里加独立硬超时 + 60 秒缓存。
 * 缓存不只是省一次调用：list() 超时返回空表时，不缓存就会每次轮询再挂 1.2 秒。
 *
 * 返回项统一成 `{ id, name, isDefault }`，只保留形状合法的 id —— roster 里混进
 * 别的东西时宁可少一列，也不让一个奇怪的值进能力表。
 */
const ROSTER_TTL_MS = 60000
let rosterCache = { at: 0, rows: [] }

async function readRoster(ctx) {
  if (rosterCache.rows.length && Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache.rows
  const presets = presetsApi(ctx)
  if (!presets || typeof presets.list !== 'function') return rosterCache.rows
  let res
  try {
    res = await withTimeout(
      Promise.resolve().then(() => presets.list()),
      DEFAULT_LIST_TIMEOUT_MS,
      null,
    )
  } catch {
    return rosterCache.rows
  }
  const raw = res && res.ok && res.value && Array.isArray(res.value.presets) ? res.value.presets : []
  const rows = raw
    .filter((row) => row && isModeId(row.id))
    .map((row) => ({
      id: row.id,
      name: typeof row.name === 'string' && row.name ? row.name : row.id,
      isDefault: row.isDefault === true,
    }))
  // 空表不写缓存：那是「这次没读到」，不是「宿主一个预设都没装」。
  if (rows.length) rosterCache = { at: Date.now(), rows }
  return rosterCache.rows
}

/** 判断时认可的预设 id；roster 没读到时返回 null，调用方退回构建期基线。 */
function rosterModeIds() {
  return rosterCache.rows.length ? rosterCache.rows.map((row) => row.id) : null
}

/**
 * 主路径读不到默认时的第二来源：官方 roster 里 `isDefault === true` 的那一项。
 *
 * 只在 /config 没给值时用，且走同一个带缓存的 readRoster —— 绝不进关键路径。
 */
async function readDefaultFromRoster(ctx) {
  const rows = await readRoster(ctx)
  const hit = rows.find((row) => row.isDefault === true)
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
  // 列 = 内置四列（顺序固定，能力差异表按它排）+ roster 里多出来的自定义预设。
  // 用户建了第五个预设，能力表就该有第五列 —— 0.2.1 及以前只读内置四个，
  // 自定义预设连一行都看不见，等于插件对它的存在装作不知道。
  const baselineIds = PRESET_BASELINE.columns.map((c) => c.id)
  const roster = await readRoster(ctx)
  const extraIds = roster.map((row) => row.id).filter((id) => !baselineIds.includes(id))
  const ids = [...baselineIds, ...extraIds]
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
  const byId = new Map(docs.filter(Boolean).map((doc) => [doc.id, doc]))
  // **内置四列必须全读到**，否则一列都不换：缺列的表会把「不知道」画成「没有」，
  // 而这四列是判断依据。自定义预设是加分项，读不到就少一列，不影响内置结论。
  if (!baselineIds.every((id) => byId.has(id))) return null
  return buildMatrix(ids.filter((id) => byId.has(id)).map((id) => byId.get(id)))
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

/**
 * 模式显示名：词典 → 能力表里的预设自带名字 → id 本身。
 *
 * 三级回落是为自定义预设准备的：词典只覆盖内置四个；用户在设置里把预设改名成
 * 「文档模式」，能力表里读到的就是那个名字，界面应当照它显示，而不是退回一个
 * `doc-writer` 这样的原始 id。
 */
function modeLabel(id, t, matrix) {
  if (typeof id !== 'string' || !id) return ''
  const key = MODE_LABEL_KEYS[id]
  if (key) {
    const value = t(key)
    if (value && value !== key) return value
  }
  const columns = matrix && Array.isArray(matrix.columns) ? matrix.columns : []
  const column = columns.find((item) => item && item.id === id)
  return (column && column.name) || id
}

/** 表头短名：内置四个走词典短名；自定义预设用它的名字（表格只有 380px 宽）。 */
function modeShortLabel(column, t) {
  const key = MODE_SHORT_KEYS[column.id]
  if (key) {
    const value = t(key)
    if (value && value !== key) return value
  }
  return column.name || column.id
}

/**
 * 「输入即显示」的判定本身：纯函数，不碰 DOM、不发请求。
 *
 * 抽出来是为了能直接验 —— 徽标的行为（什么时候出现、什么时候闭嘴）才是这个功能的
 * 全部内容，而渲染桩里的 `useEffect` 是空实现，验不到。放到这里之后，
 * 「与默认相同就不显示」「面板开着就不显示」「拿不准给入口而不是结论」都能一条一条断言。
 *
 * ## 两档，而不是「有或没有」
 *
 * 旧实现只在本地规则**定案**时出徽标，其余一律返回 null。真实说法上量出来的是：
 * 82 条里只有 24 条能定案（29%），53 条 `unknown`（65%）—— 也就是说十次输入里
 * 大约七次工具栏什么都不显示，用户看到的是「这个功能没了」。
 *
 * 现在拿不准时也返回一个 `level: 'ask'` 的入口：不给结论（那会是编的），但告诉
 * 用户「点我就能算」。点击才走完整判断（含模型兜底），所以静止状态下仍然零请求。
 *
 * @param {string} draft 输入框里的草稿
 * @param {{open?: boolean, defaultMode?: string|null, available?: string[], minChars?: number}} [options]
 * @returns {{level: 'decided', mode: string, signal: string, evidence: string[]}
 *   | {level: 'ask', mode: null, signal: string, evidence: string[]}
 *   | null}
 */
export function computeInputHint(draft, options = {}) {
  const text = typeof draft === 'string' ? draft.trim() : ''
  const opts = options && typeof options === 'object' ? options : {}
  const minChars = Number.isFinite(opts.minChars) ? opts.minChars : INPUT_HINT_MIN_CHARS
  // 面板开着时让位给完整结论；草稿太短时闭嘴（半句话在哪个模式下都成立）。
  if (opts.open === true || text.length < minChars) return null
  const available = Array.isArray(opts.available) && opts.available.length
    ? opts.available
    : PRESET_BASELINE.columns.map((column) => column.id)
  const local = recommendByRules(text, { available })
  if (local.kind === 'decided' && local.mode) {
    // 与当前默认相同 = 不用换。这时候「建议：X」是错的，X 本来就是当前模式。
    if (typeof opts.defaultMode === 'string' && opts.defaultMode && local.mode === opts.defaultMode) return null
    return { level: 'decided', mode: local.mode, signal: local.signal, evidence: local.evidence }
  }
  // 拿不准：不给结论，只给一个能点的入口。`signal` 一并带上是为了让反馈里的
  // `hits` 仍然能聚类 —— 「这一类说法本地规则从来判不了」本身就是最有用的信号。
  return {
    level: 'ask',
    mode: null,
    signal: typeof local.signal === 'string' ? local.signal : 'none',
    evidence: Array.isArray(local.evidence) ? local.evidence : [],
  }
}

/**
 * 设置卡的纯视图：只依赖「快照 + 动作 + 词典」，不碰 ctx、不碰 DOM。
 *
 * 抽成纯函数是为了能验 —— 设置页在真机里跑，判据进不去；而这张卡最容易错的地方
 * 恰恰是**读值**：`llmFallback` 读到 `undefined` 时若写成 `Boolean(x)` 就恒真，
 * 用户明明关掉了却显示勾上。所以这里写 `value.llmFallback !== false`
 * （只有明确 false 才不勾），并让判据逐条断这三种情形。
 *
 * @param {object|null} snapshot `configForms` 的快照：{status, value, writable}
 * @param {{set?: (field: string, value: unknown) => void}} actions
 * @param {(key: string) => string} t
 */
export function settingsCardView(snapshot, actions, t) {
  const h = React.createElement
  const text = typeof t === 'function' ? t : fallbackText
  const status = snapshot && typeof snapshot.status === 'string' ? snapshot.status : 'unavailable'
  // 命名空间没被宿主服务（旧宿主 / 行 id 不一致）：明说，而不是画一个改不动的假表单。
  if (status === 'unavailable') {
    return h('p', { className: 'npie-mg-card-note' }, text('settingsUnavailable'))
  }
  const value = snapshot && snapshot.value && typeof snapshot.value === 'object' ? snapshot.value : {}
  const writable = !snapshot || snapshot.writable !== false
  const set = actions && typeof actions.set === 'function' ? actions.set : () => undefined
  const timeout = Number(value.timeoutMs)
  return h('div', { className: 'npie-mg-card', 'data-status': status },
    h('label', { className: 'npie-mg-card-row' },
      h('input', {
        type: 'checkbox',
        checked: value.llmFallback !== false,
        disabled: !writable,
        onChange: (event) => set('llmFallback', event.target.checked === true),
      }),
      h('span', null, text('settingsFallback')),
    ),
    h('label', { className: 'npie-mg-card-row' },
      h('span', null, text('settingsTimeout')),
      h('input', {
        type: 'number',
        min: 1000,
        max: 120000,
        step: 1000,
        value: String(Number.isFinite(timeout) && timeout > 0 ? timeout : 20000),
        disabled: !writable,
        // 越界不写：写进去会让宿主侧 schema 校验失败，用户看到的是「保存没反应」。
        onChange: (event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next) && next >= 1000 && next <= 120000) set('timeoutMs', next)
        },
      }),
    ),
    h('p', { className: 'npie-mg-card-note' }, text('settingsHint')),
  )
}

/**
 * 插件页里「本行」的配置卡。
 *
 * 订阅一次、把快照交给纯视图渲染：字段改了就地重画，不用关页面。
 */
function SettingsCard(props) {
  const t = props.t || fallbackText
  const form = props.form
  const [snapshot, setSnapshot] = React.useState(() => (
    form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : null
  ))
  React.useEffect(() => {
    if (!form || typeof form.subscribe !== 'function') return undefined
    const off = form.subscribe(() => setSnapshot(form.getSnapshot()))
    return () => {
      if (typeof off === 'function') off()
    }
  }, [])
  return settingsCardView(snapshot, {
    set: (field, value) => {
      if (form && typeof form.set === 'function') void form.set(field, value)
    },
  }, t)
}

/**
 * 机会性取 `configForms`。
 *
 * 不写进 `inject`：旧宿主没有这个服务，写进去会让整个浏览器半区 `pending`，
 * 连浮层都不出来 —— 为了一个设置卡把主功能弄没了，是本末倒置。
 */
function settingsForm(ctx) {
  try {
    const forms = ctx && typeof ctx.get === 'function' ? ctx.get('configForms') : null
    if (!forms || typeof forms.get !== 'function') return null
    return forms.get(ROW_ID) || null
  } catch {
    return null
  }
}

/**
 * 按 id 取短名（徽标用）。
 *
 * `modeShortLabel` 要一个能力表列对象，而徽标是在打开面板之前算出来的 —— 那时
 * 能力表可能还没合成（第一次用），也可能只有基线的四列。所以这里按 id 查词典，
 * 查不到再回落到列名，最后才用 id 本身：徽标宁可显示英文 id，也不能空着。
 */
function shortModeLabel(id, t, matrix) {
  if (typeof id !== 'string' || !id) return ''
  const key = MODE_SHORT_KEYS[id]
  if (key) {
    const value = t(key)
    if (value && value !== key) return value
  }
  const columns = matrix && Array.isArray(matrix.columns) ? matrix.columns : []
  const column = columns.find((item) => item && item.id === id)
  return (column && column.name) || modeLabel(id, t, matrix) || id
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
      modeName: (id) => modeLabel(id, t, matrix),
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
  // 反馈：choice 一旦定下就锁住按钮，避免同一结论被反复记成两条相反的意见。
  const [fb, setFb] = React.useState({ choice: null, status: 'idle' })
  // 本机统计：展开时才去宿主取一次，关掉面板就重置，不当常驻轮询。
  const [statsOpen, setStatsOpen] = React.useState(false)
  const [hostStats, setHostStats] = React.useState(null)
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
  /**
   * 输入即显示的建议。null = 没有建议（不显示任何东西）。
   *
   * 只由**本地规则**产生 `kind === 'decided'` 的结论，所以：
   *   - 不花配额、不发网络请求（决定不了就什么都不显示）；
   *   - 与当前默认模式相同就不显示 —— 那等于「不用换」，说它只是噪音。
   */
  const [hint, setHint] = React.useState(null)

  // 这两个 hook 是 selector hook，必须传 (s) => s。详见文件头第 5 条。
  const inputState = typeof props.useInput === 'function' ? props.useInput((s) => s) : undefined
  const draft = inputState && typeof inputState.draft === 'string' ? inputState.draft : ''
  const session = typeof props.useSession === 'function' ? props.useSession((s) => s) : undefined
  // 官方 SessionSnapshot 的身份字段是 id；slot 有时直接给 sessionId。两个都认，
  // 只认一个会让 sessionId 变成 undefined —— 一键应用按钮直接消失或 select 找不到 Agent。
  const sessionId = props.sessionId || (session && (session.sessionId || session.id))
  // 只有空白会话能切换预设：agentPresets.select 对已开始的会话会拒绝。
  const canApply = Boolean(sessionId) && Boolean(session && session.blank === true)

  /**
   * 输入即显示：草稿停手 500ms 判一次，只走本地规则。
   *
   * 依赖里必须有 `open`：面板一开，徽标就得让位给完整结论，否则同一个按钮上
   * 出现两处说法。也不能在草稿为空时留着上一次的徽标 —— 用户可能刚把字删光。
   *
   * 判定只用 `rosterModeIds() || 基线列`：与正式判断同源，避免「徽标说创造、
   * 打开之后说标准」这种自相矛盾。
   */
  const hintDelay = typeof props.hintDelayMs === 'number' ? props.hintDelayMs : INPUT_HINT_DEBOUNCE_MS
  React.useEffect(() => {
    const text = draft.trim()
    if (open || text.length < INPUT_HINT_MIN_CHARS) {
      setHint(null)
      return undefined
    }
    const timer = setTimeout(() => {
      const available = rosterModeIds() || PRESET_BASELINE.columns.map((column) => column.id)
      const next = computeInputHint(draft, { open, defaultMode: currentDefaultMode(), available })
      if (!next) {
        setHint(null)
        return
      }
      // 比较 level 与 mode 两个字段：只比 mode 时 'ask'（mode 为 null）会被
      // 判定成「和上次一样」，于是从「建议：创造」切到「拿不准」时徽标不更新。
      setHint((prev) => (
        prev && prev.level === next.level && prev.mode === next.mode ? prev : { level: next.level, mode: next.mode }
      ))
    }, hintDelay)
    return () => clearTimeout(timer)
  }, [draft, open, defaultMode, hintDelay])

  const openSheet = () => {
    const seed = input.trim() ? input : draft
    setInput(seed)
    setTip(false)
    setOpen(true)
    // 有徽标 = 用户已经表达过「我要判断」这件事，展开时直接把结论画出来，
    // 不用再点一次「判断」。两档都自动判：
    //   - decided：本地已定案（模型兜底也可能被叫到，但结论就在眼前）；
    //   - ask：「判断」两个字本身就是用户点下来的动作，点了就该算。
    // 反过来说，**没徽标就不会自动判** —— 打开看一眼不会白发一次模型请求。
    if (hint && seed.trim()) void runJudge(seed)
  }
  const close = () => {
    judgeSeq.current += 1 // 作废在飞的判断，避免关闭后再 setState
    setOpen(false)
  }

  /**
   * 键盘关闭（Esc / ×）时把焦点还给触发按钮。
   *
   * 点浮层外面关闭时**不还**：用户已经点到别处去了，抢回来只会让焦点乱跳。
   */
  const closeAndRestore = () => {
    close()
    const el = anchorRef.current
    if (el && typeof el.focus === 'function') el.focus()
  }

  /**
   * 浮层内可 Tab 到的元素。选择器覆盖原生控件与显式 tabindex，
   * 并跳过 `disabled` —— 否则焦点会停在点不动的按钮上，看起来像界面卡住了。
   */
  const focusablesIn = (root) => {
    if (!root || typeof root.querySelectorAll !== 'function') return []
    const selector = 'button:not([disabled]),[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
    const nodes = root.querySelectorAll(selector)
    return nodes && typeof nodes.length === 'number' ? Array.prototype.slice.call(nodes) : []
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
        closeAndRestore()
        return
      }
      // aria-modal 声明了「焦点在浮层里」，就必须真的把 Tab 关在里面：
      // 只写 aria-modal 不拦 Tab，读屏用户还是会 Tab 到背后的工具栏。
      if (event.key !== 'Tab') return
      const nodes = focusablesIn(popRef.current)
      if (!nodes.length) return
      const active = typeof document !== 'undefined' ? document.activeElement : null
      const at = nodes.indexOf(active)
      const last = nodes.length - 1
      if (event.shiftKey) {
        if (at <= 0) {
          event.preventDefault()
          if (typeof nodes[last].focus === 'function') nodes[last].focus()
        }
      } else if (at === -1 || at === last) {
        event.preventDefault()
        if (typeof nodes[0].focus === 'function') nodes[0].focus()
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
  const runJudge = async (override) => {
    const text = (typeof override === 'string' ? override : input).trim()
    if (!text) return
    const seq = ++judgeSeq.current
    setApplyNote(null)
    judgedTextRef.current = text
    // 新结论 = 新的反馈对象：上一次的 👍/👎 不该挂在这一条上。
    setFb({ choice: null, status: 'idle' })
    sessionCounts.judged += 1
    // 同一句话可能先由规则定案、再被模型复核改写（source 从 rules 变 llm）。
    // 统计要算「最后是谁定的」，所以换来源时把上一条减掉，不重复计。
    let counted = null
    const noteSource = (source) => {
      if (counted && sessionCounts[counted] !== undefined) sessionCounts[counted] -= 1
      counted = source
      if (sessionCounts[source] !== undefined) sessionCounts[source] += 1
    }

    const baseline = PRESET_BASELINE
    // 认可的模式 = 宿主实际装了的（roster）；还没读到才退回构建期四列。
    // 用户删掉某个内置预设之后，规则不该继续推荐它 —— 那样「切到这个模式」必失败，
    // 而失败原因看起来像插件坏了，其实是它推荐了一个不存在的模式。
    const available = rosterModeIds() || baseline.columns.map((c) => c.id)
    const local = recommendByRules(text, { available })
    matrixRef.current = baseline
    const shownDefault = defaultMode
    const first = composeVerdict(local, null, shownDefault)
    noteSource(first.source)
    setState({
      verdict: withWhy(first, text, baseline, t, shownDefault),
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
    const finalVerdict = composeVerdict(local, llm, freshDefault)
    noteSource(finalVerdict.source)
    setState((prev) => ({
      ...prev,
      busy: '',
      verdict: withWhy(finalVerdict, text, matrixRef.current, t, freshDefault),
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

  /**
   * 👍/👎：把「这句话被判成什么」记到本机 JSONL。
   *
   * 只发这一条记录，不带任何设备/账号信息；宿主写不进文件就回 ok:false，
   * 界面说「没记上」，不假装记过了 —— 假装的反馈闭环比没有更糟。
   */
  const sendFeedback = async (thumb) => {
    const current = state.verdict
    if (!current || fb.choice || fb.status === 'sending') return
    setFb({ choice: thumb, status: 'sending' })
    try {
      const res = await fetch(FEEDBACK_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          thumb,
          input: judgedTextRef.current,
          mode: current.mode,
          source: current.source,
          signal: current.local && current.local.signal ? current.local.signal : null,
          // 命中的原词：错例聚类唯一的抓手。没有它，`--cluster` 只能说「又错了 3 次」，
          // 说不出「这 3 次都是被同一个『插件』带跑的」—— 而后者才是能改的东西。
          hits: current.local && Array.isArray(current.local.evidence) ? current.local.evidence.slice(0, 6) : [],
          defaultMode: currentDefaultMode(),
          lang: uiLang(t),
        }),
      })
      const data = res.ok ? await res.json() : null
      setFb({ choice: thumb, status: data && data.ok ? 'done' : 'failed' })
    } catch {
      setFb({ choice: thumb, status: 'failed' })
    }
  }

  /** 展开统计时才读宿主计数：它变化很快，没必要跟着轮询。 */
  const loadStats = async () => {
    const { signal, cancel } = abortAfter(CONFIG_TIMEOUT_MS)
    try {
      const res = await fetch(STATS_PATH, { cache: 'no-store', signal })
      if (!res.ok) return
      const data = await res.json()
      if (data && data.ok && data.stats) setHostStats(data.stats)
    } catch {
      // 读不到就显示客户端那一半，不编数字
    } finally {
      cancel()
    }
  }

  const verdict = state.verdict
  const matrix = state.matrix

  // 徽标两档：定案时说结论，拿不准时只给一个可点的入口（不编结论）。
  // 文字取词典而不是写死：`askHint` 在英文里是 "Judge"，直接拼英文单词会漏翻译。
  const hintLabel = hint && hint.level === 'decided' ? shortModeLabel(hint.mode, t, matrixRef.current) : ''
  const badgeText = hint
    ? (hint.level === 'decided' ? t('suggestPrefix') + hintLabel : t('askHint'))
    : ''
  const badge = hint && !open
    ? h('span', { className: 'npie-mg-badge', 'data-level': hint.level, 'data-mode': hint.mode || undefined }, badgeText)
    : null

  // 读屏用户听到的必须是同一件事：定案时念结论，拿不准时念「点了才算」。
  const triggerAria = hint && hint.level === 'decided'
    ? `${t('suggestPrefix')}${hintLabel}，${t('triggerAria')}`
    : hint
      ? `${t('askHint')}，${t('triggerAria')}`
      : t('triggerAria')

  const trigger = h('button', {
    type: 'button',
    ref: anchorRef,
    className: 'npie-mg-trigger',
    'data-armed': String(open),
    'data-hint': String(Boolean(badge)),
    'data-level': hint ? hint.level : undefined,
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    // 徽标是视觉信息，读屏用户只能听到 aria-label：不带进来说等于没做这个功能。
    'aria-label': triggerAria,
    onMouseEnter: showTip,
    onMouseLeave: () => setTip(false),
    onFocus: showTip,
    onBlur: () => setTip(false),
    onClick: () => (open ? close() : openSheet()),
  }, h(ModeIcon, { size: 18 }), badge)

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
    'aria-modal': 'true',
    'aria-label': t('sheetTitle'),
    tabIndex: -1,
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
    h('button', { type: 'button', className: 'npie-mg-close', 'aria-label': t('close'), onClick: closeAndRestore }, '×'),
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
          h('span', { className: 'npie-mg-mode' }, modeLabel(verdict.mode, t, matrix) || verdict.mode),
          verdict.source === 'llm' ? h('span', { className: 'npie-mg-source' }, t('byLlm')) : null,
          verdict.source === 'rules' ? h('span', { className: 'npie-mg-source' }, t('byRules')) : null,
          verdict.source === 'default'
            ? h('span', { className: 'npie-mg-source' }, defaultKnown
                ? t('byDefault') + (modeLabel(defaultMode, t, matrix) || defaultMode)
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
        // 反馈行：报告里「唯一的信号是用户有没有点按钮，这不叫信号」——
        // 两个按钮各写清「对/不对」，落一条本机记录，绝不联网。
        h('div', { className: 'npie-mg-fb' },
          h('span', { className: 'npie-mg-fb-ask' }, t('feedbackAsk')),
          h('button', {
            type: 'button',
            className: 'npie-mg-fb-btn',
            'aria-pressed': String(fb.choice === 'up'),
            'data-chosen': String(fb.choice === 'up'),
            disabled: fb.status === 'sending' || Boolean(fb.choice),
            onClick: () => void sendFeedback('up'),
          }, t('feedbackUp')),
          h('button', {
            type: 'button',
            className: 'npie-mg-fb-btn',
            'aria-pressed': String(fb.choice === 'down'),
            'data-chosen': String(fb.choice === 'down'),
            disabled: fb.status === 'sending' || Boolean(fb.choice),
            onClick: () => void sendFeedback('down'),
          }, t('feedbackDown')),
          fb.status === 'done'
            ? h('span', { className: 'npie-mg-fb-note', role: 'status' }, t('feedbackThanks'))
            : null,
          fb.status === 'failed'
            ? h('span', { className: 'npie-mg-fb-note', 'data-tone': 'warn', role: 'status' }, t('feedbackFailed'))
            : null,
        ),
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
                    matrix.columns.map((c) => h('th', { key: c.id }, modeShortLabel(c, t))),
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

    // 本机统计：默认收起 —— 它是给「为什么这次判错」用的，不是日常要看的东西。
    // 左边是客户端会话内计数（谁定的案），右边是宿主计数器（花了多少、被限流几次）。
    h('div', null,
      h('button', {
        type: 'button',
        className: 'npie-mg-disclosure',
        'aria-expanded': String(statsOpen),
        onClick: () => {
          const next = !statsOpen
          setStatsOpen(next)
          if (next) void loadStats()
        },
      }, t(statsOpen ? 'statsHide' : 'statsShow')),
      statsOpen
        ? h('div', { className: 'npie-mg-stats' },
            h('ul', null,
              [
                // 总数要画出来，否则「规则 + 模型定案 + 留在默认」三项之和与总数之间的关系
                // 在界面上无法核对 —— 而那正是「来源切换先减后加」唯一能被发现的破绽。
                [t('statsJudged'), sessionCounts.judged],
                [t('statsRule'), sessionCounts.rules],
                [t('statsModel'), sessionCounts.llm],
                [t('statsDefault'), sessionCounts.default],
              ].map(([label, value]) => h('li', { key: label },
                h('span', null, label), h('b', null, String(value)))),
            ),
            hostStats
              ? h('ul', null,
                  [
                    // 累计侧只有宿主自己的总数（judge），没有按来源拆分 —— 拆分是
                    // 客户端本会话的视角，两者不能混在同一列里。
                    [t('statsJudged'), hostStats.judge || 0],
                    [t('statsCalls'), hostStats.model],
                    [t('statsCache'), hostStats.cacheHit],
                    [t('statsLimited'), hostStats.limited],
                    // null = 一次模型请求都没发过，画「—」而不是「0ms」：0ms 在界面上
                    // 读起来像「问过、很快」，和「没问过」是两件事。
                    [t('statsAvg'), hostStats.avgModelMs == null ? '—' : hostStats.avgModelMs + 'ms'],
                    [t('statsFeedback'), (hostStats.feedbackUp || 0) + ' / ' + (hostStats.feedbackDown || 0)],
                  ].map(([label, value]) => h('li', { key: label },
                    h('span', null, label), h('b', null, String(value)))),
                )
              : h('p', { className: 'npie-mg-legend' }, t('statsUnavailable')),
          )
        : null,
    ),
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
  // 能力表合成与预设名回落也挂出来：任意预设这条路只有真调一次才验得准，
  // 静态断言只能证明「写了 readRoster」，证明不了第五列真的出现。
  refineMatrix,
  readRoster,
  modeLabel,
  // 输入即显示：徽标的判定是纯函数，判据直接验它的四个边界。
  computeInputHint,
  shortModeLabel,
  INPUT_HINT_MIN_CHARS,
  // 设置卡：视图是纯函数，判据验「读值不恒真 / 不可写不假扮可写」。
  settingsCardView,
  ROW_CONFIG_KEY,
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

    /**
     * 设置卡：挂到插件页「本行」的配置位。
     *
     * slot 名与 key 都是契约：`plugins.row.config` 没被声明时回调**根本不执行**
     * （不报错），key 与行 id 不一致时卡片静默不出现。所以两处都写成常量并挂出来，
     * 判据可以直接比对它们与 `cordis.patch.yml` 的 id 是否一致。
     */
    ctx.effect(() => {
      if (typeof ctx.slots.inject !== 'function') return undefined
      const off = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_CONFIG_KEY,
        locale: PKG,
      }, (cardProps) => React.createElement(SettingsCard, { ...cardProps, t, form: settingsForm(ctx) })))
      return () => {
        if (typeof off === 'function') off()
      }
    }, 'dsh-npie-modeguide: settings card')
  },
}
