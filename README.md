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

设计完成，实现刚起步。已落地两件：

- **闸门**：拦下对 mem0 写入与删除工具的直接调用。写入必须走脚本，而写入脚本尚未落地，所以现在什么都不该被写进经验库。
- **`assert-replay`**：重跑经验里的 `evidence_cmd` 并校验符号存在性。不依赖 mem0，可独立使用。

`skills/`、`scripts/experience-write` 刻意未建空壳，理由见[插件 README](plugins/experience/README.md)。

**mem0 的行为已于 2026-09-03 对活端点实测**：工具名、`infer=false` 的效果、metadata 的序列化形状、按 metadata 过滤、异步索引延迟——结论见 `DESIGN.md`「已实测的 mem0 行为」。现行 hook matcher 已确认覆盖得住写入与删除类工具。

**仍未确认的两项**，见 `DESIGN.md`「仍未确认的」：受管环境的 `allowManagedHooksOnly` 可能整体禁用本项目的 hook；凭据注入用的 `headersHelper` 尚未实测。
