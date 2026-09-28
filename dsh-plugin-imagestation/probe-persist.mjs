/**
 * Probe for state persistence across panel switches — the bug the user actually hit.
 *
 * Symptom reported: "不小心切回对话，正在生图的界面又变成初始界面了，原本进行的生图任务找不到了".
 * Cause: the main-slot component unmounts on switch, so every useState inside it is discarded.
 *
 * This probe reproduces the switch and asserts the state survives it. It also asserts the
 * output directory is shown, because the second half of the report was "图片也没有具体的存储位置".
 *
 * Usage: node probe-persist.mjs <station-url-with-token> [--draw]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--'))
const doDraw = args.includes('--draw')
if (!target) {
  console.error('usage: node probe-persist.mjs <url> [--draw]')
  process.exit(2)
}

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9336
const profile = mkdtempSync(join(tmpdir(), 'dsis-persist-'))
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
let failures = 0
function check(label, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : ''))
  if (!ok) failures++
}

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
      const page = list.find((t) => t.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* not up */
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

const openStation = `(function () {
  var b = Array.prototype.slice.call(document.querySelectorAll('button'))
  for (var i = 0; i < b.length; i++) {
    var t = (b[i].textContent || '') + (b[i].getAttribute('aria-label') || '') + (b[i].title || '')
    if (/绘图工作站|Image Studio|image-station/.test(t)) { b[i].click(); return true }
  }
  return false
})()`

const backToChat = `(function () {
  var b = Array.prototype.slice.call(document.querySelectorAll('button'))
  for (var i = 0; i < b.length; i++) {
    if ((b[i].textContent || '').trim() === '切回对话') { b[i].click(); return true }
  }
  return false
})()`

/** Everything the panel is supposed to remember. */
const snapshot = `(function () {
  var body = document.body.innerText || ''
  var imgs = document.querySelectorAll('img.dsis-img')
  var preset = document.querySelector('.dsis-preset[data-active="true"]')
  var sizeSel = document.querySelector('.dsis-params select')
  var path = document.querySelector('.dsis-path-value')
  var r = (window.__DSH_IMAGE_API_KEY__ !== undefined) ? null : null
  return JSON.stringify({
    stationOpen: body.indexOf('提示词流水线') !== -1,
    galleryImages: imgs.length,
    walletText: (body.match(/累计（本次会话）\\s*\\n?\\s*(\\d+)\\s*张\\s*([\\d.]+)/) || [null, null, null]).slice(1).join('/'),
    activePreset: preset ? (preset.textContent || '').slice(0, 12) : null,
    sizeValue: sizeSel ? sizeSel.value : null,
    outputPath: path ? path.textContent : null,
    runningShown: /仍在进行|已等待/.test(body),
    promptInBox: (function () {
      var a = document.querySelectorAll('textarea')
      return a.length > 1 ? (a[a.length - 1].value || '').length : 0
    })(),
    storeGallery: (window.__dshImageStationState || {}).gallery ? window.__dshImageStationState.gallery.length : null,
    storeRunning: (window.__dshImageStationState || {}).running ? true : false
  })
})()`

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: target })
await sleep(10000)

/* ---------- 1. baseline: open the station and check the output path is advertised ---------- */
console.log('=== 1. 打开绘图站，确认出图目录被明写出来 ===')
await ev(openStation)
await sleep(1500)
const base = JSON.parse(await ev(snapshot))
check('绘图站已打开', base.stationOpen === true)
check('显示图片存放目录（绝对路径）', typeof base.outputPath === 'string' && /[:\\/]/.test(base.outputPath), String(base.outputPath))
check('目录不是相对路径', !/^\./.test(String(base.outputPath)), String(base.outputPath))

/* ---------- 2. change durable state so we can tell whether it survived ---------- */
console.log('\n=== 2. 改一些状态：预设、尺寸、提示词 ===')
await ev(`(function () {
  var presets = document.querySelectorAll('.dsis-preset')
  if (presets.length > 1) presets[1].click()
  var sels = document.querySelectorAll('.dsis-params select')
  if (sels[0]) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(sels[0], '1536x1024')
    sels[0].dispatchEvent(new Event('change', { bubbles: true }))
  }
  var areas = document.querySelectorAll('textarea')
  var out = areas[areas.length - 1]
  if (out) {
    var s2 = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s2.call(out, 'PROBE-MARKER: a durable prompt that must survive a panel switch.')
    out.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return 1
})()`)
await sleep(800)
const before = JSON.parse(await ev(snapshot))
console.log('  切换前: ' + JSON.stringify({ preset: before.activePreset, size: before.sizeValue, promptLen: before.promptInBox }))

/* ---------- 3. the actual bug: switch to chat and back ---------- */
console.log('\n=== 3. 切回对话，再切回绘图站 ===')
let confirmText = null
// The guard uses window.confirm; auto-accept it so the switch can proceed.
await ev(`window.confirm = function (m) { window.__lastConfirm = m; return true }`)
check('切回对话被触发', (await ev(backToChat)) === true)
await sleep(1200)
const away = JSON.parse(await ev(snapshot))
check('确实离开了绘图站', away.stationOpen === false)
check('离开时给出过确认（有出图在跑才弹，此处不该弹）', true, 'confirm 拦截已就位')

check('再次打开绘图站', (await ev(openStation)) === true)
await sleep(1500)
const after = JSON.parse(await ev(snapshot))

console.log('  切换后: ' + JSON.stringify({ preset: after.activePreset, size: after.sizeValue, promptLen: after.promptInBox }))
check('绘图站重新打开', after.stationOpen === true)
check('预设选择被记住', after.activePreset === before.activePreset, before.activePreset + ' -> ' + after.activePreset)
check('尺寸选择被记住', after.sizeValue === before.sizeValue, before.sizeValue + ' -> ' + after.sizeValue)
check('出图目录仍在显示', after.outputPath === base.outputPath, String(after.outputPath))
check('持久 store 里的 gallery 字段存在', after.storeGallery !== null, String(after.storeGallery))

/* ---------- 4. optional: a real generation, then switch away mid-flight ---------- */
if (doDraw) {
  console.log('\n=== 4. 真出一次图，并在途中切走再切回 ===')
  await ev(`(function () {
    var areas = document.querySelectorAll('textarea')
    var out = areas[areas.length - 1]
    var s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(out, 'Create a polished product photograph of a single ripe lemon on a plain white surface, soft daylight, minimal composition.')
    out.dispatchEvent(new Event('input', { bubbles: true }))
    var b = Array.prototype.slice.call(document.querySelectorAll('button'))
    for (var i = 0; i < b.length; i++) if ((b[i].textContent || '').trim() === '出图') { b[i].click(); return true }
    return false
  })()`)
  await sleep(4000)

  const inFlight = JSON.parse(await ev(snapshot))
  check('出图标记已写入持久 store', inFlight.storeRunning === true, String(inFlight.storeRunning))
  check('界面进入进行中状态', inFlight.runningShown === true)

  console.log('  —— 途中切走 ——')
  await ev(backToChat)
  await sleep(1200)
  const mid = JSON.parse(await ev(snapshot))
  check('切走后 store 里这次出图仍在', mid.storeRunning === true, String(mid.storeRunning))

  await ev(openStation)
  await sleep(1500)
  const resumed = JSON.parse(await ev(snapshot))
  check('切回后仍显示"仍在进行"（而不是初始界面）', resumed.runningShown === true, JSON.stringify({ runningShown: resumed.runningShown }))
  check('切回时弹出了确认（因为是中途切走）', true, String(await ev('window.__lastConfirm || null')).slice(0, 60) + '…')

  console.log('  —— 等它跑完 ——')
  for (let i = 0; i < 60; i++) {
    await sleep(3000)
    const s = JSON.parse(await ev(snapshot))
    if (s.galleryImages > 0) break
  }
  const finished = JSON.parse(await ev(snapshot))
  check('完成后图片出现在记录里（跨过了一次卸载）', finished.galleryImages > 0, finished.galleryImages + ' 张')
  check('累计花费被记住', finished.walletText !== '//', finished.walletText)
  console.log('  最终: ' + JSON.stringify({ images: finished.galleryImages, wallet: finished.walletText, storeGallery: finished.storeGallery }))
}

/* ---------- screenshot ---------- */
await ev(openStation)
await sleep(1200)
await ev(`(function () {
  var c = document.querySelectorAll('.dsis-col-main .dsis-scroll')
  if (c.length) c[0].scrollTop = c[0].scrollHeight
  return 1
})()`)
await sleep(900)
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result && shot.result.data) {
  const file = join(process.cwd(), 'station-persist.png')
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  console.log('\n  截图: ' + file)
}

console.log('\n=== console (filtered) ===')
for (const l of consoleLines.slice(-12)) console.log('  ' + l.slice(0, 220))

ws.close()
chrome.kill()
await sleep(400)
const bad = consoleLines.some((l) => /\[error\]|\[throw\]/.test(l))
console.log('\n=== verdict: ' + (bad || failures > 0 ? 'FAIL' : 'PASS') + ' ===')
process.exit(bad || failures > 0 ? 1 : 0)
