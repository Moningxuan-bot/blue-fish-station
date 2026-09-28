/**
 * 面板 ↔ 宿主 的传输层。
 *
 * 为什么用普通 HTTP 路由而不是 DSH 的 Remote 机制：Remote 需要构建期生成的
 * `/remote` 声明，那是仓库内的产物；第三方插件走不通（详见 DESIGN.md 第 9 节）。
 * `ctx.webServer.register` 的契约恰好够用 —— 文档明写 handler
 * "owns the full response lifecycle (may hold the response open, e.g. SSE)"。
 *
 * 鉴权：这些路由**不经过** /api 的浏览器信任栅栏（aurora 的自建资源路由已经
 * 证实了这一点），所以插件自己守门。令牌由 index tap 注入页面，
 * 每个宿主进程启动时重新生成一次。
 *
 * 流格式：NDJSON（每行一个 JSON 对象），不是 SSE 帧。原因是浏览器侧要用 POST +
 * fetch 读流，而 EventSource 只支持 GET。NDJSON 解析同样简单，且不受 EventSource
 * 的自动重连语义干扰。
 */

import { readFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { expandPrompt } from './expand.js'
import { resolvePreset, specInventory } from './presets.js'
import { generateImage, persistResult } from './generate.js'
import { keyStatus, writeApiKeyFile, dshHome } from './credentials.js'

/**
 * 已知会被这台中转站静默忽略的参数。
 * 面板据此把这些控件置灰并说明原因 —— 让人在选择之前就知道代价，
 * 而不是选了、付了钱、才发现没生效。
 */
const IGNORED_BY_RELAY = [
  { key: 'background', note: '该中转站接受但忽略 background（返回的 PNG 永远不透明）' },
  { key: 'output_format', note: '该中转站接受但忽略 output_format（永远返回 PNG）' },
  { key: 'output_compression', note: '该中转站接受但忽略 output_compression' },
]

/** 本进程出过的图：id → 绝对路径。读取路由只认这里登记过的路径，不接受任意路径请求。 */
const generated = new Map()
let generatedSeq = 0

/**
 * 图片落盘目录。
 *
 * config.outputDir 在上层（index.js 的 resolveConfig）已解析成绝对路径，这里只做兜底。
 * **踩过的坑**：早先在这里按 `process.cwd()` 解析相对路径，而 dsh 是从 npm 全局目录启动的，
 * 于是图被写进了 `<npm 全局>/node_modules/@deepseek-ai/dsh/.dsh-images/` ——
 * 用户找不到，还可能被 DSH 升级连带删除。现在相对路径一律按 $DSH_HOME 解析。
 */
function resolveOutDir(config) {
  const raw = String((config && config.outputDir) || '').trim()
  if (raw === '') return join(dshHome(), 'image-station', 'images')
  return isAbsolute(raw) ? raw : join(dshHome(), raw)
}

/**
 * 路由前缀。
 *
 * **踩过的坑**：`ctx.webServer.register({kind:'prefix'})` 只决定这个 handler 接手哪些
 * 请求，**不会把前缀从 req.url 里剥掉** —— 处理器拿到的永远是完整 pathname。
 * 早先按"已剥前缀"写，结果每条请求都落进 404 分支（而鉴权先跑，所以表面上像
 * "认证过了但没这个路由"）。前缀必须在处理器里自己去掉。
 */
const PREFIX = '/image-station'

/** 面板能看到的配置：只给安全的字段，绝不回吐任何密钥，也不回吐规范正文。 */
function publicConfig(config) {
  return {
    presets: (config.presets || []).map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      version: p.version || '',
      file: p.file || '',
      hasTags: Array.isArray(p.tags) && p.tags.length > 0,
      specChars: typeof p.system === 'string' ? p.system.length : 0,
    })),
    defaultPresetId: config.defaultPresetId,
    outputLanguage: config.outputLanguage,
    streamReasoning: config.streamReasoning !== false,
    /** 出图侧的面板所需事实。不含 Key，也不含任何上游凭据。 */
    image: {
      model: config.model,
      baseUrl: config.baseUrl,
      defaults: config.image,
      outputDir: config.outputDir,
      /** 凭据状态：找过哪些地方、有没有命中、以及该往哪个文件写。脱敏，不含 Key。 */
      credentials: keyStatus(config),
      pricing: config.pricing,
      retries: config.retries,
      ignoredParams: IGNORED_BY_RELAY,
      /** 实测的每张耗时区间，用来给用户一个预期，而不是让他以为卡死了。 */
      typicalSeconds: [18, 26],
      /** 实测 quality=high 反复触发上游容量错误，medium 稳定；面板只给 low/medium 并说明。 */
      qualityNote: '实测 quality=high 会频繁触发上游"无可用账号"，故面板只提供 low / medium。',
    },
    /** 出厂规范文件的清单：面板用它显示"知识来自哪个文件"。 */
    specFiles: specInventory().map((s) => ({
      id: s.id,
      label: s.label,
      file: s.file,
      version: s.version,
      chars: s.chars,
    })),
  }
}

/** 从 Authorization 头取 bearer 令牌。 */
function bearerOf(req) {
  const raw = req.headers && (req.headers.authorization || req.headers.Authorization)
  if (typeof raw !== 'string') return ''
  const m = raw.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : ''
}

/**
 * 从 query 取令牌。
 *
 * 为什么必须有这条：`<img src="...">` **无法携带 Authorization 头**。图片读取路由只认
 * bearer 时，浏览器自己的取图请求会拿到 401 —— 这是实测踩到的（出图成功、图却显示不出来）。
 * DSH 自己的 index 就是用 `?token=` 做浏览器侧鉴权的，这里沿用同一套做法。
 * query 里的令牌会落进浏览器历史，与本机 DSH 的既有取舍一致。
 */
function queryTokenOf(url) {
  const t = url.searchParams.get('token')
  return typeof t === 'string' ? t : ''
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读请求体，带上限，避免一次畸形请求把内存吃光。 */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error(`请求体超过上限 ${limitBytes} 字节`))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 注册全部路由。
 *
 * @param {object} args
 * @param {object} args.ctx        宿主 cordis 上下文。
 * @param {object} args.config     已合并的插件配置。
 * @param {string} args.token      本进程的会话令牌。
 * @param {() => object} args.selectionOf 读取当前目标模型选择。
 * @returns {() => void} 撤销全部路由的 disposer。
 */
export function registerRoutes({ ctx, config, token, selectionOf }) {
  const disposers = []

  /**
   * DSH 的浏览器会话 cookie 名。
   *
   * 不硬编码：写在代码里就会跟着 DSH 改版失效，而且是猜。改成**从首页响应里学**——
   * 那是一个同源、无需本插件参与的真实请求，`set-cookie` 里必然带着会话名。
   * 学不到时留空，此时只要求"请求带了任意 cookie"，宽松但聊胜于无（见 /token 的说明）。
   */
  let sessionCookieName = ''
  ctx.effect(() => {
    let alive = true
    const base = 'http://' + (ctx.webServer.host || '127.0.0.1') + ':' + ctx.webServer.port
    fetch(base + '/')
      .then((res) => {
        if (!alive) return
        const list = res.headers.getSetCookie ? res.headers.getSetCookie() : []
        for (const raw of list) {
          const name = String(raw).split('=')[0].trim()
          if (name !== '') {
            sessionCookieName = name
            break
          }
        }
        if (sessionCookieName !== '') {
          console.log('[imagestation] session cookie name learned: ' + sessionCookieName)
        }
      })
      .catch(() => {
        /* 学不到就退化成宽松判据，不影响功能 */
      })
    return () => {
      alive = false
    }
  }, 'image-station: learn session cookie name')

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const fullPath = url.pathname
    // The prefix router hands us the FULL pathname (see PREFIX's note).
    const path = fullPath.startsWith(PREFIX) ? fullPath.slice(PREFIX.length) || '/' : fullPath
    const method = (req.method || 'GET').toUpperCase()

    if (process.env.DSH_IMAGESTATION_DEBUG === '1') {
      console.log(
        '[imagestation] route hit: ' + method + ' ' + fullPath + ' -> ' + path +
          ' auth=' + (bearerOf(req) === token ? 'match' : 'MISMATCH'),
      )
    }

    /*
     * GET /token —— 让面板能从陈旧令牌里自愈。
     *
     * 为什么需要它：页面里的令牌来自**渲染该页面时的宿主进程**。浏览器缓存了旧 bundle、
     * 或同时开着两个工作站窗口（各自是独立宿主进程）时，页面手上的令牌就与当前宿主不一致，
     * 面板会一直报 401 而用户无从下手。这个端点让面板能重新问一次并自己重试 ——
     * **故障恢复不该要求用户理解令牌机制**。
     *
     * 为什么它不是"把鉴权拆了"：
     *   · 要求带上 DSH 自己的浏览器会话 cookie（同源请求浏览器必然自动携带，
     *     而 curl / 别的页面 / 别的端口都不会带上这个域的会话）。实测：不带 cookie
     *     访问首页会被 /api 的信任栅栏挡回 401，所以这个 cookie 是真凭据，不是形式。
     *   · 服务只监听回环地址。
     *
     * 边界如实说：能跑在本页面里的脚本本来就能读到页面上的令牌，所以这道检查挡的是
     * "本机任意页面**无意间**驱动本面板"，**不是**对抗本机代码的强边界 ——
     * 与 token 路由的既有取舍一致。
     */
    if (path === '/token' && method === 'GET') {
      const cookieName = sessionCookieName || ''
      const cookieHeader = String((req.headers && req.headers.cookie) || '')
      const hasSession =
        cookieHeader !== '' &&
        (cookieName === '' || cookieHeader.includes(cookieName + '='))
      if (!hasSession) {
        sendJson(res, 403, {
          error: 'no-session',
          message: '取令牌需要 DSH 的浏览器会话 cookie。请从工作站窗口打开本页面。',
        })
        return
      }
      sendJson(res, 200, { token })
      return
    }

    if (bearerOf(req) !== token && queryTokenOf(url) !== token) {
      /*
       * 401 必须**自我说明**，否则用户只看到"令牌不对"却无从下手。
       *
       * 只报长度与末四位，不回显令牌本身 —— 诊断信息不该变成泄漏渠道。
       */
      const got = bearerOf(req) || queryTokenOf(url) || ''
      const tail = (s) => (s ? s.slice(-4) + '（' + s.length + ' 字符）' : '（空）')
      const headerRaw = req.headers && (req.headers.authorization || req.headers.Authorization)
      sendJson(res, 401, {
        error: 'unauthorized',
        message: '会话令牌不匹配：页面手上的令牌与宿主当前的令牌不同。',
        diagnostic: {
          receivedFrom: bearerOf(req) ? 'Authorization 头' : queryTokenOf(url) ? 'query 参数' : '两处都没有',
          receivedTail: tail(got),
          expectedTail: tail(token),
          authorizationHeaderPresent: typeof headerRaw === 'string',
        },
        hint:
          headerRaw === undefined
            ? '请求里完全没带 Authorization 头。面板会自动重取令牌并重试一次；若仍失败，按 Ctrl+Shift+R 强制刷新。'
            : '带了头但值不匹配，通常是同时开着两个工作站窗口（各自是独立宿主进程）。关掉多余窗口只留一个即可；面板也会自动重取令牌重试。',
        retryable: true,
      })
      return
    }

    // ---- GET /presets：面板启动时拉一次，拿到预设清单与默认项 ----
    if (path === '/presets' && method === 'GET') {
      let selection = null
      let modelError = null
      try {
        selection = selectionOf()
      } catch (err) {
        modelError = err && err.message ? err.message : String(err)
      }
      sendJson(res, 200, {
        ...publicConfig(config),
        model: selection ? { provider: selection.provider, model: selection.model } : null,
        modelError,
      })
      return
    }

    // ---- POST /expand：流式扩写 ----
    if (path === '/expand' && method === 'POST') {
      let payload
      try {
        const raw = await readBody(req, 64 * 1024)
        payload = raw ? JSON.parse(raw) : {}
      } catch (err) {
        sendJson(res, 400, { error: 'bad-request', message: err.message })
        return
      }

      const { preset, requestedId, fallback } = resolvePreset(config.presets, payload.presetId)

      let selection
      try {
        selection = selectionOf()
      } catch (err) {
        sendJson(res, 503, {
          error: 'no-model',
          message: err && err.message ? err.message : '拿不到可用的模型。',
        })
        return
      }

      // 头部一次性写定，然后把每个事件作为一行 JSON 推进去。
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      })
      const write = (obj) => {
        if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n')
      }

      // 客户端断开时中止上游 LLM 调用，别让它继续烧 token。
      const ac = new AbortController()
      const onClose = () => ac.abort()
      res.on('close', onClose)

      write({
        type: 'start',
        presetId: preset.id,
        presetFallback: fallback,
        requestedPresetId: requestedId,
        model: { provider: selection.provider, model: selection.model },
      })

      try {
        for await (const event of expandPrompt({
          ctx,
          preset,
          input: payload.text,
          config,
          tags: preset.tags,
          selection,
          signal: ac.signal,
        })) {
          if (event.type === 'reasoning' && config.streamReasoning === false) continue
          write(event)
        }
      } catch (err) {
        write({
          type: 'error',
          message: err && err.message ? err.message : String(err),
          aborted: ac.signal.aborted,
        })
      } finally {
        res.removeListener('close', onClose)
        if (!res.writableEnded) res.end()
      }
      return
    }

    // ---- POST /key：把 Key 写进 Key 文件（写盘后免重启即可生效） ----
    if (path === '/key' && method === 'POST') {
      let payload
      try {
        const raw = await readBody(req, 8 * 1024)
        payload = raw ? JSON.parse(raw) : {}
      } catch (err) {
        sendJson(res, 400, { error: 'bad-request', message: err.message })
        return
      }
      const key = typeof payload.key === 'string' ? payload.key.trim() : ''
      if (key === '') {
        sendJson(res, 400, { error: 'empty-key', message: 'Key 是空的。' })
        return
      }
      try {
        const written = writeApiKeyFile(config, key)
        // 立刻重读一次，确认写进去真的能被解析出来 —— 不假定写入等于生效。
        const after = keyStatus(config)
        sendJson(res, 200, {
          ok: after.hasKey,
          written,
          credentials: after,
          message: after.hasKey
            ? '已写入并确认可读，下一次出图即可生效，不必重启。'
            : '已写入，但重新读取时没解析到 Key，请检查文件内容。',
        })
      } catch (err) {
        sendJson(res, 500, { error: 'write-failed', message: err && err.message ? err.message : String(err) })
      }
      return
    }

    // ---- POST /generate：出图（NDJSON 流，推进度与结果） ----
    if (path === '/generate' && method === 'POST') {
      let payload
      try {
        const raw = await readBody(req, 4 * 1024 * 1024)
        payload = raw ? JSON.parse(raw) : {}
      } catch (err) {
        sendJson(res, 400, { error: 'bad-request', message: err.message })
        return
      }

      const prompt = String(payload.prompt == null ? '' : payload.prompt).trim()
      if (prompt === '') {
        sendJson(res, 400, { error: 'empty-prompt', message: '提示词是空的。' })
        return
      }

      // 面板传来的参数与 config 默认值合并；面板显式给的值优先。
      const params = Object.assign({}, config.image, payload.params || {})
      // 面板可能带参考图（图生图）与蒙版（局部重绘）。
      const decodeUpload = (u) => {
        if (!u || typeof u.dataBase64 !== 'string') return null
        return {
          data: Buffer.from(u.dataBase64, 'base64'),
          name: typeof u.name === 'string' ? basename(u.name) : 'upload.png',
          type: typeof u.type === 'string' ? u.type : 'image/png',
        }
      }

      const refImage = decodeUpload(payload.image)
      // 实测：edits 忽略 size（传 1024x1024 回来 1254x1254）。与其让用户以为设了尺寸，
      // 不如发之前就丢掉并明说 —— 输出尺寸由输入图决定。
      const droppedForEdits = []
      if (refImage && params.size) {
        droppedForEdits.push({
          key: 'size',
          value: params.size,
          reason: '图生图时该中转站忽略 size，输出尺寸跟随输入图',
        })
        delete params.size
      }

      const res2 = res
      res2.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      })
      const write = (obj) => {
        if (!res2.writableEnded) res2.write(JSON.stringify(obj) + '\n')
      }

      const ac = new AbortController()
      const onClose = () => ac.abort()
      res2.on('close', onClose)

      write({ type: 'start', model: config.model, params, endpoint: refImage ? 'edits' : 'generations' })

      try {
        const result = await generateImage({
          config,
          prompt,
          params,
          image: refImage,
          mask: decodeUpload(payload.mask),
          signal: ac.signal,
          onProgress: (message) => write({ type: 'progress', message }),
        })
        result.requestedParams = params
        // 面板侧剥离的 size 也要进警告，否则用户会以为设了尺寸却没生效。
        result.droppedParams = (result.droppedParams || []).concat(droppedForEdits)

        const persisted = persistResult({
          result,
          config,
          outDir: resolveOutDir(config),
          namePrefix: 'station',
        })

        // 登记图片，供 /image/<id> 读取。只登记本进程生成的路径。
        const images = persisted.saved.map((s) => {
          const id = 'img' + ++generatedSeq
          generated.set(id, s.file)
          return {
            id,
            // 令牌放 query：<img src> 带不了 Authorization 头。
            url: PREFIX + '/image/' + id + '?token=' + encodeURIComponent(token),
            file: s.file,
            name: basename(s.file),
            width: s.width,
            height: s.height,
            format: s.format,
            bytes: s.bytes,
          }
        })

        write({
          type: 'done',
          images,
          warnings: persisted.warnings,
          usage: persisted.usage,
          cost: persisted.cost,
          revisedPrompt: persisted.revisedPrompt,
          ms: persisted.ms,
          endpoint: persisted.endpoint,
          attempts: result.attempts,
          /** 这批图落在哪 —— 面板要显示绝对路径，否则用户不知道去哪儿找。 */
          directory: persisted.directory,
        })
      } catch (err) {
        write({
          type: 'error',
          message: err && err.message ? err.message : String(err),
          aborted: ac.signal.aborted,
          attempts: err && err.attempts ? err.attempts : undefined,
        })
      } finally {
        res2.removeListener('close', onClose)
        if (!res2.writableEnded) res2.end()
      }
      return
    }

    // ---- GET /image/<id>：读回本进程生成过的图 ----
    if (path.startsWith('/image/') && method === 'GET') {
      const id = path.slice('/image/'.length)
      const file = generated.get(id)
      if (!file) {
        sendJson(res, 404, { error: 'unknown-image', message: '这张图不在本进程的出图登记里。' })
        return
      }
      let body
      try {
        body = readFileSync(file)
      } catch (err) {
        sendJson(res, 410, { error: 'image-gone', message: '文件已不在磁盘上：' + basename(file) })
        return
      }
      res.writeHead(200, {
        'content-type': file.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png',
        'content-length': body.length,
        // 内容按 id 固定不变，可以长缓存；文件名带时间戳，不会互相覆盖。
        'cache-control': 'private, max-age=86400',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }

    sendJson(res, 404, { error: 'not-found', path })
  }

  disposers.push(ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }))
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* 撤销失败不该掩盖原始错误 */
      }
    }
  }
}
