/**
 * Regression probe for the spec linter.
 *
 * The linter is what turns "the model should follow the spec" into something the code
 * guarantees, so it has to be tested in BOTH directions: it must flag the tag-list style
 * the spec forbids, and it must not cry wolf on compliant output. A checker that never
 * complains is worthless; one that always complains gets ignored.
 *
 * Usage: node probe-lint.mjs
 */
import { lintPrompt } from './lib/lint.js'

const COMPLIANT = [
  [
    'general 预设的真实产出（片段）',
    'Create a polished cinematic high-fantasy character illustration. The primary subject is a queen with long silver hair, pale cool-toned skin, and calm light-blue eyes. She stands upright on the deck of a massive sailing ship, her right hand gripping a tall ceremonial scepter held vertically beside her. She wears a formal white-and-blue royal gown with a structured bodice, layered fabric, and silver trim. Use a three-quarter composition with a slightly low camera angle, keeping her sharply focused while the distant horizon falls into soft atmospheric depth. The visual style should be a polished anime-influenced high-fantasy illustration with clean linework and controlled cel shading.',
  ],
  [
    '短但没有违规',
    'Create a polished product concept sheet. The primary subject is a compact brass desk lamp with a hinged arm and a matte black shade. It sits centered on a plain pale surface. Use a centered composition with a natural, slightly elevated camera angle. The lighting is a single soft key from the upper right with gentle fill.',
  ],
]

const VIOLATIONS = [
  [
    'danbooru tag 串（旧 anime 预设的产出）',
    '1 cat, solo, orange tabby cat, wearing a scarf, sitting on a wooden windowsill, side profile, gazing out the window at falling snow, snowflakes drifting outside, cozy interior, warm lamp light from inside, anime illustration, soft shading, detailed fur, high quality',
    ['质量词', 'Tag 列表'],
  ],
  [
    '堆质量词',
    'Create a polished illustration, masterpiece, best quality, ultra detailed, 8k, absurdres of a queen standing on a ship.',
    ['质量词'],
  ],
  [
    'Markdown 列表',
    'Create a portrait.\n\n- Subject: queen\n- Lighting: storm\n- Style: anime',
    ['Markdown'],
  ],
  [
    '对话前言 + JSON 结构',
    'Here is your prompt: {"subject": "queen", "lighting": "storm"}',
    ['前言'],
  ],
  [
    'Negative prompt 区块',
    'Create a portrait of a queen. Negative prompt: bad hands, extra fingers, low quality',
    ['Negative Prompt'],
  ],
  [
    '缺任务声明（模型自己猜图片类型）',
    'A silver-haired queen stands on a ship deck during a storm, holding a staff, cold blue light comes from the left.',
    ['Create'],
  ],
  [
    '相邻重复修饰词',
    'Create a polished detailed detailed illustration of a queen standing on a wet wet deck.',
    ['重复'],
  ],
]

let failed = 0
function report(ok, label, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : ''))
  if (!ok) failed++
}

console.log('合规输出必须通过（不误报）：')
for (const [name, text] of COMPLIANT) {
  const r = lintPrompt(text)
  report(r.ok, name, r.ok ? '' : '误报: ' + r.issues.join(' | '))
}

console.log('\n违规输出必须被抓到：')
for (const [name, text, expectKeywords] of VIOLATIONS) {
  const r = lintPrompt(text)
  report(!r.ok, name + '（应被标记）', r.ok ? '漏报！' : '')
  if (!r.ok) {
    const joined = r.issues.join(' | ')
    for (const kw of expectKeywords) {
      report(
        joined.includes(kw),
        '    理由里提到「' + kw + '」',
        joined.includes(kw) ? '' : '实际理由: ' + joined,
      )
    }
  }
}

console.log('')
if (failed === 0) console.log('ALL LINT CHECKS PASSED')
else {
  console.log(failed + ' CHECK(S) FAILED')
  process.exitCode = 1
}
