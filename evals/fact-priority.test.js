#!/usr/bin/env node
'use strict';
// eval 种子用例 6：目标四在"读的那一刻"的执行者。
//
// 目标四是「仅将架构、代码作为事实，spec、adr 等仅供参考」。DESIGN 的实证
// 结论是：所有严重误诊都是同一形状——**文档或记忆说 X，实跑是 Y**。
// 那一刻不是有人**写**文档的时候，是有人**读**了文档并采信它的时候。
//
// 这组用例守三件事：
//   1. 三类文档各自被认出来，且说法不能被软化成无用
//   2. **代码不得被当成参考材料降级**——foo.spec.ts 命中就是把事实降级成参考，
//      方向正好反了
//   3. 这条 hook 永远不能挡住一次 Read
//
// 用法：node evals/fact-priority.test.js   （失败时退出码非 0）

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const F = require('../plugins/experience/hooks/fact-priority.js');

const REPO = path.join(__dirname, '..');
const HOOK = path.join(REPO, 'plugins', 'experience', 'hooks', 'fact-priority.js');
const HOOKS_JSON = path.join(REPO, 'plugins', 'experience', 'hooks', 'hooks.json');

let failures = 0;
const g = (name) => console.log(`\n${name}`);
const ok = (cond, label, extra) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
};
const kindOf = (p) => { const r = F.classify(p); return r ? r.key : null; };

// ---------------------------------------------------------------------------
g('三类文档各自认得出');
ok(kindOf('docs/architecture/modules.md') === 'architecture', '描述类架构');
ok(kindOf('docs/架构/模块清单.md') === 'architecture', '中文目录名同样认得');
ok(kindOf('docs/adr/0007-use-mem0.md') === 'adr', 'ADR');
ok(kindOf('docs/decisions/0001-x.md') === 'adr', 'decisions/ 也是 ADR');
ok(kindOf('docs/superpowers/specs/2026-08-07-x-design.md') === 'spec', 'spec 目录');
ok(kindOf('notes/thing-design.md') === 'spec', '-design.md 结尾也算 spec');
ok(kindOf('docs/architecture/adr/0001-x.md') === 'adr',
  '两边都沾时判 ADR——它的性质更特殊（不描述现状，且不会过期）');

// ---------------------------------------------------------------------------
g('★ 代码绝不能被降级成参考材料');
{
  // **这是方向性错误，比漏判严重得多。** 目标四说代码**是**事实；把一个
  // 代码文件标成"仅供参考"，正好把这条目标反过来执行。
  // 守它的是"只认 Markdown"这条限制——去掉它，下面几条立刻全错。
  for (const p of ['src/widget.spec.ts', 'tests/foo.spec.js', 'app/specs/bar.py',
    'lib/architecture/graph.rs', 'internal/adr/registry.go']) {
    ok(F.classify(p) === null, `不注入：${p}`, kindOf(p) || '');
  }
}

// ---------------------------------------------------------------------------
g('不相干的文件一概不注入');
for (const p of ['README.md', 'docs/references/playbook.md', 'CHANGELOG.md', '']) {
  ok(F.classify(p) === null, `不注入：${JSON.stringify(p)}`, kindOf(p) || '');
}
ok(F.classify(undefined) === null && F.classify(null) === null && F.classify(42) === null,
  '路径不是字符串时不崩');

// ---------------------------------------------------------------------------
g('说法不能被软化成无用');
{
  // 一句"请注意架构文档可能过时"什么也不改变。每一类都必须给出**可据以
  // 行动的优先级**，否则这条 hook 只是在每次 Read 后加一句废话。
  const byKey = Object.fromEntries(F.KINDS.map((k) => [k.key, k.note]));
  ok(/以代码为准/.test(byKey.architecture), '描述类：明说与代码冲突时以代码为准', byKey.architecture);
  ok(/更正/.test(byKey.architecture), '描述类：明说该就地更正描述');
  ok(/仅供参考|不是当前事实/.test(byKey.spec), 'spec：明说仅供参考、不是当前事实', byKey.spec);
  ok(/不描述系统现状|不描述现状/.test(byKey.adr), 'ADR：明说它不描述现状', byKey.adr);
  ok(/仍然准确|append-only/.test(byKey.adr), 'ADR：同时说明它本身不会过期——这一条与另两类相反');
}

// ---------------------------------------------------------------------------
g('hooks.json 接线');
{
  const h = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks;
  ok(Array.isArray(h.PostToolUse) && h.PostToolUse.length === 1, '有一条 PostToolUse');
  const entry = h.PostToolUse[0];
  ok(entry.matcher === 'Read', "matcher 是精确串 'Read'", JSON.stringify(entry.matcher));
  ok(/fact-priority\.js/.test(entry.hooks[0].command), '命令指向 fact-priority.js', entry.hooks[0].command);
  // 与 recall 同理：PostToolUse 上非 0 退出会把错误抛回给模型。读文件这件事
  // 不能因为这条 hook 而出问题，所以不加 `|| exit N`。
  ok(!/exit\s+\d/.test(entry.hooks[0].command), '不得有 `|| exit N`——读文件不能被它挡住');

  // matcher 分派规则的复刻（与 hook-matcher.test.js 同一套）：只含
  // 字母数字与 _ - 空格 , | 的匹配值按**精确字符串**比较，不当正则。
  const matches = (m, tool) => (/^[A-Za-z0-9_\-, |]+$/.test(m)
    ? m.split(/[|,]/).map((s) => s.trim()).filter(Boolean).includes(tool)
    : new RegExp(m).test(tool));
  ok(matches(entry.matcher, 'Read'), '实际能命中 Read');
  for (const t of ['Edit', 'Write', 'Grep', 'Bash']) {
    ok(!matches(entry.matcher, t), `不命中 ${t}`);
  }
}

// ---------------------------------------------------------------------------
g('端到端：永远输出可解析 JSON，永远不挡住 Read');
const run = (stdin) => {
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: REPO, encoding: 'utf8', input: stdin, timeout: 30000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* 下面断言 */ }
  return { code: r.status, json, out: r.stdout };
};
{
  const a = run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'docs/architecture/x.md' } }));
  ok(a.code === 0, '命中时退出码 0', `code=${a.code}`);
  ok(a.json && a.json.hookSpecificOutput
    && a.json.hookSpecificOutput.hookEventName === 'PostToolUse'
    && /以代码为准/.test(a.json.hookSpecificOutput.additionalContext),
  '命中时以 additionalContext 注入', JSON.stringify(a.json).slice(0, 70));

  const b = run(JSON.stringify({ tool_input: { file_path: 'src/main.ts' } }));
  ok(b.code === 0 && JSON.stringify(b.json) === '{}', '不命中时输出 {}，退出码 0');

  for (const bad of ['not json', '', 'null', '[]', '{"tool_input":null}']) {
    const r = run(bad);
    ok(r.code === 0 && r.json !== null, `畸形输入不崩、不挡 Read：${JSON.stringify(bad)}`, `code=${r.code} out=${r.out.slice(0, 30)}`);
  }
}

// ---------------------------------------------------------------------------
g('能力边界，如实写在代码里');
{
  const src = fs.readFileSync(HOOK, 'utf8');
  ok(/这是注入，不是拦截/.test(src),
    '文件里明写它是注入不是拦截——目标四唯一的硬强制仍然只有 assert-replay');
  ok(/插件不能提供 rules/.test(src),
    '并记下原设计（.claude\\/rules 路径作用域规则）为什么不成立');
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} 项`}`);
process.exitCode = failures === 0 ? 0 : 1;
