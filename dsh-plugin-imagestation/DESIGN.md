# 绘图工作站（dsh-plugin-imagestation）设计基准

DSH Web GUI 的二级子工作站：从对话一键切到生图，带自己的提示词与约束、自己的 TAG 知识库、
自己的生图接口，并且能调 DSH 自己的 LLM 做提示词流水线。

本文件是施工基准。凡标注「待验证」的条目，都是实现期必须先用最小实验确认的事实，不得凭推测编码。

---

## 1. 形态

**主区整页接管**，不是右栏停靠、不是浮层。

- 侧栏新增一个入口图标；点击 = 从对话切到绘图站。
- 选择任意会话 = 切回对话（`activePanelId` 变回 null）。
- 绘图站的输入、提示词历史、画廊、参数与对话完全独立，不共享草稿。

### 为什么不是右栏

`rightbar` 是 `kind: 'single'` 且已被内置右栏（`dsh-client-ui-sidebar-right`）占用，
直接注册会顶掉内置右栏。而且用户要的是「点开就能切换」——那是主区语义。
右栏方案已废弃。

### 为什么是这条路径

它与插件管理器（`dsh-client-ui-plugin-manager`）走的是同一条路，是 DSH 自带的成熟形态：

```js
// ① 侧栏入口。id 直接对应主区面板 key，侧栏负责画按钮、标签与选中态。
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: PANEL_ID,          // MainPanelId
  order: 0,
  label: () => t('panel'),
  locale: NS,
}, StationIcon));

// ② 主区整页正文。这就是「点开切换」。
ctx.slots.inject('main', function* () {
  yield ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    store,                        // 面板自己的 store 席位
    inject: () => stationFace,    // 该面板私有的注入面
    children: { /* 本页声明的子 slot */ },
  }, StationPage);
});

// ③ 程序化切换：agent 出图自动跳过去、点图回站，都靠它。
ctx.layout.selectPanel(PANEL_ID);   // 传 null 回对话
```

依据（已核对源码）：
- `dsh-client-ui-layout/lib/types/client/service.d.ts` —— `ILayout.selectPanel(panelId)`；
  `main` 是 `kind: 'keyed'`，`conversation` 为保留 key，其余 key 无 Session 绑定。
- `dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts` —— `sidebar.panellist` 是 `kind: 'list'`，
  「Each list id addresses the matching main panel」。
- `dsh-client-ui-plugin-manager/lib/client.js:3428-3491` —— 上述三段注册的完整实例。

---

## 2. 一页三区

| 区域 | 内容 |
|---|---|
| 左 | TAG 知识库：分类浏览、搜索、点选即插入、当前已选 TAG 列表 |
| 中 | 提示词区（原始描述 + LLM 扩写结果 + 出图流时间线） |
| 右 | 预设切换、接口与模型状态、当前参数、累计花费与张数 |

整页状态存 `localStorage`，key `dsh.image-station.v1`（DSH 自身的右栏就是用这个办法存布局的，
不发明新机制）。

---

## 3. 提示词流水线（核心）

**两次调用之间有人工确认，绝不自动接力**——LLM 的不可控输出不会直接烧钱。

```
你选 TAG + 写描述
      │
      ▼
① ctx.llm.stream({ provider, model, system: 预设的系统提示词+约束, messages, temperature, signal })
      │   一次性调用，identity-free，不伪造 agent、不绑定 session、不污染对话历史
      ▼
LLM 产出结构化 JSON：{ prompt, negative, params }
      │
      ▼
② 面板展示 LLM 出的提示词 → 你确认/修改 → 点「出图」
      │
      ▼
③ 调生图接口 → 图落盘 → 画廊 + 对话文件卡 + 累计成本
```

### 为什么这条流水线成立

`dsh-llm` 的 `GenerateOptions` 明确允许无身份的裸调用：

> "a hand-built one-shot may include identity-free user inputs"（`lib/types/types.d.ts`）

字段：`provider`、`model`、`messages`、`system?`、`temperature?`、`maxTokens?`、`stop?`、`signal?`。
其中 `system` 正是「工作站自己配置的提示词加约束」的落点。返回 `AsyncIterable<StreamChunk>`，
所以 LLM 的出词过程可以实时显示在面板上，而不是等一个黑盒结果。

### 模型跟随对话

`用当前会话选定的那个模型` —— 每次调用读取该会话的模型目录：

```
ctx.modelDirectories.directoryFor(sessionId).store.getSnapshot().current
→ { provider, model }
```

依据：`dsh-client-ui-model-selection/lib/types/client/{service,directory}.d.ts`。

**待验证**：全局 root 面板读取「当前会话」的路径。主区切到全局面板后，`activePanelId !== null`，
面板不再处于 `SessionProvider` 之下，因此 `sessionId` 需要另行取得（候选：sessions 服务的当前选中项）。
验证失败时的降级方案：改用 `agent-default-model` 的配置值，并在面板上显示「本次扩写使用 X」。

---

## 4. 预设 = 约束的分组单位

「按风格/预设分组，一组一套」。每个预设是一个配置包：

| 字段 | 说明 |
|---|---|
| 系统提示词 | 该风格的角色与输出契约 |
| 约束 | 风格铁律、禁止项、TAG 使用规则 |
| TAG 子集 | 该风格可用的 TAG 范围（空 = 全部） |
| 默认生图参数 | 尺寸、质量、张数、背景等 |
| 参数建议开关 | 是否允许 LLM 提议参数（你仍可改） |

预设存放位置与 TAG 库同级，随插件配置一起走。

---

## 5. 提示规范（原 TAG 知识库，方向已修正）

**修正记录**：初版设计要做 TAG 知识库（分类浏览、点选插入、中文标签层），依据是"绘图提示词＝标签"。
问过 GPT 后确认：**GPT Image 是自然语言模型，不是 Tag 解析器**。规范原文：

> 不要把 GPT Image 当成"Tag 解析器"。把它当成一个能够理解人、物体、动作、空间、镜头、光线、
> 材质和视觉意图之间关系的视觉生成模型。

并明确点名禁止 `masterpiece` / `best quality` / `ultra detailed` / `8k` / `absurdres` /
`score_9` / `1girl` / `solo` / `artist tag` —— "这些属于其他模型生态中的提示习惯"。

所以 **TAG 库整条线取消**。左栏改为"提示规范"视图：说明当前用的规范、列出知识来源文件与版本。
`tags` 字段在数据结构里保留（预留给"视觉术语表"之类），但 GPT Image 路线下默认为空。

### 规范文件化（`specs/*.md`）

规范是知识，知识不该硬编码在 JS 字符串里。落成可编辑、可版本管理的文件：

```
specs/
  gpt-image-natural-language.md   id: general             7927 字符  ← 用户给出的 v1.0 规范全文
  anime-illustration.md           id: anime-illustration  base: general
  character-keyvisual.md          id: character-keyvisual base: general
```

文件格式：`---` 头（`id` 必填，`label` / `description` / `base` / `version` 可选）+ 正文。
`base` 指向另一个预设时，被指向的规范**全文排在前**，本文件内容作为"任务聚焦层"追加在后，
所以两个窄预设各自约 9.4–9.8K 字符。**改规范 = 改 .md 文件 + F5，不用改代码。**

宿主启动时会逐条打印加载结果（id / 文件名 / 字符数 / 版本），
把"知识文件到底有没有被读到"变成启动时就可见的一行，而不是等某个预设产出诡异结果才发现。

### 顺序上的一个决定

拼给模型的 system 里，**规范全文在最前**，任务指令与 `extraRules` 排在后。
理由：规范是"怎么做"，具体任务是一次性的，后者不该盖掉前者。

---

## 5b. 规范自检（把模型自律换成代码保证）

规范第 27 节给了"发送前必须检查"的清单。其中**可机械判定**的部分由 `lib/lint.js` 兜底。

为什么需要：实测中，即便系统提示词明确禁止，模型仍可能滑回它熟悉的 Tag 写法。
只靠"提示词里写了不许"是祈祷，不是保证。

检查项：禁令词表、danbooru 计数标签、Tag 列表特征（逗号碎片占比）、Markdown 围栏/标题/列表、
JSON-YAML-XML 开头、Negative Prompt 区块、对话式前言、相邻重复修饰词、缺 `Create …` 任务声明。

**只报告，不改写。** 自动改写会掩盖问题，也容易改坏语感；结果随 `done` 事件推给面板，
重抽与否由人决定。`probe-lint.mjs` 双向验证：合规输出零误报，7 类违规全部命中
（包括旧 anime 预设那段真实产出的 tag 串）。

---

### 方向修正前后的实测对比

同一个描述（"银发女王穿白蓝礼服，拿权杖，站在暴风中的大船上"）：

| | 旧 `anime` 预设 | 新 `general` 预设（规范驱动） |
|---|---|---|
| 形态 | `1 cat, solo, orange tabby cat, …` 逗号 tag 串 | `Create a polished cinematic high-fantasy character illustration. The primary subject is…` 完整描述 |
| 质量词 | 带 `high quality` | 无 |
| 空间关系 | 无 | "the ship's masts extend behind and below her, while towering waves rise in the background" |
| 任务声明 | 无 | 明确 image type |
| 负面约束 | 无 | "do not add a crown, additional characters, text, logos, or watermarks" |

新预设三条实测**全部通过自检**，且各自侧重清晰：`general` 均衡、`anime-illustration` 强调
眼睛/发丝/上色方式、`character-keyvisual` 把取景范围与主体优先级写死。

---
### 出图接口实测能力表（在一台真实的 OpenAI 兼容中转站上实测；服务地址与模型名属部署方配置，不入库）

该服务的模型目录只有三个，全是出图模型（各自质量与价格不同；选哪个在 config 里配）。

| 能力 | 结论 | 依据 |
|---|---|---|
| `/v1/images/generations` | ✓ 可用 | 返回 `data[].b64_json` + `revised_prompt` + `usage` |
| `size` | ✓ **真生效** | 三种尺寸的返回 PNG 像素与请求完全一致（1024x1024 / 1536x1024 / 1024x1536） |
| `n` | ✓ 生效 | `n=2` 真的返回两张 |
| `/v1/images/edits` | ✓ 可用 | multipart `model + prompt + image`，返回编辑后的图 |
| `mask` 局部重绘 | ✓ 可用 | 自建 mask（左半黑=保留、右半白=重绘）后分界线精确生效 |
| `quality` | △ 部分 | `medium` 稳定；`high` **反复触发上游"无可用账号"**，故面板只给 low/medium |
| `background` | ✗ **接受但静默忽略** | 要 `transparent`，回来 PNG colorType=2（无 alpha） |
| `output_format` | ✗ **接受但静默忽略** | 要 `webp`，回来还是 PNG |
| `edits` 的 `size` | ✗ 忽略 | 传 `1024x1024`，回来 `1254x1254` |
| 上游容量 | ⚠ 间歇枯竭 | HTTP 503 `No available compatible accounts`；**必须重试** |
| 每张耗时 | ⚠ 18–26 秒 | 不是超时，是正常速度，界面必须给出预期 |

**最重要的一条：这台中转站会"接受参数但不生效"。** 它回 200 却不一定照做，所以：

- 提交前**剥离**已知无效参数并明确告知（不让用户为无效参数付这次的钱）
- 拿到图后**校验真实字节**：PNG 头里的尺寸、color type、格式
- 任何"请求与实得"不一致，都作为 warning 挂到面板上

### 凭据：为什么最后落在 Key 文件上（踩过）

初版只从环境变量读 Key，结果从桌面图标启动时必然拿不到：`BlueFishStation.exe` 用
`Process.Start` 拉起 `cmd /c dsh web`，那个子进程继承的是**资源管理器进程**的环境，
而 `setx` 不会改动已在运行的程序的环境。于是面板只能报一句找不到 Key，
用户既不知道去哪儿设、也没有更好走的路。

现在按顺序解析，并把"找过哪儿"如实回报：

| 顺序 | 来源 | 说明 |
|---|---|---|
| ① | `config.apiKey` | 不推荐，会落进 YAML |
| ② | **Key 文件** `$DSH_HOME/image-station/.env` | 推荐；一行 `KEY=VALUE` |
| ③ | 进程环境变量 | 仍支持，适合脚本化启动 |

面板提供写入口：粘进去 → 宿主写盘 → **重新解析一次确认可读** → 回报脱敏状态。
所以"保存成功"意味着真的能读到，而不是"我以为写进去了"。写盘后**免重启生效**
（每次出图都重新解析，不缓存）。

两个细节：

- Key 文件头**刻意用纯 ASCII**。无 BOM 的 UTF-8 中文在 Windows PowerShell 5.1 里会按
  ANSI 解码成乱码 —— 文件本身没坏，但看的人会以为坏了。配置文件的受众是各种工具，ASCII 最稳。
- 状态回给面板时一律脱敏（只给长度与末四位），Key 本身从不进浏览器。

---
### 参考图上传（图生图，阶段四提前落地）

后端 `/v1/images/edits` 与 `mask` 都已实测可用（见上表），本阶段补的是**面板侧**。

**客户端必须先压缩，不能直传。** 实测一张 1024x1024 PNG 有 0.6–1.0 MB，
base64 后还要再涨约 1/3，会撞上宿主侧 `readBody` 的 4 MB 上限。所以：

- 超过 2 MB 就缩到长边 1536 并转 JPEG(q=0.92)，用浏览器原生 canvas，不引任何库
- 转 JPEG 会丢 alpha，所以先在画布上填白底，否则透明区会变黑
- 压完若反而更大（极少见），就用原图 —— 不做无谓的重编码
- 已够小就原样返回，不重编码（面板会显示"未压缩，本来就不大"）

**`size` 在图生图时必须丢掉。** 实测 edits 忽略它（传 1024x1024 → 回来跟随输入图）。
与其让用户以为设了尺寸，不如提交前就剥离并明确告知 —— 面板会挂一条
"参数 size 未发送：图生图时该中转站忽略 size，输出尺寸跟随输入图"。
实测确认：用 1024x1024 的参考图，输出就是该尺寸。

**验收写在前面**：不是 PNG/JPEG/WebP、或浏览器解码不了，就明确拒绝并说明原因，
而不是把坏数据送到上游换回一个看不懂的错误。

两个入口：拖拽/点选上传，以及画廊每张图的「用它继续改」（从刚出的图接着迭代，最常用）。

---
### 计费（经仪表盘核实）

**每次固定 $0.0300**，与提示词长短、尺寸、张数无关（用户实测仪表盘：
仪表盘显示"每次 $0.0300 / $0.0300，1,518 tokens"）。

端点同时返回 usage，但**不能用它反推账单**：

| 来源 | 每次 token 数 |
|---|---|
| 本地实测 usage | in ~34 / out 1056 → 合计 ~1,090 |
| 服务方仪表盘 | 1,518 |

两者口径不同（仪表盘大概含上游内部开销）。所以：

- **`flatPricePerImage` 是唯一权威数字**，面板显示的花费一律以它为准
- `inputUsdPerMillion` / `outputUsdPerMillion` 留作**自检**：填了之后，若 token 反推值与
  包价相差超过 `sanityFactor`（默认 3 倍）就会告警，因为那说明口径配错了
- 参考换算：`output 1056 token × $28.4/M ≈ $0.0300`，与仪表盘一致 —— 印证它是
  token 计费端点，只是每张图 token 恒定，对外等价于固定单价

配置示例与自检效果：

| 配置 | 算出的花费 | 是否告警 |
|---|---|---|
| `flatPricePerImage: 0.03` | $0.030000 | 无 |
| `+ outputUsdPerMillion: 28.4`（换算正确） | $0.030000 | 无 |
| `+ outputUsdPerMillion: 4`（按 DeepSeek 口径，错） | $0.030000 | **告警：相差 7.1 倍** |
| `flatPricePerImage: 0.00003`（早期误配） | $0.000030 | 无（无 token 单价可比，检测不到） |

**规模感**：$0.03/张 → 100 张 $3，1000 张 $30。

---
### 两个实测踩到的坑（用户反馈驱动）

**① 切面板会丢状态 —— 主区面板是 slot 组件，卸载即失忆。**

用户反馈："不小心切回对话，正在生图的界面又变成初始界面了，原本进行的生图任务找不到了。"

原因：`main` 槽的面板在切走时**整个组件被卸载**，里面所有 `useState` 随之丢弃 ——
出图记录、累计花费、参数选择都回到初始值。

修法：把这类状态提到组件之外（`globalThis` 上的一个 store + 订阅式 `useStore()`）。
挂在 globalThis 而不是模块变量，是因为客户端 bundle 被 HMR 替换时会**重新执行 factory**，
模块变量会重置，而用户期望 HMR 前后看到同一份记录。

顺带修正一处派生逻辑：`drawing` 不能只用局部 `useState`。
出图结束时那个闭包写不回一个**已经消失的组件**，于是"切走再切回"会让按钮卡在"出图中…"。
现在对外暴露的是 `drawing || running`，以 store 里的 `running` 为准。

**诚实的边界**：重新挂载后**看不到实时进度**。原始请求的流只存在于它自己的闭包里，
组件卸载后拿不回来；只能等它结束时由那段闭包写入 store，再显示结果。
要连进度都恢复，需要宿主侧建任务登记表（见后续项）。

**② 出图目录按 cwd 解析 —— 图被写进了 DSH 安装目录。**

用户反馈："图片也没有具体的存储位置。"

原因：`outputDir: '.dsh-images'` 是相对**宿主进程 cwd** 解析的，而 `dsh` 从 npm 全局目录启动，
于是图落到 `<npm 全局>/node_modules/@deepseek-ai/dsh/.dsh-images/` ——
既想不到去哪儿找，也可能被 DSH 升级连带删除。

修法：默认改为 **`$DSH_HOME/image-station/images`**（与 Key 文件同级），
且 `resolveConfig` 阶段就解析成**绝对路径**，相对路径一律按 `$DSH_HOME` 而非 cwd。
面板上**明写完整路径**，用户一眼知道图在哪。

这两个坑的共同点：都是"我在测试环境里没遇到、因为我的 cwd 和挂载时序恰好正常"。
用户的真实使用路径才是判据。

---
## 6. 生图接口

| 项 | 决定 |
|---|---|
| 端点 | 第三方中转站，base URL 走插件 config |
| 主路径 | `POST /v1/images/generations` |
| 模型名 | config 可覆盖（中转站别名未知，不硬编码） |
| 响应 | `data[].b64_json`，解码后落盘 |
| 密钥 | 环境变量（`DSH_IMAGE_API_KEY`），YAML 里不写密钥 |
| 图生图 | `/v1/images/edits` + `mask` + `input_fidelity` 做成能力探测，失败则降级 |
| 降级策略 | 首发生成探测参数支持面，不支持的参数自动剥离并**在面板上明确告知**，不静默 |

**依赖纪律**：宿主侧只用 Node 内建 + 自有代码。插件经 junction 加载时 Node 按真实路径解析模块，
profile 的 `node_modules` 不在解析链上——`dsh-plugin-aurora` 就是因此刻意不依赖 `schemastery`。
配置合并手写，不引第三方 schema 库。

---

## 6b. 传输层（阶段 2a 落地）

面板与宿主之间**不用 DSH 的 Remote 机制**：它需要构建期生成的 `/remote` 声明（仓库内产物），
第三方插件走不通。改用插件自建 HTTP 路由，`ctx.webServer.register` 的契约恰好够用——
文档明写 handler "owns the full response lifecycle (may hold the response open, e.g. SSE)"。

| 端点 | 作用 |
|---|---|
| `GET /image-station/presets` | 预设清单、默认项、目标模型（**不回吐 system 正文与 extraRules**） |
| `POST /image-station/expand` | 流式扩写 |

流格式是 **NDJSON**（每行一个 JSON 事件），不是 SSE 帧：浏览器侧要用 `POST` + `fetch` 读流，
而 `EventSource` 只支持 GET。事件类型：`start` / `reasoning` / `delta` / `usage` / `done` / `error`。
客户端断开时 `res.on('close')` 会 abort 上游 LLM 调用，避免无谓烧 token。

### 鉴权：为什么必须自己守门（踩过）

`/image-station/*` **不经过** `/api` 的浏览器信任栅栏。实测：无 `Authorization` 的请求
能到达 handler 并拿到插件自己回的 401，说明根本没被外层拦。所以：

- 令牌经 **index tap** 写进 `<html data-image-station-token="…">`，浏览器解析完根标签即可读取，
  时序上一定早于 bundle 里的 `apply()`
- **令牌是每个 index 响应新生成的**，不是每进程固定。所以探针/客户端都必须从文档里读，
  不能从服务器日志那行 URL 里拿（那是另一个响应）
- 这不是对抗本机用户的强边界（本机进程本来就能读文件），而是防止浏览器里任意页面
  无意间驱动这个端点

### 前缀路由不剥前缀（踩过）

`ctx.webServer.register({ kind: 'prefix', path })` 只决定**哪些请求交给这个 handler**，
**不会把前缀从 `req.url` 里去掉** —— 处理器拿到的永远是完整 pathname。

早先按"已剥前缀"写（处理器里判断 `/presets`），结果每条请求都落进 404 分支。
更迷惑的是鉴权先跑，所以表面上像"令牌是对的、但这个路由不存在"。
**前缀必须在处理器里自己去。**

依据：`dsh-host-webserver` 的 `match()` 只做前缀判定；实测响应体里
`{"error":"not-found","path":"/image-station/presets"}` 直接暴露了完整路径。

### 宿主侧的服务注入同样不能漏（踩过第二次）

客户端漏 `inject` 会导致整行加载失败；**宿主侧漏了不会崩，而是每次访问属性都抛**
`cannot get property "X" without inject`。所以 `ctx.agentDefaultModel` 一开始拿不到，
表现为 `/expand` 返回 503（被自己的 try/catch 兜住了），排查时容易误判成凭据问题。

规则：**用到的每个 `ctx.<service>` 都必须出现在 `export const inject` 里**，两侧同理。

---

## 6c. 模型来源（阶段 2a 定案）

面板与服务端**都拿不到"你当前打开的那次会话"临时切换的模型**，这是 DSH 的设计而非疏漏：

- `ISessions` 的注释明写「导航属于视图所有者」，只给 `list`，没有"当前选中"
- 会话级模型选择是**持久化投影**，挂在 `sessionId` 下，得先有 id 才能查
- `aurora.js` 作者的兜底是**劫持 RPC 层 + 取 `updatedAt` 最新的会话**——那是猜，不采用

**定案**：读 `ctx.agentDefaultModel.currentSelection()`，即 profile 的 `agent-default-model`
（= 你在对话里选的那个档位）。代价只有一个：在会话里临时切模型后面板不实时跟随，重开面板即可。

---

## 7. 成本统计

- 口径：**成功出图张数 × 单价**。当前单价 **0.03 USD/张**（经仪表盘核实），作为 config 可覆盖项（中转站调价只改配置）。
- 展示：累计花费 + 累计张数，常驻面板右区。
- 台账：图片目录旁的 `index.jsonl`，逐条记 `{ts, 会话, 预设, 模型, 尺寸, 质量, 张数, 耗时, 单价, 小计}`。
  画廊历史与成本统计共用这一份，不另开数据库。
- 失败与取消的请求不计费。

---

## 8. 出图归属与回灌

- **落盘**：工作区子目录。
- **画廊**：面板内历史，可按会话分桶。
- **回灌**：回灌为**文件卡 / 只读路径**，不做图片附件。agent 用文件工具按需读取；
  不往会话事件里写附件对象，对话历史不被污染。
- **自动推送的归属问题**：全局面板按设计不接收 Session 绑定，因此宿主侧事件必须携带 `sessionId`，
  面板按 `sessionId` 分桶显示——当前选中会话的桶高亮，其他会话收进折叠区。
  这是必须在实现期正面解决的问题，否则多会话并开时会串图。

---

## 9. 宿主侧：一个 cordis 插件

| # | 接口 | 作用 |
|---|---|---|
| 1 | `ctx.llm.stream(...)` | 提示词流水线的 LLM 扩写 |
| 2 | `ctx.tools.register(defineTool(...))` | 给 agent 的 `image_generate` / `image_edit` 工具 |
| 3 | `ctx.webServer.register({kind:'prefix'})` + SSE | 面板命令通道与实时推进 |
| 4 | `ctx.webServer.register({kind:'exact'})` | 出图字节的读取路由，`<img src>` 直接用 |
| 5 | 自持队列 + `ctx.jobs` | 并发闸门、重试、取消、进度 |

插件骨架照 `dsh-plugin-aurora`：`export const name` / `export const inject` / `export function apply(ctx, config)`，
所有注册经 `ctx.effect(() => ...)` 并返回 disposer。

---

## 10. 客户端侧：手写 bundle，零构建

**决定：不引入构建链。** 本机没有 pnpm（只有 corepack），而 DSH 的客户端 bundle 契约足够简单，
可以直接手写：

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-imagestation',
  factory: (require) => { /* 模块体，含样式注入 */ return module.exports },
})
```

- 宿主扫已启用的 Loader 条目，把 `client.js` 经 `/plugins` 组合成 combo 脚本供浏览器按需惰性加载。
  **不需要重建 apps/web。**
- 执行 bundle 只注册 factory；所有副作用在 factory 闭包内，因此插件被真正物化前页面上什么都没发生。

### 平台模块表（外壳唯一的冻结表，从 dsh-web-frontend 产物读出）

```
react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis,
@deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
```

**`dsh-client-ui-primitives` 与 `dockkit` 都是平台种子**，因此手写 bundle 可以直接用 DSH 自己的
UI 组件库 —— 不需要把它们塞进 `dsh.client.external`。表外的任何请求都必须声明提供方，否则组合阶段拒绝。
当前实现只用到 `react`。

**刻意不写 JSX**：JSX 需要编译器。`lib/client.js` 里的 `h()` 用 `React.createElement` 实现，
代价是每个元素多一层数组括号，换来改完文件直接生效、无构建等待。

### 后端字段（package.json）

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```

`platform` 必须是字符串，否则 client-modules 直接抛错。当前不需要 `external` 与 `inject`。

### bundle patch 的格式陷阱（踩过）

`cordis-plugin-include` 的 `applyEntryPatches` 实现决定了：

| 写法 | 行为 |
|---|---|
| `- insert: [...]` | **追加新行**（新插件必须用这个） |
| `- id: 已有行` | 按 id 覆盖已有行的其他字段 |
| `- id: 不存在的行` | **warn 后静默跳过，不报错** |
| 顶层项缺 `id` 且无 `insert` | warn 后跳过 |

所以「`- id: image-station` + `name:`」这种看起来最自然的写法**会被静默丢弃**，插件根本不加载。
新增行一律放进 `- insert:`，与 DSH 随包 bundle 的写法一致。

依据：`dsh-client-modules/README.zh.md`、`cordis-plugin-include/lib/types/index.d.ts`、
`dsh-web-frontend/dist/assets/index-*.js` 的 `staticModules` 表。

### 客户端插件必须声明服务注入（踩过，代价最大）

客户端 bundle 必须导出 `inject`，列出它要用的 **cordis 服务名**（不是包名）：

```js
exports.inject = ['slots', 'locale', 'layout']
```

漏了它，访问 `ctx.locale` 会直接抛 `cannot get property "locale" without inject`，
而浏览器的报错只有一句：

```
Failed to load plugins
dsh-plugin-imagestation
web boot: 1 entry did not activate
dsh-plugin-imagestation: failed
```

**不给原因**。cordis 会一直等齐声明的服务才调用 `apply`，所以声明也是"等到就绪"的机制。

`package.json` 里的 `dsh.client.inject` 是**另一件事**：那是客户端模块的加载依赖（包名）。
两者同名不同义，别混。

依据（随包插件实测）：
`dsh-client-ui-plugin-manager` → `["slots","locale","remote","remote.pluginManager",…,"layout"]`；
`dsh-client-ui-sidebar` → `["slots","layout","uiWorkspace","locale","shortcuts"]`；
`dsh-client-locale` → `["slots","remote","configForms"]`。

### 无 JSX 的 h() 歧义（踩过三次）

本插件不写 JSX（没有编译器），`h(tag, props?, children?)` 的"第二参数是属性还是子节点"
是个固有歧义，同一个位置连踩三次：

| # | 现象 | 原因 |
|---|---|---|
| ① | React error #31，组件收不到任何属性 | 属性表落进了 children 槽（判断只在非字符串 tag 分支里生效） |
| ② | 按钮成空壳，文字消失 | 修正后过度收紧，字符串子节点被当成属性表吞掉 |
| ③ | `h('button.x', {…}, '文字')` 少一个字 | `h` 只声明两个形参，第三参被静默丢弃 |

现在的规则：**字符串标签不带类名 + 裸对象 = 属性表；带类名的标签串里，第二参数是子节点，
但显式传入裸对象时与类名合并并把第三参当子节点；组件一律"对象即属性表"。**
`probe-render.mjs` 对每种调用约定都有断言，改动 `h` 必须先让它全绿。

依据：`react-dom/server` 真渲染 + `createElement` 参数级追踪（见探针）。

---

## 11. 桌面壳

`BlueFishStation.exe`（WinForms + WebView2）**一行不动**。它只负责拉起
`dsh web --port 0 --no-open`、正则抓带 token 的 URL、塞进 WebView2。绘图站完全活在 Web GUI 里。

---

## 12. 待验证项（实现期必须先用最小实验确认）

| # | 事项 | 失败时的降级 |
|---|---|---|
| 1 | 全局 root 面板如何取得「当前会话 id」 | 用 `agent-default-model` 配置值，面板上标注实际使用的模型 |
| 2 | TAG 导入器的格式分派能否覆盖你的原件 | 先支持 CSV/JSON，其余按扩展名报错并给出期望格式 |
| 3 | 「拖参考图从对话进面板」的接入点 | 用 `dsh-client-ui-attachment` 已发布的 `ImageLoader`，不抠 DOM |
| 4 | 中转站实际支持的参数集 | 能力探测 + 参数剥离 + 面板明示 |
| 5 | `localStorage` 状态与 profile 的 HMR 回收是否干净 | 状态改存 `$DSH_HOME`，随插件生命周期 |

### 已核对过的 API 签名（不是推测，是读 `.d.ts` 得到的）

| 调用 | 确切签名 | 出处 |
|---|---|---|
| `ctx.locale.register` | `register(ns, locale, dict)` —— **没有 `define`**；整包形式是 `register(ns, dicts)` | `dsh-client-locale` |
| `ctx.locale.bind` | `bind(ns: string): Translate` | 同上 |
| 侧栏入口 `label` | `SlotLabel = string \| (() => string)` —— **无参 thunk**，每次读取重新求值以跟随语言 | `dsh-client-ui-slots` |
| `ctx.slots.inject` | `inject(key, callback) => () => void`；key 未声明时排队等待，声明后立即执行 | `dsh-client-ui-renderer` |
| `ctx.slots.register` 的 `inject` | `((...args) => Record<string, unknown>)`，返回值成为组件 props | `dsh-client-ui-slots` |
| `ctx.slots.register` 的 `locale` | 声明后框架合成 `t` seat 放到组件 props；**未安装 locale face 时会明确报错** | 同上 |
| `ctx.layout.selectPanel` | `selectPanel(panelId \| null)`；未注册的 key 抛错并保留当前选择 | `dsh-client-ui-layout` |

---

## 12b. 阶段一验证记录

验证分层，**每一层都得真跑过**——"启动图里有我"曾被误当成"能激活"，代价是浏览器里一个
不给原因的 `failed`。工具脚本都在本目录，可随时重跑。

| 层 | 手段 | 结果 |
|---|---|---|
| 语法 | `node --check` 两个入口 | 通过 |
| 安装链 | 脚本重跑幂等；`require.resolve` 主入口 + `./client` 两个导出 | 通过 |
| 宿主半侧 | `dsh web --help`（会完整组合一次 profile，零副作用） | 通过 —— 输出 `[imagestation] host half active` |
| bundle 契约 | `probe-client.mjs` / `probe-main-effect.mjs`：假 seed 表 + 记录型 ctx，把注册链路走一遍 | 通过 |
| 渲染 | `probe-render.mjs`：真 `react-dom/server` 渲染两个组件 + 15 条断言 | 通过 |
| 真实浏览器 | `probe-boot.mjs` / `probe-switch.mjs`：无头 Chrome + DevTools 协议，**真的点图标、确认整页切换、再切回来** | 通过，控制台零错误 |

最终一次端到端：侧栏入口 `label:「绘图工作站」` → 点击后标题/左中右三栏全部可见 →
点「切回对话」回到对话页。截图落在 `station-skeleton.png`。

**两个促使这套工具成型的原因，值得记住：**

1. **浏览器只说「entry did not activate」，不说为什么。** 真正的原因
   （`cannot get property "locale" without inject`）只出现在 console 里，
   而 console 被 aurora 的 telemetry beacon 刷屏淹没了。探针必须过滤噪声、
   并且**分层定位**——渲染层能过、浏览器层过不了，就把范围缩到契约层。
2. **静态代码审查会看漏。** `h()` 的歧义三次都是"读代码觉得对、跑起来才不对"。
   `probe-render.mjs` 的存在就是为了让第四次发生前就被断言拦住。

**关键手法**：另起一个端口的第二个实例来验证，因此不碰正在使用的 GUI、不中断会话。
`dsh web --help` 足以零副作用地验证宿主半侧加载。

---

## 13. 施工阶段

| 阶段 | 交付 | 结束判据 | 状态 |
|---|---|---|---|
| 一 | 骨架：包结构、安装链、插件加载、侧栏入口、整页面板、切换 | 点图标能切到绘图页，切回对话不丢会话 | **已验证（含真实浏览器点击）** |
| 二 a | 预设结构、LLM 扩写流水线、提示词确认界面 | 中文描述 → 实时扩写 → 可编辑提示词 | **已完成并验证（含真实 LLM 调用）** |
| 二 b | ~~TAG 库导入器~~ → 改为：提示规范文件化 + 规范自检 | 改 specs/*.md 即改行为；自检双向准确 | **已完成并验证** |
| 三 a | 生图：接口接入、落盘、画廊、成本、能力探测降级 | 面板里真的出图并显示 | **已完成并验证（真实出图 + 浏览器点击）** |
| 三 b | 对话文件卡回灌 | agent 能拿到出图路径 | 未开始 |
| 四 a | 参考图上传（图生图）+ 成本统计 | 传图能改图；累计花费正确 | **已完成并验证（真实图生图）** |
| 四 b | 蒙版局部重绘（接口已实测可用，缺涂刷界面） | 能在图上涂一块只重绘那里 | 未开始 |
| 四 c | 跨会话画廊 | 关掉面板后出图记录还在 | 未开始 |
| 四 d | 切面板不丢状态 + 出图目录明示 | 切走切回记录还在；目录写在界面上 | **已完成并验证** |
| 四 e | 宿主侧任务登记表（让切回后也能看到实时进度） | 重挂载后进度不中断 | 未开始 |

---

## 14. 尚未确定（不阻塞阶段一、二）

- 中转站的 base URL 与它认的模型名。
- TAG 知识库的最终格式。
- `/v1/images/edits` 在中转站上是否可用（决定阶段四的降级幅度）。
