#!/usr/bin/env node
'use strict';
//
// PreToolUse 闸门：拒绝直接调用 mem0 的写入与删除工具。
//
// 为什么是脚本而不是 hooks.json 里的一行 echo：
// 上一版用 `echo '{"...":...}'`，单引号只有 POSIX shell 认。在 cmd.exe 下
// 输出会带着两个单引号，JSON 解析失败 → PreToolUse 拿不到决策 → 工具照常
// 执行。**唯一生效的闸门在错误的 shell 下失效，且不报错**——正是本项目最
// 怕的那类静默失效，而本仓库在 Windows 上开发。
//
// 现在 JSON 由 node 生成，shell 只负责启动进程；hooks.json 里用双引号包路径
// （POSIX sh 与 cmd.exe 都认双引号，都不认单引号）。

const reason = [
  '经验库不接受直接调用 mem0 的写入或删除工具。',
  '写入须经 scripts/experience-write：查库 → Review/Dedup/Merge 三层判定 → 红线过滤 → infer=False 写入。',
  '删除一律禁止；要撤回一条经验，改写它的 status 为 retracted。',
].join('');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
}));
