---
site: <site name>
domain: <canonical domain, no www.>
updated: <YYYY-MM-DD>
confidence: high | medium | low
verified_by: browser-operator
app: <stable app key across dev/sit/uat/prod; optional>
environment: <local|dev|sit|test|stage|uat|prod|other; optional>
aliases: [<other domains for the same app>]
tags: [<tag1>, <tag2>]
---

# <Site> 操作经验

## 快速路径

1. `open <direct entry URL / URL template>`
2. `query '<result item selector>' --limit 20 --all-attrs`
3. `click '<result link selector>' --nth <N> --wait-nav`
4. 用 `state` 和 `snapshot --mode text` 读取详情页的标题和正文。

> 写清页面入口、选择器、第 N 个结果的点击规则和内容读取方式，让新会话可以直接照着操作。

## 跨环境差异

- 用 `experience related <domain>` 查看同一应用在其他环境（dev/sit/uat/prod）的经验。可以参考页面结构，但 URL、账号、机构代号和 OID 必须按当前环境重新确认。
- 在入口 URL 模板中标出随环境变化的部分，例如 `https://<env-host>/<path>`。
- 选择器或数据值只在当前环境验证过时，注明“未跨环境验证”。

## 选择器

| 用途 | 选择器 | 备注 |
|---|---|---|
| 搜索框 | `<selector>` | 是否需要先点击，是否使用 contenteditable |
| 搜索按钮 | `<selector>` | 是否也支持按 Enter 提交 |
| 结果条目 | `<selector>` | 怎样识别和排除广告 |
| 结果标题链接 | `<selector>` | 按 DOM 顺序，`--nth` 从 1 开始 |
| 详情标题 | `state.title` | 不要只依赖页面内的 h1 |
| 详情正文 | `snapshot --mode text` | 或 `query '<selector>'` |
| 拖拽源/目标 | `<source selector>` / `<target selector>` | 记录 `--nth`、`--target-nth`、`--method` 和放置位置 |
| 复杂组件 | `<datepicker/overlay/rich editor selector>` | 先用 `wait` 等容器可见，再点击可见选项，不要只用 `fill` |

## 结果读取

- 结果顺序：`query.items` 按选择器匹配的 DOM 顺序返回，可能包含隐藏或屏幕外的节点。`--limit` 限制返回条数，`count` 是总匹配数。
- 点击序号：`click --nth N` 按同一个选择器的 DOM 匹配顺序从 1 编号，指定隐藏节点会失败。先用选择器排除广告和重复节点。
- 可见性：`inViewport:true` 只表示节点边界与视口相交，不能据此判断元素可见或可点击。
- 广告和推荐卡：`<写清怎样识别和排除>`。
- 点击后的页面变化：`新标签页 / 同页跳转`。打开新标签页后，daemon 会自动将它设为当前操作的页面。
- 详情读取：用 `state` 取 `title` 和 `url`，用 `snapshot --mode text` 取正文；需要分别读取字段时，用 `query`。
- 不带跟踪参数的网址：用 `query 'link[rel="canonical"]' --all-attrs` 读取 canonical URL。`state.url` 可能带有 `scm/spm/edtsign` 等参数。
- 标题：`state.title` 可能带 SEO 后缀。详情页也可能有隐藏的 h1；读取页面标题元素时，选择可见的 h1，例如 `h1:not(.screen-reader-only)`。
- 成功判定：`<写清需要检查的提示文字、URL 或元素>`。

## 陷阱

- 默认由用户手动登录；只有用户在当前对话明确授权代登录时，相关登录命令才能加 `--allow-auth`。滑块和 CAPTCHA 始终由用户完成，不尝试绕过。
- `<记录本站需要注意的情况，如广告、懒加载、弹窗、iframe、重定向、编码或分页>`
- 列表页的选择器到了详情页，可能只匹配到分享栏或推荐内容。先重新执行 `query` 确认，不要直接复用。
- 拖拽时，先执行 `drag`，检查 `effect.mutations` 和 `effect.urlChanged`。没有变化时，再考虑 `--method mouse` 或 `--method js --allow-js`，不要直接操作数据库或内部接口来绕过页面。
- 日期选择器、弹层和富文本组件可能用 JavaScript 覆盖 `fill` 的结果。优先点击组件，用 `wait` 等容器出现，再操作可见的日期格或选项。
- 失败时先用 `debug` 查看截图、Console 和 Network，不要反复使用同一个失败的选择器。

## 空页面/异常兜底

- 页面为空、标题为空或标题与域名不一致时，用 `click` 返回的 `target.text` 记录搜索结果标题，用 `url` 记录最终地址。
- 不刷新或反复等待。用 `close` 关闭空页面，再用 `--nth N+1` 尝试下一个结果一次，并在结果中记录 `empty-landing`。
- 再次失败时，停止操作，报告 `debug` 中的截图、Console 和 Network 信息，不要连续重试。

## 验证记录

日志单独保存在 `~/.dsh/browser-operator/logs/<domain>/log.md`，本节只保留这个路径。

用 `browser log add <domain> "<任务>" --result ok|failed|partial --note "..."` 追加本次结果，每次运行一行，不在本节重复记录。
