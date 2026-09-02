# experience

团队经验沉淀。捕获编码错误 → 三层治理 → 入云端 mem0 → 按提示检索注入。

完整设计与依据见仓库根 [`DESIGN.md`](../../DESIGN.md)。本文件只写**这个包怎么运作、当前做到哪一步**。

## 组成

| 路径 | 状态 |
| --- | --- |
| `.mcp.json` | ✅ 云端 mem0（`https://mcp.mem0.ai/mcp`，HTTP，OAuth） |
| `hooks/hooks.json` | ✅ 一条：deny 裸调用 mem0 的写入与删除工具 |
| `skills/experience-intake/` | ⬜ 未建 |
| `scripts/experience-write` | ⬜ 未建 |
| `scripts/assert-replay` | ⬜ 未建 |

**未建的部分刻意不留空壳。** 一个带 description 却没有正文的 skill 会被模型加载并给出空指引；一个静默退出的脚本会让"写入失败必须硬失败"这条约束落空。空目录比空契约安全。

## 当前唯一生效的行为

`PreToolUse` 拦下 `add_memory` / `update_memory` / `delete*`，一律拒绝并给出理由。

**这在写入脚本落地之前就是正确行为**——写入必须走脚本，脚本还不存在，所以现在什么都不该写进去。检索类工具（`search_memories` / `get_memories` / …）不受影响。

## 改动 matcher 前必读

hook matcher 有两个**静默失效**点，都不报错：

1. **插件的 MCP 工具名带 plugin 前缀**——是 `mcp__plugin_experience_mem0__<tool>`，**不是** `mcp__mem0__<tool>`。
2. **无正则字符的匹配值按精确字符串比较**——`mcp__plugin_experience_mem0` 一个工具也匹配不到。

因此 **`plugin.json` 的 `name` 或 `.mcp.json` 的 server 名一旦改动，matcher 必须同步改**。

守门的是 [`evals/hook-matcher.test.js`](../../evals/hook-matcher.test.js)，它复刻了官方的 matcher 分派规则并对上述两种错写法做反向对照：

```bash
node evals/hook-matcher.test.js
```

## 开发

```bash
claude --plugin-dir ./plugins/experience   # 免安装加载
/reload-plugins                            # 改完热载
claude plugin validate ./plugins/experience
```

## 约定

- hook 脚本**不得依赖 `jq`**（本机未安装，而官方示例几乎全用它，会静默失败）
- 脚本路径一律用 `${CLAUDE_PLUGIN_ROOT}`，写死路径会在别人机器上断
