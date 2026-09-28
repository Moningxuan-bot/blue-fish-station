/**
 * Endpoint probe: drives the plugin's HTTP surface against a real running station.
 *
 * Checks the pieces the browser probe cannot see: the token handshake through the index
 * tap, bearer enforcement, the preset payload, and the NDJSON stream contract.
 * The LLM call itself needs live credentials, so a failure there is reported as INFO
 * rather than as a contract violation.
 *
 * Usage: node probe-endpoints.mjs <station-url-with-token>
 */
const target = process.argv[2]
if (!target) {
  console.error('usage: node probe-endpoints.mjs <url>')
  process.exit(2)
}

const origin = new URL(target).origin
const failures = []
function check(label, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : ''))
  if (!ok) failures.push(label)
}

/* ---------- 1. the index tap must hand the browser a token ---------- */
// Two facts this has to respect:
//   * the station token is minted per index RESPONSE, so it must be read out of the
//     document (never taken from the server's log line, which is a different response);
//   * /api is behind a browser-trust fence, and Node's fetch drops the query string when
//     it follows a redirect — so the session cookie has to be carried by hand.
const bootRes = await fetch(target, { redirect: 'manual' })
const cookie = (bootRes.headers.getSetCookie ? bootRes.headers.getSetCookie() : [])
  .map((c) => String(c).split(';')[0])
  .join('; ')
const homeUrl = new URL(target)
homeUrl.pathname = '/'
homeUrl.search = ''

const indexRes = await fetch(homeUrl.toString(), { headers: cookie ? { cookie } : {} })
const html = await indexRes.text()
const tokenMatch = html.match(/data-image-station-token="([^"]+)"/)
check('index carries the station token', Boolean(tokenMatch), 'data-image-station-token present: ' + Boolean(tokenMatch))
if (!tokenMatch) {
  console.log('\nfatal: no token in the index; the panel could never authenticate.')
  console.log('index status was ' + indexRes.status + ', ' + html.length + ' bytes')
  console.log('first 200: ' + html.slice(0, 200).replace(/\s+/g, ' '))
  process.exit(1)
}
const token = tokenMatch[1]
check('token is not empty', token.length > 0, token.length + ' chars')
check('index rendered a real document', /<html/i.test(html) && html.length > 1000, html.length + ' bytes')

/** Every plugin route call carries the session cookie (fence) and the bearer (plugin gate). */
const pluginFetch = (path, options) =>
  fetch(origin + '/image-station' + path, {
    ...options,
    headers: {
      ...(cookie ? { cookie } : {}),
      authorization: 'Bearer ' + token,
      ...((options && options.headers) || {}),
    },
  })

/* ---------- 2. the plugin's own gate must reject a missing/wrong bearer ---------- */
const noAuth = await pluginFetch('/presets', { headers: { authorization: '' } })
check('GET /presets without bearer → 401', noAuth.status === 401, 'got ' + noAuth.status)
const badAuth = await pluginFetch('/presets', { headers: { authorization: 'Bearer nope' } })
check('GET /presets with wrong bearer → 401', badAuth.status === 401, 'got ' + badAuth.status)

/* ---------- 3. the preset payload ---------- */
const presetsRes = await pluginFetch('/presets')
check('GET /presets with bearer → 200', presetsRes.status === 200, 'got ' + presetsRes.status)
const presets = await presetsRes.json()
check('presets is a non-empty array', Array.isArray(presets.presets) && presets.presets.length > 0, JSON.stringify(presets.presets && presets.presets.map((p) => p.id)))
check('defaultPresetId is one of them', presets.presets.some((p) => p.id === presets.defaultPresetId), String(presets.defaultPresetId))
check('reports the target model', Boolean(presets.model || presets.modelError), presets.model ? presets.model.provider + '/' + presets.model.model : 'modelError: ' + presets.modelError)
check('does not leak extraRules/system text', !('extraRules' in presets) && !JSON.stringify(presets).includes('提示词工程师'))

/* ---------- 4. unknown route ---------- */
const nf = await pluginFetch('/nope')
check('unknown path → 404', nf.status === 404, 'got ' + nf.status)

/* ---------- 5. the NDJSON stream contract ---------- */
console.log('\n  streaming POST /expand …')
const expandRes = await pluginFetch('/expand', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '一只戴围巾的橘猫坐在窗台上看雪', presetId: presets.defaultPresetId }),
})
check('POST /expand → 200', expandRes.status === 200, 'got ' + expandRes.status)
check(
  'content-type is ndjson',
  String(expandRes.headers.get('content-type') || '').includes('ndjson'),
  String(expandRes.headers.get('content-type')),
)

const raw = await expandRes.text()
const events = []
for (const line of raw.split('\n')) {
  const t = line.trim()
  if (t === '') continue
  try {
    events.push(JSON.parse(t))
  } catch {
    check('every stream line is valid JSON', false, t.slice(0, 120))
  }
}
const kinds = events.map((e) => e.type)
console.log('       events: ' + kinds.join(', '))

check('stream starts with a start event', events[0] && events[0].type === 'start', kinds[0])
check('start carries the resolved preset', Boolean(events[0] && events[0].presetId), events[0] && events[0].presetId)
check('start carries the model', Boolean(events[0] && events[0].model), events[0] && JSON.stringify(events[0].model))

const done = events.find((e) => e.type === 'done')
const err = events.find((e) => e.type === 'error')
const deltas = events.filter((e) => e.type === 'delta')

if (done) {
  check('done carries a non-empty prompt', typeof done.prompt === 'string' && done.prompt.trim().length > 0, String(done.prompt).slice(0, 90) + '…')
  check('deltas reconstructed the prompt', deltas.map((d) => d.text).join('').includes(done.prompt.slice(0, 20)))
  check('prompt has no markdown fence', !done.prompt.includes('```'))
  check('done carries a lint verdict', Boolean(done.lint) && typeof done.lint.ok === 'boolean', JSON.stringify(done.lint && done.lint.issues))
  console.log('\n  LLM call SUCCEEDED — full pipeline verified end to end.')
} else if (err) {
  console.log('\n  INFO: the pipeline reached the LLM but the call failed (credentials/network):')
  console.log('        ' + err.message)
  console.log('        The stream CONTRACT is still verified: start event, model, and a typed error event all arrived.')
} else {
  check('stream terminated with done or error', false, 'neither seen')
}

/* ---------- 6. the image side of the panel facts ---------- */
console.log('\n=== 6. 出图侧的面板事实 ===')
check('image config is exposed', Boolean(presets.image), JSON.stringify(presets.image && {
  model: presets.image.model,
  hasApiKey: presets.image.hasApiKey,
  defaults: presets.image.defaults,
}))
check('reports whether the API key is present', typeof (presets.image && presets.image.hasApiKey) === 'boolean', String(presets.image && presets.image.hasApiKey))
check('never leaks the key itself', !JSON.stringify(presets).includes('sk-'))
check(
  'lists the silently ignored params',
  Array.isArray(presets.image && presets.image.ignoredParams) && presets.image.ignoredParams.length > 0,
  ((presets.image && presets.image.ignoredParams) || []).map((p) => p.key).join(', '),
)
check('reports a plausible per-image duration', Array.isArray(presets.image && presets.image.typicalSeconds))

/* ---------- 7. POST /generate — spends real money, so opt in ---------- */
if (process.argv.includes('--draw')) {
  console.log('\n=== 7. 出图（真实调用，约 20–30 秒） ===')
  const genRes = await pluginFetch('/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt:
        'Create a polished product photograph of a small brass key resting on a sheet of white paper, ' +
        'soft daylight from the upper left, clean minimal composition, shallow depth of field.',
      params: { size: '1024x1024', quality: 'medium', n: 1 },
    }),
  })
  check('POST /generate → 200', genRes.status === 200, 'got ' + genRes.status)
  const genRaw = await genRes.text()
  const genEvents = []
  for (const line of genRaw.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      genEvents.push(JSON.parse(t))
    } catch {
      check('every generate line is valid JSON', false, t.slice(0, 140))
    }
  }
  const gk = genEvents.map((e) => e.type)
  console.log('       events: ' + gk.join(', '))
  check('generate stream starts with start', Boolean(genEvents[0]) && genEvents[0].type === 'start', gk[0])

  const gdone = genEvents.find((e) => e.type === 'done')
  const gerr = genEvents.find((e) => e.type === 'error')
  if (gdone) {
    check('returned at least one image', Array.isArray(gdone.images) && gdone.images.length > 0, JSON.stringify((gdone.images || []).map((i) => i.width + 'x' + i.height)))
    check('image carries a fetchable url', Boolean(gdone.images[0] && gdone.images[0].url), gdone.images[0] && gdone.images[0].url)
    check('cost was computed', Boolean(gdone.cost) && gdone.cost.usd !== undefined, JSON.stringify(gdone.cost))
    check('usage was reported', Boolean(gdone.usage), JSON.stringify(gdone.usage))

    // The image route must actually serve the bytes back. Note the URL carries the token in
    // its query string, because an <img src> cannot send an Authorization header — the very
    // reason that route accepts a query token.
    const imgRes = await fetch(origin + gdone.images[0].url)
    const bytes = Buffer.from(await imgRes.arrayBuffer())
    const isPng = bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG'
    check('GET /image/<id> serves a real PNG', imgRes.status === 200 && isPng, 'HTTP ' + imgRes.status + ', ' + bytes.length + ' bytes')
    check('served pixels match the metadata', isPng && bytes.readUInt32BE(16) === gdone.images[0].width, isPng ? bytes.readUInt32BE(16) + ' vs ' + gdone.images[0].width : 'n/a')
    check('image url carries the token for <img src>', String(gdone.images[0].url).includes('token='), String(gdone.images[0].url))
    check('image route rejects a wrong token', (await fetch(origin + '/image-station/image/' + gdone.images[0].id + '?token=wrong')).status === 401)
    check('unknown image id → 404', (await pluginFetch('/image/nope')).status === 404)

    console.log('  出图结果: ' + (gdone.images || []).map((i) => i.name + ' ' + i.width + 'x' + i.height).join(', '))
    console.log('  耗时    : ' + Math.round(gdone.ms / 1000) + ' 秒')
    console.log('  用量    : ' + JSON.stringify(gdone.usage))
    console.log('  成本    : ' + JSON.stringify(gdone.cost))
    for (const w of gdone.warnings || []) console.log('  提示    : ' + w)
  } else if (gerr) {
    console.log('  INFO: 出图失败（上游或凭据问题）：' + gerr.message)
    if (gerr.attempts) console.log('        尝试记录: ' + JSON.stringify(gerr.attempts))
    console.log('        流的契约仍然验证过：start 事件与类型化的 error 事件都到达了。')
  } else {
    check('generate stream terminated with done or error', false, 'neither seen')
  }
} else {
  console.log('\n  （跳过真实出图；加 --draw 会真的花一次钱来验证整条链）')
}

console.log('')
if (failures.length === 0) console.log('CONTRACT CHECKS PASSED')
else {
  console.log('FAILURES: ' + failures.join(' | '))
  process.exitCode = 1
}
