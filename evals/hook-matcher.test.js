#!/usr/bin/env node
// eval 种子用例 1：闸门 matcher 必须真的匹配得上。
//
// 为什么需要它：Claude Code 的 hook matcher 有两个静默失效点，都不报错——
//   1. 插件提供的 MCP server，工具名是 mcp__plugin_<plugin>_<server>__<tool>，
//      不是 mcp__<server>__<tool>；
//   2. 只含字母数字与 _ - 空格 , | 的匹配值按**精确字符串**比较，不当正则。
// 任一踩中，闸门看起来装好了但一个工具也拦不住。
//
// 用法：node evals/hook-matcher.test.js   （失败时退出码非 0）

const fs = require('fs');
const path = require('path');

/**
 * 复刻 Claude Code 的 matcher 分派规则（见官方 hooks 文档）：
 *   "*" / "" / 省略                          → 匹配全部
 *   仅含 字母 数字 _ - 空格 , |               → 精确字符串，或精确字符串列表
 *   含其他任意字符                            → 不锚定的 JavaScript 正则
 * 这三条必须一起实现——只用 RegExp 求值会让第二类误判为命中。
 */
function matches(matcher, tool) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_\-, |]+$/.test(matcher)) {
    return matcher.split(/[|,]/).map((s) => s.trim()).filter(Boolean).includes(tool);
  }
  return new RegExp(matcher).test(tool);
}

const hooksPath = path.join(__dirname, '..', 'plugins', 'experience', 'hooks', 'hooks.json');
const matcher = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks.PreToolUse[0].matcher;

const mustHit = [
  'mcp__plugin_experience_mem0__add_memory',
  'mcp__plugin_experience_mem0__update_memory',
  'mcp__plugin_experience_mem0__delete_memory',
  'mcp__plugin_experience_mem0__delete_all_memories',
  'mcp__plugin_experience_mem0__delete_entities',
];

const mustPass = [
  'mcp__plugin_experience_mem0__search_memories',
  'mcp__plugin_experience_mem0__get_memories',
  'mcp__plugin_experience_mem0__get_memory',
  'mcp__plugin_experience_mem0__list_entities',
  'mcp__plugin_experience_mem0__list_events',
  'mcp__plugin_experience_mem0__get_event_status',
  'Edit',
  'Bash',
];

let failures = 0;
const check = (ok, label, name) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}  ${name}`);
};

console.log(`matcher = ${matcher}\n`);

console.log('必须命中（写入与删除）：');
for (const t of mustHit) check(matches(matcher, t), '命中', t);

console.log('\n必须放行（读取类，检索要靠它们）：');
for (const t of mustPass) check(!matches(matcher, t), '放行', t);

// 反向对照：两种"看起来合理"的写法必须一个也匹配不到。
// 它们是本用例存在的理由——若哪天 harness 语义变了、诱饵开始命中，
// 说明分派规则变更，主 matcher 也需重新审视。
console.log('\n反向对照（以下写法必须匹配不到）：');
const decoys = [
  ['mcp__mem0__(add_memory|update_memory|delete).*', '漏掉 plugin_<name>_ 前缀'],
  ['mcp__plugin_experience_mem0', '无正则字符，退化为精确串'],
];
for (const [pat, why] of decoys) {
  check(!matches(pat, 'mcp__plugin_experience_mem0__add_memory'), `不命中（${why}）`, pat);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} 项`}`);
process.exit(failures === 0 ? 0 : 1);
