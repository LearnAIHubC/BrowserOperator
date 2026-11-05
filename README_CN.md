<h1 align="center">BrowserOperator</h1>

<p align="center"><strong>让你的 Agent 帮你操作浏览器。</strong></p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#它能干什么">使用场景</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#主要特点">主要特点</a> ·
  <a href="#和-codex-自带的浏览器操作有什么区别">与 Codex 的区别</a> ·
  <a href="skills/browser-operator/references/usage_CN.md">使用指南</a>
</p>

BrowserOperator 是一个浏览器操作 Skill。安装后，你可以直接让 Agent 在 Chrome 中搜索信息、阅读页面、填写表单或保存截图。

它通过 Playwright 和 Chrome DevTools Protocol 读取页面 DOM、定位元素，执行鼠标点击、键盘输入等操作，并提供 Console 和 Network 信息供排查问题。浏览器会话可以持续保留，Agent 也会按 Skill 规则记录站点经验，将多次验证过的流程整理成可重放的操作脚本。

你负责说明目标和检查标准，Agent 负责安排步骤、操作页面、核对结果，并保存下次可以复用的方法。

## 它能干什么？

BrowserOperator 提供网页操作能力，Agent 结合你给出的任务和资料，可以用在这些场景中：

### 电商选购与下单

访问电商网站，搜索商品、比较价格与规格、选择款式和数量。核对商品、金额和收货信息后，按你的指令提交订单。

> 帮我比较三款预算 500 元以内的机械键盘，整理价格、配列、轴体、连接方式和商品链接，标出每款的主要差异。

### 页面回归测试

按测试用例执行搜索、填写表单、提交等页面操作，检查成功提示、页面跳转和结果数据。保存关键步骤截图，遇到失败时整理页面现场、控制台错误和请求信息，方便定位问题。

例如，跑一遍“搜索 → 打开详情 → 修改表单 → 保存 → 重新查询”的业务流程，确认修改确实保存；也可以检查必填项校验、空结果和错误提示。

> 在测试环境验证客户资料修改流程：搜索指定测试客户，修改备注并保存，重新打开详情确认结果；检查必填项为空时的提示，保存关键步骤截图，最后恢复测试数据。

如果按钮点不动，Agent 可以检查元素是否被弹窗遮挡、是否可见或处于禁用状态。提交后没有反应时，可以结合 Console 错误与 Network 中的请求状态、耗时和失败信息继续排查。

### 查询招聘 JD，定制简历

在招聘网站或招聘工具的网页版中搜索岗位，设置城市、经验和薪资条件，打开职位详情，整理公司名称、岗位职责、技术栈、任职要求、薪资范围和原始链接。

> 帮我查上海的 Java 后端岗位，优先看要求 3～5 年经验、月薪 20～30K 的职位。逐条查看 JD，整理成表格，保留原始链接，没有公开写明的信息标注为“未注明”。

Agent 再结合你提供的简历和真实经历，梳理技能匹配点、突出相关项目、调整表述重点，生成针对目标岗位的简历草稿。

> 根据这些 JD 修改我的项目经历，突出 Java、Spring Boot 和数据库优化相关的真实经验。缺少的技能单独列出，不编造项目或工作经历。

招聘网站常有登录校验和反爬虫机制。BrowserOperator 提供稳定浏览器指纹和部分自动化检测适配；会话仍有效时可以复用登录状态。打开页面时识别到滑块或人机验证，会切换到可见浏览器，等你手动完成后再由 Agent 检查页面并继续。

### 操作 Web 发布平台

在自有 Web 发布平台或 GitLab CI/CD 页面中，按你指定的环境、分支和版本执行发布流程：进入项目、选择版本、填写参数、触发流水线，再查看各阶段状态和任务日志。

> 打开项目的 GitLab 页面，将 release/1.5 分支发布到指定测试环境。核对环境和分支后触发对应流水线，等待任务结束，整理流水线链接、执行结果和失败步骤的关键报错。

失败时，Agent 可以打开失败的 Job，整理构建、测试或部署步骤的错误信息。发布后，可以按项目已有的检查方式打开应用页面、验证关键功能或核对版本信息；流水线成功与应用实际可用需要分别检查。

稳定的发版步骤可以保存为带参数的操作脚本，供后续更换环境、分支或版本后复用。脚本某一步失败时会停止后续操作，并保留当前页面供排查。

## 快速开始

### 环境要求

- Node.js 20 及以上、npm。
- 已安装 Google Chrome；也可以通过 `CHROME_PATH` 指定位置。
- 支持读取 Skill 并执行本地命令的 Agent。
- macOS、Linux 或 Windows。启动器使用 Bash，Windows 需安装 Git Bash 等环境；无 Bash 时可直接运行 `node <Skill 目录>/scripts/browser.mjs ...`。

### 安装 Skill

让你的 Agent 安装 [https://github.com/LearnAIHubC/BrowserOperator.git](https://github.com/LearnAIHubC/BrowserOperator.git)。

也可以在终端运行：

```bash
npx --yes github:LearnAIHubC/BrowserOperator
```

默认安装到 `${DSH_HOME:-$HOME/.dsh}/skills/browser-operator`，同时安装依赖并创建命令行启动器。安装完成后重启 Agent，让它加载 Skill。

如果你的 Agent 使用其他 Skill 目录，通过 `--dest` 指定其父目录；安装器会在该目录下创建 `browser-operator/`：

```bash
npx --yes github:LearnAIHubC/BrowserOperator --dest /path/to/your-agent/skills
```

更新已有安装时，在原安装命令中追加 `--force`。手动安装和其他选项见[使用指南](skills/browser-operator/references/usage_CN.md)。

### 开始使用

对你的 Agent 说：

> 打开百度，搜索 xxx。

也可以把操作目标和验收条件一起说明：

> 使用 BrowserOperator 打开我的测试后台，按指定条件搜索一条记录，打开详情并保存截图。确认详情与列表中的记录一致，最后记录这个站点的操作经验。

### 查看页面与保存截图

通常由 Agent 调用命令即可。如果想了解它如何操作，下面是一组命令示例，使用默认安装目录；自定义安装时请修改 `BROWSER` 路径：

```bash
BROWSER="${DSH_HOME:-$HOME/.dsh}/skills/browser-operator/bin/browser"

# 先读取已有站点经验，再打开页面
"$BROWSER" experience show example.com
"$BROWSER" open "https://example.com" --profile example

# 查看可操作元素，读取页面内容并保存截图
"$BROWSER" snapshot --mode interactive --profile example
"$BROWSER" query "h1" --profile example
"$BROWSER" screenshot --profile example --full-page

# 关闭浏览器并保存 Profile
"$BROWSER" stop --profile example
```

后续业务操作使用 `snapshot` 返回的定位信息。每一步操作后，Agent 还需要检查页面变化和业务结果，例如重新查询确认数据已保存。

## 主要特点

### 读取 DOM，执行真实鼠标输入

Agent 可以查看页面结构和元素属性，通过文字或选择器定位按钮、输入框和结果列表，再执行点击、填写、选择、悬停或拖拽。支持 iframe 中的元素操作和标签页切换。

默认点击使用 Playwright 的鼠标输入路径，包含滚动、可操作性和点击目标检查。遇到遮挡或隐藏元素时，可以检查页面状态后调整步骤。

### 保留登录状态

为常用站点或不同账号保存独立的浏览器资料（Profile），保留 Cookie 和本地存储。登录仍然有效时，下次访问可以接着使用，减少重复登录。

默认无界面运行；打开页面时识别到需要登录或验证，会自动切换到可见窗口。依赖会话 Cookie 的站点可按需开启 `restore-session`，能否恢复仍取决于服务端会话是否有效，详见[登录持久化说明](skills/browser-operator/references/usage_CN.md#登录持久化)。

### 适配部分反爬虫与开发者工具检测

同一个 Profile 会保持稳定的浏览器指纹，在有界面与无界面模式之间使用一致的浏览器身份配置，并针对部分自动化标记和开发者工具检测误报做适配。

站点仍可能因自身风控策略拒绝访问。检测到滑块、验证码等验证页面时，需要由你在可见窗口中完成，再继续任务。

### 复用站点经验

Skill 要求 Agent 在任务开始前读取已有站点经验，在探索成功后记录页面入口、元素定位、结果读取方式和常见问题。再次处理同一站点时，先参考已验证的方法，减少重新查看 DOM 和摸索页面的时间。

经验以本地 Markdown 保存，能跨会话复用。页面改版或定位方式失效时，Agent 需要重新核实并更新记录。

### 重放常用流程

同一任务重复完成、步骤验证稳定后，Agent 可以将其整理成操作脚本（recipe），将搜索词、环境、分支或版本等设为参数。后续使用 `recipe run` 按既定步骤重放，减少重复规划。

Skill 约定同一任务在第 3 次成功执行时整理稳定步骤。脚本由 Agent 编写、验证和维护；CLI 提供参数替换与执行能力，页面变化后仍需更新步骤。

### 出错后方便接手

操作脚本执行失败时会停止后续步骤，保留当前页面，并返回失败步骤和错误信息。你或 Agent 可以结合截图、Console、Network 和运行记录查看问题，在现有会话中继续处理。

`debug` 可以一起收集页面状态、截图和近期 Console / Network 信息。Network 记录包含请求地址、状态、耗时和失败原因，不默认记录请求头或请求体。

## 从一次操作到重复执行

1. **先查已有方法**：Agent 读取站点经验和已有脚本，确认页面入口、当前环境和任务参数。
2. **查看页面并执行**：通过 DOM 快照定位目标，执行操作，等待页面或元素达到预期状态。
3. **核对业务结果**：检查成功提示、跳转、结果数据或版本信息，确认任务达到你给出的验收条件。
4. **保存可复用经验**：成功后更新入口、选择器和注意事项，并记录本次执行结果。
5. **固化稳定流程**：重复任务达到 Skill 的记录条件后，由 Agent 整理带参数脚本；后续优先重放，失效时重新检查并修正。

经验文件、操作脚本和运行日志分别保存，方便在新会话中读取。完整格式见[站点经验模板](skills/browser-operator/references/experience-template.md)和[操作流程模板](skills/browser-operator/references/recipe-template.md)。

## 和 Codex 自带的浏览器操作有什么区别？

BrowserOperator 可以作为 Skill 安装到 Codex 等 Agent 中，为其提供本地 Chrome 操作、站点经验和流程重放能力。具体使用时，需要 Agent 能读取 Skill 并执行本地命令。

Codex 有多种浏览器操作入口。在 macOS 上，通过 Computer Use 控制桌面应用时需要屏幕录制和无障碍权限；内置浏览器或连接的 Chrome 在启用开发者模式并获得相应授权后，也能查看 DOM、Console 和 Network。

| 对比项 | BrowserOperator | Codex 自带的浏览器操作 |
| --- | --- | --- |
| 使用入口 | 独立 Skill 和命令行工具，由 Agent 调用本地 Chrome | 内置浏览器、浏览器扩展或 Computer Use，取决于所用入口 |
| 元素与调试 | 通过 Playwright / CDP 读取 DOM、定位元素，查看 Console 和 Network | 浏览器开发者模式在相应授权后也可查看 DOM、Console 和 Network；桌面应用操作使用系统控制能力 |
| 会话管理 | 通过命名 Profile 分别保存站点或账号的浏览器资料 | 内置浏览器使用独立资料；浏览器扩展可以连接日常浏览器会话 |
| 经验与重放 | Skill 明确要求先读后写站点经验，并将重复任务整理为可参数化的 recipe | 可通过所装 Skill 等方式扩展流程，具体规则由当前工具与配置决定 |

BrowserOperator 将站点经验和重复流程的维护规则放在同一个 Skill 中，让后续任务有已验证的入口、定位方式和步骤可参考。页面变化时仍需核实当前状态。

Codex 当前能力和权限设置以 OpenAI 官方的[浏览器说明](https://learn.chatgpt.com/docs/browser)与 [Computer Use 说明](https://learn.chatgpt.com/docs/computer-use)为准。

## 常见问题

<details>
<summary>需要自己写代码吗？</summary>

日常使用时，只需向 Agent 描述任务。BrowserOperator 提供浏览器操作能力，具体步骤由你的 Agent 安排。

</details>

<details>
<summary>登录和验证码怎么处理？</summary>

默认由你在浏览器窗口中完成登录，再由 Agent 继续任务。只有你明确要求代登录时，才允许 Agent 执行相关操作；滑块和验证码始终由你完成。

页面特征检测可能存在误判。登录或验证提示消失后，Agent 还需要检查业务页面，确认确实进入了目标站点。

</details>

<details>
<summary>页面变化后，经验和脚本还能继续用吗？</summary>

需要重新核实。入口变化、元素改名、弹窗或加载方式调整，都可能使旧定位失效。Agent 可以保留失败现场，检查当前 DOM，更新经验和步骤，再验证流程。

</details>

<details>
<summary>数据保存在什么地方？</summary>

浏览器资料、默认截图、站点经验和运行记录保存在本机。登录能否继续使用，还取决于网站的有效期和会话设置，详见[使用指南](skills/browser-operator/references/usage_CN.md)。

默认数据目录为 `~/.dsh/browser-operator/`：`profiles/` 保存浏览器资料，`screenshots/` 保存默认截图，`experiences/` 保存站点经验，`脚本/` 保存操作脚本，`logs/` 保存站点运行记录。

</details>

## 进一步了解

- [使用指南](skills/browser-operator/references/usage_CN.md)：环境要求、手动安装、完整命令与配置。
- [Skill 说明](skills/browser-operator/SKILL.md)：Agent 使用浏览器时的流程与规则。
- [站点经验模板](skills/browser-operator/references/experience-template.md) · [操作流程模板](skills/browser-operator/references/recipe-template.md)：保存可复用的操作方法。

---

[MIT License](LICENSE)
