# BrowserOperator

BrowserOperator 是一个用于持久化 Chrome 自动化的 Agent Skill。它内置一个 Node.js CLI，通过 CDP 发出真实的鼠标/键盘事件；每个站点使用独立的 Chrome Profile，登录状态可跨命令、跨会话保留；每次探索成功后会沉淀一份可复用的站点经验文件，后续会话不必重新摸索选择器。

英文说明：[README.md](README.md)

## 功能特性

- 真实鼠标点击：走 Playwright `locator.click()` + CDP，不使用 `el.click()` DOM 事件。
- 一个站点一个持久化 Chrome Profile，cookie 与 `localStorage` 跨命令、跨会话保留。
- 默认 headless；页面需要登录或人机验证时自动切到有头窗口。
- 登录保护：Agent 绝不输入账号密码、不点登录按钮、不处理滑块/CAPTCHA。
- 提供 snapshot、query、click、fill、select、hover、press、wait、switch、screenshot 等原子操作。
- 自动收集 console、network、dialog；操作失败时自动附带截图与最近请求。
- 每个站点一份经验文件（`~/.dsh/browser-operator/experiences/<domain>.md`），探索成功后写入。
- `restore-session on`：重启浏览器后仍能恢复 session cookie（例如 Tomcat 的 `JSESSIONID`）。
- `confirm()` 弹窗自动确认并记录文案，保存/删除类流程可直接测试。
- 每个 Profile 一套固定指纹：headless 下也是普通 Chrome UA（无 `HeadlessChrome`），platform/vendor/WebGL 与宿主一致，Canvas/Audio 噪声稳定。

## 环境要求

- Node.js 18 及以上
- Google Chrome（或通过 `CHROME_PATH` 指定）
- npm
- macOS、Linux 或 Windows

## 安装到 Agent

以 [DeepSeek Harness](https://github.com/deepseek-ai) 为例（Skill 目录为 `${DSH_HOME:-$HOME/.dsh}/skills`）：

```bash
npx --yes github:LearnAIHubC/BrowserOperator
```

安装完成后重启 Agent，即可使用 `browser-operator` skill。

更新已安装版本：

```bash
npx --yes github:LearnAIHubC/BrowserOperator --force
```

安装器会把 skill 复制到 `${DSH_HOME:-$HOME/.dsh}/skills/browser-operator`，安装 Node.js 依赖，并在 `${DSH_HOME:-$HOME/.dsh}/bin/browser-operator` 创建启动器。把该 `bin` 目录加入 `PATH` 后可以直接运行 `browser-operator`；使用 `--dest` 安装时以安装器打印的启动器路径为准。

手动安装：

```bash
git clone https://github.com/LearnAIHubC/BrowserOperator.git /tmp/BrowserOperator
cp -R /tmp/BrowserOperator/skills/browser-operator "$HOME/.dsh/skills/browser-operator"
npm install --prefix "$HOME/.dsh/skills/browser-operator/scripts"
```

## 快速开始

```bash
BROWSER="$HOME/.dsh/skills/browser-operator/bin/browser"

# 用命名 Profile 打开站点（默认 headless）
"$BROWSER" open "https://example.com" --profile example

# 查看可点击元素，并拿到可直接复制的选择器
"$BROWSER" snapshot --mode interactive --profile example

# 真实鼠标点击，并验证页面是否产生变化
"$BROWSER" click "button:has-text(\"保存\")" --profile example --wait-for ".success-toast"

# 截图
"$BROWSER" screenshot --profile example --full-page
```

每个 `--profile` 对应 `~/.dsh/browser-operator/profiles/<name>` 下的独立 Chrome Profile。建议一个站点固定一个 Profile，例如 `--profile github`、`--profile company-sso`。

## 登录持久化

登录和人机验证**始终由用户手动完成**。Agent 只负责打开页面、识别登录页、请用户在可见的 Chrome 中完成操作，然后轮询等待：

```bash
"$BROWSER" open "https://intranet.example.com" --profile intranet
"$BROWSER" wait-login --profile intranet --timeout 300000
```

登录/验证进行中时，CLI 会拦截 `click`、`fill`、`press`、`select`；`snapshot`、`query`、`console`、`network`、`screenshot`、`debug` 仍然可用。

Session cookie 没有 `Expires` 属性，Chrome 默认在重启后不会重新加载。需要跨重启保留登录时，为 Profile 开启会话恢复：

```bash
"$BROWSER" restore-session on --profile intranet
```

下次启动会用 `--restore-last-session` 拉起 Chrome；恢复出来的重复标签页会自动收敛为一个。该设置按 Profile 保存，并会停止一次 daemon，让下次 `open` 生效。

## 站点经验记忆

探索站点前先读经验：

```bash
"$BROWSER" experience show example.com
```

探索成功后，按 `references/experience-template.md` 写入 `~/.dsh/browser-operator/experiences/<domain>.md`，并校验格式：

```bash
"$BROWSER" experience validate example.com
```

一份好的经验文件应包含：入口 URL、搜索/结果/详情选择器、结果顺序规则、站点陷阱和验证记录，让下一个会话用少量命令完成同类任务。

## 浏览器指纹

每个 Profile 首次启动时生成一套指纹，保存在 `~/.dsh/browser-operator/profiles/<name>/settings.json`，之后跨刷新、重启、headless/headed 切换都不变。

- **UA**：按本机 Chrome 大版本生成 `Chrome/<major>.0.0.0`，headless 不出现 `HeadlessChrome`；同时记录运行中浏览器上报的完整版本，binary 查不到时作为回退。
- **navigator**：默认不注入，保持原生值（platform/vendor/languages 本身就和系统一致）；JS 覆盖会留下痕迹，改为可选。
- **WebGL**：默认使用真实 GPU（如 Apple M1 Pro）；`"spoof"` 可固定渲染器，`"off"` 可关闭 WebGL。
- **Canvas/Audio**：用 Profile 内固定 seed 加噪，指纹哈希跨会话稳定。
- **locale/timezone**：取系统设置（macOS 的 `zh-Hans_US` 归一化为 `zh-CN`）。
- **webdriver**：由 `--disable-blink-features=AutomationControlled` 保持 `false`。
- **DevTools 误报**：默认把 `console.table` 延迟执行（`devtoolsFix`），因为 CDP 序列化 console 参数会让基于耗时的 DevTools 检测器误判为打开了开发者工具。

```bash
"$BROWSER" fingerprint --profile example          # 查看
"$BROWSER" fingerprint --profile example --reset  # 重新生成（会停 daemon）
```

可在 `settings.json` 覆盖：`fingerprint.webgl`（默认 `auto`，可选 `spoof`/`off`）、`fingerprint.navigator`（默认 `false`）、`fingerprint.canvasNoise`、`fingerprint.audioNoise`、`fingerprint.devtoolsFix`（默认 `true`）、`userAgent`、`locale`、`timezone`。

## 常用命令

| 命令 | 用途 |
|---|---|
| `open <url> [--profile name] [--headed\|--headless] [--no-auto-headed] [--snapshot]` | 打开 URL；不传模式参数时保持当前模式 |
| `goto <url>` | 同 `open`，不返回 snapshot |
| `state` | 当前 URL、标题、标签页、登录/验证提示 |
| `snapshot [--mode interactive\|text\|full\|forms] [--selector CSS]` | 页面结构 + 推荐选择器 |
| `query <selector> [--limit N] [--html] [--all-attrs]` | 读取 DOM 节点（含非交互元素） |
| `click <selector> [--nth N] [--wait-for CSS] [--wait-nav]` | 真实鼠标点击并验证效果 |
| `fill <selector> <value> [--type] [--append]` | 填写输入框；`--type` 逐字输入 |
| `press <key>` | 发送按键 |
| `hover <selector>` | 真实鼠标悬停 |
| `select <selector> <value> [--label]` | 选择下拉项 |
| `wait <selector>` / `wait --url <pattern>` | 等待元素或 URL |
| `screenshot [path] [--full-page]` | 保存截图 |
| `switch --index N` / `switch --url includes` | 切换活动标签页 |
| `mode headed` / `mode headless` | 切换模式（会重启 Chrome） |
| `restore-session on\|off` | 跨浏览器重启保留 session cookie |
| `fingerprint [--reset]` | 查看 Profile 固定指纹；`--reset` 重新生成 |
| `wait-login [--timeout ms]` | 等待登录页消失 |
| `wait-verification [--timeout ms]` | 等待滑块/验证页消失 |
| `console` / `network` / `debug` | 诊断：日志、请求、截图、最近弹窗 |
| `close` / `stop` / `status` | 标签页与 daemon 生命周期 |
| `profiles` | 列出已知 Profile（不含敏感信息） |
| `experience list\|path\|show\|validate` | 站点经验操作 |

## 安全模型

- 账号密码只在用户可见的 Chrome 窗口中输入，CLI 不接收密码、OTP 或 cookie 值。
- CLI 不打印、不复制、不上传 `chrome-profile/`、cookie、`daemon.json` 或 daemon token。
- Profile、截图、经验文件都保存在 `~/.dsh/browser-operator/` 下，不会进入本仓库。
- 默认 headless；只有站点需要人工登录时才显示浏览器窗口。
- 无遥测；除你打开的页面外不发起其他网络请求。

## 项目结构

```text
bin/install.mjs
package.json
skills/browser-operator/
|-- SKILL.md
|-- bin/browser
|-- references/experience-template.md
`-- scripts/
    |-- browser.mjs
    |-- package.json
    `-- package-lock.json
```

## 校验

```bash
node --check skills/browser-operator/scripts/browser.mjs
node --check bin/install.mjs
"$HOME/.dsh/skills/browser-operator/bin/browser" experience validate example.com
```

## 打包预览

```bash
npm pack --dry-run
```

## 友情链接

- [LINUX DO](https://linux.do/) - 新的理想型社区，技术爱好者的聚集地。

## 许可证

MIT License，详见 [LICENSE](LICENSE)。
