/**
 * refresh-baseline.mjs — 从已安装的 DeepSeek Harness app.asar 重新生成 src/preset-baseline.json。
 *
 * 内核升级改了 presets/*.patch.yml 之后跑一次 `npm run refresh:baseline`，再 `npm run build`。
 * 不用解包、不写系统目录：直接读 asar 头部索引，按 offset 取四个 YAML 的字节。
 *
 * 可用 DSH_ASAR 覆盖 asar 路径（非 macOS 或自定义安装位置）。
 */
import { closeSync, openSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMatrix } from '../src/capabilities.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASAR = process.env.DSH_ASAR || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const BASE = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/'
const IDS = ['standard', 'ptc', 'minimal', 'cordis']
const NAMES = { standard: '标准模式', ptc: 'PTC 模式', minimal: '极简模式', cordis: '创造模式' }

/** 读 asar 头，返回 { header, dataOffset, fd }。 */
function openAsar(path) {
  const fd = openSync(path, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonLen = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonLen)
  readSync(fd, json, 0, jsonLen, 16)
  return { fd, header: JSON.parse(json.toString('utf8')), dataOffset: 8 + headerSize }
}

/** 按 asar 内的绝对路径取一个文件的文本。 */
function readEntry(asar, path) {
  let node = asar.header
  for (const seg of path.split('/')) {
    if (!node.files || !node.files[seg]) throw new Error('[baseline] asar 里找不到 ' + path)
    node = node.files[seg]
  }
  const buf = Buffer.alloc(Number(node.size))
  readSync(asar.fd, buf, 0, buf.length, asar.dataOffset + Number(node.offset))
  return buf.toString('utf8')
}

/** 预设 patch 里的 `config.plugins` 就是 agentPresets.read() 会返回的 content。 */
function pluginsSection(text, id) {
  const match = /\n {8}plugins:\n/.exec(text)
  if (!match) throw new Error(`[baseline] ${id}.patch.yml 里找不到 plugins 段，预设格式可能变了`)
  return text.slice(match.index + match[0].length)
}

const asar = openAsar(ASAR)
let presets
try {
  presets = IDS.map((id) => ({
    id,
    name: NAMES[id],
    content: pluginsSection(readEntry(asar, `${BASE}${id}.patch.yml`), id),
  }))
} finally {
  closeSync(asar.fd)
}

const matrix = buildMatrix(presets)
if (matrix.columns.length !== 4 || matrix.rows.length === 0) {
  throw new Error('[baseline] 解析结果异常：列数不是 4 或没有任何差异行，拒绝写入')
}

const out = {
  meta: {
    note: 'Generated from the installed DeepSeek Harness app.asar; run npm run refresh:baseline after a kernel upgrade.',
    source: `DeepSeek Harness app.asar /${BASE}*.patch.yml`,
    platform: 'darwin',
  },
  matrix,
}
writeFileSync(join(ROOT, 'src/preset-baseline.json'), JSON.stringify(out, null, 2) + '\n')
console.log(`[baseline] 4 columns, ${matrix.rows.length} differing rows <- ${ASAR}`)
