/**
 * 出图接口的凭据解析。
 *
 * 为什么要有这个模块：最初只认环境变量，结果从桌面图标启动时拿不到
 * （`BlueFishStation.exe` 拉起的 dsh web 继承的是资源管理器进程的环境，
 * 而 `setx` 之后不重开工作站就不生效），面板只能报一句"没找到 Key"，
 * 既说不清去哪儿找，也没有更好走的路。
 *
 * 现在按顺序解析，谁先有值用谁：
 *   ① 配置里显式给的 apiKey（不推荐，会落进 YAML）
 *   ② Key 文件。默认 `$DSH_HOME/image-station/.env`，一行 KEY=VALUE
 *   ③ 进程环境变量（apiKeyEnv，默认 DSH_IMAGE_API_KEY）
 *
 * 每一项都会记进 `sources`，所以面板能如实列出"我找过哪些地方"，
 * 而不是只说一句找不到。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** `$DSH_HOME` 或 `~/.dsh`。与 DSH 自身的默认取法一致。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

export function defaultKeyFile() {
  return join(dshHome(), 'image-station', '.env')
}

export function resolveKeyFile(config) {
  const raw = String((config && config.apiKeyFile) || '').trim()
  if (raw === '') return defaultKeyFile()
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
}

/**
 * 解析 `KEY=VALUE` 文本。容忍注释、空行、`export ` 前缀与包裹引号 ——
 * 因为这个文件是给人和脚本共用的，不能只接受最严格的一种写法。
 */
export function parseKeyFile(text, wantedName) {
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const at = withoutExport.indexOf('=')
    if (at === -1) continue
    const name = withoutExport.slice(0, at).trim()
    if (name !== wantedName) continue
    let value = withoutExport.slice(at + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value !== '') return value
  }
  return null
}

/**
 * 按顺序解析出 Key。
 *
 * @param {object} config 插件配置（apiKey / apiKeyFile / apiKeyEnv）
 * @returns {{key: string|null, envName: string, filePath: string, envValue: boolean, sources: Array}}
 */
export function resolveApiKey(config) {
  const cfg = config || {}
  const envName = cfg.apiKeyEnv || 'DSH_IMAGE_API_KEY'
  const filePath = resolveKeyFile(cfg)
  const sources = []

  // ① 配置里显式给的
  if (typeof cfg.apiKey === 'string' && cfg.apiKey.trim() !== '') {
    sources.push({ kind: 'config', ok: true, where: 'config.apiKey' })
    return { key: cfg.apiKey.trim(), envName, filePath, envValue: false, sources }
  }
  sources.push({ kind: 'config', ok: false, where: 'config.apiKey（未配置）' })

  // ② Key 文件
  let fileKey = null
  if (existsSync(filePath)) {
    try {
      fileKey = parseKeyFile(readFileSync(filePath, 'utf8'), envName)
      sources.push({
        kind: 'file',
        ok: Boolean(fileKey),
        where: filePath + (fileKey ? '' : '（文件存在，但里面没有 ' + envName + '）'),
      })
    } catch (err) {
      sources.push({ kind: 'file', ok: false, where: filePath + '（读取失败：' + err.message + '）' })
    }
  } else {
    sources.push({ kind: 'file', ok: false, where: filePath + '（文件不存在）' })
  }

  // ③ 环境变量
  const envRaw = process.env[envName]
  const envValue = typeof envRaw === 'string' && envRaw.trim() !== ''
  sources.push({
    kind: 'env',
    ok: envValue,
    where: envName + (envValue ? '（进程环境里有）' : '（进程环境里没有）'),
  })

  const key = fileKey || (envValue ? envRaw.trim() : null)
  return { key, envName, filePath, envValue, sources }
}

/** 把 Key 写进 Key 文件，权限尽量收紧。返回写入的路径。 */
export function writeApiKeyFile(config, key) {
  const filePath = resolveKeyFile(config)
  const envName = (config && config.apiKeyEnv) || 'DSH_IMAGE_API_KEY'
  mkdirSync(dirname(filePath), { recursive: true })

  let existing = ''
  if (existsSync(filePath)) {
    try {
      existing = readFileSync(filePath, 'utf8')
    } catch {
      existing = ''
    }
  }

  // 文件头刻意用纯 ASCII：这个文件会被人用各种工具打开（记事本、PowerShell 5.1、
  // git diff、编辑器），而无 BOM 的 UTF-8 中文在 Windows PowerShell 5.1 里会按 ANSI
  // 解码成乱码 —— 文件本身没坏，但看的人会以为坏了。ASCII 没有这个问题。
  const header =
    '# DSH image-station credential file.\n' +
    '# One KEY=VALUE per line. Not tracked by git, never printed to logs.\n' +
    '# Changes take effect on the next generation - no restart needed.\n'
  const body = existing.trim() === '' ? header + envName + '=' + key + '\n' : null

  if (body !== null) {
    writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 })
    return filePath
  }

  // 文件已存在：替换那一行，保留其他内容（用户可能在里面放了别的东西）。
  const lines = existing.split(/\r?\n/)
  let replaced = false
  const out = lines.map((line) => {
    const trimmed = line.trim()
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
    const at = withoutExport.indexOf('=')
    if (at !== -1 && withoutExport.slice(0, at).trim() === envName) {
      replaced = true
      return envName + '=' + key
    }
    return line
  })
  if (!replaced) out.push(envName + '=' + key)
  writeFileSync(filePath, out.join('\n'), { encoding: 'utf8', mode: 0o600 })
  return filePath
}

/** 给面板看的、脱敏后的凭据状态。绝不回吐 Key 本身，只给长度与末四位。 */
export function keyStatus(config) {
  const r = resolveApiKey(config)
  const mask = (k) => (k ? '****' + k.slice(-4) + '（' + k.length + ' 字符）' : null)
  return {
    hasKey: Boolean(r.key),
    masked: mask(r.key),
    envName: r.envName,
    keyFile: r.filePath,
    keyFileExists: existsSync(r.filePath),
    sources: r.sources,
    /** 前端要的写法提示，集中在这里产出，避免两边各写一份。 */
    setupHint: {
      file: r.filePath,
      line: r.envName + '=sk-...',
      note: '写进这个文件后不需要重启，下一次出图就生效。',
    },
  }
}
