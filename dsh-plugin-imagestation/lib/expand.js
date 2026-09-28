/**
 * 扩写的核心：把中文描述交给 DSH 的 LLM，流式取回出图提示词。
 *
 * 刻意不碰 HTTP —— 传输层在 routes.js，这里只依赖 `ctx.llm`。好处有两个：
 * ① 能脱离服务器单独测（见 probe-expand.mjs）；
 * ② 以后 agent 工具要复用同一条流水线时，直接调它即可。
 *
 * LLM 调用是**无身份的一次性调用**：dsh-llm 的 GenerateOptions 明确允许
 * "a hand-built one-shot may include identity-free user inputs"，
 * 因此不需要伪造 agent、不绑定 session、不污染对话历史。
 */

import { lintPrompt } from './lint.js'

const MAX_TEXT_CHARS = 8000
const MAX_TAGS = 80

/**
 * 拼出发给模型的 system。
 *
 * 结构：**规范全文在最前**（它是知识主体），任务指令与 config 追加的额外约束排在后面。
 * 顺序有意如此：规范是"怎么做"，具体任务是一次性的，后者不该盖掉前者。
 */
function buildSystem(preset, config, tags) {
  const parts = []

  const spec = String(preset.system || '').trim()
  if (spec !== '') parts.push(spec)

  const language = String(config.outputLanguage || 'en').toLowerCase()
  const task = [
    '',
    '---',
    '',
    '# 本次任务',
    '',
    '下面会给你一句用户写的中文描述。请按上面的规范，把它编译成**一段**完整的视觉指令。',
    '',
    '- 只输出那段指令本身。不要标题、不要分段标签、不要解释、不要 Markdown。',
    '- 不要在开头写 "Here is your prompt" 之类的话。',
    '- 补全视觉细节，但**不得改变用户给出的设定**（规范第 22 节）。',
  ]
  if (language === 'en') {
    task.push('- 用英文输出；人名、地名等专有名词保留原文。')
  } else if (language === 'zh') {
    task.push('- 用中文输出。')
  } else {
    task.push('- 用 ' + language + ' 输出。')
  }
  parts.push(task.join('\n'))

  const extras = Array.isArray(config.extraRules) ? config.extraRules : []
  const clean = extras.map((r) => String(r || '').trim()).filter(Boolean)
  if (clean.length > 0) {
    parts.push(
      '',
      '# 本部署的额外约束（优先级高于通用规则）',
      '',
      ...clean.map((r, i) => `${i + 1}. ${r}`),
    )
  }

  if (Array.isArray(tags) && tags.length > 0) {
    // 预留给"视觉术语表"之类的可选素材。GPT Image 路线下通常为空。
    parts.push(
      '',
      '# 可参考的视觉术语（按需取用，不要罗列）',
      '',
      tags.slice(0, MAX_TAGS).map((t) => String(t)).join(', '),
    )
  }

  return parts.join('\n')
}

/** 规格化模型输出：去掉可能的代码围栏与包裹引号，压缩多余空行。 */
export function normalizePrompt(raw) {
  let s = String(raw || '').trim()
  // 有些模型会自作主张套一层 ```...```
  const fence = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/)
  if (fence) s = fence[1].trim()
  // 整体被引号包起来也去掉
  if (s.length > 1) {
    const first = s[0]
    const last = s[s.length - 1]
    if ((first === '"' && last === '"') || (first === '“' && last === '”')) s = s.slice(1, -1).trim()
  }
  return s.replace(/\n{3,}/g, '\n\n')
}

/**
 * 流式扩写。
 *
 * @param {object} args
 * @param {object} args.ctx       宿主 cordis 上下文（要用它的 ctx.llm）。
 * @param {object} args.preset    已解析的预设。
 * @param {string} args.input     用户的中文描述。
 * @param {object} [args.config]  插件配置（extraRules / llm 覆盖 / 温度等）。
 * @param {string[]} [args.tags]  本次可用的 TAG 词表。
 * @param {object} args.selection 目标模型选择 {provider, model, reasoningEffort?}。
 * @param {AbortSignal} [args.signal]
 * @yields {{type:'delta',text:string}|{type:'usage',usage:object}|{type:'done',prompt:string}}
 */
export async function* expandPrompt({ ctx, preset, input, config, tags, selection, signal }) {
  const cfg = config || {}
  const text = String(input == null ? '' : input).trim()
  if (text === '') {
    throw new Error('描述是空的：请先写下你想画什么。')
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(`描述太长（${text.length} 字符），上限 ${MAX_TEXT_CHARS}。`)
  }

  const provider = selection && selection.provider
  const model = selection && selection.model
  if (!provider || !model) {
    throw new Error(
      '拿不到可用的模型：请在 profile 的 agent-default-model 里配好 provider 与 model。',
    )
  }

  const options = {
    provider,
    model,
    system: buildSystem(preset, cfg, tags),
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  }
  if (Number.isFinite(cfg.temperature)) options.temperature = cfg.temperature
  if (Number.isFinite(cfg.maxTokens)) options.maxTokens = cfg.maxTokens
  if (signal) options.signal = signal
  if (selection.reasoningEffort) options.reasoningEffort = selection.reasoningEffort

  let assembled = ''
  let usage

  for await (const chunk of ctx.llm.stream(options)) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      assembled += chunk.text
      yield { type: 'delta', text: chunk.text }
    } else if (chunk.type === 'reasoning-delta') {
      // 推理内容不进提示词，但要让面板知道"它在想"，否则长推理期间界面像卡住了。
      yield { type: 'reasoning', text: String(chunk.text || '') }
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    }
  }

  const prompt = normalizePrompt(assembled)
  if (prompt === '') {
    throw new Error('模型没有产出任何内容。可以重试，或换一个描述再试。')
  }

  // 规范第 27 节的检查表里可机械判定的部分：只报告，不改写。
  const lint = lintPrompt(prompt)

  if (usage) yield { type: 'usage', usage }
  yield { type: 'done', prompt, lint }
}
