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

**它会执行 `evidence_cmd`，而条目来自团队共享的云端库。** 2026-09-02 的落地评审实测出三条可执行的攻击（假冒白名单程序、`git --upload-pack=` 拉起外部脚本、`find -fprintf` 写任意文件），三条当时均返回 `pass`。**已修，每条都有回归用例。**

现在的边界是四道：拒绝 shell 元字符 → 不经 shell 执行 → 程序名必须是裸名 → **子命令与每一个选项都必须被显式允许，路径参数关进 `--cwd` 之内**。要放宽只能改 `COMMAND_RULES`，是一次有意的动作。

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
