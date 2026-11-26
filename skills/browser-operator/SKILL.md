---
name: browser-operator
description: "Persistent Chrome automation for real mouse clicks: headless by default, with dynamic headed switching when the user must log in or complete verification. Manual-auth policy: by default the user performs login and verification in the visible browser; the agent types credentials or clicks login only when the user explicitly asks for it in the conversation, and then must pass --allow-auth. Sliders/CAPTCHA are never solved by the agent. Use for opening sites, reusing existing sessions, snapshots, clicks, hover, forms, iframes, screenshots, console/network debugging. Dialogs are never auto-handled: they stay open until the agent accepts or dismisses them. It reads a saved per-site experience before exploring and writes a reusable experience md after a successful run. It also keeps per-site task scripts under 脚本/: parameterized JS files made of named steps, run with recipe run and resumable from the step where they stopped; run recipe show before exploring a site. Profiles keep cookies/localStorage. Triggers include 浏览器点击, 打开网站, 登录网站, 保存登录, 保持登录, 帮我登录, 操作脚本, 一键执行, real click, browser automation."
---

# Browser Operator

Use this skill for **all** browser click/automation work. Do not write one-off Playwright/CDP scripts, and do not use `el.click()` / DOM events as the default path. The bundled CLI owns a persistent Chrome profile and a local daemon, so login state survives between commands and between sessions.

## 标注入口与持久配置

- 标注按钮是否出现，统一读取 skill 配置 `~/.dsh/browser-operator/config.json` 的 `annotationEnabled` 布尔值；设置 `BROWSER_OPERATOR_HOME` 时，配置位于该目录的 `config.json`。没有配置时默认开启，所有 profile 共用。
- 开启时，打开、刷新或跳转页面都会自动显示右下角按钮。默认只显示入口，用户点击后按钮立即显示“请选择”，再拖出矩形框；记录后按钮显示“清空标注”。
- 用户明确说“关闭标注”时，执行 `annotate cancel --profile <profile>`：写入 `annotationEnabled: false` 并移除当前浏览器各标签页的标注。后续页面和浏览器重启后都不再出现入口。
- 用户明确说“开启标注”“需要标注”时，执行 `annotate start --profile <profile>`：写入 `annotationEnabled: true` 并恢复入口，以后自动显示。不要在普通打开页面或任务收尾时反复运行 start/cancel 覆盖用户的配置。
- 每个框的右上角 × 单独删除该框；“清空标注”清空所有框并退出绘制，保留按钮，也不改变持久配置。Esc 退出本次绘制。
- 用户要求查看框选内容时，执行 `annotate read --profile <profile>`，直接读取 DOM 元素、文字、唯一 CSS 选择器、元素边界 `rect` 和中心点 `center`，不截图。坐标为页面可见区域内的 CSS 像素，`coordinateSpace: viewport`。


## 登录与验证：默认交给用户，用户明确授权后才可代操作

**默认行为（用户没明确让你登录时）**——登录和验证一律由用户在可见浏览器完成：

- **不要**输入用户名、密码、手机号、OTP 或任何凭据。
- **不要**点击 登录 / 注册 / 登录/注册 / 发送验证码 / 扫码登录 / Sign in / Log in / Continue with ...，也不要提交登录表单。
- **不要**解决或交互滑块、CAPTCHA、「访问验证」「滑动验证」「人机验证」，也不要重试它们。
- agent 只负责：打开页面、报告 `login.likely` / `challenge.likely` / `manualAuth`、按需切到 headed、用 `wait-login` / `wait-verification` 轮询。
- `manualAuth.required` 为 true 时，`click` / `drag` / `eval` / `fill` / `press` / `select` 默认会以 `manual-auth-required` 失败。此时用 `snapshot`、`query`、`console`、`network`、`screenshot`、`debug` 观察，并请用户在可见窗口完成。

**例外：用户明确要求由你登录时才有输入权**——仅当用户在本次对话里直接说「你帮我输入账号密码登录」「用这组账号登进去」「帮我点登录」这类明确指令时：

- 才对登录页执行 `fill` / `click` / `press`，并且**必须**加 `--allow-auth`：
  ```bash
  "$BROWSER" fill "#username" "<用户提供的账号>" --allow-auth --profile mysite
  "$BROWSER" fill "#password" "<用户提供的密码>" --allow-auth --profile mysite
  "$BROWSER" click "#btnLoginNow" --allow-auth --profile mysite --wait-nav
  ```
- 只用用户在对话里给出的凭据；不要从文件、历史记录、其他站点猜测或复用。
- 不要把凭据写进经验文件、日志、截图说明或最终答复；结果只描述成功/失败。
- `--allow-auth` 只对 `manualAuth.kind === "login"` 生效。页面出现滑块/CAPTCHA（`kind: "verification"`）时仍会被拦截，必须由用户完成。
- 用户只是说「打开看看」「试试看」，没有明确要你代登录时，走默认行为，不要自行升级成代登录。

**任何情况下都不要**用 `--js`、`--force`、直接 DOM 调用或其他脚本去绕过登录/验证拦截。


## 经验记忆（强制，先读后写）

这个 skill 不只是浏览器，还要把每次探索沉淀成可复用的经验，避免新会话重新摸索。

**固定位置**：`~/.dsh/browser-operator/experiences/<canonical-domain>.md`
（例如 `www.baidu.com` → `baidu.com.md`；子域名保留，只去掉开头的 `www.`）

**每次任务开始前**：先 `"$BROWSER" recipe show <domain>`（见「操作脚本」一节）。有对得上的脚本就直接跑，不用读经验；没有对得上的，再读经验：

```bash
"$BROWSER" experience show <domain-or-url>
```

- `found:true`：先按 `content` 里的“快速路径/选择器/陷阱”执行，不要从头探索。
- `found:false`：先看返回的 `related`。如果有同 `app` 或同域归一化的其他环境经验（dev/sit/uat/prod），先读最接近的环境并只复用结构，URL、账号、机构代号、数据对象 OID 等环境值必须重新确认；没有 `related` 才从头探索。
- `related` 里的 `match` 是 `app`（同应用）、`alias`（别名）或 `normalized-domain`（去掉 dev/sit/uat/prod 等环境词后同域）。
- 如果 `open` 后发生重定向（例如 127.0.0.1 → localhost、http → https、裸域 → www），用 `experience current` 按最终 `state.url` 的 host 再查一次；localhost/127.0.0.1 建议两个都查。
- 经验过期或页面改版：更新文件，并用 `log add` 记录变化。

**探索成功后必须写/更新经验**（用 `write` 工具写文件，不要只留在对话里）：

- 先读模板：`references/experience-template.md`
- 写入固定路径：`~/.dsh/browser-operator/experiences/<domain>.md`
- 必须包含 YAML frontmatter：`site`、`domain`、`updated`、`confidence`
- 同一应用有多个环境/域名时，建议加 `app`、`environment`、`aliases`：
  - `app`：跨环境稳定的应用键（如 `my-admin`），不要带环境名
  - `environment`：`local|dev|sit|test|stage|uat|prod|other`
  - `aliases`：同应用的其他域名（含 `127.0.0.1` 这类别名）
- 必须包含章节：`## 快速路径`、`## 选择器`、`## 结果读取`、`## 陷阱`、`## 空页面/异常兜底`、`## 验证记录`
- 写“下一个会话能直接照做”的信息：入口 URL 模板、搜索框/按钮选择器、结果条目选择器、按第 N 个结果点击的规则、详情读取方式、广告/懒加载/新标签页等陷阱。
- 不写 cookies、token、密码、手机号、完整个人数据；只写站点结构和选择器。
- 写完用 `"$BROWSER" experience validate <domain>` 校验格式。
- 查询同应用其他环境：`"$BROWSER" experience related <domain>`；`experience show` / `experience current` 也会返回 `related` 列表。

**任务收尾检查（强制，给最终答复前）**：

脚本一次跑成功的任务（`recipe run` 返回 `ok:true`，中途没有手动接管）不用做下面的检查，次数和日志已经自动记好。手动做的、或脚本停下后手动接管的，照做：

1. 再执行一次 `"$BROWSER" experience show <domain>`；如果本次页面发生过重定向，用 `"$BROWSER" experience current` 以最终 host 复查。
2. 对照本次操作，确认是否出现新的入口 URL、选择器、结果读取方式、失败兜底或陷阱。
3. 有新增/变化：更新经验文件，再执行 `experience validate <domain>`。
4. 无论有没有变化，都用日志命令记一条本次运行：`"$BROWSER" log add <domain> "<任务>" --result ok|failed|partial --task <任务名> --note "<结果/备注>"`（无新增也记 `ok` + “无新增”，证明已检查）。`--task <任务名>` 和 `--one-off` 必须带一个，见「操作脚本」的「收尾」；返回里的 `hint` 说到该写脚本了，就在这次收尾里写。
5. 未完成以上检查，不得给最终答复。

这一步是硬性收尾条件。经验文件的价值在于“下一次只看 md 就能照做”，不记录等于本次探索白做。

**新会话验证标准**：不依赖旧对话，只读这份 md，就能在少量命令内完成同类任务。验证后再把结果记进日志。

## 验证日志（logs/<domain>/log.md，固定格式）

验证记录不再堆在经验文件里，按域名独立存放，一个域名一个文件夹：

- **位置**：`~/.dsh/browser-operator/logs/<canonical-domain>/log.md`
- **固定格式**（一行一次，只追加、不改历史行）：
  `- YYYY-MM-DD HH:mm | 任务 | 结果(ok|failed|partial) | 备注`
- **追加**：`"$BROWSER" log add <domain> "<任务>" --result ok|failed|partial (--task <任务名> | --one-off) --note "<备注>"`；脚本跑成功或停下时会自动追加一行，备注以 `[脚本]` 开头
- **查看**：`"$BROWSER" log show <domain> [--limit N]`；全部域名：`"$BROWSER" log list`
- 经验文件的 `## 验证记录` 只保留日志路径指针。迁移旧经验时，先将原表格/条目原样保存在日志的 `## 历史记录（经验迁移 …）` 下，再替换经验中的旧记录；CLI 不会自动迁移历史内容。
- 不要手工改格式；`log add` 会生成合法行，`log show` 只解析这个格式。

## 操作脚本（recipe）：做过三次的操作写成传参数就能跑的脚本

经验记录「这个站点怎么操作」，脚本是「同一个操作传参数就能重跑」。脚本是一个 JS 文件，由一串有名字的步骤组成：每步做完读回页面的实际情况、打一行日志，情况不对就停在那一步，处理完从那一步接着跑。

**位置**（与 `experiences/` 同层级；域名去掉开头 `www.`，子域名保留）：

- `~/.dsh/browser-operator/脚本/<canonical-domain>.md`：这个站点的任务索引。frontmatter 与经验一致，另有 `profile`（必填，脚本用哪个 profile）和可选的 `origin`（站点地址不是 `https://<domain>` 时写，如 `http://localhost:8765`）。每个任务一个 `## <任务名>` 段，`说明 / 次数 / 最近 / 状态 / 上次失败` 这几行由命令维护，不要手改；下面可以手写备注。模板 `references/recipe-template.md`。
- `~/.dsh/browser-operator/脚本/<canonical-domain>/<任务名>.mjs`：任务的脚本。同目录 `_` 开头的 `.mjs` 放本站点几个脚本共用的函数。模板 `references/recipe-template.mjs`。

**任务名**：小写字母、数字、下划线，像函数名。它说的是动作，不带具体的项目、环境、版本号，这些是参数：写 `deploy_tag`，不写「重跑 rule-engine SIT」。同一个操作换了项目或环境还是同一个任务。

### 开工：先看有没有脚本

```bash
"$BROWSER" recipe show <domain>
```

返回这个站点每个任务的说明（`desc`）、适用范围（`scope`）、参数、状态（`state`）和可以直接复制的调用命令（`usage`），内容很短。

- 有对得上的任务，`state` 是 `已验证` 或 `未验证`：直接 `recipe run`，不用先读经验。对不对得上看 `desc` 和 `scope`，不要只看名字像。
- 没有对得上的，或 `state` 是 `计数中`（还没写脚本）、`不写脚本`（固定不下来，`noScript` 是原因）：按「经验记忆」一节，`experience show` 后手动做。
- `state` 是 `加载失败`：脚本文件有错（`error` 里有原因），修好再跑；急着用就先手动做。
- 任务相近、但脚本覆盖不了这次的用法（多一个变量、换一类页面）：这次手动做，做完在原脚本上加参数（见「更新脚本」），不要另起一个相近的任务。

### 运行

```bash
"$BROWSER" recipe run <domain> <任务名> --var name=value --var name2=value2
```

- 参数会先检查：缺了、名字写错、不在允许的取值里，都不会开始跑。`--dry-run` 只检查、不执行；索引没写 `profile` 时 dry-run 只给一条警告，实跑会报 `no-profile`。
- 每完成一步打一行 `✓ <步骤> (<耗时>) <这一步读到的情况>`，最后是结果 JSON。
- 预计要跑几分钟以上的脚本（比如等流水线）放后台跑，结束时再看输出。
- 成功（`ok:true`）：`result` 就是要回报给用户的内容。次数、状态和 `logs/<domain>/log.md` 都已自动记好，不用再做「任务收尾检查」，也不用再 `log add`。
- 用户本次明确要求代登录时，才在 `recipe run` 上加 `--allow-auth`；脚本文件里不允许出现这个授权。滑块/CAPTCHA 仍必须由用户完成。

### 停下来以后

`ok:false` 时看 `status`。两种情况都保留页面现场，返回里的 `resume` 是可以直接复制的续跑命令（停在提交步骤上时例外，见下面）：

| `status` | 什么情况 | 怎么办 |
|---|---|---|
| `paused` | 未验证的脚本走到会改东西的步骤之前（`before`），或 `--step` 模式下每步之后（`after`） | 看截图和前面各步打出来的情况，确认没问题再 `--resume`；有问题按 `stopped` 处理 |
| `stopped` | 某一步出错：命令失败、核对不成立（`expect-failed`）、没预料的弹窗（`unexpected-dialog`）、要登录（`needs-login`）、要做验证（`needs-verification`）、超过 `--max-minutes`（`run-timeout`）等 | 看 `step`、`error`、截图，用同一个 profile 直接操作浏览器查清原因 |

查清以后：

- 页面状态的问题（弹层挡住、数据没准备好）：处理掉，`--resume` 重做这一步。
- `needs-login`：请用户在可见窗口登录，`wait-login` 之后再 `--resume`。
- `needs-verification`：页面出了滑块或验证码，请用户在可见窗口完成，`wait-verification` 之后再 `--resume`。
- `unexpected-dialog`：弹窗还开着，读内容后自己决定 `dialog accept` 还是 `dialog dismiss`，再续跑。
- 脚本的问题（选择器变了、等待不够）：改脚本文件再 `--resume`，用的是改后的代码。改的时候不要动已经做完的步骤的名字：续跑靠名字认出哪些步骤做过，改了名就会被当成没做过。提交步骤改了名会停下报 `commit-step-missing`，按 `hint` 处理。
- 这一步已经手动做完：`--resume --skip`；后面的步骤要用这一步的返回值时加 `--value '<json>'`。
- 停在提交步骤上：这一步可能已经生效。先到页面确认，已生效用 `--resume --skip`，没生效用 `--resume --retry`；单独 `--resume` 会被拒绝。这时返回里的 `resume` 仍是单独的 `--resume`，带 `--skip` 和 `--retry` 的两条完整命令在 `hint` 里。

做过的步骤不会重做，返回值沿用。不要为了续跑而重新 `recipe run`：上一次运行提交过又没跑完，新的 `recipe run` 会被拦下（`unfinished-run`），不管参数和上次是否相同；返回里有上次的参数、停在哪一步，以及 `--resume` 和 `--new` 两条完整命令。确实要放弃上一次从头再来，才用 `--new`。

`已验证` 由执行器记：这份代码从头到尾一次跑完、中途没有出错停下（停下后再 `--resume` 走完的也不算）、没有跳过步骤，才算。提交前的暂停和 `--step` 的暂停不算出错。代码一改就变回 `未验证`。不要手写这一行。

### 收尾：手动做的要归类

手动完成的任务（包括脚本停下后手动接管做完的），`log add` 时必须说明它属于哪个任务：

```bash
"$BROWSER" log add <domain> "<这次做了什么>" --result ok --task <任务名> --note "..."
"$BROWSER" log add <domain> "<这次做了什么>" --result ok --one-off     # 一次性的操作，以后不会重复
```

- 先看 `recipe show <domain>` 里已有的任务名，是同一个操作就用同一个名字。
- 返回里的 `recipe.count` 是这个任务成功做过的次数，`hint` 说明下一步。第 1、2 次只计数。**第 3 次成功时现在就写脚本**，趁这次跑过的命令还在上下文里。只做过一两次的不写。
- 会重复做、但每次步骤都不一样、固定不下来的任务：照常用 `--task` 计数，在索引里这个任务段加一行 `- 不写脚本: <原因>`。之后 `state` 显示 `不写脚本`，`log add` 也不再提示写脚本。

### 写脚本

从 `references/recipe-template.mjs` 起步。要点：

- 步骤用这次实际跑通的命令和选择器，不凭印象写；探索时走的弯路不要写进去。
- 每一步做完读回页面的实际情况，用 `b.expect` 核对，再把读到的东西 `return` 出来，它就是这一步的日志。只发命令、不核对的步骤等于没有检查。
- 会改线上数据、不能重做的那一步（提交、发布、删除、上传）单独成一步，标 `{ commit: true }`；它前面的步骤要先核对页面上的值和参数一致。
- 页面里读数据用 `b.eval(函数, 参数)`，参数按数据传进去，不要拼进字符串。
- 预期会弹的确认框写明内容：`b.click(sel, { dialog: "确定存档" })`，内容对得上才确认，对不上会取消并停下。
- 晚一点才弹的弹窗（比如 ajax 保存成功后才 alert）不要用 `dialog` 选项，命令返回时它还没弹，会报 `dialog-missing`。改成点完以后用 `b.until` 轮询 `b.dialog("status")` 的 `pending`，核对内容后再 `b.dialog("accept")`，写法见模板末尾。
- 等待用 `b.wait` 或 `b.until`，不用固定的 sleep。
- 不写账号、密码、token、OTP、证件号，不写 `allowAuth`。参数会明文写进运行记录（`logs/<domain>/runs/`）和日志，所以密码、token 这类东西也不能做成参数。
- 同一个任务不要同时跑两次：两次会用同一份运行记录，互相覆盖。

写完先 `recipe run <domain> <任务名> --dry-run`，确认能加载、参数对。只读的任务当场实跑一次，和刚才手动得到的结果对一下。会改东西的任务不要为了验证再跑一遍，留到下次真正要用时，它会停在提交步骤之前让你确认。新脚本或刚大改过的脚本可以加 `--step`，一步一停地跑。

`b` 提供的东西：

| 写法 | 作用 |
|---|---|
| `await b.step("名字", async () => {...}, { commit: true })` | 一个步骤。返回值会存下来并打进日志，续跑时直接沿用。浏览器命令都要写在步骤里；步骤不能嵌套；名字不能重复（循环里把序号或对象写进名字） |
| `b.open` `goto` `state` `wait` `click` `fill` `press` `select` `hover` `drag` `query` `snapshot` `screenshot` `switch` `close` `dialog` `upload` 等 | 与同名 CLI 命令一样：位置参数在前，选项放最后一个对象里，`{ waitNav: true, timeout: 20000 }` 对应 `--wait-nav --timeout 20000`。失败就停 |
| `await b.eval(函数或表达式, 参数)` | 在页面里执行，返回它的结果 |
| `b.expect(条件, "不成立时的说明")` | 不成立就停在这一步 |
| `await b.until(async () => 值或 null, { every: 30, max: 600 })` | 每隔 `every` 秒查一次，直到返回真值；超过 `max` 秒算失败 |
| `b.log("…")` | 步骤中途打一行进度，和上一行相同就不打 |
| `b.finish(结果)` | 已经是要的状态，后面的不用做了 |
| `b.origin` `b.domain` `b.profile` `b.vars` | 站点地址、域名、profile、参数 |

### 更新脚本

- 脚本覆盖不了的新用法：在原脚本上加参数并给默认值，原来的调用不受影响；几个脚本共用的部分提到 `_common.mjs`。
- 脚本跑失败、页面改版：修到能 `--resume` 走完。索引里的「上次失败」会留到下一次成功。
- 改完代码状态变回 `未验证`，下一次从头到尾一次跑完（中途没停、没跳过步骤）后恢复。
- 一个脚本反复修不好，就删掉它的 `.mjs` 回到手动做，索引里的计数留着。

查看全部站点的任务：`"$BROWSER" recipe list [domain-filter]`。

旧的写法（索引文件任务段里的 `steps` 代码块，每行一条命令、`{{占位符}}`）还能用 `recipe run` 执行，但不要再新写。

## Quick start

Requires Node.js 20+ with the currently locked Playwright dependency, npm, and Chrome. The `bin/browser` launcher requires Bash (including on Windows); without Bash, run `node <skill-directory>/scripts/browser.mjs ...` directly. The examples below use the default installation path; adjust it when installed with `--dest` or a custom `DSH_HOME`.

```bash
BROWSER="$HOME/.dsh/skills/browser-operator/bin/browser"

# 1. First run only (already installed on this machine):
npm install --prefix "$HOME/.dsh/skills/browser-operator/scripts"

# 2. Read the saved experience first (if any)
"$BROWSER" experience show example.com

# 3. Open a site with a named profile (headless by default; add --headed to watch)
"$BROWSER" open "https://example.com" --profile mysite

# 4. If login/challenge is detected, `open` auto-switches to headed.
#    If you need to do it explicitly:
"$BROWSER" mode headed --profile mysite
#    Bring the window forward when the user needs to log in:
"$BROWSER" focus --profile mysite
#    Ask the user to complete login/verification, then wait:
"$BROWSER" wait-login --profile mysite --timeout 300000
#    Stay headed after login unless restore-session was enabled before login.
#    With restore-session on, you may switch back using mode headless.

# 5. See what is clickable (returns selectors you can copy)
"$BROWSER" snapshot --mode interactive --profile mysite

# 6. Read the heading on example.com; use snapshot selectors for business actions
"$BROWSER" query "h1" --profile mysite

# 7. Close the browser when done; the profile keeps login state
"$BROWSER" stop --profile mysite
```

The default mode is **headless** for speed. Add `--headed` to `open` when you want to watch, or use `mode headed` at any time. Login/verification automatically escalates to headed (unless `--no-auto-headed`) and can be switched back with `mode headless`.

**Headed focus handling (macOS).** The daemon records the frontmost app before launching headed Chrome, attempts to restore that app's focus, and skips `page.bringToFront()` during headed navigation/clicks. Consequences:

- The user may not notice the window. When they need to log in / verify, either tell them "Chrome 已在后台打开，请切换过去" or run `browser focus --profile <name>` (the only thing that foregrounds it).
- `wait-login` / `wait-verification` do **not** foreground the window; they only poll.
- If the user asks to watch, run `focus` once so they see it.


Changing mode **closes and relaunches Chrome**. `open`/`goto` keeps the current mode unless `--headed`/`--headless` is passed explicitly or login/verification triggers automatic headed escalation. `--no-auto-headed` disables that escalation for the navigation. Restarting still loses session cookies (e.g. Tomcat `JSESSIONID`) unless the profile has `restore-session on` (see below).

## Login persistence (the required flow)

```
open target site (headless) → reuse existing profile
  → if login/verification is needed: mode headed (or auto-escalated by open)
  → user logs in / solves verification in the visible Chrome
  → wait-login / wait-verification
  → stay headed, or mode headless if restore-session was enabled before login
  → snapshot → click → verify
  → stop (cookies + localStorage stay in the profile)
```

- Profiles live under `~/.dsh/browser-operator/profiles/<name>/chrome-profile`.
- Use one stable profile per site, e.g. `--profile wechat`, `--profile xiaohongshu`, `--profile company-sso`.
- Re-running `open` with the same profile reuses cookies/localStorage. **Do not ask the user to log in again unless the page actually shows a login screen.**
- Session cookies (no `Expires`, e.g. Tomcat `JSESSIONID`) are **not** reloaded after Chrome restarts by default. Run `restore-session on --profile <name>` to launch Chrome with `--restore-last-session`; then a mode switch or daemon restart keeps the login as long as the server-side session is still valid. The setting is per profile and stops the daemon once so it applies on the next `open`; restored duplicate tabs are closed automatically so tabs do not pile up.
- `wait-login` polls until `login.likely` becomes false (no visible password input / login URL / "登录超时" text), up to the timeout.
- `state` and `snapshot` include `login.likely`, `login.reasons`, and `challenge.likely`. If `challenge.likely` is true (slider/CAPTCHA), ask the user to complete it in the visible Chrome, then run `wait-verification`.
- The browser stays open between CLI commands, so `sessionStorage`, tabs, and popups survive while the daemon is running.
- Never read, print, copy, or upload `chrome-profile/`, cookies, `daemon.json`, or the daemon token. Do not ask the user to paste a password into chat; let them type it in the visible browser. Only use credentials the user volunteers with an explicit instruction to log in, and never echo them back.

## Browser fingerprint (fixed per profile)

Every profile gets **one stable fingerprint** on first launch, stored in `~/.dsh/browser-operator/profiles/<name>/settings.json` under `fingerprint`. It does not change between pages, reloads, headed/headless switches, or daemon restarts.

- UA/UA-CH: the **same identity is injected in both headed and headless mode**, so switching modes never changes the fingerprint. The UA keeps the real Chrome major version; UA-CH metadata (architecture, platformVersion, bitness) is computed from the host. Headless is the default; headed is only for manual login or verification.
- `navigator`: left **native** by default (`platform`, `vendor`, `languages` already match the host). JS overrides are opt-in (`fingerprint.navigator: true`) because tampering is detectable.
- WebGL: uses the real GPU by default (for example Apple M1 Pro); set `fingerprint.webgl: "spoof"` to pin a renderer or `"off"` to disable WebGL.
- Canvas/Audio: deterministic noise from the profile seed, so the fingerprint hash is stable across reloads and restarts.
- `navigator.webdriver`: kept `false` by `--disable-blink-features=AutomationControlled`.
- DevTools false positives: `console.table` is deferred by default (`fingerprint.devtoolsFix: true`). CDP serialization makes `console.table` slow, which timing-based devtools detectors (e.g. `devtools-detector`) misread as an open DevTools panel.
- locale/timezone: taken from the OS; macOS `zh-Hans_US` is normalized to `zh-CN`.

Inspect or reset:

```bash
"$BROWSER" fingerprint --profile mysite          # show the stored fingerprint
"$BROWSER" fingerprint --profile mysite --reset  # regenerate it (stops the daemon)
```

A profile fingerprint is rebuilt automatically if the same profile is opened on a different OS (for example a macOS profile on Windows). Overridable keys in `settings.json`: `fingerprint.webgl` (`auto` by default, `spoof`, `off`), `fingerprint.navigator` (`false` by default), `fingerprint.canvasNoise`, `fingerprint.audioNoise`, `fingerprint.devtoolsFix` (`true` by default), `userAgent`, `locale`, `timezone`. Do not reset a fingerprint on a logged-in site: the site will see a different device.

## Commands

| Command | Purpose |
|---|---|
| `open <url> [--profile name] [--headed\|--headless] [--no-auto-headed] [--snapshot]` | Open URL; keeps current mode unless a mode flag is given; auto-heads on manual auth |
| `mode headed` / `mode headless` | Switch mode (restarts Chrome; session cookies can be restored with `restore-session on` while the server session remains valid). On macOS, headed launch attempts to restore the previous app's focus |
| `focus` | Bring the headed Chrome window to the front (explicit opt-in; nothing else foregrounds it) |
| `restore-session on\|off` | Per-profile: relaunch Chrome with `--restore-last-session` so session cookies survive restarts; stops the daemon so it applies on next `open` |
| `fingerprint [--reset]` | Show the profile's fixed fingerprint; `--reset` regenerates it and stops the daemon |
| `goto <url>` | Alias of `open`, with the same flags |
| `state` | Current URL/title/pages/login hints |
| `snapshot [--mode interactive\|text\|full\|forms] [--selector CSS] [--frame CSS]` | Page structure with suggested selectors |
| `query <selector> [--limit N] [--html] [--all-attrs] [--frame CSS]` | Read matched DOM nodes (text/attrs/rect), including non-interactive divs |
| `click <selector> [--nth N] [--wait-for CSS] [--wait-nav] [--frame CSS] [--timeout ms] [--allow-auth]` | Real mouse click + effect verification; `--allow-auth` only when the user explicitly asked you to log in |
| `drag <source> <target> [--nth N] [--target-nth N] [--steps N] [--method auto\|dragTo\|mouse\|js]` | Real drag/drop; auto tries stepped mouse then `dragTo`; `js` needs `--allow-js` |
| `eval <expression>` | Explicit JS escape hatch for page-specific handlers; never bypasses login/verification |
| `fill <selector> <value> [--type] [--append] [--frame CSS] [--allow-auth]` | Fill input; `--type` types with keyboard events; `--allow-auth` only for user-authorized login |
| `press <key> [--allow-auth]` | Keyboard key (e.g. `Enter`, `Escape`, `Tab`); `--allow-auth` only for user-authorized login submit |
| `hover <selector> [--wait ms]` | Real mouse hover; use before clicking hover-only menus |
| `select <selector> <value> [--label] [--allow-auth]` | Select an option; `--allow-auth` only for user-authorized login |
| `upload <selector> <file>... [--frame CSS]` | Put local files into a file input |
| `wait <selector>` / `wait --url <pattern>` | Wait for element or URL |
| `screenshot [path] [--full-page]` | Save a screenshot; default under `~/.dsh/browser-operator/screenshots` |
| `switch --index N` / `switch --url includes` | Switch active tab |
| `close` | Close the active tab and switch back to the remaining page |
| `wait-login [--timeout ms]` | Wait until the login screen disappears |
| `wait-verification [--timeout ms]` | Wait until a slider/CAPTCHA verification page disappears (user solves it in the headed window) |
| `console [--limit N] [--filter text] [--clear]` | Recent browser console logs and page errors |
| `network [--limit N] [--filter text] [--type xhr\|fetch\|document] [--errors] [--clear]` | Recent requests/responses, status, duration, failures |
| `debug` | One bundle: state + screenshot + recent console + recent network |
| `stop` | Close browser and flush the profile |
| `status` | Show daemon mode (headless/headed) without starting one |
| `profiles` | List known profiles and their last URL/title (no secrets) |
| `experience list` | List saved site experiences |
| `experience path <domain>` | Print the fixed experience file path |
| `experience show <domain>` | Read a saved experience; also returns `related` environments |
| `experience related <domain>` | List same-app / alias / normalized-domain experiences without loading full content |
| `experience current [--profile name]` | Resolve the active page URL and read that host's experience |
| `experience validate <domain>` | Validate frontmatter and required sections |
| `log add <domain> "<任务>" --result ok\|failed\|partial (--task name \| --one-off) [--note text]` | Append one fixed-format verification log line; `--task` also counts the run toward that task's script threshold |
| `log show <domain> [--limit N]` | Recent standardized log entries for a domain |
| `log list` | Domains with logs, entry counts and last entry |
| `recipe list [filter]` | List every site's tasks with their state and counter |
| `recipe show <domain> [task]` | Show each task's description, scope, params, state and a ready-to-copy run command |
| `recipe log <domain> <task>` | Increment that task's `次数` only (normally done by `log add --task`) |
| `recipe run <domain> <task> [--var k=v]... [--dry-run] [--step] [--profile name] [--allow-auth] [--max-minutes N]` | Run the task's script step by step; stops or pauses at a step and keeps the page; login requires explicit authorization for this run |
| `recipe run <domain> <task> --resume [--skip [--value json] \| --retry]` | Continue the stopped or paused run from that step. A fresh run is refused while the last unfinished run has submitted something, whatever the params; `--new` abandons that run |

Operational commands return JSON. `ok:false` means the action failed; inspect `error.code`, `error.message`, `error.diagnosis`, and any `error.screenshot` / `error.recentConsole` / `error.recentNetwork` attachments. Even with `ok:true`, inspect `warning`, `effect`, and the business success condition.

## Real click rules

`click` uses Playwright's `locator.click()`: it scrolls the element into view, waits for actionability, verifies the hit target, and dispatches trusted CDP mouse input. It returns:

```json
{
  "ok": true,
  "method": "playwright-mouse",
  "trusted": true,
  "authOverride": true,
  "target": { "tag": "BUTTON", "text": "保存", "rect": {...}, "covered": false },
  "effect": {
    "urlChanged": true,
    "newPage": false,
    "navigated": false,
    "clickEvents": 1,
    "trustedEvents": 1,
    "mutations": 3
  }
}
```

- `authOverride: true` in the response means the click/fill ran on a login page with `--allow-auth`. It never appears for slider/CAPTCHA pages.
- **Do not use `--js`** unless the user explicitly asks for a DOM click or the page is impossible to drive with real input. `--js` returns `trusted:false` and is not a real mouse click.
- `--force` skips actionability checks but still clicks the real screen coordinates; it can hit an overlay. Use only with a clear reason.
- If `covered` is returned, a real click cannot reach the target — a human would hit the overlay too. First close the overlay (`press Escape`, click a close button), scroll, or choose the visible element. Do not retry the same covered selector.
- If `warning` says the page received no click event or no observable change, run `snapshot` again and verify the selector/coordinates before retrying.
- For hover-only menus: `hover` the parent, then `click` the item that appeared.
- For iframes: pass `--frame "#iframe-id"` to `click`, `snapshot`, `fill`, etc. Playwright resolves the frame internally.
- For links/buttons that open a new tab: the daemon switches the active page automatically and returns `effect.newPage:true`; use `switch` to go back.

## Drag / complex widgets

Use `drag` for drag-and-drop lists, sortable tables, kanban boards, and upload drop zones:

```bash
"$BROWSER" drag "#source .item" "#target" --nth 1 --target-nth 1 --profile mysite
```

- Default `--method auto` performs a stepped real-mouse drag first, then falls back to Playwright `dragTo` if no URL/DOM change is observed.
- SortableJS / jQuery UI / pointer-based lists usually work with the mouse path; HTML5 native drag can use `--method js --allow-js` as an explicit fallback.
- If the source/target has hidden duplicates, inspect `query` and choose the matching DOM index with `--nth` / `--target-nth` (starting at 1); selecting a hidden match fails. Without an index, the command picks a visible match. It returns `source`/`target` boxes.
- A `warning` means the drag ran but no URL/DOM change was observed. Check source/target, drop position, or the component's own JS state; don't assume success from the mouse action alone.
- For JS-managed date/time pickers, don't trust `fill` alone: click the field, wait for the visible calendar, then click the target day/cell. Prefer `wait <selector>` over fixed sleeps.
- `eval` is an explicit escape hatch for page-specific handlers when real input is impossible. It executes JavaScript rather than trusted mouse/keyboard input; its response has no `trusted` field. It must not be used to bypass login, verification, or CAPTCHA.

## 通用任务模式（写经验时套用）

| 任务 | 经验里必须写清楚 |
|---|---|
| 搜索 | 结果页直达 URL 模板、搜索框/提交按钮、结果条目选择器、`--nth` 按该选择器的 DOM 匹配顺序从 1 编号、广告/重复节点；`query.items` 可包含隐藏/屏幕外节点并受 `--limit` 截断，`count` 是总匹配数 |
| 列表 → 详情 | 列表卡片选择器、标题链接选择器、点击是否新标签页、详情标题/正文选择器、空页面兜底；详情页不要复用列表选择器 |
| 表单提交 | 字段选择器/标签、填写方式（fill/type/select）、提交按钮、成功/失败判定选择器；登录/验证默认人工，用户明确授权后代填需 `--allow-auth` |
| 拖拽/排序 | source/target 选择器、`--nth`/`--target-nth`、`--method`、drop 位置、成功后的 DOM/URL 变化 |
| 复杂组件 | datepicker/弹层/富文本/级联选择；先 `wait` 可见容器，再点可见项，不要只 `fill` |
| 文章阅读 | 标题来源（`state.title` / 可见 h1）、正文容器、摘要截取方式、canonical 干净 URL、分页/懒加载/视频噪音 |
| 多标签/iframe | 新标签页切换规则、iframe 选择器、`--frame` 用法 |
| 弹窗/确认 | 哪一步会弹出什么（type、message）；弹出后命令返回 `status: dialog-pending`，按业务意图 `dialog accept`（prompt 用 `--text`）或 `dialog dismiss` |

## Workflow for a new site

0. `recipe show <domain>`：有对得上的脚本就直接 `recipe run`。没有再 `experience show <domain>`，有经验就照做；没有才探索。
1. `open <url> --profile <site>`.
2. Read the returned `login` / `challenge` / `manualAuth`. By default `open` auto-switches to headed when manual auth is needed. If it is still headless, run `mode headed` (or `wait-login` / `wait-verification`, which also escalates). Default: ask the user to complete it in the visible window. Only if the user explicitly told you to log in for them, drive it yourself with `--allow-auth` (login kind only; sliders/CAPTCHA still stay with the user). After it is done you can stay headed (fast enough) or run `mode headless` if the profile has `restore-session on`, otherwise switching modes restarts Chrome and drops session cookies.
3. `snapshot --mode interactive` to get visible elements and suggested selectors.
4. `click <selector>` with `--wait-for` / `--wait-nav` when the page loads asynchronously.
5. After each click, check `trusted`, `effect`, and `warning`; take a screenshot if the result is unclear.
6. 成功后按 `references/experience-template.md` 写/更新 `~/.dsh/browser-operator/experiences/<domain>.md`，并 `experience validate <domain>`。
7. 给最终答复前执行“任务收尾检查”：再 `experience show <domain>`，有变化更新并 validate；无论有无变化，都用 `log add`（带 `--task <任务名>` 或 `--one-off`）追加本次验证日志。
8. When done, `stop` to flush the profile. The next `open` reuses it; login still depends on cookie persistence and server-side session validity.

Example (WeChat public account):

```bash
BROWSER="$HOME/.dsh/skills/browser-operator/bin/browser"
"$BROWSER" open "https://mp.weixin.qq.com/" --profile wechat
# user scans the QR code in the visible Chrome
"$BROWSER" wait-login --profile wechat --timeout 300000
"$BROWSER" snapshot --mode interactive --profile wechat
"$BROWSER" click "button:has-text(\"新的创作\")" --profile wechat --wait-for "span:has-text(\"文章\")"
"$BROWSER" click "span:has-text(\"文章\")" --profile wechat --wait-nav
"$BROWSER" stop --profile wechat
```

## Dialogs (important)

Native `alert` / `confirm` / `prompt` / `beforeunload` dialogs are **never handled automatically**. When one opens it stays open, and the command that triggered it returns right away with `status: "dialog-pending"` and `pendingDialog` (`type`, `message`, and `defaultValue` for prompts). Read the message, then decide:

```bash
"$BROWSER" click "#delete" --profile mysite
# -> "status": "dialog-pending", "pendingDialog": {"type": "confirm", "message": "确定删除?"}

"$BROWSER" dialog accept --profile mysite               # press OK
"$BROWSER" dialog dismiss --profile mysite              # press Cancel
"$BROWSER" dialog accept --text "yes" --profile mysite  # prompt: type the text, then OK
"$BROWSER" dialog status --profile mysite               # pending dialog and recent history
```

- While a dialog is pending the page is frozen, so other page commands fail fast with `dialog-pending`; only `dialog`, `console`, `network`, `status`, and `stop` still work.
- `dialog accept|dismiss` returns `handled`, the interrupted action's result as `resumed` (when it finished), and the current `url` / `title`. If the page opens another dialog right after (for example an alert after a confirm), the response is `dialog-pending` again; handle that one too.
- On a prompt, `dialog accept` without `--text` keeps the prefilled value, like pressing OK.
- There is no pre-set policy: `dialog accept` with nothing pending fails with `no-pending-dialog`. Trigger the action first, then decide.
- In headed mode the user can also click the dialog in Chrome; the daemon clears it.
- Do not confirm login, payment, delete, or publish dialogs unless the action is intended. Read the message first.

## Automatic debugging

Browser action exceptions attempt to attach a screenshot and recent console/network entries. Validation/startup failures and returned timeout results may lack these attachments:

```json
{
  "ok": false,
  "error": {
    "code": "covered",
    "message": "locator.click: Timeout 2000ms exceeded.；中心点被 <DIV> 遮挡",
    "diagnosis": { "covered": true, "topTag": "DIV" },
    "screenshot": "~/screenshots/error-51job-...png",
    "recentConsole": [ ... ],
    "recentNetwork": [ { "status": 404, "url": "..." } ]
  }
}
```

On demand:

```bash
"$BROWSER" debug --profile mysite
"$BROWSER" console --profile mysite --limit 30
"$BROWSER" network --profile mysite --errors --limit 30
"$BROWSER" network --profile mysite --type fetch --filter "/api/" --limit 20
"$BROWSER" wait-verification --profile mysite --timeout 120000
```

The buffers are per daemon, capped (300 console / 500 network), URLs are token-masked, and request bodies/headers are not recorded. Clear them with `--clear` after reproducing an issue.

Headed vs headless: headless is the default for automation; use `mode headed` or `open --headed` when the user must log in / solve verification. Switching modes restarts Chrome: keep the current mode (plain `open`/`goto` no longer change it) unless you need the other one; with `restore-session on` the login survives the restart. `wait-login` and `wait-verification` auto-escalate, so no `stop` is needed to change mode.

## Troubleshooting

| Symptom | Action |
|---|---|
| `covered` | Close the modal/overlay, scroll, or click the visible element; real input cannot penetrate another element |
| `hidden` | Wait for the element, hover its parent, or use `snapshot` to find the visible duplicate |
| `timeout` | Increase `--timeout`, check login state, and re-run `snapshot` |
| `not-found` | Selector is wrong/ambiguous; copy a selector suggested by `snapshot` |
| Chrome not found | Install Google Chrome or set `CHROME_PATH` |
| Daemon start timeout | Check `~/.dsh/browser-operator/profiles/<name>/daemon.log`; run `stop` and retry |
| User cannot see the browser | Run `mode headed` (or `open --headed`) then `focus`; headed stays behind on purpose |
| Login keeps asking | Confirm the same `--profile` is used; do not delete the profile directory |
| `manual-auth-required` | Default: the user logs in or completes verification in the visible Chrome, then `wait-login` / `wait-verification`. Only when the user explicitly asked you to log in for them, retry the same command with `--allow-auth` (login kind only). Never use `--js`/`--force` to get around it |
| Command returns `dialog-pending` | A native dialog is open and the page is frozen until it closes. Read `pendingDialog.message`; run `dialog accept` (prompt text via `--text`) only when confirmation is intended, otherwise `dialog dismiss` |
| `challenge.likely:true` / `verification-timeout` | A slider/CAPTCHA is blocking the page. Ask the user to complete it in the visible Chrome, then run `wait-verification` |

## Notes

- Default mode is headless. On macOS, headed launch attempts to restore the previous app's focus; headed actions do not bring the page forward. Run `focus` when the user needs to see it. `mode headed`/`mode headless` relaunches Chrome with the same profile and attempts to restore the URL.
- Runtime data defaults to `~/.dsh/browser-operator/`; set `BROWSER_OPERATOR_HOME` to change it. `DSH_HOME` and installer `--dest` only change installation locations, not the runtime root. Paths above assume the defaults.
- `open` accepts `file://`, `http://`, and `https://`.
- The daemon is local-only (`127.0.0.1`), token-protected, and exits after 30 idle minutes (configurable with `--idle-minutes`). Mode is stored in `daemon.json` and reported by `status` / `health`.
- This skill is the single entry point for browser operations. If a capability is missing, extend `scripts/browser.mjs` rather than creating a parallel script.
- Scripts and experience memory are part of the skill contract: run `recipe show` first and use a matching script; otherwise read `experience show`, and write/update the fixed md after a successful exploration. The next session must be able to finish the same site without re-discovering selectors.
