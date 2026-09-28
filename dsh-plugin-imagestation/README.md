# dsh-plugin-imagestation

DSH Web GUI 的**绘图工作站**：从对话一键切换到生图，带自己的提示词流水线、TAG 知识库与生图接口。

设计基准见 [DESIGN.md](DESIGN.md) —— 施工前先读它，里面记着每个决定的依据与踩过的坑。

## 现状

**阶段一（骨架）与阶段二 a（提示词流水线）已完成并验证。**

已经能跑的：

- 插件被 profile 加载、客户端 bundle 激活、侧栏出现「绘图工作站」入口
- 点它整页切到绘图站，点「切回对话」切回对话页
- **写中文描述 → 点「扩写提示词」 → 出图提示词实时流式出现 → 可直接改**
- 风格预设切换（出厂两个：通用 / 二次元插画，可在插件 config 里加）
- 目标模型显示（读 profile 的 `agent-default-model`），token 用量显示
- 模型的思考过程单独折叠显示，**不混进提示词**

**提示规范已文件化**（阶段二 b）：提示词知识不在代码里，而在 `specs/*.md`。
改规范＝改文件 + F5。宿主启动时会逐条打印加载了哪些规范文件。

**还有一个规范自检**：模型即便被明确禁止，偶尔仍会滑回 Tag 写法（实测过）。
`lib/lint.js` 会检查质量词、danbooru 计数标签、Markdown、Negative Prompt 区块、
是否以 `Create …` 开头等，**只报告不改写**，结果直接显示在面板上。

**已经能出图了**（阶段三 a）：写中文 → 扩写提示词 → 点「出图」→ 图出现在面板里，
带尺寸、耗时、token 用量与成本。实测每张 18–30 秒。

**这台中转站有一条必须知道的脾气**：它会"接受参数但不生效"——`background: transparent`
和 `output_format: webp` 都回 200，却静默返回不透明 PNG。所以插件会：

- **提交前剥离**已知无效参数（不让你为无效参数花这次的钱）
- **拿到图后校验真实字节**（PNG 头里的尺寸、有没有 alpha、实际格式）
- 任何"请求与实得"不一致都作为提示挂在面板上

实测支持：`size`（像素精确生效）、`n`、`/v1/images/edits`、`mask` 局部重绘。
实测忽略：`background`、`output_format`、以及 `edits` 的 `size`。

## 花费

**每张固定 $0.0300**（经中转站仪表盘核实，与提示词长短、尺寸、张数无关）。
100 张 $3，1000 张 $30。面板右栏的"累计（本次会话）"按这个单价记。

端点也返回 token 用量，但**不要用它反推账单**：本地实测约 1,090 token/张，
仪表盘显示 1,518，口径不同。所以 `config.pricing.flatPricePerImage` 是唯一权威数字；
`inputUsdPerMillion` / `outputUsdPerMillion` 只作自检——填了之后若与包价差得离谱会告警。

## 参考图（图生图）

面板中栏有「参考图（可选）」区：**拖进去、或点一下选文件**。
给了图就走图生图，不给就是文生图。画廊里每张图下面还有「用它继续改」，
从刚出的图接着迭代。

- 支持 PNG / JPEG / WebP；超过 2 MB 会**在浏览器里**自动压到长边 1536 转 JPEG
  （不压的话 base64 后可能撞上宿主 4 MB 的请求体上限）
- 给参考图时 `size` 会被**主动剥离并告知** —— 实测这台中转站图生图忽略 size，输出跟随输入图
- 提示词建议写清"改什么 + 保留什么"，例如
  "Change the mug colour to deep teal. Keep the composition, background and lighting exactly as they are."
  上游会重绘整张图，只说改什么容易把别的也改掉

## 图片存在哪

**`$DSH_HOME/image-station/images`**（默认），面板上会把这个完整路径写出来。

改成别处：在 config 里给 `outputDir`。**相对路径按 `$DSH_HOME` 解析，不按当前工作目录** ——
早先按 cwd 解析，而 dsh 是从 npm 全局目录启动的，图被写进了 DSH 安装目录里
（既找不到，也可能被升级连带删除）。这是个实测踩到的坑。

## 切面板不会丢状态

从绘图站切回对话、再切回来，**出图记录、累计花费、参数与预设选择都还在**。
出图中途切走也不会中断，跑完后会自动出现在记录里。

两个已知边界（诚实说明）：

- **切回后看不到实时进度**。出图请求的流只存在于发起它的那段代码里，面板卸载后就接不回来了，
  只能等它结束再显示结果。面板会明确显示"这次出图仍在进行（已等待 N 秒）"，
  而不是假装什么都没发生。
- 出图中点「切回对话」会**先问一句**，说明"不会中断、但你要等它跑完再切回来才看得到进度"。

还没做：蒙版局部重绘的涂刷界面（接口已实测可用）、对话文件卡回灌、跨会话画廊、
宿主侧任务登记表（做了它才能连实时进度一起恢复）。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半侧接线：配置、令牌、Index 注入 |
| `lib/presets.js` | 预设加载：读 `specs/*.md`，支持 `base` 继承与 config 覆盖 |
| `lib/expand.js` | 扩写核心，只依赖 `ctx.llm`，可脱离服务器单独测 |
| `lib/lint.js` | 规范自检：把"模型该守规矩"变成代码能判定的事 |
| `lib/generate.js` | 出图核心：调中转站、剥离无效参数、校验返回字节、算账 |
| `lib/routes.js` | 传输层：HTTP + NDJSON 流 + 令牌鉴权 + 图片读取 |
| `lib/client.js` | 浏览器半侧。**手写 bundle，无构建步骤**，只 require 平台种子表里的模块。 |
| `specs/*.md` | 提示规范（知识）。改这里就是改行为，不用改代码。 |
| `cordis.patch.yml` | bundle patch：往 profile 插件树插入一行。 |

## 配置

改 `$DSH_HOME/profiles/web/cordis.patch.yml` 里 `image-station` 那一行的 `config`：

```yaml
- insert:
    - id: image-station
      name: dsh-plugin-imagestation
      config:
        enabled: true
        defaultPresetId: general     # 出厂三个：general / anime-illustration / character-keyvisual
        streamReasoning: true        # 思考过程是否推给面板
        temperature: 0.8             # 不写则用服务商默认
        maxTokens: 1600
        extraRules:                  # 追加到规范之后，优先级更高
          - 画面里不要出现文字或水印
        presets:
          # 只改显示名，规范仍用出厂同名文件
          - id: general
            label: 我的通用
            description: 我调过的版本
          # 完全自定义：内联规范全文
          - id: my-style
            label: 我的风格
            system: |
              你的职责：把用户的一句话描述编译成……
          # 或者指向 specs 目录里的自有文件
          # - id: another
          #   specFile: my-own-spec.md

        # ---- 出图 ----
        # 本插件的出厂默认是【占位符】，开箱不可用 —— 必须在这里填上你自己的服务。
        # 这样仓库里不残留任何具体的第三方服务信息，别人克隆下来也不会误打误撞
        # 把请求发到某个真实服务上。
        baseUrl: https://api.example.com   # 你的 OpenAI 兼容出图服务地址
        apiKeyEnv: DSH_IMAGE_API_KEY       # 只从 Key 文件/环境变量读；Key 绝不写进本文件
        model: your-image-model            # 你的服务上实际的模型名
        retries: 4                         # 上游容量枯竭时的重试次数
        timeoutMs: 180000                  # 出图较慢，别调太小（实测每张 18–31 秒）
        image:                             # 面板上的默认值，用户可改
          size: 1024x1024
          quality: medium
          n: 1
        # 图片存哪。**相对路径按 $DSH_HOME 解析，不按当前工作目录**
        # （按 cwd 解析会让图落进 DSH 安装目录里，找不到还可能被升级连带删除）。
        outputDir: image-station/images
        pricing:
          flatPricePerImage: 0.03      # 你的服务怎么计费就填多少
          outputUsdPerMillion: null    # 填了才做 token 反推自检
          sanityFactor: 3              # 反推值与包价差超过这个倍数就告警
```

**改规范优先改 `specs/*.md`，不要写进 YAML** —— 规范是知识，放在文件里才能被编辑器、
diff 和版本管理正常对待。YAML 里的 `presets` 只用于"这个部署想覆盖/新增哪几个"。

**三处必须自己填**：`baseUrl`、`model`、`pricing.flatPricePerImage`。
出厂的 `https://api.example.com` 只是个明确不可用的占位符 —— 填错会在面板上报错，
而不是静默把请求发到别处。

## 密钥怎么给

**在面板里直接粘贴，不用碰环境变量。** 没找到 Key 时，出图区会出现一个输入框：

1. 把 Key 粘进去，点「保存」
2. 宿主写进 `$DSH_HOME/image-station/.env`，然后**重新解析一次确认可读**
3. **不需要重启**，下一次出图就生效

为什么不用环境变量：`BlueFishStation.exe` 拉起的 `dsh web` 是**资源管理器进程的子进程**，
而 `setx` 不会改动已在运行的程序的环境 —— 所以从桌面图标启动时，环境变量这条路必须
"重开整个工作站"才生效，极易踩空（实测踩过）。

解析顺序（谁先有值用谁）：

1. `config.apiKey` —— 不推荐，会落进 YAML
2. **Key 文件** `$DSH_HOME/image-station/.env` —— 推荐
3. 进程环境变量 `DSH_IMAGE_API_KEY` —— 仍然支持，适合脚本化启动

面板会如实列出"找过哪些地方、哪一项命中了"，不再只丢一句"没找到"。


## 安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-imagestation.ps1
```

脚本做两件事，都不需要 pnpm：

1. 在 `$DSH_HOME/profiles/node_modules/` 建一个指向本目录的 **junction**
2. 在 `$DSH_HOME/profiles/web/package.json` 里补上 `dependencies` 的 `link:` 声明与
   `dsh.profile.bundles` 条目（先备份为 `.imagestation-bak`）

**幂等**：重复运行安全。它用 `ConvertFrom-Json` + 重新序列化，不会像逐行插入那样破坏 JSON。

## 生效方式

| 改动 | 如何生效 |
|---|---|
| `lib/client.js` 或 `lib/index.js` 的内容 | 按 **F5** 刷新页面 |
| `cordis.patch.yml`（插件配置） | 按 F5；多数配置项下一次读取时生效 |
| profile 清单、启用/停用插件、**改 `package.json` 的 `dsh` 段** | **重启**（关掉 BlueFishStation 窗口再打开） |

> 客户端 bundle 的 URL 带一个由文件 mtime/大小派生的 revision，浏览器会缓存它。
> 改了代码但界面行为没变时，先按 **Ctrl+F5** 强刷，再怀疑代码 —— 这个坑排查过一次。

## 验证工具（都不碰正在使用的界面）

改完客户端代码别只靠肉眼。这套探针是**分层**的，因为浏览器那句
`web boot: 1 entry did not activate` 不会告诉你原因：

| 脚本 | 层 | 作用 |
|---|---|---|
| `probe-client.mjs` | 契约 | 假 seed 表 + 记录型 ctx，走一遍注册链路 |
| `probe-main-effect.mjs` | 契约 | 确认 `slots.inject('main', …)` 的 generator effect 真被执行 |
| `probe-createelement.mjs` | 痕迹 | 打印每次 `createElement` 的 props/children，抓"对象当子节点"这类歧义 |
| `probe-render.mjs` | 渲染 | **真 `react-dom/server`** 渲染两个组件 + 15 条断言 |
| `probe-endpoints.mjs` | 网络 | 令牌握手、bearer 拦截、预设载荷、NDJSON 流契约；**会真实调一次 LLM** |
| `probe-sample.mjs` | 人工 | 把每个预设的真实扩写结果完整打出来，用来判断提示词质量 |
| `probe-boot.mjs` | 浏览器 | 无头 Chrome + DevTools 协议，确认启动无错误并截图 |
| `probe-switch.mjs` | 浏览器 | **真的点图标**，切换整页，在浏览器里跑完一次扩写，**再真的出一次图**并确认 <img> 显示成功 |
| `probe-relay.mjs` | 中转站 | 探测模型目录与参数接受度（带容量重试，否则会把故障误报成能力） |
| `probe-relay-verify.mjs` | 中转站 | 用真图验证 size / edits / mask，比对返回字节而不是只看状态码 |
| `probe-generate.mjs` | 出图核心 | 真实调用 generate.js：参数剥离、落盘、成本、校验警告 |
| `probe-reference.mjs` | 浏览器 | **用 CDP 真的注入一个文件**，验证压缩/预览/图生图整条链，并真的出一张图 |
| `probe-persist.mjs` | 浏览器 | **真的切走再切回**，断言记录/花费/参数还在，并在出图中途切走验证不丢 |
| `probe-credentials.mjs` | 凭据 | 解析顺序、写盘幂等、脱敏、容忍各种 .env 写法 |
| `probe-keysetup.mjs` | 凭据 | 没 Key → 面板写入 → **免重启** → 立刻出图，整条链真跑 |

`probe-render.mjs` 需要本地 React（仅开发用，bundle 本身零依赖）：

```powershell
npm install --no-save react@18 react-dom@18
node probe-render.mjs
```

浏览器层探针需要另起一个实例，这样不中断你正在用的工作站：

```powershell
cd "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh"
node lib\bin.js web --port 45790 --no-open    # 记下它打印的带 token 的 URL
cd D:\WORK\Agent\dsh\dsh-plugin-imagestation
node probe-switch.mjs '<那个 URL>'
```

宿主半侧的加载则可以零副作用地验证：`node lib\bin.js web --help` 就会完整组合一次 profile。

## 三个已知的坑（都已在 DESIGN.md 记明）

1. **bundle patch 里新增行必须放进 `- insert:`**。顶层裸的 `- id: xxx` 是「按 id 覆盖已有行」，
   匹配不到时**只 warn 然后静默跳过**，插件根本不加载，且不报错。
2. **客户端插件必须 `exports.inject = ['slots','locale','layout']`**（cordis **服务名**）。
   漏了它，`ctx.locale` 直接抛 `cannot get property "locale" without inject`，
   而浏览器只报「entry did not activate」不给原因。
   注意 `package.json` 的 `dsh.client.inject` 是另一件事（模块加载依赖，填**包名**）。
3. **Windows PowerShell 5.1 的 `Remove-Item` 删目录 junction 会抛 NullReferenceException**，
   且 `Test-Path` 会把包名里的 `[` 当通配符。安装脚本已分别改用 `cmd /c rmdir` 与 `-LiteralPath`。

