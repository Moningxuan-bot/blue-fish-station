/**
 * Boot the real GUI in headless Chrome with the DevTools protocol attached, then report
 * whether every client entry activated.
 *
 * This is the check whose absence let "the boot graph mentions my bundle" pass while the
 * browser still showed "1 entry did not activate".
 *
 * Usage: node probe-boot.mjs <station-url-with-token>
 * Exit code 0 when the boot succeeded, 1 otherwise.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('usage: node probe-boot.mjs <url>')
  process.exit(2)
}

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333
const profile = mkdtempSync(join(tmpdir(), 'dsis-chrome-'))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list')
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('chrome devtools endpoint never came up')
}

const wsUrl = await findTarget()
const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = (e) => reject(new Error('ws error ' + (e && e.message)))
})

let nextId = 1
const pending = new Map()
const consoleLines = []
const exceptions = []

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || [])
      .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
      .join(' ')
    consoleLines.push({ level: msg.params.type, text })
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    const desc = (d.exception && (d.exception.description || d.exception.value)) || ''
    // aurora.js ships a telemetry beacon that cannot reach its endpoint in a headless
    // run; it retries in a loop and would otherwise drown the real signal.
    if (String(desc).includes('aurora.js')) return
    exceptions.push({ text: d.text, desc })
  }
}

function send(method, params) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params: params || {} }))
  return new Promise((resolve) => pending.set(id, resolve))
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.navigate', { url: target })
await sleep(9000)

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
  if (res.result && res.result.exceptionDetails) {
    return { error: res.result.exceptionDetails.text }
  }
  return { value: res.result && res.result.result ? res.result.result.value : undefined }
}

/* Did the shell's boot sequence get past activation? It throws on failure, and its
 * catcher replaces the boot card with `.fail(...)`. */
const state = await evaluate(`(function () {
  var card = document.querySelector('[data-dsh-boot]')
  var bodyText = document.body ? document.body.innerText : ''
  var failed = /did not activate|failed to load|failed to activate/i.test(bodyText)
  var bootCard = card ? (card.innerText || card.textContent || '') : null
  return JSON.stringify({
    title: document.title,
    bootCardPresent: !!card,
    bootCardText: bootCard ? String(bootCard).slice(0, 400) : null,
    bodySnippet: String(bodyText).slice(0, 400),
    failedPattern: failed,
    hasStationIcon: !!document.querySelector('[data-slot-entry*="image-station"], svg'),
    moduleLoader: typeof window.__ModuleLoader__,
    bootRows: window.__DSH_BOOT__ && window.__DSH_BOOT__.plugins
      ? window.__DSH_BOOT__.plugins.length
      : null,
    stationRow: (function () {
      var p = window.__DSH_BOOT__ && window.__DSH_BOOT__.plugins
      if (!p) return null
      for (var i = 0; i < p.length; i++) if (p[i].id === 'dsh-plugin-imagestation') return p[i]
      return 'absent'
    })()
  })
})()`)

console.log('=== page state ===')
console.log(state.value ? JSON.stringify(JSON.parse(state.value), null, 2) : JSON.stringify(state))

console.log('=== console (' + consoleLines.length + ' lines, aurora beacon noise filtered) ===')
const interesting = consoleLines.filter(
  (l) => !/beacon|Failed to fetch|aurora\.js/.test(l.text),
)
for (const l of interesting.slice(-40)) {
  console.log('  [' + l.level + '] ' + l.text.slice(0, 400))
}

console.log('\n=== uncaught exceptions (' + exceptions.length + ') ===')
for (const e of exceptions) {
  console.log('  ' + e.text)
  if (e.desc) console.log('    ' + e.desc.split('\n').slice(0, 6).join('\n    '))
}

const failure = exceptions.length > 0 || /did not activate|failed to load/i.test(JSON.stringify(state)) || /did not activate|failed to load/i.test(consoleLines.map((l) => l.text).join(' '))

ws.close()
chrome.kill()
await sleep(500)
console.log('\n=== verdict: ' + (failure ? 'FAIL' : 'PASS') + ' ===')
process.exit(failure ? 1 : 0)
