---
site: 站点名
domain: example.com
app: example-app
environment: prod
profile: example
updated: 2026-11-05
---

# example.com 操作脚本

> 文件开头的 YAML 信息（frontmatter）必须从第一行开始。每个域名保存一份 Markdown，路径为 `~/.dsh/browser-operator/脚本/<canonical-domain>.md`。
>
> 每个任务用一个 `##` 小节，成功后用 `browser recipe log` 累计次数。`steps` 每行写一个 browser 子命令，不加 `browser` 前缀。动态内容用 `{{name}}` 占位，并在 `- 参数:` 行声明。
>
> 下方选择器只演示格式，执行前要替换为本站已验证的选择器。不要在脚本中保存凭据或 `--allow-auth`；只有用户在当前对话明确授权代登录时，才在 `recipe run` 命令上加 `--allow-auth`。

## 搜索并读取结果

- 次数: 0
- 参数: query=搜索词
- 最近: 2026-11-05

```steps
open https://example.com/ --profile example
fill "#kw" "{{query}}"
click "#su" --wait-nav
wait "#content_left"
query "#content_left"
```

备注：

- 说明选择器为什么可用，哪些步骤需要等待，以及失败后怎么处理。
- 写清已知的环境差异，如 dev/sit/uat/prod 使用不同的主机名、机构代号或账号。
- 提醒哪些信息不能保存到脚本中，如密码、token、OTP、身份证号；不要填入这些信息的真实值。
