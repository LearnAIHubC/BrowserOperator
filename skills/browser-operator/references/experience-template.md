---
site: <site name>
domain: <canonical domain, no www.>
updated: <YYYY-MM-DD>
confidence: high | medium | low
verified_by: browser-operator
tags: [<tag1>, <tag2>]
---

# <Site> 快速访问经验

## 快速路径

1. `open <direct entry URL / URL template>`
2. `query '<result item selector>' --limit 20 --all-attrs`
3. `click '<result link selector>' --nth <N> --wait-nav`
4. `state` + `snapshot --mode text` 读取详情的标题和正文

> 目标：让新会话不看页面也能直接知道入口、选择器、索引规则和读取方式。

## 选择器

| 用途 | 选择器 | 备注 |
|---|---|---|
| 搜索框 | `<selector>` | 是否需要先点击/是否 contenteditable |
| 搜索按钮 | `<selector>` | 或 Enter 提交 |
| 结果条目 | `<selector>` | 包含/排除广告的规则 |
| 结果标题链接 | `<selector>` | 按 DOM 顺序，`--nth` 从 1 开始 |
| 详情标题 | `state.title` | 不要依赖页面内 h1 |
| 详情正文 | `snapshot --mode text` | 或 `query '<selector>'` |

## 结果读取

- 结果顺序：`<selector>` 的可见顺序；第 1 个是第一条。以 `query` 返回的 `items`（`inViewport:true`）为准，`count` 可能包含隐藏/重复节点，不能直接当序号。
- 广告/推荐卡：`<如何识别和排除>`。
- 点击后：`新标签页 / 同页跳转`；daemon 会自动切换 active page。
- 详情读取：`state` 取 title/url，`snapshot --mode text` 取正文；需要结构化字段时用 `query`。
- 干净 URL：跟踪参数多时用 `query 'link[rel="canonical"]' --all-attrs` 取 canonical；`state.url` 可能带 `scm/spm/edtsign` 等。
- 标题：`state.title` 可能带 SEO 后缀；详情页可能有隐藏 h1，取可见 h1（例如 `h1:not(.screen-reader-only)`）。
- 成功判定：`<明确文案/URL/元素>`。

## 陷阱

- 登录/验证/滑块必须由用户完成；不要点击或尝试绕过。
- `<站点特有陷阱：广告、懒加载、弹窗、iframe、重定向、编码、分页...>`
- 列表页选择器在详情页可能只剩分享栏/推荐位，不要直接复用；先重新 `query`。
- 失败时先 `debug` 看截图、console、network；不要重复同一个失败选择器。

## 空页面/异常兜底

- 空文档/标题为空/标题与域名不一致时：用 `click` 返回的 `target.text` 作为 SERP 标题、`url` 作为最终 URL。
- 不刷新、不反复等待；`close` 空页后按 `--nth N+1` 兜底一次，并在结果里记录 `empty-landing`。
- 兜底仍失败：停止并报告 `debug` 截图/console/network，不要连续重试。

## 验证记录

| 日期 | 任务 | 结果 | 备注 |
|---|---|---|---|
| <YYYY-MM-DD> | <keyword / index / page> | <title + url> | <first run / reuse run> |
