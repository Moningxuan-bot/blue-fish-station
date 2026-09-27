# DSH Aurora — DeepSeek Harness 外观覆盖层

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 换皮：品牌标、思考状态文案、背景图与毛玻璃。
**纯前端覆盖，不改 DSH 一行源码**；刷新浏览器即生效，不需要重启 `dsh web`。

> 现状：原型阶段。所有改动都以文件注入的方式落在 DSH 已安装的前端产物目录里，
> 因此 `@deepseek-ai/dsh-web-frontend` 升级/重装会覆盖掉，重跑一次 `install.ps1` 即可恢复。

## 效果

| 位置 | 改动 |
|---|---|
| 侧边栏 / 折叠态 / 空白会话 Hero 的品牌标 | 换成自定义图片 |
| 浏览器标签图标 | 换成自定义图片 |
| 品牌字标（logo 右侧） | 换成「蓝色大肥鱼」+「工作站」双色文字 |
| 思考状态行 | `Deep diving...` → 「大肥鱼正在吃你的 TOKEN」，前面带图片图标 |
| 整站背景 | 换成自定义背景图（+ 柔光罩），替掉刺眼的纯白 |
| 侧边栏 | 毛玻璃（半透明 + 背景虚化） |

## 安装

前置：Windows + PowerShell 7（`pwsh`）、DSH 已装好并且 `web` profile 已初始化过。

```powershell
pwsh -File .\install.ps1
```

它会做三件事：
1. 备份 `dist/index.html` 为 `index.html.aurora-bak`（只备份一次）；
2. 往 `index.html` 注入 `<link .../aurora.css>`、`<script .../aurora.js>`，并把 favicon 指向新图标；
3. 调用 `sync.ps1` 把 `aurora.css` / `aurora.js` / 图片同步进 dist。

然后回浏览器 **F5**。

### 只改样式时

改完 `aurora.css` 跑一次：

```powershell
pwsh -File .\sync.ps1
```

`sync.ps1` 会：把 `*.png`/`*.jpg` 包进内嵌 base64 的 SVG（DSH 静态服务器的 MIME 表只认
`.html/.js/.css/.svg/.json/.map/.webmanifest`，raster 图会被发成 `application/octet-stream`）、
复制全部资产到 dist、并给 `index.html` 里的引用打上 `?v=` 版本号防缓存。

## 卸载 / 回滚

```powershell
$d = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai\dsh-web-frontend\dist'
Copy-Item "$d\index.html.aurora-bak" "$d\index.html" -Force
Remove-Item "$d\aurora.css","$d\aurora.js","$d\aurora-logo.svg","$d\aurora-fish.svg","$d\aurora-fish-flat.svg","$d\aurora-bg.svg" -Force -ErrorAction SilentlyContinue
```

## 换素材

| 文件 | 用途 | 说明 |
|---|---|---|
| `logo.jpg` | 品牌标（侧边栏/折叠态/Hero）+ favicon | 方形效果最好 |
| `fish.png` | 思考状态行前的图标（已抠白底） | 由 `fish-src.png` 处理而来 |
| `fish-flat.png` | 同上但保留白底 | 备选，切 `aurora.css` 里的 url 即可 |
| `bg.jpg` | 整站背景图 | `cover` 裁切，注意左右会被裁 |

换完跑 `sync.ps1` 即可（脚本按时间戳决定是否重新生成 SVG 包装）。

## 工作原理

### 为什么是文件注入

DSH 的前端由 `dsh-host-frontend-static` 提供，它**每个请求都重新读取 `dist/index.html`** 并跑一遍
index taps。所以直接改这个文件、再 F5，就能生效 —— 不需要重启正在托管会话的 `dsh web`。

### 为什么不用插件

DSH 的插件分两种：宿主行（Host row）和客户端包（`dsh.client`）。前者只能改服务端行为，
改不了浏览器里的 DOM/CSS；后者的构建预设 `packages/client/tsdown.client.ts` **没有随 npm 发布**，
要出可用的客户端 bundle 基本得进仓库。所以外观覆盖走注入是最现实的路。
正式的宿主插件（提供 `/aurora/*` 路由 + `tapIndex`）是这套原型的下一个形态。

## 实测的钩子（这是本仓库最值钱的部分）

DSH 的 CSS Module 类名格式是 `<hash>_<localName>`：**hash 会随构建变，`_localName` 后缀稳定**。
所以 `[class*="_turnStatus"]` 这类选择器跨版本可用。

| 目标 | 稳定钩子 | 出处 |
|---|---|---|
| 侧边栏品牌标（展开） | `[class*="_brandMark"]` | ui-sidebar `renderSlot('sidebar.brand.mark')` |
| 同上（折叠窄条） | `[class*="_railMark"]` | 同上 |
| 品牌字标 | `[class*="_brandName"]` | `renderSlot('sidebar.brand.name')` |
| 空白会话 Hero 品牌标 | `[class*="_fishHitbox"]` | ui-conversation `renderSlot('conversation.hero.brand.mark')` |
| Hero 标题网格 | `[class*="_headline"]`（`grid-template-columns:34px auto auto`） | 放大图标时必须一起改第一列 |
| 思考状态行 | `[class*="_turnStatus"]`，且带 `role="status" aria-live="polite"` | ui-conversation `ChatView.TurnStatus`，文案硬编码 `Deep diving...` |
| 推理块标题 | `[data-variant="think"][data-state="running"] [class*="_title"]` | ui-conversation `ReasoningRow`，文案硬编码 `Think` |
| 轨迹面板思考按钮 | `[class*="_thinkingToggle"]` | ui-trajectory，文案硬编码 `Thinking` |
| 三栏布局列 | `[class*="_sidebarCol"] / _centerCol / _detailsCol` | ui-layout `AppFrame` |

### 表面色令牌（浅色主题下的真实值）

```
--dsw-alias-bg-base          = --dsw-static-neutral-bluish-00   (纯白)
--dsw-alias-bg-layer-1/2/3   = --dsw-static-neutral-bluish-00   (纯白)
--dsw-specific-sidebar-fill  = --dsw-static-neutral-bluish-50   (#f9fafb)
--dsw-static-deepseek-500    = #4176e6                          (DeepSeek 主色)
--dsw-alias-label-primary    = #0f1115 (浅色) / #f9fafb (深色)
```

**关键认识**：`--dsw-alias-bg-base` 不只用于对话卡片 —— `AppFrame` 自己就 `background: var(--dsw-alias-bg-base)`，
它是【全局调暗器】；`ConversationRoot` 又用同一个令牌叠第二层。`--dsw-specific-sidebar-fill` 更是
被用了两次（`.sidebarCol` + 侧边栏根）。**算透明度时必须按真实层数叠乘**，否则背景图会被叠没。

## 三个 CSS 陷阱（都踩过，别再踩）

1. **不要用通配后代选择器挂 `backdrop-filter`**：`[class*="_frame"] > *` 会命中铺满全屏的层，
   整个界面被虚化。
2. **`backdrop-filter` 会创建 fixed 的包含块**：加在 `_sidebarCol` 上，挂在侧边栏子树里的
   全屏设置面板（`.overlay{position:fixed;inset:0;z-index:1000}`）会被挤进 264px 宽的侧边栏。
3. **`isolation: isolate` 会创建层叠上下文**：面板尺寸正常了，但被关在侧边栏的层叠上下文里 →
   被后面的对话列盖住、点不到。

结论：`isolation / filter / transform / backdrop-filter / will-change / contain` 这些属性，
**都不能加在「别人的全屏 fixed 层挂在我 DOM 子树里」的容器上**。侧边栏就是这种容器。
当前实现只在 `_sidebarCol` 上留了 `position: relative`（安全），模糊挂在 `::before`（伪元素没有后代）。

## 调参

全在 `aurora.css` 第 4 节：

| 想要的效果 | 改什么 |
|---|---|
| 背景图更清晰 | 最上层的白纱 `rgba(255,255,255,.10)` 调小；`--dsw-alias-bg-base` 调小 |
| 文字发花 | 白纱调大（最安全的全局提亮），或反着调各层 alpha |
| 侧边栏玻璃更明显 | `--dsw-specific-sidebar-fill` 调小，`blur(14px)` 调大 |
| 侧边栏不想要虚化 | 删掉 `[class*="_sidebarCol"]::before` 整段，只保留半透明 |
| 字号 / 图标大小 | 第 1、2 节里的 `width/height/font-size` |

## 已知限制

- `@deepseek-ai/dsh-web-frontend` 升级会覆盖，需重跑 `install.ps1`。
- 只支持浅色主题（所有覆盖都在 `body:not([data-ds-dark-theme])` 作用域内，深色主题保持原样）。
- 文案是硬编码英文，所以用文本节点替换实现；若 DSH 改了文案，需要同时改 `aurora.js` 里的 `FROM`。
