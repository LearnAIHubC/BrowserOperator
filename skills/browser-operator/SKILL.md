---
name: browser-operator
description: "Automate Chrome with real mouse input and profiles that keep cookies/localStorage. Runs headless by default and switches to a visible window when login or verification is needed. The user handles login unless they explicitly ask the agent to do it in the conversation; the agent must then use --allow-auth. The user always completes sliders/CAPTCHAs. Use for opening sites, reusing sessions, snapshots, clicks, hover, forms, iframes, screenshots, and console/network debugging. Dialogs default to cancel; accepting requires an explicit command. Read saved site notes before exploring and update the Markdown notes after a successful run. Save reusable task recipes under 脚本/ with {{placeholders}} and replay them with recipe run. Triggers include 浏览器点击, 打开网站, 登录网站, 保存登录, 保持登录, 帮我登录, 操作脚本, 一键执行, real click, browser automation."
---

# Browser Operator

Use this skill for all browser clicks and automation. Use the bundled CLI instead of writing separate Playwright/CDP scripts; do not use `el.click()` or DOM events as the default. The CLI manages a persistent Chrome profile and a local background process (daemon). Login state can be reused across commands and sessions while the cookies and server-side session remain valid.

## 页面标注与配置

- `~/.dsh/browser-operator/config.json` 中的 `annotationEnabled` 布尔值决定是否显示标注按钮。设置了 `BROWSER_OPERATOR_HOME` 时，读取该目录下的 `config.json`。没有配置时默认开启，所有 Profile 共用这个设置。
- 开启后，打开、刷新或跳转页面时，右下角都会显示标注按钮。用户点击后，按钮变为“请选择”，此时可以拖出矩形框；记录标注后，按钮变为“清空标注”。
- 用户明确说“关闭标注”时，执行 `annotate cancel --profile <profile>`，将配置保存为 `annotationEnabled: false`，并移除当前浏览器各标签页的标注。以后打开页面或重启浏览器，都不再显示标注入口。
- 用户明确说“开启标注”或“需要标注”时，执行 `annotate start --profile <profile>`，将配置保存为 `annotationEnabled: true`，恢复标注入口。平时打开页面或结束任务时，不要反复执行 start/cancel，以免覆盖用户的设置。
- 点击框右上角的 × 只删除该框；“清空标注”会清空所有框并退出绘制，按钮仍保留，配置也不变。按 Esc 可以退出本次绘制。
- 用户要求查看框选内容时，执行 `annotate read --profile <profile>`，直接读取 DOM 元素、文字、唯一 CSS 选择器、元素边界 `rect` 和中心点 `center`，不需要截图。坐标以页面可见区域为基准，单位是 CSS 像素，返回值为 `coordinateSpace: viewport`。


## 登录与验证

默认由用户在可见的浏览器窗口中完成登录和验证。用户没有明确要求代登录时，遵守以下规则：

- 不输入用户名、密码、手机号、OTP 或其他凭据。
- 不点击“登录”“注册”“登录/注册”“发送验证码”“扫码登录”、Sign in、Log in、Continue with ... 等入口，也不提交登录表单。
- 不操作或重试滑块、CAPTCHA、“访问验证”“滑动验证”“人机验证”。
- Agent 负责打开页面，报告 `login.likely`、`challenge.likely` 和 `manualAuth` 的结果，按需切到可见窗口模式（headed），再用 `wait-login` 或 `wait-verification` 等待。
- `manualAuth.required` 为 true 时，`click` / `drag` / `eval` / `fill` / `press` / `select` 默认返回 `manual-auth-required`。此时可以用 `snapshot`、`query`、`console`、`network`、`screenshot`、`debug` 查看页面，请用户在可见窗口中完成登录或验证。

只有用户在当前对话中明确说“你帮我输入账号密码登录”“用这组账号登进去”“帮我点登录”等指令时，Agent 才能代为登录：

- 对登录页执行 `fill` / `click` / `press` 时，必须加 `--allow-auth`：
  ```bash
  "$BROWSER" fill "#username" "<用户提供的账号>" --allow-auth --profile mysite
  "$BROWSER" fill "#password" "<用户提供的密码>" --allow-auth --profile mysite
  "$BROWSER" click "#btnLoginNow" --allow-auth --profile mysite --wait-nav
  ```
- 只使用用户在对话中提供的凭据，不从文件、历史记录或其他站点查找、猜测或复用。
- 不把凭据写进经验文件、日志、截图说明或最终答复；只说明登录是否成功。
- `--allow-auth` 仅对 `manualAuth.kind === "login"` 生效。滑块或 CAPTCHA（`kind: "verification"`）仍会被拦截，必须由用户完成。
- “打开看看”“试试看”不代表授权代登录，仍按默认方式处理。

任何情况下，都不能用 `--js`、`--force`、直接调用 DOM 或其他脚本绕过登录和验证拦截。


## 站点经验：任务前读取，探索成功后更新

每次探索成功后，都要保存入口、选择器和操作方法，让下一个会话能继续使用。

**固定位置**：`~/.dsh/browser-operator/experiences/<canonical-domain>.md`
（例如 `www.baidu.com` → `baidu.com.md`；子域名保留，只去掉开头的 `www.`）

**每次任务开始前**：

```bash
"$BROWSER" experience show <domain-or-url>
```

- `found:true`：先按 `content` 里的“快速路径”“选择器”和“陷阱”操作，不要从头探索。
- `found:false`：先检查返回的 `related`。如果有同一应用或相似域名在其他环境（dev/sit/uat/prod）的经验，先读最接近的那份。可以参考页面结构，但 URL、账号、机构代号、数据对象 OID 等必须按当前环境重新确认。没有相关经验时，再从头探索。
- `related` 中的 `match` 说明匹配原因：`app` 表示同一应用，`alias` 表示域名别名，`normalized-domain` 表示去掉 dev/sit/uat/prod 等环境词后域名相同。
- 如果 `open` 后发生重定向，例如 127.0.0.1 → localhost、http → https、裸域 → www，用 `experience current` 按最终 `state.url` 中的主机名再查一次。localhost 和 127.0.0.1 建议都查。
- 经验过期或页面改版：更新文件，并用 `log add` 记录变化。

**探索成功后，必须用文件写入工具保存或更新经验**，不能只留在对话中：

- 先读模板：`references/experience-template.md`
- 写入固定路径：`~/.dsh/browser-operator/experiences/<domain>.md`
- 必须包含 YAML frontmatter：`site`、`domain`、`updated`、`confidence`
- 同一应用有多个环境或域名时，建议加 `app`、`environment`、`aliases`：
  - `app`：各环境共用的应用标识，如 `my-admin`，不要带环境名
  - `environment`：`local|dev|sit|test|stage|uat|prod|other`
  - `aliases`：同应用的其他域名（含 `127.0.0.1` 这类别名）
- 必须包含章节：`## 快速路径`、`## 选择器`、`## 结果读取`、`## 陷阱`、`## 空页面/异常兜底`、`## 验证记录`
- 写清下一个会话需要的信息：入口 URL 模板、搜索框和按钮的选择器、结果条目选择器、第 N 个结果的点击规则、详情读取方式，以及广告、懒加载、新标签页等需要注意的情况。
- 只记录站点结构和选择器，不写 Cookie、token、密码、手机号或完整个人数据。
- 写完用 `"$BROWSER" experience validate <domain>` 校验格式。
- 查询同应用其他环境：`"$BROWSER" experience related <domain>`；`experience show` / `experience current` 也会返回 `related` 列表。

**给最终答复前，必须完成以下检查**：

1. 再执行一次 `"$BROWSER" experience show <domain>`；如果本次页面发生过重定向，用 `"$BROWSER" experience current` 以最终 host 复查。
2. 对照本次操作，检查入口 URL、选择器、结果读取方式、失败后的处理方法和注意事项是否有变化。
3. 有新增/变化：更新经验文件，再执行 `experience validate <domain>`。
4. 无论经验有没有变化，都要记录本次运行：`"$BROWSER" log add <domain> "<任务>" --result ok|failed|partial --note "<结果/备注>"`。按实际结果填写 `--result`；任务成功且没有新发现时，记 `ok`，备注写“无新增”。

**验证标准**：新会话不依赖旧对话，只读经验文件，就能用少量命令完成同类任务。验证结果也要写入日志。

## 验证日志

每个域名的验证记录单独存放，不追加到经验文件中：

- **位置**：`~/.dsh/browser-operator/logs/<canonical-domain>/log.md`
- **固定格式**（一行一次，只追加、不改历史行）：
  `- YYYY-MM-DD HH:mm | 任务 | 结果(ok|failed|partial) | 备注`
- **追加**：`"$BROWSER" log add <domain> "<任务>" --result ok|failed|partial --note "<备注>"`
- **查看**：`"$BROWSER" log show <domain> [--limit N]`；全部域名：`"$BROWSER" log list`
- 经验文件的 `## 验证记录` 只保留日志路径。迁移旧经验时，先把原表格或条目原样保存到日志的 `## 历史记录（经验迁移 …）` 下，再将经验中的旧记录替换为日志路径。CLI 不会自动迁移历史内容。
- 使用 `log add` 生成记录，不要手工改格式；`log show` 只能解析上述格式。

## 操作脚本（recipe）

经验文件说明站点结构和操作方法，脚本保存可以重复执行的步骤。同一域名、同一任务已成功执行 2 次（`次数: 2`），第 3 次仍成功时，把步骤写成脚本。以后优先用 `recipe run` 执行，失败后由 Agent 在当前页面继续操作并修正脚本。

**固定位置**：`~/.dsh/browser-operator/脚本/<canonical-domain>.md`（与 `experiences/` 同层级；去掉开头 `www.`，子域名保留）

每个域名保存一份 Markdown。文件开头的 YAML 信息（frontmatter）与经验文件一致，包含 `site`、`domain`、`app`、`environment`、`updated`，可选 `profile`。每个任务用一个 `##` 小节：

````markdown
## 搜索并读取结果
- 次数: 3
- 参数: query=搜索词
- 最近: 2026-11-05

```steps
open https://example.com/ --profile example
fill "#kw" "{{query}}"
click "#su" --wait-nav
wait "#content_left"
query "#content_left"
```
````

规则：

- `steps` 每行一个 `browser` 子命令（不写 `browser` 前缀），支持 `open/goto/state/fill/click/press/select/hover/wait/query/snapshot/screenshot/switch/close/mode/focus/console/network/debug/eval/drag` 等；`stop/status/recipe/experience/profiles` 不允许。
- 动态内容用 `{{name}}` 占位，在 `- 参数:` 行用 `name=说明` 声明，运行时通过 `--var name=value` 传入。不要把真实账号、密码、token、OTP、证件号写进文件或参数说明。
- 不在 `steps` 中保存 `--allow-auth`。只有用户在当前对话明确要求代登录时，才在 `recipe run` 命令上加这个参数；脚本文件不保存授权。滑块和 CAPTCHA 仍由用户完成。
- `--profile` 可以写在第一个 `open` 步骤或 frontmatter 中，`recipe run` 会将它传给后续步骤；单个步骤也可以指定其他 Profile。
- 点击成功后，用 `wait` 或 `--wait-nav` 等待页面变化，再用 `query` 或 `snapshot` 读取结果。除非用户明确要求，否则避免使用 `--js`。

**流程**：

1. 任务开始时，先执行 `"$BROWSER" recipe show <domain> "<任务>"`。返回 `recorded:true` 时，直接用 `"$BROWSER" recipe run <domain> "<任务>" --var name=value` 执行。
2. 没有脚本时，照常操作页面。如果文件或任务小节不存在，先按 `references/recipe-template.md` 创建；还没有验证过的步骤时，删除模板中的示例 `steps`。
3. `recipe run` 返回 `ok:false` 时，查看 `failedStep`、该步的 `error` 和 `screenshot`。使用同一 Profile 在当前页面继续完成任务，不要重新打开页面。成功后修正选择器、等待条件或参数，再执行一次脚本验证；连续两次失败时，删除 `steps` 或只保留文字说明。
4. 本次任务成功后，只执行一次 `"$BROWSER" recipe log <domain> "<任务>"` 来累计次数。返回 `count>=3` 且尚无 `steps` 时，把验证过的步骤写入 `steps` 代码块，再用 `recipe run` 验证。
5. 结束时，用 `log add` 记录实际结果，并说明脚本是否可用、是否修正。`recipe run` 不会自动累计次数、追加验证日志，也不会生成或修正脚本，这些都由 Agent 完成。

查看全部：`"$BROWSER" recipe list [domain-filter]`；只看次数和参数：`recipe show <domain>`。`recipe run --dry-run` 只校验参数与命令，不执行。

## Quick start

The currently locked Playwright dependency requires Node.js 20 or later. You also need npm and Chrome. The `bin/browser` launcher uses Bash, including on Windows. Without Bash, run `node <skill-directory>/scripts/browser.mjs ...` directly. The examples use the default installation path; adjust it if you installed with `--dest` or a custom `DSH_HOME`.

```bash
BROWSER="$HOME/.dsh/skills/browser-operator/bin/browser"

# 1. Install dependencies if the installer has not already done so
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

Chrome runs without a visible window (headless) by default. Add `--headed` to `open`, or use `mode headed`, when a visible window is needed. Detecting login or verification switches it to headed unless `--no-auto-headed` is set. To return to headless, follow the session-cookie guidance below.

**Window focus on macOS.** Before launching visible Chrome, the daemon records which app is in front and tries to return focus to it afterward. Navigation and clicks in headed mode skip `page.bringToFront()`, so the browser may stay behind other apps:

- When the user needs to log in or verify, tell them “Chrome 已在后台打开，请切换过去”, or run `browser focus --profile <name>` to bring it forward.
- `wait-login` and `wait-verification` only check the page repeatedly; they do not bring the window forward.
- If the user asks to watch, run `focus` once so they see it.


Changing mode closes and relaunches Chrome. Plain `open` and `goto` keep the current mode unless you pass `--headed` or `--headless`, or login or verification triggers a visible window. `--no-auto-headed` disables the automatic switch for that navigation. Restarting loses session cookies, such as Tomcat `JSESSIONID`, unless the profile has `restore-session on` (see below).

## Login persistence

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
- Opening the same profile again reuses its cookies and local storage. Ask the user to log in again only if the page shows a login screen.
- Chrome does not reload session cookies without an `Expires` attribute, such as Tomcat `JSESSIONID`, after a restart by default. Run `restore-session on --profile <name>` to use `--restore-last-session` on the next launch. This lets a mode switch or daemon restart retain the login while the server-side session remains valid. The setting is saved per profile and stops the daemon once, taking effect on the next `open`. Duplicate restored tabs are closed automatically.
- `wait-login` polls until `login.likely` becomes false (no visible password input / login URL / "登录超时" text), up to the timeout.
- `state` and `snapshot` include `login.likely`, `login.reasons`, and `challenge.likely`. If `challenge.likely` is true (slider/CAPTCHA), ask the user to complete it in the visible Chrome, then run `wait-verification`.
- The browser stays open between CLI commands, so `sessionStorage`, tabs, and popups survive while the daemon is running.
- Never read, print, copy, or upload `chrome-profile/`, cookies, `daemon.json`, or the daemon token. Do not ask the user to paste a password into chat; let them type it in the visible browser. Only use credentials the user volunteers with an explicit instruction to log in, and never echo them back.

## Browser fingerprint (fixed per profile)

Each profile gets a fingerprint on first launch, stored under `fingerprint` in `~/.dsh/browser-operator/profiles/<name>/settings.json`. It stays the same across pages, reloads, mode switches, and daemon restarts.

- UA/UA-CH: both modes use the same browser identity. The UA keeps the real Chrome major version; UA-CH metadata (`architecture`, `platformVersion`, `bitness`) comes from the host. Headless is the default; use headed when the user needs to log in, verify, or watch the task.
- `navigator`: keeps native values by default because `platform`, `vendor`, and `languages` already match the host. JavaScript overrides require `fingerprint.navigator: true`; sites can detect these changes.
- WebGL: uses the real GPU by default (for example Apple M1 Pro); set `fingerprint.webgl: "spoof"` to pin a renderer or `"off"` to disable WebGL.
- Canvas/Audio: adds noise based on the profile's fixed seed, keeping the fingerprint hash stable across reloads and restarts.
- `navigator.webdriver`: kept `false` by `--disable-blink-features=AutomationControlled`.
- DevTools false positives: `console.table` is deferred by default (`fingerprint.devtoolsFix: true`). CDP serialization makes `console.table` slow, which timing-based devtools detectors (e.g. `devtools-detector`) misread as an open DevTools panel.
- locale/timezone: taken from the OS; macOS `zh-Hans_US` is normalized to `zh-CN`.

Inspect or reset:

```bash
"$BROWSER" fingerprint --profile mysite          # show the stored fingerprint
"$BROWSER" fingerprint --profile mysite --reset  # regenerate it (stops the daemon)
```

Opening a profile on a different operating system, such as moving it from macOS to Windows, automatically rebuilds its fingerprint. Do not reset the fingerprint while logged in to a site: the site will see a different device.

You can override these keys in `settings.json`: `fingerprint.webgl` (`auto` by default, `spoof`, `off`), `fingerprint.navigator` (`false` by default), `fingerprint.canvasNoise`, `fingerprint.audioNoise`, `fingerprint.devtoolsFix` (`true` by default), `userAgent`, `locale`, `timezone`.

## Commands

| Command | Purpose |
|---|---|
| `open <url> [--profile name] [--headed\|--headless] [--no-auto-headed] [--snapshot]` | Open a URL; keep the current mode unless a mode flag is given or manual login/verification requires a visible window |
| `mode headed` / `mode headless` | Switch mode (restarts Chrome; session cookies can be restored with `restore-session on` while the server session remains valid). On macOS, headed launch attempts to restore the previous app's focus |
| `focus` | Bring the visible Chrome window to the front |
| `restore-session on\|off` | Per-profile: relaunch Chrome with `--restore-last-session` so session cookies survive restarts; stops the daemon so it applies on next `open` |
| `fingerprint [--reset]` | Show the profile's fixed fingerprint; `--reset` regenerates it and stops the daemon |
| `goto <url>` | Alias of `open`, with the same flags |
| `state` | Read the current URL, title, tabs, and login hints |
| `snapshot [--mode interactive\|text\|full\|forms] [--selector CSS] [--frame CSS]` | Page structure with suggested selectors |
| `query <selector> [--limit N] [--html] [--all-attrs] [--frame CSS]` | Read text, attributes, and bounds of matching DOM nodes, including non-interactive elements |
| `click <selector> [--nth N] [--wait-for CSS] [--wait-nav] [--frame CSS] [--timeout ms] [--allow-auth]` | Send a real mouse click and report its effect; use `--allow-auth` only when the user explicitly asks you to log in |
| `drag <source> <target> [--nth N] [--target-nth N] [--steps N] [--method auto\|dragTo\|mouse\|js]` | Real drag/drop; auto tries stepped mouse then `dragTo`; `js` needs `--allow-js` |
| `eval <expression>` | Run JavaScript for page-specific handlers; cannot bypass login or verification |
| `fill <selector> <value> [--type] [--append] [--frame CSS] [--allow-auth]` | Fill input; `--type` types with keyboard events; `--allow-auth` only for user-authorized login |
| `press <key> [--allow-auth]` | Keyboard key (e.g. `Enter`, `Escape`, `Tab`); `--allow-auth` only for user-authorized login submit |
| `hover <selector> [--wait ms]` | Real mouse hover; use before clicking hover-only menus |
| `select <selector> <value> [--label] [--allow-auth]` | Select an option; `--allow-auth` only for user-authorized login |
| `wait <selector>` / `wait --url <pattern>` | Wait for element or URL |
| `screenshot [path] [--full-page]` | Save a screenshot; default under `~/.dsh/browser-operator/screenshots` |
| `annotate start\|read\|wait\|cancel [--timeout ms]` | Enable, read, wait for, or disable page annotations; the setting is saved |
| `switch --index N` / `switch --url includes` | Switch active tab |
| `close` | Close the active tab and switch back to the remaining page |
| `wait-login [--timeout ms]` | Wait until the login screen disappears |
| `wait-verification [--timeout ms]` | Wait until a slider/CAPTCHA verification page disappears (user solves it in the headed window) |
| `console [--limit N] [--filter text] [--clear]` | Recent browser console logs and page errors |
| `network [--limit N] [--filter text] [--type xhr\|fetch\|document] [--errors] [--clear]` | Recent requests/responses, status, duration, failures |
| `debug` | Collect page state, a screenshot, and recent Console and Network records |
| `stop` | Close browser and flush the profile |
| `status` | Show daemon mode (headless/headed) without starting one |
| `profiles` | List known profiles and their last URL/title (no secrets) |
| `experience list` | List saved site experiences |
| `experience path <domain>` | Print the fixed experience file path |
| `experience show <domain>` | Read a saved experience; also returns `related` environments |
| `experience related <domain>` | List same-app / alias / normalized-domain experiences without loading full content |
| `experience current [--profile name]` | Resolve the active page URL and read that host's experience |
| `experience validate <domain>` | Validate frontmatter and required sections |
| `log add <domain> "<任务>" --result ok\|failed\|partial [--note text]` | Append one fixed-format verification log line |
| `log show <domain> [--limit N]` | Recent standardized log entries for a domain |
| `log list` | Domains with logs, entry counts and last entry |
| `recipe list [filter]` | List saved operation recipes, their task counters and whether steps exist |
| `recipe show <domain> [task]` | Show a task's params, counter and steps |
| `recipe log <domain> <task>` | Increment that task's `次数` and stamp `最近` |
| `recipe run <domain> <task> [--var k=v]... [--dry-run] [--profile name] [--allow-auth]` | Replay the task's `steps`; stops at the first failure and keeps the page for manual takeover; login requires explicit authorization for this run |

Operational commands return JSON. If `ok:false`, check `error.code`, `error.message`, `error.diagnosis`, and any `error.screenshot`, `error.recentConsole`, or `error.recentNetwork` attachments. If `ok:true`, still check `warning`, `effect`, and whether the requested result was achieved.

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
- If `covered` is returned, another element blocks the click. Close the overlay with `press Escape` or its close button, scroll, or choose a visible element. Do not retry the same covered selector.
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
- A `warning` means the drag ran but no URL or DOM change was observed. Check the source, target, drop position, or component's JavaScript state before treating the action as successful.
- For JS-managed date/time pickers, don't trust `fill` alone: click the field, wait for the visible calendar, then click the target day/cell. Prefer `wait <selector>` over fixed sleeps.
- Use `eval` for page-specific handlers only when real input cannot perform the action. It runs JavaScript rather than trusted mouse or keyboard input, and its response has no `trusted` field. Never use it to bypass login, verification, or CAPTCHA.

## 不同任务需要记录什么

| 任务 | 经验里必须写清楚 |
|---|---|
| 搜索 | 结果页直达 URL 模板，搜索框、提交按钮和结果条目的选择器，广告和重复节点的排除方法。`--nth` 按 DOM 匹配顺序从 1 编号；`query.items` 可能包含隐藏或屏幕外节点，受 `--limit` 限制，`count` 则是总匹配数 |
| 列表 → 详情 | 列表卡片和标题链接的选择器，是否打开新标签页，详情标题和正文的选择器，遇到空页面时怎么处理。详情页不要直接复用列表页的选择器 |
| 表单提交 | 字段的选择器或标签、填写方式（fill/type/select）、提交按钮，以及判断成功或失败的选择器。登录和验证默认由用户完成；明确授权代登录后，相关命令需加 `--allow-auth` |
| 拖拽/排序 | 源元素和目标元素的选择器、`--nth`、`--target-nth`、`--method`、放置位置，以及成功后的 DOM 或 URL 变化 |
| 复杂组件 | 日期选择器、弹层、富文本或级联选择的操作方法。先用 `wait` 等容器可见，再点击可见选项，不要只用 `fill` |
| 文章阅读 | 标题来源（`state.title` 或可见 h1）、正文容器、摘要截取方式、canonical URL，以及分页、懒加载和视频等无关内容的处理方法 |
| 多标签/iframe | 新标签页的切换规则、iframe 选择器和 `--frame` 用法 |
| 弹窗/确认 | 默认 `dismiss`（取消）；需要确认时先执行 `dialog accept`，prompt 的内容用 `--text` 传入。记录 `click` 返回的 `dialogs`，供检查弹窗内容 |

## Workflow for a new site

0. 执行 `experience show <domain>`，先参考已有经验；没有时，按前面的规则查看相关经验，再探索页面。
1. `open <url> --profile <site>`.
2. Check the returned `login`, `challenge`, and `manualAuth`. `open` normally switches to headed when the user needs to log in or verify. If Chrome is still headless, use `mode headed`, `wait-login`, or `wait-verification` to switch. Follow the login rules above: the user handles it unless they explicitly ask you to log in with `--allow-auth`; sliders and CAPTCHAs always require the user. Afterward, stay headed, or switch back only if `restore-session on` was enabled before login, since changing modes restarts Chrome.
3. `snapshot --mode interactive` to get visible elements and suggested selectors.
4. `click <selector>` with `--wait-for` / `--wait-nav` when the page loads asynchronously.
5. After each click, check `trusted`, `effect`, and `warning`; take a screenshot if the result is unclear.
6. 成功后，按 `references/experience-template.md` 保存或更新 `~/.dsh/browser-operator/experiences/<domain>.md`，再执行 `experience validate <domain>`。
7. 给最终答复前，按前面的要求复查经验：执行 `experience show <domain>`，重定向后用 `experience current`。有变化就更新并校验，无论有无变化都用 `log add` 记录本次结果。
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

## Native dialogs

Native `alert`, `confirm`, `prompt`, and `beforeunload` dialogs are dismissed or cancelled by default. Accepting one may submit data, delete an item, publish content, or leave the page, so the CLI requires an explicit command to accept it.

```bash
# Default: dismiss (confirm -> false, prompt -> null)
"$BROWSER" click "#delete" --profile mysite

# Explicitly confirm after inspecting the dialog evidence
"$BROWSER" dialog accept --profile mysite
"$BROWSER" click "#delete" --profile mysite

# Fill a prompt
"$BROWSER" dialog accept --text "yes" --profile mysite
"$BROWSER" click "#rename" --profile mysite

# Inspect or restore the safe default
"$BROWSER" dialog status --profile mysite
"$BROWSER" dialog dismiss --profile mysite
```

- `click` / `open` return `dialogs` with `type`, `message`, `policy`, and `promptText`.
- The policy persists within the daemon, including headed/headless mode switches. Run `dialog dismiss` after the intended confirmation; restarting the daemon also restores `dismiss`.
- Do not confirm login, payment, delete, or publish dialogs automatically. Read the message first and only accept when the action is intended.

## Automatic debugging

When a browser action throws an exception, the CLI tries to attach a screenshot and recent Console and Network records. Validation failures, startup failures, and returned timeout results may have no attachments:

```json
{
  "ok": false,
  "error": {
    "code": "covered",
    "message": "locator.click: Timeout 2000ms exceeded.；中心点被 <DIV> 遮挡",
    "diagnosis": { "covered": true, "topTag": "DIV" },
    "screenshot": "/Users/.../screenshots/error-51job-...png",
    "recentConsole": [ ... ],
    "recentNetwork": [ { "status": 404, "url": "..." } ]
  }
}
```

To collect details yourself:

```bash
"$BROWSER" debug --profile mysite
"$BROWSER" console --profile mysite --limit 30
"$BROWSER" network --profile mysite --errors --limit 30
"$BROWSER" network --profile mysite --type fetch --filter "/api/" --limit 20
"$BROWSER" wait-verification --profile mysite --timeout 120000
```

Each daemon keeps up to 300 Console entries and 500 Network entries. Tokens in URLs are masked; request bodies and headers are not recorded. Use `--clear` to clear the records after reproducing an issue.

For manual login or verification, use `mode headed` or `open --headed`. `wait-login` and `wait-verification` can also switch to headed without a separate `stop`. Mode switches restart Chrome; enable `restore-session on` before login if session cookies need to survive, and remember that the server-side session must still be valid.

## Troubleshooting

| Symptom | Action |
|---|---|
| `covered` | Close the modal/overlay, scroll, or click the visible element; real input cannot penetrate another element |
| `hidden` | Wait for the element, hover its parent, or use `snapshot` to find the visible duplicate |
| `timeout` | Increase `--timeout`, check login state, and re-run `snapshot` |
| `not-found` | Selector is wrong/ambiguous; copy a selector suggested by `snapshot` |
| Chrome not found | Install Google Chrome or set `CHROME_PATH` |
| Daemon start timeout | Check `~/.dsh/browser-operator/profiles/<name>/daemon.log`; run `stop` and retry |
| User cannot see the browser | Run `mode headed` (or `open --headed`), then `focus` to bring it forward |
| Login keeps asking | Confirm the same `--profile` is used; do not delete the profile directory |
| `manual-auth-required` | Ask the user to log in or verify in visible Chrome, then run `wait-login` or `wait-verification`. For login only, if the user explicitly asks you to do it, retry the relevant command with `--allow-auth`. Never bypass the block with `--js` or `--force` |
| Dialog appears and action is cancelled | Default policy is dismiss. Inspect `dialogs`; if the message is safe and confirmation is intended, run `dialog accept` (prompt text via `--text`) and retry |
| `challenge.likely:true` / `verification-timeout` | A slider/CAPTCHA is blocking the page. Ask the user to complete it in the visible Chrome, then run `wait-verification` |

## Notes

- Default mode is headless. On macOS, headed launch attempts to restore the previous app's focus; headed actions do not bring the page forward. Run `focus` when the user needs to see it. `mode headed`/`mode headless` relaunches Chrome with the same profile and attempts to restore the URL.
- Runtime data defaults to `~/.dsh/browser-operator/`; set `BROWSER_OPERATOR_HOME` to change it. `DSH_HOME` and installer `--dest` only change installation locations, not the runtime root. Paths above assume the defaults.
- `open` accepts `file://`, `http://`, and `https://`.
- The daemon is local-only (`127.0.0.1`), token-protected, and exits after 30 idle minutes (configurable with `--idle-minutes`). Mode is stored in `daemon.json` and reported by `status` / `health`.
- This skill is the single entry point for browser operations. If a capability is missing, extend `scripts/browser.mjs` rather than creating a parallel script.
- Always read saved site notes with `experience show` before a task, then save or update them after successful exploration. Record enough detail for the next session to perform the same task without finding the selectors again.
