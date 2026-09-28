/**
 * dsh-plugin-imagestation — 绘图工作站的浏览器半侧。
 *
 * 本文件是**手写的客户端 bundle**，不经过任何构建步骤。它遵守 dsh-client-modules 的
 * 加载契约（与 DSH 自带客户端插件完全同形）：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * 执行本文件只做一件事：注册 factory。所有模块副作用（含样式注入）都在 factory 闭包内，
 * 因此在本插件被真正物化之前，页面上什么都不会发生。
 *
 * 可用的 require 目标只有外壳那张冻结的平台模块表：
 *   react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis,
 *   @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
 *   @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
 * 表外的任何请求都必须在 package.json 的 dsh.client.external 里声明提供方，
 * 否则组合阶段直接拒绝。本文件只用到 react。
 *
 * 刻意不写 JSX：JSX 需要编译器，而本机没有构建链。h() 用 React.createElement 实现，
 * 代价是每个元素多一层数组括号，换来改完文件直接生效、无构建等待。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-imagestation',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const createElement = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    /* ------------------------------------------------------------------ *
     * 无 JSX 的元素构造器。
     *   h('div.x.y', [h('span', '文字')])   →   <div class="x y"><span>文字</span></div>
     *   h(SomeComponent, { size: 18 })      →   <SomeComponent size={18} />
     * 类名写在标签串里，属性与子节点同处一个数组 —— 这是本文件唯一需要记住的约定。
     * ------------------------------------------------------------------ */

    /**
     * 第二（第三）参数是「属性表」还是「子节点」？
     *
     * 无 JSX 的固有歧义，靠 tag 形态 + 参数个数消解。两种调用约定都支持：
     *   h('svg', { width: 18 })                字符串标签 + 裸对象 = 属性表
     *   h('div.a', [children])                 类名在标签串里，第二参数是子节点
     *   h('button.dsis-back', { title }, '文字')  显式三参数 = 属性表 + 子节点
     *   h(Component, { size: 18 })             组件：对象即属性表
     *
     * 这里连着踩了三个坑，全是同一处歧义的不同侧面：
     *   ① 属性表落进 children 槽 → props 恒为 null，React 报 error #31
     *   ② 修正后过度收紧 → 字符串子节点被当属性表吞掉，按钮成了空壳
     *   ③ h 只声明两个形参 → 三参数调用点的第三参被静默丢弃
     * 教训：这个 helper 的每个分支都要有一个断言式的探针盯着（见 probe-createelement.mjs）。
     */
    function isPropsObject(v) {
      return v !== null && typeof v === 'object' && !Array.isArray(v) && !React.isValidElement(v)
    }

    /** 'margin-top:12px' → { marginTop: '12px' }。只为省掉一次性的类名。 */
    function parseStyleString(text) {
      const out = {}
      for (const part of String(text).split(';')) {
        const at = part.indexOf(':')
        if (at === -1) continue
        const key = part.slice(0, at).trim()
        const value = part.slice(at + 1).trim()
        if (key === '') continue
        out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
      }
      return out
    }

    function h(tag, second, third) {
      let name = tag
      let props = null
      let kids

      if (typeof tag === 'string') {
        const dot = tag.indexOf('.')
        if (dot === -1) {
          // 'svg' —— 裸对象只能是属性表
          if (isPropsObject(second)) {
            props = second
            kids = third
          } else {
            kids = second
          }
        } else {
          // 'div.a.b' —— 类名写在标签串里
          name = tag.slice(0, dot)
          props = { className: tag.slice(dot + 1).split('.').join(' ') }
          if (isPropsObject(second)) {
            // 显式属性表：与标签串里的类名合并，类名优先保留
            props = Object.assign({}, second, props)
            kids = third
          } else {
            kids = second
          }
        }
      } else if (isPropsObject(second)) {
        // 组件 —— 对象即属性表
        props = second
        kids = third
      } else {
        kids = second
      }

      // 极少数地方需要行内样式（例如只调一处间距）。React 要求 style 是对象，
      // 这里把标签串里的 style 字符串形式也接受下来，省得为一行间距加一个类。
      if (props && typeof props.style === 'string') {
        props = Object.assign({}, props, { style: parseStyleString(props.style) })
      }

      if (kids === undefined || kids === null) {
        return createElement(name, props)
      }
      if (Array.isArray(kids)) {
        return createElement(name, props, ...kids)
      }
      return createElement(name, props, kids)
    }

    /* ------------------------------------------------------------------ *
     * 样式。以 .dsis- 前缀命名，避免与外壳或其他插件的类名相撞。
     * 全部用外壳公开的 CSS 变量，因此自动跟随浅色/深色与主题切换。
     * ------------------------------------------------------------------ */
    const CSS = `
/* 背景刻意【不透明】：外壳的 AppFrame 自己就是 background: var(--dsw-alias-bg-base)
 * （aurora.css 称它为「全局调暗器」，一层 40% 白纱），本体再叠一层同样的令牌，
 * 文字才有和对话区一样的底子。曾经设成 transparent，结果整页比对话区更透，
 * 占位文字直接压在壁纸上，可读性掉下来。 */
.dsis-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;
  background:var(--dsw-alias-bg-base,rgba(255,255,255,.4));color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:20px}
.dsis-head{display:flex;align-items:center;gap:10px;padding:12px 18px;
  border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}
.dsis-title{font-size:15px;font-weight:600}
.dsis-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsis-back{margin-left:auto;flex:none;cursor:pointer;font-size:12px;
  color:var(--dsw-alias-label-secondary);background:0 0;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  padding:3px 10px}
.dsis-back:hover{background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary)}
.dsis-body{display:flex;flex:1;min-height:0}
.dsis-col{display:flex;flex-direction:column;min-height:0;min-width:0}
.dsis-col-tags{width:246px;flex:none;border-right:.5px solid var(--dsw-alias-border-l1)}
.dsis-col-main{flex:1;border-right:.5px solid var(--dsw-alias-border-l1)}
.dsis-col-side{width:262px;flex:none}
.dsis-colhead{flex:none;padding:9px 14px 7px;font-size:11px;letter-spacing:.04em;
  text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dsis-scroll{flex:1;min-height:0;overflow:auto;padding:0 14px 14px}
/* 占位块/卡片用更高一层的令牌打底。aurora 把 --dsw-alias-bg-base 设成 40% 白纱
 * （有意让壁纸透出来），所以只靠根元素打底时，内容少的页面会显得文字偏淡。
 * layer-2（.70）让每张卡自带可读底子，同时外层的壁纸氛围还在。 */
.dsis-placeholder{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.7));
  padding:12px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsis-step{margin:0 0 10px}
.dsis-stepname{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsis-stepdesc{color:var(--dsw-alias-label-tertiary);font-size:12px}

/* ---- 中栏工作区：描述输入 → 扩写 → 提示词确认 ---- */
.dsis-work{display:flex;flex-direction:column;gap:10px}
.dsis-field{display:flex;flex-direction:column;gap:5px}
.dsis-flabel{font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:6px}
.dsis-flabel .dsis-count{margin-left:auto;font-variant-numeric:tabular-nums}
.dsis-input,.dsis-out{box-sizing:border-box;width:100%;font:inherit;font-size:13px;line-height:19px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major,rgba(255,255,255,.72));
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  padding:7px 9px;resize:vertical}
.dsis-input{min-height:88px}
/* 输出框给足高度：规范要求的提示词通常在 2000–2600 字符，矮框会让人反复滚动。 */
.dsis-out{min-height:340px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.7))}
.dsis-input:focus,.dsis-out:focus{outline:none;border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.dsis-input::placeholder,.dsis-out::placeholder{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary))}
.dsis-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsis-btn{cursor:pointer;font:inherit;font-size:12px;border-radius:var(--dsw-radius-sm);
  border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);
  padding:4px 12px}
.dsis-btn:hover:not(:disabled){background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary)}
.dsis-btn:disabled{opacity:.5;cursor:default}
.dsis-btn-primary{border-color:transparent;background:var(--dsw-alias-label-primary);
  color:var(--dsw-alias-bg-base,#fff);font-weight:600}
.dsis-btn-primary:hover:not(:disabled){background:var(--dsw-alias-label-primary);
  color:var(--dsw-alias-bg-base,#fff);opacity:.88}
.dsis-chip{font-size:11px;padding:1px 8px;border-radius:999px;
  border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.dsis-reason{max-height:96px;overflow:auto;font-size:11px;line-height:16px;white-space:pre-wrap;
  color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-fill-l1,rgba(0,0,0,.03));
  border-radius:var(--dsw-radius-sm);padding:6px 8px}
.dsis-note{font-size:12px;border-radius:var(--dsw-radius-sm);padding:7px 9px;
  border:.5px solid var(--dsw-alias-border-l2)}
.dsis-note-err{color:var(--dsw-alias-state-error-primary,inherit);
  border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#c00) 45%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#c00) 8%, transparent)}
.dsis-usage{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* ---- 右栏：预设与模型 ---- */
.dsis-preset{display:flex;flex-direction:column;gap:2px;text-align:left;width:100%;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.7));padding:7px 9px;margin-bottom:6px;
  font:inherit;color:inherit}
.dsis-preset:hover{background:var(--dsw-alias-fill-l1)}
.dsis-preset[data-active="true"]{border-color:var(--dsw-alias-label-primary)}
.dsis-preset-label{font-size:12px;font-weight:600}
.dsis-preset-desc{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:16px}
.dsis-kv{display:flex;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 0}
.dsis-kv b{font-weight:500;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono)}

/* ---- 左栏：规范来源 ---- */
.dsis-specrow{display:flex;flex-direction:column;gap:1px;padding:6px 8px;margin-bottom:5px;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.7))}
.dsis-specname{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsis-specmeta{font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono);
  word-break:break-all}

/* ---- 规范自检结果 ---- */
.dsis-lint{border-radius:var(--dsw-radius-sm);padding:7px 9px;font-size:12px;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-fill-l1,rgba(0,0,0,.03))}
.dsis-lint ul{margin:5px 0 0;padding-left:18px}
.dsis-lint li{margin:2px 0;line-height:17px}
.dsis-lint-ok{color:var(--dsw-alias-label-secondary)}
.dsis-lint-warn{border-color:color-mix(in srgb, var(--dsw-alias-state-warning-primary,#c80) 45%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-warning-primary,#c80) 9%, transparent)}

/* ---- 出图区 ---- */
.dsis-draw{display:flex;flex-direction:column;gap:8px;padding-top:10px;
  border-top:.5px solid var(--dsw-alias-border-l1)}
.dsis-params{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.dsis-param{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsis-select{font:inherit;font-size:11px;color:var(--dsw-alias-label-primary);cursor:pointer;
  background:var(--dsw-specific-input-major,rgba(255,255,255,.72));
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:2px 5px}
.dsis-progress{display:flex;align-items:center;gap:8px;font-size:12px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l1,rgba(0,0,0,.03));
  border-radius:var(--dsw-radius-sm);padding:7px 9px}
.dsis-spinner{flex:none;width:11px;height:11px;border-radius:50%;
  border:1.6px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);
  animation:dsis-spin .8s linear infinite}
@keyframes dsis-spin{to{transform:rotate(360deg)}}

/* 画廊 */
.dsis-gallery{display:flex;flex-direction:column;gap:10px;padding-top:10px;
  border-top:.5px solid var(--dsw-alias-border-l1)}
.dsis-entry{display:flex;flex-direction:column;gap:6px;padding:9px;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.7))}
.dsis-thumb{display:block;line-height:0;border-radius:var(--dsw-radius-sm);overflow:hidden;
  border:.5px solid var(--dsw-alias-border-l2)}
.dsis-thumb:hover{border-color:var(--dsw-alias-label-secondary)}
.dsis-img{display:block;width:100%;height:auto;max-height:360px;object-fit:contain;
  background:repeating-conic-gradient(rgba(0,0,0,.06) 0% 25%, transparent 0% 50%) 50%/16px 16px}
.dsis-row .dsis-thumb{flex:1;min-width:0}
.dsis-details{font-size:11px}
.dsis-details summary{cursor:pointer;color:var(--dsw-alias-label-tertiary)}

/* ---- 参考图 ---- */
.dsis-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
  min-height:72px;padding:12px;cursor:pointer;text-align:center;font-size:12px;
  color:var(--dsw-alias-label-tertiary);
  border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.7))}
.dsis-drop:hover{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-secondary)}
/* 拖拽经过时给出明确的"松手即接收"信号，而不是只换个边框色 */
.dsis-drop-over{border-color:var(--dsw-alias-label-primary);border-style:solid;
  background:var(--dsw-alias-fill-l1,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary)}
.dsis-drop-hint{font-size:10px;opacity:.75}
.dsis-ref{display:flex;gap:10px;align-items:flex-start;padding:9px;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.7))}
.dsis-ref-img{flex:none;width:88px;height:88px;object-fit:cover;border-radius:var(--dsw-radius-sm);
  border:.5px solid var(--dsw-alias-border-l2)}
.dsis-ref-meta{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.dsis-ref-name{font-size:12px;font-weight:600;word-break:break-all}

/* ---- 出图目录提示 ---- */
.dsis-path{display:flex;align-items:baseline;gap:6px;font-size:11px;min-width:0}
.dsis-path-label{flex:none;color:var(--dsw-alias-label-tertiary)}
.dsis-path-value{min-width:0;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono);
  font-size:10px;word-break:break-all;
  background:var(--dsw-alias-fill-l1,rgba(0,0,0,.03));border-radius:var(--dsw-radius-xs,3px);padding:1px 5px}

/* ---- Key 输入（只在没找到凭据时出现） ---- */
.dsis-keyrow{display:flex;gap:6px;align-items:center;margin-top:8px}
.dsis-keyinput{flex:1;min-width:0;font:inherit;font-size:12px;box-sizing:border-box;
  color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major,rgba(255,255,255,.72));
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:5px 8px}
.dsis-keyinput:focus{outline:none;border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}

/* 累计花费 */
.dsis-wallet{display:flex;align-items:baseline;gap:5px;font-variant-numeric:tabular-nums}
.dsis-wallet-num{font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsis-wallet-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-right:8px}
`

    /* ------------------------------------------------------------------ *
     * 跨挂载的持久状态。
     *
     * **为什么必须这么做**：主区面板是 slot 组件，从绘图站切回对话时**整个组件被卸载**，
     * 用 useState 存的东西全部丢失 —— 出图记录、累计花费、参数选择会回到初始值，
     * 正在进行的那次出图虽然宿主侧还在跑，面板却再也接不回来。这是实测踩到的。
     *
     * 所以把这些状态放到组件之外。挂在 globalThis 上而不是普通模块变量，是因为
     * 客户端 bundle 被 HMR 替换时会**重新执行 factory**，模块变量会随之重置，
     * 而用户在 HMR 前后期望看到同一份记录。
     * ------------------------------------------------------------------ */

    const STORE_KEY = '__dshImageStationState'

    function getStore() {
      let s = globalThis[STORE_KEY]
      if (!s) {
        s = {
          gallery: [],
          wallet: { count: 0, usd: 0 },
          imgParams: null,
          presetId: null,
          /** 正在跑的那次出图：{ startedAt, prompt, hadReference }。null 表示空闲。 */
          running: null,
          lastDirectory: null,
        }
        globalThis[STORE_KEY] = s
      }
      return s
    }

    getStore()
    const storeListeners = new Set()

    /** 改持久状态并通知所有订阅者。所有写入都必须经过这里。 */
    function updateStore(patch) {
      const s = getStore()
      for (const [k, v] of Object.entries(patch)) s[k] = v
      for (const fn of storeListeners) {
        try {
          fn()
        } catch {
          /* 一个订阅者出错不该影响其他订阅者 */
        }
      }
    }

    /**
     * 订阅持久状态。返回 `[snapshot, update]`。
     *
     * 用 `useState` 只存一个版本号来强制重渲染，而不是把整个 store 塞进 state ——
     * 这样写入方（例如仍在运行的那个 fetch 循环）不需要拿到组件的 setState 就能更新界面，
     * 组件卸载后写入也不会丢，重新挂载时直接读到最新值。
     */
    function useStore() {
      const [, bump] = useState(0)
      useEffect(() => {
        const fn = () => bump((n) => n + 1)
        storeListeners.add(fn)
        // 重新挂载时对齐一次：卸载期间可能已经有写入。
        bump((n) => n + 1)
        return () => {
          storeListeners.delete(fn)
        }
      }, [])
      return [getStore(), updateStore]
    }

    /** 把样式表注入文档一次。factory 物化时才跑，插件被回收时外壳会一并回收。 */
    function installStyles() {
      const tagId = 'dsh-plugin-imagestation/station.css'
      if (document.querySelector('style[data-dsh-css="' + tagId + '"]') !== null) return
      const el = document.createElement('style')
      el.setAttribute('data-dsh-css', tagId)
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /* ------------------------------------------------------------------ *
     * 侧栏入口图标。侧栏自己拥有按钮、标签与选中态，这里只画图标。
     * 走 currentColor，因此自动继承选中/未选中时的文字色。
     * ------------------------------------------------------------------ */
    function StationIcon(props) {
      const size = props.size || 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        [
          // 画框 + 山 + 日，与 DSH 自带图标的描边风格一致
          h('rect', { key: 'frame', x: 3, y: 4, width: 18, height: 16, rx: 2.5 }),
          h('circle', { key: 'sun', cx: 8.5, cy: 9.5, r: 1.5 }),
          h('path', { key: 'hill', d: 'M3.5 17l5-5 3.5 3.5 3-3 5.5 5.5' }),
        ],
      )
    }

    /* ------------------------------------------------------------------ *
     * 与宿主通信。
     *
     * 走插件自己的 HTTP 路由（不是 DSH 的 Remote 机制：那需要构建期生成的
     * `/remote` 声明，第三方插件走不通）。令牌由宿主经 index tap 写在 <html> 的
     * data 属性上，浏览器解析完根标签即可读取，时序上一定早于 apply()。
     * ------------------------------------------------------------------ */

    const API = '/image-station'

    /** 读会话令牌。拿不到就返回空串 —— 调用方会拿到 401，并在面板上显示原因。 */
    function readToken() {
      try {
        const el = document.documentElement
        return (el && el.getAttribute('data-image-station-token')) || ''
      } catch {
        return ''
      }
    }

    /**
     * 取当前令牌。
     *
     * 页面里的令牌来自**渲染该页面时的宿主进程**，所以它可能过期：浏览器缓存了旧 bundle、
     * 或同时开着两个工作站窗口（各自是独立宿主进程）时，页面手上的令牌就与当前宿主不一致。
     * 这个端点让面板能重新问一次，从而自愈 —— 而不是让用户去理解令牌机制。
     */
    let tokenOverride = null
    async function refreshToken() {
      const res = await fetch(API + '/token', { headers: { 'cache-control': 'no-cache' } })
      if (!res.ok) throw new Error('取令牌失败：HTTP ' + res.status)
      const body = await res.json()
      if (!body || typeof body.token !== 'string' || body.token === '') {
        throw new Error('宿主没有返回令牌。')
      }
      tokenOverride = body.token
      return tokenOverride
    }

    const authHeader = () => ({ authorization: 'Bearer ' + (tokenOverride || readToken()) })

    /**
     * 带一次自愈重试的请求。
     *
     * 401 时先问 `/token` 拿当前令牌再重试一次；仍失败才报错。
     * 这样"陈旧令牌"从"用户看不懂的故障"变成"面板自己悄悄修好"。
     */
    async function fetchWithAuthRetry(path, init) {
      const build = () =>
        fetch(API + path, Object.assign({}, init, {
          headers: Object.assign({}, authHeader(), (init && init.headers) || {}),
        }))

      let res = await build()
      if (res.status !== 401) return res

      // 401：把响应体读出来（可能是要展示的诊断），再取新令牌重试。
      let firstBody = null
      try {
        firstBody = await res.text()
      } catch {
        /* 读不到就算了，重试优先 */
      }
      try {
        await refreshToken()
      } catch (err) {
        // 连令牌都取不到，就把第一次的错误如实抛出，附上取令牌的失败原因。
        const e = new Error('会话令牌不匹配，且自动重取令牌失败：' + (err && err.message ? err.message : String(err)))
        e.firstBody = firstBody
        throw e
      }
      res = await build()
      return res
    }

    /**
     * 把宿主的错误载荷拼成一句人话。
     *
     * 宿主的 401 会带 `diagnostic` 与 `hint`：**只报"令牌不对"对用户毫无帮助**。
     */
    function describeFailure(payload, res, text) {
      if (payload && (payload.message || payload.error)) {
        const parts = [payload.message || payload.error]
        if (payload.diagnostic) {
          const d = payload.diagnostic
          parts.push(
            '（收到：' + (d.receivedFrom || '未知') +
              '，值 ' + (d.receivedTail || '（空）') +
              '；宿主期望 ' + (d.expectedTail || '未知') + '）',
          )
        }
        if (payload.hint) parts.push(payload.hint)
        return parts.join('\n')
      }
      return 'HTTP ' + res.status + (text ? '：' + text.slice(0, 160) : '')
    }

    async function apiJson(path, options) {
      const res = await fetchWithAuthRetry(path, options)
      const text = await res.text()
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        /* 保留下面的状态码分支处理非 JSON 响应 */
      }
      if (!res.ok) throw new Error(describeFailure(payload, res, text))
      return payload
    }

    /* ------------------------------------------------------------------ *
     * 参考图处理（全部用浏览器原生能力，不引任何库）。
     *
     * 为什么必须在客户端压：一张 1024x1024 的 PNG 实测 0.6–1.0 MB，
     * base64 后还要再涨约 1/3。直传会撑大请求体（宿主侧 readBody 上限 4 MB），
     * 也让中转站白等更久。所以统一缩到长边 1536、转 JPEG —— 对"改这张图"这件事，
     * 分辨率不是瓶颈，理解画面才是。
     * ------------------------------------------------------------------ */

    const REF_MAX_EDGE = 1536
    const REF_MAX_BYTES = 2 * 1024 * 1024

    /** 可被图生图接受的输入类型。中转站的 edits 要的是真图片，SVG 之类不算。 */
    const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = () => reject(new Error('读取文件失败'))
        fr.readAsDataURL(file)
      })
    }

    function loadImageElement(src) {
      return new Promise((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('这个文件不是浏览器能解码的图片'))
        el.src = src
      })
    }

    /** 缩到长边 REF_MAX_EDGE 并转 JPEG；已经够小就原样返回，不做无谓的重编码。 */
    async function shrinkImage(file) {
      const dataUrl = await readAsDataUrl(file)
      if (file.size <= REF_MAX_BYTES) {
        return { dataUrl, name: file.name, type: file.type || 'image/png', bytes: file.size, resized: false }
      }
      const img = await loadImageElement(dataUrl)
      const scale = Math.min(1, REF_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.max(1, Math.round(img.naturalWidth * scale))
      const h = Math.max(1, Math.round(img.naturalHeight * scale))

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const cx = canvas.getContext('2d')
      // 转 JPEG 会丢掉 alpha，透明区填白 —— 否则会变成黑底。
      cx.fillStyle = '#ffffff'
      cx.fillRect(0, 0, w, h)
      cx.drawImage(img, 0, 0, w, h)

      const out = canvas.toDataURL('image/jpeg', 0.92)
      // 万一压完反而更大（极少见），就用原图。
      if (out.length * 0.75 >= file.size) {
        return { dataUrl, name: file.name, type: file.type || 'image/png', bytes: file.size, resized: false }
      }
      return {
        dataUrl: out,
        name: file.name.replace(/\.[^.]+$/, '') + '.jpg',
        type: 'image/jpeg',
        bytes: Math.round(out.length * 0.75),
        resized: true,
        width: w,
        height: h,
        originalWidth: img.naturalWidth,
        originalHeight: img.naturalHeight,
      }
    }

    /** 面板的全部状态。抽成 hook 是为了让组件只负责画，逻辑集中在一处。 */
    function useStation() {
      const [ready, setReady] = useState(false)
      const [bootError, setBootError] = useState(null)
      const [presets, setPresets] = useState([])
      const [presetId, setPresetId] = useState(null)
      const [model, setModel] = useState(null)
      const [modelError, setModelError] = useState(null)
      const [specFiles, setSpecFiles] = useState([])

      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [reasoning, setReasoning] = useState('')
      const [prompt, setPrompt] = useState('')
      const [usage, setUsage] = useState(null)
      const [lint, setLint] = useState(null)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [runId, setRunId] = useState(0)

      /* ---- 出图侧 ---- */
      const [imageInfo, setImageInfo] = useState(null)
      /* 这些放在持久 store 里，切面板不丢（见 useStore 的说明）。 */
      const [persist, setPersist] = useStore()
      const imgParams = persist.imgParams || { size: '1024x1024', quality: 'medium', n: 1 }
      const setImgParams = (next) => setPersist({ imgParams: next })
      const [drawing, setDrawing] = useState(false)
      const [drawProgress, setDrawProgress] = useState('')
      const [nowTick, setNowTick] = useState(0)
      const [reference, setReference] = useState(null)
      const [refBusy, setRefBusy] = useState(false)
      const [dragOver, setDragOver] = useState(false)
      const [keyDraft, setKeyDraft] = useState('')
      const [keySaving, setKeySaving] = useState(false)
      const [keyMessage, setKeyMessage] = useState(null)
      const fileRef = useRef(null)
      const drawAbortRef = useRef(null)
      const attachedRef = useRef(false)

      const gallery = persist.gallery
      const wallet = persist.wallet

      const abortRef = useRef(null)
      const outRef = useRef(null)
      const streamedRef = useRef('')

      /** 凭据是否就位。宿主只回脱敏状态，Key 本身从不进浏览器。 */
      const hasKey = Boolean(imageInfo && imageInfo.credentials && imageInfo.credentials.hasKey)

      // 拉一次预设清单与目标模型。
      useEffect(() => {
        let alive = true
        apiJson('/presets')
          .then((data) => {
            if (!alive) return
            setPresets(data.presets || [])
            const wanted = data.defaultPresetId || (data.presets && data.presets[0] && data.presets[0].id) || null
            // 用户选过的预设优先，不要每次重挂载都被服务端默认值覆盖。
            setPresetId(persist.presetId || wanted)
            setModel(data.model || null)
            setModelError(data.modelError || null)
            setSpecFiles(data.specFiles || [])
            setImageInfo(data.image || null)
            if (data.image && data.image.defaults && !getStore().imgParams) {
              setPersist({ imgParams: data.image.defaults })
            }
            setReady(true)
          })
          .catch((err) => {
            if (!alive) return
            setBootError(err && err.message ? err.message : String(err))
            setReady(true)
          })
        return () => {
          alive = false
        }
      }, [])

      // 扩写进行中时，把光标钉在输出框末尾，让流式出词可见。
      useEffect(() => {
        const el = outRef.current
        if (busy && el) el.scrollTop = el.scrollHeight
      }, [busy, runId])

      const stop = () => {
        if (abortRef.current) abortRef.current.abort()
      }

      const expand = async () => {
        if (busy) return
        const input = text.trim()
        if (input === '') {
          setError('先写下你想画什么。')
          return
        }
        setBusy(true)
        setError(null)
        setNotice(null)
        setUsage(null)
        setLint(null)
        setReasoning('')
        streamedRef.current = ''
        setPrompt('')
        setRunId((n) => n + 1)

        const ac = new AbortController()
        abortRef.current = ac

        try {
          const res = await fetchWithAuthRetry('/expand', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: input, presetId }),
            signal: ac.signal,
          })

          if (!res.ok) {
            const raw = await res.text()
            let payload = null
            try {
              payload = raw ? JSON.parse(raw) : null
            } catch {
              /* 用下面的兜底文案 */
            }
            throw new Error(describeFailure(payload, res, raw))
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''

          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let nl
            while ((nl = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, nl).trim()
              buffer = buffer.slice(nl + 1)
              if (line === '') continue
              let event
              try {
                event = JSON.parse(line)
              } catch {
                continue
              }
              if (event.type === 'start') {
                streamedRef.current = ''
                setModel(event.model || null)
                if (event.presetFallback) {
                  setNotice('预设「' + event.requestedPresetId + '」不存在，已回退到「' + event.presetId + '」。')
                }
              } else if (event.type === 'delta') {
                streamedRef.current += event.text
                setPrompt(streamedRef.current)
              } else if (event.type === 'reasoning') {
                setReasoning((prev) => prev + event.text)
              } else if (event.type === 'usage') {
                setUsage(event.usage || null)
              } else if (event.type === 'done') {
                // done 里是规格化后的成品：去掉围栏、引号、压缩空行。
                streamedRef.current = event.prompt
                setPrompt(event.prompt)
                if (event.lint) setLint(event.lint)
              } else if (event.type === 'error') {
                if (!event.aborted) setError(event.message || '扩写失败。')
              }
            }
          }
        } catch (err) {
          if (err && err.name === 'AbortError') {
            setNotice('已停止。上面的文字是停下时已生成的部分，可以直接用或继续改。')
          } else {
            setError(err && err.message ? err.message : String(err))
          }
        } finally {
          setBusy(false)
          abortRef.current = null
        }
      }

      /**
       * 出图。与扩写同构：POST + NDJSON 流，进度实时可见。
       *
       * 这一步要花钱，所以：出图前必须先有提示词；进度里明确报"第几次尝试"，
       * 因为这台中转站上游会间歇性枯竭，重试是常态而不是故障。
       */
      const draw = async () => {
        if (getStore().running) return
        const p = prompt.trim()
        if (p === '') {
          setError('还没有提示词。先扩写，或者直接在提示词框里写一段。')
          return
        }
        setDrawing(true)
        setError(null)
        setNotice(null)
        setDrawProgress('正在提交…')

        // 标记"有一次出图在跑"，并记住起点 —— 这样即使面板被卸载，
        // 重新挂载时也能显示"已经跑了多久"，而不是一片空白。
        const startedAt = Date.now()
        setPersist({
          running: { startedAt, prompt: p.slice(0, 120), hadReference: Boolean(reference) },
        })

        const ac = new AbortController()
        drawAbortRef.current = ac

        try {
          const res = await fetchWithAuthRetry('/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              Object.assign(
                { prompt: p, params: imgParams },
                // 有参考图就走图生图：把图交给宿主，它转成 multipart 发给 /v1/images/edits。
                reference
                  ? {
                      image: {
                        dataBase64: String(reference.dataUrl).split(',')[1] || '',
                        name: reference.name || 'reference.png',
                        type: reference.type || 'image/png',
                      },
                    }
                  : null,
              ),
            ),
            signal: ac.signal,
          })

          if (!res.ok) {
            const raw = await res.text()
            let payload = null
            try {
              payload = raw ? JSON.parse(raw) : null
            } catch {
              /* 用下面的兜底文案 */
            }
            throw new Error(describeFailure(payload, res, raw))
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''

          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let nl
            while ((nl = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, nl).trim()
              buffer = buffer.slice(nl + 1)
              if (line === '') continue
              let event
              try {
                event = JSON.parse(line)
              } catch {
                continue
              }
              if (event.type === 'progress') {
                setDrawProgress(event.message)
              } else if (event.type === 'done') {
                setDrawProgress('')
                // 写进持久 store：面板此刻可能已经被卸载，用 setState 会丢。
                const s = getStore()
                const n = event.images ? event.images.length : 0
                const usd = event.cost && typeof event.cost.usd === 'number' ? event.cost.usd : 0
                setPersist({
                  gallery: s.gallery.concat([event]),
                  wallet: { count: s.wallet.count + n, usd: s.wallet.usd + usd },
                  running: null,
                  lastDirectory: event.directory || s.lastDirectory,
                })
                // running 清掉后 drawing 也要归位，否则按钮仍显示"出图中…"
                // （返回给面板的 drawing 是两者的或，两个都得放）。
                setDrawing(false)
                if (event.warnings && event.warnings.length > 0) {
                  setNotice('出图完成，但有 ' + event.warnings.length + ' 条提示（见下方本次结果）。')
                }
              } else if (event.type === 'error') {
                setDrawProgress('')
                setPersist({ running: null })
                if (!event.aborted) {
                  const detail =
                    event.attempts && event.attempts.length > 0
                      ? '（尝试 ' + event.attempts.length + ' 次：' +
                        event.attempts.map((a) => 'HTTP ' + a.status).join('、') + '）'
                      : ''
                  setError((event.message || '出图失败。') + detail)
                }
              }
            }
          }
        } catch (err) {
          setPersist({ running: null })
          if (err && err.name === 'AbortError') {
            setNotice('已取消出图。已提交的请求可能仍在上游执行。')
          } else {
            setError(err && err.message ? err.message : String(err))
          }
        } finally {
          setDrawing(false)
          setDrawProgress('')
          drawAbortRef.current = null
        }
      }

      const stopDraw = () => {
        if (drawAbortRef.current) drawAbortRef.current.abort()
      }

      /**
       * 重新挂载时，如果宿主侧还有一次出图在跑，就**接回来** ——
       * 显示"已经跑了多久"，而不是让用户以为任务丢了。
       *
       * 诚实的边界：原始那次请求的流只存在于它自己的闭包里，组件卸载后拿不回来，
       * 所以重新挂载**看不到实时进度**，只能等它结束时由那段闭包写入 store 再显示结果。
       * 要连进度都恢复，需要宿主侧建任务登记表（见 DESIGN 的后续项），那是更大的改动。
       */
      useEffect(() => {
        const s = getStore()
        if (s.running) {
          setDrawing(true)
          setDrawProgress('这次出图仍在进行（换页不会中断它，完成后会自动出现在记录里）')
        } else {
          // 关键：卸载期间那次出图可能已经结束了（结束由它的闭包写入 store，
          // 但无法写回一个已经不存在的组件的 useState）。所以重挂载时必须
          // 主动把 drawing 归位，否则按钮会一直卡在"出图中…"。
          setDrawing(false)
          setDrawProgress('')
        }
        attachedRef.current = true
      }, [])

      // 出图进行中时每秒跳一次，让"已等待 N 秒"是活的。
      useEffect(() => {
        if (!persist.running) return undefined
        const t = setInterval(() => setNowTick((n) => n + 1), 1000)
        return () => clearInterval(t)
      }, [persist.running])

      /**
       * 收下一张参考图（来自文件选择或拖拽）。
       *
       * 验收条件写在前面而不是事后补救：不是图片、或解码不了，就明确拒绝并说明原因，
       * 而不是把坏数据送到上游让中转站报一个看不懂的错。
       */
      const acceptReference = async (file) => {
        if (!file) return
        if (!ACCEPTED_TYPES.includes(file.type)) {
          setError('参考图只支持 PNG / JPEG / WebP，实际是「' + (file.type || '未知类型') + '」。')
          return
        }
        setRefBusy(true)
        setError(null)
        try {
          const shrunk = await shrinkImage(file)
          setReference(Object.assign({}, shrunk, { sourceName: file.name }))
        } catch (err) {
          setError('参考图读取失败：' + (err && err.message ? err.message : String(err)))
        } finally {
          setRefBusy(false)
          // 清空 input 的值，否则同一个文件再选一次不会触发 change。
          if (fileRef.current) fileRef.current.value = ''
        }
      }

      const clearReference = () => {
        setReference(null)
        setError(null)
      }

      /** 从画廊里挑一张当参考图 —— 迭代改图时最常用的入口。 */
      const useGalleryImageAsReference = async (url, name) => {
        setRefBusy(true)
        setError(null)
        try {
          const res = await fetch(url)
          if (!res.ok) throw new Error('取图失败：HTTP ' + res.status)
          const blob = await res.blob()
          const file = new File([blob], name || 'reference.png', { type: blob.type || 'image/png' })
          const shrunk = await shrinkImage(file)
          setReference(Object.assign({}, shrunk, { sourceName: '(来自画廊) ' + (name || '') }))
        } catch (err) {
          setError('取画廊图片失败：' + (err && err.message ? err.message : String(err)))
        } finally {
          setRefBusy(false)
        }
      }

      /**
       * 把 Key 交给宿主写进本地 Key 文件。
       *
       * 写盘后宿主会**重新解析一次**再回报，所以"保存成功"意味着真的能读到，
       * 而不是"我以为写进去了"。成功后立刻刷新凭据状态，出图按钮随之解禁。
       */
      const saveKey = async () => {
        const key = keyDraft.trim()
        if (key === '' || keySaving) return
        setKeySaving(true)
        setKeyMessage(null)
        setError(null)
        try {
          const res = await apiJson('/key', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key }),
          })
          setKeyDraft('')
          setKeyMessage(res && res.message ? res.message : '已保存。')
          // 用宿主回报的状态就地更新，省一次 /presets 往返。
          if (res && res.credentials && imageInfo) {
            setImageInfo(Object.assign({}, imageInfo, { credentials: res.credentials }))
          }
        } catch (err) {
          setError('保存 Key 失败：' + (err && err.message ? err.message : String(err)))
        } finally {
          setKeySaving(false)
        }
      }

      const dropHandlers = {
        onDragOver: (e) => {
          e.preventDefault()
          if (!dragOver) setDragOver(true)
        },
        onDragLeave: (e) => {
          e.preventDefault()
          setDragOver(false)
        },
        onDrop: (e) => {
          e.preventDefault()
          setDragOver(false)
          const files = e.dataTransfer && e.dataTransfer.files
          if (files && files.length > 0) acceptReference(files[0])
        },
      }

      return {
        ready, bootError, presets,
        presetId,
        // 预设选择也要持久：切面板回来不该被服务端默认值覆盖。
        setPresetId: (id) => {
          setPresetId(id)
          setPersist({ presetId: id })
        },
        model, modelError,
        text, setText, busy, reasoning, prompt, setPrompt, usage, lint, error, notice,
        specFiles, expand, stop, outRef,
        imageInfo, imgParams, setImgParams, drawProgress, gallery, wallet, draw, stopDraw,
        /**
         * 是否正在出图 —— **派生自持久 store**，而不是只用局部 useState。
         *
         * 局部标志在组件卸载时来不及归位（出图结束时那个闭包写不回一个已消失的组件），
         * 于是"切走再切回"会让按钮卡在"出图中…"。`running` 在 store 里，
         * 它的有无才是权威事实；局部 `drawing` 只覆盖"刚点下、尚未写入 running"那一瞬。
         */
        drawing: drawing || Boolean(persist.running),
        /** 出图中：起点、提示词摘要、是否带参考图。切面板回来据此显示"仍在进行"。 */
        running: persist.running,
        runningSeconds: persist.running ? Math.floor((Date.now() - persist.running.startedAt) / 1000) : 0,
        /** 出图落盘的绝对目录。必须显示出来，否则用户不知道图存到哪儿了。 */
        outputDir: (imageInfo && imageInfo.outputDir) || persist.lastDirectory || null,
        reference, refBusy, dragOver, fileRef, acceptReference, clearReference,
        useGalleryImageAsReference, dropHandlers,
        hasKey, keyDraft, setKeyDraft, keySaving, keyMessage, saveKey,
      }
    }

    /* ------------------------------------------------------------------ *
     * 主区整页正文。
     * ------------------------------------------------------------------ */
    function StationPage(props) {
      installStyles()

      const back = props.stationBack
      const s = useStation()

      const canExpand = s.ready && !s.busy && s.text.trim() !== '' && !s.modelError && !!s.model

      return h('div.dsis-root', [
        h('div.dsis-head', [
          h('span.dsis-title', '绘图工作站'),
          h('span.dsis-sub', '提示词流水线'),
          h(
            'button.dsis-back',
            {
              type: 'button',
              title: s.running ? '出图还在进行中' : '切回对话',
              onClick: () => {
                // 出图中切走虽然不会再丢状态（记录在持久 store 里），但用户会以为任务没了。
                // 所以先问一句，并说明真实后果 —— 而不是硬拦。
                if (s.running) {
                  const ok = window.confirm(
                    '出图还在进行中（已等待 ' + s.runningSeconds + ' 秒）。\n\n' +
                      '切回对话不会中断这次出图，完成后它会自动出现在出图记录里；\n' +
                      '但你要等它跑完再切回来才看得到进度。\n\n确定切走吗？',
                  )
                  if (!ok) return
                }
                if (typeof back === 'function') back()
              },
            },
            '切回对话',
          ),
        ]),
        h('div.dsis-body', [
          /* ---- 左：规范与知识来源 ---- */
          h('div.dsis-col.dsis-col-tags', [
            h('div.dsis-colhead', '提示规范'),
            h('div.dsis-scroll', [
              h(
                'div.dsis-placeholder',
                [
                  h('div.dsis-stepname', 'GPT Image 用自然语言，不用 TAG'),
                  h(
                    'div.dsis-stepdesc',
                    '规范要求把画面编译成一段完整描述：主体 → 动作 → 空间关系 → 构图 → 光照 → 风格。' +
                      '禁止 masterpiece / 8k / 1girl 这类别的模型生态的质量词与 Tag 列表。',
                  ),
                ],
              ),
              h('div.dsis-flabel', { style: { marginTop: '12px' } }, '知识来源（specs/*.md）'),
              s.specFiles.length === 0
                ? h('div.dsis-placeholder', s.ready ? '宿主没有加载到规范文件。' : '加载中…')
                : h(
                    'div',
                    s.specFiles.map((f) =>
                      h('div.dsis-specrow', { key: f.id }, [
                        h('span.dsis-specname', f.label),
                        h(
                          'span.dsis-specmeta',
                          'specs/' + f.file + (f.version ? '  ' + f.version : '') +
                            '  ' + f.chars + ' 字符',
                        ),
                      ]),
                    ),
                  ),
              h(
                'div.dsis-stepdesc',
                { style: { marginTop: '10px' } },
                '改规格＝改 specs 目录里的 .md 文件，然后按 F5。不用改代码。',
              ),
            ]),
          ]),

          /* ---- 中：描述 → 扩写 → 提示词确认 ---- */
          h('div.dsis-col.dsis-col-main', [
            h('div.dsis-colhead', '提示词'),
            h('div.dsis-scroll', [
              h('div.dsis-work', [
                h('div.dsis-field', [
                  h('label.dsis-flabel', [
                    h('span', '你想画什么'),
                    h('span.dsis-count', String(s.text.length) + ' 字'),
                  ]),
                  h('textarea.dsis-input', {
                    value: s.text,
                    placeholder: '用中文写一句描述，例如：一只戴围巾的橘猫坐在窗台上看雪',
                    spellCheck: false,
                    onChange: (e) => s.setText(e.target.value),
                  }),
                ]),

                h('div.dsis-row', [
                  h(
                    'button.dsis-btn.dsis-btn-primary',
                    {
                      type: 'button',
                      disabled: !canExpand,
                      onClick: () => s.expand(),
                    },
                    s.busy ? '扩写中…' : '扩写提示词',
                  ),
                  s.busy
                    ? h('button.dsis-btn', { type: 'button', onClick: () => s.stop() }, '停止')
                    : null,
                  s.model
                    ? h('span.dsis-chip', s.model.provider + ' / ' + s.model.model)
                    : h('span.dsis-chip', '未取到模型'),
                ]),

                s.bootError
                  ? h('div.dsis-note.dsis-note-err', '连不上宿主：' + s.bootError)
                  : null,
                s.modelError
                  ? h('div.dsis-note.dsis-note-err', s.modelError)
                  : null,
                s.notice ? h('div.dsis-note', s.notice) : null,
                s.error ? h('div.dsis-note.dsis-note-err', s.error) : null,

                s.reasoning !== ''
                  ? h('div.dsis-field', [
                      h('div.dsis-flabel', '模型的思考过程（不进提示词）'),
                      h('div.dsis-reason', s.reasoning),
                    ])
                  : null,

                h('div.dsis-field', [
                  h('label.dsis-flabel', [
                    h('span', '出图提示词（可以改）'),
                    s.usage
                      ? h(
                          'span.dsis-usage.dsis-count',
                          'in ' + s.usage.inputTokens + ' / out ' + s.usage.outputTokens,
                        )
                      : null,
                  ]),
                  h('textarea.dsis-out', {
                    ref: s.outRef,
                    value: s.prompt,
                    placeholder: '扩写结果会实时出现在这里，改完再去出图。',
                    spellCheck: false,
                    onChange: (e) => s.setPrompt(e.target.value),
                  }),
                ]),

                /* 规范第 27 节的检查表里可机械判定的部分。只报告，不改写模型输出 —— */
                /* 自动改写会掩盖问题，也容易改坏语感；重抽与否由人决定。 */
                s.lint
                  ? h(
                      'div.dsis-lint' + (s.lint.ok ? '.dsis-lint-ok' : '.dsis-lint-warn'),
                      s.lint.ok
                        ? ['规范自检：通过（无质量词、无 Tag 列表、无 Markdown、以 Create 开头）']
                        : [
                            h('b', '规范自检发现 ' + s.lint.issues.length + ' 处问题（仅供参考，不阻止出图）：'),
                            h('ul', s.lint.issues.map((t, i) => h('li', { key: i }, t))),
                          ],
                    )
                  : null,

                /* ---- 参考图（图生图）。不给图就是文生图 ---- */
                h('div.dsis-field', [
                  h('label.dsis-flabel', [
                    h('span', '参考图（可选）'),
                    h(
                      'span.dsis-count',
                      s.reference ? '给了图 → 走图生图，输出尺寸跟随输入图' : '不给图就是文生图',
                    ),
                  ]),

                  s.reference
                    ? h('div.dsis-ref', [
                        h('img.dsis-ref-img', { src: s.reference.dataUrl, alt: '参考图' }),
                        h('div.dsis-ref-meta', [
                          h('div.dsis-ref-name', s.reference.name || '参考图'),
                          h(
                            'div.dsis-stepdesc',
                            Math.round(s.reference.bytes / 1024) + ' KB' +
                              (s.reference.resized
                                ? '（已从 ' + s.reference.originalWidth + 'x' + s.reference.originalHeight +
                                  ' 压到 ' + s.reference.width + 'x' + s.reference.height + '）'
                                : '（未压缩，本来就不大）'),
                          ),
                          h('div.dsis-row', [
                            h(
                              'button.dsis-btn',
                              {
                                type: 'button',
                                onClick: () => {
                                  if (s.fileRef.current) s.fileRef.current.click()
                                },
                              },
                              '换一张',
                            ),
                            h('button.dsis-btn', { type: 'button', onClick: () => s.clearReference() }, '去掉'),
                          ]),
                        ]),
                      ])
                    : h(
                        'div.dsis-drop' + (s.dragOver ? '.dsis-drop-over' : ''),
                        Object.assign({}, s.dropHandlers, {
                          onClick: () => {
                            if (s.fileRef.current) s.fileRef.current.click()
                          },
                        }),
                        [
                          s.refBusy
                            ? h('span', '正在处理图片…')
                            : h('span', '把图片拖到这里，或点一下选择文件'),
                          h('span.dsis-drop-hint', 'PNG / JPEG / WebP，超过 2 MB 会自动压缩'),
                        ],
                      ),

                  h('input', {
                    ref: s.fileRef,
                    type: 'file',
                    accept: ACCEPTED_TYPES.join(','),
                    style: 'display:none',
                    onChange: (e) => {
                      const f = e.target.files && e.target.files[0]
                      if (f) s.acceptReference(f)
                    },
                  }),

                  s.reference
                    ? h(
                        'div.dsis-stepdesc',
                        '写清楚"要改什么、保留什么"。上游会重绘整张图，说"保持其余部分不变"比只说要改的部分更稳。',
                      )
                    : null,
                ]),

                /* ---- 出图 ---- */
                h('div.dsis-draw', [
                  h('div.dsis-row', [
                    h(
                      'button.dsis-btn.dsis-btn-primary',
                      {
                        type: 'button',
                        disabled: s.drawing || s.prompt.trim() === '' || !s.hasKey,
                        onClick: () => s.draw(),
                      },
                      s.drawing ? '出图中…' : '出图',
                    ),
                    s.drawing
                      ? h('button.dsis-btn', { type: 'button', onClick: () => s.stopDraw() }, '取消')
                      : null,
                    s.imageInfo
                      ? h('span.dsis-chip', s.imageInfo.model)
                      : null,
                  ]),

                  /* 凭据没就位时，把"找过哪儿、怎么修"直接摆出来，
                   * 并在面板里提供写入口 —— 而不是让用户去猜环境变量。 */
                  !s.hasKey && s.imageInfo && s.imageInfo.credentials
                    ? h('div.dsis-note.dsis-note-err', [
                        h('b', '还没找到出图接口的 Key。已查找：'),
                        h(
                          'ul',
                          s.imageInfo.credentials.sources.map((src, i) =>
                            h('li', { key: i }, src.where),
                          ),
                        ),
                        h('div.dsis-keyrow', [
                          h('input.dsis-keyinput', {
                            type: 'password',
                            value: s.keyDraft,
                            placeholder: '把 Key 粘到这里（sk-…），只写进本机文件',
                            spellCheck: false,
                            onChange: (e) => s.setKeyDraft(e.target.value),
                            onKeyDown: (e) => {
                              if (e.key === 'Enter') s.saveKey()
                            },
                          }),
                          h(
                            'button.dsis-btn.dsis-btn-primary',
                            {
                              type: 'button',
                              disabled: s.keySaving || s.keyDraft.trim() === '',
                              onClick: () => s.saveKey(),
                            },
                            s.keySaving ? '写入中…' : '保存',
                          ),
                        ]),
                        h(
                          'div.dsis-stepdesc',
                          '会写进 ' + s.imageInfo.credentials.setupHint.file +
                            '（不进 git），' + s.imageInfo.credentials.setupHint.note,
                        ),
                      ])
                    : null,

                  s.keyMessage ? h('div.dsis-note', s.keyMessage) : null,

                  s.drawing
                    ? h('div.dsis-progress', [
                        h('span.dsis-spinner'),
                        h('span', s.drawProgress || '正在出图…'),
                        s.running
                          ? h('span.dsis-usage', '已等待 ' + s.runningSeconds + ' 秒')
                          : null,
                        s.imageInfo
                          ? h('span.dsis-usage', '（实测每张 ' +
                              s.imageInfo.typicalSeconds[0] + '–' + s.imageInfo.typicalSeconds[1] +
                              ' 秒，上游繁忙时会自动重试，属正常）')
                          : null,
                      ])
                    : null,

                  /* 出图目录：必须明写出来。用户反馈过"图片没有具体存储位置"——
                   * 因为原先只存在一个相对路径，谁也不知道它落到哪儿去了。 */
                  s.outputDir
                    ? h('div.dsis-path', [
                        h('span.dsis-path-label', '图片存到'),
                        h('code.dsis-path-value', s.outputDir),
                      ])
                    : null,

                  /* 参数区 */
                  s.imageInfo
                    ? h('div.dsis-params', [
                        h('label.dsis-param', [
                          h('span', '尺寸'),
                          h(
                            'select.dsis-select',
                            {
                              value: s.imgParams.size || '1024x1024',
                              onChange: (e) =>
                                s.setImgParams(Object.assign({}, s.imgParams, { size: e.target.value })),
                            },
                            ['1024x1024', '1536x1024', '1024x1536'].map((v) =>
                              h('option', { key: v, value: v }, v),
                            ),
                          ),
                        ]),
                        h('label.dsis-param', [
                          h('span', '质量'),
                          h(
                            'select.dsis-select',
                            {
                              value: s.imgParams.quality || 'medium',
                              onChange: (e) =>
                                s.setImgParams(Object.assign({}, s.imgParams, { quality: e.target.value })),
                            },
                            ['low', 'medium'].map((v) => h('option', { key: v, value: v }, v)),
                          ),
                        ]),
                        h('label.dsis-param', [
                          h('span', '张数'),
                          h(
                            'select.dsis-select',
                            {
                              value: String(s.imgParams.n || 1),
                              onChange: (e) =>
                                s.setImgParams(Object.assign({}, s.imgParams, { n: Number(e.target.value) })),
                            },
                            [1, 2, 3, 4].map((v) => h('option', { key: v, value: String(v) }, String(v))),
                          ),
                        ]),
                      ])
                    : null,
                  s.imageInfo && s.imageInfo.ignoredParams
                    ? h(
                        'div.dsis-stepdesc',
                        '该中转站会静默忽略：' +
                          s.imageInfo.ignoredParams.map((p) => p.key).join('、') +
                          '（已在提交前剥离，不会白花这次的钱）',
                      )
                    : null,
                  s.imageInfo && s.imageInfo.qualityNote
                    ? h('div.dsis-stepdesc', s.imageInfo.qualityNote)
                    : null,
                ]),

                /* ---- 本次出图结果 ---- */
                s.gallery.length > 0
                  ? h('div.dsis-gallery', [
                      h('div.dsis-flabel', '出图记录（本次会话）'),
                      ...s.gallery.map((entry, gi) =>
                        h('div.dsis-entry', { key: 'entry' + gi }, [
                          h('div.dsis-row', [
                            ...(entry.images || []).map((im) =>
                              h(
                                'a.dsis-thumb',
                                {
                                  key: im.id,
                                  href: im.url,
                                  target: '_blank',
                                  rel: 'noreferrer',
                                  title: im.name + '  ' + im.width + 'x' + im.height +
                                    '  ' + Math.round(im.bytes / 1024) + ' KB',
                                },
                                h('img.dsis-img', { src: im.url, alt: im.name, loading: 'lazy' }),
                              ),
                            ),
                          ]),
                          h('div.dsis-stepdesc', [
                            (entry.images || []).map((im) => im.width + 'x' + im.height).join('、') +
                              '　' + Math.round((entry.ms || 0) / 1000) + ' 秒' +
                              '　' +
                              (entry.cost && typeof entry.cost.usd === 'number'
                                ? '@ ' + entry.cost.usd.toFixed(2) + ' USD/张'
                                : '花费未知') +
                              (entry.usage
                                ? '　out ' + (entry.usage.output_tokens ?? entry.usage.outputTokens) + ' tok'
                                : ''),
                          ]),
                          /* 迭代改图的最短路径：拿这张当参考图，再改一处。 */
                          h('div.dsis-row', [
                            ...(entry.images || []).map((im) =>
                              h(
                                'button.dsis-btn',
                                {
                                  key: 'ref-' + im.id,
                                  type: 'button',
                                  title: '把这张图设为参考图，下一张在它基础上改',
                                  onClick: () => s.useGalleryImageAsReference(im.url, im.name),
                                },
                                (entry.images || []).length > 1 ? '用第 ' + (entry.images.indexOf(im) + 1) + ' 张改' : '用它继续改',
                              ),
                            ),
                          ]),
                          entry.revisedPrompt
                            ? h('details.dsis-details', [
                                h('summary', '模型改写过的提示词'),
                                h('div.dsis-reason', entry.revisedPrompt),
                              ])
                            : null,
                          entry.warnings && entry.warnings.length > 0
                            ? h('div.dsis-lint.dsis-lint-warn', [
                                h('b', '本次有 ' + entry.warnings.length + ' 条提示：'),
                                h('ul', entry.warnings.map((t, i) => h('li', { key: i }, t))),
                              ])
                            : null,
                        ]),
                      ),
                    ])
                  : null,
              ]),
            ]),
          ]),

          /* ---- 右：预设与模型 ---- */
          h('div.dsis-col.dsis-col-side', [
            h('div.dsis-colhead', '预设与成本'),
            h('div.dsis-scroll', [
              h('div.dsis-field', [
                h('div.dsis-flabel', '风格预设'),
                h(
                  'div',
                  s.presets.length === 0
                    ? [h('div.dsis-placeholder', s.ready ? '宿主没有返回任何预设。' : '加载中…')]
                    : s.presets.map((p) =>
                        h(
                          'button.dsis-preset',
                          {
                            key: p.id,
                            type: 'button',
                            'data-active': p.id === s.presetId ? 'true' : 'false',
                            onClick: () => s.setPresetId(p.id),
                          },
                          [
                            h('span.dsis-preset-label', p.label),
                            p.description ? h('span.dsis-preset-desc', p.description) : null,
                            p.file
                              ? h('span.dsis-specmeta', p.file + (p.version ? '  ' + p.version : ''))
                              : null,
                          ],
                        ),
                      ),
                ),
              ]),
              h('div.dsis-field', [
                h('div.dsis-flabel', '当前模型'),
                h('div.dsis-kv', [
                  h('span', 'provider'),
                  h('b', s.model ? s.model.provider : '—'),
                ]),
                h('div.dsis-kv', [h('span', 'model'), h('b', s.model ? s.model.model : '—')]),
              ]),

              /* 累计花费：只记成功出图的张数与小计，失败与取消不计。 */
              h('div.dsis-field', [
                h('div.dsis-flabel', '累计（本次会话）'),
                h('div.dsis-wallet', [
                  h('span.dsis-wallet-num', String(s.wallet.count)),
                  h('span.dsis-wallet-label', '张'),
                  h('span.dsis-wallet-num', s.wallet.usd.toFixed(5)),
                  h('span.dsis-wallet-label', 'USD'),
                ]),
                s.imageInfo && s.imageInfo.pricing
                  ? h(
                      'div.dsis-stepdesc',
                      s.imageInfo.pricing.flatPricePerImage != null
                        ? '按包价 ' + s.imageInfo.pricing.flatPricePerImage + ' USD/张计'
                        : '按 token 计费（见 config.pricing）',
                    )
                  : null,
              ]),

              h(
                'div.dsis-placeholder',
                '待接入：跨会话画廊、图像编辑（图生图的接口已实测可用）。（阶段四）',
              ),
            ]),
          ]),
        ]),
      ])
    }

    /* ------------------------------------------------------------------ *
     * 插件正文。
     * ------------------------------------------------------------------ */

    /** 侧栏入口 id 与主区面板 key 必须是同一个值 —— 侧栏用它寻址 main 面板。 */
    const PANEL_ID = 'image-station'

    /** 词典命名空间。目前只用于侧栏入口的标签解析。 */
    const NS = 'imageStation'

    /**
     * 必需服务（**cordis 服务名，不是包名**）。
     *
     * 这一条是必须的，不是可选优化：客户端上下文对未声明的服务属性直接抛
     *   cannot get property "locale" without inject
     * 而 cordis 会一直等齐这些服务才调用 apply。缺了它，apply 一进去就抛，
     * 浏览器只报「entry did not activate」而不给原因 —— 这个坑踩过一次。
     *
     * 对照随包插件：
     *   dsh-client-ui-plugin-manager  ["slots","locale","remote",...,"layout"]
     *   dsh-client-ui-sidebar         ["slots","layout","uiWorkspace","locale","shortcuts"]
     *   dsh-client-locale             ["slots","remote","configForms"]
     */
    const injectServices = ['slots', 'locale', 'layout']

    /**
     * @param {object} ctx 客户端根上下文。
     * @returns {Promise<void>}
     */
    async function apply(ctx) {
      // ① 注册词典。整包形式按语言给字典；返回值是 disposer，交给 ctx.effect 托管，
      //    这样 HMR 或停用插件时词典会被撤回。bind 出来的翻译函数引用稳定，可跨渲染复用。
      let t = (key) => key
      try {
        t = ctx.locale.bind(NS)
        ctx.effect(() =>
          ctx.locale.register(NS, {
            zh: { panel: '绘图工作站' },
            en: { panel: 'Image Studio' },
          }),
        )
      } catch (err) {
        // 词典出问题不该拖垮整个插件：侧栏标签退化成显示 key 本身。
        console.warn('[imagestation] locale registration failed:', err && err.message)
      }

      // ② 侧栏入口。id 直接对应主区面板 key，侧栏负责画按钮与选中态。
      //    label 是**无参** thunk，每次读取重新求值 —— 所以切语言时标签自动跟随，无需重注册。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 0,
            label: () => t('panel'),
            locale: NS,
          },
          StationIcon,
        ),
      )

      // ③ 主区整页正文。这一条就是「点开就从对话切到绘图站」。
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            // 本页私有的注入面：目前只给一个「切回对话」的动作。
            inject: () => ({
              stationBack: () => ctx.layout.selectPanel(null),
            }),
          },
          StationPage,
        )
      })

      console.log('[imagestation] client half active; panel id = ' + PANEL_ID)
    }

    exports.NS = NS
    exports.PANEL_ID = PANEL_ID
    exports.inject = injectServices
    exports.apply = apply

    return module.exports
  },
})
