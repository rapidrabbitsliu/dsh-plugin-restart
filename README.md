# DSH Web Restart

[![npm](https://img.shields.io/npm/v/dsh-plugin-web-restart)](https://www.npmjs.com/package/dsh-plugin-web-restart)

在 DSH Web 左侧栏底部增加 **重启 DSH** 图标。点击后二次确认，通过 DSH 的 `appExit(0)` 正常退出；独立启动包装器等待旧进程退出，再以同一命令、参数、工作目录和环境拉起新进程。页面检测到新服务实例后自动刷新。

**首次必须用包装器启动 DSH 一次，之后才能通过侧边栏重启。** 本插件不修改 DSH 核心，不强杀进程，不扫描端口后终止服务，不从浏览器接收任意启动命令。

- npm 包：`dsh-plugin-web-restart`
- GitHub 仓库：<https://github.com/rapidrabbitsliu/dsh-plugin-restart>
- 独立社区插件，非 DSH 官方插件。

## 1. 安装插件

在 DSH 插件管理页面安装 `dsh-plugin-web-restart` 并启用，或运行：

```powershell
dsh plugin --profile web add dsh-plugin-web-restart
```

选择实际运行的 profile；CLI 与 GUI 必须指向同一 DSH 安装、home 和 profile。也可安装 GitHub Release 提供的 tarball，或通过本地目录安装。不要同时启用多个本插件副本或其他占用相同路由的旧版本。

## 2. 首次切换启动方式

保存编辑、等待重要任务结束，在原终端正常停止旧 DSH。**旧服务仍占用端口时，不要启动第二个实例。**

包装器入口为本包的 `supervisor.js`。源码用户可 clone 本仓库并使用该文件；npm 用户可以从 profile 实际依赖位置找到它，或在独立目录安装并解析：

```powershell
npm install --prefix ./restart-launcher dsh-plugin-web-restart
node --input-type=module -e "console.log(import.meta.resolve('dsh-plugin-web-restart/supervisor'))"
```

第二条命令应在 `restart-launcher` 目录执行，输出是文件 URL，启动命令应使用对应的本地文件路径。

### DSH 源码 checkout 示例

把以下占位路径换成自己的真实路径，保留原来的环境变量和启动参数：

```powershell
Set-Location 'C:\path\to\deepseek-harness'
& 'C:\Program Files\nodejs\node.exe' 'C:\path\to\dsh-plugin-restart\supervisor.js' -- 'C:\Program Files\nodejs\node.exe' --import tsx/esm apps/cli/src/bin.ts web --no-open --port 3090
```

### 已安装 DSH CLI 的通用形式

```text
node /absolute/path/to/supervisor.js -- /absolute/path/to/node /actual/dsh/cli-entry.js web ...
```

`cli-entry.js` 必须是当前 DSH 安装的真实 CLI 入口，不是任意 Host 模块。包装器不使用 shell；Windows 下不要传入 `.cmd`、`.bat` 或 `pnpm` 作为被监管进程。推荐使用 Node 的绝对路径，避免开机启动时 PATH 不同。

保留原先的 DSH home、profile、patch、trusted-host、端口、日志和环境设置。启动后使用终端打印的登录地址访问原 GUI；不要公开认证令牌。保持包装器终端运行，或让现有开机启动机制启动包装器。自动启动配置需自行备份、检查重复实例策略，**本包不会安装 Windows 服务或修改计划任务**。

## 3. 使用

1. 刷新原 GUI，点击侧边栏底部 **重启 DSH**。
2. 可以先测试“取消”，不应中断服务。
3. 确认没有重要任务正在运行，再点击“确认重启”。
4. 页面等待新实例上线并刷新。90 秒内未恢复时可以继续检查，但不会自动重复发送重启请求。

如果提示“未由重启包装器启动”，当前服务缺少包装器控制环境，请检查首次启动方式。成功的判据是 **DSH PID 改变、包装器 PID 不变、原端口恢复且无重复实例**。

**重启影响整个 DSH 服务及所有用户/会话。** 正在运行的回答、工具、后台任务会中断，不承诺自动恢复。此版本不阻止活动任务，也不提供任务清空锁；请先等待重要任务结束。会话持久化恢复由 DSH 自身负责。

## 插件开发与 watcher

不要将包装器套在 `pnpm run dev:web` 外面，也不要直接用于 Desktop 或已有服务监管器中的 Host。支持的方式是包装器监管实际 Web CLI。所验证版本的 `dev:web` 启动器将 Web 子进程退出视为失败，会停止 watchers。

需要前端自动重建时，在另一个终端、同一 checkout 运行：

```powershell
pnpm run dev:web --no-serve
```

完成构建后再启动受包装器监管的实际 Web CLI。已有构建产物时可按 DSH 文档选择 `--skip-build`。Host 插件 HMR、前端 bundle 重建和页面刷新是不同能力；没有正确 watcher 时不保证编辑后自动更新。

## 安全与生命周期

- 插件 Web 路由使用 DSH `connection.admit`，仅允许已登录 owner browser；同源 POST 还要求精确 Origin、自定义确认头和 JSON。
- 一次性随机确认票据有效期 60 秒，每个插件实例最多保留 64 个；同一实例只允许一个正在提交的重启请求。
- 包装器监听随机 `127.0.0.1` 端口，通过私有环境变量注入随机 Bearer token。浏览器不接收 token；控制通道拒绝 Origin / Sec-Fetch 请求，不启用 CORS。Host 使用 Node HTTP 访问该通道。
- 收到请求后 15 秒内，只有旧进程以 0 退出时才拉起一次。崩溃、非零退出或无请求退出不会自动拉起；超时不杀旧进程，重复请求不延长超时。
- Host 在包装器确认后延迟 400 毫秒请求正常退出，为响应送达留出时间。断网或关闭页面不会撤销已提交的请求。结果未知时页面只检查新实例，不自动重发。
- DSH 自身清理有超时；非零退出将使包装器停止，应检查启动日志。本包不提供崩溃自动恢复或重试循环。
- 停用插件会移除路由与侧边栏入口，并清理未执行的退出定时器。包装器独立运行，需在其终端 Ctrl+C 停止；Windows 信号行为由 Node/Windows 决定，不保证包装器终止时的子进程优雅清理。
- 反向代理必须保留正确 Host/协议；本版不信任任意 X-Forwarded-*。协议或 Origin 不符时会拒绝请求。
- 受监管进程及其子进程能读取控制环境变量；这是受信任本机进程间通信，不是针对恶意宿主插件的隔离机制。

## 开发与验证

Node >=22.19，ESM，运行时零第三方依赖。`client.js` 是 DSH lazy-CJS factory 产物，无需独立构建工具。

```powershell
npm run check
npm test
npm pack --dry-run
npm pack
```

17 项 Node 测试覆盖认证、Origin、JSON 限制、确认票据、生命周期清理、包装器鉴权、真实子进程重启、重复请求、超时、信号、失败退出和 CLI。集成测试使用真实插件与包装器，但注入 mock DSH 服务/认证，不冒充完整 Loader 验收。

浏览器 smoke 使用真实 React 18 和 Chromium、模拟 slots 与 HTTP。设置 `PLAYWRIGHT_MODULE`、`CHROME_PATH`、`REACT_UMD`、`REACT_DOM_UMD` 后运行 `node test/browser-smoke.cjs`。它覆盖本地化、原生确认框、取消优先聚焦、Escape、未监管提示、确认 POST、防重复点击和卸载。

2026-10-29 在 Windows 的 DSH 源码 Web 环境完成本地安装、用户在真实 GUI 点击确认重启，以及进程级验收：旧 DSH 退出、新 PID 监听原端口、包装器 PID 保持不变、会话恢复可用。开机启动配置已指向包装器，但尚未通过下一次开机验证。其他平台、其他 DSH 版本、Desktop 和 Windows 服务集成不在已验证范围内。

## 停用、卸载和升级

在 DSH 插件页面停用或卸载 `dsh-plugin-web-restart`。若插件停用，DSH 普通退出后包装器也退出。恢复原启动方式前先停止包装器，避免重复服务。

升级插件后，独立 clone/安装的包装器文件不会自动同步；应同时更新其版本，等待任务结束后重新启动包装器。不要覆盖正在运行的旧版启动脚本而不检查兼容性。

## 资源与模型体验

MIT 许可。图标为原创简单 SVG 路径，不含外部素材。不注册模型工具、不增加提示词或模型请求 token；重启会中断运行中的模型调用。
