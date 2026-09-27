/* aurora.js — DSH Web 外观覆盖层的行为部分
 * 1) 把「正在思考」状态文案换成大肥鱼（文本节点替换，不碰 React 树）
 * 2) 注入「推理强度」滑块：读 session.models / 写 session.selectModel
 *
 * 关于 2)：DSH 浏览器端用的是自研 RPC，协议已实测确认：
 *   POST /api/<method>   content-type: application/json
 *   body   { type:'client-request', rpcId:<uuid>, method:'session.selectModel', payload:{...} }
 *   返回   { type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error } }
 * 客户端自己的 callUnary 就是这么发的（见 dsh-client-connection 的 postJson + callUnary）。
 * sessionId 拿不到现成来源，靠 hook window.fetch 从 App 自己的 /api/session.* 请求里学；
 * 我们的脚本在 <body> 末尾、App 的 module 脚本之前执行，所以 hook 一定先装上。
 */
(() => {
  'use strict'

  const rawFetch = window.fetch.bind(window)

  /* ─────────── 1) 思考状态文案 ─────────── */
  const FROM = 'Deep diving...'
  const TO = '大肥鱼正在吃你的 TOKEN'

  const swap = (root) => {
    if (!root || root.nodeType === 3) {
      if (root && root.nodeValue && root.nodeValue.trim() === FROM) root.nodeValue = TO
      return
    }
    if (root.nodeType !== 1) return
    if (root.tagName === 'SCRIPT' || root.tagName === 'STYLE') return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n; (n = walker.nextNode());) {
      if (n.nodeValue && n.nodeValue.trim() === FROM) n.nodeValue = n.nodeValue.replace(FROM, TO)
    }
  }

  /* ─────────── 2) RPC ─────────── */
  const seen = { sessionId: null, payload: {} }

  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const m = /\/api\/([A-Za-z.]+)/.exec(url)
      if (m && init && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        const p = body && body.payload
        if (p) {
          seen.payload[m[1]] = p
          if (p.sessionId && p.sessionId !== seen.sessionId) onSession(p.sessionId)
        }
      }
    } catch (e) { /* 观测失败绝不影响 App 自己的请求 */ }
    return rawFetch(input, init)
  }

  const rpc = async (method, payload) => {
    const rpcId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random()
    const res = await rawFetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: rpcId, method: method, payload: payload })
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const full = await res.json()
    if (!full || !full.result) throw new Error('malformed response')
    if (!full.result.ok) throw new Error((full.result.error && full.result.error.message) || 'rpc failed')
    return full.result.value
  }

  /* ─────────── 2b) 滑块 UI ─────────── */
  const st = { sessionId: null, provider: null, model: null, efforts: [], index: 0, busy: false, note: '等待会话…' }
  let ui = null

  const css = {
    box: 'position:fixed;right:18px;bottom:18px;z-index:900;width:224px;padding:10px 12px 9px;border-radius:12px;' +
      'background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.88));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));' +
      'box-shadow:var(--dsw-shadow-lv1,0 8px 28px rgba(15,17,21,.14));backdrop-filter:blur(12px) saturate(1.4);' +
      'color:var(--dsw-alias-label-primary,#0f1115);font:500 12px/16px system-ui,-apple-system,Segoe UI,sans-serif;user-select:none;' +
      'transition:opacity .2s',
    head: 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px',
    title: 'color:var(--dsw-alias-label-tertiary,#8a93a8);font-size:11px;letter-spacing:.02em',
    value: 'font-weight:600;font-size:13px',
    range: 'width:100%;margin:2px 0 0;accent-color:var(--dsw-static-deepseek-500,#4176e6);cursor:pointer',
    ticks: 'display:flex;justify-content:space-between;margin-top:2px',
    tick: 'font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#8a93a8);flex:1;text-align:center;white-space:nowrap;overflow:hidden',
    err: 'margin-top:4px;font-size:10px;line-height:14px;color:var(--dsw-alias-state-error-primary,#d94b4b);display:none'
  }

  const build = () => {
    const box = document.createElement('div')
    box.id = 'aurora-effort'
    box.setAttribute('style', css.box)
    const head = document.createElement('div')
    head.setAttribute('style', css.head)
    const title = document.createElement('span')
    title.setAttribute('style', css.title)
    title.textContent = '推理强度'
    const value = document.createElement('span')
    value.setAttribute('style', css.value)
    head.appendChild(title); head.appendChild(value)
    const range = document.createElement('input')
    range.type = 'range'; range.min = '0'; range.max = '0'; range.step = '1'; range.value = '0'
    range.setAttribute('style', css.range)
    const ticks = document.createElement('div')
    ticks.setAttribute('style', css.ticks)
    const err = document.createElement('div')
    err.setAttribute('style', css.err)
    box.appendChild(head); box.appendChild(range); box.appendChild(ticks); box.appendChild(err)
    document.body.appendChild(box)
    ui = { box: box, value: value, range: range, ticks: ticks, err: err }

    range.addEventListener('input', () => {
      const i = Number(range.value)
      ui.value.textContent = st.efforts[i] ? st.efforts[i].name : '—'
    })
    range.addEventListener('change', () => { commit(Number(range.value)) })
  }

  const render = () => {
    if (!ui) return
    const n = st.efforts.length
    ui.range.disabled = st.busy || n < 2
    ui.range.max = String(Math.max(0, n - 1))
    ui.range.value = String(st.index)
    ui.range.style.opacity = n < 2 ? '.4' : '1'
    ui.value.textContent = n === 0 ? '—' : (st.efforts[st.index] ? st.efforts[st.index].name : '—')
    ui.ticks.textContent = ''
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span')
      s.setAttribute('style', css.tick)
      s.textContent = st.efforts[i].name
      ui.ticks.appendChild(s)
    }
    ui.err.style.display = st.note && n < 2 ? 'block' : 'none'
    ui.err.textContent = n < 2 ? st.note : ''
  }

  const commit = async (i) => {
    if (!st.sessionId || !st.provider || st.busy || !st.efforts[i]) return
    st.busy = true; st.index = i; render()
    try {
      await rpc('session.selectModel', {
        sessionId: st.sessionId, provider: st.provider, model: st.model,
        reasoningEffort: st.efforts[i].id
      })
      st.note = ''
    } catch (e) {
      st.note = '设置失败：' + (e && e.message ? e.message : e)
      console.warn('[aurora] selectModel failed', e)
    }
    st.busy = false; render()
  }

  const refresh = async () => {
    if (!st.sessionId) return
    try {
      const base = seen.payload['session.models'] || {}
      const payload = Object.assign({}, base, { sessionId: st.sessionId })
      const v = await rpc('session.models', payload)
      st.provider = v.current && v.current.provider
      st.model = v.current && v.current.model
      let reasoning
      ;(v.groups || []).forEach((g) => {
        if (g.id !== st.provider) return
        ;(g.models || []).forEach((m) => { if (m.id === st.model) reasoning = m.reasoning })
      })
      st.efforts = (reasoning && reasoning.efforts) || []
      const eff = (v.current && v.current.reasoningEffort) || (reasoning && reasoning.defaultEffort)
      const idx = st.efforts.findIndex((x) => x.id === eff)
      st.index = idx < 0 ? 0 : idx
      st.note = st.efforts.length < 2 ? '当前模型未提供推理强度档位' : ''
    } catch (e) {
      st.efforts = []; st.note = '读取失败：' + (e && e.message ? e.message : e)
      console.warn('[aurora] session.models failed', e)
    }
    render()
  }

  function onSession (id) {
    seen.sessionId = id
    st.sessionId = id
    if (!ui) build()
    refresh()
  }

  /* ─────────── 启动 ─────────── */
  const start = () => {
    swap(document.body)
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') { swap(r.target); continue }
        for (const n of r.addedNodes) swap(n)
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
    build()
    render()
    document.documentElement.dataset.aurora = 'on'
    console.log('[aurora] armed: thinking label + effort slider')
  }

  if (!document.body) document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
