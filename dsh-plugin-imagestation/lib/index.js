/**
 * dsh-plugin-imagestation — 绘图工作站的宿主插件。
 *
 * 这一半活在 DSH 的宿主进程里（Node）。分三层，刻意解耦：
 *   presets.js  预设数据（纯数据，零依赖）
 *   expand.js   扩写核心（只依赖 ctx.llm，可脱离服务器单独测）
 *   routes.js   传输层（HTTP + NDJSON 流 + 令牌鉴权）
 *   本文件      接线：配置、令牌、Index 注入、把上面三层挂到 DSH 上
 *
 * 后续阶段往这里加：
 *   ctx.tools.register(...)                给 agent 的 image_generate / image_edit 工具
 *   ctx.webServer.register({kind:'exact'}) 出图字节的读取路由
 *   自持队列 + ctx.jobs                    并发闸门、重试、取消、进度
 *
 * 依赖纪律（照 dsh-plugin-aurora）：插件经 junction 加载时，Node 按真实路径解析模块，
 * profile 的 node_modules 不在解析链上，任何外部依赖都可能解析不到。因此只允许
 * Node 内建 + 自有代码，配置合并手写，不引第三方 schema 库。
 *
 * 另一半在 lib/client.js（浏览器侧，手写 bundle，无构建步骤）。改完两侧任意一份，
 * 按 F5 刷新页面即可；改 package.json 的 dsh 段或启停插件才需要重启进程。
 */

import { randomBytes } from 'node:crypto'
import { mergePresets, DEFAULT_PRESETS, specInventory } from './presets.js'
import { registerRoutes } from './routes.js'
import { dshHome } from './credentials.js'
import { isAbsolute, join } from 'node:path'

export const name = 'image-station'

/**
 * 必需服务。
 *   webServer         自建路由（面板的命令通道与流）
 *   llm               提示词扩写的一次性调用
 *   agentDefaultModel 解析"用哪个模型"（profile 的 agent-default-model）
 *
 * **这里的每一项都必须在列表里**：cordis 对未声明的服务属性直接抛
 * `cannot get property "X" without inject`。这个坑在客户端踩过一次
 * （整行加载失败），在宿主侧又踩了第二次（表现为端点返回 503），
 * 两次都是同一个原因。
 */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/**
 * 合并配置。**刻意浅合并**：数组字段（presets / extraRules）整体替换，不做深合并。
 * 理由同 presets.js：提示词是整体语感，半合并会产出自相矛盾的约束。
 */
function resolveConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const merged = Object.assign(
    {
      enabled: true,
      defaultPresetId: 'general',
      outputLanguage: 'en',
      streamReasoning: true,
      extraRules: [],
      temperature: undefined,
      maxTokens: undefined,

      /* ---- 出图接口 ----
       *
       * 这里的默认值是**通用占位符，开箱不可用** —— 部署方必须在 profile 覆盖层里
       * 填上自己的服务地址与模型名。这样仓库里不会残留任何具体的第三方服务信息，
       * 别人克隆下来也不会误打误撞把请求发到某个真实服务上。
       * Key 只从 Key 文件或环境变量读，绝不写进代码或 YAML。见 README「配置」。 */
      baseUrl: 'https://api.example.com',
      apiKeyEnv: 'DSH_IMAGE_API_KEY',
      model: 'your-image-model',
      retries: 4,
      timeoutMs: 180000,

      /* ---- 图片落到哪里 ----
       *
       * **踩过的坑**：最初写成 '.dsh-images'，靠 hosts 进程的 cwd 解析 —— 而 dsh 是从
       * npm 全局目录启动的，于是图被写进了
       *   <npm 全局>/node_modules/@deepseek-ai/dsh/.dsh-images/
       * 既想不到去哪儿找，也可能被 DSH 升级连带删除。
       *
       * 现在默认落在 `$DSH_HOME/image-station/images`：与 Key 文件同级，
       * 不随 cwd 变化、不随 DSH 升级消失，且是一个用户能记住的位置。
       * 想改成工作区子目录就在 config 里给绝对路径。 */
      outputDir: join(dshHome(), 'image-station', 'images'),
    },
    raw,
  )
  // 嵌套对象单独合并：raw 里只给 image.size 时，不该把 quality/n 的默认值抹掉。
  merged.image = Object.assign({ size: '1024x1024', quality: 'medium', n: 1 }, raw.image || {})
  merged.pricing = Object.assign(
    {
      /* 计费口径。**以 flatPricePerImage 为准**，因为它是唯一经服务方仪表盘核实的数字。
       *
       * 实测：每次固定 $0.03 上下，与提示词长短、尺寸、张数无关。
       * 端点同时返回 usage（input 几十 / output 约 1000 token），说明它内部按 token 记，
       * 但每张图的 token 数恒定，所以对外等价于固定单价。
       *
       * 注意：仪表盘显示的 token 数比本地实测合计更大 —— 两者口径不同
       * （仪表盘大概含上游内部开销）。所以**不要**用本地 usage 反推账单：
       * 配置里的 inputUsdPerMillion / outputUsdPerMillion 只用于自检，
       * 一旦它们与 flatPricePerImage 算出的数差得离谱，面板会明确告警。 */
      flatPricePerImage: 0.03,
      /* 留 null 表示"不做 token 反推"。想自检就填：按 $28.4/M output 折算，1056 token ≈ $0.03。 */
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
      /* 自检容差：token 反推值与包价相差超过这个倍数就告警。 */
      sanityFactor: 3,
    },
    raw.pricing || {},
  )
  merged.presets = mergePresets(raw.presets)
  if (!merged.presets.some((p) => p.id === merged.defaultPresetId)) {
    merged.defaultPresetId = merged.presets[0] ? merged.presets[0].id : DEFAULT_PRESETS[0].id
  }
  // 出图目录在这里就解析成**绝对路径**：相对路径按宿主进程 cwd 解析是不可靠的
  // （dsh 从 npm 全局目录启动，图会落到安装目录里）。下游一律拿绝对路径。
  merged.outputDir = resolveOutputDir(merged.outputDir)
  return merged
}

/** 把出图目录解析成绝对路径。相对路径按 $DSH_HOME 解析，而不是按 cwd。 */
function resolveOutputDir(raw) {
  const value = String(raw == null ? '' : raw).trim()
  if (value === '') return join(dshHome(), 'image-station', 'images')
  return isAbsolute(value) ? value : join(dshHome(), value)
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    console.log('[imagestation] 配置里 enabled=false，宿主侧未启用')
    return
  }

  /**
   * 本进程的会话令牌。
   *
   * 为什么需要它：插件的自建路由**不经过** /api 的浏览器信任栅栏
   * （aurora 的自建资源路由已经证实了这条路径），所以插件必须自己守门。
   * 令牌每进程重新生成一次，经 index tap 注入页面；面板在 Authorization 头里回传。
   * 这不是对抗本机其他用户的强边界（本机进程本来就能读文件），而是防止
   * 浏览器里任意页面/脚本无意间驱动这个端点。
   */
  const token = randomBytes(24).toString('base64url')

  /**
   * 目标模型：读 profile 的 agent-default-model，也就是你在对话里选的那个档位。
   *
   * 已知边界：面板与服务端都拿不到"你当前打开的那次会话"临时切换的模型
   * （会话选择归视图所有者，DSH 未开放）。代价是临时切模型后面板不实时跟随，
   * 重开面板即可。详见 DESIGN.md 第 3 节。
   */
  const selectionOf = () => {
    const svc = ctx.agentDefaultModel
    if (svc && typeof svc.currentSelection === 'function') return svc.currentSelection()
    throw new Error(
      '拿不到默认模型服务 agentDefaultModel；请在 profile 里启用 @deepseek-ai/dsh-agent-default-model。',
    )
  }

  // ① 路由：面板的 /presets 与 /expand。
  ctx.effect(() => registerRoutes({ ctx, config, token, selectionOf }), 'image-station: routes')

  // ② Index 注入：把令牌交给浏览器侧。
  //    用 data 属性而不是可执行脚本，浏览器解析完 <html> 标签即可读取，
  //    时序上一定早于 bundle 里的 apply()。转义 < 以防令牌字符破坏文档。
  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) =>
        html.replace(
          /<html([^>]*)>/i,
          (whole, attrs) =>
            '<html' + attrs + ' data-image-station-token="' + token.replace(/</g, '') + '">',
        ),
      ),
    'image-station: index token',
  )

  console.log(
    '[imagestation] host half active; presets=' +
      config.presets.map((p) => p.id).join(',') +
      ' default=' +
      config.defaultPresetId,
  )

  // 规范文件的自检：把"知识文件是否真的被加载"变成启动时可见的一行，
  // 而不是等到某个预设产出诡异结果才发现 specs 没读到。
  for (const s of specInventory()) {
    console.log(
      '[imagestation] spec ' + s.id + ' <- specs/' + s.file + '  (' + s.chars + ' 字符' +
        (s.version ? ', ' + s.version : '') + ')',
    )
  }
}
