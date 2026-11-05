# BrowserOperator 使用参考

这里收录安装选项、命令行操作、登录恢复、站点记录与配置说明。第一次使用请先阅读项目首页。

[项目首页](../../../README_CN.md) · [English](usage.md)

## 环境要求

- Node.js 20 及以上（当前锁定的 `playwright-core` 依赖要求）
- Google Chrome（或通过 `CHROME_PATH` 指定）
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

安装器会把 skill 复制到 `${DSH_HOME:-$HOME/.dsh}/skills/browser-operator`，安装 Node.js 依赖，并在 `${DSH_HOME:-$HOME/.dsh}/bin/browser-operator` 创建启动器。把该 `bin` 目录加入 `PATH` 后可以直接运行 `browser-operator`；使用 `--dest` 安装时以安装器打印的启动器路径为准。

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

每个 `--profile` 对应 `~/.dsh/browser-operator/profiles/<name>` 下的独立 Chrome Profile。建议一个站点固定一个 Profile，例如 `--profile github`、`--profile company-sso`。

## 登录持久化

登录默认由用户在可见 Chrome 中完成。Agent 打开页面并检查 `login`、`challenge` 和 `manualAuth`，需要人工处理时切到 headed；窗口没有出现在前台时执行 `focus`：

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

**用户明确要求代登录时**，`click`、`fill`、`press`、`select` 可加 `--allow-auth`。该参数仅对 `manualAuth.kind === "login"` 生效；滑块/CAPTCHA 仍需用户处理，`drag` / `eval` 也不会因此解除拦截。不要将凭据写入经验、操作脚本、日志或最终输出。

登录/验证检测采用页面特征判断；`wait-login` / `wait-verification` 成功表示相应提示消失，仍需用业务页面元素确认实际登录结果。

Session cookie 没有 `Expires` 属性，Chrome 默认在重启后不会重新加载。需要跨重启保留登录时，为 Profile 开启会话恢复：

```bash
"$BROWSER" restore-session on --profile intranet
```

下次启动会用 `--restore-last-session` 拉起 Chrome，并将恢复的标签页收敛为一个。该设置按 Profile 保存，并会停止一次 daemon，让下次 `open` 生效；服务端会话仍须有效。

`mode headed` / `mode headless` 会关闭并重启 Chrome，尝试恢复当前 URL。未开启会话恢复时，登录后可继续保持 headed。不带模式参数的 `open` / `goto` 保持当前模式，检测到需要人工登录/验证时仍可自动切到 headed；`--no-auto-headed` 可关闭这次自动切换。

## 站点经验记忆

探索站点前先读经验：

```bash
"$BROWSER" experience show example.com
```

如果 `open` 后发生重定向，用 `experience current` 按最终页面 host 读取经验：

```bash
"$BROWSER" experience current --profile example
```

探索成功后，按 [经验模板](experience-template.md) 写入 `~/.dsh/browser-operator/experiences/<domain>.md`，并校验格式：

```bash
"$BROWSER" experience validate example.com
```

一份好的经验文件应包含：入口 URL、搜索/结果/详情选择器、结果顺序规则、站点陷阱和异常兜底，让下一个会话用少量命令完成同类任务。`## 验证记录` 只保留日志路径，实际运行记录用 `log add` 追加。域名统一转小写并去掉开头的 `www.`，其他子域名保留。

同一应用有 dev/sit/uat/prod 多个环境时，建议加可选 frontmatter：

```yaml
app: my-admin              # 跨环境稳定的应用键
environment: uat
aliases: [my-admin.example.com, 127.0.0.1]
```

`experience show` / `experience current` 会返回 `related`，列出同 `app`、别名或去掉环境词后同域的经验；`experience related <domain>` 可显式查询。只复用结构，URL、账号、机构代号、OID 等环境值必须重新确认。

任务结束时，再用 `experience show <domain>` 复查已保存的经验（重定向后用 `experience current`）。有变化就更新并重新校验，再按下一节记录本次运行结果；没有新发现时也可以注明“无新增”。

## 验证日志

验证日志独立保存在 `~/.dsh/browser-operator/logs/<domain>/log.md`，固定格式为 `- YYYY-MM-DD HH:mm | 任务 | ok/failed/partial | 备注`，每次运行追加一行：

```bash
"$BROWSER" log add example.com "读取页面标题" --result ok --note "无新增"
"$BROWSER" log show example.com --limit 10
"$BROWSER" log list
```

`--result` 必须使用 `ok`、`failed` 或 `partial`，按实际结果填写。新日志会自动创建，但 `log add` 不会自动迁移旧经验里的历史记录；迁移时须保留原记录，并将经验的 `## 验证记录` 改为日志路径指针。

## 操作脚本（recipe）

经验记录站点结构，操作脚本保存可重放的步骤。按 [操作脚本模板](recipe-template.md) 创建 `~/.dsh/browser-operator/脚本/<domain>.md`，每个任务一个 `##` 段落。同一任务第 3 次稳定完成后，由 Agent 写入 `steps` 代码块，动态内容使用 `{{name}}` 占位符。

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
- `--profile` 可写在步骤或 frontmatter；运行时的 `--profile` 会注入未指定 Profile 的步骤，已显式指定的步骤保持原值。
- 不在脚本中保存凭据或 `--allow-auth`。用户本次明确授权代登录时，才在 `recipe run` 上加 `--allow-auth`；该授权只传给 `click` / `fill` / `press` / `select`。
- 失败返回 `failedStep`，并尝试附带 `screenshot`；页面保留现场，可用同一 Profile 接管，修正步骤后再验证。
- `recipe run` 不会自动录制/修正脚本、增加次数或写入验证日志；这些由 Agent 分别完成。

## 数据目录与配置

| 配置 | 用途 |
|---|---|
| `CHROME_PATH` | 指定 Chrome 可执行文件 |
| `DSH_HOME` | 安装器的默认根目录，默认 `~/.dsh`；影响 Skill 和启动器位置 |
| `BROWSER_OPERATOR_HOME` | CLI 的运行数据根目录，默认 `~/.dsh/browser-operator`；不随 `DSH_HOME` 或 `--dest` 自动改变 |

下文路径均指默认运行数据根目录：

```text
~/.dsh/browser-operator/
|-- profiles/<name>/       # Chrome Profile、settings.json、daemon 日志
|-- screenshots/           # 截图与错误现场
|-- experiences/<domain>.md
|-- logs/<domain>/log.md
`-- 脚本/<domain>.md
```

每个 Profile 对应一个本地 daemon，默认空闲 30 分钟后退出；启动时可用 `--idle-minutes` 调整。

## 浏览器指纹

每个 Profile 首次启动时生成一套指纹，保存在 `~/.dsh/browser-operator/profiles/<name>/settings.json`，之后跨刷新、重启、headless/headed 切换都不变。

- **UA/UA-CH**：有头和无头注入**完全相同的一套身份**（真实 Chrome 大版本 + 宿主 architecture/platformVersion/bitness），切换模式指纹不变；默认全程无头。
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

不要在已登录的站点随意重置指纹；换到不同操作系统时会自动重建，Chrome 更新也会改变 UA 版本。

可在 `settings.json` 覆盖：`fingerprint.webgl`（默认 `auto`，可选 `spoof`/`off`）、`fingerprint.navigator`（默认 `false`）、`fingerprint.canvasNoise`、`fingerprint.audioNoise`、`fingerprint.devtoolsFix`（默认 `true`）、`userAgent`、`locale`、`timezone`。

## 常用命令

| 命令 | 用途 |
|---|---|
| `open <url> [--profile name] [--headed\|--headless] [--no-auto-headed] [--snapshot]` | 打开 URL；不传模式参数时保持当前模式 |
| `goto <url>` | `open` 的别名，支持相同参数 |
| `state` | 当前 URL、标题、标签页、登录/验证提示 |
| `snapshot [--mode interactive\|text\|full\|forms] [--selector CSS]` | 页面结构 + 推荐选择器 |
| `query <selector> [--limit N] [--html] [--all-attrs]` | 读取 DOM 节点（含非交互元素） |
| `click <selector> [--nth N] [--wait-for CSS] [--wait-nav]` | 真实鼠标点击并验证效果 |
| `drag <source> <target> [--nth N] [--target-nth N] [--steps N] [--method auto\|dragTo\|mouse\|js]` | 真实拖拽；auto 先真实鼠标再 dragTo；`js` 需 `--allow-js` |
| `eval <expression>` | 显式 JS 逃生口，用于页面自定义处理器；不绕过登录/验证 |
| `fill <selector> <value> [--type] [--append]` | 填写输入框；`--type` 逐字输入 |
| `press <key>` | 发送按键 |
| `hover <selector>` | 真实鼠标悬停 |
| `select <selector> <value> [--label]` | 选择下拉项 |
| `wait <selector>` / `wait --url <pattern>` | 等待元素或 URL |
| `screenshot [path] [--full-page]` | 保存截图 |
| `switch --index N` / `switch --url includes` | 切换活动标签页 |
| `mode headed` / `mode headless` | 切换模式（会重启 Chrome）；也可直接用 `headed` / `headless` |
| `focus` | 将有头 Chrome 窗口带到前台 |
| `dialog accept [--text value]` / `dialog dismiss` / `dialog status` | 弹窗策略；默认取消 |
| `restore-session on\|off` | 跨浏览器重启保留 session cookie |
| `fingerprint [--reset]` | 查看 Profile 固定指纹；`--reset` 重新生成 |
| `wait-login [--timeout ms]` | 等待登录页消失 |
| `wait-verification [--timeout ms]` | 等待滑块/验证页消失 |
| `console` / `network` / `debug` | 诊断：日志、请求、截图、最近弹窗 |
| `close` / `stop` / `status` | 关闭当前标签页（至少保留一个）/停止浏览器/查看状态（不启动 daemon） |
| `profiles` | 列出已知 Profile（不含敏感信息） |
| `experience list\|path\|show\|related\|validate\|current` | 站点经验操作；`related` 查找同应用的其他环境，`current` 解析当前页面 host |
| `log add <domain> "任务" --result ok\|failed\|partial [--note text]` | 追加一行验证日志 |
| `log show <domain> [--limit N]` / `log list` | 查看域名日志/列出所有日志 |
| `recipe list [filter]` / `recipe show <domain> [task]` | 查看操作脚本与任务 |
| `recipe log <domain> <task>` | 累计任务次数，更新最近日期 |
| `recipe run <domain> <task> [--var k=v]... [--dry-run] [--profile name] [--allow-auth]` | 校验或重放任务；代登录需本次明确授权 |

`click`、`fill`、`press`、`select` 支持 `--allow-auth`，使用条件见“登录持久化”。`snapshot`、`query`、`click`、`drag`、`fill`、`hover`、`select` 和按元素等待的 `wait` 支持 `--frame CSS`。`--nth` / `--target-nth` 从 1 开始，`switch --index` 从 0 开始。

业务命令返回 JSON；`ok:false` 表示失败，`ok:true` 时仍需检查 `warning`、`effect` 和业务成功条件。浏览器操作抛出异常时会尝试附带 `error.screenshot`、`error.recentConsole`、`error.recentNetwork`，参数校验失败或浏览器未启动时不保证有截图。

`click` 默认发送真实鼠标输入；显式加 `--js` 才改用 DOM 点击，此时返回 `trusted:false`。两种方式都需要检查实际页面结果，不能仅凭命令执行结束判断业务成功。

## 安全模型

- 默认由用户在可见 Chrome 中输入凭据。用户在当前对话明确要求代登录时，Agent 只使用用户主动提供的凭据，并对相关命令显式加 `--allow-auth`；不读取、导出或分享 cookie。
- CLI 不打印、不复制、不上传 `chrome-profile/`、cookie、`daemon.json` 或 daemon token。
- Profile、默认截图、经验、日志和操作脚本保存在运行数据根目录；不要将这些本地数据提交到仓库。`screenshot [path]` 可显式指定其他位置。
- 默认 headless；检测到登录/验证可自动切到 headed，也可显式使用 `--headed` / `mode headed`。
- 弹窗默认取消；确认前先显式设置 `dialog accept`，操作后用 `dialog dismiss` 恢复。策略在当前 daemon 内持续生效（模式切换也保留），重启 daemon 后恢复默认取消。
- `eval` 是显式 JavaScript 逃生口，用于页面自定义处理器；登录/验证页面会被拦截，不能用来绕过人工登录。
- 无遥测；除你打开的页面外不发起其他网络请求。

## 项目结构

```text
bin/install.mjs
package.json
skills/browser-operator/
|-- SKILL.md
|-- bin/browser
|-- references/
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
