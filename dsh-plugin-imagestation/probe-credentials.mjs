/**
 * Regression probe for lib/credentials.js.
 *
 * The credential resolver exists because "只认环境变量" failed in practice: the desktop shell
 * launches `dsh web` as a child of Explorer, so `setx` does not reach it until the whole
 * workstation is restarted. A key FILE avoids that trap entirely, so this file's resolution
 * order and its write path both need to be pinned down.
 *
 * Usage: node probe-credentials.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveApiKey, writeApiKeyFile, keyStatus, parseKeyFile, defaultKeyFile, dshHome } from './lib/credentials.js'

const ENV = 'DSIS_PROBE_KEY'

/*
 * 测试用的合成凭据。**刻意不含真实的 "sk-" 前缀** —— 否则仓库里的密钥扫描器
 * （以及任何 CI 的 secret scanning）会把它当成真密钥报警。
 * 假警报比没有警报更坏：它会训练人忽略警报。
 */
const FAKE_FILE_KEY = 'test-key-file-0001'
const FAKE_SECOND_KEY = 'test-key-second-0002'
const FAKE_THIRD_KEY = 'test-key-third-0003'
const FAKE_ENV_KEY = 'test-key-env-0004'
const FAKE_QUOTED_KEY = 'test-key-quoted-0005'
const FAKE_EXPLICIT_KEY = 'test-key-explicit-0006'
const tmp = mkdtempSync(join(tmpdir(), 'dsis-cred-'))
const keyFile = join(tmp, 'nested', '.env')

let failed = 0
function check(label, ok, detail) {
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + (detail ? '  -> ' + detail : ''))
  if (!ok) failed++
}

delete process.env[ENV]

console.log('=== 1. 解析顺序 ===')
{
  const r = resolveApiKey({ apiKeyFile: join(tmp, 'missing.env'), apiKeyEnv: ENV })
  check('什么都没有时返回 null', r.key === null, String(r.key))
  check('来源逐条记录（而不是只说找不到）', r.sources.length === 3, r.sources.length + ' 条')
  check('不存在的文件被标为未命中', r.sources.some((s) => s.kind === 'file' && !s.ok))
  check('环境变量未命中也被记录', r.sources.some((s) => s.kind === 'env' && !s.ok))
}

console.log('\n=== 2. 写文件后能读回来 ===')
{
  const written = writeApiKeyFile({ apiKeyFile: keyFile, apiKeyEnv: ENV }, FAKE_FILE_KEY)
  check('写到了指定的嵌套路径（目录自动创建）', written === keyFile, written)
  const content = readFileSync(keyFile, 'utf8')
  check('文件里是 KEY=VALUE 一行', content.includes(ENV + '=' + FAKE_FILE_KEY), JSON.stringify(content.split('\n').filter((l) => l.includes('='))[0]))
  check('带注释头（便于人读）', content.startsWith('#'))

  const r = resolveApiKey({ apiKeyFile: keyFile, apiKeyEnv: ENV })
  check('解析到文件里的 Key', r.key === FAKE_FILE_KEY, String(r.key))
  check('文件来源标记为命中', r.sources.some((s) => s.kind === 'file' && s.ok))
}

console.log('\n=== 3. 环境变量与文件的优先级 ===')
{
  process.env[ENV] = FAKE_ENV_KEY
  const onlyEnv = resolveApiKey({ apiKeyFile: join(tmp, 'missing.env'), apiKeyEnv: ENV })
  check('没有文件时用环境变量', onlyEnv.key === FAKE_ENV_KEY, String(onlyEnv.key))
  check('envValue 标记正确', onlyEnv.envValue === true)

  const both = resolveApiKey({ apiKeyFile: keyFile, apiKeyEnv: ENV })
  check('两者都有时文件胜出（文件是明确写下的意图）', both.key === FAKE_FILE_KEY, String(both.key))

  const explicit = resolveApiKey({ apiKey: FAKE_EXPLICIT_KEY, apiKeyFile: keyFile, apiKeyEnv: ENV })
  check('config.apiKey 优先于两者', explicit.key === FAKE_EXPLICIT_KEY, String(explicit.key))
  delete process.env[ENV]
}

console.log('\n=== 4. 重写是幂等的（不会重复追加） ===')
{
  writeApiKeyFile({ apiKeyFile: keyFile, apiKeyEnv: ENV }, FAKE_SECOND_KEY)
  const lines = readFileSync(keyFile, 'utf8').split('\n').filter((l) => l.trim().startsWith(ENV + '='))
  check('该键只剩一行', lines.length === 1, lines.length + ' 行')
  check('值是新的', lines[0].includes(FAKE_SECOND_KEY), lines[0])
  check('解析到新值', resolveApiKey({ apiKeyFile: keyFile, apiKeyEnv: ENV }).key === FAKE_SECOND_KEY)

  // 文件里原有别的内容必须保留
  writeFileSync(keyFile, readFileSync(keyFile, 'utf8') + 'OTHER_SETTING=keep-me\n')
  writeApiKeyFile({ apiKeyFile: keyFile, apiKeyEnv: ENV }, FAKE_THIRD_KEY)
  const after = readFileSync(keyFile, 'utf8')
  check('重写不动文件里的其他内容', after.includes('OTHER_SETTING=keep-me'))
  check('重写后该键仍只有一行', after.split('\n').filter((l) => l.trim().startsWith(ENV + '=')).length === 1)
}

console.log('\n=== 5. parseKeyFile 容忍常见写法 ===')
{
  const sample = [
    '# comment',
    '',
    'export ' + ENV + "='" + FAKE_QUOTED_KEY + "'",
    'OTHER=1',
  ].join('\n')
  check('能读 export 前缀 + 单引号', parseKeyFile(sample, ENV) === FAKE_QUOTED_KEY, String(parseKeyFile(sample, ENV)))
  check('能读双引号', parseKeyFile(ENV + '="' + FAKE_QUOTED_KEY + '"', ENV) === FAKE_QUOTED_KEY)
  check('跳过注释行', parseKeyFile('# ' + ENV + '=nope\n' + ENV + '=' + FAKE_QUOTED_KEY, ENV) === FAKE_QUOTED_KEY)
  check('找不到时返回 null', parseKeyFile('A=1', ENV) === null)
  check('空值不算命中', parseKeyFile(ENV + '=', ENV) === null)
}

console.log('\n=== 6. 面板只看得到脱敏状态 ===')
{
  const st = keyStatus({ apiKeyFile: keyFile, apiKeyEnv: ENV })
  check('报告 hasKey', st.hasKey === true)
  check('只给末四位与长度', /^\*\*\*\*/.test(st.masked) && st.masked.includes(FAKE_THIRD_KEY.slice(-4)), String(st.masked))
  check('整体 JSON 里不含完整 Key', !JSON.stringify(st).includes(FAKE_THIRD_KEY), '已脱敏')
  check('给出 setupHint 的文件路径与写法', Boolean(st.setupHint.file) && st.setupHint.line.startsWith(ENV + '='), st.setupHint.line)
}

console.log('\n=== 7. 默认路径落在 DSH_HOME 下 ===')
{
  const f = defaultKeyFile()
  check('默认 Key 文件在 $DSH_HOME/image-station/ 下', f.startsWith(dshHome()) && f.includes('image-station'), f)
}

console.log('')
console.log(failed === 0 ? 'ALL CREDENTIAL CHECKS PASSED' : failed + ' CHECK(S) FAILED')
if (failed > 0) process.exitCode = 1
