'use strict';
//
// auth-headers —— `.mcp.json` 的 `headersHelper`，把 API key 注入 MCP 连接
// 而**不让它进任何文件**。
//
// ## 为什么需要它
//
// `.mcp.json` 的静态 `headers` 字段写上 key 就等于把 key 提交进版本库。
// DESIGN 早就禁止那么做，并让人改用 `headersHelper`——**但它指向的
// `scripts/auth-headers.sh` 从来没被写出来过**（2026-09-04 发现）。
// 于是"按规矩配"这条路是断的，唯一走得通的就是被禁止的那条。
//
// 一条规则挡住了唯一的替代路径，等于没有规则。这个文件是那条替代路径。
//
// ## 契约（2026-09-04 查官方文档确认）
//
// - **必须往 stdout 输出一个字符串键值的 JSON 对象**
// - Claude Code **在 shell 里**跑它，10 秒后放弃
// - 动态 header 覆盖同名的静态 `headers`
// - `${CLAUDE_PLUGIN_ROOT}` 在 http 类 server 的 `url` / `headers` /
//   `headersHelper` 三个字段里会被展开
//
// ## 为什么是 .js 不是 .sh
//
// DESIGN 里那段示例写的是 `.sh`，而本项目的既定约定是**脚本一律用 Node
// 并以 `node <path>` 调用**——不依赖 shebang，也不依赖可执行位，因为
// Windows 上两者都不可靠。一个 `.sh` 在这个项目的主力开发平台上跑不起来。
// 官方说"在 shell 里跑"，所以命令写成 `node "..."` 两边都成立。
//
// ## 配法
//
//   "headersHelper": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/auth-headers.js\""
//
// key 从环境变量取（`.claude/settings.local.json` 的 `env` 或本机密钥库），
// **不进版本库**。

const KEY = process.env.MEM0_API_KEY || '';

if (KEY.trim() === '') {
  // **不输出空 header，也不输出 {}。**
  //
  // 输出 `{"Authorization":"Bearer "}` 是拿一个坏 header 去连——服务端
  // 回 401，而用户看到的是"检索不到经验"。
  // 输出 `{}` 是静默退回 OAuth 浏览器登录——在 CI 或无浏览器环境里，
  // 那正是配了 headersHelper 要避免的情形，却不会有任何提示。
  //
  // 两种都是静默失效。这里选响亮地失败。
  process.stderr.write(
    '缺 MEM0_API_KEY —— headersHelper 取不到凭据。\n'
    + '把它放进 .claude/settings.local.json 的 env（不进版本库）或本机密钥库。\n'
    + '若本来就打算走 OAuth 浏览器登录，那就不该配 headersHelper。\n',
  );
  process.exitCode = 1;
} else {
  // mem0 的 MCP 端点用 Bearer——2026-09-03 对活端点实测过（tools/list 实得
  // 11 个工具）。**注意 REST 那一侧未验**：mem0.js 里写的是 `Token`，
  // 两侧是否一致要由 `selfcheck --mem0` 去测。
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${KEY}` }));
}
