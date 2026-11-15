/**
 * 真 HTTP 端到端：鉴权与配额不能只在「假 req」上成立。
 *
 * 为什么单独一个文件：先前这两条守卫是用写在 `/tmp` 里的临时脚本验的，脚本没进
 * 仓库 —— 也就是说仓库里的回归只能证明「在手工构造的 req 对象上成立」。而真实链路上
 * 有三件事不一样：header 名被小写化、`req.socket.remoteAddress` 真的存在、
 * 响应要经过真实 socket。这三件恰好都是鉴权判据的输入。
 *
 * 这里起一个真的 `http.Server`，把插件注册的路由原样接上去，用真 cookie 打请求。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, CONFIG_PATH, JUDGE_PATH } from '../index.js'

// 真的能力表：`matrix: null` 会让 askModel 直接放弃（没有可选模式），
// 那样测的就不是配额而是「表为空」，看起来全绿其实什么都没验证。
const MATRIX = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/preset-baseline.json'), 'utf8'),
).matrix

/** 起一个只挂了本插件路由的真服务器，返回 baseUrl 与关闭函数。 */
async function startHost(overrides = {}) {
  const handlers = {}
  const calls = { streams: 0, rejection: 0 }
  const webCtx = {
    effect: (fn) => { fn() },
    webServer: {
      register: (spec) => { handlers[spec.path] = spec.handler; return () => { delete handlers[spec.path] } },
    },
    reflect: {
      get: (name) => {
        if (name === 'llm') {
          return {
            stream: async function* () {
              calls.streams += 1
              yield { type: 'text-delta', text: JSON.stringify({ mode: 'ptc', reason: 'batched', confidence: 0.8 }) }
            },
          }
        }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (name === 'connection' && overrides.connection) {
          calls.rejection += 1
          return overrides.connection
        }
        return undefined
      },
    },
  }
  apply({ inject: (_names, cb) => cb(webCtx) }, {})

  const server = createServer((req, res) => {
    const handler = handlers[req.url]
    if (!handler) {
      res.writeHead(404).end()
      return
    }
    Promise.resolve(handler(req, res)).catch(() => {
      try { res.writeHead(500).end() } catch { /* 已结束 */ }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    async close() {
      server.close()
      await once(server, 'close')
    },
  }
}

const body = (input) => JSON.stringify({ input, matrix: MATRIX })

test('真 HTTP：宿主签发的 cookie 放行，伪造的长 cookie 一律 403', async () => {
  // 不提供 connection 服务 ⇒ 走插件自己的降级判据（宿主缺席时的那条路）。
  const host = await startHost()
  try {
    const forged = await fetch(host.baseUrl + JUDGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'x'.repeat(64) },
      body: body('整理这批日志'),
    })
    assert.equal(forged.status, 403, '本机任意进程造一个长 cookie 不许被当成自己人')
    assert.equal(host.calls.streams, 0, '被拒的请求不许触到模型')

    const genuine = await fetch(host.baseUrl + JUDGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'dsh-auth-session=abc' },
      body: body('整理这批日志'),
    })
    assert.equal(genuine.status, 200)
    const payload = await genuine.json()
    assert.equal(payload.ok, true)
    assert.equal(host.calls.streams, 1)

    // 跨站与外来 origin 同样要挡。
    const crossSite = await fetch(host.baseUrl + JUDGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'dsh-auth-session=abc', 'sec-fetch-site': 'cross-site' },
      body: body('整理这批日志'),
    })
    assert.equal(crossSite.status, 403)

    const foreign = await fetch(host.baseUrl + JUDGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'dsh-auth-session=abc', origin: 'https://evil.example' },
      body: body('整理这批日志'),
    })
    assert.equal(foreign.status, 403)

    // /config 也不许裸奔。
    const anonConfig = await fetch(host.baseUrl + CONFIG_PATH)
    assert.equal(anonConfig.status, 403)
    const okConfig = await fetch(host.baseUrl + CONFIG_PATH, { headers: { cookie: 'dsh-auth-session=abc' } })
    assert.equal(okConfig.status, 200)
  } finally {
    await host.close()
  }
})

test('真 HTTP：宿主提供 connection 时以它的判定为准', async () => {
  let verdict = undefined
  const host = await startHost({ connection: { requestRejection: () => verdict } })
  try {
    const open = await fetch(host.baseUrl + JUDGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body('整理这批日志'),
    })
    assert.equal(open.status, 200, '宿主说放行就放行，插件不再自己判一遍')

    verdict = 401
    const denied = await fetch(host.baseUrl + JUDGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body('整理这批日志 2'),
    })
    assert.equal(denied.status, 401)

    // 契约外的返回值（上游改成 500 / 对象）必须按拒绝处理 —— 否则一次上游改动
    // 就等于把门开着。这是「只在明确 undefined 时放行」的反向对照。
    verdict = 500
    const weird = await fetch(host.baseUrl + JUDGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body('整理这批日志 3'),
    })
    assert.equal(weird.status, 403)
  } finally {
    await host.close()
  }
})

test('真 HTTP：连点 6 次只打 5 次模型，第 6 次 429 且带 retry-after', async () => {
  const host = await startHost()
  try {
    const cookie = 'dsh-auth-session=abc'
    for (let i = 1; i <= 5; i += 1) {
      const res = await fetch(host.baseUrl + JUDGE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: body('整理这批日志 ' + i),
      })
      assert.equal(res.status, 200, `第 ${i} 次仍在配额内`)
    }
    assert.equal(host.calls.streams, 5)

    const blocked = await fetch(host.baseUrl + JUDGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: body('整理这批日志 6'),
    })
    assert.equal(blocked.status, 429)
    assert.ok(blocked.headers.get('retry-after'), '要说清还要等多久')
    assert.equal(host.calls.streams, 5, '被限流时绝不许再打模型')
  } finally {
    await host.close()
  }
})
