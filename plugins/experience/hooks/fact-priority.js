'use strict';
//
// fact-priority —— 目标四「仅将架构、代码作为事实，spec、adr 等仅供参考」
// 在**读的那一刻**的执行者。
//
// ## 危险时刻在哪
//
// DESIGN 的实证结论：所有严重误诊都是同一形状——**文档或记忆说 X，实跑是 Y**。
// 那一刻不是有人**写**文档的时候，是有人**读**了文档并采信它的时候。
//
// 因此这条 hook 挂 `PostToolUse` 的 `Read`：文档内容刚进上下文，优先级约束
// 紧跟着进去。不依赖 agent 记得加载什么，也不依赖它读过哪份 skill。
//
// ## 为什么不是 `.claude/rules/` 的路径作用域规则
//
// 原设计选的是那个，理由同样是"读到匹配文件时才载入，执行者与失效点对齐"。
// **但 2026-09-04 查官方文档确认：插件不能提供 rules。**
// 插件的组件类型是 skills / commands / agents / workflows / hooks /
// .mcp.json / .lsp.json / output-styles / themes / monitors —— 没有 rules，
// `.claude/rules/` 是项目级功能。
//
// 那条设计因此不成立，与 `auth-headers.sh` 是同一个形状：**规矩指向一个
// 装不上的东西**。换成 hook 之后失效点没变，只是执行者换成了插件带得走的。
//
// ## 能力边界，说清楚
//
// **这是注入，不是拦截。** 它把优先级摆到上下文里，agent 仍然可以不照做。
// 目标四唯一的**硬**强制仍然只有 assert-replay（真的去跑那条命令、真的去
// 查那个符号）。原设计选路径作用域规则时也是注入，这一点没有变差。
//
// 它值得存在的理由是**时机**：一句写在 skill 里的"以代码为准"，只在 agent
// 恰好加载了那份 skill 时才在场；而误诊发生在读文档的那一刻。

const fs = require('fs');

// 只认 Markdown。**这条限制是必需的**——否则 `foo.spec.ts`、`bar_test.py`
// 这类测试文件会被"spec"命中，而它们是代码，不是待降级的参考材料。
const MARKDOWN = /\.(md|markdown)$/i;

// 三类文档的过期方式不同，所以说法也不同。
//
//   描述类  会过期，且无声——代码改了它不会跟着改
//   spec    不描述现状，它记的是当初打算怎么做
//   ADR     **不会过期**：决策发生过就是发生过，即便后来被推翻，
//           记录本身仍然准确——但它同样不描述现状
const KINDS = [
  {
    key: 'adr',
    // adr 放在 spec 之前判：docs/adr/xxx-design.md 这类路径两边都沾，
    // 而 ADR 的性质更特殊，先判它。
    test: (p) => /(^|\/)(adr|adrs|decisions|decision-records)(\/|$)/.test(p),
    note: '这是架构决策记录：它记录当初为什么这么决定，append-only。即便该决策后来被推翻，记录本身仍然准确——但它不描述系统现状。判断现状请读代码。',
  },
  {
    key: 'architecture',
    test: (p) => /(^|\/)(architecture|架构)(\/|$)/.test(p),
    note: '这是描述类架构文档：它描述系统现在长什么样，而正确性来源是代码。**与代码冲突时一律以代码为准**，并就地更正描述。',
  },
  {
    key: 'spec',
    test: (p) => /(^|\/)specs?(\/|$)/.test(p) || /-design\.(md|markdown)$/i.test(p),
    note: '这是 spec / 设计文档：它是当初的意图与方案，**仅供参考，不是当前事实**。判断系统现在如何，以代码为准。',
  },
];

/** @returns {{key: string, note: string} | null} */
function classify(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return null;
  const p = filePath.replace(/\\/g, '/').toLowerCase();
  if (!MARKDOWN.test(p)) return null;
  for (const k of KINDS) if (k.test(p)) return { key: k.key, note: k.note };
  return null;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return emit({}); }

  const hit = classify(input.tool_input && input.tool_input.file_path);
  if (!hit) return emit({});

  // **用 systemMessage，不是 additionalContext。**
  //
  // 2026-09-04 首版写的是 `hookSpecificOutput.additionalContext`，而查文档
  // 确认：**`additionalContext` 在 `PostToolUse` 上不是受支持字段**（它支持
  // 的是 `PreToolUse` / `UserPromptSubmit` / `PostToolBatch` / 两个
  // `ModelSwitch`）。`PostToolUse` 支持的是 `systemMessage` 与
  // `terminalSequence`。
  //
  // 后果不是"少一句提示"——**这条 hook 会一声不响地什么都不做**，而它看起来
  // 装好了、用例也全绿（用例只断言了脚本自己的输出形状，断言不到 harness
  // 认不认那个字段）。**又一次"声称有执行者，执行者不在那一层"。**
  //
  // `systemMessage` 在这里恰好是更合适的通道：官方原话是
  // 「On `PostToolUse` and `PostToolUseFailure`, it's shown to Claude after
  // the tool output」——文档内容刚进上下文，约束紧跟其后，正是要的时机。
  return emit({ systemMessage: hit.note });
}

if (require.main === module) {
  try { main(); } catch (e) {
    // 读文件这件事绝不能因为这条 hook 而出错。
    process.stderr.write(`fact-priority 异常：${(e && e.message) || e}\n`);
    emit({});
  }
}

module.exports = { classify, KINDS, MARKDOWN };
