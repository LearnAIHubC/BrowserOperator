# BrowserOperator Usage Reference

This guide explains how to install the skill, run commands, restore logins, save site notes, and change settings. If this is your first use, start with the project README.

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

The installer copies the skill into `${DSH_HOME:-$HOME/.dsh}/skills/browser-operator`, installs its Node.js dependencies, and creates a launcher at `${DSH_HOME:-$HOME/.dsh}/bin/browser-operator`.

Add that `bin` directory to `PATH` to run `browser-operator` without the full path. If you install with `--dest`, use the launcher path printed by the installer.

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

Each `--profile` keeps separate Chrome browser data under `~/.dsh/browser-operator/profiles/<name>`. Use the same profile name whenever you return to a site, for example `--profile github` or `--profile company-sso`.

## Login Persistence

By default, the user logs in through a visible Chrome window. The agent opens the page, checks `login`, `challenge`, and `manualAuth`, then switches to visible-window mode (headed) when needed. Run `focus` if the window is behind other apps:

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

Only when the user explicitly asks the agent to log in may `click`, `fill`, `press`, and `select` use `--allow-auth`. The flag applies only to `manualAuth.kind === "login"`; `drag` and `eval` stay blocked. The user always completes sliders and CAPTCHAs. Never store credentials in site notes, recipes, logs, or final output.

The tool checks page features to detect login and verification screens. A successful `wait-login` or `wait-verification` only means the corresponding hints disappeared. Check an element on the logged-in page to confirm the actual result.

Session cookies have no `Expires` attribute, so Chrome normally does not reload them after a restart. Enable session restore for a profile when you want a mode switch or browser restart to keep the login:

```bash
"$BROWSER" restore-session on --profile intranet
```

The next launch runs Chrome with `--restore-last-session` and keeps one restored tab. The setting is saved per profile. Running this command stops the background process (daemon) so the setting takes effect on the next `open`. The server-side session must still be valid.

`mode headed` and `mode headless` close and relaunch Chrome, attempting to restore the current URL. Stay headed after login if session restore is off, to avoid losing session cookies when switching modes.

Plain `open` and `goto` keep the current mode, but detecting login or verification can still trigger a visible window. Use `--no-auto-headed` to disable that automatic switch for the navigation.

## Page Annotations

To show the agent which part of a page you mean, click “圈选标注” at the bottom right of the visible browser and draw a rectangle. The agent uses `annotate read` to read the DOM elements, text, CSS selectors, bounds (`rect`), and center points (`center`) in that area, without taking a screenshot.

```bash
# Enable annotations when the user needs them, then bring the window forward
"$BROWSER" annotate start --profile example
"$BROWSER" focus --profile example

# Read after the user draws a box; coordinates are CSS pixels within the viewport
"$BROWSER" annotate read --profile example

# Or wait for the user to draw, then read the selection
"$BROWSER" annotate wait --profile example --timeout 150000
```

`annotate wait` enables annotations before waiting for the user to draw. If Chrome is headless, both commands that enable annotations switch to headed and restart the browser. If session cookies need to survive, enable session restore before login as described under “Login Persistence”.

The × at the top right of a box deletes that box. “清空标注” clears all boxes and exits drawing while keeping the button; Esc only exits drawing. When the user asks to turn annotations off, run `annotate cancel --profile example`.

Annotations are enabled by default. The `annotationEnabled` setting in `~/.dsh/browser-operator/config.json` is shared by all profiles. `annotate start` enables it and `annotate cancel` disables it; the setting remains in effect across navigation and restarts. With `BROWSER_OPERATOR_HOME` set, the configuration file lives in that directory. Records returned by `annotate read` are saved under `annotations/` in the runtime data directory.

## Save and Reuse Site Notes

Before exploring a site, read its saved notes:

```bash
"$BROWSER" experience show example.com
```

If `open` redirects to a different host, use `experience current` to read the notes for the final page's host:

```bash
"$BROWSER" experience current --profile example
```

After a successful exploration, write `~/.dsh/browser-operator/experiences/<domain>.md` using the [experience template](experience-template.md), then validate it:

```bash
"$BROWSER" experience validate example.com
```

The notes should record the entry URL, selectors for searches, results, and details, result order, common problems, and what to do after a failure. Include enough detail for the next session to complete the same task in a few commands. Keep only the log path under `## 验证记录`, and record actual runs with `log add`.

Domains are saved in lowercase without a leading `www.`. Other subdomains are preserved.

For apps deployed to multiple environments, add optional frontmatter:

```yaml
app: my-admin              # stable across dev/sit/uat/prod
environment: uat
aliases: [my-admin.example.com, 127.0.0.1]
```

`experience show` and `experience current` return a `related` list. It includes notes matched by the same `app`, a domain alias, or a domain that matches after removing environment names such as dev/sit/uat/prod. Use `experience related <domain>` to query the list separately.

You can reuse page structure from another environment's notes. Re-check URLs, accounts, institution IDs, and object IDs for the current environment.

At the end of a task, review the saved experience with `experience show <domain>` (or `experience current` after a redirect). Update and revalidate any changes, then log the run as described below; use a "no new findings" note when appropriate.

## Verification Logs

Logs live separately at `~/.dsh/browser-operator/logs/<domain>/log.md`. Each run appends one line: `- YYYY-MM-DD HH:mm | task | ok/failed/partial | note`.

```bash
"$BROWSER" log add example.com "Read page heading" --result ok --note "No new findings"
"$BROWSER" log show example.com --limit 10
"$BROWSER" log list
```

Set `--result` to `ok`, `failed`, or `partial` to match the actual outcome. Missing log files are created automatically, but `log add` does not move historical entries from site notes. Preserve those entries when migrating, then replace them with the log path under `## 验证记录` in the notes.

## Operation Recipes

Site notes describe page structure, and recipes save steps you can repeat. Create `~/.dsh/browser-operator/脚本/<domain>.md` from the [recipe template](recipe-template.md), with one `##` section per task. After the same task succeeds for the third time, the agent writes the verified steps in a `steps` block, using `{{name}}` placeholders for values that change between runs.

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
- Set `--profile` on a step or in the YAML information at the start of the file (frontmatter). The run-level `--profile` is passed to steps that lack one; a profile set on an individual step keeps its value.
- Never store credentials or `--allow-auth` in steps. Only explicit user authorization in the current conversation permits `recipe run --allow-auth`, which forwards the flag to `click` / `fill` / `press` / `select`.
- On failure, the command returns `failedStep` and tries to attach a `screenshot`. Continue on the current page with the same profile, fix the steps, then verify again.
- `recipe run` executes the steps. The agent separately writes or repairs recipes, increments counters, and records verification logs.

## Data Directories and Configuration

| Setting | Purpose |
|---|---|
| `CHROME_PATH` | Chrome executable path |
| `DSH_HOME` | Installer root, default `~/.dsh`; controls skill and launcher locations |
| `BROWSER_OPERATOR_HOME` | CLI runtime data root, default `~/.dsh/browser-operator`; does not follow `DSH_HOME` or `--dest` automatically |

The paths below use the default runtime root:

```text
~/.dsh/browser-operator/
|-- config.json            # Annotation setting shared by all profiles
|-- profiles/<name>/       # Chrome profile, settings.json, daemon logs
|-- screenshots/           # Screenshots and error captures
|-- annotations/           # Annotation records (JSON)
|-- experiences/<domain>.md
|-- logs/<domain>/log.md
`-- 脚本/<domain>.md
```

Each profile has a local daemon that exits after 30 idle minutes by default; set `--idle-minutes` when starting it to change the timeout.

## Fingerprint

Each profile gets a browser fingerprint on first launch, stored in `~/.dsh/browser-operator/profiles/<name>/settings.json`. It stays the same across page reloads, browser restarts, and switches between hidden-window (headless) and visible-window (headed) modes.

- **UA/UA-CH**: both modes use the same browser identity. The Chrome major version comes from the installed browser; `architecture`, `platformVersion`, and `bitness` come from the host. Headless is the default.
- **navigator**: keeps native values by default. JavaScript overrides must be enabled explicitly because sites can detect these changes.
- **WebGL**: uses the real GPU by default (for example Apple M1 Pro); `"spoof"` pins a renderer, `"off"` disables WebGL.
- **Canvas/Audio**: adds noise based on the profile's fixed seed, keeping the fingerprint hash stable.
- **locale/timezone**: taken from the OS (macOS `zh-Hans_US` is normalized to `zh-CN`).
- **webdriver**: kept `false` by `--disable-blink-features=AutomationControlled`.
- **DevTools false positives**: delays `console.table` by default (`devtoolsFix`). Serializing Console arguments over CDP takes time, which some sites mistake for an open DevTools panel. This setting reduces those false positives.

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
| `click <selector> [--nth N] [--wait-for CSS] [--wait-nav]` | Send a real mouse click and report page changes |
| `drag <source> <target> [--nth N] [--target-nth N] [--steps N] [--method auto\|dragTo\|mouse\|js]` | Real drag/drop; auto tries stepped mouse then `dragTo`; `js` needs `--allow-js` |
| `eval <expression>` | Run JavaScript for page-specific handlers; cannot bypass login or verification |
| `fill <selector> <value> [--type] [--append]` | Fill an input; `--type` sends real keyboard events |
| `press <key>` | Send a keyboard key |
| `hover <selector>` | Real mouse hover |
| `select <selector> <value> [--label]` | Select an option |
| `wait <selector>` / `wait --url <pattern>` | Wait for an element or URL |
| `screenshot [path] [--full-page]` | Save a screenshot |
| `annotate start\|read\|wait\|cancel [--timeout ms]` | Enable, read, wait for, or disable page annotations; the setting is saved |
| `switch --index N` / `switch --url includes` | Switch the active tab |
| `mode headed` / `mode headless` | Switch mode (restarts Chrome); `headed` / `headless` are shorthand aliases |
| `focus` | Bring headed Chrome to the foreground |
| `dialog accept [--text value]` / `dialog dismiss` / `dialog status` | Dialog policy; default is dismiss/cancel |
| `restore-session on\|off` | Set whether to restore session cookies after browser restarts |
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

Operational commands return JSON. `ok:false` indicates failure. With `ok:true`, still check `warning`, `effect`, and whether the requested result was achieved. When a browser action throws an exception, the CLI tries to attach `error.screenshot`, `error.recentConsole`, and `error.recentNetwork`. Argument validation and startup failures may have no screenshot.

`click` sends real mouse input by default. Passing `--js` uses a DOM click and returns `trusted:false`. With either method, check the resulting page before treating the requested action as successful.

## Safety Model

- By default, the user enters credentials in visible Chrome. Only explicit authorization in the current conversation permits the agent to use credentials volunteered by the user, with `--allow-auth` on the relevant commands. Never read, export, or share cookies.
- The CLI never prints, copies, or uploads `chrome-profile/`, cookies, `daemon.json`, or the daemon token.
- Profiles, default screenshots, experiences, logs, and recipes stay under the runtime root; do not commit local runtime data. `screenshot [path]` can explicitly save elsewhere.
- The default mode is headless. Login/verification may trigger headed mode, or it can be selected with `--headed` / `mode headed`.
- Dialogs default to dismiss/cancel. Set `dialog accept` explicitly before confirming, then restore `dialog dismiss`. The policy persists within the daemon, including mode switches; restarting the daemon restores dismiss.
- `eval` runs JavaScript for page-specific handlers. It is blocked on login and verification pages and must not be used to bypass manual login or verification.
- No telemetry and no network calls other than the pages you open.

## Project Layout

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
