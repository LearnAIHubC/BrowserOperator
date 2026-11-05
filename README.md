<h1 align="center">BrowserOperator</h1>

<p align="center"><strong>Let your agent work in the browser for you.</strong></p>

<p align="center">
  <a href="README_CN.md">中文</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="skills/browser-operator/references/usage.md">User guide</a>
</p>

BrowserOperator is a browser skill. Once installed, your agent can use Chrome to search for information, read pages, fill forms, and save screenshots.

## Quick start

### Install the skill

Ask your agent to install [https://github.com/LearnAIHubC/BrowserOperator.git](https://github.com/LearnAIHubC/BrowserOperator.git).

### Start using it

Tell your agent:

> Open Baidu and search for xxx.

## Key features

### Keep your login state

Save separate browser data for your usual sites. While a login remains valid, later visits can reuse it and avoid another sign-in.

### Reuse site knowledge

Your agent can record verified procedures, entry points, and things to watch for. On the next visit, those notes help it spend less time rediscovering the site.

### Replay familiar workflows

Your agent can save stable steps as a reusable workflow. Similar tasks can follow those steps again with different search terms or form values.

### Pick up after a failure

When a workflow fails, later steps stop and the current page stays open. You or your agent can inspect screenshots and run records to understand the problem and continue.

## Common questions

<details>
<summary>Do I need to write code?</summary>

For everyday use, just describe the task to your agent. BrowserOperator provides browser actions, and your agent decides which steps to take.

</details>

<details>
<summary>How are login and verification handled?</summary>

By default, you log in through the browser window before the agent continues. The agent may perform login actions only when you explicitly ask it to. Sliders and CAPTCHAs always stay with you.

</details>

<details>
<summary>Where is my data stored?</summary>

Browser data, default screenshots, site notes, and run records are stored locally. Whether a login can be reused also depends on the site's expiry rules and session settings. See the [user guide](skills/browser-operator/references/usage.md).

</details>

## Learn more

- [User guide](skills/browser-operator/references/usage.md): requirements, manual installation, commands, and configuration.
- [Skill instructions](skills/browser-operator/SKILL.md): procedures and rules for the agent.
- [Site experience template](skills/browser-operator/references/experience-template.md) · [Workflow template](skills/browser-operator/references/recipe-template.md): save reusable procedures.

---

[MIT License](LICENSE)
