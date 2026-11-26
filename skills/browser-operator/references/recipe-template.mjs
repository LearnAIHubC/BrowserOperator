// 脚本模板：复制到 ~/.dsh/browser-operator/脚本/<canonical-domain>/<任务名>.mjs 再改。
// 任务名用小写字母、数字、下划线，说的是动作（search_read、deploy_tag）；项目、环境、版本号做成参数。
// 下面的地址和选择器只是格式示例，写的时候换成这次实际跑通的。

export const meta = {
  desc: "搜索关键词并读取前几条结果",
  scope: "站内搜索页；要登录才能看的内容不适用",
  params: {
    query: { desc: "搜索词" },
    limit: { desc: "读几条", default: "5", pattern: "^\\d+$" },
    // 取值固定的参数写 enum，例如 env: { desc: "环境", enum: ["sit", "uat"] }
  },
};

export async function run(b, { query, limit }) {
  await b.step("打开搜索页", async () => {
    await b.open(`${b.origin}/`);
    await b.wait("#kw");
    return (await b.state()).url;
  });

  const count = await b.step("搜索", async () => {
    await b.fill("#kw", query);
    await b.click("#su", { waitNav: true });
    await b.wait("#content_left");
    // 做完读回页面的实际情况并核对，再 return 出去，它就是这一步的日志
    const shown = await b.eval(() => document.querySelector("#kw").value);
    b.expect(shown === query, `搜索框里是「${shown}」，要搜的是「${query}」`);
    return b.eval(() => document.querySelectorAll("#content_left .result").length);
  });
  if (count === 0) b.finish({ query, results: [] });

  // 参数按数据传给页面里的函数，不要拼进字符串
  const results = await b.step("读结果", () =>
    b.eval(
      (n) => [...document.querySelectorAll("#content_left .result h3")].slice(0, n).map((el) => el.innerText.trim()),
      Number(limit),
    ),
  );
  return { query, results };
}

// 会改线上数据、不能重做的步骤单独成一步，标 commit，并写明预期的确认框内容：
//
//   const message = await b.step("提交", async () => {
//     await b.click("#btnSubmit", { dialog: "确定存档" });
//     await b.wait(".alert-success");
//     return b.eval(() => document.querySelector(".alert-success").innerText.trim());
//   }, { commit: true });
//
// 要等几分钟的状态用 b.until，查到的进度用 b.log 打出来：
//
//   const status = await b.step("等流水线", () =>
//     b.until(async () => {
//       const s = await b.eval(readStatus, id);
//       b.log(`流水线 ${s}`);
//       return ["success", "failed", "canceled"].includes(s) ? s : null;
//     }, { every: 30, max: 1500 }),
//   );
//
// 往文件栏位放本地文件：
//
//   await b.upload('input[type=file]', "/绝对路径/rules.xlsx");
//
// 晚一点才弹的弹窗（比如 ajax 保存成功后才 alert）：点击时不写 dialog 选项，
// 点完轮询 dialog status，看到弹窗、核对内容后再确认：
//
//   await b.step("保存", async () => {
//     await b.click("#btnSave");
//     const pending = await b.until(async () => (await b.dialog("status")).pending, { every: 1, max: 30 });
//     b.expect(pending.message.includes("保存成功"), `弹窗内容是「${pending.message}」`);
//     await b.dialog("accept");
//     return pending.message;
//   }, { commit: true });
