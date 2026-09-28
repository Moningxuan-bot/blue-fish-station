<p align="center">
  <img src="docs/station-intro.png" alt="蓝色大肥鱼工作站 —— DSH 桌面应用，已集成 GPT 绘图工作站">
</p>

<h1 align="center">蓝色大肥鱼工作站</h1>

<p align="center"><b>DSH 单独应用</b> · <b>界面美化</b> · <b>集成 GPT 绘图工作站</b></p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6">
  <img alt="dsh" src="https://img.shields.io/badge/DSH-0.1.7--rc.2-4176e6">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 变成**双击就能用的桌面程序**，
顺手把界面换成自己的样子，再塞进一个能直接出图的绘图工作站。
**不改 DSH 一行源码**：桌面部分是一个 WebView2 外壳，界面部分是一个宿主插件。

| 组成 | 是什么 | 目录 |
|---|---|---|
| **桌面应用** | `BlueFishStation.exe`：自己拉起 DSH 服务、开一个没有浏览器界面的窗口 | [`desktop/`](desktop) |
| **界面美化** | 宿主插件：品牌标 / 思考文案 / 背景毛玻璃 / 推理强度滑块 | [`dsh-plugin-aurora/`](dsh-plugin-aurora) · [`aurora.css`](aurora.css) · [`aurora.js`](aurora.js) |
| **绘图工作站** | 独立插件：中文描述 → 扩写提示词 → 出图，带规范自检与计费 | [`dsh-plugin-imagestation/`](dsh-plugin-imagestation) |

## 目录

[快速开始](#快速开始) · [功能一览](#功能一览) · [仓库结构](#仓库结构) · [它是怎么工作的](#它是怎么工作的) ·
[换素材调参](#换素材--调参) · [排错](#排错) · [卸载与回滚](#卸载与回滚) · [升级 DSH 之后](#升级-dsh-之后) ·
[踩坑记录](#踩坑记录) · [已知限制](#已知限制)

## 快速开始

前置：Windows 10/11 + 系统自带的 **Windows PowerShell 5.1**（不需要 PowerShell 7）、装好的 DSH（`web` profile 初始化过一次即可）。

### ① 桌面应用（日常用这个）

```powershell
powershell -File .\desktop\install-desktop.ps1
```

编译 `desktop\BlueFishStation.cs` → 部署到 `%LOCALAPPDATA%\BlueFishStation\` → 在桌面创建「蓝色大肥鱼工作站」快捷方式。
**双击即用**。改了代码之后，双击 [`desktop\redeploy.cmd`](desktop/redeploy.cmd) 重新部署。

### ② 界面美化插件（随 DSH 升级存活）

```powershell
powershell -File .\install-plugin.ps1
```

装完**重启一次 `dsh web`**（bundle 列表是启动时读的）。之后改 `aurora.css` / `aurora.js` 只要 **F5** ——
插件每次请求都从工作区读盘，不用同步、不用重启。

### ③ 绘图工作站

```powershell
powershell -File .\install-imagestation.ps1
```

重启后侧栏出现「绘图工作站」入口。提示规范写在 [`dsh-plugin-imagestation/specs/*.md`](dsh-plugin-imagestation/specs)，
**改规范＝改文件 + F5**，不用改代码。详细用法见[它自己的 README](dsh-plugin-imagestation/README.md)。

### ④ 备用：文件注入（会被升级覆盖）

```powershell
powershell -File .\install.ps1     # 备份 index.html + 注入 <link>/<script> + 同步资源到 dist
powershell -File .\sync.ps1        # 只改了 CSS/JS 时
```

`sync.ps1` 会把 `*.png`/`*.jpg` 包进内嵌 base64 的 SVG（DSH 静态服务的 MIME 表只认
`.html/.js/.css/.svg/.json/.map/.webmanifest`，raster 图会被发成 `application/octet-stream`），
再复制进 dist 并给引用打 `?v=` 防缓存。**每次升级 `dsh-web-frontend` 后都要重跑** —— 所以它只是备用路径。

## 功能一览

### 桌面应用

| | 说明 |
|---|---|
| 一键启动 | 双击快捷方式：拉起 `dsh web --port 0 --no-open` → 解析带 token 的地址 → 载入窗口 |
| 无浏览器界面 | WinForms + WebView2，没有地址栏/标签页；标题与图标都是「蓝色大肥鱼工作站」 |
| 高 DPI | 挂 `app.manifest`（PerMonitorV2）+ `app.config`，150% 缩放下按 144 DPI 原生渲染，窗口任意缩放都锐利 |
| 干净退出 | 关窗时 `taskkill /pid <pid> /T /F` 收掉整个服务进程树 |
| 单实例 | 命名互斥体，重复双击只提示「已经在运行」 |
| 参数 | `--url=<带 token 地址>` 连已有实例；`--userdata=<目录>` 换 WebView2 数据目录；`--selftest` 无头自检 |
| 日志 | `%LOCALAPPDATA%\BlueFishStation\station.log`（含服务 stdout/stderr） |

### 界面美化

| 位置 | 改动 |
|---|---|
| 侧边栏 / 折叠态 / 空白会话 Hero 的品牌标 | 换成自定义图片 |
| 浏览器标签图标 | 换成自定义图片 |
| 品牌字标（logo 右侧） | 换成「蓝色大肥鱼」+「工作站」双色文字 |
| 思考状态行 | 「深度求索中，用时12秒」→「**大肥鱼正在吃你的 TOKEN**，用时12秒」（保留计时） |
| 整站背景 | 换成自定义背景图（+ 柔光罩），替掉刺眼的纯白 |
| 侧边栏 | 毛玻璃（半透明 + 背景虚化） |
| 模型菜单 → 思考强度 | **自绘滑块**：渐变胶囊轨道 + 星星圆点 + 百分比胶囊刻度 + 中文档位名 |
| 思考强度面板 | **档位立绘**：四个档位各一张角色图，当前档全亮、其余压暗 |
| 拖动滑块时 | **角色跑动**：12 帧跑动图骑在圆点上跟着手跑；**流光**从轨道左→右扫过 |
| 松手定档 | 跑动角色退场，档位立绘重新出现并停在当前档 |

### 绘图工作站

- 中文描述 → **扩写提示词**（实时流式）→ **出图**，每张 18–30 秒、**固定 $0.03**
- 提示规范文件化（`specs/*.md`），出厂三个预设，支持 `base` 继承与 config 内联覆盖
- **规范自检**（`lib/lint.js`）：查质量词、danbooru 计数标签、Markdown、Negative Prompt 区块等，只报告不改写
- **参考图（图生图）**：拖入或选文件；>2MB 会在浏览器里自动压到长边 1536
- **中转站脾气适配**：提交前剥离已知无效参数（`background` / `output_format`），拿到图后校验真实字节（尺寸/alpha/格式），
  请求与实得任何不一致都挂在面板上；`size`、`n`、`/v1/images/edits`、`mask` 实测有效
- 图片写到 `$DSH_HOME/image-station/images`（相对路径按 `$DSH_HOME` 解析，不按 cwd）

## 仓库结构

```
desktop/                     桌面应用（WebView2 外壳）
  BlueFishStation.cs         唯一源文件（C# 5，纯 ASCII，中文用 \u 转义）
  BlueFishStation.exe        编译产物（已提交，方便直接部署）
  app.manifest               PerMonitorV2 高 DPI 清单（编译时 /win32manifest 挂上）
  app.config                 部署为 BlueFishStation.exe.config（WinForms 的 DpiAwareness 键）
  install-desktop.ps1        编译 + 部署 + 建桌面快捷方式
  redeploy.cmd               双击重新部署
  make-icons.ps1             源图 → 6 尺寸 app-icon.ico + app-icon-256.png
  extract-webview2.ps1       从 nupkg 里取 WebView2 SDK 三个文件
  gen-social-preview.ps1     生成 1280x640 社交预览图
  Microsoft.Web.WebView2.*   运行时依赖（随 exe 部署）

dsh-plugin-aurora/           界面美化插件（宿主半侧）
  lib/index.js               8 条资源路由 + tapIndex 注入
  cordis.patch.yml           往 profile 插件树插入一行

aurora.css                   样式：1) LOGO  2) 思考行图标  3) 品牌字标  4) 背景+毛玻璃
aurora.js                    行为：思考文案替换 + 推理强度滑块
logo.jpg fish.png fish-flat.png bg.jpg moods.png run.png   源素材
tools/mkbg.cs                背景图转换：居中裁剪 + 重采样 + 锐化

dsh-plugin-imagestation/     绘图工作站（独立插件，见其自家 README）
install.ps1 / sync.ps1       备用：文件注入模式
install-plugin.ps1 / uninstall-plugin.ps1   美化插件的装/卸
docs/station-intro.png       本仓库介绍图
```

## 它是怎么工作的

### 桌面外壳：怎么拿到「不用登录」的窗口

0.1.7 起 DSH 的首页与 `/api` 都要过一道**浏览器信任闸门**：进程启动时生成 launch token，
把 `http://127.0.0.1:<port>/?token=...` 打印到终端，浏览器访问它才换到签名 cookie。所以外壳的做法是：

```
cmd /c dsh web --port 0 --no-open
  ↓ stdout: "dsh web: http://127.0.0.1:63183/?token=..."
  ↓ 正则抓出地址 → web.Source = new Uri(url)
```

`--port 0` 让 OS 挑一个空闲端口，所以它**不会和你终端里那个实例抢端口**。

### 高 DPI：「窗口一变尺寸就糊」的真凶

exe 默认**没有 DPI 感知声明**，Windows 于是按 96 DPI 渲染整个窗口、再位图拉伸到实际分辨率。
本机实测：物理 2560×1600 / 虚拟 1707×1067 = **150% 缩放**，旧 build 的进程感知级别是 `UNAWARE` → 糊。
修法是编译时挂 [`app.manifest`](desktop/app.manifest)（`dpiAware=true/pm` + `dpiAwareness=PerMonitorV2`）
并部署 [`app.config`](desktop/app.config)（`DpiAwareness=PerMonitorV2`）。修好后同一查询返回 `PER_MONITOR_AWARE`，
页面内 `window.devicePixelRatio = 1.5`，内容按原生 144 DPI 渲染。

### 覆盖层：为什么能活过 DSH 升级

DSH 的前端由 `dsh-host-frontend-static` 提供，它**每个请求都重新读取 `dist/index.html`** 并跑一遍 index taps。
宿主插件正好有这两个钩子：

| 钩子 | 作用 |
|---|---|
| `webServer.register({ kind:"exact", path:"/aurora.css", ... })` | 8 条精确路由，每次请求读工作区文件 + `no-store` |
| `webServer.tapIndex(html => ...)` | 每个 index 响应注入 `<link>`/`<script>`（版本号取资源 mtime） |

于是「改文件 → F5」就是最新，而 `dsh-web-frontend` 升级覆盖 dist 也伤不到它。

安装不用 pnpm：在 `$DSH_HOME/profiles/node_modules/` 建一个**目录 junction** 指向本仓库的插件目录，
再往 profile 的 `dependencies`（`link:` 形式，将来跑 pnpm 也不会被清掉）和 `dsh.profile.bundles` 各写一条。
装之前可以先干跑一次预检：`dsh --profile web --dump-config`，能看到 `- id: aurora-overlay` 就说明 bundle 解析与 patch 合成都没问题。

### 思考状态文案：三层兜底 + 语义匹配

新版的文案不再硬编码，而是本地化 key：`chat.deepDiving` =「深度求索中」/`Deep diving...`，
`message.turnProcess.deepDivingFor` =「深度求索中，用时{duration}」。而且它挂在一个**回合结束后仍然存在**的
`<button data-turn-process>` 里（跑完文案变「已完成工作」），所以替换必须带语义判断：

1. **容器钩子按优先级试**：`[data-turn-process]` → `[data-chat-running]` → `[class*="_turnStatus"]` → `[class*="_runningText"]` → `[class*="_running"]`
   （首次插入时 MutationObserver 给的往往是更外层节点，所以祖先找不到时会再往**子树内部**找一遍）
2. **只换容器内第一个「像运行文案」的文本节点**，并保留「，用时12秒」尾巴，计时器继续走
3. **全局兜底**：整篇文档里像运行文案的文本也换，但绝不碰 `PROTECTED`（我们自己的浮层、菜单、按钮、表单、`role=status` 无障碍节点）

三层都没命中时 `selfCheck` 会在控制台 warn 一次 —— 升级后一眼就能定位。

### 推理强度滑块：内部 RPC 的真实契约

DSH 浏览器端用的是自研 RPC。**0.1.7-rc.2 换了命名与信封**（以下都是打真服务端验证过的）：

```http
POST /api/<namespace>/<method>        content-type: application/json
body   { type:'client-request', rpcId:<uuid>, method:'<namespace>/<method>',
         payload: { args: <按接口描述符 wire 名的对象> } }
resp   { type:'server-response', rpcId, result: { ok:true, value } | { ok:false, error } }
```

| 调用 | 端点（**斜杠**） | payload |
|---|---|---|
| 读档位 | `session/modelCatalog`（**无参数**） | `{ args: {} }` |
| 写档位 | `session/selectModel` | `{ args: { request: { sessionId, provider, model, reasoningEffort } } }` |
| 会话列表 | `session/list` | `{ args: { _request: {} } }` |

目录返回的结构（旧版字段叫 `current`，新版叫 `default`，两个都读）：

```jsonc
{ "default": { "provider": "...", "model": "deepseek-flash", "reasoningEffort": "high" },
  "groups": [ { "id": "deepseek-official", "models": [ { "id": "deepseek-flash",
      "reasoning": { "defaultEffort": "high", "efforts": [ {"id":"off","name":"Off"} /* low/high/max */ ] } } ] } ] }
```

`aurora.js` 不硬编码这些名字：它 hook `window.fetch`，**从 App 自己的请求里学**端点名与信封样式，
候选列表只用于「App 还没发过这个请求」时兜底。顺带也这样学到 `sessionId`（它藏在 `payload.args.request.sessionId` 里）。

### 滑块是怎么长进菜单里的

| 环节 | 做法 |
|---|---|
| 找到原生档位行 | `[role="menuitemradio"]` **四重校验**：无 `title`、文字以档位名开头、数量与档位数 1:1、有实际矩形 |
| 藏掉原生行 | `opacity: 0`（**不是** `visibility: hidden`）+ `pointer-events: none` |
| 摆浮层 | 覆盖在原生行那块矩形上，宽度取 `max(行宽, 344)`，垂直居中 |
| 不被菜单关掉 | mousedown/click 捕获阶段屏蔽 + `focusout` 屏蔽（焦点落进浮层时吞掉） |
| 拖动 | 轨道连续 `0..1000`，生效值取**最近的档位**；松手没跨档位就弹回、不提交 |
| 定位驱动 | 输入事件（rAF，抢在绘制前）+ 250ms 轮询兜底；自激熔断 >60 次/秒则停用浮层 |

尺寸都在文件顶部：`TRACK=24` `THUMB=40` `PANEL_MIN_W=344` `MOOD_H=52` `RUN_MS=1600` `RUN_FRAMES=12`。

**为什么 `opacity` 不能换成 `visibility`**：0.1.7 的菜单新增了 `onBlur` 关闭，切到档位面板时应用会 `focus()`
那一行「已选中」的档位按钮；`visibility:hidden` 的元素**不可聚焦** → 焦点落回 `body` → 菜单判定焦点跑出去 → `close()`，
表现就是「滑块刚出现就被关掉」。`opacity:0` 的元素依然可聚焦，所以两件事都能满足。

### 主题令牌与毛玻璃

```
--dsw-alias-bg-base          = --dsw-static-neutral-bluish-00   (纯白)
--dsw-specific-sidebar-fill  = --dsw-static-neutral-bluish-50   (#f9fafb)
--dsw-static-deepseek-500    = #4176e6                          (主色)
--dsw-alias-label-primary    = #0f1115 (浅色) / #f9fafb (深色)
```

关键认识：`--dsw-alias-bg-base` 不只用在对话卡片 —— `AppFrame` 自己就 `background: var(...)`，是**全局调暗器**；
`ConversationRoot` 又叠了一层。算透明度时必须**按真实层数叠乘**，否则背景图会被叠没。
这些 alias 令牌是**行内样式写在 body 上**的，所以覆盖要 `!important` 且作用域落在 `body`。

### 绘图工作站（两半结构）

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半侧接线：配置、令牌、Index 注入 |
| `lib/presets.js` | 预设加载：读 `specs/*.md`，支持 `base` 继承与 config 覆盖 |
| `lib/expand.js` | 扩写核心，只依赖 `ctx.llm`，可脱离服务器单独测 |
| `lib/lint.js` | 规范自检：把「模型该守规矩」变成代码能判定的事 |
| `lib/generate.js` | 出图核心：调中转站、剥离无效参数、校验返回字节、算账 |
| `lib/routes.js` | 传输层：HTTP + NDJSON 流 + 令牌鉴权 + 图片读取 |
| `lib/client.js` | 浏览器半侧（手写 bundle，无构建步骤） |
| `specs/*.md` | 提示规范（知识）。改这里就是改行为 |

## 换素材 / 调参

| 文件 | 用途 | 说明 |
|---|---|---|
| `logo.jpg` | 品牌标（侧边栏/折叠态/Hero）+ favicon | 方形效果最好，960×960 |
| `fish.png` | 思考状态行前的图标（已抠白底） | 127×126 |
| `fish-flat.png` | 同上但保留白底 | 备选 |
| `bg.jpg` | 整站背景图 | **当前 2560×1600**（= 本机 150% 缩放下的物理分辨率，1:1 不放大）。换图用 `tools\mkbg.cs`：`mkbg.exe <输入图> bg.jpg 2560 1600 0.55` |
| `moods.png` | 四档角色立绘 | 4 格雪碧图，160×128/格 |
| `run.png` | 拖动时的跑动循环 | 12 格雪碧图，96×77/格 |

换完**直接 F5**（插件模式）；只有文件注入模式才需要跑一次 `sync.ps1`。

样式调参全在 [`aurora.css`](aurora.css) 第 4 节：

| 想要的效果 | 改什么 |
|---|---|
| 背景图更清晰 | 最上层白纱 `rgba(255,255,255,.10)` 调小；`--dsw-alias-bg-base` 调小 |
| 文字发花 | 白纱调大（最安全的全局提亮），或反着调各层 alpha |
| 侧边栏玻璃更明显 | `--dsw-specific-sidebar-fill` 调小，`blur(14px)` 调大 |
| 侧边栏不想要虚化 | 删掉 `[class*="_sidebarCol"]::before` 整段 |
| 滑块尺寸/跑动速度 | `aurora.js` 顶部的 `TRACK`/`THUMB`/`MOOD_H`/`RUN_MS` |

## 排错

| 现象 | 看哪里 |
|---|---|
| 桌面应用起不来 | `%LOCALAPPDATA%\BlueFishStation\station.log`（含服务 stdout/stderr） |
| 想不动窗口验证一遍 | `& "$env:LOCALAPPDATA\BlueFishStation\BlueFishStation.exe" --selftest` → 退出码 0 = WebView2 起来了且覆盖层生效 |
| 美化不生效 | 浏览器控制台 `[aurora] armed: ...`（脚本起来了）/ 终端里 `[aurora] overlay plugin active`（插件生效） |
| 思考文案没被替换 | 控制台 `[aurora] 运行状态容器钩子全都没匹配上…` → 上游改结构了 |
| 滑块不出来 | 控制台 `[aurora] radios=… matched=… efforts=…` 这行会说明是「菜单没了」「匹配失败」还是「目录读取失败」 |
| 改完 CSS/JS 没变化 | 确认走的是插件模式（终端应有 `[aurora] overlay plugin active`），然后 F5 |

## 卸载与回滚

```powershell
# 美化插件
powershell -File .\uninstall-plugin.ps1      # 移除 junction + 清掉 bundles/dependencies，然后重启 dsh web

# 桌面应用：删掉桌面快捷方式 + %LOCALAPPDATA%\BlueFishStation\ 即可（不在系统里注册任何东西）

# 文件注入模式
$d = Join-Path $env:DSH_HOME 'profiles\node_modules\@deepseek-ai\dsh-web-frontend\dist'
Copy-Item "$d\index.html.aurora-bak" "$d\index.html" -Force
Remove-Item "$d\aurora.css","$d\aurora.js","$d\aurora-logo.svg","$d\aurora-fish.svg","$d\aurora-bg.svg","$d\aurora-moods.svg","$d\aurora-run.svg" -Force -ErrorAction SilentlyContinue
```

## 升级 DSH 之后

1. **插件模式**：什么都不用做，最多 F5；
2. **桌面应用**：不用动（每次启动都会重新解析地址与 token）；
3. **文件注入模式**：重跑 `install.ps1`。

### 上游变化对照表（0.1.7-rc.2 实测）

| 我们依赖的东西 | 新版状态 |
|---|---|
| 思考状态行 `[class*="_turnStatus"]` | ❌ rc.2 产物里**没有** `data-chat-running`（那是 master 源码里的，比 rc.2 新）；✅ 真实结构是 `<button data-turn-process>` + 内部 `<span class="_label">`，已作为首选钩子 |
| 文案 `Deep diving...` | ❌ 变成本地化 key（`chat.deepDiving` / `message.turnProcess.deepDivingFor`）；✅ 已改成语义匹配 + 保留计时尾巴 |
| 模型菜单 `role="menuitemradio"` + `effortChoices` | ✅ 原样（但菜单新增了 `onBlur` 关闭，见上文） |
| RPC 读档位 `session.models` | ❌ 改名 `session/modelCatalog`（斜杠、无参数），`current` → `default` |
| RPC 信封 | ❌ 多了一层 `payload.args`（按描述符 wire 名嵌套） |
| 品牌标 `_brandMark` / Hero `_fishHitbox` / 轨迹 `_thinkingToggle` | ✅ 都还在 |
| frontend-static MIME 表 | ✅ 一模一样（图片仍需包进 SVG） |

## 踩坑记录

1. **MutationObserver 自激 = 页面卡死**。回调里写自己观察范围内的 DOM，微任务里再生产微任务，浏览器永远轮不到绘制。
   修法不是打补丁而是换驱动：定位改由输入事件 + 定时器驱动，Observer 只做文案替换。
2. **菜单的 `onBlur` 会吃掉滑块**：焦点离开菜单就 `close()`。用 `focusout` 捕获屏蔽 + 让浮层自己接住焦点解决。
3. **`opacity` vs `visibility`**：前者可聚焦、后者不可。在这套菜单里这一条决定了「滑块能不能活过一帧」。
4. **`backdrop-filter` 会给 `position: fixed` 当包含块**，`isolation: isolate` 会创建层叠上下文 ——
   都不能加在「别人的全屏 fixed 层挂在我 DOM 子树里」的容器上（侧边栏就是这种容器）。
5. **DPI 不感知 = 整窗位图拉伸**：`csc` 默认清单里没有 DPI 声明，150% 缩放下全窗口发糊。
6. **.NET 的 `Icon` 类读不了 PNG 压缩条目的 ICO**（`ToBitmap()` 抛异常），而 Explorer 能读；
   所以窗口图标是运行时 `GetHicon()` 从 PNG 加载的。
7. **`.ps1` 不要写非 ASCII**：Windows PowerShell 5.1 按 ANSI 读脚本，中文字节可能吞掉引号导致语法错误。
   所有脚本保持纯 ASCII，中文名用码点拼（如桌面快捷方式名）。
8. **GitHub 仓库名只允许 ASCII**，而且 API 对非法字符是「静默裁剪」不报错 —— 别拿线上仓库做实验。
9. **`git add -A` 会扫到并行会话的在制品**。本仓库曾因此误提交（已撤回并 force-push）。**只用显式路径 add**。
10. **绘图站：相对 `outputDir` 按 `$DSH_HOME` 解析，不按 cwd** —— 按 cwd 时图被写进了 DSH 安装目录（找不到、还可能被升级删掉）。

## 已知限制

- 只支持**浅色主题**（所有覆盖都在 `body:not([data-ds-dark-theme])` 作用域内，深色主题保持原样）。
- 美化插件与 DSH 的具体版本强相关（钩子是 `data-*` 属性 + `<hash>_<localName>` 后缀），跨大版本升级后建议核对控制台告警。
- `/api/<namespace>/<method>` 是 DSH 内部协议，没有稳定性承诺；端点或信封再变时，滑块需要同步调整。
- 滑块会实时改写**当前会话**的推理强度（与界面里选 effort 是同一个操作）。
- 绘图站：切回对话后**看不到实时进度**（出图不会中断，跑完自动出现在记录里）；蒙版涂刷界面尚未实现。
- 桌面应用只在 Windows 上验证过（WebView2 运行时随 Edge 安装，Win10/11 一般都在）。

## License

MIT —— 见 [LICENSE](LICENSE)。代码可自由使用。

素材（`logo.jpg` / `fish.png` / `fish-flat.png` / `bg.jpg` / `moods.png` / `run.png` /
`desktop/app-icon*.png` / `docs/station-intro.png`）是仓库作者的个人素材
（角色立绘与跑动图取自作者自己的设计稿），**替换成你自己的即可**。
