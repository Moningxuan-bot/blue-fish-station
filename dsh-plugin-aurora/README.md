# dsh-plugin-aurora

把 `..`（工作区里的 aurora 覆盖层）接进 DSH 的宿主插件。

## 它解决什么

文件注入模式（`install.ps1`）会在每次升级 `@deepseek-ai/dsh-web-frontend` 时被覆盖，
得手动重跑脚本。插件模式把注入和资源提供都放到启动时：

- `tapIndex` 每个 index 响应注入 `<link>`/`<script>`（带 `?v=` 防缓存）；
- `webServer.register` 为 8 个资源各注册一条 exact 路由，**读的是 `assetDir` 指向的工作区目录**。

插件装在 `$DSH_HOME/profiles` 下，DSH 本体在 npm 全局目录 —— 两者独立，所以升级 DSH 不会删它。

## 配置

`cordis.patch.yml` 里这一行：

```yaml
- id: aurora-overlay
  name: 'dsh-plugin-aurora'
  config:
    assetDir: 'D:/WORK/Agent/dsh'
    enabled: true
    injectFavicon: true
```

## 安装 / 卸载

```powershell
pwsh -File ..\install-plugin.ps1     # 安装（不需要 pnpm）
pwsh -File ..\uninstall-plugin.ps1   # 卸载
```

装完必须**重启一次 `dsh web`** —— bundles 列表是启动时读的。

## 注意

文件注入和插件注入**不要同时开**：两者都会注入 `<link>`/`<script>`，会加载两次。
切到插件模式前先跑一次回滚（README 里的卸载命令），把 dist 里的注入去掉。
