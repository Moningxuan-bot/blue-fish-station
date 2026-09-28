/**
 * 预设（风格）：一条流水线的可切换形态。
 *
 * 与第一版的根本差别：**提示词不再硬编码在代码里**，而是从 `specs/*.md` 加载。
 * 规范是知识，知识应当是可编辑、可版本管理的文件，不是 JS 字符串。
 *
 * 文件格式：
 *   ---
 *   id: xxx            # 必填，预设标识
 *   label: 显示名       # 可选，默认用 id
 *   description: 一句话  # 可选
 *   base: 另一个 id     # 可选，继承那个规范（本文件内容追加在后）
 *   ---
 *   正文 = 发给模型的规范全文
 *
 * 落盘策略：`specs/` 是出厂默认；用户在插件 config 里给的同名预设整体替换默认项，
 * 新名字是纯新增；`presets` 里的项可以直接给 `system` 内联全文，不必有文件。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPECS_DIR = join(HERE, '..', 'specs')

/** 出厂预设顺序。列表顺序就是面板上的显示顺序。 */
const BUILTIN_ORDER = ['general', 'character', 'anime']

/** 解析 `---` 头 + 正文。头是可选的。 */
function parseSpecFile(text) {
  const normalized = String(text).replace(/^\uFEFF/, '')
  const m = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: normalized.trim() }

  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at === -1) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key !== '') meta[key] = value
  }
  return { meta, body: m[2].trim() }
}

/** 读 specs 目录里所有 .md。目录不存在时返回空表（插件仍能用内联预设工作）。 */
function loadSpecFiles() {
  const out = new Map()
  let names
  try {
    names = readdirSync(SPECS_DIR).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch (err) {
    console.warn('[imagestation] 读不到 specs 目录（' + SPECS_DIR + '）：' + err.message)
    return out
  }
  for (const name of names) {
    try {
      const parsed = parseSpecFile(readFileSync(join(SPECS_DIR, name), 'utf8'))
      const id = parsed.meta.id || name.replace(/\.md$/i, '')
      out.set(id, {
        id,
        label: parsed.meta.label || id,
        description: parsed.meta.description || '',
        base: parsed.meta.base || '',
        version: parsed.meta.version || '',
        file: name,
        body: parsed.body,
      })
    } catch (err) {
      console.warn('[imagestation] 规范文件 ' + name + ' 读失败：' + err.message)
    }
  }
  return out
}

/**
 * 组装出厂预设。
 * `base` 指向另一个预设时，被指向的规范全文排在前，本文件内容追加在后
 * （聚焦层叠加在通用规范之上）。只解一层继承，避免环。
 */
function buildBuiltins() {
  const files = loadSpecFiles()
  const list = []
  const ids = BUILTIN_ORDER.filter((id) => files.has(id))
  // 不在 BUILTIN_ORDER 里的文件也收进来，附在末尾，这样加文件即可加预设。
  for (const id of files.keys()) if (!ids.includes(id)) ids.push(id)

  for (const id of ids) {
    const entry = files.get(id)
    let system = entry.body
    if (entry.base && files.has(entry.base)) {
      const baseEntry = files.get(entry.base)
      system =
        baseEntry.body +
        '\n\n---\n\n' +
        '# 任务聚焦：' + entry.label +
        '\n\n' +
        entry.body
    }
    list.push({
      id,
      label: entry.label,
      description: entry.description,
      system,
      version: entry.version,
      file: entry.file,
      params: {},
      tags: [],
    })
  }

  // 兜底：specs 目录整个缺失时，至少留一条能用的，别让插件变成空壳。
  if (list.length === 0) {
    list.push({
      id: 'general',
      label: '通用',
      description: '（specs 目录缺失，使用内置兜底提示词）',
      system: [
        '你是一位资深的图像生成提示词工程师。用户会用中文给你一句简短的画面描述，',
        '你把它编译成一段完整、自然、明确的英文视觉指令。',
        '',
        '规则：',
        '1. 只输出提示词本身，不要解释、不要 Markdown、不要引号包裹。',
        '2. 用英文输出，专有名词保留原文。',
        '3. 以 "Create a polished ..." 开头，明确图片类型。',
        '4. 描述主体、动作、空间关系、场景、构图、光照、风格与氛围。',
        '5. 不要堆叠 masterpiece / best quality / 8k 这类质量词，也不要输出 Tag 列表。',
        '6. 补全细节，但不要改变用户给出的设定。',
      ].join('\n'),
      params: {},
      tags: [],
    })
  }
  return list
}

/** 出厂默认预设（进程内只组装一次）。 */
export const DEFAULT_PRESETS = buildBuiltins()

/** 当前出厂规范文件的元信息，给面板展示用。 */
export function specInventory() {
  return DEFAULT_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    version: p.version,
    file: p.file,
    chars: p.system.length,
  }))
}

/** 取一个预设；找不到就退回第一个，并把实际用的 id 一并返回。 */
export function resolvePreset(presets, id) {
  const list = Array.isArray(presets) && presets.length > 0 ? presets : DEFAULT_PRESETS
  const wanted = typeof id === 'string' ? id : ''
  const hit = list.find((p) => p && p.id === wanted)
  if (hit) return { preset: hit, requestedId: wanted, fallback: false }
  return { preset: list[0], requestedId: wanted, fallback: wanted !== '' && wanted !== list[0].id }
}

/**
 * 把用户 config 里的预设与出厂默认合并。
 * 同名 → 用户项整体替换（不做深合并：提示词是整体语感，半合并会产出自相矛盾的约束）；
 * 新名 → 追加。
 * 用户项可以只写 `system`（内联全文）或 `specFile`（指向 specs 目录里的文件）。
 */
export function mergePresets(userPresets) {
  if (!Array.isArray(userPresets) || userPresets.length === 0) return DEFAULT_PRESETS.slice()
  const out = DEFAULT_PRESETS.slice()
  for (const raw of userPresets) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') continue

    let system = typeof raw.system === 'string' ? raw.system : ''
    let label = typeof raw.label === 'string' ? raw.label : raw.id
    let description = typeof raw.description === 'string' ? raw.description : ''

    // 允许用户只指个文件名，正文从 specs 目录读。
    if (system === '' && typeof raw.specFile === 'string' && raw.specFile !== '') {
      const fromFile = loadSpecFiles().get(raw.specFile.replace(/\.md$/i, ''))
      if (fromFile) {
        system = fromFile.body
        if (typeof raw.label !== 'string') label = fromFile.label
        if (typeof raw.description !== 'string') description = fromFile.description
      } else {
        console.warn('[imagestation] 预设 ' + raw.id + ' 指定的 specFile 不存在：' + raw.specFile)
      }
    }
    // 都没给就沿用同名出厂预设的规范，只改显示名。
    if (system === '') {
      const existing = out.find((p) => p.id === raw.id)
      system = existing ? existing.system : ''
    }

    const entry = {
      id: raw.id,
      label,
      description,
      system,
      version: typeof raw.version === 'string' ? raw.version : '',
      file: typeof raw.specFile === 'string' ? raw.specFile : '',
      params: raw.params && typeof raw.params === 'object' ? raw.params : {},
      tags: Array.isArray(raw.tags) ? raw.tags : [],
    }
    const at = out.findIndex((p) => p.id === entry.id)
    if (at === -1) out.push(entry)
    else out[at] = entry
  }
  return out
}
