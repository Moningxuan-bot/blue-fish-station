/**
 * Probe for the auth path and its self-healing, including the "stale token" case that
 * produced a real user-visible failure ("连不上宿主：缺少或错误的会话令牌").
 *
 * Why the failure could happen at all: the token in the page belongs to the host process that
 * RENDERED that page. A browser holding a cached bundle, or two workstation windows each with
 * their own host process, leaves the page with a token the current host does not recognise —
 * and the user has no way to reason about that.
 *
 * Usage: node probe-auth.mjs <station-url-with-token> [--browser]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--'))
const withBrowser = args.includes('--browser')
if (!target) {
  console.error('usage: node probe-auth.mjs <url> [--browser]')
  process.exit(2)
}

const origin = new URL(target).origin
let failures = 0
function check(label, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : ''))
  if (!ok) failures++
}

/* ---------- establish a real browser session exactly like the panel does ---------- */
const boot = await fetch(target, { redirect: 'manual' })
const setCookies = boot.headers.getSetCookie ? boot.headers.getSetCookie() : []
const cookie = setCookies.map((c) => String(c).split(';')[0]).join('; ')
const cookieName = setCookies.length > 0 ? String(setCookies[0]).split('=')[0].trim() : ''

const home = new URL(target)
home.pathname = '/'
home.search = ''
const html = await (await fetch(home.toString(), { headers: cookie ? { cookie } : {} })).text()
const token = (html.match(/data-image-station-token="([^"]+)"/) || [])[1]

console.log('=== 会话与令牌 ===')
console.log('      cookie 名   : ' + (cookieName || '（没有 set-cookie）'))
console.log('      令牌长度    : ' + (token ? token.length : 0))
check('首页带会话 cookie', cookie !== '')
check('首页注入插件令牌', Boolean(token))

const withCookie = (extra) => ({ ...(cookie ? { cookie } : {}), ...(extra || {}) })

/* ---------- 1. the protected route: right token passes, wrong token fails ---------- */
console.log('\n=== 1. 受保护路由 ===')
const good = await fetch(origin + '/image-station/presets', { headers: withCookie({ authorization: 'Bearer ' + token }) })
check('正确令牌 → 200', good.status === 200, 'HTTP ' + good.status)

const badRes = await fetch(origin + '/image-station/presets', { headers: withCookie({ authorization: 'Bearer stale-token-xxxx' }) })
check('陈旧令牌 → 401', badRes.status === 401, 'HTTP ' + badRes.status)
const badBody = await badRes.json()
check('401 带 diagnostic（不只一句"不对"）', Boolean(badBody.diagnostic), JSON.stringify(badBody.diagnostic))
check('401 带 hint（告诉用户怎么办）', typeof badBody.hint === 'string' && badBody.hint.length > 10, String(badBody.hint).slice(0, 60) + '…')
check('401 标记 retryable（面板据此自愈）', badBody.retryable === true)
check('401 不回显完整令牌', !JSON.stringify(badBody).includes(token), '只给末四位')
check('diagnostic 说明令牌从哪来', typeof (badBody.diagnostic || {}).receivedFrom === 'string', (badBody.diagnostic || {}).receivedFrom)

const noHeader = await fetch(origin + '/image-station/presets', { headers: withCookie() })
check('完全没带头 → 401', noHeader.status === 401, 'HTTP ' + noHeader.status)
const noHeaderBody = await noHeader.json()
check('没带头时的 hint 指向"强制刷新"', /Ctrl\+Shift\+R|刷新/.test(String(noHeaderBody.hint)), String(noHeaderBody.hint).slice(0, 50) + '…')

/* ---------- 2. the recovery endpoint ---------- */
console.log('\n=== 2. 取令牌端点（自愈用） ===')
const tokRes = await fetch(origin + '/image-station/token', { headers: withCookie() })
check('带会话 cookie → 200', tokRes.status === 200, 'HTTP ' + tokRes.status)
const tokBody = await tokRes.json()
check('返回当前令牌', tokBody.token === token, tokBody.token ? '匹配' : '空')

const tokNoCookie = await fetch(origin + '/image-station/token')
check('不带会话 cookie → 403（不是白送）', tokNoCookie.status === 403, 'HTTP ' + tokNoCookie.status)

/* ---------- 3. browser: the panel heals itself from a stale token ---------- */
if (withBrowser && token) {
  console.log('\n=== 3. 浏览器里的真实自愈 ===')
  const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const PORT = 9337
  const profile = mkdtempSync(join(tmpdir(), 'dsis-auth-'))
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
     '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--window-size=1400,900', 'about:blank'],
    { stdio: 'ignore' },
  )
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function findTarget() {
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
        const page = list.find((t) => t.type === 'page')
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      } catch { /* not up */ }
      await sleep(250)
    }
    throw new Error('devtools never came up')
  }
  const ws = new WebSocket(await findTarget())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws')) })
  let nextId = 1
  const pending = new Map()
  const logs = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || a.type)).join(' ')
      if (!/aurora|beacon|Failed to fetch/.test(t)) logs.push('[' + m.params.type + '] ' + t)
    }
  }
  const send = (method, params) => { const id = nextId++; ws.send(JSON.stringify({ id, method, params: params || {} })); return new Promise((r) => pending.set(id, r)) }
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: target })
  await sleep(10000)

  // Corrupt the page's token the way a stale bundle / second window would.
  await ev(`(function () {
    document.documentElement.setAttribute('data-image-station-token', 'stale-token-from-another-process')
    return true
  })()`)

  // Reopen the station so the panel fetches again with the now-wrong token.
  const openStation = `(function () {
    var b = Array.prototype.slice.call(document.querySelectorAll('button'))
    for (var i = 0; i < b.length; i++) {
      var t = (b[i].textContent || '') + (b[i].getAttribute('aria-label') || '') + (b[i].title || '')
      if (/绘图工作站|Image Studio|image-station/.test(t)) { b[i].click(); return true }
    }
    return false
  })()`
  await ev(openStation)
  await sleep(4000)

  const state = await ev(`(function () {
    var body = document.body.innerText || ''
    return JSON.stringify({
      showsTokenError: /会话令牌不匹配|缺少或错误的会话令牌/.test(body),
      loadedPresets: /通用/.test(body) && /角色主视觉/.test(body),
      specFilesListed: body.indexOf('specs/') !== -1
    })
  })()`)
  console.log('      状态: ' + state)
  const st = JSON.parse(state)
  check('用陈旧令牌后没有卡在令牌错误上', st.showsTokenError === false, String(state))
  check('面板正常加载了预设（自愈成功）', st.loadedPresets === true, String(state))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result && shot.result.data) {
    const file = join(process.cwd(), 'station-auth.png')
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    console.log('      截图: ' + file)
  }

  ws.close()
  chrome.kill()
  await sleep(400)
}

console.log('')
console.log(failures === 0 ? 'AUTH CHECKS PASSED' : failures + ' CHECK(S) FAILED')
if (failures > 0) process.exitCode = 1
