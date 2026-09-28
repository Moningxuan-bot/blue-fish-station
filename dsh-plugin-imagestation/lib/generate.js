/**
 * 出图核心：调 OpenAI 兼容的出图接口，落盘，报告真实的用法与花费。
 *
 * 下面这张能力表是在**一台真实中转站**上实测出来的（具体服务地址与模型名属于部署方配置，
 * 不写进仓库）。它不是对某个服务的描述，而是提醒：不同中转站差异极大，别假设官方行为：
 *
 *   ✓ /v1/images/generations   可用，返回 data[].b64_json + data[].revised_prompt + usage
 *   ✓ size                     真生效（1024x1024 / 1536x1024 / 1024x1536 像素精确匹配）
 *   ✓ n                        生效（n=2 真的回两张）
 *   ✓ /v1/images/edits         可用（multipart：model + prompt + image）
 *   ✓ mask 局部重绘            可用，且严格按蒙版边界重绘（实测左半黑=保留、右半白=重绘）
 *   ✗ background               接受但**静默忽略**（要 transparent，回来 PNG colorType=2 无 alpha）
 *   ✗ output_format            接受但**静默忽略**（要 webp，回来还是 PNG）
 *   ? moderation low           接受，无从验证
 *   ! 上游会间歇性枯竭          HTTP 503 "No available compatible accounts" → 必须重试
 *   ! 耗时 18–26 秒/张          不是超时，是正常速度，界面必须给出预期
 *
 * **最重要的一条**：中转站可能"接受参数但不生效"，所以**绝不信任 200** ——
 * 下单前剥离已知无效参数并明确告知，拿到图后校验真实像素，不一致就在结果里挂警告。
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveApiKey } from './credentials.js'

/** 实测确认无效的参数：送过去只会增加被上游拒的概率，不如剥掉并告知。 */
const IGNORED_PARAMS = ['background', 'output_format', 'output_compression']

/** 上游容量枯竭的判据：这是"稍后重试能成功"，不是"请求有问题"。 */
function isCapacityError(status, bodyText) {
  if (status === 429 || status === 502 || status === 503 || status === 524) return true
  return (
    bodyText.includes('No available compatible accounts') ||
    bodyText.includes('upstream') ||
    bodyText.includes('rate limit')
  )
}

/** 从 base64 里读出 PNG 的真实尺寸与是否带 alpha —— 用来验证 size/background 到底有没有生效。 */
export function inspectPng(bytes) {
  const isPng = bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG'
  if (!isPng) {
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8
    const isWebp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
    return { format: isJpeg ? 'JPEG' : isWebp ? 'WebP' : 'unknown', width: null, height: null, hasAlpha: false }
  }
  return {
    format: 'PNG',
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    // PNG color type 在第 25 字节（IHDR 内）：6 = RGBA，4 = GA，其余无 alpha
    hasAlpha: bytes[25] === 6 || bytes[25] === 4,
    colorType: bytes[25],
  }
}

/**
 * 算这次调用的花费。
 *
 * **以 flatPricePerImage 为准**：那是唯一经服务方仪表盘核实的数字
 * （实测：每次固定 $0.0300，与提示词长短、尺寸、张数无关）。
 *
 * 端点同时返回 usage，但**不能用它反推账单**：仪表盘显示 1,518 tokens，
 * 本地实测合计约 1,090 —— 两者口径不同（仪表盘大概含上游内部开销）。
 * 所以 token 口径只当一个自检：配置了单价后若反推值与包价差得离谱，就明确告警，
 * 而不是默默显示一个自己都不信的数字。
 */
export function computeCost(usage, pricing) {
  const p = pricing || {}

  const inTok = usage ? Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) : 0
  const outTok = usage ? Number(usage.output_tokens ?? usage.completion_tokens ?? 0) : 0
  const inRate = Number(p.inputUsdPerMillion ?? 0)
  const outRate = Number(p.outputUsdPerMillion ?? 0)
  const hasTokenRates = inRate > 0 || outRate > 0
  const tokenUsd = hasTokenRates ? (inTok / 1e6) * inRate + (outTok / 1e6) * outRate : null

  const flat = Number.isFinite(p.flatPricePerImage) ? p.flatPricePerImage : null
  const factor = Number.isFinite(p.sanityFactor) ? p.sanityFactor : 3

  if (flat !== null) {
    const out = {
      usd: flat,
      basis: 'flat',
      detail: '包价 ' + flat + ' USD/张' + (inTok || outTok ? '（本次 in ' + inTok + ' / out ' + outTok + ' tok）' : ''),
      tokenEstimateUsd: tokenUsd,
    }
    if (tokenUsd !== null && tokenUsd > 0) {
      const ratio = tokenUsd > flat ? tokenUsd / flat : flat / tokenUsd
      if (ratio > factor) {
        out.warning =
          '计费口径可能配错了：包价算出 $' + flat.toFixed(6) +
          '，而配置的 token 单价反推是 $' + tokenUsd.toFixed(6) +
          '（相差 ' + ratio.toFixed(1) + ' 倍）。请核对中转站仪表盘后改 config.pricing。'
      }
    }
    return out
  }

  if (tokenUsd === null) {
    return { usd: null, basis: 'unknown', detail: usage ? '价格未配置' : '没有用量数据' }
  }
  return {
    usd: tokenUsd,
    basis: 'tokens',
    detail: 'in ' + inTok + '×' + inRate + '/M + out ' + outTok + '×' + outRate + '/M',
  }
}

/** 把用户选择的参数收敛成这个中转站真正认的集合，并回报被丢掉的部分。 */
function sanitizeParams(params, config) {
  const dropped = []
  const out = {}

  if (params.size && params.size !== 'auto') out.size = params.size
  if (params.quality && params.quality !== 'auto') {
    // 实测 high 反复触发上游容量错误，medium 稳定成功；不禁止，但要让人知道代价。
    out.quality = params.quality
  }
  if (Number.isFinite(params.n) && params.n > 1) out.n = Math.min(Math.max(1, Math.floor(params.n)), 10)

  for (const key of IGNORED_PARAMS) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
      dropped.push({ key, value: params[key], reason: '实测该中转站接受此参数但不生效' })
    }
  }
  return { params: out, dropped }
}

/**
 * 调一次出图（文生图或图生图）。
 *
 * @param {object} a
 * @param {object} a.config        插件配置（baseUrl / model / 超时 / 重试 / 价格）
 * @param {string} a.prompt        提示词
 * @param {object} [a.params]      size / quality / n / background / output_format
 * @param {{data:Buffer,name:string,type:string}} [a.image] 参考图（给了就走 edits）
 * @param {{data:Buffer,name:string,type:string}} [a.mask]  蒙版（需同时给 image）
 * @param {AbortSignal} [a.signal]
 * @param {(msg:string)=>void} [a.onProgress]
 */
export async function generateImage(a) {
  const config = a.config || {}
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '')
  const resolved = resolveApiKey(config)
  const apiKey = resolved.key
  if (!baseUrl) throw new Error('没有配置出图接口地址（config.baseUrl）。')
  if (!apiKey) {
    // 报错必须说清"找过哪儿、怎么修"，否则用户只能干瞪眼。
    throw new Error(
      '没有找到出图接口的 Key。已查找：\n' +
        resolved.sources.map((s) => '  · ' + s.where).join('\n') +
        '\n修法（二选一）：\n' +
        '  · 写进 Key 文件（推荐，改完不用重启）： ' + resolved.filePath + '\n' +
        '    内容一行：' + resolved.envName + '=sk-...\n' +
        '  · 或设为环境变量 ' + resolved.envName + '（从桌面图标启动时，setx 之后必须重开工作站）',
    )
  }

  // 模型名没有合理默认 —— 它是部署方配置的一部分（见 README「配置」）。
  // 这里只做兜底，给出占位符而不是某个具体服务的型号。
  const model = String(config.model || 'your-image-model')
  const { params, dropped } = sanitizeParams(a.params || {}, config)
  const useEdits = Boolean(a.image)

  const url = baseUrl + (useEdits ? '/v1/images/edits' : '/v1/images/generations')
  let body
  const headers = { authorization: 'Bearer ' + apiKey }
  if (useEdits) {
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', a.prompt)
    for (const [k, v] of Object.entries(params)) form.append(k, String(v))
    form.append('image', new Blob([a.image.data], { type: a.image.type || 'image/png' }), a.image.name || 'image.png')
    if (a.mask) {
      form.append('mask', new Blob([a.mask.data], { type: a.mask.type || 'image/png' }), a.mask.name || 'mask.png')
    }
    body = form
  } else {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(Object.assign({ model, prompt: a.prompt }, params))
  }

  const maxAttempts = Math.max(1, Number(config.retries ?? 4) + 1)
  const timeoutMs = Number(config.timeoutMs ?? 180000)
  const attempts = []

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    if (a.signal) {
      if (a.signal.aborted) throw new Error('已取消。')
      a.signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    const started = Date.now()

    try {
      if (a.onProgress) {
        a.onProgress(
          '第 ' + attempt + '/' + maxAttempts + ' 次请求（' + model + '，通常 20 秒左右）',
        )
      }
      const res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal })
      const text = await res.text()
      const ms = Date.now() - started
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        /* 保留原文用于报错 */
      }

      if (res.ok && payload && Array.isArray(payload.data) && payload.data.length > 0) {
        clearTimeout(timer)
        if (a.signal) a.signal.removeEventListener('abort', onAbort)
        attempts.push({ attempt, status: res.status, ms })
        return {
          ok: true,
          payload,
          ms,
          attempts,
          model,
          endpoint: useEdits ? 'edits' : 'generations',
          droppedParams: dropped,
        }
      }

      const reason =
        (payload && payload.error && (payload.error.message || payload.error.code)) ||
        text.slice(0, 200) ||
        ('HTTP ' + res.status)
      attempts.push({ attempt, status: res.status, ms, reason })

      if (attempt < maxAttempts && isCapacityError(res.status, text)) {
        clearTimeout(timer)
        if (a.signal) a.signal.removeEventListener('abort', onAbort)
        const wait = Math.min(15000, 3000 * attempt)
        if (a.onProgress) a.onProgress('上游暂时没有可用账号，' + wait / 1000 + ' 秒后重试…')
        await new Promise((r) => setTimeout(r, wait))
        continue
      }

      clearTimeout(timer)
      if (a.signal) a.signal.removeEventListener('abort', onAbort)
      const err = new Error(reason)
      err.attempts = attempts
      err.status = res.status
      throw err
    } catch (err) {
      clearTimeout(timer)
      if (a.signal) a.signal.removeEventListener('abort', onAbort)
      if (err && err.name === 'AbortError') {
        if (a.signal && a.signal.aborted) throw new Error('已取消。')
        throw new Error('请求超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒）。出图通常 20 秒左右，' +
          '若反复超时请检查网络或调大 config.timeoutMs。')
      }
      if (err && err.attempts) throw err
      if (attempt < maxAttempts) {
        const wait = Math.min(15000, 3000 * attempt)
        if (a.onProgress) a.onProgress('网络错误（' + (err && err.message) + '），' + wait / 1000 + ' 秒后重试…')
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw err
    }
  }

  const err = new Error('重试 ' + maxAttempts + ' 次后仍然失败。')
  err.attempts = attempts
  throw err
}

/**
 * 把一次成功响应落盘，并校验"它到底有没有照做"。
 *
 * @returns {{saved:Array, warnings:string[], usage:object|null, revisedPrompt:string|null, cost:object}}
 */
export function persistResult({ result, config, outDir, namePrefix }) {
  const payload = result.payload
  const dir = outDir
  mkdirSync(dir, { recursive: true })

  const warnings = []
  const saved = []
  const requested = result.requestedParams || {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  payload.data.forEach((item, index) => {
    let bytes = null
    if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
      bytes = Buffer.from(item.b64_json, 'base64')
    }
    if (!bytes) {
      warnings.push('第 ' + (index + 1) + ' 张没有返回图像数据（既无 b64_json）')
      return
    }

    const info = inspectPng(bytes)
    const file = join(dir, namePrefix + '-' + stamp + (payload.data.length > 1 ? '-' + (index + 1) : '') + '.' +
      (info.format === 'JPEG' ? 'jpg' : info.format === 'WebP' ? 'webp' : 'png'))
    writeFileSync(file, bytes)

    // 校验 1：size 是不是真生效
    if (requested.size && info.width && info.height) {
      const want = String(requested.size).split('x')
      if (Number(want[0]) !== info.width || Number(want[1]) !== info.height) {
        warnings.push(
          '第 ' + (index + 1) + ' 张实际尺寸是 ' + info.width + 'x' + info.height +
            '，与请求的 ' + requested.size + ' 不一致 —— 该中转站忽略了 size。',
        )
      }
    }
    // 校验 2：background 是不是真生效（实测这台会忽略）
    if (requested.background === 'transparent' && !info.hasAlpha && info.format === 'PNG') {
      warnings.push(
        '第 ' + (index + 1) + ' 张要求透明背景，但返回的 PNG 没有 alpha 通道 —— 该中转站忽略了 background。',
      )
    }
    // 校验 3：output_format 是不是真生效
    if (requested.output_format) {
      const want = String(requested.output_format).toLowerCase()
      const got = info.format.toLowerCase()
      if (want !== got && !(want === 'jpg' && got === 'jpeg')) {
        warnings.push(
          '第 ' + (index + 1) + ' 张要求 ' + want + '，实际返回 ' + info.format + ' —— 该中转站忽略了 output_format。',
        )
      }
    }

    saved.push({ file, bytes: bytes.length, width: info.width, height: info.height, format: info.format })
  })

  const usage = payload.usage || null
  const cost = computeCost(usage, config.pricing)
  const revisedPrompt =
    payload.data.length > 0 && typeof payload.data[0].revised_prompt === 'string'
      ? payload.data[0].revised_prompt
      : null

  for (const d of result.droppedParams || []) {
    warnings.push('参数 ' + d.key + ' 未发送：' + d.reason)
  }
  for (const at of result.attempts || []) {
    if (at.status && at.status !== 200) {
      warnings.push('第 ' + at.attempt + ' 次尝试失败：HTTP ' + at.status + ' ' + (at.reason || ''))
    }
  }
  if (cost.warning) warnings.push(cost.warning)

  return {
    saved,
    warnings,
    usage,
    revisedPrompt,
    cost,
    model: result.model,
    ms: result.ms,
    endpoint: result.endpoint,
    /** 这批图落在哪个目录（绝对路径）。面板必须显示它 —— 否则用户找不到自己的图。 */
    directory: dir,
  }
}
