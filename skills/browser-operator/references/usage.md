# BrowserOperator Usage Reference

Installation options, CLI commands, login recovery, site records, and configuration. Start with the project README if this is your first use.

[Project README](../../../README.md) · [中文](usage_CN.md)

## Requirements

- Node.js 20 or newer (required by the currently locked `playwright-core` dependency)
- Google Chrome (or set `CHROME_PATH`)
- npm
- macOS, Linux, or Windows. `bin/browser` is a Bash script, and the Windows launcher also uses Bash; install Git Bash or an equivalent. Without Bash, run `node <skill-directory>/scripts/browser.mjs ...` directly.

Command examples below use Bash.

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

Install into another agent's skills directory (`--dest` is the parent directory; the installer creates `browser-operator/` inside it):

```bash
npx --yes github:LearnAIHubC/BrowserOperator --dest "$HOME/my-agent/skills"
```

The installer also accepts `--no-bin` (skip launcher creation) and `--help`. The `npx` entry point installs the skill; browser commands use the installed `bin/browser` or `browser-operator` launcher.

Manual install:

```bash
git clone https://github.com/LearnAIHubC/BrowserOperator.git /tmp/BrowserOperator
mkdir -p "$HOME/.dsh/skills"
cp -R /tmp/BrowserOperator/skills/browser-operator "$HOME/.dsh/skills/browser-operator"
npm install --prefix "$HOME/.dsh/skills/browser-operator/scripts"
```

## Quick Start

```bash
BROWSER="$HOME/.dsh/skills/browser-operator/bin/browser"

# Read any saved site experience first
"$BROWSER" experience show example.com

# Open a site with a named profile (headless by default)
"$BROWSER" open "https://example.com" --profile example

# See what is clickable and get ready-to-copy selectors
"$BROWSER" snapshot --mode interactive --profile example

# Read the page heading
"$BROWSER" query "h1" --profile example

# Capture a screenshot
"$BROWSER" screenshot --profile example --full-page

# Close the browser and save the profile when done
"$BROWSER" stop --profile example
```

Each `--profile` is a separate Chrome profile under `~/.dsh/browser-operator/profiles/<name>`. Use one stable profile per site, for example `--profile github` or `--profile company-sso`.

## Login Persistence

Login is manual by default. The agent opens the page, checks `login`, `challenge`, and `manualAuth`, and switches to headed when needed. Run `focus` if the window is behind other apps:

```bash
# Enable before login if session cookies must survive restarts (stops any running daemon)
"$BROWSER" restore-session on --profile intranet
"$BROWSER" open "https://intranet.example.com" --profile intranet
"$BROWSER" focus --profile intranet
"$BROWSER" wait-login --profile intranet --timeout 300000
# If a slider/CAPTCHA appears, wait for the user to complete it
"$BROWSER" wait-verification --profile intranet --timeout 120000
```

While a login or challenge is showing, `click`, `drag`, `eval`, `fill`, `press`, and `select` are blocked by default. Read-only commands (`snapshot`, `query`, `console`, `network`, `screenshot`, `debug`) still work.

**Only when the user explicitly asks the agent to log in**, `click`, `fill`, `press`, and `select` may use `--allow-auth`. This applies only to `manualAuth.kind === "login"`; sliders/CAPTCHAs remain manual, and `drag` / `eval` stay blocked. Never store credentials in experiences, recipes, logs, or final output.

Login and verification detection use page heuristics. A successful `wait-login` / `wait-verification` means the corresponding hints disappeared; confirm the actual login result through an authenticated page element.

Session cookies have no `Expires` attribute, so Chrome normally does not reload them after a restart. Enable session restore for a profile when you want a mode switch or browser restart to keep the login:

```bash
"$BROWSER" restore-session on --profile intranet
```

The next launch runs Chrome with `--restore-last-session` and reduces restored tabs to one. The setting is per profile and stops the daemon once so it applies on the next `open`; the server-side session must still be valid.

`mode headed` / `mode headless` closes and relaunches Chrome, attempting to restore the current URL. Stay headed after login if session restore is off. Plain `open` / `goto` keeps the current mode, except for automatic escalation on login/verification; `--no-auto-headed` disables that escalation for the navigation.

## Experience Memory

Before exploring a site, read its saved experience:

```bash
"$BROWSER" experience show example.com
```

If `open` redirects to a different host, use `experience current` to resolve the final page host and read that experience instead:

```bash
"$BROWSER" experience current --profile example
```

After a successful exploration, write `~/.dsh/browser-operator/experiences/<domain>.md` using the [experience template](experience-template.md), then validate it:

```bash
"$BROWSER" experience validate example.com
```

A good experience file records the entry URL, selectors, result-ordering rules, traps, and error fallbacks so the next session can finish the same task in a few commands. Its `## 验证记录` section only points to the log; append actual run records with `log add`. Domains are lowercased and stripped of a leading `www.`; other subdomains are preserved.

For apps deployed to multiple environments, add optional frontmatter:

```yaml
app: my-admin              # stable across dev/sit/uat/prod
environment: uat
aliases: [my-admin.example.com, 127.0.0.1]
```

`experience show` and `experience current` return a `related` list of same-app, alias, or normalized-domain experiences (dev/sit/uat/prod). `experience related <domain>` lists them explicitly. Reuse structure only; re-check environment-specific URLs, accounts, institute IDs, and object IDs.

At the end of a task, review the saved experience with `experience show <domain>` (or `experience current` after a redirect). Update and revalidate any changes, then log the run as described below; use a "no new findings" note when appropriate.

## Verification Logs

Logs live separately at `~/.dsh/browser-operator/logs/<domain>/log.md`. Each run appends one line: `- YYYY-MM-DD HH:mm | task | ok/failed/partial | note`.

```bash
"$BROWSER" log add example.com "Read page heading" --result ok --note "No new findings"
"$BROWSER" log show example.com --limit 10
"$BROWSER" log list
```

Use `ok`, `failed`, or `partial` for `--result`, matching the actual outcome. New log files are created automatically, but `log add` does not migrate historical entries from experience files. Preserve those entries when migrating, then leave a log-path pointer under `## 验证记录` in the experience.

## Operation Recipes

Experiences describe site structure; recipes store replayable steps. Create `~/.dsh/browser-operator/脚本/<domain>.md` from the [recipe template](recipe-template.md), with one `##` section per task. After the third stable completion, the agent writes a `steps` block with `{{name}}` placeholders for dynamic values.

```bash
# Inspect a saved task; create the file and task section from the template first
"$BROWSER" recipe show example.com "搜索并读取结果"

# Validate parameters and commands without opening a browser or executing steps
"$BROWSER" recipe run example.com "搜索并读取结果" --var query="example query" --dry-run

# Replace template selectors with real site selectors before execution
"$BROWSER" recipe run example.com "搜索并读取结果" --var query="example query" --profile example

# Increment the counter after a successful task; append its verification log separately
"$BROWSER" recipe log example.com "搜索并读取结果"
"$BROWSER" recipe list
```

- Each `steps` line is a CLI subcommand without the `browser` prefix; arbitrary shell scripts are not executed.
- Set `--profile` on a step or in frontmatter. The run-level `--profile` is injected into steps that lack one; explicit per-step profiles are preserved.
- Never store credentials or `--allow-auth` in steps. Only explicit user authorization in the current conversation permits `recipe run --allow-auth`, which forwards the flag to `click` / `fill` / `press` / `select`.
- Failure returns `failedStep` and a best-effort `screenshot`. Take over with the same profile, repair the steps, then verify again.
- `recipe run` does not record/repair recipes, increment counters, or append verification logs automatically; the agent performs those actions separately.

## Data Directories and Configuration

| Setting | Purpose |
|---|---|
| `CHROME_PATH` | Chrome executable path |
| `DSH_HOME` | Installer root, default `~/.dsh`; controls skill and launcher locations |
| `BROWSER_OPERATOR_HOME` | CLI runtime data root, default `~/.dsh/browser-operator`; does not follow `DSH_HOME` or `--dest` automatically |

The paths below use the default runtime root:

```text
~/.dsh/browser-operator/
|-- profiles/<name>/       # Chrome profile, settings.json, daemon logs
|-- screenshots/           # Screenshots and error captures
|-- experiences/<domain>.md
|-- logs/<domain>/log.md
`-- 脚本/<domain>.md
```

Each profile has a local daemon that exits after 30 idle minutes by default; set `--idle-minutes` when starting it to change the timeout.

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

Avoid resetting the fingerprint on a logged-in site. Moving the profile to another OS rebuilds it automatically; Chrome updates also change the UA version.

Override via `settings.json`: `fingerprint.webgl` (`auto` by default, `spoof`, `off`), `fingerprint.navigator` (`false` by default), `fingerprint.canvasNoise`, `fingerprint.audioNoise`, `fingerprint.devtoolsFix` (`true` by default), `userAgent`, `locale`, `timezone`.

## Common Commands

| Command | Purpose |
|---|---|
| `open <url> [--profile name] [--headed\|--headless] [--no-auto-headed] [--snapshot]` | Open a URL; keeps the current mode unless a mode flag is given |
| `goto <url>` | Alias of `open`, with the same flags |
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
| `mode headed` / `mode headless` | Switch mode (restarts Chrome); `headed` / `headless` are shorthand aliases |
| `focus` | Bring headed Chrome to the foreground |
| `dialog accept [--text value]` / `dialog dismiss` / `dialog status` | Dialog policy; default is dismiss/cancel |
| `restore-session on\|off` | Persist session cookies across browser restarts |
| `fingerprint [--reset]` | Show the profile's fixed fingerprint; `--reset` regenerates it |
| `wait-login [--timeout ms]` | Wait until the login screen disappears |
| `wait-verification [--timeout ms]` | Wait until a slider/CAPTCHA disappears |
| `console` / `network` / `debug` | Diagnostics: logs, requests, screenshot, recent dialogs |
| `close` / `stop` / `status` | Close the active tab (keeping at least one) / stop the browser / inspect status without starting a daemon |
| `profiles` | List known profiles without secrets |
| `experience list\|path\|show\|related\|validate\|current` | Experience memory operations; `related` finds same-app environments, `current` resolves the active page host |
| `log add <domain> "task" --result ok\|failed\|partial [--note text]` | Append a verification log line |
| `log show <domain> [--limit N]` / `log list` | Read a domain's logs / list all logs |
| `recipe list [filter]` / `recipe show <domain> [task]` | Inspect saved recipes and tasks |
| `recipe log <domain> <task>` | Increment the task counter and update its last-run date |
| `recipe run <domain> <task> [--var k=v]... [--dry-run] [--profile name] [--allow-auth]` | Validate or replay a task; login requires explicit authorization for this run |

`click`, `fill`, `press`, and `select` accept `--allow-auth` under the conditions in “Login Persistence”. `snapshot`, `query`, `click`, `drag`, `fill`, `hover`, `select`, and element-based `wait` accept `--frame CSS`. `--nth` / `--target-nth` start at 1; `switch --index` starts at 0.

Operational commands return JSON. `ok:false` indicates failure; even with `ok:true`, inspect `warning`, `effect`, and the business success condition. Browser action exceptions trigger best-effort `error.screenshot`, `error.recentConsole`, and `error.recentNetwork` attachments; argument validation or startup failures may have no screenshot.

`click` sends real mouse input by default. Explicit `--js` uses a DOM click and returns `trusted:false`. With either method, check the resulting page state before treating the business action as successful.

## Safety Model

- By default, the user enters credentials in visible Chrome. Only explicit authorization in the current conversation permits the agent to use credentials volunteered by the user, with `--allow-auth` on the relevant commands. Never read, export, or share cookies.
- The CLI never prints, copies, or uploads `chrome-profile/`, cookies, `daemon.json`, or the daemon token.
- Profiles, default screenshots, experiences, logs, and recipes stay under the runtime root; do not commit local runtime data. `screenshot [path]` can explicitly save elsewhere.
- The default mode is headless. Login/verification may trigger headed mode, or it can be selected with `--headed` / `mode headed`.
- Dialogs default to dismiss/cancel. Set `dialog accept` explicitly before confirming, then restore `dialog dismiss`. The policy persists within the daemon, including mode switches; restarting the daemon restores dismiss.
- `eval` is an explicit JavaScript escape hatch for page-specific handlers; it is blocked on login/verification pages and must not be used to bypass manual auth.
- No telemetry and no network calls other than the pages you open.

## Project Layout

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

## Validation

Check the CLI syntax:

```bash
node --check skills/browser-operator/scripts/browser.mjs
```

Check the installer syntax:

```bash
node --check bin/install.mjs
```

Install dependencies to use the repository CLI (no arguments prints usage and exits with code 2):

```bash
npm ci --prefix skills/browser-operator/scripts
node skills/browser-operator/scripts/browser.mjs
```

Validate an experience or recipe after creating it from the template:

```bash
BROWSER="$PWD/skills/browser-operator/bin/browser"
"$BROWSER" experience validate example.com
"$BROWSER" recipe run example.com "搜索并读取结果" --var query="example query" --dry-run
```

## Packaging

Preview the npm package contents:

```bash
npm pack --dry-run
```

## License

MIT License. See [LICENSE](../../../LICENSE).
