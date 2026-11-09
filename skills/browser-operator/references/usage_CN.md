# BrowserOperator 使用参考

这里说明怎样安装、执行命令、恢复登录、保存站点经验和修改配置。第一次使用请先阅读项目首页。

[项目首页](../../../README_CN.md) · [English](usage.md)

## 环境要求

- Node.js 20 及以上，当前锁定的 `playwright-core` 依赖需要这个版本。
- Google Chrome；可以通过 `CHROME_PATH` 指定可执行文件的位置。
- npm
- macOS、Linux 或 Windows；`bin/browser` 是 Bash 脚本，Windows 启动器也通过 Bash 执行，需安装 Git Bash 等环境。无 Bash 时可直接运行 `node <安装目录>/scripts/browser.mjs ...`。

下文命令示例使用 Bash。

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

安装器会把 Skill 复制到 `${DSH_HOME:-$HOME/.dsh}/skills/browser-operator`，安装 Node.js 依赖，并在 `${DSH_HOME:-$HOME/.dsh}/bin/browser-operator` 创建启动器。

把该 `bin` 目录加入 `PATH` 后，可以直接运行 `browser-operator`。使用 `--dest` 安装时，启动器的位置以安装器打印的路径为准。

安装到其他 Agent 的 Skill 目录（`--dest` 指向父目录，安装器会在其中创建 `browser-operator/`）：

```bash
npx --yes github:LearnAIHubC/BrowserOperator --dest "$HOME/my-agent/skills"
```

安装器还支持 `--no-bin`（不创建启动器）和 `--help`。`npx` 入口负责安装，浏览器操作使用安装后的 `bin/browser` 或 `browser-operator` 启动器。

手动安装：

```bash
git clone https://github.com/LearnAIHubC/BrowserOperator.git /tmp/BrowserOperator
mkdir -p "$HOME/.dsh/skills"
cp -R /tmp/BrowserOperator/skills/browser-operator "$HOME/.dsh/skills/browser-operator"
npm install --prefix "$HOME/.dsh/skills/browser-operator/scripts"
```

## 快速开始

```bash
BROWSER="$HOME/.dsh/skills/browser-operator/bin/browser"

# 先查看已有站点经验
"$BROWSER" experience show example.com

# 用命名 Profile 打开站点（默认 headless）
"$BROWSER" open "https://example.com" --profile example

# 查看可点击元素，并拿到可直接复制的选择器
"$BROWSER" snapshot --mode interactive --profile example

# 读取页面标题元素
"$BROWSER" query "h1" --profile example

# 截图
"$BROWSER" screenshot --profile example --full-page

# 完成后关闭浏览器，保存 Profile
"$BROWSER" stop --profile example
```

每个 `--profile` 对应一份独立的 Chrome 浏览器资料，保存在 `~/.dsh/browser-operator/profiles/<name>`。建议一个站点固定使用一个 Profile，例如 `--profile github` 或 `--profile company-sso`。

## 登录持久化

默认由用户在可见的 Chrome 窗口中登录。Agent 打开页面后，检查 `login`、`challenge` 和 `manualAuth`，需要用户操作时切到可见窗口模式（headed）。如果窗口被其他应用挡住，执行 `focus` 将它带到前台：

```bash
# 需要跨重启恢复会话 cookie 时，建议在登录前开启（此命令会停止已有 daemon）
"$BROWSER" restore-session on --profile intranet
"$BROWSER" open "https://intranet.example.com" --profile intranet
"$BROWSER" focus --profile intranet
"$BROWSER" wait-login --profile intranet --timeout 300000
# 如果出现滑块/CAPTCHA，用户完成后用 wait-verification 等待验证页消失
"$BROWSER" wait-verification --profile intranet --timeout 120000
```

登录/验证进行中时，CLI 默认拦截 `click`、`drag`、`eval`、`fill`、`press`、`select`；`snapshot`、`query`、`console`、`network`、`screenshot`、`debug` 仍然可用。

只有用户明确要求代登录时，`click`、`fill`、`press`、`select` 才能加 `--allow-auth`。该参数仅对 `manualAuth.kind === "login"` 生效，`drag` 和 `eval` 仍会被拦截。滑块和 CAPTCHA 始终由用户完成。不要将凭据写入经验、操作脚本、日志或最终答复。

工具根据页面特征判断是否需要登录或验证。`wait-login` 或 `wait-verification` 成功，只表示相应提示已经消失；还需要检查登录后的页面元素，确认实际结果。

Session cookie 没有 `Expires` 属性，Chrome 默认在重启后不会重新加载。需要跨重启保留登录时，为 Profile 开启会话恢复：

```bash
"$BROWSER" restore-session on --profile intranet
```

下次启动时，会用 `--restore-last-session` 打开 Chrome，并只保留一个恢复的标签页。设置按 Profile 保存；执行命令时会停止后台进程（daemon），在下次 `open` 时生效。能否继续登录，还取决于服务端会话是否有效。

`mode headed` 和 `mode headless` 会关闭并重启 Chrome，尝试恢复当前 URL。未开启会话恢复时，登录后可以继续保持 headed，避免切换模式丢失会话 Cookie。

不带模式参数的 `open` 或 `goto` 会保持当前模式；检测到需要用户登录或验证时，仍可自动切到 headed。加 `--no-auto-headed` 可以关闭本次导航的自动切换。

## 页面标注

需要向 Agent 指明页面上的某一块内容时，可以在可见浏览器中点击右下角的“圈选标注”，再拖出矩形框。Agent 用 `annotate read` 读取对应的 DOM 元素、文字、CSS 选择器、元素边界 `rect` 和中心点 `center`，不需要截图。

```bash
# 用户需要标注时，开启入口并将窗口带到前台
"$BROWSER" annotate start --profile example
"$BROWSER" focus --profile example

# 用户框选后读取内容；坐标为视口内的 CSS 像素
"$BROWSER" annotate read --profile example

# 也可以等待用户框选后再读取
"$BROWSER" annotate wait --profile example --timeout 150000
```

`annotate wait` 会先开启标注，再等待用户框选。这两个开启入口的命令在 headless 模式下都会切到 headed，因此会重启 Chrome。需要保留会话 Cookie 时，按前面的“登录持久化”说明，在登录前开启会话恢复。

每个框右上角的 × 只删除该框。“清空标注”会清空所有框并退出绘制，保留入口；Esc 只退出本次绘制。用户要求关闭标注时，执行 `annotate cancel --profile example`。

标注默认开启，开关保存在 `~/.dsh/browser-operator/config.json` 的 `annotationEnabled` 中，所有 Profile 共用。`annotate start` 开启，`annotate cancel` 关闭；导航和重启后仍按保存的设置显示。设置了 `BROWSER_OPERATOR_HOME` 时，配置位于该目录下。读取到的标注记录保存在运行数据目录的 `annotations/` 中。

## 保存和复用站点经验

探索站点前先读经验：

```bash
"$BROWSER" experience show example.com
```

如果 `open` 后发生重定向，用 `experience current` 按最终页面的主机名读取经验：

```bash
"$BROWSER" experience current --profile example
```

探索成功后，按 [经验模板](experience-template.md) 写入 `~/.dsh/browser-operator/experiences/<domain>.md`，并校验格式：

```bash
"$BROWSER" experience validate example.com
```

经验文件应写清入口 URL，搜索、结果和详情的选择器，结果排列顺序，以及容易出错的地方和处理方法，让下一个会话用少量命令完成同类任务。`## 验证记录` 只保留日志路径，实际运行结果用 `log add` 记录。

保存时，域名统一转为小写，去掉开头的 `www.`，其他子域名保留。

同一应用有 dev/sit/uat/prod 多个环境时，建议加可选 frontmatter：

```yaml
app: my-admin              # 跨环境稳定的应用键
environment: uat
aliases: [my-admin.example.com, 127.0.0.1]
```

`experience show` 和 `experience current` 返回的 `related` 会列出相关经验，包括同一 `app`、域名别名，或去掉环境词后域名相同的记录。也可以用 `experience related <domain>` 单独查询。

参考其他环境的经验时，只复用页面结构；URL、账号、机构代号和 OID 等必须按当前环境重新确认。

任务结束时，再用 `experience show <domain>` 复查已保存的经验（重定向后用 `experience current`）。有变化就更新并重新校验，再按下一节记录本次运行结果；没有新发现时也可以注明“无新增”。

## 验证日志

验证日志独立保存在 `~/.dsh/browser-operator/logs/<domain>/log.md`，固定格式为 `- YYYY-MM-DD HH:mm | 任务 | ok/failed/partial | 备注`，每次运行追加一行：

```bash
"$BROWSER" log add example.com "读取页面标题" --result ok --note "无新增"
"$BROWSER" log show example.com --limit 10
"$BROWSER" log list
```

`--result` 必须按实际结果填写 `ok`、`failed` 或 `partial`。日志文件不存在时会自动创建，但 `log add` 不会自动迁移旧经验里的历史记录。迁移时要保留原记录，再将经验文件的 `## 验证记录` 改为日志路径。

## 操作脚本（recipe）

经验文件记录站点结构，操作脚本保存可以重复执行的步骤。按[操作脚本模板](recipe-template.md)创建 `~/.dsh/browser-operator/脚本/<domain>.md`，每个任务用一个 `##` 小节。同一任务第 3 次成功完成后，由 Agent 将验证过的步骤写入 `steps` 代码块，动态内容使用 `{{name}}` 占位符。

```bash
# 检查已有脚本；文件和任务段落需先按模板创建
"$BROWSER" recipe show example.com "搜索并读取结果"

# 参数与命令校验，不打开浏览器、不执行步骤
"$BROWSER" recipe run example.com "搜索并读取结果" --var query="示例关键词" --dry-run

# 模板中的选择器替换为真实站点选择器后再执行
"$BROWSER" recipe run example.com "搜索并读取结果" --var query="示例关键词" --profile example

# 每次任务成功后累计次数，并另行追加验证日志
"$BROWSER" recipe log example.com "搜索并读取结果"
"$BROWSER" recipe list
```

- `steps` 每行一个 CLI 子命令，不写 `browser` 前缀，也不执行任意 Shell 脚本。
- `--profile` 可以写在步骤或文件开头的 YAML 信息（frontmatter）中。运行时指定的 `--profile` 会传给未指定 Profile 的步骤；步骤已经指定的值保持不变。
- 不在脚本中保存凭据或 `--allow-auth`。用户本次明确授权代登录时，才在 `recipe run` 上加 `--allow-auth`；该授权只传给 `click` / `fill` / `press` / `select`。
- 失败时返回 `failedStep`，并尝试附带 `screenshot`。当前页面会保留，可以用同一 Profile 继续操作，修正步骤后再验证。
- `recipe run` 只负责执行步骤。编写或修正脚本、累计次数、写入验证日志，都需要由 Agent 另行完成。

## 数据目录与配置

| 配置 | 用途 |
|---|---|
| `CHROME_PATH` | 指定 Chrome 可执行文件 |
| `DSH_HOME` | 安装器的默认根目录，默认 `~/.dsh`；影响 Skill 和启动器位置 |
| `BROWSER_OPERATOR_HOME` | CLI 的运行数据根目录，默认 `~/.dsh/browser-operator`；不随 `DSH_HOME` 或 `--dest` 自动改变 |

下文路径均指默认运行数据根目录：

```text
~/.dsh/browser-operator/
|-- config.json            # 所有 Profile 共用的标注开关
|-- profiles/<name>/       # Chrome Profile、settings.json、daemon 日志
|-- screenshots/           # 截图与错误现场
|-- annotations/           # 读取到的标注记录（JSON）
|-- experiences/<domain>.md
|-- logs/<domain>/log.md
`-- 脚本/<domain>.md
```

每个 Profile 对应一个本地 daemon，默认空闲 30 分钟后退出；启动时可用 `--idle-minutes` 调整。

## 浏览器指纹

每个 Profile 在首次启动时生成浏览器指纹，保存在 `~/.dsh/browser-operator/profiles/<name>/settings.json`。刷新页面、重启浏览器，或在无界面模式（headless）与可见窗口模式（headed）之间切换时，指纹保持不变。

- **UA/UA-CH**：两种模式使用相同的浏览器身份。Chrome 大版本取实际安装的版本，`architecture`、`platformVersion` 和 `bitness` 取当前系统的值；默认使用 headless。
- **navigator**：默认保留原生值，`platform`、`vendor`、`languages` 本身就与系统一致。用 JavaScript 修改这些值可能被站点检测到，因此需要显式开启。
- **WebGL**：默认使用真实 GPU（如 Apple M1 Pro）；`"spoof"` 可固定渲染器，`"off"` 可关闭 WebGL。
- **Canvas/Audio**：使用 Profile 内固定的随机种子添加噪声，使指纹哈希在不同会话中保持稳定。
- **locale/timezone**：使用系统设置，macOS 的 `zh-Hans_US` 会转换为 `zh-CN`。
- **webdriver**：由 `--disable-blink-features=AutomationControlled` 保持 `false`。
- **DevTools 误报**：默认延迟执行 `console.table`（`devtoolsFix`）。CDP 序列化 Console 参数需要时间，一些站点会根据这段耗时误判为打开了开发者工具；这项设置用于减少此类误报。

```bash
"$BROWSER" fingerprint --profile example          # 查看
"$BROWSER" fingerprint --profile example --reset  # 重新生成（会停 daemon）
```

不要在已登录的站点随意重置指纹；换到不同操作系统时会自动重建，Chrome 更新也会改变 UA 版本。

可在 `settings.json` 覆盖：`fingerprint.webgl`（默认 `auto`，可选 `spoof`/`off`）、`fingerprint.navigator`（默认 `false`）、`fingerprint.canvasNoise`、`fingerprint.audioNoise`、`fingerprint.devtoolsFix`（默认 `true`）、`userAgent`、`locale`、`timezone`。

## 常用命令

| 命令 | 用途 |
|---|---|
| `open <url> [--profile name] [--headed\|--headless] [--no-auto-headed] [--snapshot]` | 打开 URL；不传模式参数时保持当前模式 |
| `goto <url>` | `open` 的别名，支持相同参数 |
| `state` | 当前 URL、标题、标签页、登录/验证提示 |
| `snapshot [--mode interactive\|text\|full\|forms] [--selector CSS]` | 查看页面结构和推荐选择器 |
| `query <selector> [--limit N] [--html] [--all-attrs]` | 读取 DOM 节点（含非交互元素） |
| `click <selector> [--nth N] [--wait-for CSS] [--wait-nav]` | 发送真实鼠标点击并报告页面变化 |
| `drag <source> <target> [--nth N] [--target-nth N] [--steps N] [--method auto\|dragTo\|mouse\|js]` | 拖拽元素；auto 先尝试真实鼠标，再尝试 `dragTo`；`js` 需加 `--allow-js` |
| `eval <expression>` | 用 JavaScript 调用页面自定义处理器；不能绕过登录或验证 |
| `fill <selector> <value> [--type] [--append]` | 填写输入框；`--type` 逐字输入 |
| `press <key>` | 发送按键 |
| `hover <selector>` | 真实鼠标悬停 |
| `select <selector> <value> [--label]` | 选择下拉项 |
| `wait <selector>` / `wait --url <pattern>` | 等待元素或 URL |
| `screenshot [path] [--full-page]` | 保存截图 |
| `annotate start\|read\|wait\|cancel [--timeout ms]` | 开启、读取、等待或关闭页面标注；开关会保存 |
| `switch --index N` / `switch --url includes` | 切换活动标签页 |
| `mode headed` / `mode headless` | 切换模式（会重启 Chrome）；也可直接用 `headed` / `headless` |
| `focus` | 将有头 Chrome 窗口带到前台 |
| `dialog accept [--text value]` / `dialog dismiss` / `dialog status` | 弹窗策略；默认取消 |
| `restore-session on\|off` | 设置是否在浏览器重启后恢复会话 Cookie |
| `fingerprint [--reset]` | 查看 Profile 固定指纹；`--reset` 重新生成 |
| `wait-login [--timeout ms]` | 等待登录页消失 |
| `wait-verification [--timeout ms]` | 等待滑块/验证页消失 |
| `console` / `network` / `debug` | 查看日志、请求、截图和最近弹窗，帮助排查问题 |
| `close` / `stop` / `status` | 关闭当前标签页（至少保留一个）/停止浏览器/查看状态（不启动 daemon） |
| `profiles` | 列出已知 Profile（不含敏感信息） |
| `experience list\|path\|show\|related\|validate\|current` | 站点经验操作；`related` 查找同应用的其他环境，`current` 解析当前页面 host |
| `log add <domain> "任务" --result ok\|failed\|partial [--note text]` | 追加一行验证日志 |
| `log show <domain> [--limit N]` / `log list` | 查看域名日志/列出所有日志 |
| `recipe list [filter]` / `recipe show <domain> [task]` | 查看操作脚本与任务 |
| `recipe log <domain> <task>` | 累计任务次数，更新最近日期 |
| `recipe run <domain> <task> [--var k=v]... [--dry-run] [--profile name] [--allow-auth]` | 校验或重放任务；代登录需本次明确授权 |

`click`、`fill`、`press`、`select` 支持 `--allow-auth`，使用条件见“登录持久化”。`snapshot`、`query`、`click`、`drag`、`fill`、`hover`、`select` 和按元素等待的 `wait` 支持 `--frame CSS`。`--nth` / `--target-nth` 从 1 开始，`switch --index` 从 0 开始。

操作命令返回 JSON。`ok:false` 表示失败；`ok:true` 时，仍需检查 `warning`、`effect` 和实际结果是否符合预期。浏览器操作抛出异常时，会尝试附带 `error.screenshot`、`error.recentConsole` 和 `error.recentNetwork`；参数校验失败或浏览器未启动时，可能没有截图。

`click` 默认发送真实鼠标输入；显式加 `--js` 才改用 DOM 点击，此时返回 `trusted:false`。两种方式都需要检查实际页面结果，不能仅凭命令执行结束判断业务成功。

## 安全模型

- 默认由用户在可见 Chrome 中输入凭据。用户在当前对话明确要求代登录时，Agent 只使用用户主动提供的凭据，并对相关命令显式加 `--allow-auth`；不读取、导出或分享 cookie。
- CLI 不打印、不复制、不上传 `chrome-profile/`、cookie、`daemon.json` 或 daemon token。
- Profile、默认截图、经验、日志和操作脚本保存在运行数据根目录；不要将这些本地数据提交到仓库。`screenshot [path]` 可显式指定其他位置。
- 默认 headless；检测到登录/验证可自动切到 headed，也可显式使用 `--headed` / `mode headed`。
- 弹窗默认取消；确认前先显式设置 `dialog accept`，操作后用 `dialog dismiss` 恢复。策略在当前 daemon 内持续生效（模式切换也保留），重启 daemon 后恢复默认取消。
- `eval` 用于通过 JavaScript 调用页面自定义处理器。它在登录和验证页面会被拦截，不能用来绕过人工登录。
- 无遥测；除你打开的页面外不发起其他网络请求。

## 项目结构

```text
bin/install.mjs
package.json
skills/browser-operator/
|-- SKILL.md
|-- bin/browser
|-- references/
|   |-- assets/
|   |-- experience-template.md
|   |-- recipe-template.md
|   |-- usage.md
|   `-- usage_CN.md
`-- scripts/
    |-- browser.mjs
    |-- package.json
    `-- package-lock.json
```

## 校验

```bash
node --check skills/browser-operator/scripts/browser.mjs
node --check bin/install.mjs
# 安装脚本依赖后，可直接使用仓库内 CLI（无参数会输出用法并以状态码 2 退出）
npm ci --prefix skills/browser-operator/scripts
node skills/browser-operator/scripts/browser.mjs

# 已按模板创建经验/脚本后再校验
BROWSER="$PWD/skills/browser-operator/bin/browser"
"$BROWSER" experience validate example.com
"$BROWSER" recipe run example.com "搜索并读取结果" --var query="示例关键词" --dry-run
```

## 打包预览

```bash
npm pack --dry-run
```

## 许可证

MIT License，详见 [LICENSE](../../../LICENSE)。
