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

// 工具名已于 2026-09-03 对活端点确认：`https://mcp.mem0.ai/mcp`（server
// 版本 1.29.1）的 tools/list 实得 11 个工具，写入与删除类正是下面这五个。
//
// **但本用例仍守不住"工具名变了"这一类偏差**——它把名字抄在这里，与
// hooks.json 引用同一个前提。真正的守法是把 tools/list 的结果落成 fixture
// 再对着 fixture 断言；那件事**还没做**。
// 在此之前，`plugins/experience/scripts/selfcheck.js --mem0` 是唯一会
// 对活端点核对工具名的东西，而它由人手动跑。
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
//
// 能力边界，说清楚：上面的 matches() 是对 harness 分派规则的**复刻**，
// 规则本身就写在这个文件里。因此本用例守得住"matcher 字符串被改坏"，
// **守不住 harness 分派语义发生变化**——真变了，这里的复刻也不会动。
console.log('\n反向对照（以下写法必须匹配不到）：');
const decoys = [
  ['mcp__mem0__(add_memory|update_memory|delete).*', '漏掉 plugin_<name>_ 前缀'],
  ['mcp__plugin_experience_mem0', '无正则字符，退化为精确串'],
];
for (const [pat, why] of decoys) {
  check(!matches(pat, 'mcp__plugin_experience_mem0__add_memory'), `不命中（${why}）`, pat);
}

// ---------------------------------------------------------------------------
// 闸门的另一半：命令真的跑起来、输出真的是一份 deny 决策。
// 上一版只读 .matcher，从头到尾没碰过 .hooks[0].command——于是
// "单引号只有 POSIX shell 认"这个静默失效点没有任何用例守着。
// ---------------------------------------------------------------------------
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..', 'plugins', 'experience');
const rawCommand = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
const command = rawCommand.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN_ROOT);

console.log(`\ncommand = ${rawCommand}`);
console.log('\n实跑该命令，输出必须是一份可解析的 deny 决策：');

// harness 用哪个 shell 不由我们决定，而失效时不会报错，所以两个都测。
// cmd 必须用 windowsVerbatimArguments——否则 node 会给参数二次加引号，
// 测出来的是 spawn 的引号规则，不是命令本身。
function runIn(shell, cmdline) {
  const opt = { encoding: 'utf8', timeout: 20000, windowsHide: true };
  return shell === 'cmd'
    ? spawnSync('cmd', ['/c', cmdline], { ...opt, windowsVerbatimArguments: true })
    : spawnSync('sh', ['-c', cmdline], opt);
}

function decisionOf(r) {
  try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch (_) { return null; }
}

const shells = process.platform === 'win32' ? ['sh', 'cmd'] : ['sh'];

for (const shell of shells) {
  const r = runIn(shell, command);
  if (r.error && r.error.code === 'ENOENT') { console.log(`  skip  ${shell} 不可用`); continue; }
  const d = decisionOf(r);
  check(d === 'deny', `${shell}：输出为 permissionDecision=deny`,
    d ? '' : `stdout=${JSON.stringify(String(r.stdout).slice(0, 60))} stderr=${String(r.stderr).trim().slice(0, 60)}`);
  check(r.status === 0, `${shell}：退出码 0`, `code=${r.status}`);
}

// fail-open：解释器缺失时命令必须仍以 exit 2 结束。
// PreToolUse 只有 exit 2 才阻断——其余非零算非阻断错误、工具照常执行；
// 实测 cmd.exe 下解释器缺失是 exit 0，连"出过错"都不留痕。
// 这是全项目唯一已落地的强制点，而使用者的环境比开发机异质得多。
{
  const broken = command.replace(/^node\b/, 'zz-no-such-interpreter-qq');
  for (const shell of shells) {
    const r = runIn(shell, broken);
    check(r.status === 2, `${shell}：解释器缺失时仍以 exit 2 阻断`, `实得退出码 ${r.status}`);
  }
}

// 反向对照：证明这组用例真的抓得住那个失效模式。
// 上一版把 JSON 直接嵌在 `echo '…'` 里，单引号只有 POSIX shell 认；
// 在 cmd 下输出会带着引号、JSON 解析失败 → PreToolUse 拿不到决策 →
// **工具照常执行，且不报错**。若下面这条"通过"了，说明本用例已失去意义。
if (process.platform === 'win32') {
  const legacy = `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}'`;
  check(decisionOf(runIn('sh', legacy)) === 'deny', 'sh：旧写法（echo 单引号）本来是能用的');
  check(decisionOf(runIn('cmd', legacy)) !== 'deny', 'cmd：旧写法必须解析失败——这正是它被换掉的原因');
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} 项`}`);
process.exitCode = failures === 0 ? 0 : 1;
