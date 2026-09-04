# experience

团队经验沉淀。捕获编码错误 → 三层治理 → 入云端 mem0 → 按提示检索注入。

完整设计与依据见仓库根 [`DESIGN.md`](../../DESIGN.md)。本文件只写**这个包怎么运作、当前做到哪一步**。

## 组成

| 路径 | 做什么 |
| --- | --- |
| `.mcp.json` | 云端 mem0（`https://mcp.mem0.ai/mcp`，HTTP，OAuth），供 agent 做临时检索 |
| `hooks/hooks.json` | 两条，**失败方向相反**，见下 |
| `hooks/recall.js` | 每轮提示按内容检索经验，**注入前逐条校验**，带双上限 |
| `hooks/deny.js` | 拒绝裸调用 mem0 的写入与删除工具 |
| `skills/experience-intake/` | 判"值不值得记"——三镜头、九类垃圾、乙分支的信号与锚 |
| `scripts/experience-write.js` | 入库的唯一通道：形状 → 红线 → 自检 → 查库 → 分支 → 写入 |
| `scripts/assert-replay.js` | 重跑断言 + 符号存在性校验，上面两条都靠它 |
| `scripts/mem0.js` | REST 客户端，写入与检索共用一份契约 |
| `scripts/selfcheck.js` | **装好之后先跑它**，见下 |

**两条 hook 的失败方向是相反的，改动前先看清楚：**

| hook | 解释器缺失时 | 为什么 |
| --- | --- | --- |
| `deny`（`PreToolUse`） | **失败关闭**（`\|\| exit 2`） | 放行就等于绕过写入脚本的全部把关 |
| `recall`（`UserPromptSubmit`） | **失败开放** | 这里非 0 退出码会挡住用户这一轮提问；**取不到经验绝不能是"不许提问"** |

**把 `recall` 照抄成 `\|\| exit 2` 就是把它改坏。** 有用例守着这一条。

## 配置：两个值由你的项目自己定

**本插件不预设默认值。** 共享库的 scope 若有默认值，两个不相干的团队会共用同一个库——别人的经验会进你的每一轮提示。

| 环境变量 | 是什么 | 放哪 |
| --- | --- | --- |
| `MEM0_USER_ID` | 共享库的 scope，**团队里所有人必须填同一个值** | 项目 `.claude/settings.json` 的 `env`——不是凭据，**该进版本库** |
| `MEM0_API_KEY` | REST 写入的凭据 | `.claude/settings.local.json` 的 `env` 或本机密钥库，**不进版本库** |

两者归属不同才分开放：scope 是团队约定，key 是个人凭据。写反了要么共享失效，要么把 key 提交进库。

### 不要把凭据写进 `.mcp.json`

**默认不用配任何凭据**——MCP 走 OAuth 浏览器登录，`.mcp.json` 里只有 URL。

需要用 API key 的场景（CI、无浏览器），加这一行，**凭据仍然只在环境变量里**：

```json
"headersHelper": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/auth-headers.js\""
```

| 别写 | 为什么 |
| --- | --- |
| `"headers": { "Authorization": "Bearer m0-…" }` | 静态字段，写上就等于把 key 提交进版本库 |
| `"oauth": { "clientSecret": "…" }` | `oauth` 是受支持字段，但 `clientSecret` 一样是凭据；官方示例给的是 `clientId` + `callbackPort`，不含 secret |

**两条都有用例守着**（`evals/no-credentials.test.js`），整个已跟踪仓库都在扫描范围内。

取不到 key 时 `auth-headers.js` **非 0 退出并说明原因**，不输出 `{}` 也不输出空 header——前者静默退回 OAuth 登录（CI 里正是配它要避免的），后者拿坏 header 去连、服务端回 401，而你看到的是"检索不到经验"。

**缺任何一个都硬失败，不静默降级**——缺 scope 则写进去的取不回来，缺 key 则"记下了"其实什么都没发生。**检索走 MCP、写入走 REST，两条路必须取到同一对值**，否则表现是"写入成功但永远检索不到"且两端都不报错。自检覆盖这一项。

## 装好之后先跑自检

```bash
node plugins/experience/scripts/selfcheck.js --cwd <你的仓库>
node plugins/experience/scripts/selfcheck.js --cwd <你的仓库> --mem0   # 需 MEM0_API_KEY + MEM0_USER_ID
```

**`--mem0` 用的是你自己的 key，在你自己的项目里跑——凭据不进任何仓库，也不必给任何人。** 它做两件事：探 MCP 的工具名与 deny hook 的 matcher 对不对得上；发一次**只读**检索验 REST 的路径与鉴权头（`Token` 与 `Bearer` 都试，报告哪种成立）。

**它不验写入路径**——自检不往你的共享库里塞探针经验，那是用探活污染真实数据。写入只能由第一条真经验来验。

**为什么必须跑**：本插件的强制点全部是**静默失效型**的——

- `node` 不在 PATH 时，deny 闸门**放行且不留痕**（`cmd.exe` 下退出码是 0）
- 只有 `grep` 没有 `rg` 的机器上，符号检索慢数倍，可能直接超出注入预算
- MCP 连不上时，检索静默返回空——看起来像"没有相关经验"
- **REST 契约（路径、鉴权头）尚未对活端点验证过**，写错了的表现是"写得进去但检索不到"，两端都不报错

**正常使用中你看不见这些**：你会以为闸门在、经验在，实际都不在。自检逐项实跑（包括把解释器换成不存在的程序、确认闸门仍以 exit 2 阻断）并打印耗时，**输出可以直接贴出来**。

## 已生效的行为

**闸门**：`PreToolUse` 拦下 `add_memory` / `update_memory` / `delete*`，一律拒绝并给出理由。写入只能走 `experience-write.js`，因为**查库、红线过滤与硬失败都落在那里**——绕过它，"必须撞上第二次才进检索"这条规则就没有执行者了。检索类工具（`search_memories` / `get_memories` / …）不受影响。

**检索**：`UserPromptSubmit` 每轮按提示内容检索 `status: confirmed` 的经验，**逐条跑 `assert-replay --mode symbols` 之后才注入**——`verdict` 不是 `pass`、或 `verified` 不是 `true` 的一律不注入。时间账：检索 ≤ 1,500 ms + 校验 ≤ 2,000 ms，最坏约 3,500 ms/轮。注入上限 5 条 / 1,500 tokens。

**"取回后请先跑 `evidence_cmd` 再采信"是一条没有执行者的要求**，所以校验做成了注入前的机器动作，agent 想跳过也跳不掉。

**写入**：`experience-write.js` 是唯一通道。它会真的执行你写的 `evidence_cmd`（`--mode full`，在你自己机器上跑你自己写的命令），真的查库，写失败就硬失败——**退出码非 0 表示库里什么都没多**。先用 `--dry-run` 看它会写什么。

**`assert-replay.js`**：可独立使用，不依赖 mem0。

```bash
node plugins/experience/scripts/assert-replay.js <entry.json|-> \
  [--mode symbols|full] [--cwd dir] [--budget ms] [--timeout ms] [--allow a,b] [--backend rg|grep] [--quiet]
```

**按消费方分层，默认不执行任何命令**——两个检查的威胁面差一个量级：符号存在性的不可信输入只有一个被正则收死的标识符；重跑则整条命令来自共享库。

| 消费方 | `--mode` | 为什么 |
| --- | --- | --- |
| 写入自检 | `full` | 命令是作者自己写的、在他自己机器上跑，威胁模型消失 |
| **注入前校验** | **`symbols`**（默认） | 挂在每轮提示上，**不执行任何命令**；默认 2 秒总预算 |
| 人工离线审计 | `full` | 由人触发、偶尔跑，边界在这条路径上仍然全副武装 |

**执行命令必须显式 `--mode full`**——粗心的调用方默认拿到安全的那一半，而不是反过来。

条目形如：

```json
{
  "id": "…",
  "metadata": {
    "evidence_cmd": "git rev-parse --is-inside-work-tree",
    "evidence_digest": { "exit": 0, "contains": ["true"] },
    "files": ["DESIGN.md"],
    "symbols": ["ZzWidget.attachToList"]
  }
}
```

退出码 0 = 全部通过，1 = 有条目未通过，2 = 用法或输入错误。

**它会执行 `evidence_cmd`，而条目来自团队共享的云端库。** 两轮独立评审各实测出一批可执行的攻击——第一轮是程序名白名单的漏洞（假冒二进制、`git --upload-pack=`、`find -fprintf`），第二轮是词法路径检查的漏洞（`~` 与 glob 由 MSYS coreutils 自行展开、符号链接）。**全部已修，每条都有回归用例。**

现在的边界是五道：

1. 拒绝 shell 元字符、glob 字符、控制字符、`~` 开头、反斜杠转义的引号
2. 不经 shell 执行
3. 程序名必须是裸名（含路径分隔符即拒绝）
4. 子命令与**每一个选项**都必须在 `COMMAND_RULES` 里被显式允许
5. 路径形态的参数做 **realpath 物理围栏**，解析链接后必须仍在 `--cwd` 内

要放宽只能改 `COMMAND_RULES`，是一次有意的动作。

**结果的三个判定字段**——`verdict` / `ok` / **`verified`**。`verified: false` 表示"没验过"（跳过、后端不可用），**不是**"验证不过"。淘汰只能对 `verdict: fail` 且 `verified: true` 生效；注入前校验必须把 `verified: false` 当作不可采信。

**判定结果不回写共享库**：pass/fail 一旦写回，写这条经验的人就读得回来，而 `evidence_cmd` 由他自己写——那是一条可逐字符爆破的出向信道。

**已知残留**：超时只杀直接子进程，孙进程会活下来。收紧允许列表后能起进程树的只剩本仓库自己的测试命令，因此是资源问题不是安全问题。

**依赖 Node。** 脚本以 `node <path>` 调用，不依赖 shebang。

## 改动 matcher 前必读

hook matcher 有两个**静默失效**点，都不报错：

1. **插件的 MCP 工具名带 plugin 前缀**——是 `mcp__plugin_experience_mem0__<tool>`，**不是** `mcp__mem0__<tool>`。
2. **无正则字符的匹配值按精确字符串比较**——`mcp__plugin_experience_mem0` 一个工具也匹配不到。

因此 **`plugin.json` 的 `name` 或 `.mcp.json` 的 server 名一旦改动，matcher 必须同步改**。

守门的是 [`evals/hook-matcher.test.js`](../../evals/hook-matcher.test.js)，它复刻了官方的 matcher 分派规则并对上述两种错写法做反向对照：

```bash
node evals/run-all.js
```

同一份用例还会**实跑 deny 命令**并断言输出是可解析的 deny 决策，并以旧写法（`echo '单引号 JSON'`）作反向对照——旧写法在 `cmd.exe` 下解析失败、闸门静默放行，这正是它被换掉的原因。

## 开发

```bash
claude --plugin-dir ./plugins/experience   # 免安装加载
/reload-plugins                            # 改完热载
claude plugin validate ./plugins/experience
```

## 约定

- hook 脚本**不得依赖 `jq`**（本机未安装，而官方示例几乎全用它，会静默失败）
- 脚本路径一律用 `${CLAUDE_PLUGIN_ROOT}`，写死路径会在别人机器上断
