<h1 align="center">BrowserOperator</h1>

<p align="center"><strong>让你的 Agent 帮你操作浏览器。</strong></p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="skills/browser-operator/references/usage_CN.md">使用指南</a>
</p>

BrowserOperator 是一个浏览器操作 Skill。安装后，你可以直接让 Agent 在 Chrome 中搜索信息、阅读页面、填写表单或保存截图。

## 快速开始

### 安装 Skill

让你的 Agent 安装 [https://github.com/LearnAIHubC/BrowserOperator.git](https://github.com/LearnAIHubC/BrowserOperator.git)。

### 开始使用

对你的 Agent 说：

> 打开百度，搜索 xxx。

## 主要特点

### 保留登录状态

为常用站点保存独立的浏览器资料。登录仍然有效时，下次访问可以接着使用，减少重复登录。

### 复用站点经验

Agent 可以记录已经验证的操作方法、页面入口和注意事项。再次处理同一站点时，有经验可参考，减少重复摸索。

### 重放常用流程

Agent 可以把稳定的操作步骤整理成可复用流程。同类任务换个关键词或填写内容，就能按已有步骤再次执行。

### 出错后方便接手

流程执行失败时会停止后续步骤，保留当前页面。你或 Agent 可以结合截图和运行记录，查看问题并继续处理。

## 常见问题

<details>
<summary>需要自己写代码吗？</summary>

日常使用时，只需向 Agent 描述任务。BrowserOperator 提供浏览器操作能力，具体步骤由你的 Agent 安排。

</details>

<details>
<summary>登录和验证码怎么处理？</summary>

默认由你在浏览器窗口中完成登录，再由 Agent 继续任务。只有你明确要求代登录时，才允许 Agent 执行相关操作；滑块和验证码始终由你完成。

</details>

<details>
<summary>数据保存在什么地方？</summary>

浏览器资料、默认截图、站点经验和运行记录保存在本机。登录能否继续使用，还取决于网站的有效期和会话设置，详见[使用指南](skills/browser-operator/references/usage_CN.md)。

</details>

## 进一步了解

- [使用指南](skills/browser-operator/references/usage_CN.md)：环境要求、手动安装、完整命令与配置。
- [Skill 说明](skills/browser-operator/SKILL.md)：Agent 使用浏览器时的流程与规则。
- [站点经验模板](skills/browser-operator/references/experience-template.md) · [操作流程模板](skills/browser-operator/references/recipe-template.md)：保存可复用的操作方法。

---

[MIT License](LICENSE)
