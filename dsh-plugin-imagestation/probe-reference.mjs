/**
 * Reference-image probe: drive the panel's upload path in a real browser and then actually
 * run one image-to-image generation.
 *
 * Why a browser is required: the upload path is File → FileReader → canvas downscale →
 * base64 → fetch. Every one of those is browser-only, so no amount of Node-side testing
 * proves it works. The relay's `edits` endpoint was already verified from Node
 * (probe-relay-verify.mjs), so this probe is about the PANEL half.
 *
 * Usage: node probe-reference.mjs <station-url-with-token>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('usage: node probe-reference.mjs <url>')
  process.exit(2)
}

/* ---------- make a real reference image to upload (reuse a relay sample if present) ---------- */
const tmp = mkdtempSync(join(tmpdir(), 'dsis-ref-'))
const refPath = join(tmp, 'my-reference.png')
let reused = null
for (const candidate of ['relay-samples/reference-mug.png', 'relay-samples/reference.png']) {
  try {
    writeFileSync(refPath, readFileSync(candidate))
    reused = candidate
    break
  } catch {
    /* try the next one */
  }
}
if (reused === null) {
  // 1x1 PNG fallback: still exercises the pipeline, just not a meaningful edit.
  writeFileSync(
    refPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
}
console.log('上传用的参考图: ' + refPath + (reused ? '  （取自 ' + reused + '）' : '  （1x1 兜底）'))
console.log('')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9335
const profile = mkdtempSync(join(tmpdir(), 'dsis-ref-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=1700,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
      const page = list.find((t) => t.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('devtools never came up')
}

const ws = new WebSocket(await findTarget())
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = (e) => rej(new Error('ws ' + (e && e.message)))
})

let nextId = 1
const pending = new Map()
const consoleLines = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || a.type)).join(' ')
    if (!/aurora|beacon|Failed to fetch/.test(text)) consoleLines.push('[' + m.params.type + '] ' + text)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    const desc = String((d.exception && (d.exception.description || d.exception.value)) || '')
    if (!desc.includes('aurora.js')) consoleLines.push('[throw] ' + d.text + ' ' + desc.split('\n')[0])
  }
}
function send(method, params) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params: params || {} }))
  return new Promise((r) => pending.set(id, r))
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) return { __error: r.result.exceptionDetails.text }
  return r.result && r.result.result ? r.result.result.value : undefined
}

await send('Runtime.enable')
await send('Page.enable')
await send('DOM.enable')
await send('Page.navigate', { url: target })
await sleep(10000)

const out = {}
let failures = 0
function check(label, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : ''))
  if (!ok) failures++
}

/* ---------- open the station ---------- */
await ev(`(function () {
  var b = Array.prototype.slice.call(document.querySelectorAll('button'))
  for (var i = 0; i < b.length; i++) {
    var t = (b[i].textContent || '') + (b[i].getAttribute('aria-label') || '') + (b[i].title || '')
    if (/绘图工作站|Image Studio|image-station/.test(t)) { b[i].click(); return true }
  }
  return false
})()`)
await sleep(1200)

out.dropZone = await ev(`(function () {
  var dz = document.querySelector('.dsis-drop')
  var input = document.querySelector('input[type=file]')
  return JSON.stringify({
    dropZonePresent: !!dz,
    dropZoneText: dz ? (dz.innerText || '').replace(/\\s+/g, ' ').trim() : null,
    fileInputPresent: !!input,
    accept: input ? input.getAttribute('accept') : null
  })
})()`)
console.log('上传区: ' + out.dropZone)

/* ---------- upload through the real file input (CDP sets files, so React sees a change) ---------- */
const doc = await send('DOM.getDocument', { depth: -1 })
const nodeRes = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' })
check('找得到 file input', Boolean(nodeRes.result && nodeRes.result.nodeId), JSON.stringify(nodeRes.result))

const setRes = await send('DOM.setFileInputFiles', { files: [refPath], nodeId: nodeRes.result.nodeId })
check('CDP 注入文件成功（无异常）', !setRes.error, setRes.error ? JSON.stringify(setRes.error) : '')
await sleep(2500)

out.afterUpload = await ev(`(function () {
  var img = document.querySelector('.dsis-ref-img')
  var name = document.querySelector('.dsis-ref-name')
  var meta = document.querySelector('.dsis-ref .dsis-stepdesc')
  var body = document.body.innerText || ''
  return JSON.stringify({
    previewShown: !!img,
    previewLoaded: img ? (img.complete && img.naturalWidth > 0) : null,
    fileName: name ? name.textContent : null,
    meta: meta ? meta.textContent : null,
    dropZoneGone: !document.querySelector('.dsis-drop'),
    hint: body.indexOf('输出尺寸跟随输入图') !== -1,
    hasChangeHint: body.indexOf('保持其余部分不变') !== -1
  })
})()`)
console.log('上传后: ' + out.afterUpload)
{
  const a = JSON.parse(out.afterUpload)
  check('参考图预览出现', a.previewShown === true)
  check('预览真的解码成功', a.previewLoaded === true)
  check('显示压缩信息', typeof a.meta === 'string' && a.meta.length > 0, String(a.meta).slice(0, 90))
  check('拖拽区收起（换成预览）', a.dropZoneGone === true)
  check('提示已切换为图生图语义', a.hint === true)
  check('给出"保留什么"的写法提示', a.hasChangeHint === true)
}

/* ---------- fill the prompt and actually generate ---------- */
out.draw = await ev(`(function () {
  function setNativeValue(el, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea'))
  var out = areas[areas.length - 1]
  if (!out) return Promise.resolve(JSON.stringify({ error: '没找到提示词框' }))
  setNativeValue(out, 'Change the object colour to deep teal. Keep the composition, background and lighting exactly as they are.')

  var b = Array.prototype.slice.call(document.querySelectorAll('button'))
  var go = null
  for (var i = 0; i < b.length; i++) if ((b[i].textContent || '').trim() === '出图') { go = b[i]; break }
  if (!go) return Promise.resolve(JSON.stringify({ error: '没找到出图按钮' }))
  if (go.disabled) return Promise.resolve(JSON.stringify({ error: '出图按钮被禁用' }))

  setTimeout(function () { go.click() }, 350)
  var started = Date.now()
  var sawProgress = false
  return new Promise(function (resolve) {
    var timer = setInterval(function () {
      var body = document.body.innerText || ''
      if (/正在提交|第 1\\/|上游/.test(body)) sawProgress = true
      var imgs = Array.prototype.slice.call(document.querySelectorAll('img.dsis-img'))
      var elapsed = Date.now() - started
      if ((imgs.length > 0 && imgs[0].complete && imgs[0].naturalWidth > 0) || elapsed > 180000) {
        clearInterval(timer)
        resolve(JSON.stringify({
          sawProgress: sawProgress,
          seconds: Math.round(elapsed / 1000),
          imageCount: imgs.length,
          firstNatural: imgs[0] ? imgs[0].naturalWidth + 'x' + imgs[0].naturalHeight : null,
          brokenImage: imgs[0] ? imgs[0].complete && imgs[0].naturalWidth === 0 : null,
          hasWarnings: /本次有 \\d+ 条提示/.test(body),
          mentionsSizeDropped: body.indexOf('忽略 size') !== -1 || body.indexOf('输出尺寸跟随') !== -1
        }))
      }
    }, 1000)
  })
})()`)
console.log('出图: ' + out.draw)

/* ---------- screenshot with the gallery in view ---------- */
await ev(`(function () {
  var c = document.querySelectorAll('.dsis-col-main .dsis-scroll')
  if (c.length) c[0].scrollTop = c[0].scrollHeight
  return 1
})()`)
await sleep(1200)
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result && shot.result.data) {
  const file = join(process.cwd(), 'station-reference.png')
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  out.screenshot = file
}

console.log('')
console.log(JSON.stringify(out, null, 2))
console.log('\n=== console (filtered) ===')
for (const l of consoleLines.slice(-15)) console.log('  ' + l.slice(0, 240))

ws.close()
chrome.kill()
await sleep(400)
const bad = consoleLines.some((l) => /\[error\]|\[throw\]/.test(l))
console.log('\n=== verdict: ' + (bad || failures > 0 ? 'FAIL' : 'PASS') + ' ===')
process.exit(bad || failures > 0 ? 1 : 0)
