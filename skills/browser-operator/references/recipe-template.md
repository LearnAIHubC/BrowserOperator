---
site: 站点名
domain: example.com
app: example-app
environment: prod
profile: example
updated: 2026-11-05
---

# example.com 操作脚本

> 模板说明：这是一个站点的任务索引，frontmatter 必须从文件第一行开始。一个域名一份，放在 `~/.dsh/browser-operator/脚本/<canonical-domain>.md`；任务的脚本放 `~/.dsh/browser-operator/脚本/<canonical-domain>/<任务名>.mjs`，模板见 `recipe-template.mjs`。
> `profile` 必填，脚本用它打开浏览器。站点地址不是 `https://<domain>` 时加一行，如 `origin: http://localhost:8765`。
> 一个任务一个 `## <任务名>` 段。任务名用小写字母、数字、下划线，说的是动作，项目、环境、版本号是参数。
> `说明 / 次数 / 最近 / 状态 / 上次失败` 这几行由 `log add --task` 和 `recipe run` 维护，不要手改。平时不用手建这个文件：第一次 `log add --task` 会自动建，只需要补上 `profile`。
> 会重复做、但每次步骤都不一样、固定不下来的任务，在它的段里手写一行 `- 不写脚本: <原因>`，之后不会再提示写脚本，计数照常。

## search_read

- 说明: 搜索关键词并读取前几条结果
- 次数: 0
- 最近: 2026-11-05

备注：

- 这个任务什么时候适用、什么时候不适用（脚本写好后以脚本里的 `meta.scope` 为准）
- 已知环境差异（dev/sit/uat/prod 的 host、机构代号、账号不同）
- 不写密码、token、OTP、身份证号
