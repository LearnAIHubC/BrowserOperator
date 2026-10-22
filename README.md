# BrowserOperator

BrowserOperator is an agent skill for persistent Chrome automation. It ships a Node.js CLI that drives a real Chrome window with trusted mouse and keyboard input, keeps one Chrome profile per site so logins survive between commands, and saves a reusable experience file per site so later sessions do not have to rediscover selectors.

Read this in Chinese: [README_CN.md](README_CN.md)

## Features

- Real Playwright mouse clicks through CDP (`locator.click()`), not `el.click()` DOM events.
- One persistent Chrome profile per site; cookies and `localStorage` survive across commands and sessions.
- Headless by default, with automatic escalation to a visible window when a login or verification is required.
- Manual-auth guard: the agent never types credentials, clicks login buttons, or solves CAPTCHAs.
- Snapshot, query, click, drag, fill, select, hover, press, wait, switch, and screenshot primitives.
- Console, network, and dialog capture, with a screenshot attached to every failed action.
- Per-site experience files (`~/.dsh/browser-operator/experiences/<domain>.md`) written after a successful run.
- `restore-session on` keeps session cookies (for example a Tomcat `JSESSIONID`) across browser restarts.
- Native dialogs default to **dismiss/cancel**; `dialog accept` confirms explicitly and `dialog accept --text` fills prompts. `dialogs` evidence is returned by `click` / `open` / `debug`.
- One fixed fingerprint per profile: normal Chrome UA in headless (no `HeadlessChrome`), matching platform/vendor/WebGL, and stable Canvas/Audio noise.

## Requirements

- Node.js 18 or newer
- Google Chrome (or set `CHROME_PATH`)
- npm
- macOS, Linux, or Windows

## Install Into Your Agent

With [DeepSeek Harness](https://github.com/deepseek-ai) (the skill directory is `${DSH_HOME:-$HOME/.dsh}/skills`):

```bash
npx --yes github:LearnAIHubC/BrowserOperator
```

Then restart your agent and use the `browser-operator` skill.

To update an existing installation:

```bash
npx --yes github:LearnAIHubC/BrowserOperator --force
```

The installer copies the skill into `${DSH_HOME:-$HOME/.dsh}/skills/browser-operator`, installs its Node.js dependencies, and creates a launcher at `${DSH_HOME:-$HOME/.dsh}/bin/browser-operator`. Add that `bin` directory to `PATH` if you want to run `browser-operator` without the full path. If you install with `--dest`, use the launcher path printed by the installer.

Manual install:

```bash
git clone https://github.com/LearnAIHubC/BrowserOperator.git /tmp/BrowserOperator
cp -R /tmp/BrowserOperator/skills/browser-operator "$HOME/.dsh/skills/browser-operator"
npm install --prefix "$HOME/.dsh/skills/browser-operator/scripts"
```

## Quick Start

```bash
BROWSER="$HOME/.dsh/skills/browser-operator/bin/browser"

# Open a site with a named profile (headless by default)
"$BROWSER" open "https://example.com" --profile example

# See what is clickable and get ready-to-copy selectors
"$BROWSER" snapshot --mode interactive --profile example

# Real mouse click with effect verification
"$BROWSER" click "button:has-text(\"Save\")" --profile example --wait-for ".success-toast"

# Capture a screenshot
"$BROWSER" screenshot --profile example --full-page
```

Each `--profile` is a separate Chrome profile under `~/.dsh/browser-operator/profiles/<name>`. Use one stable profile per site, for example `--profile github` or `--profile company-sso`.

## Login Persistence

Login and verification are **always manual**. The agent opens the page, detects the login screen, asks you to complete it in the visible Chrome window, and polls until it disappears:

```bash
"$BROWSER" open "https://intranet.example.com" --profile intranet
"$BROWSER" wait-login --profile intranet --timeout 300000
```

While a login or challenge is showing, write actions (`click`, `drag`, `eval`, `fill`, `press`, `select`) are blocked by the CLI. Read-only commands (`snapshot`, `query`, `console`, `network`, `screenshot`, `debug`) still work.

Session cookies have no `Expires` attribute, so Chrome normally does not reload them after a restart. Enable session restore for a profile when you want a mode switch or browser restart to keep the login:

```bash
"$BROWSER" restore-session on --profile intranet
```

The next launch runs Chrome with `--restore-last-session`. Restored duplicate tabs are closed automatically so tabs do not pile up. The setting is per profile and stops the daemon once so it applies on the next `open`.

## Experience Memory

Before exploring a site, read its saved experience:

```bash
"$BROWSER" experience show example.com
```

If `open` redirects to a different host, use `experience current` to resolve the final page host and read that experience instead:

```bash
"$BROWSER" experience current --profile example
```

After a successful exploration, write `~/.dsh/browser-operator/experiences/<domain>.md` using `references/experience-template.md`, then validate it:

```bash
"$BROWSER" experience validate example.com
```

A good experience file records the entry URL, selectors, result-ordering rules, traps, and a verification log so the next session can finish the same task in a few commands.

Before giving the final answer, run `experience show <domain>` again. If the task added or changed anything, update the file and append a verification row; if nothing changed, still append a short "no new findings" row. Do not finish the task before this close-out check.

## Fingerprint

Each profile creates a single fingerprint on first launch and stores it in `~/.dsh/browser-operator/profiles/<name>/settings.json`. It stays the same across pages, reloads, headed/headless switches, and daemon restarts.

- **UA/UA-CH**: the same identity is injected in headed and headless mode (real Chrome major version plus host architecture/platformVersion/bitness), so mode switches never change the fingerprint. Headless is the default.
- **navigator**: left native by default; JS overrides are opt-in because tampering is detectable.
- **WebGL**: uses the real GPU by default (for example Apple M1 Pro); `"spoof"` pins a renderer, `"off"` disables WebGL.
- **Canvas/Audio**: deterministic noise from the profile seed, so the fingerprint hash is stable.
- **locale/timezone**: taken from the OS (macOS `zh-Hans_US` is normalized to `zh-CN`).
- **webdriver**: kept `false` by `--disable-blink-features=AutomationControlled`.
- **DevTools false positive**: `console.table` is deferred by default (`devtoolsFix`), because CDP console serialization makes timing-based devtools detectors think DevTools is open.

```bash
"$BROWSER" fingerprint --profile example          # show the stored fingerprint
"$BROWSER" fingerprint --profile example --reset  # regenerate it (stops the daemon)
```

Override via `settings.json`: `fingerprint.webgl` (`auto` by default, `spoof`, `off`), `fingerprint.navigator` (`false` by default), `fingerprint.canvasNoise`, `fingerprint.audioNoise`, `fingerprint.devtoolsFix` (`true` by default), `userAgent`, `locale`, `timezone`.

## Common Commands

| Command | Purpose |
|---|---|
| `open <url> [--profile name] [--headed\|--headless] [--no-auto-headed] [--snapshot]` | Open a URL; keeps the current mode unless a mode flag is given |
| `goto <url>` | Same as `open` without snapshot |
| `state` | Current URL, title, tabs, login and challenge hints |
| `snapshot [--mode interactive\|text\|full\|forms] [--selector CSS]` | Page structure with suggested selectors |
| `query <selector> [--limit N] [--html] [--all-attrs]` | Read matched DOM nodes, including non-interactive elements |
| `click <selector> [--nth N] [--wait-for CSS] [--wait-nav]` | Real mouse click plus effect verification |
| `drag <source> <target> [--nth N] [--target-nth N] [--steps N] [--method auto\|dragTo\|mouse\|js]` | Real drag/drop; auto tries stepped mouse then `dragTo`; `js` needs `--allow-js` |
| `eval <expression>` | Explicit JS escape hatch for page-specific handlers; never bypasses login/verification |
| `fill <selector> <value> [--type] [--append]` | Fill an input; `--type` sends real keyboard events |
| `press <key>` | Send a keyboard key |
| `hover <selector>` | Real mouse hover |
| `select <selector> <value> [--label]` | Select an option |
| `wait <selector>` / `wait --url <pattern>` | Wait for an element or URL |
| `screenshot [path] [--full-page]` | Save a screenshot |
| `switch --index N` / `switch --url includes` | Switch the active tab |
| `mode headed` / `mode headless` | Switch mode (restarts Chrome) |
| `dialog accept [--text value]` / `dialog dismiss` / `dialog status` | Dialog policy; default is dismiss/cancel |
| `restore-session on\|off` | Persist session cookies across browser restarts |
| `fingerprint [--reset]` | Show the profile's fixed fingerprint; `--reset` regenerates it |
| `wait-login [--timeout ms]` | Wait until the login screen disappears |
| `wait-verification [--timeout ms]` | Wait until a slider/CAPTCHA disappears |
| `console` / `network` / `debug` | Diagnostics: logs, requests, screenshot, recent dialogs |
| `close` / `stop` / `status` | Tab control and daemon lifecycle |
| `profiles` | List known profiles without secrets |
| `experience list\|path\|show\|validate\|current` | Experience memory operations; `current` resolves the active page host |

## Safety Model

- Credentials are entered only by the user in the visible Chrome window. The CLI never receives a password, OTP, or cookie value.
- The CLI never prints, copies, or uploads `chrome-profile/`, cookies, `daemon.json`, or the daemon token.
- Profiles, screenshots, and experience files stay under `~/.dsh/browser-operator/` and are never committed to this repository.
- The default mode is headless; the browser becomes visible only when the site requires manual authentication.
- Dialogs are never auto-confirmed. The default is dismiss/cancel; confirmation requires an explicit `dialog accept`.
- `eval` is an explicit JavaScript escape hatch for page-specific handlers; it is blocked on login/verification pages and must not be used to bypass manual auth.
- No telemetry and no network calls other than the pages you open.

## Project Layout

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

## Validation

Check the CLI syntax:

```bash
node --check skills/browser-operator/scripts/browser.mjs
```

Check the installer syntax:

```bash
node --check bin/install.mjs
```

Validate a saved experience file:

```bash
"$HOME/.dsh/skills/browser-operator/bin/browser" experience validate example.com
```

## Packaging

Preview the npm package contents:

```bash
npm pack --dry-run
```

## Friendly Links

- [LINUX DO](https://linux.do/) - A new ideal community and gathering place for technology enthusiasts.

## License

MIT License. See [LICENSE](LICENSE).
