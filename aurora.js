/* aurora.js — 把「正在思考」状态文案换成大肥鱼
 * 目标：@deepseek-ai/dsh-client-ui-conversation → ChatView → TurnStatus 的 "Deep diving..."
 * 做法：只替换该文本节点，不碰 React 树、不改 class、不影响计时器与 aria-live。
 * 文案前面的图标由 aurora.css 的 ::before 提供（伪元素不参与 React 重渲染）。
 */
(() => {
  const FROM = 'Deep diving...'
  const TO = '大肥鱼正在吃你的 TOKEN'

  const swap = (root) => {
    if (!root || root.nodeType === 3) {
      if (root && root.nodeValue && root.nodeValue.trim() === FROM) root.nodeValue = TO
      return
    }
    if (root.nodeType !== 1) return
    if (root.tagName === 'SCRIPT' || root.tagName === 'STYLE') return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n; (n = walker.nextNode());) {
      if (n.nodeValue && n.nodeValue.trim() === FROM) n.nodeValue = n.nodeValue.replace(FROM, TO)
    }
  }

  const start = () => {
    swap(document.body)
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') { swap(r.target); continue }
        for (const n of r.addedNodes) swap(n)
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
    document.documentElement.dataset.aurora = 'on'
    console.log('[aurora] thinking-label swap armed')
  }

  if (!document.body) document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
