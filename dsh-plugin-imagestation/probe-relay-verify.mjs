/**
 * Second-stage relay probe: verify claims the first probe could not, using REAL images.
 *
 * Why this exists: the relay accepts parameters it then ignores (measured: it answers 200 for
 * `background: transparent` and `output_format: webp` while returning a plain opaque PNG).
 * A 200 therefore proves nothing about what was honoured, so every check below compares the
 * ACTUAL returned bytes against what was requested.
 *
 * It also re-tests `/v1/images/edits` with a proper image: the first attempt used a 1x1 PNG and
 * got `invalid_image`, which proves the endpoint exists but says nothing about usability.
 *
 * Usage:
 *   $env:DSH_IMAGE_API_KEY = 'sk-...'
 *   node probe-relay-verify.mjs [baseUrl] [model]
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const baseUrl = (process.argv[2] || 'https://api.example.com').replace(/\/+$/, '')
const model = process.argv[3] || 'your-image-model'
const key = process.env.DSH_IMAGE_API_KEY
if (!key) {
  console.error('缺少 DSH_IMAGE_API_KEY')
  process.exit(2)
}

const auth = { authorization: 'Bearer ' + key }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync('relay-samples', { recursive: true })

function isCapacity(status, body) {
  const s = JSON.stringify(body || '')
  return status === 429 || status === 502 || status === 503 || status === 524 || s.includes('No available compatible accounts')
}

async function post(path, options, { retries = 5, label = '' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res
    const started = Date.now()
    try {
      res = await fetch(baseUrl + path, Object.assign({ headers: auth }, options))
    } catch (err) {
      if (attempt === retries) return { status: 0, error: err.message, ms: Date.now() - started }
      await sleep(3000 * (attempt + 1))
      continue
    }
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      /* keep raw */
    }
    const out = { status: res.status, ms: Date.now() - started, body, raw: text }
    if (res.status === 200) return out
    if (isCapacity(res.status, body) && attempt < retries) {
      const wait = 5000 * (attempt + 1)
      process.stdout.write('      [' + label + '] 容量不足，等 ' + wait / 1000 + 's 重试 ' + (attempt + 1) + '/' + retries + '\n')
      await sleep(wait)
      continue
    }
    return out
  }
}

/** Decode one data[0] payload into bytes plus the format facts that actually matter. */
function inspect(item) {
  if (!item || typeof item.b64_json !== 'string') return { error: '没有 b64_json' }
  const bytes = Buffer.from(item.b64_json, 'base64')
  const isPng = bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG'
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8
  const isWebp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
  const format = isPng ? 'PNG' : isJpeg ? 'JPEG' : isWebp ? 'WebP' : '未知'
  let width = null
  let height = null
  let colorType = null
  if (isPng) {
    width = bytes.readUInt32BE(16)
    height = bytes.readUInt32BE(20)
    colorType = bytes[25]
  }
  return { bytes, format, width, height, colorType, hasAlpha: colorType === 6 || colorType === 4 }
}

function save(name, bytes) {
  const file = 'relay-samples/' + name
  writeFileSync(file, bytes)
  return file
}

console.log('baseUrl: ' + baseUrl + '   model: ' + model)
console.log('')

/* ---------- A. does `size` actually change the output? ---------- */
console.log('=== A. size 参数是否真的生效（比对返回 PNG 的实际像素） ===')
const sizeResults = []
for (const size of ['1024x1024', '1536x1024', '1024x1536']) {
  const r = await post(
    '/v1/images/generations',
    {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, auth),
      body: JSON.stringify({ model, prompt: 'a plain grey rectangle, minimal, flat', n: 1, size }),
    },
    { label: size },
  )
  if (r.status === 200 && r.body && r.body.data && r.body.data[0]) {
    const info = inspect(r.body.data[0])
    const matches = info.width + 'x' + info.height === size
    console.log('  请求 ' + size.padEnd(10) + ' → 实际 ' + String(info.width + 'x' + info.height).padEnd(10) +
      (matches ? '  ✓ 生效' : '  ✗ 未生效（被忽略）') + '   ' + r.ms + 'ms')
    sizeResults.push({ size, actual: info.width + 'x' + info.height, matches })
    save('size-' + size + '.png', info.bytes)
  } else {
    console.log('  请求 ' + size.padEnd(10) + ' → HTTP ' + r.status + '  ' + JSON.stringify(r.body).slice(0, 110))
    sizeResults.push({ size, actual: null, matches: null })
  }
}

/* ---------- B. a good reference image for the edits test ---------- */
console.log('')
console.log('=== B. 生成一张正规参考图（给 edits 用，同时也存下来供人眼确认） ===')
const refRes = await post(
  '/v1/images/generations',
  {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, auth),
    body: JSON.stringify({
      model,
      prompt: 'Create a simple flat illustration of a white ceramic mug on a plain pale blue background, centered, soft even lighting.',
      n: 1,
      size: '1024x1024',
    }),
  },
  { label: 'ref' },
)
let refBytes = null
if (refRes.status === 200 && refRes.body && refRes.body.data && refRes.body.data[0]) {
  const info = inspect(refRes.body.data[0])
  refBytes = info.bytes
  console.log('  ✓ ' + info.format + ' ' + info.width + 'x' + info.height + '  ' + info.bytes.length + ' 字节  ' + refRes.ms + 'ms')
  console.log('  存: ' + save('reference-mug.png', info.bytes))
  if (refRes.body.data[0].revised_prompt) {
    console.log('  revised_prompt: ' + String(refRes.body.data[0].revised_prompt).slice(0, 160))
  }
  if (refRes.body.usage) console.log('  usage: ' + JSON.stringify(refRes.body.usage))
} else {
  console.log('  HTTP ' + refRes.status + '  ' + JSON.stringify(refRes.body).slice(0, 200))
}

/* ---------- C. edits endpoint with a real image ---------- */
console.log('')
console.log('=== C. /v1/images/edits 用真图重测 ===')
if (!refBytes) {
  console.log('  跳过：没有可用的参考图')
} else {
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', 'Change the mug colour to deep teal and keep everything else identical.')
  form.append('image', new Blob([refBytes], { type: 'image/png' }), 'reference.png')
  const r = await post('/v1/images/edits', { method: 'POST', body: form }, { label: 'edits' })
  console.log('  HTTP ' + r.status + '  ' + r.ms + 'ms')
  if (r.status === 200 && r.body && r.body.data && r.body.data[0]) {
    const info = inspect(r.body.data[0])
    console.log('  ✓ edits 可用：' + info.format + ' ' + info.width + 'x' + info.height)
    console.log('  存: ' + save('edited-mug.png', info.bytes))
    if (r.body.usage) console.log('  usage: ' + JSON.stringify(r.body.usage))
  } else {
    console.log('  ' + JSON.stringify(r.body || r.raw).slice(0, 300))
  }
}

/* ---------- D. mask support ---------- */
console.log('')
console.log('=== D. edits 是否支持 mask（局部重绘） ===')
if (!refBytes) {
  console.log('  跳过：没有可用的参考图')
} else {
  // A mask must be the same size as the image. White = repaint, black = keep (per OpenAI).
  const { deflateSync } = await import('node:zlib')
  function pngChunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
    let crc = 0xffffffff
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
    crc = (crc ^ 0xffffffff) >>> 0
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc)
    return Buffer.concat([len, body, crcBuf])
  }
  const W = 1024
  const H = 1024
  const raw = Buffer.alloc((W * 4 + 1) * H)
  for (let y = 0; y < H; y++) {
    const rowStart = y * (W * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < W; x++) {
      // left half black (keep), right half white (repaint)
      const v = x < W / 2 ? 0 : 255
      const at = rowStart + 1 + x * 4
      raw[at] = v
      raw[at + 1] = v
      raw[at + 2] = v
      raw[at + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const maskPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  console.log('  构造 mask: ' + maskPng.length + ' 字节，1024x1024（左半黑=保留，右半白=重绘）')

  const form = new FormData()
  form.append('model', model)
  form.append('prompt', 'Repaint the right half as a soft warm wooden surface.')
  form.append('image', new Blob([refBytes], { type: 'image/png' }), 'reference.png')
  form.append('mask', new Blob([maskPng], { type: 'image/png' }), 'mask.png')
  const r = await post('/v1/images/edits', { method: 'POST', body: form }, { label: 'mask' })
  console.log('  HTTP ' + r.status + '  ' + r.ms + 'ms')
  if (r.status === 200 && r.body && r.body.data && r.body.data[0]) {
    const info = inspect(r.body.data[0])
    console.log('  ✓ mask 被接受：' + info.format + ' ' + info.width + 'x' + info.height)
    console.log('  存: ' + save('masked.png', info.bytes))
  } else {
    console.log('  ' + JSON.stringify(r.body || r.raw).slice(0, 300))
  }
}

console.log('')
console.log('=== 结论 ===')
const honour = sizeResults.filter((s) => s.matches === true).length
console.log('  size 生效: ' + honour + '/' + sizeResults.length)
console.log('  样本图存于 relay-samples/  —— 请人眼确认画面内容（参数"被接受"不等于"被遵守"）')
