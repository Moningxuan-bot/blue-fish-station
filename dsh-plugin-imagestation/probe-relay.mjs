/**
 * Probe an OpenAI-compatible image relay: what does it actually implement?
 *
 * Relay stations vary wildly — some only implement `/v1/images/generations` with a subset of
 * parameters, some return `url` instead of `b64_json`, some reject `quality`/`size` outright.
 * DESIGN.md's rule is "capability probing + graceful degradation", so the first job is to find
 * out the truth instead of assuming the official OpenAI surface.
 *
 * Observed on api.example.com: the upstream pool runs dry intermittently and answers
 * HTTP 503 `{"error":{"message":"No available compatible accounts"}}`. That is CAPACITY, not
 * lack of support, so every parameter probe here retries with a backoff — otherwise the probe
 * reports a fault as if it were a capability answer (which is exactly what the first run did).
 *
 * The key is read from the environment and never printed.
 *
 * Usage:
 *   $env:DSH_IMAGE_API_KEY = 'sk-...'
 *   node probe-relay.mjs [baseUrl] [model] [--save]
 */
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2).filter((a) => a !== '--save')
const save = process.argv.includes('--save')
const baseUrl = (args[0] || process.env.DSH_IMAGE_BASE_URL || 'https://api.example.com').replace(/\/+$/, '')
const model = args[1] || process.env.DSH_IMAGE_MODEL || 'your-image-model'
const key = process.env.DSH_IMAGE_API_KEY

if (!key) {
  console.error('缺少 DSH_IMAGE_API_KEY 环境变量。')
  process.exit(2)
}

const authHeaders = { authorization: 'Bearer ' + key }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Upstream pool exhaustion, worth retrying. Anything else is an answer. */
function isCapacity(body, status) {
  if (status === 503 && String(JSON.stringify(body || '')).includes('No available compatible accounts')) return true
  return status === 502 || status === 524 || status === 429
}

async function call(path, options, { retries = 4, label = '' } = {}) {
  let last = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now()
    let res
    try {
      res = await fetch(baseUrl + path, Object.assign({ headers: authHeaders }, options))
    } catch (err) {
      last = { status: 0, error: err.message, ms: Date.now() - started }
      if (attempt < retries) {
        await sleep(1500 * (attempt + 1))
        continue
      }
      return last
    }
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      /* keep raw */
    }
    last = { status: res.status, ms: Date.now() - started, body, raw: text, contentType: res.headers.get('content-type') }
    if (res.status === 200) return last
    if (isCapacity(body, res.status) && attempt < retries) {
      const wait = 4000 * (attempt + 1)
      process.stdout.write('      [' + label + '] 上游容量不足，' + wait / 1000 + 's 后重试（第 ' + (attempt + 1) + '/' + retries + ' 次）\n')
      await sleep(wait)
      continue
    }
    return last
  }
  return last
}

function shape(value, depth) {
  if (depth > 3) return '…'
  if (Array.isArray(value)) return '[' + (value.length ? shape(value[0], depth + 1) : '') + '] x' + value.length
  if (value && typeof value === 'object') return '{' + Object.keys(value).slice(0, 14).join(', ') + '}'
  if (typeof value === 'string') return 'string(' + value.length + ')'
  return typeof value
}

console.log('baseUrl : ' + baseUrl)
console.log('model   : ' + model)
console.log('key     : 已提供（' + key.length + ' 字符，不打印内容）')
console.log('')

/* ---------- 1. model catalogue ---------- */
console.log('=== 1. 模型目录 ===')
const models = await call('/v1/models', {}, { retries: 2, label: 'models' })
if (models.status === 200 && models.body && Array.isArray(models.body.data)) {
  const list = models.body.data.map((m) => (m && (m.id || m.name)) || String(m))
  console.log('  HTTP 200  ' + list.length + ' 个：' + list.join(', '))
  console.log('  目标模型在列表里：' + list.includes(model))
} else {
  console.log('  HTTP ' + models.status + '  ' + JSON.stringify(models.body).slice(0, 200))
}

/* ---------- 2. minimal generation, and inspect the payload for real ---------- */
console.log('')
console.log('=== 2. 最小生成（1 张，1024x1024，除 prompt 外只给 model/size/n） ===')
const minimal = await call(
  '/v1/images/generations',
  {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, authHeaders),
    body: JSON.stringify({ model, prompt: 'a red apple on a wooden table', n: 1, size: '1024x1024' }),
  },
  { label: 'minimal' },
)
console.log('  HTTP ' + minimal.status + '  ' + minimal.ms + 'ms')

if (minimal.status === 200 && minimal.body) {
  const body = minimal.body
  console.log('  顶层字段: ' + Object.keys(body).join(', '))
  const item = Array.isArray(body.data) && body.data.length ? body.data[0] : null
  if (item) {
    console.log('  data[0] 字段: ' + Object.keys(item).join(', '))
    if (typeof item.b64_json === 'string') {
      const bytes = Buffer.from(item.b64_json, 'base64')
      const isPng = bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG'
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8
      const isWebp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
      console.log(
        '  b64_json: ' + item.b64_json.length + ' 字符 → ' + bytes.length + ' 字节，格式 ' +
          (isPng ? 'PNG' : isJpeg ? 'JPEG' : isWebp ? 'WebP' : '未知'),
      )
      if (isPng) {
        const w = bytes.readUInt32BE(16)
        const h = bytes.readUInt32BE(20)
        console.log('  PNG 尺寸: ' + w + 'x' + h)
      }
      if (save) {
        const file = 'relay-sample.' + (isPng ? 'png' : isJpeg ? 'jpg' : 'bin')
        writeFileSync(file, bytes)
        console.log('  已存: ' + file)
      }
    }
    if (typeof item.url === 'string') console.log('  url: ' + item.url.slice(0, 100))
    if (typeof item.revised_prompt === 'string') {
      console.log('  revised_prompt（模型自己改写过的提示词，前 200 字）:')
      console.log('    ' + item.revised_prompt.slice(0, 200))
    }
  }
  if (body.usage) console.log('  usage: ' + JSON.stringify(body.usage))
} else {
  console.log('  ' + JSON.stringify(minimal.body || minimal.raw || minimal.error).slice(0, 300))
}

/* ---------- 3. parameter acceptance, with capacity retries ---------- */
console.log('')
console.log('=== 3. 参数接受度（每个参数单独一发；容量不足会自动重试） ===')
const variants = [
  ['size 1536x1024', { size: '1536x1024' }],
  ['size auto', { size: 'auto' }],
  ['quality high', { quality: 'high' }],
  ['quality medium', { quality: 'medium' }],
  ['n=2', { n: 2 }],
  ['background transparent', { background: 'transparent' }],
  ['output_format webp', { output_format: 'webp' }],
  ['moderation low', { moderation: 'low' }],
]
const verdicts = []
for (const [label, extra] of variants) {
  const body = Object.assign({ model, prompt: 'a blue circle on white', size: '1024x1024' }, extra)
  const r = await call(
    '/v1/images/generations',
    { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, authHeaders), body: JSON.stringify(body) },
    { label },
  )
  const ok = r.status === 200
  const count = ok && r.body && Array.isArray(r.body.data) ? r.body.data.length : null
  let note = ''
  if (ok && extra.size && extra.size !== 'auto' && r.body && r.body.data && r.body.data[0] && r.body.data[0].b64_json) {
    const b = Buffer.from(r.body.data[0].b64_json, 'base64')
    if (b[0] === 0x89) note = '  实际 ' + b.readUInt32BE(16) + 'x' + b.readUInt32BE(20)
    if (extra.n) note += '  实际 ' + r.body.data.length + ' 张'
  }
  if (ok && extra.output_format) {
    const b = Buffer.from(r.body.data[0].b64_json, 'base64')
    const fmt = b[0] === 0x89 ? 'PNG' : b.subarray(0, 4).toString() === 'RIFF' ? 'WebP' : b[0] === 0xff ? 'JPEG' : '?'
    note = '  实际格式 ' + fmt
  }
  if (ok && extra.background) {
    const b = Buffer.from(r.body.data[0].b64_json, 'base64')
    // PNG 第 25 字节是 color type：6 = RGBA（含 alpha），2 = RGB
    const colorType = b[0] === 0x89 ? b[25] : null
    note = '  PNG colorType=' + colorType + (colorType === 6 ? '（含 alpha，透明可用）' : '（无 alpha，透明被忽略）')
  }
  console.log(
    '  ' + label.padEnd(26) + (ok ? '接受  ' + r.ms + 'ms' : 'HTTP ' + r.status + '  ' + r.ms + 'ms') +
      (count !== null ? '  ' + count + ' 张' : '') + note +
      (ok ? '' : '  ' + JSON.stringify(r.body).slice(0, 140)),
  )
  verdicts.push({ label, ok, status: r.status })
}

/* ---------- 4. edits endpoint ---------- */
console.log('')
console.log('=== 4. edits 端点（multipart，带一张 1x1 PNG 作输入图） ===')
{
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  )
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', 'make it blue')
  form.append('image', new Blob([png], { type: 'image/png' }), 'seed.png')
  const r = await call('/v1/images/edits', { method: 'POST', body: form }, { label: 'edits', retries: 3 })
  console.log('  HTTP ' + r.status + '  ' + r.ms + 'ms')
  console.log('  ' + JSON.stringify(r.body || r.raw).slice(0, 320))
  if (r.status === 200 && r.body && r.body.data) {
    console.log('  → edits 可用，图生图/局部重绘这条线能走')
  } else if (String(JSON.stringify(r.body || '')).includes('No available compatible accounts')) {
    console.log('  → 容量问题，无法定论；需要稍后单独复测')
  } else {
    console.log('  → 看起来不支持或另有要求（注意 1x1 的输入图本身也可能被拒）')
  }
}

console.log('')
console.log('=== 汇总 ===')
const accepted = verdicts.filter((v) => v.ok).map((v) => v.label)
const rejected = verdicts.filter((v) => !v.ok)
console.log('  接受: ' + (accepted.join(' | ') || '（无）'))
console.log(
  '  拒绝/异常: ' +
    (rejected.map((v) => v.label + '(HTTP ' + v.status + ')').join(' | ') || '（无）'),
)
