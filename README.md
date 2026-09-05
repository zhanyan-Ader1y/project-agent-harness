# project-agent-harness

以 Claude Code plugin 的形式增强 superpowers，让 AI 带着项目语境进场。

四条目标见 [`DESIGN.md`](DESIGN.md)：意图确立、review 增强、经验沉淀、事实准确。

贯穿全篇的一条原则——**每条规则都要挪到产生它的那一层去执行**。写成条款而执行者不在那一层的规则，会被一致地、有记录地绕过。因此本项目的分工固定为：**判断放 skill，机械动作放脚本，强制放 hook。**

## 目录

| 路径 | 内容 |
| --- | --- |
| [`DESIGN.md`](DESIGN.md) | 设计：**最小可用发布**所需的决策、依据、前提假设与退路 |
| [`docs/deferred.md`](docs/deferred.md) | 分档移出的设计：原文 + 为什么不在最小可用 + **拿回条件** |
| [`plugins/experience/`](plugins/experience/) | 经验沉淀插件（唯一在建） |
| [`evals/`](evals/) | 评测用例。skill / hook / 脚本一变更即跑 |
| [`docs/references/`](docs/references/) | 外部参考的提炼，各带来源与读取日期 |
| [`docs/review/`](docs/review/) | 评审发现与逐条处置追踪 |
| `docs/decisions/` | ADR（尚无） |

## 安装

```bash
/plugin marketplace add <owner>/project-agent-harness
/plugin install experience@project-agent-harness
```

团队统一推广写进项目的 `.claude/settings.json`：

```json
{
  "extraKnownMarketplaces": {
    "project-agent-harness": {
      "source": { "source": "github", "repo": "<owner>/project-agent-harness" }
    }
  },
  "enabledPlugins": { "experience@project-agent-harness": true }
}
```

## 开发

```bash
claude --plugin-dir ./plugins/experience    # 免安装加载
claude plugin validate ./plugins/experience
node evals/run-all.js                        # 全部评测用例
```

## 当前进度

**部件齐了，闭环还差最后一步。** 5 个脚本 + 3 条 hook + 1 个 skill，2,301 行，**7 份 eval 共 487 项断言**，CI 双 OS matrix 全绿。

最小可用的定义是一句话，它有三段——**三段的成熟度不一样**：

| | 执行者 | 状态 |
| --- | --- | --- |
| 一条经验能**写进**跨会话跨成员共享的库 | `scripts/experience-write.js` | 🟡 已落地，**端到端未跑通** |
| 下次相关提问时它**自动回到**上下文 | `hooks/recall.js`（`UserPromptSubmit`） | 🟡 已落地，**端到端未跑通** |
| 注入前**机器验过**它声称的符号真的存在 | `scripts/assert-replay.js` | ✅ 完全可验、已验 |

**两处 🟡 卡在同一件事**：写入与检索共用 `scripts/mem0.js` 的 REST 契约，而**那份契约没有对活端点跑通过**——本机没有可用的 key。已实测的只有 MCP 那一侧。契约错了的表现是**"写得进去但检索不到"，两端都不报错**，所以不声称它可用。

**解法不需要把 key 给任何人**：在你自己的项目里配好 `MEM0_USER_ID` 与 `MEM0_API_KEY`，跑一次 `node plugins/experience/scripts/selfcheck.js --cwd . --mem0`。它只发**只读**检索。

### 四条目标的落地程度并不均衡

| 目标 | 执行者 | 状态 |
| --- | --- | --- |
| 经验沉淀 | 写入脚本 + 检索 hook + intake skill | 🟡 主体已落地，卡在 REST |
| 事实准确 | `assert-replay`（硬强制）+ `fact-priority` hook（读时注入） | 🟡 两个消费方接了两个，另两个随淘汰延后 |
| 意图确立 | — | ❌ **一个执行者都没有**，整条见 `docs/deferred.md` |
| review 增强 | — | ❌ 整条延后，是延后项里成本最低的一个 |

### 已实测 / 仍未确认

**已实测**：mem0 的 MCP 侧行为（工具名、`infer=false` 不整合、metadata 是字符串键值模型、按 metadata 过滤、异步索引延迟约 725ms，2026-09-03）；`type: "agent"` hook 可用；`headersHelper` 的契约与 `${CLAUDE_PLUGIN_ROOT}` 的展开范围（2026-09-04 查官方文档）。

**仍未确认只剩一项**：受管环境的 `allowManagedHooksOnly` 可能整体禁用本项目的 hook，闸门静默失效——团队推广前须确认。
