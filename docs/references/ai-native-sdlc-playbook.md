# 参考：The AI-Native SDLC Playbook

- **来源**：<https://claude.com/blog/the-ai-native-sdlc-playbook>（Anthropic 官方）
- **读取日期**：2026-09-02
- **定位**：把 Claude 嵌入软件生命周期六个阶段的官方实践指南。本文件**不是原文摘要**，只保留对本项目（`DESIGN.md` 四条目标）有参考价值的部分，并标明哪些印证了已有决策、哪些填补了空白、哪些与我们的选择冲突。

原文核心前提一句话：**"Code is no longer the bottleneck"**——瓶颈已从写代码转移到人速的审批闸门，所以要改的是流程，不只是工具。

---

## 一、直接印证本项目已定决策

这一节的价值在于：**这些不再是我们的一家之言**，官方实践给出了同样的结论。

| Playbook 的说法 | 本项目对应的决策 |
| --- | --- |
| Hooks 是**确定性**护栏，用于挡住不安全动作；对硬性要求，**hook 比建议性的 skill 更快也更可靠** | 「规则必须有可执行路径」。我们把经验检索、写入形状检查、删除拒绝全部放 hook，不放 skill |
| "**写代码的那个 agent 没有任何途径批准它自己**"（分离职责，分支保护要求 code owner 批准） | Themis 的 `实现者不得验证自身产出`（实测 11 次失效 10 次，补上可执行路径后 4/4） |
| 监控的**检测环节完全确定性，不含模型**；模型只在检测之后介入 | 同上。判定与执行分开，判定不能交给被判定者 |
| Skills 是**版本控制**的组织知识，带触发条件，策略变更时集中更新 | plugin 内 `skills/`，随仓库走 |
| 修 bug 时**先写失败测试，并用 hook 阻止 agent 编辑测试文件** | 具体可抄的模式，我们尚未设计 |
| 每阶段产出**提交进 git 的工件**，工件链本身就是审计轨迹 | 经验条目必须带 `commit` / `files` / `evidence_cmd` |

**最值得记住的一条**：官方明确把 hook 定位为"对硬性要求比 skill 更合适"。这和我们反复验证的结论一致——**skill 是给 agent 看的规则，没有执行者。**

---

## 二、填补本项目空白（本文件最有价值的部分）

以下是 `DESIGN.md` 完全没有涉及、而 playbook 有成熟做法的。

### 2.1 持续 eval：改 skill / hook 就跑，按通过率卡门 ★最重要

> 20–50 个真实任务配预期结果，构成 eval 套件。**当 `CLAUDE.md`、skills 或 hooks 发生变更时套件自动运行**，配置类变更以通过率为准入门槛。

**为什么对本项目关键**：我们打算写六个 skill 和四条 hook，但**没有任何手段判断改一版是变好还是变坏**。superpowers 的 `writing-skills` 讲了单个 skill 的 RED-GREEN 测法，这里给的是**组织级、持续跑**的版本。

没有它，plugin 会重蹈 Themis 的路——规则越加越多，没人知道哪条真的拦住过东西（Themis 实测：13 节规则里只有 4 条机制抓到过东西）。

### 2.2 每次线上事故变成一条永久 eval ★

> "Each production incident becomes permanent eval."

**这比我们设计的经验沉淀更强。** 我们目前定的是「经验只作检索参考」——取出来给 agent 看，用不用随它（TRACE 论文实测这条路有 57.5% 取到了也照样违反）。

Playbook 的终点不是记忆条目，是**一条会一直跑的测试**。**经验 → eval** 这条升级路径应当记在设计里，即便当前不做。

### 2.3 `REVIEW.md`：评审标准也是版本控制的工件

四个小节：**Passes**（评审类别）/ **What Important means**（严重度阈值）/ **Cap the nits**（吹毛求疵的数量上限）/ **Do not report**（排除项：生成文件、CI 已覆盖的检查）。

**直接喂给 `review-presentation` skill。** 特别是后两节——我们迁移过来的那份 skill 讲的是"怎么呈现"，没讲"什么不该报"，这是缺的一半。

### 2.4 `CLAUDE.md` 控制在一页以内

> Kept under one page to preserve context efficiency.

**这就是"别再长成 571 行控制面"的官方版本。** 建议把它写成本项目的硬约束，并用 `claude plugin details <name>` 的 token 估算定期核。

### 2.5 按环境分级放权

开发环境自由部署 / 预发布有条件 / 生产仅限预先批准。**回滚路径必须在 agent 能触发之前演练过。**

同一个分级思路可以搬到经验写入：本地实验随便写 / 团队共享区要过闸门。

### 2.6 每阶段都有 leading / lagging 指标

Playbook 给每个阶段配了两类指标，例如：

- Plan：从首次对话到提交 `intent.md` 的耗时（leading）／`intent.md` 进入下一阶段的存活率（lagging）
- Build：首轮就合入的比例（leading）／每次变更的返工轮数、合入 diff 与 `plan.md` 的吻合度（lagging）
- Test：agent 所写变更的**首轮 CI 通过率**（leading）／每个 PR 的评审耗时、变更失败率（lagging）

**本项目目前零指标。** 至少应当定一条：**经验被检索出来之后，有多少比例真的改变了行为**——这正是 access-compliance gap 的度量。

### 2.7 企业侧管控设置（团队推广时相关）

`permissions.deny/allow`、`sandbox`（OS 级隔离 + 域名白名单）、**`allowManagedHooksOnly`**（只允许批准过的闸门运行）、`strictKnownMarketplaces`（skill/plugin 必须来自组织 marketplace）、`requiredMinimumVersion`。

**注意 `allowManagedHooksOnly` 是双刃的**：它能保证只有批准的 hook 运行，也意味着**本项目的 hook 在这类环境里可能被整体禁用**，闸门静默失效。团队推广前必须确认。

---

## 三、与本项目设计冲突（要么改我们，要么写明为什么不同）

### 3.1 组织知识落在仓库内的 `CLAUDE.md`，不是远程记忆服务

Playbook 的做法：约定、命令、架构、**"Claude 常犯的错"**统统写进仓库根的 `CLAUDE.md`，会话开始时读取，版本控制，可评审。

**本项目已决定走云端 mem0 + MCP。** 差异是真实的：

| | Playbook（`CLAUDE.md`） | 本项目（云端 mem0） |
| --- | --- | --- |
| 共享范围 | 单仓库 | 跨仓库、跨工具、跨机器 |
| 可评审 | ✅ 走 PR | ❌ 无 diff |
| 逐字保留 | ✅ 就是文件 | ⚠️ `add_memory` 无 `infer` 参数，内容可能被 LLM 改写 |
| 上下文成本 | 每次会话全量读 | 按需检索 |

**这不是说我们选错了**——跨仓库共享是 `DESIGN.md` 明确的目标，`CLAUDE.md` 做不到。但**"可评审"和"逐字保留"这两项是我们付出的代价，应当在设计里写明**，而不是当作没有。

### 3.2 记录经验的阈值：**错两次**，不是错一次

> "When Claude makes a mistake twice, correction goes into `CLAUDE.md`."

**这条我们没有。** 目前 `experience-intake` 的准入判据是空的，而这是一个现成、可数、不留解释空间的门槛：**同一个错误发生第二次才记。**

好处是直接的：**一次性的偶发不会污染共享库**，而重复出现本身就证明了它可复现。建议直接采纳。

### 3.3 三份工件，不是十六份

Playbook 全流程只有三份核心工件：`intent.md` → `spec.md` → `plan.md`，加上 PR、测试、评审发现、事故记录构成审计链。

Themis 的对照数是**每个需求 16 份工件、约 1,200 行**。**三是个有用的锚**——本项目的工件数应当靠近三，而不是靠近十六。

---

## 四、可直接抄的模板骨架

### `intent.md`
```
# Intent: [标题]
Author: [name]. Status: [draft|approved].

## Problem            今天做不到什么
## Proposed outcome   更好的样子是什么
## Affected users and systems
## Constraints        边界与限制
## Open questions     尚未解决的
```

### `plan.md`
```
# Plan: [标题] (from intent.md [date])

## Files that change  具体路径
## Order of work      实施顺序
## Risks              可能坏掉什么
## Proof              测试与成功判据
```

### `CLAUDE.md`
```
# [服务名]
## Commands           Build / Test / Lint
## Conventions        风格、语言、架构规则
## Architecture       系统设计概览
## Things Claude gets wrong    常犯错误与更正
```

### `REVIEW.md`
```
# Review instructions
## Passes                 评审类别：bug / 安全 / 合规
## What Important means   严重度阈值定义
## Cap the nits           吹毛求疵的上限
## Do not report          排除项
```

**注意**：`CLAUDE.md` 的 `## Architecture` 一节正是我们讨论过的**描述类架构**——会过期且过期无声。抄这个模板时，这一节要配防过期机制（见 `DESIGN.md` 架构一节）。

---

## 五、反模式对照

| 反模式 | 为什么失败 | 替代 |
| --- | --- | --- |
| 委员会写需求 | 慢、有损、脱离实现 | 发起人 + Claude 头脑风暴 → `intent.md` |
| 需求与设计分阶段 | 交接丢失；策略违规到评审才发现 | 单次会话内合并，策略以 skill 形式**在写的时候就生效** |
| 代码先行 | 评审时才意外；返工贵 | plan mode → 批准 → 实现 |
| 人工逐行评审 | 瓶颈；量一大质量就降 | Claude 查机械项，人判意图与风险 |
| 知识只在工程师脑子里 | 上手慢、错误重复 | `CLAUDE.md` / skills / hooks 进 git |
| 被动响应事故 | 知识流失、重复发生 | 自动监测 → `intent.md` → 回到流程起点 |

---

## 六、值得逐字保留的原句

> "Code is no longer the bottleneck."

> "Both phases happen in a single prompted session."（需求与设计合并）

> "Work starts with a written plan that Claude produces in plan mode, where it can read the codebase without changing anything."

> "A session checks its own work and fixes its own mistakes before an engineer sees them."

> "The agent that wrote the code has no way to approve it."

> "A trigger invokes Claude without a person in the path. Claude diagnoses, acts only through gated routes, and writes what it finds as `intent.md`."

> "Every stage commits an artifact the next stage can read."

> "The loop keeps running. Human judgement stays above it."

---

## 七、落到本项目的行动项

**七条已于 2026-09-02 采纳，落点见 `DESIGN.md`。另有三项本文提出但未被采纳，一并列明——否则本节会被当成"空白已补完"的凭据。**

| # | 行动项 | 落在 `DESIGN.md` 何处 |
| --- | --- | --- |
| 1 | 「错两次才记」作为 `experience-intake` 准入阈值 | 经验如何沉淀 |
| 2 | eval 套件（20–50 真实任务），skill / hook 变更即跑、按通过率卡准入 | 约束；仓库结构 `evals/` |
| 3 | `REVIEW.md` 的「Cap the nits」「Do not report」并入 `review-presentation` | SKILL 清单 |
| 4 | 上下文预算硬约束（常驻 ≤ 400 tokens、单 SKILL ≤ 250 行，以实测修正） | 约束 |
| 5 | 写明选云端 mem0 放弃了可评审与逐字保留 | 经验如何沉淀 → 选云端 mem0 放弃了什么 |
| 6 | 记下「经验 → eval」升级路径 | 经验如何沉淀 |
| 7 | 团队推广前确认 `allowManagedHooksOnly` | 阻塞目标本身的未知 |

**未采纳的三项**（本文提出，`DESIGN.md` 中无落点）：

| 出处 | 内容 | 现状 |
| --- | --- | --- |
| 2.5 | 按环境分级放权（开发自由 / 预发布有条件 / 生产仅限预先批准） | **不做**。本项目不触碰部署，无对应环境 |
| 2.6 | 每阶段 leading / lagging 指标 | **部分做**。只采纳了一条——"经验取回后有多少比例真的改变了行为"，进 eval 套件。其余阶段指标未定 |
| 1（表内） | 修 bug 先写失败测试，用 hook 阻止 agent 编辑测试文件 | **未设计**。是可直接抄的模式，尚未排期 |
