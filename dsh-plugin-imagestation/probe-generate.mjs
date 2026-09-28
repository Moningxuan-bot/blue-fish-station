/**
 * Probe for lib/generate.js — the code that actually spends money.
 *
 * Everything here runs against the real relay, because the whole point of the module is
 * coping with THIS relay's quirks: capacity brownouts, parameters it accepts but ignores,
 * and an edits endpoint that resizes silently. A mock would prove none of that.
 *
 * Usage:
 *   $env:DSH_IMAGE_API_KEY = 'sk-...'
 *   node probe-generate.mjs            # 快速模式：1 张文生图 + 参数剥离检查
 *   node probe-generate.mjs --full     # 再加图生图与 mask（更慢，更贵）
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateImage, persistResult, computeCost, inspectPng } from './lib/generate.js'

const full = process.argv.includes('--full')
// 只把非标志位的第一个参数当作模型名：早先直接用 argv[2]，`--full` 被当成了模型，
// 于是请求带着 model:"--full" 发出去，回来 404 —— 探针自身的 bug，不是中转站的问题。
const modelArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
const key = process.env.DSH_IMAGE_API_KEY
if (!key) {
  console.error('缺少 DSH_IMAGE_API_KEY')
  process.exit(2)
}

const config = {
  baseUrl: 'https://api.example.com',
  apiKeyEnv: 'DSH_IMAGE_API_KEY',
  model: modelArg || 'your-image-model',
  retries: 5,
  timeoutMs: 180000,
  pricing: { inputUsdPerMillion: 0.14, outputUsdPerMillion: 4.0 },
}
console.log('模型: ' + config.model + (full ? '   （--full：含图生图）' : ''))

let failed = 0
function check(label, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : ''))
  if (!ok) failed++
}

const outDir = mkdtempSync(join(tmpdir(), 'dsis-gen-'))
console.log('输出目录: ' + outDir)
console.log('')

/* ---------- 1. 纯函数：参数剥离与成本计算（不花钱，先跑） ---------- */
console.log('=== 1. 纯函数检查（不发请求） ===')
{
  // inspectPng 对已知字节的判断
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  )
  const info = inspectPng(png)
  check('inspectPng 认出 1x1 PNG', info.format === 'PNG' && info.width === 1 && info.height === 1, JSON.stringify(info))
  check('inspectPng 认出 RGBA（colorType=6）', info.hasAlpha === true, 'colorType=' + info.colorType)

  const c1 = computeCost({ input_tokens: 23, output_tokens: 1056 }, config.pricing)
  check('token 计费会算出数值', typeof c1.usd === 'number' && c1.usd > 0, c1.usd + ' USD  (' + c1.detail + ')')
  // 用显式传入的价格断言，而不是依赖 config 默认值 —— 否则中转站一调价，这条测试就会假失败。
  const c2 = computeCost({ input_tokens: 23, output_tokens: 1056 }, { flatPricePerImage: 0.03 })
  check('包价模式优先于 token 计费', c2.basis === 'flat' && c2.usd === 0.03, JSON.stringify(c2))
  const c2b = computeCost(
    { input_tokens: 34, output_tokens: 1056 },
    { flatPricePerImage: 0.03, outputUsdPerMillion: 28.4 },
  )
  check('换算正确的 token 单价不触发告警', !c2b.warning, c2b.warning || '')
  const c2c = computeCost(
    { input_tokens: 34, output_tokens: 1056 },
    { flatPricePerImage: 0.03, outputUsdPerMillion: 4 },
  )
  check('换算错误的 token 单价会告警', typeof c2c.warning === 'string' && c2c.warning.includes('口径'), (c2c.warning || '').slice(0, 80))
  const c3 = computeCost(null, {})
  check('没有价格配置时返回 null 而不是 0', c3.usd === null, JSON.stringify(c3))
}

/* ---------- 2. 端到端：文生图，并验证 size 真生效 ---------- */
console.log('')
console.log('=== 2. 文生图（请求 1024x1024，带会被忽略的参数） ===')
let firstImage = null
try {
  const requestedParams = {
    size: '1024x1024',
    background: 'transparent', // 实测被忽略 —— 应出现在 warnings 里
    output_format: 'webp', // 实测被忽略 —— 应出现在 warnings 里
  }
  const result = await generateImage({
    config,
    prompt:
      'Create a polished product photograph of a small brass compass resting on weathered dark wood, ' +
      'soft window light from the left, shallow depth of field, muted earth tones.',
    params: requestedParams,
    onProgress: (m) => console.log('      进度: ' + m),
  })
  result.requestedParams = requestedParams
  check('请求成功', result.ok === true, result.endpoint + '  ' + result.ms + 'ms')

  const persisted = persistResult({ result, config, outDir, namePrefix: 'compass' })
  check('落盘了至少一张图', persisted.saved.length >= 1, JSON.stringify(persisted.saved.map((s) => s.file.split(/[\\/]/).pop())))
  check('实际尺寸等于请求尺寸', persisted.saved[0] && persisted.saved[0].width === 1024 && persisted.saved[0].height === 1024,
    persisted.saved[0] ? persisted.saved[0].width + 'x' + persisted.saved[0].height : 'no file')
  check('usage 被解析出来', Boolean(persisted.usage), JSON.stringify(persisted.usage))
  check('成本算出了数值', persisted.cost && typeof persisted.cost.usd === 'number', JSON.stringify(persisted.cost))
  check('revised_prompt 被捕获', typeof persisted.revisedPrompt === 'string', String(persisted.revisedPrompt).slice(0, 70))

  const w = persisted.warnings.join(' || ')
  check('背景透明被忽略 → 有警告', w.includes('alpha') || w.includes('background'), w.slice(0, 160))
  check('output_format 被忽略 → 有警告', w.includes('output_format') || w.includes('实际返回 PNG'), w.slice(0, 160))
  check('被剥离的参数有告知', w.includes('未发送'), w.slice(0, 200))

  firstImage = { data: readFileSync(persisted.saved[0].file), name: 'ref.png', type: 'image/png' }
  console.log('')
  console.log('  这张图: ' + persisted.saved[0].file)
  console.log('  用量  : ' + JSON.stringify(persisted.usage))
  console.log('  成本  : ' + persisted.cost.usd + ' USD  (' + persisted.cost.detail + ')')
  if (persisted.revisedPrompt) console.log('  revised: ' + persisted.revisedPrompt.slice(0, 140))
  console.log('  警告  :')
  for (const line of persisted.warnings) console.log('    - ' + line)
} catch (err) {
  check('文生图成功', false, err.message)
  if (err.attempts) console.log('      尝试记录: ' + JSON.stringify(err.attempts))
}

/* ---------- 3. 图生图 + mask ---------- */
if (full && firstImage) {
  console.log('')
  console.log('=== 3. 图生图（edits，带参考图） ===')
  try {
    const r2 = await generateImage({
      config,
      prompt: 'Change the compass casing to bright polished silver while keeping everything else identical.',
      params: { size: '1024x1024' },
      image: firstImage,
      onProgress: (m) => console.log('      进度: ' + m),
    })
    r2.requestedParams = { size: '1024x1024' }
    const p2 = persistResult({ result: r2, config, outDir, namePrefix: 'compass-edited' })
    check('edits 成功', p2.saved.length >= 1, p2.saved[0] ? p2.saved[0].width + 'x' + p2.saved[0].height : '')
    console.log('  这张图: ' + (p2.saved[0] ? p2.saved[0].file : '无'))
    console.log('  用量  : ' + JSON.stringify(p2.usage))
    // edits 会重设尺寸，这是已知行为，不该被当成错误
    if (p2.saved[0] && (p2.saved[0].width !== 1024 || p2.saved[0].height !== 1024)) {
      console.log('  注意  : edits 把尺寸改成了 ' + p2.saved[0].width + 'x' + p2.saved[0].height + '（实测行为，非错误）')
    }
  } catch (err) {
    check('edits 成功', false, err.message)
  }
} else if (full) {
  console.log('\n跳过图生图：没有参考图')
}

console.log('')
console.log(failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED')
if (failed > 0) process.exitCode = 1
