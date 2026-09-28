/**
 * Show the real expansion output for each preset, in full.
 *
 * A human-readable companion to probe-endpoints.mjs: that one asserts the contract,
 * this one prints what the model actually produced so the prompt quality can be judged.
 *
 * Usage: node probe-sample.mjs <station-url-with-token> ["你的描述"]
 */
const target = process.argv[2]
const input = process.argv[3] || '一只戴围巾的橘猫坐在窗台上看雪，暖色灯光'

if (!target) {
  console.error('usage: node probe-sample.mjs <station-url-with-token> ["描述"]')
  process.exit(2)
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
const origin = new URL(target).origin

const presets = await (
  await fetch(origin + '/image-station/presets', {
    headers: { cookie, authorization: 'Bearer ' + token },
  })
).json()

console.log('目标模型: ' + (presets.model ? presets.model.provider + ' / ' + presets.model.model : '(未知)'))
console.log('输入描述: ' + input)
console.log('')

for (const p of presets.presets) {
  const res = await fetch(origin + '/image-station/expand', {
    method: 'POST',
    headers: { cookie, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ text: input, presetId: p.id }),
  })
  const text = await res.text()
  const events = text
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
  const usage = events.find((e) => e.type === 'usage')
  const reasoning = events.filter((e) => e.type === 'reasoning').length

  console.log('══════ 预设「' + p.label + '」(' + p.id + ') ══════')
  if (done) {
    console.log(done.prompt)
    console.log('')
    console.log(
      '  [chunks: delta=' +
        events.filter((e) => e.type === 'delta').length +
        ' reasoning=' +
        reasoning +
        (usage ? '  tokens: in ' + usage.usage.inputTokens + ' / out ' + usage.usage.outputTokens : '') +
        ']',
    )
  } else {
    console.log('  失败: ' + (err ? err.message : '没有 done 也没有 error'))
  }
  console.log('')
}
