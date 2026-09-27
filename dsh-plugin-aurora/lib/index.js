/**
 * dsh-plugin-aurora — DSH Web 外观覆盖层的宿主插件。
 *
 * 为什么需要它：文件注入（改 dist/index.html + 往 dist 拷资源）在每次升级
 * `@deepseek-ai/dsh-web-frontend` 时都会被覆盖，得手动重跑 install.ps1。插件形态
 * 把这两件事变成启动时自动完成：
 *   ① tapIndex —— 每个 index 响应都注入 <link>/<script>（并带 ?v= 防缓存）
 *   ② webServer.register —— 自建路由提供 CSS/JS/图片，读的是工作区目录，不被升级删除
 *
 * 插件本体装在 $DSH_HOME/profiles 下（junction 指向工作区），DSH 本体在 npm 全局目录，
 * 两者独立 —— 所以升级 DSH 不会删它，也不会让注入失效。
 *
 * 刻意不依赖 @deepseek-ai/schemastery：插件通过 junction 加载时，Node 按“真实路径”
 * 解析模块，profile 的 node_modules 不在解析链上，任何外部依赖都可能解析不到。
 * 因此 Config 不做 schema 校验，改为在 apply 里合并默认值。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

export const name = 'aurora-overlay'
export const inject = ['webServer']

/** URL 路径 → 工作区里的文件名。刻意与文件注入模式共用同一批文件名，两种模式可随时互换。 */
const FILES = {
  '/aurora.css': 'aurora.css',
  '/aurora.js': 'aurora.js',
  '/aurora-logo.svg': 'logo.svg',
  '/aurora-fish.svg': 'fish.svg',
  '/aurora-fish-flat.svg': 'fish-flat.svg',
  '/aurora-bg.svg': 'bg.svg',
  '/aurora-moods.svg': 'moods.svg',
  '/aurora-run.svg': 'run.svg',
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const LF = String.fromCharCode(10)

/** 所有资源的 mtime 最大值作为缓存版本号：任一文件改动都会让浏览器重新拉取。 */
function stamp(dir) {
  let max = 0
  for (const f of Object.values(FILES)) {
    try { max = Math.max(max, statSync(join(dir, f)).mtimeMs) } catch { /* 缺文件就跳过 */ }
  }
  return String(Math.floor(max))
}

/** 注入/改写引用。已存在就只换 ?v=，所以不会因为文件注入模式留下的标签而重复加载。 */
function withAuroraTags(html, dir, withFavicon) {
  const v = stamp(dir)
  let out = html
  out = out.includes('/aurora.css')
    ? out.replace(/\/aurora\.css(\?v=\d+)?/g, '/aurora.css?v=' + v)
    : out.replace('</head>', '  <link rel="stylesheet" href="/aurora.css?v=' + v + '">' + LF + '</head>')
  out = out.includes('/aurora.js')
    ? out.replace(/\/aurora\.js(\?v=\d+)?/g, '/aurora.js?v=' + v)
    : out.replace('</body>', '  <script src="/aurora.js?v=' + v + '"></script>' + LF + '</body>')
  if (withFavicon) {
    out = out.replace(/<link rel="icon"[^>]*>/, '<link rel="icon" type="image/svg+xml" href="/aurora-logo.svg">')
  }
  return out
}

export function apply(ctx, rawConfig) {
  const config = Object.assign({ enabled: true, injectFavicon: true }, rawConfig || {})
  if (!config.enabled) return
  const dir = config.assetDir
  if (typeof dir !== 'string' || dir.length === 0 || !existsSync(dir)) {
    console.warn('[aurora] assetDir 无效，外观覆盖层未启用: ' + String(dir))
    return
  }

  /* ① 资源路由：每个文件一条 exact 路由（不能用 /aurora 前缀 —— /aurora.css 不在该前缀下）。
   * 每次请求都重新读盘 + no-store，所以改完 CSS/JS 按 F5 就见效，不用重启。 */
  for (const [url, file] of Object.entries(FILES)) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: url,
      handler: (req, res) => {
        let body
        try {
          body = readFileSync(join(dir, file))
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('aurora: missing ' + file)
          return
        }
        res.writeHead(200, {
          'content-type': MIME[extname(file)] || 'application/octet-stream',
          'cache-control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    }))
  }

  /* ② index.html 注入：dsh-host-frontend-static 每个请求都重读 dist/index.html 并跑 index taps，
   * 所以这里注入等于永久生效 —— 升级覆盖 dist 也不会丢。 */
  ctx.effect(() => ctx.webServer.tapIndex((html) => withAuroraTags(html, dir, config.injectFavicon)))

  console.log('[aurora] overlay plugin active; assets from ' + dir)
}
