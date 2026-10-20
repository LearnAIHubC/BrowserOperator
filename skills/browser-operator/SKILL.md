---
name: browser-operator
description: "Persistent Chrome automation for real mouse clicks: headless by default, with dynamic headed switching when the user must log in or complete verification. Hard manual-auth rule: the agent must NEVER perform login or verification — no typing credentials, clicking login/register/send-code/QR, or solving sliders/CAPTCHA; the user does all login and verification in the visible browser. Use for opening sites, reusing existing sessions, snapshots, clicks, hover, forms, iframes, screenshots, console/network debugging. It reads a saved per-site experience before exploring and writes a reusable experience md after a successful run. Profiles keep cookies/localStorage. Triggers include 浏览器点击, 打开网站, 登录网站, 保存登录, 保持登录, real click, browser automation."
---

# Browser Operator

Use this skill for **all** browser click/automation work. Do not write one-off Playwright/CDP scripts, and do not use `el.click()` / DOM events as the default path. The bundled CLI owns a persistent Chrome profile and a local daemon, so login state survives between commands and between sessions.


## Hard rule: login and verification are ALWAYS manual

- **Never** type a username, password, phone number, OTP, or any credential.
- **Never** click 登录 / 注册 / 登录/注册 / 发送验证码 / 扫码登录 / Sign in / Log in / Continue with ..., and never submit a login form.
- **Never** solve or interact with a slider, CAPTCHA, "访问验证", "滑动验证", "人机验证", or similar challenge. Do not click, drag, refresh, or retry it.
- The agent only: opens the page, detects `login.likely` / `challenge.likely` / `manualAuth`, tells the user, and passively polls with `wait-login` or `wait-verification`.
- While `manualAuth.required` is true, the CLI blocks `click`, `fill`, `press`, and `select` with `manual-auth-required`. Use `snapshot`, `query`, `console`, `network`, `screenshot`, and `debug` only.
- Do not try to bypass the guard with `--js`, `--force`, direct DOM calls, or another script. If the user asks the agent to log in or solve verification, refuse and ask them to do it in the visible browser.


## 经验记忆（强制，先读后写）

这个 skill 不只是浏览器，还要把每次探索沉淀成可复用的经验，避免新会话重新摸索。

**固定位置**：`~/.dsh/browser-operator/experiences/<canonical-domain>.md`
（例如 `www.baidu.com` → `baidu.com.md`；子域名保留，只去掉开头的 `www.`）

**每次任务开始前**：

```bash
"$BROWSER" experience show <domain-or-url>
```

- `found:true`：先按 `content` 里的“快速路径/选择器/陷阱”执行，不要从头探索。
- `found:false`：正常探索；成功后必须写经验。
- 经验过期或页面改版：更新文件，并在“验证记录”里注明。

**探索成功后必须写/更新经验**（用 `write` 工具写文件，不要只留在对话里）：

- 先读模板：`references/experience-template.md`
- 写入固定路径：`~/.dsh/browser-operator/experiences/<domain>.md`
- 必须包含 YAML frontmatter：`site`、`domain`、`updated`、`confidence`
- 必须包含章节：`## 快速路径`、`## 选择器`、`## 结果读取`、`## 陷阱`、`## 空页面/异常兜底`、`## 验证记录`
- 写“下一个会话能直接照做”的信息：入口 URL 模板、搜索框/按钮选择器、结果条目选择器、按第 N 个结果点击的规则、详情读取方式、广告/懒加载/新标签页等陷阱。
- 不写 cookies、token、密码、手机号、完整个人数据；只写站点结构和选择器。
- 写完用 `"$BROWSER" experience validate <domain>` 校验格式。

**新会话验证标准**：不依赖旧对话，只读这份 md，就能在少量命令内完成同类任务。验证后再把结果补充到“验证记录”。

## Quick start

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
#    Ask the user to complete login/verification, then wait:
"$BROWSER" wait-login --profile mysite --timeout 300000
#    After the user is done, switch back for speed:
"$BROWSER" mode headless --profile mysite

# 5. See what is clickable (returns selectors you can copy)
"$BROWSER" snapshot --mode interactive --profile mysite

# 6. Real mouse click; verifies page received a trusted click
"$BROWSER" click "button:has-text(\"保存\")" --profile mysite --wait-for ".success-toast"

# 7. Close the browser when done; the profile keeps login state
"$BROWSER" stop --profile mysite
```

The default mode is **headless** for speed. Add `--headed` to `open` when you want to watch, or use `mode headed` at any time. Login/verification automatically escalates to headed (unless `--no-auto-headed`) and can be switched back with `mode headless`.

Changing mode **closes and relaunches Chrome**. `open`/`goto` only switch mode when `--headed`/`--headless` is passed explicitly; otherwise the current mode is kept, so plain navigation never restarts the browser (and never drops the login). Restarting still loses session cookies (e.g. Tomcat `JSESSIONID`) unless the profile has `restore-session on` (see below).

## Login persistence (the required flow)

```
open target site (headless) → reuse existing profile
  → if login/verification is needed: mode headed (or auto-escalated by open)
  → user logs in / solves verification in the visible Chrome
  → wait-login / wait-verification
  → mode headless
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
- Never read, print, copy, or upload `chrome-profile/`, cookies, `daemon.json`, or the daemon token. Never ask the user to paste a password into chat; login happens in the visible browser.

## Browser fingerprint (fixed per profile)

Every profile gets **one stable fingerprint** on first launch, stored in `~/.dsh/browser-operator/profiles/<name>/settings.json` under `fingerprint`. It does not change between pages, reloads, headed/headless switches, or daemon restarts.

- UA: headed Chrome uses its native UA and UA-CH. Headless replaces only the `HeadlessChrome` token and supplies matching UA-CH metadata (architecture, platformVersion, bitness), so the page sees the host OS rather than `x86 / 10_15_7`. The Chrome version comes from the installed binary (Windows: the version directory), with the running browser version persisted as a fallback.
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
| `open <url> [--profile name] [--headed|--headless] [--no-auto-headed] [--snapshot]` | Open URL; keeps current mode unless a mode flag is given; auto-heads on manual auth |
| `mode headed` / `mode headless` | Switch mode (restarts Chrome; with `restore-session on` cookies/login survive) |
| `restore-session on\|off` | Per-profile: relaunch Chrome with `--restore-last-session` so session cookies survive restarts; stops the daemon so it applies on next `open` |
| `fingerprint [--reset]` | Show the profile's fixed fingerprint; `--reset` regenerates it and stops the daemon |
| `goto <url>` | Same as open without snapshot |
| `state` | Current URL/title/pages/login hints |
| `snapshot [--mode interactive\|text\|full\|forms] [--selector CSS] [--frame CSS]` | Page structure with suggested selectors |
| `query <selector> [--limit N] [--html] [--all-attrs] [--frame CSS]` | Read matched DOM nodes (text/attrs/rect), including non-interactive divs |
| `click <selector> [--nth N] [--wait-for CSS] [--wait-nav] [--frame CSS] [--timeout ms]` | Real mouse click + effect verification |
| `fill <selector> <value> [--type] [--append] [--frame CSS]` | Fill input; `--type` types with keyboard events |
| `press <key>` | Keyboard key (e.g. `Enter`, `Escape`, `Tab`) |
| `hover <selector> [--wait ms]` | Real mouse hover; use before clicking hover-only menus |
| `select <selector> <value> [--label]` | Select an option |
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
| `status` | Daemon/browser status without starting one |
| `profiles` | List known profiles and their last URL/title (no secrets) |
| `experience list` | List saved site experiences |
| `experience path <domain>` | Print the fixed experience file path |
| `experience show <domain>` | Read a saved experience before exploring |
| `experience validate <domain>` | Validate frontmatter and required sections |

All commands return JSON. `ok:false` means the action failed; inspect `error.code`, `error.message`, `error.diagnosis`, and the automatic `error.screenshot` / `error.recentConsole` / `error.recentNetwork` attachments.

## Real click rules

`click` uses Playwright's `locator.click()`: it scrolls the element into view, waits for actionability, verifies the hit target, and dispatches trusted CDP mouse input. It returns:

```json
{
  "ok": true,
  "method": "playwright-mouse",
  "trusted": true,
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

- **Do not use `--js`** unless the user explicitly asks for a DOM click or the page is impossible to drive with real input. `--js` returns `trusted:false` and is not a real mouse click.
- `--force` skips actionability checks but still clicks the real screen coordinates; it can hit an overlay. Use only with a clear reason.
- If `covered` is returned, a real click cannot reach the target — a human would hit the overlay too. First close the overlay (`press Escape`, click a close button), scroll, or choose the visible element. Do not retry the same covered selector.
- If `warning` says the page received no click event or no observable change, run `snapshot` again and verify the selector/coordinates before retrying.
- For hover-only menus: `hover` the parent, then `click` the item that appeared.
- For iframes: pass `--frame "#iframe-id"` to `click`, `snapshot`, `fill`, etc. Playwright resolves the frame internally.
- For links/buttons that open a new tab: the daemon switches the active page automatically and returns `effect.newPage:true`; use `switch` to go back.


## 通用任务模式（写经验时套用）

| 任务 | 经验里必须写清楚 |
|---|---|
| 搜索 | 结果页直达 URL 模板、搜索框/提交按钮、结果条目选择器、`--nth` 从 1 开始的规则、广告/重复节点；序号以 `items` 的可见顺序为准，`count` 可能更大 |
| 列表 → 详情 | 列表卡片选择器、标题链接选择器、点击是否新标签页、详情标题/正文选择器、空页面兜底；详情页不要复用列表选择器 |
| 表单提交 | 字段选择器/标签、填写方式（fill/type/select）、提交按钮、成功/失败判定选择器；登录/验证永远人工 |
| 文章阅读 | 标题来源（`state.title` / 可见 h1）、正文容器、摘要截取方式、canonical 干净 URL、分页/懒加载/视频噪音 |
| 多标签/iframe | 新标签页切换规则、iframe 选择器、`--frame` 用法 |

## Workflow for a new site

0. `experience show <domain>`。有经验就直接照做；没有才探索。
1. `open <url> --profile <site>`.
2. Read the returned `login` / `challenge` / `manualAuth`. By default `open` auto-switches to headed when manual auth is needed. If it is still headless, run `mode headed` (or `wait-login` / `wait-verification`, which also escalates). Ask the user to complete it; after they finish you can stay headed (fast enough) or run `mode headless` if the profile has `restore-session on`, otherwise switching modes restarts Chrome and drops session cookies.
3. `snapshot --mode interactive` to get visible elements and suggested selectors.
4. `click <selector>` with `--wait-for` / `--wait-nav` when the page loads asynchronously.
5. After each click, check `trusted`, `effect`, and `warning`; take a screenshot if the result is unclear.
6. 成功后按 `references/experience-template.md` 写/更新 `~/.dsh/browser-operator/experiences/<domain>.md`，并 `experience validate <domain>`。
7. When done, `stop` to flush the profile. The next `open` with the same profile is already logged in.

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

## Automatic debugging

Every failed action automatically attaches a screenshot and recent console/network entries, so you can diagnose without guessing:

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
| User cannot see the browser | Run `mode headed` (or `open --headed`); check `status` for the current mode |
| Login keeps asking | Confirm the same `--profile` is used; do not delete the profile directory |
| `manual-auth-required` | The page needs the user to log in or complete verification. Do not retry with `--js`/`--force`; ask the user to finish it in the visible Chrome, then use `wait-login` / `wait-verification` |
| `challenge.likely:true` / `verification-timeout` | A slider/CAPTCHA is blocking the page. Ask the user to complete it in the visible Chrome, then run `wait-verification` |

## Notes

- Default mode is headless; headed Chrome is brought to front only when manual auth is needed or `--headed` is used. `mode headed`/`mode headless` switches dynamically while preserving the URL and profile.
- `open` accepts `file://`, `http://`, and `https://`.
- The daemon is local-only (`127.0.0.1`), token-protected, and exits after 30 idle minutes (configurable with `--idle-minutes`). Mode is stored in `daemon.json` and reported by `status` / `health`.
- This skill is the single entry point for browser operations. If a capability is missing, extend `scripts/browser.mjs` rather than creating a parallel script.
- Experience memory is part of the skill contract: read `experience show` first; write/update the fixed md after a successful exploration. The next session must be able to finish the same site without re-discovering selectors.
