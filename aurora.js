/* aurora.js — DSH Web 外观覆盖层的行为部分
 * 1) 思考状态文案替换（文本节点，不碰 React）
 * 2) 推理强度滑块：长在模型菜单的二级面板里，覆盖原生那几行档位按钮
 *
 * RPC 协议（实测确认，见 README）：
 *   POST /api/<method>  { type:'client-request', rpcId, method, payload }
 *   resp                { type:'server-response', rpcId, result:{ ok, value|error } }
 * 用到的方法（两代命名都兼容，且优先复用从 App 流量里学到的真实端点）：
 *   读档位：session.modelCatalog（0.1.7-rc.2 起，无参数） / session.models（旧）
 *   写档位：session.selectModel {sessionId, provider, model, reasoningEffort}
 *   会话兜底：session.list → 取 updatedAt 最新的会话
 *   返回里的当前选择：新版叫 default，旧版叫 current（两个都读）
 *
 * ⚠ 卡死事故记录（v3 → v4）
 *   v3 用 MutationObserver(childList, subtree) 观察 body，回调里只要看到档位行就 place()，
 *   而 place() 会写自己 panel 的 ticks（textContent='' + appendChild）。panel 就挂在 body 下、
 *   也在观察范围内 —— 自己产生的 DOM 变更触发自己的回调，而 MutationObserver 回调是微任务，
 *   微任务里再生产微任务，浏览器永远轮不到绘制：页面直接卡死，只能重启。
 *   v4 的结构性修法（不是打补丁，是换驱动方式）：
 *     ① **定位改由 250ms 定时器驱动**，Observer 只做文案替换、绝不写定位相关的 DOM。
 *        定时器不会被自己的写入触发，所以自激回路在结构上就不可能出现。
 *     ② place() 先算签名，位置没变就不写 DOM；隐藏行用行内 opacity（React 会覆盖 className，
 *        但不会碰 style），并且只在行集合变化时才重新处理。
 *     ③ 熔断兜底：一秒内调度超过 60 次，或 place 抛错，就彻底停用浮层并恢复原生行。
 *
 * 调试：控制台执行 __aurora 看内部状态。
 */
(() => {
  'use strict'

  const rawFetch = window.fetch.bind(window)

  /* ─────────── 1) 运行状态文案（抗升级版） ───────────
   * v1 把文案和类名都写死了（FROM='Deep diving...' + [class*="_turnStatus"]），上游一改就【静默失效】。
   * 实测新版（0.1.7-rc.2 产物，dsh-client-ui-chat）：文案挂在
   *   <button data-turn-process=...><span class={css.label}>{label}</span></button>
   *   的 label 里，同一个按钮内还有工具调用计数等内容（所以只换第一个文本节点）。
   *   该按钮在回合结束后【依然存在】（文案变「已完成工作」），所以替换必须带语义判断。
   *   本地化 key：chat.deepDiving = 「深度求索中」/ 'Deep diving...'，
   *   message.turnProcess.deepDivingFor = 「深度求索中，用时{duration}」/ 'Deep diving for {duration}'。
   *   （master 源码里的 data-chat-running / RunningStatus.tsx 在 rc.2 产物里【不存在】。）
   * 现在三层兜底：
   *   A. 容器钩子按优先级试：data-turn-process → data-chat-running → _turnStatus → _runningText → _running
   *   B. 容器内第 1 个【像运行文案】的文本节点替换（保留「，用时12秒」尾巴，计时器继续走）
   *   C. 全局兜底：整篇文档里“看起来就是运行文案”的文本也换（容器改名时也能救回来），
   *      但绝不碰 PROTECTED（我们自己的浮层、菜单、按钮、表单、role=status 无障碍节点）
   * 三层都没命中时 warn 一次，升级后一眼就能定位。
   */
  const LABEL = '大肥鱼正在吃你的 TOKEN'
  /* 容器钩子，按稳定性排序（实测 0.1.7-rc.2 的产物）：
   *   [data-turn-process]   ← 现在真正装着文案的那个 <button>（data-* 最稳）
   *   [data-chat-running]   ← 只在 master 源码里有，rc.2 产物里不存在，留着当保险
   *   其余是历史类名（CSS Module 的 _xxx，升级可能改名）
   * 注意不要再放 [role="status"]：那个节点是【视觉隐藏】的无障碍通告，改了也看不见，
   * 反而可能命中别的 role=status（弹条等）。
   */
  const CONTAINERS = ['[data-turn-process]', '[data-chat-running]', '[class*="_turnStatus"]', '[class*="_runningText"]', '[class*="_running"]']
  /* 认得出“这就是运行文案”的前缀；上游换词时在这里加一条即可。
   * ⚠ 这里是【最容易自己咬自己】的地方：我们给最高档位的中文说明正是「深度思考」，
   *   而运行状态的中文文案很可能是「深度思考中」。所以裸的 /^深度思考/ 绝对不能留 ——
   *   模型菜单的档位标签一被 React 重新渲染，就会被当成运行文案替换掉（踩过）。
   *   凡是和我们 CAPTION 里任何一个中文说明重名的前缀，都必须带后缀限定或不收。 */
  const COPY_PATTERNS = [
    /^deep diving/i,
    /^thinking/i,
    /^深度求索/,        /* 0.1.7-rc.2 的中文文案：深度求索中 / 深度求索中，用时12秒 */
    /^思考中/,
    /^正在思考/,
    /^正在深度思考/,
    /^深度思考(中|…|\.\.\.)/,   /* 必须带后缀：「深度思考中」「深度思考…」才认 */
    /^深度潜水/,
  ]
  /* 全局兜底时绝不碰的区域：我们自己的浮层、菜单里的按钮/选项、表单控件。
   * 档位标签（如「深度思考」）就长在这些地方，误替换=用户看得见的错。 */
  const PROTECTED = ['#aurora-effort', '[role="status"]', '[role="menu"]', '[role="menuitemradio"]', '[role="listbox"]', '[role="option"]', 'button', 'input', 'textarea', 'select']
  const CAPTIONS = ['不想思考', '开始思考', '认真思考', '深度思考']
  const protectedText = (node) => {
    const el = node && node.parentElement
    if (!el) return true
    if (CAPTIONS.indexOf((node.nodeValue || '').trim()) >= 0) return true
    for (const sel of PROTECTED) { if (el.closest(sel)) return true }
    return false
  }
  const CLOCK_RE = /^[\d\s:：.·hms分秒]+$/i
  const isClock = (t) => CLOCK_RE.test(t)
  const isCopy = (t) => COPY_PATTERNS.some((re) => re.test(t))

  /* 计时尾巴（中文「，用时12秒」/ 英文「 for 12s」）：换文案时保留它，这样计时器还在走 */
  const TAIL_RE = /(，?\s*用时\s*[0-9][^，]*|\s+for\s+[0-9][^,]*)$/i
  const keepTail = (t) => {
    const m = TAIL_RE.exec(t)
    return LABEL + (m ? m[1] : '')
  }

  /* 只替换容器内【第一个】可见文本节点。
   * 为什么不是全换：新版文案挂在一个 <button data-turn-process> 里，同一个按钮内还有
   * 工具调用计数、折叠内容等文字，全换会把它们一起毁掉。第一个非空文本节点就是那句文案。 */
  const swapInside = (host) => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    for (let n; (n = walker.nextNode());) {
      const t = (n.nodeValue || '').trim()
      if (!t || t === LABEL || isClock(t)) continue
      /* 必须“像运行文案”才换：新版 [data-turn-process] 这个按钮在回合结束后依然存在，
       * 那时文案是「已完成工作」，若无条件替换就会把它也改掉。
       * 代价是上游换措辞时要在 COPY_PATTERNS 里补一条 —— 失配时 selfCheck 会告警。 */
      if (!isCopy(t)) continue
      n.nodeValue = n.nodeValue.replace(t, keepTail(t))
      return
    }
  }

  const swap = (root) => {
    const el = !root ? null : root.nodeType === 3 ? root.parentElement : root
    if (!el || el.nodeType !== 1) return
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return
    for (const sel of CONTAINERS) {
      const host = el.closest ? el.closest(sel) : null
      if (host) { swapInside(host); return }
    }
    /* 容器也可能在【新增子树内部】：首次挂载时 MutationObserver 给的 addedNode 往往是
     * 更外层的节点（比如整条消息），closest() 只看祖先，于是这一帧找不到容器，只能走全局兜底；
     * 而全局兜底为防误伤把 button 列进了 PROTECTED，结果就是「先看到深度求索中，一秒后才变成大肥鱼」。
     * 所以这里再往子树里找一遍容器，保证首次插入就能在同一次微任务里换掉。 */
    if (el.querySelectorAll) {
      for (const sel of CONTAINERS) {
        const hosts = el.querySelectorAll(sel)
        if (hosts.length > 0) {
          for (const h of hosts) swapInside(h)
          return
        }
      }
    }
    /* 全局兜底（容器钩子全失配时才需要）：只认“看起来就是运行文案”的文本，
     * 并且绝不碰菜单/按钮/表单/我们自己的浮层。 */
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n; (n = walker.nextNode());) {
      const t = (n.nodeValue || '').trim()
      if (!t || t === LABEL || isClock(t) || !isCopy(t)) continue
      if (protectedText(n)) continue
      n.nodeValue = n.nodeValue.replace(t, LABEL)
    }
  }

  /* 自检：容器钩子全部失配却发现了“像运行文案”的文本 → 说明上游改了结构，告警一次 */
  let hookWarned = false
  let mutationSeq = 0
  let scannedSeq = -1
  const selfCheck = () => {
    if (hookWarned || !document.body) return
    if (mutationSeq === scannedSeq) return   /* 文档没动过就不必再扫，避免空转 */
    scannedSeq = mutationSeq
    for (const sel of CONTAINERS) {
      const host = document.querySelector(sel)
      if (host) { swapInside(host); return }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n; (n = walker.nextNode());) {
      const t = (n.nodeValue || '').trim()
      if (t && isCopy(t) && !protectedText(n)) {
        n.nodeValue = n.nodeValue.replace(t, LABEL)
        hookWarned = true
        console.warn('[aurora] 运行状态容器钩子全都没匹配上，已用全局文本兜底。上游可能改了结构，请把这条日志发我。命中文本: ' + t)
        return
      }
    }
  }

  /* ── 临时诊断通道 ───────────────────────────────────────────────
   * 把状态变化 POST 到本机 127.0.0.1:8799（作者开的接收端），这样“闪一下就关”的过程
   * 不用你手抄控制台。接收端没开就静默失败，绝不影响页面。
   * 定位完之后这段可以整段删掉。
   */
  const BEACON = 'http://127.0.0.1:8799/aurora'
  const beacon = (text) => {
    try { rawFetch(BEACON, { method: 'POST', mode: 'no-cors', body: String(text).slice(0, 900) }) } catch (e) { /* 忽略 */ }
  }
  window.addEventListener('error', (e) => beacon('PAGE-ERROR ' + (e && e.message) + ' @ ' + (e && e.filename) + ':' + (e && e.lineno)))
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason
    beacon('PAGE-REJECT ' + ((r && r.message) || String(r)))
  })

  /* ─────────── 2) RPC ───────────
   * 端点命名在 0.1.7-rc.2 变了：读档位从 session.models 改成 session.modelCatalog（无参数），
   * 返回里原来的 current 改名叫 default。groups / models / reasoning.efforts 的结构没变。
   * 与其硬编码猜测，主路径是【从 App 自己的流量里学】：hook fetch 时记下它用过的 method
   * 字符串与目录响应值，优先复用；候选列表只用于首次打开菜单前的兜底。
   */
  /* 实测（0.1.7-rc.2，直接打服务端验证过）：
   *   POST /api/<namespace>/<method>    ← 斜杠！旧版是点号（session.models）
   *   payload: { args: <对象> }         ← 多了一层 args 信封；旧版是裸 payload
   *   args 里的键名来自接口描述符的 wire 名：
   *     session/modelCatalog（0 参数）→ args: {}
   *     session/selectModel（1 参数 request）→ args: { request: {...} }
   *     session/list（1 参数 _request）→ args: { _request: {} }
   * newStyle: false 表示旧版裸 payload 形式，作为回退保留。
   */
  const EP = {
    catalog: [
      { method: 'session/modelCatalog', args: () => ({}) },
      { method: 'session.models', args: (p) => p, newStyle: false },
      { method: 'session.modelCatalog', args: () => ({}) },
    ],
    select: [
      { method: 'session/selectModel', args: (p) => ({ request: p }) },
      { method: 'session.selectModel', args: (p) => p, newStyle: false },
    ],
    list: [
      { method: 'session/list', args: () => ({ _request: {} }) },
      { method: 'session.list', args: (p) => p, newStyle: false },
    ],
  }
  const learned = { catalog: null, select: null, list: null, lastCatalog: null, newStyle: null }

  /* 在新旧两种信封里挖 sessionId */
  const findSessionId = (p) => {
    if (!p || typeof p !== 'object') return null
    if (typeof p.sessionId === 'string') return p.sessionId
    const a = p.args
    if (!a || typeof a !== 'object') return null
    if (typeof a.sessionId === 'string') return a.sessionId
    for (const k of ['request', '_request']) {
      const inner = a[k]
      if (inner && typeof inner.sessionId === 'string') return inner.sessionId
    }
    return null
  }

  /* 从方法名推断新版 args 里的参数键名（描述符的 wire 名） */
  const inferArgs = (method, p) => {
    if (/selectModel/.test(method)) return { request: p }
    if (/[./]list$/.test(method)) return { _request: {} }
    return {}
  }
  const seen = { sessionId: null, payload: {} }

  window.fetch = function (input, init) {
    let method = null
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const m = /\/api\/([A-Za-z0-9._$/-]+)/.exec(url)
      if (m && init && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        const p = body && body.payload
        method = body && body.method
        if (typeof method === 'string') {
          /* 学真实端点名：新版 session.modelCatalog、旧版 session.models 都认得出来 */
          if (/selectModel/.test(method)) learned.select = method
          else if (/modelCatalog|(^|\.)models$/.test(method)) learned.catalog = method
          if (/^session[./]list$/.test(method)) learned.list = method
          /* 顺便学信封样式：新版 payload 里有 args 这一层，旧版没有 */
          if (p && typeof p === 'object') learned.newStyle = Object.prototype.hasOwnProperty.call(p, 'args')
        }
        if (p) {
          seen.payload[m[1]] = p
          /* 新版把参数包在 payload.args 里（args.request.sessionId 等），旧版直接在 payload 上；
           * 都要能找到 sessionId，否则会话兜底会白跑一趟。 */
          const sid = findSessionId(p)
          if (sid && sid !== seen.sessionId) onSession(sid)
        }
      }
    } catch (e) { /* 观测失败绝不影响 App 自己的请求 */ }
    const res = rawFetch(input, init)
    /* 顺带缓存目录响应：App 打开模型菜单时会自己去拉，我们直接复用 —— 既省一次请求，
     * 也不怕上游再改结构（我们复用的是它自己认得的形状）。 */
    try {
      if (method && /modelCatalog|(^|\.)models$/.test(method) && res && res.clone) {
        res.clone().json().then((full) => {
          const v = full && full.result && full.result.ok ? full.result.value : null
          if (v && v.groups) {
            learned.lastCatalog = v
            readState()   /* 拿到目录就立刻重读一次：不用等下次开菜单，滑块马上能出来 */
          }
        }).catch(() => {})
      }
    } catch (e) { /* 同上 */ }
    return res
  }

  const rpc = async (method, args, newStyle) => {
    const rpcId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random()
    /* 未指定样式时，优先用从 App 流量里学到的 */
    const wrap = newStyle === undefined ? learned.newStyle !== false : newStyle !== false
    const payload = wrap ? { args: args } : args
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

  /* 依次试候选端点，第一个成功的就是它；优先用从 App 流量里学到的那个名字 */
  const rpcAny = async (key, p) => {
    const tries = []
    if (learned[key]) {
      /* 学到过端点：先按学到的用（信封样式也按学到的），再兜底另一种样式 */
      tries.push({ method: learned[key], args: (x) => inferArgs(learned[key], x) })
      tries.push({ method: learned[key], args: (x) => inferArgs(learned[key], x), newStyle: false })
    }
    for (const e of EP[key]) tries.push(e)
    let lastErr = null
    for (const t of tries) {
      try { return await rpc(t.method, t.args(p), t.newStyle) } catch (e) { lastErr = e }
    }
    throw lastErr || new Error('no endpoint: ' + key)
  }

  /* ─────────── 3) 状态 ─────────── */
  const st = {
    sessionId: null, provider: null, model: null, efforts: [], index: 0,
    busy: false, note: '', rows: 0, placed: false, disabled: false, places: 0,
    /* 诊断用：radios = 文档里 menuitemradio 总数；matched = 通过我们四重校验的行数；
     * flash = 浮层显示/隐藏的切换次数（“闪一下”会在这里累加） */
    radios: 0, matched: 0, flash: 0
  }
  window.__aurora = st

  const describe = () => {
    const sid = st.sessionId ? String(st.sessionId).slice(-6) : 'none'
    return 'sid:' + sid + ' rows:' + st.rows + ' efforts:' + st.efforts.length + (st.note ? ' | ' + st.note : '')
  }

  /* ─────────── 4) 读当前档位 ─────────── */
  const readState = async () => {
    try {
      /* 新版 session.modelCatalog 不带参数；旧版 session.models 需要 sessionId。
       * 两种 payload 都带上，服务端按自己的 schema 取用即可。 */
      const payload = Object.assign({}, seen.payload[learned.catalog || ''] || {}, { sessionId: st.sessionId })
      const v = learned.lastCatalog || await rpcAny('catalog', payload)
      if (!v) { st.note = '目录为空'; render(); return }
      /* current（旧）→ default（新）；再不行退回模型自带的 defaultEffort */
      const cur = v.current || v.default || {}
      st.provider = cur.provider
      st.model = cur.model
      let reasoning = null
      ;(v.groups || []).forEach((g) => {
        if (g.id !== st.provider) return
        ;(g.models || []).forEach((m) => { if (m.id === st.model) reasoning = m.reasoning })
      })
      /* 防闪：同一次会话里 App 可能发出不止一次目录请求（比如打开菜单时的 reload），
       * 其中某次若没带上 reasoning（局部/过滤过的目录），直接覆盖就会让滑块闪一下消失。
       * 所以只有在「模型确实变了」或「这次真的拿到了档位」时才替换。 */
      const nextEfforts = (reasoning && reasoning.efforts) || []
      const sameModel = cur.provider === st.provider && cur.model === st.model
      if (nextEfforts.length === 0 && st.efforts.length >= 2 && sameModel) {
        console.log('[aurora] 本次目录没给出 efforts，保留上次档位（' + st.efforts.length + ' 档）')
      } else {
        st.efforts = nextEfforts
      }
      const eff = cur.reasoningEffort || (reasoning && reasoning.defaultEffort)
      const idx = st.efforts.findIndex((x) => x.id === eff)
      st.index = idx < 0 ? 0 : idx
      st.note = st.efforts.length >= 2 ? '' : '当前模型未提供推理强度档位'
      console.log('[aurora] efforts', st.efforts.map((e) => e.id).join('/'), 'current=' + eff,
        'via=' + (learned.lastCatalog ? 'app-cache' : (learned.catalog || EP.catalog[0].method)))
      beacon('readState ok efforts=' + st.efforts.length + ' [' + st.efforts.map((e) => e.id).join('/') + ']' +
        ' cur=' + st.provider + '/' + st.model + '/' + eff + ' via=' + (learned.lastCatalog ? 'app-cache' : (learned.catalog || EP.catalog[0].method)))
    } catch (e) {
      st.efforts = []
      st.note = '读取失败: ' + (e && e.message ? e.message : e)
      console.warn('[aurora] modelCatalog failed', e)
      beacon('readState FAIL ' + (e && e.message ? e.message : e))
    }
    render()
  }

  const bootstrapSession = async () => {
    if (st.sessionId) return
    try {
      const v = await rpcAny('list', {})
      const items = (v && v.items) || []
      const cands = items.filter((i) => !i.parentSessionId && !i.origin)
      const best = (cands.length ? cands : items).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
      if (best && best.sessionId) {
        console.log('[aurora] sessionId from session.list:', best.sessionId)
        onSession(best.sessionId)
      } else {
        st.note = '找不到会话'
      }
    } catch (e) {
      st.note = '会话列表读取失败: ' + (e && e.message ? e.message : e)
      console.warn('[aurora] session.list failed', e)
    }
    render()
  }

  function onSession (id) {
    seen.sessionId = id
    st.sessionId = id
    readState()
  }

  /* ─────────── 5) 滑块 ─────────── */
  const PANEL_ID = 'aurora-effort'
  let panel = null
  let hiddenRows = []
  let lastSig = ''
  let scheduled = false
  let placeTimes = []
  let observer = null
  let tickTimer = null
  let pendingIndex = null   /* 提交进行中又拖了新的值：记下来，等当前这次回来再补发 */
  let dragging = false      /* 正在拖：期间 render 不许写 range.value，否则拇指会被拽回刻度 */
  let dragFrom = null       /* 本次拖动开始时的挡位，用于松手时判断要不要弹回 */
  let previewIndex = null   /* 拖动中预览到的高亮挡位 */

  /* ── 平滑拖动 + 挡位吸附 ────────────────────────────────────────
   * 轨道是连续的（0..1000），所以拇指跟着鼠标连续走，不会被机械吸到挡位上；
   * 但真正生效的值始终取【离拇指最近的挡位】。松手时：
   *   · 最近的挡位还是原来那个  → 拇指弹回原挡位，不提交（这就是你说的没拖到位就恢复）
   *   · 最近的是别的挡位        → 提交该挡位，并把拇指吸附到它的刻度上
   */
  const STEPS = 1000
  const levelCount = () => st.efforts.length
  const valOf = (i) => {
    const n = levelCount()
    if (n <= 1) return 0
    return Math.round((Math.max(0, Math.min(n - 1, i)) / (n - 1)) * STEPS)
  }
  const idxOf = (v) => {
    const n = levelCount()
    if (n <= 1) return 0
    return Math.max(0, Math.min(n - 1, Math.round((Number(v) / STEPS) * (n - 1))))
  }

  const paintTicks = (active) => {
    if (!panel) return
    const n = levelCount()
    panel.ticks.textContent = ''
    for (let i = 0; i < n; i++) {
      /* 每个刻度按百分比绝对定位 + translateX(-50%)，让标签中心正好落在拇指的刻度上
       * （用 flex:1 平均分的话首尾会明显偏内）。每格 = 百分比胶囊 + 中文说明，对齐设计稿。 */
      const pct = n <= 1 ? 50 : (i / (n - 1)) * 100
      const on = i === active
      const wrap = document.createElement('span')
      wrap.setAttribute('style', 'position:absolute;top:0;left:' + pct + '%;transform:translateX(-50%);' +
        'width:' + (100 / n) + '%;display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center')
      const badge = document.createElement('span')
      badge.textContent = Math.round(pct) + '%'
      badge.setAttribute('style', 'font-size:9px;line-height:15px;padding:0 7px;border-radius:999px;font-weight:600;' +
        (on ? 'background:#2F86EA;color:#fff' : 'background:rgba(47,134,234,.10);color:#2F6FBF'))
      const cap = document.createElement('span')
      cap.textContent = captionOf(st.efforts[i])
      cap.setAttribute('style', 'font-size:10px;line-height:13px;white-space:nowrap;' +
        (on ? 'font-weight:700;color:#1E6FD0' : 'color:rgba(47,111,191,.72)'))
      wrap.appendChild(badge)
      wrap.appendChild(cap)
      panel.ticks.appendChild(wrap)
    }

    /* 角色立绘：当前档位全亮略上浮，其余压暗降饱和；拖动时跟着预览档位实时切换。
     * 一格一个，绝对定位在自己的刻度百分比上，和上面的标签、下面的胶囊完全对齐。 */
    if (panel.moods) {
      panel.moods.textContent = ''
      const slotW = Math.round(MOOD_H * 1.25)
      for (let i = 0; i < n; i++) {
        const pct = n <= 1 ? 50 : (i / (n - 1)) * 100
        const on = i === active
        const s = document.createElement('div')
        /* 拖动中：当前档位那格换成 12 帧跑动图并逐帧播放 —— 角色“跑”到目标档位；
         * 松手定档后（dragging=false）自动切回该档位的静态立绘。 */
        const skin = 'background-image:url(' + MOODS_URL + ');background-repeat:no-repeat;' +
          'background-size:' + (n * 100) + '% 100%;background-position:' + pct + '% 50%;'
        s.setAttribute('style', 'position:absolute;top:0;left:' + pct + '%;' +
          'width:' + slotW + 'px;height:' + MOOD_H + 'px;' +
          'transform:translateX(-50%)' + (on ? ' translateY(-3px) scale(1.08)' : '') + ';' +
          skin +
          'opacity:' + (on ? 1 : 0.42) + ';' +
          'filter:' + (on ? 'none' : 'saturate(.55)') + ';' +
          'transition:opacity .15s linear,transform .15s ease,filter .15s linear;pointer-events:none')
        panel.moods.appendChild(s)
      }
    }
  }

  const paintValue = (i) => {
    if (!panel) return
    panel.value.textContent = st.efforts[i] ? st.efforts[i].name : '—'
  }

  /* 松手结算 */
  const finishDrag = () => {
    if (!panel || !dragging) return
    const from = dragFrom === null ? st.index : dragFrom
    const to = idxOf(panel.range.value)
    dragging = false
    dragFrom = null
    previewIndex = null
    if (panel.flow) panel.flow.dataset.on = '0'   /* 松手收掉流光 */
    setDragging(false)                            /* 跑动角色退场，档位立绘重新出现 */
    if (to === from) {
      /* 没跨过任何挡位中点：拇指弹回原挡位，什么都不提交 */
      panel.range.value = String(valOf(from))
      setFill(valOf(from))
      paintValue(from)
      paintTicks(from)
      return
    }
    panel.range.value = String(valOf(to))   /* 先吸到目标刻度，视觉上立刻到位 */
    setFill(valOf(to))
    paintValue(to)
    paintTicks(to)
    commit(to)
  }

  /* ── 尺寸与外观（对齐参考设计稿；想再调大就改这三个数） ────────── */
  const TRACK = 24   /* 轨道高度 px（设计稿是满屏粗胶囊，按菜单宽度等比缩） */
  const THUMB = 40   /* 圆点直径 px（设计稿里圆点比轨道高约 1.3 倍） */
  const PANEL_MIN_W = 344 /* 面板最小宽度：4 个中文档位名要一行放得下，太窄就挤成一团 */
  const MOOD_H = 52       /* 档位角色立绘显示高度 px（宽 = 高 × 1.25，与雪碧图单格等比） */
  const MOODS_URL = '/aurora-moods.svg'  /* 四格雪碧图：依次是 1/3/4/5 号角色 */
  const RUN_URL = '/aurora-run.svg'      /* 12 格跑动图：起跑 + 跑步1-10 + 循环 */
  const RUN_FRAMES = 12
  const RUN_MS = 1600    /* 跑动一轮的时长：12 帧 / 1.6s ≈ 每帧 133ms。想更慢就加大这个数 */
  const RADIUS = 999 /* 轨道圆角，999 = 全圆头 */
  const STYLE_ID = 'aurora-effort-style'

  /* 白星（圆点内）与淡星（轨道装饰），用 data URI 内联，避免额外资源请求 */
  const svgStar = (fill, opacity) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>" +
    "<path fill='" + fill + "' fill-opacity='" + opacity + "' d='M12 2.4l2.95 6.06 6.65.94-4.83 4.62 1.16 6.6L12 17.5l-5.93 3.12 1.16-6.6L2.4 9.4l6.65-.94z'/></svg>"
  )
  const STAR_WHITE = svgStar('%23ffffff', '1')
  const STAR_FAINT = svgStar('%23ffffff', '0.38')

  /* 档位 → 中文说明（对齐设计稿的五个说法，按 id 映射，认不出就退回 provider 给的名字） */
  const CAPTION = {
    off: '不想思考',
    none: '不想思考',
    minimal: '开始思考',
    low: '开始思考',
    medium: '认真思考',
    high: '深度思考',
    max: '极度专注',
    maximum: '极度专注'
  }
  const captionOf = (e) => (e && CAPTION[e.id]) || (e ? e.name : '')

  /* range 的轨道/圆点只能靠伪元素样式，而伪元素没法写行内样式，所以这里插一个 <style>。
   * 尺寸全部走变量，后面调大小只改上面三个常量。 */
  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return
    const grad = 'linear-gradient(90deg,#DCEFFC 0%,#B9E0FA 30%,#7CC0F5 62%,#2F86EA 100%)'
    const stars = 'url("' + STAR_FAINT + '"),url("' + STAR_FAINT + '"),url("' + STAR_FAINT + '"),'
    /* 跑动图逐帧关键帧：12 格雪碧图里，第 k 格对应 background-position = k/(n-1)*100%，
     * 每帧用 steps(1,end) 让它“停住”而不是补间滑过去，否则会看到两格之间的错位重影。 */
    let runKf = '@keyframes aurora-run{'
    for (let k = 0; k < RUN_FRAMES; k++) {
      const p = ((k / (RUN_FRAMES - 1)) * 100).toFixed(4)
      runKf += p + '%{background-position:' + p + '% 50%;animation-timing-function:steps(1,end)}'
    }
    runKf += '}'
    /* 流光：一道白色斜向高光沿轨道循环扫过（第 5 层背景，只动它的 background-position） */
    const sheen = 'linear-gradient(105deg,rgba(255,255,255,0) 32%,rgba(255,255,255,.72) 50%,rgba(255,255,255,0) 68%)'
    const css = [
      '#aurora-effort input[type=range]{-webkit-appearance:none;appearance:none;background:transparent;width:100%;margin:0;height:' + THUMB + 'px;cursor:grab;touch-action:none}',
      '#aurora-effort input[type=range]:focus{outline:none}',
      '#aurora-effort input[type=range]:active{cursor:grabbing}',
      /* 轨道：粗胶囊 + 淡蓝→饱和蓝渐变 + 内嵌白描边 + 三颗淡星装饰（都来自设计稿） */
      '#aurora-effort input[type=range]::-webkit-slider-runnable-track{height:' + TRACK + 'px;border-radius:' + RADIUS + 'px;' +
        'background-image:' + stars + grad + ',' + sheen + ';' +
        'background-repeat:no-repeat,no-repeat,no-repeat,no-repeat,no-repeat;' +
        'background-size:10px 10px,10px 10px,10px 10px,100% 100%,55% 100%;' +
        'background-position:18% 50%,45% 50%,72% 50%,0 0,-100% 0;' +
        'box-shadow:inset 0 0 0 2px rgba(255,255,255,.92),0 3px 10px rgba(47,134,234,.22)}',
      /* 圆点：白环 + 蓝底 + 白星 */
      '#aurora-effort input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:' + THUMB + 'px;height:' + THUMB + 'px;border-radius:50%;' +
        'border:3px solid #fff;' +
        'background-image:url("' + STAR_WHITE + '"),radial-gradient(circle at 50% 42%,#5AA9F0 0%,#2F7FE0 100%);' +
        'background-size:' + Math.round(THUMB * 0.47) + 'px ' + Math.round(THUMB * 0.47) + 'px,100% 100%;' +
        'background-repeat:no-repeat,no-repeat;background-position:center,center;' +
        'box-shadow:0 3px 10px rgba(24,80,170,.35);margin-top:' + ((TRACK - THUMB) / 2) + 'px;' +
        'animation:aurora-thumb-glow 2.2s ease-in-out infinite}',
      '#aurora-effort input[type=range]::-moz-range-track{height:' + TRACK + 'px;border-radius:' + RADIUS + 'px;background-image:' + grad + ';box-shadow:inset 0 0 0 2px rgba(255,255,255,.92)}',
      '#aurora-effort input[type=range]::-moz-range-thumb{width:' + THUMB + 'px;height:' + THUMB + 'px;border-radius:50%;border:3px solid #fff;' +
        'background-image:url("' + STAR_WHITE + '"),radial-gradient(circle at 50% 42%,#5AA9F0 0%,#2F7FE0 100%);background-size:' + Math.round(THUMB * 0.47) + 'px ' + Math.round(THUMB * 0.47) + 'px,100% 100%;background-repeat:no-repeat,no-repeat;background-position:center,center}',
      '#aurora-effort input[type=range]:disabled{opacity:.45}',
      /* 流光：一层独立的覆盖层（不挂在 track 伪元素上，避免表单控件伪元素动画不刷新的坑）。
       * 颜色取轨道底色的同色系淡蓝 + 白芯，扫过去跟底色是一个调子，不会像纯白那样突兀。
       * 平时 opacity:0 不显示，按住滑块（拖动中）才 data-on=1 显形，符合“按住才出现流光”。 */
      '#aurora-effort .ae-flow{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);height:' + TRACK + 'px;' +
        'border-radius:' + RADIUS + 'px;overflow:hidden;pointer-events:none;opacity:0;transition:opacity .12s linear}',
      '#aurora-effort .ae-flow[data-on="1"]{opacity:1}',
      '#aurora-effort .ae-flow::before{content:"";position:absolute;top:0;bottom:0;left:0;width:45%;' +
        'background:linear-gradient(100deg,rgba(214,240,255,0) 0%,rgba(219,241,255,.85) 38%,rgba(255,255,255,.98) 52%,rgba(214,240,255,.85) 64%,rgba(214,240,255,0) 100%);' +
        'transform:translateX(-110%);animation:aurora-sweep 1.15s linear infinite}',
      '@keyframes aurora-sweep{from{transform:translateX(-110%)}to{transform:translateX(255%)}}',
      runKf,
      '@media (prefers-reduced-motion:reduce){#aurora-effort .ae-flow::before{animation:none}}',
      '@keyframes aurora-thumb-glow{' +
        '0%,100%{box-shadow:0 3px 10px rgba(24,80,170,.35),0 0 0 0 rgba(90,169,240,.55)}' +
        '50%{box-shadow:0 3px 10px rgba(24,80,170,.35),0 0 0 8px rgba(90,169,240,0)}}',
      /* 尊重系统的减少动态偏好 */
      '@media (prefers-reduced-motion:reduce){#aurora-effort input[type=range]::-webkit-slider-runnable-track,' +
        '#aurora-effort input[type=range]::-webkit-slider-thumb{animation:none}}'
    ].join('')
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = css
    document.head.appendChild(el)
  }

  /* 已填充比例（拇指左边的蓝色部分） */
  const setFill = (v) => {
    if (panel) panel.range.style.setProperty('--ae-fill', ((Number(v) / STEPS) * 100).toFixed(2) + '%')
  }

  /* 把跑动角色摆到圆点正上方。range 的可用行程是 [THUMB/2, width - THUMB/2]，
   * 所以拇指中心的 x = 左边界 + THUMB/2 + (value/STEPS) × (width - THUMB)。 */
  const moveRunner = () => {
    if (!panel || !panel.runner) return
    const pr = panel.box.getBoundingClientRect()
    const rr = panel.range.getBoundingClientRect()
    const usable = Math.max(0, rr.width - THUMB)
    const cx = rr.left + THUMB / 2 + (Number(panel.range.value) / STEPS) * usable - pr.left
    const cy = rr.top + rr.height / 2 - pr.top
    const w = Math.round(MOOD_H * 1.25)
    panel.runner.style.left = (cx - w / 2) + 'px'
    /* 底部对齐到【圆点】上沿再留 2px 缝 —— 注意要对齐的是圆点（THUMB，40px）而不是轨道
     * （TRACK，24px）：圆点比轨道上下各高出 8px，只按轨道算的话角色会压在手柄上。 */
    panel.runner.style.top = (cy - THUMB / 2 - MOOD_H - 2) + 'px'
  }

  const setDragging = (on) => {
    if (!panel) return
    if (panel.runner) panel.runner.style.display = on ? 'block' : 'none'
    if (panel.moods) panel.moods.style.opacity = on ? '0' : '1'   /* 拖动时不显示档位立绘 */
    if (on) moveRunner()
  }

  const buildPanel = () => {
    ensureStyle()
    const box = document.createElement('div')
    box.id = PANEL_ID
    box.setAttribute('style', [
      'position:fixed', 'z-index:1200', 'box-sizing:border-box', 'display:none',
      'flex-direction:column', 'justify-content:center', 'gap:9px', 'padding:10px 34px 12px',
      'border-radius:10px', 'background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.72))',
      'font:500 12px/16px system-ui,-apple-system,Segoe UI,sans-serif',
      'color:var(--dsw-alias-label-primary,#0f1115)', 'user-select:none'
    ].join(';'))
    const head = document.createElement('div')
    head.setAttribute('style', 'display:flex;align-items:baseline;justify-content:space-between;gap:8px')
    const left = document.createElement('span')
    left.textContent = '思考强度'
    left.setAttribute('style', 'font-size:11px;color:var(--dsw-alias-label-tertiary,#8a93a8)')
    const value = document.createElement('span')
    value.setAttribute('style', 'font-weight:600;font-size:13px')
    head.appendChild(left)
    head.appendChild(value)
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0'
    range.max = String(STEPS)   /* 连续轨道：拇指跟手，不吸附 */
    range.step = '1'
    range.value = '0'
    range.setAttribute('style', 'width:100%;margin:0;accent-color:var(--dsw-static-deepseek-500,#4176e6);cursor:grab;touch-action:none')
    /* 档位角色立绘：一格一个，绝对定位在自己的刻度上（和下面的标签同一套百分比），
     * 用雪碧图 background-position 取对应那一格。内容在 paintTicks 里按档位数动态生成。 */
    const moods = document.createElement('div')
    moods.setAttribute('style', 'position:relative;width:100%;height:' + MOOD_H + 'px')

    /* 拖动时骑在圆点上的跑动角色。放在面板里绝对定位（面板是 position:fixed，可作参照），
     * 位置由 range 的当前值实时算出 —— 它是“跟着手柄跑”，不是待在档位格里。 */
    const runner = document.createElement('div')
    runner.setAttribute('style', 'position:absolute;display:none;z-index:3;pointer-events:none;' +
      'width:' + Math.round(MOOD_H * 1.25) + 'px;height:' + MOOD_H + 'px;' +
      'background-image:url(' + RUN_URL + ');background-repeat:no-repeat;' +
      'background-size:' + (RUN_FRAMES * 100) + '% 100%;background-position:0% 50%;' +
      'animation:aurora-run ' + (RUN_MS / 1000) + 's linear infinite;' +
      'filter:drop-shadow(0 3px 5px rgba(24,80,170,.28))')

    /* 把 range 和流光层套进一个相对定位容器：流光层正好压在轨道上、随轨道圆角裁切 */
    const trackWrap = document.createElement('div')
    trackWrap.setAttribute('style', 'position:relative;width:100%')
    const flow = document.createElement('div')
    flow.className = 'ae-flow'
    trackWrap.appendChild(range)
    trackWrap.appendChild(flow)
    const ticks = document.createElement('div')
    ticks.setAttribute('style', 'position:relative;height:32px;margin-top:6px')
    const note = document.createElement('div')
    note.setAttribute('style', 'font-size:10px;line-height:14px;color:var(--dsw-alias-state-error-primary,#d94b4b);display:none')
    box.appendChild(head)
    box.appendChild(moods)
    box.appendChild(trackWrap)
    box.appendChild(ticks)
    box.appendChild(note)
    box.appendChild(runner)
    document.body.appendChild(box)

    /* 关键：把鼠标事件挡在这里，不让它冒泡到 document。
     * DSH 的模型菜单在 document 上挂了 mousedown 的 closeOutside（点在菜单外就关闭），
     * 我们的浮层在菜单的 DOM 之外 —— 不挡住的话，按下滑块 = 点了菜单外面 = 菜单立刻关闭，
     * 浮层在 250ms 轮询里被隐藏，拖动还没结束就没了：表现就是【只能点、不能拖】。 */
    box.setAttribute('tabindex', '-1')   /* 让浮层本身可聚焦：点空白处焦点也不会掉到 body */
    const stop = (e) => {
      e.stopPropagation()
      /* 焦点必须留在浮层内：一旦落到 body，应用的 onBlur 会判定“跑出菜单”并 close()。
       * 这里先兜住焦点，随后浏览器按默认行为把焦点交给 range（仍在我们浮层内）。 */
      try { if (!box.contains(document.activeElement)) box.focus({ preventScroll: true }) } catch (err) { /* 忽略 */ }
    }
    for (const type of ['mousedown', 'pointerdown', 'touchstart', 'click']) {
      box.addEventListener(type, stop)
    }
    /* 再加一道【捕获阶段】的屏蔽（只需加一次）。
     * 应用的 closeOutside 挂在 document 的 mousedown 上：元素级 stopPropagation 只有在事件
     * 冒泡到我们元素时才生效，如果应用用捕获阶段监听、或换了别的时机，就拦不住 → 菜单被关掉、
     * 滑块“闪一下就没了”。在 document 捕获阶段先吞掉，target 落在我们浮层里的一律不放行。
     * 只拦 mousedown / click：pointerdown 必须留给元素级监听，否则 range 的拖动状态机会失效。 */
    if (!window.__auroraShield) {
      window.__auroraShield = true
      for (const type of ['mousedown', 'click']) {
        document.addEventListener(type, (e) => {
          if (panel && e.target && panel.box.contains(e.target)) e.stopPropagation()
        }, true)
      }
      /* 焦点屏蔽（0.1.7 的 onBlur 关闭路径）：
       * 新版菜单用 React onBlur 关闭 —— 译成原生就是 focusout 的冒泡：
       *   const onBlur = (e) => { if (relatedTarget 在 root/menu 内) return; close() }
       * 我们的 range 一被按下就会获得焦点（焦点随即离开菜单）→ onBlur 判定“跑出菜单”→ close()，
       * 表现就是【一按滑块菜单就关】。在 document 捕获阶段吞掉“焦点去向是我们的浮层”的 focusout，
       * React 就看不到这次离开；range 的默认行为（拖动、键盘）都不受影响。 */
      document.addEventListener('focusout', (e) => {
        const to = e.relatedTarget
        if (panel && to && panel.box.contains(to)) {
          e.stopPropagation()
          beacon('shielded focusout -> ' + (to.tagName || '?') + '（菜单本会因此关闭）')
        }
      }, true)
      /* 反过来也要挡：从菜单外点回浮层时的 focusin 不必处理，但记一笔便于排查 */
      document.addEventListener('focusin', (e) => {
        if (panel && e.target && panel.box.contains(e.target)) beacon('focusin panel ' + (e.target.tagName || '?'))
      }, true)
    }

    range.addEventListener('pointerdown', () => {
      dragging = true
      dragFrom = st.index
      flow.dataset.on = '1'   /* 按住才亮起流光 */
      setDragging(true)       /* 跑动角色出场、档位立绘隐去 */
    })
    range.addEventListener('pointercancel', finishDrag)
    /* 拖动中：只做预览（文字 + 高亮最近的挡位），拇指保持跟手，不写回 range.value */
    range.addEventListener('input', () => {
      if (!dragging) { dragging = true; dragFrom = st.index; setDragging(true) }
      setFill(range.value)   /* 蓝色填充跟着拇指实时走 */
      moveRunner()           /* 跑动角色跟着拇指走 */
      const i = idxOf(range.value)
      if (i !== previewIndex) {
        previewIndex = i
        paintValue(i)
        paintTicks(i)
      }
    })
    /* 松手结算：跨了挡位就提交，没跨就弹回去 */
    range.addEventListener('change', finishDrag)
    range.addEventListener('pointerup', finishDrag)
    range.addEventListener('blur', finishDrag)
    panel = { box: box, value: value, range: range, ticks: ticks, note: note, flow: flow, moods: moods, runner: runner, sig: '' }
  }

  const render = () => {
    if (!panel) return
    const n = st.efforts.length
    const sig = n + '|' + st.index + '|' + (st.busy ? 1 : 0) + '|' + st.note + '|' + (st.sessionId || '')
    if (panel.sig === sig) return
    panel.sig = sig
    const usable = n >= 2 && !!st.sessionId
    panel.range.disabled = st.busy || !usable
    panel.range.max = String(STEPS)
    /* 拖动中绝不写 range.value：render 每 250ms 会被 place() 调到一次，
     * 一旦在这里回写，拇指就会被拽回刻度，手感立刻断掉。 */
    if (!dragging) {
      panel.range.value = String(valOf(st.index))
      setFill(valOf(st.index))
    }
    paintValue(n === 0 ? -1 : st.index)
    paintTicks(dragging && previewIndex !== null ? previewIndex : st.index)
    panel.note.style.display = st.note ? 'block' : 'none'
    panel.note.textContent = st.note
    panel.box.title = describe()
  }

  const commit = async (i) => {
    if (!st.sessionId || !st.provider || !st.efforts[i]) return
    if (st.busy) { pendingIndex = i; return }
    st.busy = true
    st.index = i
    render()
    try {
      await rpcAny('select', {
        sessionId: st.sessionId, provider: st.provider, model: st.model,
        reasoningEffort: st.efforts[i].id
      })
      st.note = ''
      console.log('[aurora] effort ->', st.efforts[i].id)
    } catch (e) {
      st.note = '设置失败: ' + (e && e.message ? e.message : e)
      console.warn('[aurora] selectModel failed', e)
    }
    st.busy = false
    render()
    if (pendingIndex !== null) {
      const next = pendingIndex
      pendingIndex = null
      commit(next)
    }
  }

  const stopObserving = () => {
    if (observer) { observer.disconnect(); observer = null }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  }

  const unhideRows = () => {
    for (const el of hiddenRows) {
      try { el.style.removeProperty('opacity'); el.style.removeProperty('pointer-events') } catch (e) {}
    }
    hiddenRows = []
  }

  /* 熔断：宁可不生效，也绝不再卡死 */
  const disableOverlay = (why) => {
    if (st.disabled) return
    st.disabled = true
    stopObserving()
    unhideRows()
    if (panel) panel.box.style.display = 'none'
    st.placed = false
    st.note = '浮层已停用: ' + why
    console.warn('[aurora] overlay disabled:', why)
  }

  /* 找原生档位行：模型列表也是 menuitemradio（带 title=模型名），必须三重校验才敢动 */
  const nativeRows = () => {
    const names = st.efforts.map((e) => e.name)
    const all = document.querySelectorAll('[role="menuitemradio"]')
    st.radios = all.length
    st.matched = 0
    if (names.length < 2) return []
    const matched = new Map()
    for (const el of all) {
      if (el.hasAttribute('title')) continue
      if (el.getClientRects().length === 0) continue
      const txt = (el.textContent || '').trim()
      const hit = names.find((n) => txt === n || txt.indexOf(n) === 0)
      if (hit && !matched.has(hit)) matched.set(hit, el)
    }
    st.matched = matched.size
    if (matched.size !== names.length) return []
    return names.map((n) => matched.get(n))
  }

  /* 菜单自己的状态：触发器的 aria-expanded，用来判断“菜单被关了”还是“只有我们的浮层被藏了” */
  const menuState = () => {
    const ts = document.querySelectorAll('[aria-haspopup="menu"][aria-expanded]')
    let openCount = 0
    for (const t of ts) if (t.getAttribute('aria-expanded') === 'true') openCount++
    const rows = document.querySelectorAll('[role="menuitemradio"]').length
    return 'triggers=' + ts.length + ' open=' + openCount + ' radios=' + rows
  }

  /* 状态变化时打一行，用来回放“闪一下”的过程（相同状态不重复打） */
  let lastPlaceLog = ''
  const logPlace = (rows, visible) => {
    const line = 'radios=' + st.radios + ' matched=' + st.matched + ' rows=' + rows.length +
      ' efforts=' + st.efforts.length + ' visible=' + visible + ' flash=' + st.flash +
      (st.note ? ' note=' + st.note : '')
    if (line !== lastPlaceLog) {
      lastPlaceLog = line
      console.log('[aurora] ' + line)
      beacon('place ' + line + ' | ' + menuState())
    }
  }

  const place = () => {
    if (st.disabled) return
    try {
      const rows = nativeRows()
      if ((rows.length > 0) !== st.placed) st.flash++   /* 计数：每闪一次 +1 */
      st.rows = rows.length
      if (rows.length === 0) {
        unhideRows()
        if (panel) panel.box.style.display = 'none'
        st.placed = false
        lastSig = ''
        logPlace(rows, false)
        return
      }
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
      for (const el of rows) {
        const q = el.getBoundingClientRect()
        if (q.left < l) l = q.left
        if (q.top < t) t = q.top
        if (q.right > r) r = q.right
        if (q.bottom > b) b = q.bottom
      }
      const sig = [l, t, r, b, rows.length].join(',')
      if (!panel) buildPanel()
      if (sig !== lastSig) {
        lastSig = sig
        const same = hiddenRows.length === rows.length && hiddenRows.every((el, i) => el === rows[i])
        if (!same) { unhideRows(); hiddenRows = rows.slice() }
        for (const el of rows) {
          /* 关键：用 opacity:0 而不是 visibility:hidden！
           * 0.1.7 的菜单新增了 onBlur 关闭：
           *   const onBlur = (e) => { if (relatedTarget 在 root/menu 内) return; close() }
           * 而切到档位面板时，应用会 focus 那一行被选中的档位（paneFocus 的 'drill' 分支）。
           * visibility:hidden 会让元素【不可聚焦】→ focus 落回 body → onBlur 认为焦点跑出菜单 → close()，
           * 于是「滑刚出现就被关掉」。opacity:0 的元素依然可聚焦 ✔ 也不改变布局 ✔。
           * pointer-events:none 让点击穿透到菜单本身（仍然是菜单内的 mousedown，不会触发 closeOutside）。 */
          /* 幂等写入：值已经对了就不再写，减少无谓的属性变更（将来若观察 attributes 也不会自激） */
          if (el.style.opacity !== '0') el.style.setProperty('opacity', '0', 'important')
          if (el.style.pointerEvents !== 'none') el.style.setProperty('pointer-events', 'none', 'important')
        }
        /* 面板不再强行塞进原生行那块矩形：给它一个最小宽度（4 个中文档位名要一行放得下），
         * 以原生行区域为中心摆放，高度自适应后垂直居中。所以它会比菜单略宽一点。 */
        const rowsW = r - l
        const rowsH = b - t
        const boxW = Math.max(rowsW, PANEL_MIN_W)
        panel.box.style.display = 'flex'
        panel.box.style.width = boxW + 'px'
        panel.box.style.left = (l + rowsW / 2 - boxW / 2) + 'px'
        panel.box.style.height = 'auto'
        panel.box.style.top = t + 'px'
        const boxH = panel.box.offsetHeight   /* 唯一一次读布局，用来垂直居中 */
        panel.box.style.top = (t + Math.max(0, (rowsH - boxH) / 2)) + 'px'
      }
      st.placed = true
      render()
      logPlace(rows, true)
      if (dragging) moveRunner()   /* 拖动中若面板位置变了，角色跟着重新贴合 */
    } catch (e) {
      disableOverlay('place 抛错: ' + (e && e.message ? e.message : e))
    }
  }

  /* 不计入熔断次数的“帧内同步”：由用户输入（点击/键盘）驱动，天然有界。
   * 熔断器是防自激回路的，把输入事件也计进去会被误判成 60/s 超限而停用浮层。 */
  let syncScheduled = false
  const scheduleSync = () => {
    if (syncScheduled || st.disabled) return
    syncScheduled = true
    requestAnimationFrame(() => {
      syncScheduled = false
      if (!st.disabled) place()
    })
  }

  const schedulePlace = () => {
    if (st.disabled || scheduled) return
    const now = Date.now()
    placeTimes = placeTimes.filter((x) => now - x < 1000)
    placeTimes.push(now)
    if (placeTimes.length > 60) { disableOverlay('调度过于频繁 (>60/s)'); return }
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      st.places++
      place()
    })
  }

  /* ─────────── 6) 启动 ─────────── */
  const start = () => {
    swap(document.body)
    /* 这个 Observer 只干文案替换，绝不做定位 —— 定位改由定时器驱动。
     * 理由：Observer 回调里做 DOM 写入，一旦写入落在自己的观察范围内就会自激（v3 卡死）；
     * 而定时器天然不会被自己触发，结构上就不可能形成回路。
     * 另外 swap 是幂等的：换成 TO 之后不再匹配 FROM，不会反复写同一个节点触发新记录。 */
    observer = new MutationObserver((records) => {
      mutationSeq++   /* 给自检用：文档动过才值得重新扫 */
      let needPlace = false   /* 只有「档位行刚被插进来」才值得立刻重摆浮层 */
      for (const rec of records) {
        if (panel && rec.target && panel.box.contains(rec.target)) continue
        if (rec.type === 'characterData') { swap(rec.target); continue }
        for (const n of rec.addedNodes) {
          /* 菜单一插入就立刻摆浮层（rAF 在同一帧、绘制之前），这样原生那几行根本不会被画出来，
           * 观感上滑块是“直接出现”而不是“先原生、250ms 后被替换”。
           * 只认档位行这个信号，避免流式输出时每个 token 都触发（那会撞上熔断）。 */
          if (!needPlace && n.nodeType === 1 && n.querySelector && n.querySelector('[role="menuitemradio"]')) needPlace = true
          swap(n)
        }
      }
      if (needPlace && !st.disabled) schedulePlace()
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    document.addEventListener('scroll', () => { if (st.placed) schedulePlace() }, true)
    window.addEventListener('resize', () => { if (st.placed) schedulePlace() })
    /* 切到档位面板【可能是纯 CSS display 切换】（类名/样式变化），而我们对 attributes 是
     * 故意不观察的（怕自己的行内样式写入自激），所以那种情况收不到 mutation 通知、
     * 只能等 250ms 轮询 → 原生那几行先被画出来。改成用输入事件驱动：
     * 捕获阶段先预约一帧，React 的离散事件是同步提交的，rAF 跑在提交之后、绘制之前，
     * 于是同一帧内浮层就摆好了，原生行根本来不及显示。 */
    for (const type of ['pointerdown', 'mousedown', 'click', 'keydown']) {
      document.addEventListener(type, () => scheduleSync(), true)
    }
    /* 定位的唯一驱动：250ms 轮询。菜单开/关、位置变化都会在一个 tick 内被发现，
     * 而轮询不可能被自己的 DOM 写入触发 —— 这是这次改动的核心安全保证。 */
    tickTimer = setInterval(() => { if (!st.disabled) place() }, 250)
    setInterval(selfCheck, 5000)   /* 文案钩子自检，仅在上次扫描后文档有变化时才真的扫 */
    document.documentElement.dataset.aurora = 'on'
    beacon('armed href=' + location.href + ' ua=' + navigator.userAgent.slice(-30))
    bootstrapSession()
    console.log('[aurora] armed: thinking label + in-menu effort slider')
  }

  if (!document.body) document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
