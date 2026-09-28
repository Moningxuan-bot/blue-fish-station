/**
 * Probe for the key setup path: what the panel shows with no key, and whether the panel's
 * write endpoint actually makes the key usable WITHOUT restarting anything.
 *
 * This exists because the original design only read an environment variable, and the desktop
 * shell launches `dsh web` as a child of Explorer — so `setx` does not reach it until the whole
 * workstation is restarted. The fix is a key file plus an in-panel write; this probe proves it.
 *
 * Usage: node probe-keysetup.mjs <station-url-with-token> --key <sk-...>
 */
const args = process.argv.slice(2)
const target = args[0]
const keyIndex = args.indexOf('--key')
const keyToWrite = keyIndex !== -1 ? args[keyIndex + 1] : null

if (!target) {
  console.error('usage: node probe-keysetup.mjs <url> [--key sk-...]')
  process.exit(2)
}

const origin = new URL(target).origin
let failed = 0
function check(label, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : ''))
  if (!ok) failed++
}

const boot = await fetch(target, { redirect: 'manual' })
const cookie = (boot.headers.getSetCookie ? boot.headers.getSetCookie() : [])
  .map((c) => String(c).split(';')[0])
  .join('; ')
const home = new URL(target)
home.pathname = '/'
home.search = ''
const html = await (await fetch(home.toString(), { headers: cookie ? { cookie } : {} })).text()
const token = html.match(/data-image-station-token="([^"]+)"/)[1]

const stationFetch = (path, options) =>
  fetch(origin + '/image-station' + path, {
    ...options,
    headers: {
      ...(cookie ? { cookie } : {}),
      authorization: 'Bearer ' + token,
      ...((options && options.headers) || {}),
    },
  })

/* ---------- 1. what the panel is told about credentials ---------- */
// 这一步在"有 Key"和"没 Key"两种状态下都应该是自洽的，所以按实际状态断言，
// 而不是假定一定是干净的 —— 否则探针跑过一遍之后就没法再跑（踩过）。
console.log('=== 1. 出图配置与凭据状态 ===')
const presets = await (await stationFetch('/presets')).json()
const cred = presets.image && presets.image.credentials

/*
 * 仓库出货的默认是占位符，真实服务地址与模型名属于部署配置（profile 覆盖层）。
 * 这里要能分辨"在跑真实配置"还是"在跑占位符"，并把结论说清楚 ——
 * 判据是那两个占位符常量本身，因此不需要知道任何真实值。
 */
const PLACEHOLDER_BASE = 'https://api.example.com'
const PLACEHOLDER_MODEL = 'your-image-model'
const onPlaceholder =
  !presets.image || presets.image.baseUrl === PLACEHOLDER_BASE || presets.image.model === PLACEHOLDER_MODEL
console.log('      baseUrl   : ' + (presets.image && presets.image.baseUrl))
console.log('      model     : ' + (presets.image && presets.image.model))
console.log('      outputDir : ' + (presets.image && presets.image.outputDir))
console.log('      单价      : ' + (presets.image && presets.image.pricing && presets.image.pricing.flatPricePerImage))
console.log('      配置来源  : ' + (onPlaceholder ? '⚠ 出厂占位符（未在 profile 里覆盖）' : '✓ 部署方配置（覆盖层生效）'))

check('出图配置被暴露给面板', Boolean(presets.image && presets.image.baseUrl))
check('baseUrl 是 http(s) 地址', /^https?:\/\//.test(String(presets.image.baseUrl)), String(presets.image.baseUrl))
check(
  'outputDir 是绝对路径（不按 cwd 解析）',
  /^([A-Za-z]:[\\/]|\/)/.test(String(presets.image.outputDir)),
  String(presets.image.outputDir),
)
if (onPlaceholder) {
  console.log('      INFO: 当前是占位符状态。要真出图，需在 profile 的 cordis.patch.yml 里')
  console.log('            给 image-station 行配上 baseUrl / model / pricing。')
}

check('image.credentials 存在', Boolean(cred), JSON.stringify(presets.image && Object.keys(presets.image)))
check('hasKey 是布尔值', cred && typeof cred.hasKey === 'boolean', String(cred && cred.hasKey))
console.log('      当前状态: ' + (cred.hasKey ? '已配置 ' + cred.masked : '未配置（面板会引导写入）'))
check('逐条列出找过的地方', cred && Array.isArray(cred.sources) && cred.sources.length === 3, JSON.stringify(cred && cred.sources && cred.sources.map((s) => s.ok)))
check('来源命中情况与 hasKey 自洽', cred && (cred.hasKey === cred.sources.some((s) => s.ok)), cred && JSON.stringify(cred.sources.map((s) => s.ok)))
check('给出 Key 文件路径', Boolean(cred && cred.setupHint && cred.setupHint.file), cred && cred.setupHint && cred.setupHint.file)
check('给出要写的那一行', cred && cred.setupHint.line.startsWith(cred.envName + '='), cred && cred.setupHint.line)
// 注意：setupHint 里本来就含占位符 "NAME=sk-..."，所以不能简单地查 "sk-" 子串
// —— 那会把正规划程误判成泄漏。只有"sk- 后面跟着一长串真字符"才算真密钥。
check(
  '响应里不含真实密钥（占位符允许）',
  !/sk-[A-Za-z0-9]{20,}/.test(JSON.stringify(presets)),
  '已脱敏',
)

/* ---------- 2. the panel's write endpoint ---------- */
console.log('\n=== 2. POST /key 写盘 ===')
if (!keyToWrite) {
  console.log('  （未提供 --key，跳过写入测试）')
} else {
  const res = await stationFetch('/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: keyToWrite }),
  })
  const body = await res.json()
  check('写入返回 200', res.status === 200, 'HTTP ' + res.status)
  check('写完后重新解析确认可读', body.ok === true, String(body.ok))
  check('返回写入路径', typeof body.written === 'string' && body.written.length > 0, body.written)
  check('返回的状态仍是脱敏的', body.credentials && body.credentials.masked && !JSON.stringify(body).includes(keyToWrite), String(body.credentials && body.credentials.masked))
  console.log('      宿主原话: ' + body.message)

  /* ---------- 3. it must take effect with NO restart ---------- */
  console.log('\n=== 3. 免重启即生效（同一个进程，不重启） ===')
  const after = await (await stationFetch('/presets')).json()
  check('再次读取时 hasKey=true', after.image.credentials.hasKey === true, String(after.image.credentials.hasKey))
  check('提示与文件路径一致', after.image.credentials.setupHint.file === body.written, after.image.credentials.setupHint.file)

  /* ---------- 4. generation should now be possible ---------- */
  console.log('\n=== 4. 立刻出图（真实调用，约 20–30 秒） ===')
  const gen = await stationFetch('/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Create a polished product photograph of a single green pear on a plain white surface, soft daylight, minimal composition.',
      params: { size: '1024x1024', quality: 'medium', n: 1 },
    }),
  })
  check('POST /generate → 200', gen.status === 200, 'HTTP ' + gen.status)
  const raw = await gen.text()
  const events = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const done = events.find((e) => e.type === 'done')
  const err = events.find((e) => e.type === 'error')
  if (done) {
    check('出图成功（Key 文件被真正用上了）', Array.isArray(done.images) && done.images.length > 0, JSON.stringify((done.images || []).map((i) => i.width + 'x' + i.height)))
    console.log('      耗时 ' + Math.round(done.ms / 1000) + ' 秒，成本 ' + JSON.stringify(done.cost))
    for (const w of done.warnings || []) console.log('      提示: ' + w)
  } else if (err) {
    console.log('  INFO: 出图未成功（上游问题，与凭据无关）：' + err.message)
    check('错误不是"没有 Key"', !err.message.includes('没有找到出图接口的 Key'), err.message.slice(0, 100))
  }
}

console.log('')
console.log(failed === 0 ? 'KEY SETUP CHECKS PASSED' : failed + ' CHECK(S) FAILED')
if (failed > 0) process.exitCode = 1
