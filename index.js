/**
 * dsh-npie-modeguide — 宿主半区。
 *
 * 只做一件事：**本地规则拿不准时，代客户端问一次模型判该用哪个模式**。
 *
 * 为什么这一段必须放在宿主：
 *   - 模型的 provider / 密钥 / 余额都由宿主统一管（「设置 → 模型」），浏览器半区
 *     拿不到；自己 fetch 就等于让插件再管一份密钥。
 *   - `ctx.llm.stream` 是宿主服务，浏览器侧没有。
 *
 * 三条纪律（AGENTS.md 的服务三定律），这里逐条守住：
 *   1. `webServer` 走 `ctx.inject(['webServer'], ...)` —— 不是可选服务，缺了这插件
 *      确实没法工作，该等就等。
 *   2. `llm` / `agentDefaultModel` 是**可选**服务：绝不写进 inject，也不写
 *      `ctx.llm`（属性代理会抛，`?.` 拦不住）。只走 `ctx.reflect.get(name, false)`。
 *      llm 缺席时这条路直接回 501，客户端退回本地规则 —— 功能降级，不是故障。
 *   3. 不替用户选预设：切换仍由客户端走 Remote 的 `select()` 做。宿主只**读**
 *      `agentPresets.defaultId`（用户在「设置 → Agent 预设」里选的新任务默认），
 *      经 /config 下发给浏览器半区；不重写一遍「谁是默认」的判定。
 *   4. 不自己写鉴权：两条路由的受理判定复用宿主 `connection.requestRejection()`
 *      （Host/Origin 栅栏 + 签名 cookie 校验），只在它缺席时才退回本地轻判据。
 *
 * 关于「为什么不用 tool」：这个插件不注册模型可见工具。选模式是用户自己的决定，
 * 不该被模型看见、更不该被模型改。所以整条链路对人类可见、对模型不可见。
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
// 提示词构造与 LLM 输出解析只有这一份。宿主与浏览器半区共用，避免两边各写一遍后漂移：
// 测试测的是这一份，实际跑的也必须是这一份。
import { buildLlmPrompt, parseLlmVerdict, PROMPT_VERSION } from './src/recommender.js'
// 白名单只有这一份：浏览器半区构建时内联同一个文件，两处不许各写一遍。
// 宿主只关心形状（自定义预设也合法），「是不是内置四个」由规则引擎与词典使用。
import { isModeId } from './src/presets.js'
import z from '@deepseek-ai/schemastery'

/**
 * 插件配置的 schema（0.2.3 新增）。
 *
 * 为什么要有它：宿主只把**标了 `.volatile()` 的字段**投影成设置命名空间
 * （`projectForm` 返回 undefined 时 `describe()` 整条丢弃）。没有 schema 的插件
 * 在设置页里根本不存在 —— 用户只能手改 `cordis.patch.yml`，改完还得重启。
 *
 * 标 `.volatile()` 还带来第二个好处：新值**原地提交进正在运行的 fiber**
 * （`config.llmFallback` 变成可 `.get()` 的引用对象），所以设置页改完立刻生效，
 * 不用重启。代价是 apply 里不能裸读——`normalizeConfig` 已经统一解包。
 *
 * 行 id（`npie-modeguide`）就是命名空间，客户端用 `configForms.get('npie-modeguide')`
 * 拿到的就是这张表单；改 id 必须同时改客户端。
 */
export const Config = z.object({
  /** 本地规则拿不准时，是否调一次模型兜底。关掉后行为完全离线。 */
  llmFallback: z.boolean().default(true).volatile(),
  /** 单次判定超时（毫秒）。超时退回本地建议，不让界面一直转圈。 */
  timeoutMs: z.number().default(20000).volatile(),
  /** 调模型时用的 provider / model。留空 = 跟随「设置 → 模型」的默认模型。 */
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
})

/** 判定路由。客户端 POST 这里。 */
export const JUDGE_PATH = '/api/npie-modeguide/judge'

/** 读配置的路由（客户端 `apply` 拿不到 config，见下）。 */
export const CONFIG_PATH = '/api/npie-modeguide/config'

/** 反馈落盘的路由（👍/👎）。只写本机文件，不联网、不发遥测。 */
export const FEEDBACK_PATH = '/api/npie-modeguide/feedback'

/** 本机统计的路由（计数器在宿主内存里，重载插件即清零）。 */
export const STATS_PATH = '/api/npie-modeguide/stats'

/**
 * 反馈文件的位置与上限。
 *
 * 为什么放 profile 目录：那是宿主自己的可写数据目录（`DSH_PROFILE_DIR`），
 * 卸载插件不会顺手删掉用户的反馈，也不该写进插件包目录（只读安装位置）。
 *
 * 为什么要有上限：这是一份**只追加**的文件，长期使用会无限长；到 5 MB 就滚一份
 * `feedback.1.jsonl`（只保留一代）。不滚动的话，`npm run stats` 会越来越慢，
 * 最后变成「统计命令跑不动、于是没人用」。
 */
export const FEEDBACK_LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, maxInputChars: 500 })

/** 反馈与统计的文件名（目录由 profile 决定）。 */
const FEEDBACK_DIR = 'npie-modeguide'
const FEEDBACK_FILE = 'feedback.jsonl'

/**
 * 模型兜底的配额。**唯一来源**：宿主按它限流，/config 也按它下发，界面文案再从
 * 下发值算「约 X 秒后可再问」—— 三个地方不许各写一个数字。
 *
 *   容量 5 次突发 → 之后每 20 秒补 1 次（约 3 次/分钟持续）
 *
 * 为什么是令牌桶而不是「每分钟 N 次」：正常使用是「偶尔一句歧义描述」，突发几次
 * 都该放行；怕的是连点。桶既能放行突发，又能在持续连点时把人挡住。
 */
export const JUDGE_LIMITS = Object.freeze({
  capacity: 5,
  refillMs: 20000,
  // 同一句描述 5 分钟内复用上次结论：连点同一条不重复烧 token。
  cacheMs: 5 * 60 * 1000,
  cacheSize: 8,
})

/**
 * 令牌桶。
 * @param {{capacity?: number, refillMs?: number}} [limits]
 * @param {() => number} [now] - 注入时钟，判据里才能不真等 20 秒。
 * @returns {{take: () => {ok: boolean, remaining?: number, retryAfterMs?: number}, refund: () => void}}
 */
export function createTokenBucket(limits = JUDGE_LIMITS, now = () => Date.now()) {
  const capacity = Math.max(1, Number(limits?.capacity) || JUDGE_LIMITS.capacity)
  const refillMs = Math.max(1000, Number(limits?.refillMs) || JUDGE_LIMITS.refillMs)
  let tokens = capacity
  let stamp = now()
  const refill = (at) => {
    const elapsed = Math.max(0, at - stamp)
    stamp = at
    tokens = Math.min(capacity, tokens + elapsed / refillMs)
  }
  return {
    take() {
      refill(now())
      if (tokens >= 1) {
        tokens -= 1
        return { ok: true, remaining: Math.floor(tokens) }
      }
      // 还差多少才够一次：向上取整，界面说「约 X 秒」就不会说成 0 秒。
      return { ok: false, retryAfterMs: Math.ceil((1 - tokens) * refillMs) }
    },
    /**
     * 退回一次配额。只给「模型根本没被调用」用（未配置模型 / llm 服务缺席）：
     * 那种情况没花钱，却让用户看到「问得太频繁」是错的。
     */
    refund() {
      refill(now())
      tokens = Math.min(capacity, tokens + 1)
    },
  }
}

/**
 * 判定结果短时缓存（LRU + TTL）。
 *
 * 缓存只解决「同一句话反复点」，不替代配额：不同输入仍然各花一次模型调用。
 * key 里带上能力表，因为表变了结论的依据就变了，旧结论不能冒充新表的结果。
 *
 * @param {{cacheMs?: number, cacheSize?: number}} [limits]
 * @param {() => number} [now]
 */
export function createVerdictCache(limits = JUDGE_LIMITS, now = () => Date.now()) {
  const ttlMs = Math.max(1000, Number(limits?.cacheMs) || JUDGE_LIMITS.cacheMs)
  const max = Math.max(1, Number(limits?.cacheSize) || JUDGE_LIMITS.cacheSize)
  const entries = new Map()
  return {
    get(key) {
      const hit = entries.get(key)
      if (!hit) return null
      if (hit.expiresAt <= now()) {
        entries.delete(key)
        return null
      }
      // 命中即续位：淘汰时先丢最久没用过的，而不是最早写进来的。
      entries.delete(key)
      entries.set(key, hit)
      return hit.verdict
    },
    set(key, verdict) {
      entries.delete(key)
      entries.set(key, { verdict, expiresAt: now() + ttlMs })
      while (entries.size > max) entries.delete(entries.keys().next().value)
    },
  }
}

/**
 * 缓存 key：输入 + 能力表 + **新任务默认模式** + 提示词版本。
 *
 * 为什么要带默认模式：提示词里写着「需求不明确就选 X」，所以默认模式是**决策
 * 前提**，不是背景信息。0.1.11 的 key 只有文本与能力表，于是「改成标准模式之后
 * 再问同一句话」会命中按 PTC 算出来的旧结论 —— 结论看起来正常，前提已经换了一个。
 *
 * 为什么要带提示词版本：改了规则语义（比如这次加了反向词表）以后，旧缓存里的
 * 结论是新逻辑永远不会给出的，却在 5 分钟内继续被当成「模型刚判的」。
 *
 * @param {string} input
 * @param matrix
 * @param {string|null} defaultMode
 * @returns {string}
 */
function judgeCacheKey(input, matrix, defaultMode) {
  const parts = [PROMPT_VERSION, defaultMode || '-', input]
  try {
    parts.push(JSON.stringify(matrix ?? null))
  } catch {
    // 序列化失败（body 是 JSON.parse 出来的，理论上不该发生）：按「没有能力表」
    // 处理。绝不能退化成「只用文本」的 key —— 那会让前提不同的请求撞在一起。
    parts.push('-')
  }
  return createHash('sha1').update(parts.join('\u0000')).digest('hex')
}

/**
 * 第二来源：直接读宿主自己持久化的 profile patch。
 *
 * 「设置 → Agent 预设」改的新任务默认会落到 `cordis.patch.yml` 的
 * `agent-preset-registry` 行（`default` + `selectedDefault`）。这是宿主已有的数据，
 * 插件只是读，不重写一份判定。用 `DSH_PROFILE_DIR`（宿主注入的环境变量）定位，
 * 每次现读，所以改完设置下一次请求就是新值。
 *
 * 不引 YAML 依赖：只按块取两个标量字段，块外一律不看。解析不出来返回 null，
 * 由客户端的官方 roster 再兜一层。
 *
 * 读盘加了 mtime + size 缓存：界面每 4 秒复查一次默认，而这份文件只有几百字节。
 * 缓存键带上 mtime 与字节数，文件一变就必然重读，因此不会读到旧值；命中时省掉的
 * 只是「每次都同步读一次盘」。
 *
 * @param {string} profileDir - profile 目录；传 null 可禁用这条来源（判据用）。
 * @returns {string|null}
 */
export function readDefaultFromProfile(profileDir) {
  if (typeof profileDir !== 'string' || !profileDir) return null
  const file = join(profileDir, 'cordis.patch.yml')
  let stat
  try {
    stat = statSync(file)
  } catch {
    return null
  }
  const stamp = `${file}\u0000${stat.mtimeMs}\u0000${stat.size}`
  if (profileCache && profileCache.stamp === stamp) return profileCache.id
  let id = null
  try {
    id = parseDefaultFromPatch(readFileSync(file, 'utf8'))
  } catch {
    id = null
  }
  profileCache = { stamp, id }
  return id
}

/** 最近一次 profile 解析结果。只缓存一个文件，插件里也只有这一个 profile。 */
let profileCache = null

/**
 * 纯解析，导出给判据直接验（不需要真去读用户的 profile）。
 * @param {string} text - cordis.patch.yml 全文。
 * @returns {string|null}
 */
export function parseDefaultFromPatch(text) {
  if (typeof text !== 'string') return null
  let inBlock = false
  let selected = null
  let deployed = null
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*-\s*id:\s*agent-preset-registry\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (inBlock && /^\s*-\s*id:\s*/.test(line)) break
    if (!inBlock) continue
    const match = /^\s+(selectedDefault|default):\s*([^\s#]+)\s*$/.exec(line)
    if (!match) continue
    const value = match[2].replace(/^['"]|['"]$/g, '')
    if (match[1] === 'selectedDefault') selected = value
    else deployed = value
  }
  const id = selected || deployed
  // 自定义预设也要认：这里只校验形状，不校验「是不是内置四个」——
  // 用户在自己机器上建了 `doc-writer` 并设成默认，插件却报「未读到默认」，
  // 那是插件的错，不是用户的。是否真的存在由 roster（agentPresets.list）确认。
  return isModeId(id) ? id : null
}

/**
 * 现读宿主给新任务选的默认模式。
 *
 * 宿主 `AgentPresetRegistry.defaultId` 是同步 getter：
 *   `config.selectedDefault.get() ?? config.default`
 * 前者是用户在「设置 → Agent 预设」里改的 volatile 值，后者是部署默认。这是**唯一**
 * 权威口径，插件不自己推、不缓存。
 *
 * 为什么用 reflect 而不是 inject：agentPresets 依赖 loader/sessionProjections/agents，
 * 把它写进本插件的 inject 会让插件在预设注册表就绪前一直 pending；而读不到默认只是
 * 降级（界面会诚实标「内置兜底」），不该拖住整个插件。
 *
 * 两层来源：运行时 service（最实时）→ profile patch 文件（持久化的同一份数据）。
 * 都拿不到返回 null，客户端还有官方 roster 的 `isDefault` 兜底，但界面会标「未读到」，
 * 绝不把内置 ptc 冒充成用户的选择。
 *
 * @param ctx - 宿主上下文。
 * @param {string} [profileDir] - profile 目录；默认取宿主注入的 DSH_PROFILE_DIR。
 * @returns {string|null} 可信的默认模式 id；读不到返回 null，绝不猜。
 */
export function readDefaultMode(ctx, profileDir = process.env.DSH_PROFILE_DIR) {
  let service = null
  try {
    service = ctx?.reflect?.get?.('agentPresets', false)
  } catch {
    service = null
  }
  let id
  try {
    id = service && typeof service === 'object' ? service.defaultId : undefined
  } catch {
    id = undefined
  }
  // 内置与自定义一视同仁：宿主 registry 给的 `defaultId` 就是权威值，
  // 插件只校验形状（见 src/presets.js 的 isModeId），不替用户否掉他自己的预设。
  if (isModeId(id)) return id
  return readDefaultFromProfile(profileDir)
}

/**
 * 浏览器半区的 `apply(ctx, config)` **拿不到 config**：客户端加载器建入口时只传
 * `{ name: id }`，启动清单里也没有 config 字段。所以配置必须绕 HTTP 让宿主现读。
 *
 * @param config - 宿主侧的行配置。
 * @param ctx - 宿主上下文，用来现读用户选的新任务默认模式。
 * @returns 归一后的纯配置。defaultMode 为 null 表示没读到，客户端会诚实标注兜底。
 */
export function normalizeConfig(config, ctx) {
  const src = config ?? {}
  // `.volatile()` 字段在 apply 里是 `{ get(), [Symbol.for(...)] }` 而不是值 ——
  // 裸读拿到对象、对象恒真，`=== false` 永不成立。统一解包。
  const read = (key) => {
    const value = src[key]
    if (typeof value === 'object' && value !== null && typeof value.get === 'function') {
      try {
        return value.get()
      } catch {
        return undefined
      }
    }
    return value
  }
  const timeout = Number(read('timeoutMs'))
  return {
    // 默认开启：这是用户选了「本地规则 + 不确定时调 LLM」的方案。
    llmFallback: read('llmFallback') !== false,
    provider: typeof read('provider') === 'string' ? read('provider').trim() : '',
    model: typeof read('model') === 'string' ? read('model').trim() : '',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(120000, timeout) : 20000,
    // 每次请求现读：用户在设置页改了默认，下一次 /config 或 /judge 立刻跟着变。
    defaultMode: readDefaultMode(ctx),
  }
}

/**
 * 反馈文件路径。没有 profile 目录（比如纯 CLI 环境）时返回 null ——
 * 那种环境不该假装记录成功。
 * @param {string|undefined} profileDir
 * @returns {string|null}
 */
export function feedbackFilePath(profileDir) {
  if (typeof profileDir !== 'string' || !profileDir) return null
  return join(profileDir, FEEDBACK_DIR, FEEDBACK_FILE)
}

/**
 * 校验并归一一条反馈。**只收白名单字段**：请求体来自浏览器，可能被手工构造。
 *
 * 为什么要留 `input`：只有知道「哪句话被判成什么」才能改进规则；但它是用户
 * 原文，所以截到 500 字并且只留在**本机文件**里，绝不上报。
 *
 * @param {unknown} raw
 * @param {() => string} [now]
 * @returns {object|null} 非法输入返回 null
 */
export function normalizeFeedback(raw, now = () => new Date().toISOString()) {
  /** 请求体来源不可信：只按白名单字段取值，多余字段一律丢弃。 */
  const body = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' ? raw : {})
  const thumb = body.thumb === 'up' ? 'up' : body.thumb === 'down' ? 'down' : null
  if (!thumb) return null
  /**
   * @param {unknown} value
   * @param {number} max
   * @returns {string}
   */
  const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const rawSource = typeof body.source === 'string' ? body.source : ''
  const source = ['rules', 'llm', 'default'].includes(rawSource) ? rawSource : null
  return {
    at: now(),
    thumb,
    mode: str(body.mode, 64) || null,
    source,
    signal: str(body.signal, 24) || null,
    defaultMode: str(body.defaultMode, 64) || null,
    // 命中的原词：错例聚类靠它把「又错了」变成「又被同一个词带跑了」。
    // 只收字符串、只留 6 个、每个最多 24 字 —— 客户端是浏览器，请求体不可信。
    hits: Array.isArray(body.hits)
      ? body.hits.filter((w) => typeof w === 'string' && w.trim()).slice(0, 6).map((w) => w.trim().slice(0, 24))
      : [],
    lang: body.lang === 'en' ? 'en' : 'zh',
    // 规则/提示词版本：没有它，三个月后没人能分清这条反馈是哪套规则下产生的。
    ruleVersion: PROMPT_VERSION,
    input: str(body.input, FEEDBACK_LIMITS.maxInputChars),
  }
}

/**
 * 追加一条反馈到本机 JSONL。**不抛** —— 反馈失败不该让界面报错。
 *
 * 滚动策略：超 5 MB 就把当前文件改名成 `feedback.1.jsonl`（只保留一代）。
 * 这是一份只追加的文件，不滚动的话长期使用会无限长，`npm run stats` 也越来越慢。
 *
 * @param {object} record
 * @param {string|undefined} profileDir
 * @param {{maxBytes?: number}} [limits]
 * @returns {{ok: boolean, error?: string}}
 */
export function appendFeedback(record, profileDir, limits = FEEDBACK_LIMITS) {
  const file = feedbackFilePath(profileDir)
  if (!file) return { ok: false, error: 'no-storage' }
  try {
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > (limits.maxBytes || FEEDBACK_LIMITS.maxBytes)) {
        renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'))
      }
    } catch {
      // 文件还不存在 / 改名失败：继续往下写，丢记录比留不下更糟。
    }
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
    return { ok: true }
  } catch {
    return { ok: false, error: 'write-failed' }
  }
}

/**
 * 读请求体，超限截断。
 * @param req - node:http 请求。
 * @param limit - 字节上限。
 * @returns {Promise<string>}
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    // 请求体流也可能不结束。到点按空串处理 → 下游 JSON.parse 失败 → 400，
    // 而不是让这个连接永远挂住。
    const timer = setTimeout(() => done(''), 5000)
    const finish = (value) => { clearTimeout(timer); done(value) }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(''))
  })
}

/**
 * 这个请求该不该受理。
 *
 * **不自己判「有 cookie 就算自己人」。** 宿主 `client-connection` 已经有一份完整的
 * admission：Host/Origin 栅栏（防 DNS rebinding）+ 用本机签名密钥校验的
 * `dsh-auth-*` cookie（`BrowserAuth.authenticate` 会解签、核对 authority、校验
 * 有效期）。插件直接复用 `requestRejection(req)`，不重写第二套判定 —— 两套必然
 * 漂移，而「cookie 长度 ≥ 16」这种弱判据本机任何进程随手就能伪造。
 *
 * 桌面端渲染层跑在 `dsh-app://app`，主进程转发到宿主端口时会删掉 origin 头，
 * 所以宿主的栅栏在这条链路上靠 Host 落在 loopback 通过、cookie 负责认证。
 *
 * service 缺席（宿主改了服务名/未挂 connection）时退回本地轻判据，并**明确知道
 * 它弱**：只挡跨站与明显伪造，挡不住拿到同一 cookie 的本机进程。宁可降级可用，
 * 也不因为一次宿主改名把功能锁死；降级路径本身有判据盯着（见 test）。
 *
 * @param ctx - 宿主上下文。
 * @param req - node:http 请求。
 * @returns {401|403|null} 拒绝码；null 表示放行。
 */
export function authorizeRequest(ctx, req) {
  const service = readService(ctx, 'connection')
  if (service && typeof service.requestRejection === 'function') {
    try {
      const rejection = service.requestRejection(req)
      // 契约是 `401 | 403 | undefined`。只认「明确没拒绝」才放行：将来宿主返回
      // 别的非空值（改成 500、改成对象）也必须挡下来，否则一次上游改动就等于开门。
      if (rejection === undefined || rejection === null) return null
      return rejection === 401 || rejection === 403 ? rejection : 403
    } catch {
      // 宿主内部异常不许降级成 200：那等于把鉴权失败变成放行。
      return 401
    }
  }
  return looksLikeHostPage(req) ? null : 403
}

/**
 * 软取一个可选宿主服务。`reflect.get(name, false)` 缺席时返回 undefined 而不是抛。
 * @param ctx
 * @param name
 * @returns {any}
 */
function readService(ctx, name) {
  try {
    return ctx?.reflect?.get?.(name, false)
  } catch {
    return undefined
  }
}

/** loopback 字面量：v4 / v6 / v4-mapped。 */
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/

/**
 * 降级判据：像不像宿主页面自己发的请求。
 *
 * 三条都要满足 —— 不带 `sec-fetch-site: cross-site`、`origin` 为空或就是桌面端、
 * cookie 里真有宿主签发的 `dsh-auth-*`。socket 地址存在时还必须是 loopback
 * （挡住同一网段的其它机器；地址取不到就不额外拦，避免把正常链路误杀）。
 *
 * @param req
 * @returns {boolean}
 */
function looksLikeHostPage(req) {
  const headers = req?.headers ?? {}
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'dsh-app://app') return false
  const address = req?.socket?.remoteAddress
  if (typeof address === 'string' && address !== '' && !LOOPBACK.test(address)) return false
  const cookie = headers.cookie
  return typeof cookie === 'string' && /(^|;\s*)dsh-auth-[^=;\s]*=/.test(cookie)
}

/**
 * 从能力矩阵里取出模式 id 列表。
 * @param matrix
 * @returns {string[]}
 */
function modeIdsOf(matrix) {
  const columns = matrix && Array.isArray(matrix.columns) ? matrix.columns : []
  return columns.map((c) => c && c.id).filter((id) => typeof id === 'string' && id)
}

// 提示词构造与 LLM 输出解析已统一到 src/recommender.js 的
// buildLlmPrompt / parseLlmVerdict。宿主不再保留第二份实现：
// 两份迟早漂移，而测试只会测到其中一份（给没被执行的那份发合格证）。

/**
 * 调一次模型并解析判定结果。
 *
 * 失败一律返回 null（客户端会退回本地规则）。**不抛**：一次 LLM 失败不该让
 * 「该选哪个模式」这个问题变成错误弹窗。
 *
 * @param ctx - 宿主上下文。
 * @param input - 任务描述。
 * @param matrix - 能力矩阵。
 * @param cfg - normalizeConfig 的结果。
 * @returns {Promise<{attempted: boolean, verdict: {mode: string, reason: string, confidence: number}|null}>}
 *   `attempted=false` 表示**根本没发请求**（服务缺席 / 没配模型 / 能力表空），
 *   调用方据此退回配额：没花钱就不该让用户看到「问得太频繁」。
 */
async function askModel(ctx, input, matrix, cfg) {
  // 可选服务：只走 reflect，且 missing 时静默返回 undefined。
  const llm = ctx.reflect?.get?.('llm', false)
  if (!llm || typeof llm.stream !== 'function') return { attempted: false, verdict: null }

  const modeIds = modeIdsOf(matrix)
  if (!modeIds.length) return { attempted: false, verdict: null }

  // 不指定 provider/model 时跟随「设置 → 模型」的默认选择，用户不用配第二遍。
  let provider = cfg.provider
  let model = cfg.model
  if (!provider || !model) {
    const defaults = ctx.reflect?.get?.('agentDefaultModel', false)
    try {
      const selection = defaults?.currentSelection?.()
      if (selection) {
        provider = provider || selection.provider
        model = model || selection.model
      }
    } catch {
      // 读不到就继续用空值 → 下面直接放弃
    }
  }
  if (!provider || !model) return { attempted: false, verdict: null }

  const ctrl = new AbortController()
  try {
    // 提示词构造也必须在这个 try 内：matrix 来自 HTTP body，坏形状不该让 handler
    // 带着未捕获异常退出（那样连接既不返回 JSON，也没有错误可查）。
    // 默认模式必须出现在能力表里，否则模型会被要求选一个自己没法选的 id。
    const fallback = modeIds.includes(cfg.defaultMode) ? cfg.defaultMode : 'ptc'
    const { system, user } = buildLlmPrompt(input, matrix, fallback)
    const messages = [
      { role: 'system', id: randomUUID(), source: { kind: 'plugin:dsh-npie-modeguide' }, content: [{ type: 'text', text: system }] },
      { role: 'user', id: randomUUID(), source: { kind: 'plugin:dsh-npie-modeguide' }, content: [{ type: 'text', text: user }] },
    ]
    // 不能只靠 signal：第三方 provider 的流未必响应 abort，`for await` 会一直不退出，
    // handler 就永远不 end。race 一个独立计时器，保证到点一定返回。
    const { timedOut, acc } = await consumeWithDeadline(
      llm,
      // temperature: 0 —— 这是分类任务，不是创作。不指定时同一句话两次调用可能给出
      // 两个不同结论，而缓存会把其中一个当成「刚判的」固定下来。
      { provider, model, messages, maxTokens: 200, temperature: 0, signal: ctrl.signal },
      cfg.timeoutMs,
    )
    if (timedOut) {
      ctrl.abort()
      // 请求确实发出去了（可能已经在计费），不算「没调用」，不退配额。
      return { attempted: true, verdict: null }
    }
    // 与浏览器半区共用同一份解析：坏 JSON / 不在清单里的模式一律返回 null。
    return { attempted: true, verdict: parseLlmVerdict(acc, modeIds) }
  } catch {
    return { attempted: true, verdict: null }
  }
}

/**
 * 消费模型流，外加一个与 signal 无关的硬截止点。
 *
 * 超时的流无法真正取消（底层可能没有实现），所以这里只把它从 Promise 链上摘掉；
 * `catch` 兜住它后续可能抛出的 rejection，避免变成未处理异常。
 */
function consumeWithDeadline(llm, request, timeoutMs) {
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, acc: '' }), timeoutMs)
  })
  const consume = (async () => {
    let acc = ''
    for await (const chunk of llm.stream(request)) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') acc += chunk.text
    }
    return { timedOut: false, acc }
  })().catch(() => ({ timedOut: false, acc: '' }))
  return Promise.race([consume, deadline]).finally(() => clearTimeout(timer))
}

/**
 * 插件入口。
 * @param ctx - 宿主上下文。
 * @param config - 本行的配置。
 */
export function apply(ctx, config) {
  // 每个插件实例一份配额与缓存：插件重载应该重置，而不是把上一轮的「用光了」带过来。
  const bucket = createTokenBucket(JUDGE_LIMITS)
  const cache = createVerdictCache(JUDGE_LIMITS)
  /**
   * 本机计数器：面板底部「本机统计」就是把这些数字加上客户端会话内的计数。
   *
   * 只在内存里、只在本机展示 —— 这不是遥测。插件重载即清零，因为它是
   * 「这次运行发生了什么」，不是历史账本（历史在 feedback.jsonl 里）。
   */
  const stats = { judge: 0, model: 0, cacheHit: 0, limited: 0, modelMs: 0, feedbackUp: 0, feedbackDown: 0, since: Date.now() }
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const offConfig = webCtx.webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405).end()
            return
          }
          const rejection = authorizeRequest(webCtx, req)
          if (rejection) {
            res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'untrusted-caller' }))
            return
          }
          // 每次现读：默认模式是 volatile 活引用，用户在设置页改完下一次读就是新值。
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(normalizeConfig(config, webCtx)))
        },
      })

      const offJudge = webCtx.webServer.register({
        kind: 'exact',
        path: JUDGE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405).end()
            return
          }
          const rejection = authorizeRequest(webCtx, req)
          if (rejection) {
            res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'untrusted-caller' }))
            return
          }
          stats.judge += 1
          const raw = await readBody(req, 256 * 1024)
          let body
          try {
            body = JSON.parse(raw)
          } catch {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'invalid-json' }))
            return
          }
          // 整段判定都必须给出 JSON 结论：任何未预期的异常都不许留下一个
          // 既不返回、也不报错的连接（客户端只能等超时，用户体验是「一直转」）。
          try {
            const cfg = normalizeConfig(config, webCtx)
            if (!cfg.llmFallback) {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'llm-disabled' }))
              return
            }
            // 空输入不该花掉一次配额，也不该打模型：客户端的 bug 不能由用户的
            // 额度买单。校验放在扣配额之前。
            const input = typeof body?.input === 'string' ? body.input.trim() : ''
            if (!input) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'invalid-input' }))
              return
            }
            // 同一句描述 + 同一张能力表 + 同一个默认模式 ⇒ 上次的结论仍然成立，
            // 连点不该重复烧 token。
            const key = judgeCacheKey(input, body?.matrix, cfg.defaultMode)
            const cached = cache.get(key)
            if (cached) {
              stats.cacheHit += 1
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, verdict: cached, cached: true }))
              return
            }
            const ticket = bucket.take()
            if (!ticket.ok) {
              stats.limited += 1
              // 429 而不是「模型不可用」：界面要能说清「还要等多久」，用户才不会
              // 以为模型坏了、也不会以为插件没反应。
              res.writeHead(429, {
                'content-type': 'application/json; charset=utf-8',
                'retry-after': String(Math.max(1, Math.ceil(ticket.retryAfterMs / 1000))),
              })
              res.end(JSON.stringify({ ok: false, error: 'rate-limited', retryAfterMs: ticket.retryAfterMs }))
              return
            }
            const modelStarted = Date.now()
            const out = await askModel(webCtx, input, body?.matrix, cfg)
            // 一次请求都没发（未配置模型 / llm 服务缺席）⇒ 退回刚扣的配额。
            if (!out.attempted) bucket.refund()
            else {
              // 只有真发出去的请求才计入「模型调用」与耗时：没发出去的请求
              // 既没花钱也没延迟，算进去会让平均耗时看起来莫名其妙地低。
              stats.model += 1
              stats.modelMs += Date.now() - modelStarted
            }
            const verdict = out.verdict
            if (verdict) cache.set(key, verdict)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(verdict ? { ok: true, verdict } : { ok: false, error: 'llm-unavailable' }))
          } catch {
            try {
              if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'judge-failed' }))
            } catch {
              try { res.end() } catch { /* 连接已断，没什么可做的 */ }
            }
          }
        },
      })

      // ── 反馈：👍/👎 落本机 JSONL ────────────────────────────────────────
      // 只写 `DSH_PROFILE_DIR` 下的文件，不联网、不发遥测。写不进去也回 200，
      // 带上 error 让界面说「记录失败」，而不是弹一个「服务器错误」。
      const offFeedback = webCtx.webServer.register({
        kind: 'exact',
        path: FEEDBACK_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405).end()
            return
          }
          const rejection = authorizeRequest(webCtx, req)
          if (rejection) {
            res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'untrusted-caller' }))
            return
          }
          // 反馈体很小：判错的原文已由客户端截断，8 KB 足够，超了就是有人在塞东西。
          const raw = await readBody(req, 8 * 1024)
          let body
          try {
            body = JSON.parse(raw)
          } catch {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'invalid-json' }))
            return
          }
          const record = normalizeFeedback(body)
          if (!record) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'invalid-feedback' }))
            return
          }
          const stored = appendFeedback(record, process.env.DSH_PROFILE_DIR)
          // 计数只算真的落盘了的：写失败却说「已记录 1 条」比不记更糟。
          if (stored.ok) {
            if (record.thumb === 'up') stats.feedbackUp += 1
            else stats.feedbackDown += 1
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(stored.ok ? { ok: true, stored: true } : { ok: false, error: stored.error }))
        },
      })

      // ── 本机统计：内存计数器，重载插件即清零 ───────────────────────────
      const offStats = webCtx.webServer.register({
        kind: 'exact',
        path: STATS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405).end()
            return
          }
          const rejection = authorizeRequest(webCtx, req)
          if (rejection) {
            res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'untrusted-caller' }))
            return
          }
          // 零请求时平均耗时是 `null` 而不是 0：一次都没发过，"平均 0ms" 会被读成
          // "发过了而且很快"，那是把「没有数据」画成一个好看的数字。
          const avgModelMs = stats.model ? Math.round(stats.modelMs / stats.model) : null
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({
            ok: true,
            stats: {
              ...stats,
              avgModelMs,
              feedback: stats.feedbackUp + stats.feedbackDown,
              uptimeMs: Date.now() - stats.since,
            },
          }))
        },
      })

      return () => {
        offConfig()
        offJudge()
        offFeedback()
        offStats()
      }
    }, 'dsh-npie-modeguide: config + judge + feedback + stats routes')
  })
}
