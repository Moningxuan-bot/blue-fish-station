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
| 模型菜单 → 思考强度 | **自绘滑块**：渐变胶囊轨道 + 星星圆点 + 百分比胶囊刻度 + 中文档位名 |
| 思考强度面板 | **档位立绘**：四个档位各一张角色图，当前档全亮、其余压暗 |
| 拖动滑块时 | **角色跑动**：12 帧跑动图骑在圆点上跟着手跑；**流光**从轨道左→右扫过 |
| 松手定档 | 跑动角色退场，档位立绘重新出现并停在当前档 |
| **桌面应用** | 「蓝色大肥鱼工作站」：双击即启动（见下节） |

## 桌面应用：蓝色大肥鱼工作站

`desktop\` 下是一个真正的 Windows 桌面外壳（WinForms + WebView2，C# 编译成单个 EXE）：
双击桌面快捷方式 → 它自己拉起一个 DSH 服务 → 打开一个**没有浏览器界面**的应用窗口（自定义图标与标题）。

```powershell
powershell -File .\desktop\install-desktop.ps1   # 编译 + 部署 + 建桌面快捷方式
```

它会：

1. 用 .NET Framework 自带的 `csc` 编译 `BlueFishStation.cs`（源码纯 ASCII，中文用 `\u` 转义，避免编码坑）；
2. 把 `BlueFishStation.exe` + WebView2 三个依赖 + 图标复制到 `%LOCALAPPDATA%\BlueFishStation\`；
3. 在桌面创建「蓝色大肥鱼工作站.lnk」（名字由码点拼出，脚本本身仍是纯 ASCII）。

运行行为：

| 行为 | 说明 |
|---|---|
| 启动服务 | `cmd /c dsh web --port 0 --no-open` → **随机端口**，不会和终端里那个实例抢端口 |
| 取认证 URL | 读子进程 stdout，按 `http://127.0.0.1:\d+/\?token=...` 抓出带 token 的地址（0.1.7 起 `/api` 与首页都要过浏览器信任闸门） |
| 窗口 | WebView2 全屏填充，`form.Text` = 蓝色大肥鱼工作站，窗口/任务栏图标来自 `app-icon-256.png` |
| 退出 | 关窗时 `taskkill /pid <pid> /T /F` 把整个服务进程树收掉 |
| 单实例 | 命名互斥体，重复启动只会提示「已经在运行」 |
| 日志 | `%LOCALAPPDATA%\BlueFishStation\station.log`（含服务 stdout，排错用） |

无头自测（不开窗口，跑完自己退出，退出码 0 表示 OK）：

```powershell
& "$env:LOCALAPPDATA\BlueFishStation\BlueFishStation.exe" --selftest
```
它会在 WebView2 里执行一段 JS，确认覆盖层真的生效：`a=true;mark=on;efforts=4;ids=off/low/high/max`。

关于图标：源图（`Pictures\93a81a91a9f8bf70556128e5180c1918400820618.png`，1378×1382，**本身就是透明底**）
由 `desktop\make-icons.ps1` 生成 6 个尺寸（256/128/64/48/32/16）的 `app-icon.ico` 与 `app-icon-256.png`。
ICA 用的是 PNG 压缩条目（Explorer 支持），但 **.NET 的 `Icon` 类读不了这种条目**（`ToBitmap()` 会抛异常），
所以窗口图标是运行时从 `app-icon-256.png` 用 `GetHicon()` 加载的 —— 这一点踩过，写在代码注释里了。

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

## 两种部署形态（推荐插件模式）

| | 文件注入（`install.ps1`） | **插件模式（推荐）** |
|---|---|---|
| 原理 | 往 `dist/index.html` 注入标签 + 把资源拷进 dist | `tapIndex` 每个 index 响应注入 + 自建路由提供资源 |
| 升级 `dsh-web-frontend` 后 | ❌ 注入和资源被覆盖，要重跑 `install.ps1` | ✅ 启动时自动完成，不受影响 |
| 改完 CSS/JS | 跑 `sync.ps1` | 直接 F5（插件每次请求都读盘） |
| 资源位置 | dist 目录 | `assetDir` 指向的工作区目录 |

```powershell
pwsh -File .\install-plugin.ps1     # 安装（不需要 pnpm）
pwsh -File .\uninstall-plugin.ps1   # 卸载
```

安装会做三件事：在 `$DSH_HOME/profiles/node_modules/` 下建一个**目录 junction** 指向本仓库的
`dsh-plugin-aurora/`（这样不用 pnpm 就能被解析）、把它写进 profile 的 `dependencies`（`link:` 形式，
将来跑 pnpm 也不会被清掉）、并加进 `dsh.profile.bundles`。**装完必须重启一次 `dsh web`** —— bundle 列表是启动时读的。

两种形态**可以共存**：插件注入前会先检查标签是否已存在，存在就只改 `?v=`，所以不会重复加载。
也就是说装了插件之后，即使 dist 被升级覆盖，插件也会把标签补回去。

> 装插件前建议先预检（不启动服务，只合成配置树）：`dsh --profile web --dump-config`，
> 能在里面看到 `- id: aurora-overlay` 就说明 bundle 解析和 patch 合成都没问题。
> 万一重启后起不来，跑 `uninstall-plugin.ps1` 即可回退（profile manifest 也在安装时备份为 `.aurora-back`）。

## 卸载 / 回滚

```powershell
$d = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai\dsh-web-frontend\dist'
Copy-Item "$d\index.html.aurora-bak" "$d\index.html" -Force
Remove-Item "$d\aurora.css","$d\aurora.js","$d\aurora-logo.svg","$d\aurora-fish.svg","$d\aurora-fish-flat.svg","$d\aurora-bg.svg","$d\aurora-moods.svg","$d\aurora-run.svg" -Force -ErrorAction SilentlyContinue
```

## 换素材

| 文件 | 用途 | 说明 |
|---|---|---|
| `logo.jpg` | 品牌标（侧边栏/折叠态/Hero）+ favicon | 方形效果最好 |
| `fish.png` | 思考状态行前的图标（已抠白底） | 由 `fish-src.png` 处理而来 |
| `fish-flat.png` | 同上但保留白底 | 备选，切 `aurora.css` 里的 url 即可 |
| `bg.jpg` | 整站背景图 | `cover` 裁切，注意左右会被裁 |
| `moods.png` | 四个档位的角色立绘（4 格等宽雪碧图，160×128/格） | 取自设计稿 1/3/4/5 号角色，已抠白底 |
| `run.png` | 拖动时的跑动循环（12 格等宽雪碧图，96×77/格） | 取自跑动设计稿的 12 帧 |

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

## 推理强度滑块（内部 RPC）

DSH 浏览器端用的是自研 RPC，协议实测如下（`dsh-client-connection` 的 `postJson` + `callUnary`）：

```http
POST /api/<method>        content-type: application/json
body   { type: 'client-request', rpcId: <uuid>, method: '<method>', payload: { ... } }
resp   { type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }
```

滑块用到两个方法：

| 方法 | payload | 返回 |
|---|---|---|
| `session.models` | `{ sessionId }` | `{ current: {provider, model, reasoningEffort?}, groups: [{id, models:[{id, name, reasoning:{defaultEffort, efforts:[{id,name}]}}]}], ... }` |
| `session.selectModel` | `{ sessionId, provider, model, reasoningEffort? }` | `{ selected }` |

实测本机 `deepseek-v4-flash` 的档位：`off`(Off) / `low`(Low) / `high`(High) / `max`(Max)，默认 `high`。

**`sessionId` 怎么来**：它没有现成的全局来源，所以 `aurora.js` 会 hook `window.fetch`，
从 App 自己发出的 `/api/session.*` 请求体里学 —— 顺带把每个方法的真实请求体形状也记下来复用。
注入脚本在 `<body>` 末尾、App 的 module 脚本之前执行，所以这个 hook 一定装得上。

## 滑块的视觉与交互实现

### 自绘轨道 / 圆点

`input[type=range]` 的轨道和圆点只能靠伪元素画，所以 `aurora.js` 会往 `<head>` 插一段 `<style>`
（选择器限定在 `#aurora-effort` 内，不影响页面其它地方）。尺寸都在文件顶部：

```js
const TRACK = 24        // 轨道高度
const THUMB = 40        // 圆点直径
const PANEL_MIN_W = 344 // 面板最小宽度（4 个中文档位名要一行放得下）
const MOOD_H = 52       // 档位立绘显示高度
const RUN_MS = 1600     // 跑动一轮时长（12 帧 / 1.6s ≈ 133ms 一帧）
```

### 平滑拖动 + 挡位吸附

轨道是**连续**的（`0..1000`），所以拇指跟着鼠标连续走、不会被机械吸到挡位上；生效值取**离拇指最近的挡位**。
松手时：没跨过挡位中点 → 拇指弹回原挡位、不提交；跨过了 → 提交并把拇指吸附到该刻度。

拖动中 `render()` **绝不回写** `range.value`（靠 `dragging` 标志），否则 250ms 一次的定位轮询会把拇指拽回刻度、手感立刻断掉。

### 雪碧图与逐帧动画

- 档位立绘：`background-size: n×100% 100%` + `background-position: pct% 50%`，`pct` 与刻度、胶囊用的是**同一个百分比**，三者天然对齐。
- 跑动图：12 格，用 `@keyframes` 显式列出 12 个停靠点，每帧 `animation-timing-function: steps(1,end)` 让它**停住**；
  百分比分母是 `n-1=11` 而不是 12（`background-position` 的 0% 是第一格、100% 是最后一格），写成 `steps(12)` 会整体错位。
- 抠白底：`alpha = 255 - min(R,G,B)` 再把颜色反预乘（`C' = (C - (1-a)·255)/a`），角色才能融进半透明面板而不是带一块白底。

### 跑动角色为什么贴在圆点上

原生 range 的**可用行程被圆点宽度内缩**了：拇指中心走的是 `[THUMB/2, width - THUMB/2]`，所以

```js
const usable = rr.width - THUMB
const cx = rr.left + THUMB/2 + (value / STEPS) * usable
```

少减 `THUMB/2` 这一项，角色在两端就会跑得比拇指快、对不齐。垂直方向也要对齐**圆点**（40px）而不是轨道（24px）——
圆点比轨道上下各高 8px，只按轨道算角色会压在手柄上。

## 让模型能读图（一个容易踩的配置坑）

如果 `read_image` 报 `model "xxx" does not declare image input`，**别急着下结论说模型不支持** ——
`dsh-llm-deepseek` 适配器本身支持图片，只是要目录里声明 `inputModalities`。
本机实测：`$DSH_HOME/settings.yaml` 里模型目录写的是 `[text]`，所以被直接拦掉。改成

```yaml
llm-deepseek:
  models:
    - id: deepseek-flash
      inputModalities:
        - text
        - image
```

之后报错立刻变成「尺寸超 2000px」——说明读图链路已经通了（适配器**每次操作重读一次目录**，改完下个请求就生效，不用重启）。图片长边超过 2000px 时先缩小再读。

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

## 踩过的坑（都真踩过，别再踩）

### 1) MutationObserver 自激 —— 页面直接卡死

我第一版用 `MutationObserver(childList, subtree)` 观察 `body`，回调里判断「只要菜单里有档位行就重新定位」，
而定位函数会写自己浮层的刻度（`textContent=''` + `appendChild`）。浮层就挂在 `body` 下、也在观察范围内 ——
**自己产生的 DOM 变更触发自己的回调**，而 MutationObserver 回调是微任务，微任务里再生产微任务，
浏览器永远轮不到绘制和响应事件：页面卡死，只能重启标签页。

**修法不是打补丁，是换驱动方式**：定位改由 **250ms 定时器**驱动，Observer 只做文案替换、绝不写定位相关的 DOM。
定时器不会被自己的写入触发，回路在结构上就不可能出现。另外加了两层保险：`place()` 先比签名（位置没变就不写 DOM）、
一秒内调度超 60 次就**熔断**（彻底停用浮层并恢复原生行）。

### 2) 菜单的 closeOutside 把拖动吃掉了

DSH 的模型菜单在 `document` 上挂了 `mousedown` 的「点在菜单外就关闭」。我们的浮层挂在菜单 DOM 之外，
于是**按下滑块 = 点了菜单外面 = 菜单立刻关闭**，浮层在下一个轮询里被隐藏，拖动还没结束就没了。
表现就是「只能点、不能拖」。修法：在浮层上 `stopPropagation` 掉 `mousedown/pointerdown/touchstart/click`。

### 3) `backdrop-filter` 会给 `position: fixed` 当包含块

加在侧边栏列上，结果挂在侧边栏子树里的全屏设置面板（`position:fixed;inset:0;z-index:1000`）被挤进 264px 宽的侧边栏。

### 4) `isolation: isolate` 会创建层叠上下文

改用 `isolation` 后尺寸正常了，但那个 `z-index:1000` 的 fixed 层被关在侧边栏的层叠上下文里出不来，
被后面的对话列盖住、点不到。

**3、4 的共同结论**：`isolation / filter / transform / backdrop-filter / will-change / contain` 这些属性，
都不能加在「别人的全屏 fixed 层挂在我 DOM 子树里」的容器上。侧边栏就是这种容器。
当前实现只留了 `position: relative`（既不创建层叠上下文、也不当 fixed 的包含块），模糊挂在 `::before` 上（伪元素没有后代）。

### 5) `[class*="_frame"] > *` 这种通配后代选择器

想一次覆盖三栏，结果命中了铺满全屏的层，`backdrop-filter` 一上去整个界面都被虚化。
教训：`backdrop-filter` 只加在确定是面板的元素上。

### 6) `.ps1` 里不要写非 ASCII 字符

这个 shell 会把脚本按 ANSI 读，中文字节可能吞掉一个引号导致语法错误（踩过一次）。
`sync.ps1` / `install.ps1` 保持纯 ASCII。

## CSS 陷阱（都踩过，别再踩）

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

## 升级 DSH 之后要做什么

1. 插件模式：**什么都不用做**（插件会自动注入），最多 F5 一下；
2. 文件注入模式：重跑 `install.ps1`；
3. 如果思考状态行/品牌标之类**突然不生效了**，看浏览器控制台：有 `[aurora] 运行状态容器钩子全都没匹配上…`
   这类告警就说明上游改了钩子，把日志发我即可。

### 已知的上游变化（dsh-v0.1.7-rc.2 实测）

| 我们的钩子 | 新版状态 |
|---|---|
| 思考状态行 `[class*="_turnStatus"]` | ❌ 组件搬到 `ui-chat/RunningStatus.tsx`，类名改 `_running`；✅ 新增稳定属性 **`data-chat-running`**（已作为首选钩子） |
| 文案 `Deep diving...` | ❌ 变成本地化 key（`chat.deepDiving` / `chat.deepDivingFor`，1 秒后带时长）；✅ 已改成**语义替换 + 全局兜底** |
| 品牌标 `_brandMark` / Hero `_fishHitbox` / 轨迹 `_thinkingToggle` | ✅ 都还在 |
| 模型菜单 `role="menuitemradio"` 与 `effortChoices` 结构 | ✅ 原样 |
| RPC **读档位** `session.models` | ❌ 改名 `session/modelCatalog`（**斜杠**路径、**无参数**），返回里 `current` → **`default`** |
| RPC **信封** | ❌ 多了一层：`payload: { args: <按描述符 wire 名的对象> }`（旧版是裸 payload）。例：`session/selectModel` → `args:{request:{...}}`、`session/list` → `args:{_request:{}}`、`session/modelCatalog` → `args:{}` |
| RPC `session.selectModel` | ⚠️ 方法名没变，但路径与信封变了：`POST /api/session/selectModel` + `args.request` |
| frontend-static 的 MIME 表 | ✅ 一模一样（图片仍需包进 SVG） |

## 已知限制

- `@deepseek-ai/dsh-web-frontend` 升级会覆盖，需重跑 `install.ps1`。
- 只支持浅色主题（所有覆盖都在 `body:not([data-ds-dark-theme])` 作用域内，深色主题保持原样）。
- 文案是硬编码英文，所以用文本节点替换实现；若 DSH 改了文案，需要同时改 `aurora.js` 里的 `FROM`。
- 与 DSH 的具体版本强相关（钩子是 `<hash>_<localName>` 后缀 + `data-*` 属性），跨大版本升级后建议重新核对。
- `/api/<method>` 是 DSH 内部协议，没有稳定性承诺；`session.models` / `session.selectModel` 改名或改
  payload 形状时，滑块需要同步调整（`aurora.js` 里已把失败原因显示在滑块上，不会静默失败）。
- 滑块会实时改写**当前会话**的推理强度（和界面里选模型时选 effort 是同一个操作）。

## License

MIT —— 见 [LICENSE](LICENSE)。代码可自由使用；`logo.jpg` / `fish.png` / `bg.jpg` / `moods.png` /
`run.png` 是仓库作者的个人素材（其中角色立绘与跑动图取自作者自己的设计稿），替换成你自己的即可。

