/**
 * Interaction probe for the drawing station: boot the real GUI in headless Chrome and
 * actually click the sidebar entry, then verify the whole page swapped and can swap back.
 *
 * "The boot graph mentions my bundle" is not evidence that a panel renders — this is.
 *
 * Usage: node probe-switch.mjs <station-url-with-token>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('usage: node probe-switch.mjs <url>')
  process.exit(2)
}

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9334
const profile = mkdtempSync(join(tmpdir(), 'dsis-switch-'))

// The combo URL carries a revision derived from the file's mtime/ctime/size, and the
// browser caches that script. A fresh profile is not always enough (a reused profile
// disk cache survives), so also disable the HTTP cache outright.
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-application-cache',
    '--disk-cache-size=1',
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
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list')
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* not up */
    }
    await sleep(250)
  }
  throw new Error('devtools endpoint never came up')
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
    const text = (m.params.args || [])
      .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
      .join(' ')
    if (!/aurora|beacon|Failed to fetch/.test(text)) {
      consoleLines.push('[' + m.params.type + '] ' + text)
    }
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
  if (r.result && r.result.exceptionDetails) {
    return { __error: r.result.exceptionDetails.text + ' ' + JSON.stringify(r.result.exceptionDetails.exception || {}) }
  }
  return r.result && r.result.result ? r.result.result.value : undefined
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: target })
await sleep(10000)

const out = {}

/* 1. the sidebar entry exists, carries our panel id, and has a real <svg> inside */
out.step1_sidebar_entry = await ev(`(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
  var hit = null
  for (var i = 0; i < buttons.length; i++) {
    var b = buttons[i]
    var t = (b.textContent || '') + (b.getAttribute('aria-label') || '') + (b.title || '')
    if (/绘图工作站|Image Studio|image-station/.test(t)) { hit = b; break }
  }
  return JSON.stringify({
    found: !!hit,
    label: hit ? (hit.getAttribute('aria-label') || hit.title || hit.textContent || '').trim() : null,
    svgInside: hit ? !!hit.querySelector('svg') : false,
    svgAttrs: hit && hit.querySelector('svg')
      ? Array.prototype.map.call(hit.querySelector('svg').attributes, function (a) { return a.name })
      : null
  })
})()`)

/* 2. click it and see whether the centre column actually swapped */
out.step2_after_click = await ev(`(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
  var hit = null
  for (var i = 0; i < buttons.length; i++) {
    var t = (buttons[i].textContent || '') + (buttons[i].getAttribute('aria-label') || '') + (buttons[i].title || '')
    if (/绘图工作站|Image Studio|image-station/.test(t)) { hit = buttons[i]; break }
  }
  if (!hit) return JSON.stringify({ clicked: false })
  hit.click()
  return new Promise(function (resolve) {
    setTimeout(function () {
      var body = document.body.innerText || ''
      resolve(JSON.stringify({
        clicked: true,
        stationTitleVisible: body.indexOf('绘图工作站') !== -1,
        leftColumnSpec: body.indexOf('提示规范') !== -1,
        rightColumnCost: body.indexOf('预设与成本') !== -1,
        middleColumnPrompt: body.indexOf('提示词') !== -1,
        pipelineLabel: body.indexOf('提示词流水线') !== -1,
        backButton: body.indexOf('切回对话') !== -1
      }))
    }, 1200)
  })
})()`)

/* 3. click the in-page "back to conversation" control and confirm the swap reverses */
out.step3_back = await ev(`(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
  var back = null
  for (var i = 0; i < buttons.length; i++) {
    if ((buttons[i].textContent || '').indexOf('切回对话') !== -1) { back = buttons[i]; break }
  }
  if (!back) return JSON.stringify({ found: false })
  back.click()
  return new Promise(function (resolve) {
    setTimeout(function () {
      var body = document.body.innerText || ''
      resolve(JSON.stringify({
        found: true,
        backToConversation: body.indexOf('提示词流水线') === -1 && body.indexOf('描述你想要构建的内容') !== -1
      }))
    }, 1200)
  })
})()`)

/* 4. drive the real pipeline in the browser: type a description, click expand, and watch
 *    the prompt textarea fill in from the stream. This is the only check that exercises
 *    panel → plugin routes → ctx.llm → streamed back → rendered. */
const openStation = `(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
  for (var i = 0; i < buttons.length; i++) {
    var t = (buttons[i].textContent || '') + (buttons[i].getAttribute('aria-label') || '') + (buttons[i].title || '')
    if (/绘图工作站|Image Studio|image-station/.test(t)) { buttons[i].click(); return true }
  }
  return false
})()`
await ev(openStation)
await sleep(1200)

out.step4_expand = await ev(`(function () {
  function setNativeValue(el, value) {
    var proto = window.HTMLTextAreaElement.prototype
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea'))
  if (areas.length < 2) return Promise.resolve(JSON.stringify({ error: 'expected 2 textareas, found ' + areas.length }))
  setNativeValue(areas[0], '一只戴围巾的橘猫坐在窗台上看雪，暖色灯光')

  var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
  var go = null
  for (var i = 0; i < buttons.length; i++) {
    if ((buttons[i].textContent || '').indexOf('扩写提示词') !== -1) { go = buttons[i]; break }
  }
  if (!go) return Promise.resolve(JSON.stringify({ error: 'expand button not found' }))

  var samples = []
  var started = Date.now()
  setTimeout(function () { go.click() }, 300)

  return new Promise(function (resolve) {
    var timer = setInterval(function () {
      var out = Array.prototype.slice.call(document.querySelectorAll('textarea'))[1]
      var len = out ? (out.value || '').length : 0
      samples.push(len)
      var elapsed = Date.now() - started
      var grew = samples.some(function (n) { return n > 0 })
      var n = samples.length
      var settled = grew && n > 4 && len > 0 && len === samples[n - 2] && len === samples[n - 3]
      if (settled || elapsed > 120000) {
        clearInterval(timer)
        resolve(JSON.stringify({
          grewWhileStreaming: grew,
          growthSamples: samples.slice(0, 10).concat(['…']).concat(samples.slice(-3)),
          finalLength: len,
          finalPreview: (out ? out.value : '').slice(0, 160)
        }))
      }
    }, 500)
  })
})()`)

out.step5_panel_facts = await ev(`(function () {
  var body = document.body.innerText || ''
  var m = body.match(/deepseek[-a-z0-9]*\\s*\\/\\s*deepseek[-a-z0-9]*/i)
  return JSON.stringify({
    modelChip: m ? m[0] : null,
    hasPresets: /通用/.test(body) && /二次元插画/.test(body) && /角色主视觉/.test(body),
    specFilesListed: body.indexOf('specs/') !== -1,
    lintVerdict: (body.match(/规范自检[^\\n]*/) || [null])[0],
    hasErrorBanner: /连不上宿主|扩写失败|unauthorized/.test(body)
  })
})()`)

/* 5. 在浏览器里真的出一次图 —— 只有这一步能证明图片能被 <img> 真正显示出来。 */
console.log('  （接下来会真的出一次图，约 20–30 秒）')
out.step6_draw = await ev(`(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
  var go = null
  for (var i = 0; i < buttons.length; i++) {
    if ((buttons[i].textContent || '').trim() === '出图') { go = buttons[i]; break }
  }
  if (!go) return Promise.resolve(JSON.stringify({ error: '出图按钮没找到' }))
  if (go.disabled) return Promise.resolve(JSON.stringify({ error: '出图按钮是禁用的（没有提示词，或缺 API Key）' }))
  go.click()

  var started = Date.now()
  var sawProgress = false
  return new Promise(function (resolve) {
    var timer = setInterval(function () {
      var body = document.body.innerText || ''
      if (body.indexOf('正在提交') !== -1 || body.indexOf('第 1/') !== -1 || body.indexOf('上游') !== -1) sawProgress = true
      var imgs = Array.prototype.slice.call(document.querySelectorAll('img.dsis-img'))
      var elapsed = Date.now() - started
      var loaded = imgs.length > 0 && imgs[0].complete && imgs[0].naturalWidth > 0
      if (loaded || elapsed > 180000) {
        clearInterval(timer)
        var first = imgs[0]
        resolve(JSON.stringify({
          sawProgress: sawProgress,
          seconds: Math.round(elapsed / 1000),
          imageCount: imgs.length,
          firstNatural: first ? first.naturalWidth + 'x' + first.naturalHeight : null,
          srcIsStationRoute: first ? first.src.indexOf('/image-station/image/') !== -1 : false,
          brokenImage: first ? (first.complete && first.naturalWidth === 0) : null,
          walletShown: body.indexOf('累计（本次会话）') !== -1,
          hasWarnings: /本次有 \\d+ 条提示/.test(body)
        }))
      }
    }, 1000)
  })
})()`)

/* 6. screenshot the station so a human can judge the layout.
 *    Scroll the centre column to the gallery first: the whole point of the image is to show
 *    the generated picture, and it sits below the fold in a 900px-tall capture. */
await ev(`(function () {
  var cols = document.querySelectorAll('.dsis-col-main .dsis-scroll')
  if (cols.length > 0) cols[0].scrollTop = cols[0].scrollHeight
  return 1
})()`)
await sleep(1200)
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result && shot.result.data) {
  const { writeFileSync } = await import('node:fs')
  const file = join(process.cwd(), 'station-pipeline.png')
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  out.screenshot = file
}

console.log(JSON.stringify(out, null, 2))
console.log('\n=== console (filtered) ===')
for (const l of consoleLines.slice(-20)) console.log('  ' + l.slice(0, 300))

ws.close()
chrome.kill()
await sleep(400)
const bad = consoleLines.some((l) => /\[error\]|\[throw\]/.test(l))
console.log('\n=== verdict: ' + (bad ? 'CONSOLE ERRORS PRESENT' : 'PASS (no console errors)') + ' ===')
process.exit(bad ? 1 : 0)
