# experience

团队经验沉淀。捕获编码错误 → 三层治理 → 入云端 mem0 → 按提示检索注入。

完整设计与依据见仓库根 [`DESIGN.md`](../../DESIGN.md)。本文件只写**这个包怎么运作、当前做到哪一步**。

## 组成

| 路径 | 状态 |
| --- | --- |
| `.mcp.json` | ✅ 云端 mem0（`https://mcp.mem0.ai/mcp`，HTTP，OAuth） |
| `hooks/hooks.json` | ✅ 一条：deny 裸调用 mem0 的写入与删除工具 |
| `scripts/assert-replay.js` | ✅ 重跑断言 + 符号存在性校验 |
| `skills/experience-intake/` | ⬜ 未建 |
| `scripts/experience-write` | ⬜ 未建 |

**未建的部分刻意不留空壳。** 一个带 description 却没有正文的 skill 会被模型加载并给出空指引；一个静默退出的脚本会让"写入失败必须硬失败"这条约束落空。空目录比空契约安全。

## 已生效的行为

**闸门**：`PreToolUse` 拦下 `add_memory` / `update_memory` / `delete*`，一律拒绝并给出理由。**这在写入脚本落地之前就是正确行为**——写入必须走脚本，脚本还不存在，所以现在什么都不该写进去。检索类工具（`search_memories` / `get_memories` / …）不受影响。

**`assert-replay.js`**：可独立使用，不依赖 mem0。

```bash
node plugins/experience/scripts/assert-replay.js <entry.json|-> [--cwd dir] [--timeout ms] [--allow a,b] [--quiet]
```

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
