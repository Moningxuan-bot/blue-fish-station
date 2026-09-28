/**
 * 规范自检。
 *
 * 规范第 27 节给了一份"发送前必须检查"的清单。其中**可机械判定**的部分由代码兜底：
 * 把"模型自律"换成"代码保证"，因为模型偶尔会滑回它熟悉的 Tag 写法
 * （实测：即便系统提示词明确禁止，它仍可能吐出 `masterpiece, best quality`）。
 *
 * 这里只做**报告**，不改写模型输出 —— 自动改写会掩盖问题，而且容易改坏语感。
 * 结果随 `done` 事件一起推给面板，让人自己决定要不要重抽。
 */

/** 其他模型生态的质量词/标签，规范第 0 节与第 16 节点名禁止。 */
const BANNED_TOKENS = [
  'masterpiece',
  'best quality',
  'high quality',
  'ultra detailed',
  'ultra-detailed',
  'highly detailed',
  'absurdres',
  'score_9',
  'score 9',
  '8k',
  '4k',
  'uhd',
  'artist tag',
  'trending on artstation',
  'award winning',
  'best resolution',
]

/** danbooru 式计数标签：行首/逗号后的 `1girl` `2boys` `solo` 等。 */
const COUNT_TAG_RE = /(^|[,;\n]\s*)(\d+\s*(girl|girls|boy|boys|other|others)|solo|multiple girls|multiple boys)\s*(?=[,;\n]|$)/i

/** 逗号分隔的短片段列表：一个片段里词数很少且没有动词性结构，就当作 tag 串。 */
function looksLikeTagList(prompt) {
  const segments = prompt
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (segments.length < 8) return false
  // 规范要求的是完整句子/从句；tag 串的特征是大量 1–4 词的碎片。
  const short = segments.filter((s) => s.split(/\s+/).length <= 4).length
  return short / segments.length >= 0.7
}

/** 相邻重复的修饰词，如 "detailed, detailed" 或 "soft soft"。 */
function repeatedAdjectives(prompt) {
  const hits = []
  const words = prompt.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1] && words[i].length > 3) hits.push(words[i])
  }
  return [...new Set(hits)]
}

/**
 * 检查一段模型输出是否符合规范。
 *
 * @param {string} prompt 已规格化的提示词
 * @returns {{ok: boolean, issues: string[]}} issues 是给人看的中文说明
 */
export function lintPrompt(prompt) {
  const text = String(prompt || '')
  const lower = text.toLowerCase()
  const issues = []

  const banned = BANNED_TOKENS.filter((t) => lower.includes(t))
  if (banned.length > 0) {
    issues.push('出现了规范禁止的质量词：' + banned.join('、'))
  }

  if (COUNT_TAG_RE.test(text)) {
    issues.push('出现了 danbooru 式计数标签（如 1girl / solo），属于规范第 0 节禁止的 Tag 写法')
  }

  if (looksLikeTagList(text)) {
    issues.push('整体更像逗号分隔的 Tag 列表，而不是完整的自然语言描述（规范第 28 节）')
  }

  if (text.includes('```')) {
    issues.push('含 Markdown 代码围栏（规范第 26 节）')
  }
  if (/^\s*(#|[-*]\s|\d+\.\s)/m.test(text)) {
    issues.push('含 Markdown 标题或列表（规范第 26 节）')
  }
  if (/^\s*[{[<]/.test(text)) {
    issues.push('以 JSON / YAML / XML 结构开头（规范第 26 节）')
  }
  if (/negative\s*prompt\s*[:：]/i.test(text)) {
    issues.push('含 Negative Prompt 区块（规范第 21 节：应改为自然语言约束）')
  }
  if (/^\s*(here is|here's|sure[,!]|certainly)/i.test(text)) {
    issues.push('以对话式前言开头（规范第 26 节）')
  }

  const heads = text.match(/"[^"]{4,80}"/g)
  if (heads && heads.length >= 3) {
    issues.push('出现了多处引号包裹的短语，可能是关键词列表而非自然语言')
  }

  const dupes = repeatedAdjectives(text)
  if (dupes.length > 0) {
    issues.push('相邻重复的修饰词：' + dupes.join('、'))
  }

  if (!/^\s*create\b/i.test(text)) {
    issues.push('没有以 "Create a …" 开头明确图片类型（规范第 2、25 节）')
  }

  return { ok: issues.length === 0, issues }
}
