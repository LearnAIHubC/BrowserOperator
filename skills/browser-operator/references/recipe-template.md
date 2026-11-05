# 操作脚本模板（脚本/<domain>.md）

> 一个域名一份 Markdown，放在 `~/.dsh/browser-operator/脚本/<canonical-domain>.md`。
> 一个任务一个 `##` 段落；`- 次数:` 用 `browser recipe log` 维护；`steps` 每行一个 browser 子命令（不写 `browser` 前缀）；动态内容用 `{{name}}`，并在 `- 参数:` 行声明。

---
site: 站点名
domain: example.com
app: example-app
environment: prod
profile: example
updated: 2026-11-05
---

# example.com 操作脚本

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
- 选择器为什么稳定、关键等待点、失败兜底
- 已知环境差异（dev/sit/uat/prod 的 host、机构代号、账号不同）
- 哪些内容绝不能写进脚本（密码、token、OTP、身份证号等）
