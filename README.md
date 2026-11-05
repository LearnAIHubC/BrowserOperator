<h1 align="center">BrowserOperator</h1>

<p align="center"><strong>Let your agent work in the browser for you.</strong></p>

<p align="center">
  <a href="README_CN.md">中文</a> ·
  <a href="#what-can-it-do">Use cases</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#key-features">Key features</a> ·
  <a href="#how-does-it-compare-with-codexs-browser-tools">Compare with Codex</a> ·
  <a href="skills/browser-operator/references/usage.md">User guide</a>
</p>

BrowserOperator is a browser skill. Once installed, your agent can use Chrome to search for information, read pages, fill forms, and save screenshots.

It uses Playwright and the Chrome DevTools Protocol to read the DOM, locate elements, and perform actions such as mouse clicks and keyboard input. Console and Network records help diagnose failures. Browser sessions can persist, while the skill instructs your agent to save site knowledge and turn repeatedly verified workflows into replayable recipes.

Describe the goal and how to check it. Your agent plans the steps, operates the page, verifies the outcome, and records procedures it can reuse later.

## What can it do?

BrowserOperator provides browser actions. Your agent can combine them with your instructions and materials for workflows such as:

### Shop and place orders

Visit shopping sites, find products, compare prices and specifications, and choose variants and quantities. Check the items, total, and shipping details, then submit the order as you instruct.

> Compare three mechanical keyboards under CNY 500. List their prices, layouts, switches, connectivity, and product links, and explain the main differences.

### Run UI regression tests

Follow test cases to search, fill forms, and submit data, then check success messages, navigation, and resulting data. Capture screenshots at key steps and collect page state, console errors, and request details when something fails.

For example, run “search → open details → edit a form → save → search again” to confirm that a change persisted. Include required-field validation, empty results, and error messages when relevant.

> In the test environment, find the specified test customer, edit and save its notes, then reopen the details to check the result. Check the warning for an empty required field, capture key screenshots, and restore the test data afterward.

When a button cannot be clicked, your agent can check for overlays, visibility, or a disabled state. If a submission appears to do nothing, it can inspect Console errors alongside Network status codes, timing, and failures.

### Research job descriptions and tailor a resume

Search job sites or web-based recruiting tools, filter by city, experience, and salary, then open job details. Collect company names, responsibilities, technology requirements, qualifications, salary ranges, and original links.

> Find Java backend roles in Shanghai, prioritizing positions asking for 3–5 years of experience and paying CNY 20–30K per month. Read each JD and make a table with the original links. Mark information that is not published as “not specified.”

Your agent can then use your existing resume and actual experience to identify relevant skills, highlight projects, refine the emphasis, and draft a resume for the target role.

> Tailor my project descriptions to these JDs, emphasizing my actual Java, Spring Boot, and database optimization experience. List skill gaps separately; do not invent projects or work history.

Job sites often require authentication or apply anti-bot checks. BrowserOperator provides a stable browser fingerprint and compatibility measures for some automation checks; valid login sessions can be reused. When it detects a slider or CAPTCHA while opening a page, it switches to a visible browser so you can complete verification before the agent checks the page and continues.

### Operate a web release platform

Use your web release platform or GitLab CI/CD pages to release your chosen environment, branch, and version: open the project, select the version, fill in parameters, trigger the pipeline, and inspect stage status and job logs.

> Open the project's GitLab page and release the release/1.5 branch to the specified test environment. Check the environment and branch before triggering the corresponding pipeline. Wait for completion and report its link, outcome, and the key errors from any failed steps.

If a job fails, your agent can open it and summarize errors from the build, test, or deployment steps. Afterward, follow the project's existing verification procedure to open the app, check key features, or verify its version. Pipeline success and a working application need separate checks.

Stable release procedures can become recipes with environment, branch, or version parameters. A failed recipe step stops later steps and leaves the page open for diagnosis.

## Quick start

### Requirements

- Node.js 20 or later and npm.
- Google Chrome installed; use `CHROME_PATH` to specify its location if needed.
- An agent that can read skills and execute local commands.
- macOS, Linux, or Windows. The launcher uses Bash, so Windows needs an environment such as Git Bash. Without Bash, run `node <skill-directory>/scripts/browser.mjs ...` directly.

### Install the skill

Ask your agent to install [https://github.com/LearnAIHubC/BrowserOperator.git](https://github.com/LearnAIHubC/BrowserOperator.git).

Or run this in a terminal:

```bash
npx --yes github:LearnAIHubC/BrowserOperator
```

By default, the installer uses `${DSH_HOME:-$HOME/.dsh}/skills/browser-operator`, installs dependencies, and creates a command-line launcher. Restart your agent afterward so it loads the skill.

For an agent with a different skills directory, pass that parent directory with `--dest`. The installer creates `browser-operator/` inside it:

```bash
npx --yes github:LearnAIHubC/BrowserOperator --dest /path/to/your-agent/skills
```

To update an existing installation, add `--force` to the original install command. See the [user guide](skills/browser-operator/references/usage.md) for manual installation and other options.

### Start using it

Tell your agent:

> Open Baidu and search for xxx.

For a more specific task, include the goal and acceptance criteria:

> Use BrowserOperator to open my test dashboard, search for a record using the specified filters, open its details, and save a screenshot. Check that the details match the list entry, then record the procedure in the site's notes.

### Inspect a page and save a screenshot

Your agent normally runs the commands for you. To see how they work, this example uses the default install directory. Change `BROWSER` for a custom installation:

```bash
BROWSER="${DSH_HOME:-$HOME/.dsh}/skills/browser-operator/bin/browser"

# Read saved site knowledge before opening the page
"$BROWSER" experience show example.com
"$BROWSER" open "https://example.com" --profile example

# Inspect interactive elements, read content, and save a screenshot
"$BROWSER" snapshot --mode interactive --profile example
"$BROWSER" query "h1" --profile example
"$BROWSER" screenshot --profile example --full-page

# Close the browser and save the profile
"$BROWSER" stop --profile example
```

Use the locators returned by `snapshot` for later actions. After each step, your agent still needs to check page changes and the business outcome, such as querying a record again to confirm that it was saved.

## Key features

### Read the DOM and use real mouse input

Your agent can inspect page structure and element attributes, locate buttons, inputs, and results by text or selector, then click, fill, select, hover, or drag. It also supports elements inside iframes and switching tabs.

The default click uses Playwright's mouse input path, including scrolling, actionability checks, and hit-target checks. If an element is covered or hidden, inspect the page state and adjust the steps.

### Keep your login state

Save separate browser profiles for sites or accounts, retaining cookies and local storage. While a login remains valid, later visits can reuse it and avoid another sign-in.

Chrome runs headlessly by default and switches to a visible window when login or verification is detected while opening a page. For sites using session cookies, enable `restore-session` when needed. Recovery still depends on the server-side session remaining valid; see [login persistence](skills/browser-operator/references/usage.md#login-persistence).

### Handle some anti-bot and DevTools checks

Each profile keeps a stable browser fingerprint and consistent browser identity settings across headed and headless modes. The tool includes compatibility measures for some automation markers and false positives from developer-tools detection.

A site may still deny access under its own risk controls. Sliders, CAPTCHAs, and similar verification pages require you to complete the check in the visible browser before continuing.

### Reuse site knowledge

The skill requires your agent to read existing site notes before a task and record entry points, element locators, result extraction, and common problems after successful exploration. Later visits start with verified procedures, reducing repeated DOM inspection and exploration.

Notes are saved as local Markdown files and can be reused across sessions. When a site changes or a locator fails, your agent needs to check the current page and update the notes.

### Replay familiar workflows

After repeatedly completing a task and verifying its steps, your agent can write an operation recipe with parameters for search terms, environments, branches, or versions. Later tasks use `recipe run` to replay those steps with less repeated planning.

The skill calls for recording stable steps on the third successful run of the same task. Your agent writes, verifies, and maintains recipes; the CLI substitutes parameters and executes them. Site changes can require updates to the steps.

### Pick up after a failure

When a recipe fails, later steps stop, the current page stays open, and the tool reports the failed step and error. You or your agent can inspect screenshots, Console, Network, and run records, then continue in the existing session.

`debug` collects page state, a screenshot, and recent Console and Network information together. Network records contain request URLs, status, timing, and failure reasons; request headers and bodies are not recorded by default.

## From a first run to repeatable workflows

1. **Check saved procedures:** Read site notes and existing recipes, then confirm the entry point, current environment, and task parameters.
2. **Inspect and act:** Use DOM snapshots to locate targets, perform actions, and wait for the expected page or element state.
3. **Verify the outcome:** Check success messages, navigation, resulting data, or version information against your acceptance criteria.
4. **Save useful knowledge:** Update entry points, selectors, and things to watch for, then record the run's outcome.
5. **Record stable steps:** Once a repeated task meets the skill's recording conditions, write a parameterized recipe. Prefer replay on later runs; inspect and repair the steps when they fail.

Site notes, recipes, and run logs are stored separately for reuse in new sessions. See the [site experience template](skills/browser-operator/references/experience-template.md) and [workflow template](skills/browser-operator/references/recipe-template.md) for their formats.

## How does it compare with Codex's browser tools?

BrowserOperator can be installed as a skill in agents such as Codex, providing local Chrome control, site notes, and workflow replay. The agent needs to be able to read the skill and execute local commands.

Codex has several browser-control options. On macOS, controlling desktop apps through Computer Use requires Screen Recording and Accessibility permissions. Its built-in browser or connected Chrome can also inspect the DOM, Console, and Network with developer mode enabled and the appropriate access approved.

| Area | BrowserOperator | Codex's browser tools |
| --- | --- | --- |
| Entry point | A separate skill and CLI through which an agent operates local Chrome | Built-in browser, browser extension, or Computer Use, depending on the selected entry point |
| Elements and debugging | Playwright / CDP for DOM inspection, element targeting, Console, and Network | Browser developer mode can also inspect DOM, Console, and Network with approval; desktop app control uses operating-system capabilities |
| Sessions | Named profiles keep browser data separate for sites or accounts | The built-in browser uses its own profile; the browser extension can connect to a regular browser session |
| Knowledge and replay | The skill specifies reading and updating site notes, with parameterized recipes for repeated tasks | Installed skills can extend workflows; the rules depend on the current tools and configuration |

BrowserOperator keeps rules for maintaining site notes and repeated workflows in one skill, giving future tasks verified entry points, locators, and steps to consult. Current page state still needs checking when a site changes.

For current Codex capabilities and permissions, see OpenAI's official [browser documentation](https://learn.chatgpt.com/docs/browser) and [Computer Use documentation](https://learn.chatgpt.com/docs/computer-use).

## Common questions

<details>
<summary>Do I need to write code?</summary>

For everyday use, just describe the task to your agent. BrowserOperator provides browser actions, and your agent decides which steps to take.

</details>

<details>
<summary>How are login and verification handled?</summary>

By default, you log in through the browser window before the agent continues. The agent may perform login actions only when you explicitly ask it to. Sliders and CAPTCHAs always stay with you.

Detection uses page features and can be wrong. After a login or verification prompt disappears, the agent still needs to inspect the business page to confirm that it reached the intended site.

</details>

<details>
<summary>Will saved notes and recipes survive site changes?</summary>

They need checking. Changed entry points, renamed elements, pop-ups, or different loading behavior can invalidate old locators. Your agent can keep the failed page open, inspect the current DOM, update notes and steps, and verify the workflow again.

</details>

<details>
<summary>Where is my data stored?</summary>

Browser data, default screenshots, site notes, and run records are stored locally. Whether a login can be reused also depends on the site's expiry rules and session settings. See the [user guide](skills/browser-operator/references/usage.md).

The default data directory is `~/.dsh/browser-operator/`: `profiles/` holds browser data, `screenshots/` holds default screenshots, `experiences/` holds site notes, `脚本/` holds recipes, and `logs/` holds site run records.

</details>

## Learn more

- [User guide](skills/browser-operator/references/usage.md): requirements, manual installation, commands, and configuration.
- [Skill instructions](skills/browser-operator/SKILL.md): procedures and rules for the agent.
- [Site experience template](skills/browser-operator/references/experience-template.md) · [Workflow template](skills/browser-operator/references/recipe-template.md): save reusable procedures.

---

[MIT License](LICENSE)
