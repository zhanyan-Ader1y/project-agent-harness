#!/usr/bin/env node
'use strict';
// eval 种子用例 4：UserPromptSubmit 上的经验检索与注入。
//
// 这条 hook 是"下一次相关提问时它自动回到上下文里"那半句的执行者，而它
// 挂在**每一轮用户提示**上。三件事最要紧：
//
//   1. **只放行判定过且通过的条目**——verified:false 是"没验过"，在注入
//      路径上必须和"验证不过"一样处置。放行它，"注入前机器验过"就是空话。
//   2. **双上限真的截断**——条数与 token 任一超出即停，否则库一长就把
//      每轮上下文吃掉，那正是前身 571 行常驻控制面换了个来源。
//   3. **失败注入空，不挡用户提问**——但配置错误必须看得见，每个会话提示
//      一次：一次都不提示就是静默失效，每轮都提示是噪音。
//
// 网络那一段没有用例（本机没有可用的 key），验证手段是 selfcheck --mem0。
//
// 用法：node evals/recall.test.js   （失败时退出码非 0）

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const R = require('../plugins/experience/hooks/recall.js');

const REPO = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'repo');
const HOOK = path.join(REPO, 'plugins', 'experience', 'hooks', 'recall.js');
const HOOKS_JSON = path.join(REPO, 'plugins', 'experience', 'hooks', 'hooks.json');

let failures = 0;
const g = (name) => console.log(`\n${name}`);
const ok = (cond, label, extra) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
};

// ---------------------------------------------------------------------------
g('响应字段名未经实测：认得出就用，认不出就跳过，不猜');
for (const k of ['memory', 'text', 'content', 'information']) {
  ok(R.sentenceOf({ [k]: '一句经验' }) === '一句经验', `认得 ${k}`);
}
ok(R.sentenceOf({ body: 'x' }) === null, '认不出的形状 → null，这一条整个跳过');
ok(R.sentenceOf({ memory: '   ' }) === null, '空白不算内容');

// ---------------------------------------------------------------------------
g('双上限：条数与 token 任一超出即截断');
const e = (info, md = {}) => ({ information: info, metadata: md });
{
  const many = Array.from({ length: R.MAX_ENTRIES + 3 }, (_, i) => e(`第 ${i} 条经验`));
  const text = R.render(many);
  const lines = text.split('\n').filter((l) => l.startsWith('- '));
  ok(lines.length === R.MAX_ENTRIES, `条数上限 ${R.MAX_ENTRIES} 生效`, `实得 ${lines.length}`);
  ok(text.startsWith(R.PREAMBLE), '注入内容带使用约束——经验是参考，冲突时以代码为准');
}
{
  // token 上限必须能在条数上限之前先咬住。用一条超长的经验来证明。
  const huge = e('很'.repeat(R.MAX_TOKENS + 50));
  ok(R.render([huge]) === null, 'token 上限先咬住时一条都不注入，而不是硬塞进去');
  ok(R.render([e('短的'), huge]).split('\n').length === 2, '前面装得下的照常注入，超出的那条截断');
}
ok(R.render([]) === null, '没有可注入的条目 → null，不发空壳');
ok(R.estimateTokens('中文四个字') === 5 && R.estimateTokens('abcd') === 1,
  'token 估算：CJK 按字计，其余按 4 字符计（估算，不是实测；估高只是少注入一条）');

// ---------------------------------------------------------------------------
g('注入前校验：只放行判定过且通过的');
{
  const real = e('ZzWidget 必须走 attachToList', { repo: 'project-agent-harness', symbols: ['ZzWidget'] });
  const fake = e('应当调用 ZzFabricatedQq', { repo: 'project-agent-harness', symbols: ['ZzFabricatedQq'] });
  // 既没有 symbols 也没有 files —— assert-replay 判"什么都没判定过"，
  // verified:false。放行它，"注入前机器验过它声称的符号真的存在"就是空话。
  const bare = e('一句谁也验不了的话', { repo: 'project-agent-harness' });
  const v = R.verified([real, fake, bare], FIXTURE);
  ok(!v.error, '校验跑起来了', v.error);
  if (!v.error) {
    ok(v.keep.length === 1 && v.keep[0] === real, '只留下真的验过且通过的那一条', `留下 ${v.keep.length} 条`);
    ok(v.dropped === 2, '断言为假的与没验过的都被拦下', `拦下 ${v.dropped} 条`);
  }
}

// ---------------------------------------------------------------------------
g('注入路径永不执行命令——这条守的是 --mode symbols');
{
  // **这一组是 2026-09-04 一次真实回归的产物。** recall.js 里的 --mode 被从
  // symbols 改成 full 并推上了远端，而当时**没有任何用例守着它**：上面那组
  // 「只放行判定过且通过的」用的条目不带 evidence_cmd，两种 mode 结果一样，
  // 全绿。
  //
  // 后果不是少测一条：注入路径挂在每一轮用户提示上，evidence_cmd 是共享云库
  // 里的一段文本。改成 full，等于让任何能写入该库的人在每个成员的每一轮提示
  // 里执行命令——assert-replay 那五道执行边界存在的全部理由就是防这个。
  const src = fs.readFileSync(HOOK, 'utf8');
  const call = (src.match(/'--mode',\s*'(\w+)'/) || [])[1];
  ok(call === 'symbols', "recall.js 传给 assert-replay 的是 --mode symbols", `实得 '${call}'`);
  ok(!/'--mode',\s*'full'/.test(src), 'recall.js 里不得出现 --mode full', '注入路径不执行任何命令');

  // 静态检查能被绕过（换成变量、拼字符串），所以再从**行为**上验一次。
  //
  // 第一版这条写的是"喂一条会留下痕迹的命令，跑完痕迹必须不存在"——
  // 而它在 --mode full 下**照样通过**：那条命令根本不在允许列表里，
  // 被执行边界拒了，不是被 mode 拦的。**判据证明不了它声称在证明的事。**
  //
  // 换成一个真能区分两种 mode 的观测点：带一条**不被允许**的 evidence_cmd。
  //   symbols：命令检查 not-run，符号检查 pass  → verdict pass → 留下
  //   full   ：命令检查 refused                 → verdict fail → 丢弃
  // 这个差别只取决于 mode，与允许列表里有什么无关。
  const withCmd = e('带一条不被允许的命令', {
    repo: 'project-agent-harness',
    symbols: ['ZzWidget'],
    evidence_cmd: 'curl https://example.invalid',
  });
  const v = R.verified([withCmd], FIXTURE);
  ok(!v.error, '校验跑起来了', v.error);
  ok(v.keep && v.keep.length === 1,
    '带不被允许的命令时仍被留下——证明这条路没去执行它（full 下会判 refused 而丢弃）',
    `留下 ${v.keep ? v.keep.length : 0} 条`);
}

// ---------------------------------------------------------------------------
g('配置错误：每个会话提示一次');
{
  const sid = `zztest-${Date.now()}`;
  ok(R.warnOnce(sid, 'msg') === 'msg', '第一次返回提示');
  ok(R.warnOnce(sid, 'msg') === null, '第二次不再提示——每轮都提示会变成噪音');
  try { fs.unlinkSync(path.join(os.tmpdir(), `experience-recall-${sid}.warned`)); } catch (_) { /* 清理失败无所谓 */ }
}

// ---------------------------------------------------------------------------
g('端到端：任何情况都要输出可解析的 JSON，且不挡住提问');
const run = (input, env) => {
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: REPO, encoding: 'utf8', input: JSON.stringify(input), timeout: 30000,
    env: { ...process.env, MEM0_USER_ID: '', MEM0_API_KEY: '', ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* 下面断言 */ }
  return { code: r.status, json, out: r.stdout, err: r.stderr };
};
{
  const sid = `zze2e-${Date.now()}`;
  const a = run({ prompt: '怎么改这个组件', session_id: sid, cwd: FIXTURE });
  ok(a.json !== null, '输出可解析', a.out.slice(0, 80));
  ok(a.code === 0, '退出码 0——非 0 会挡住用户这一轮提问', `code=${a.code}`);
  ok(/MEM0_USER_ID/.test(a.json.systemMessage || ''), '缺配置时说出来，而不是静默返回空', JSON.stringify(a.json));
  const b = run({ prompt: '再问一句', session_id: sid, cwd: FIXTURE });
  ok(!b.json.systemMessage, '同一会话内不再重复提示');
  try { fs.unlinkSync(path.join(os.tmpdir(), `experience-recall-${sid.replace(/[^A-Za-z0-9_-]/g, '')}.warned`)); } catch (_) { /* 忽略 */ }
}
{
  const r = run({ prompt: '', session_id: 'zzempty', cwd: FIXTURE });
  ok(r.code === 0 && JSON.stringify(r.json) === '{}', '空提示 → 不检索、不注入');
}
{
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: REPO, encoding: 'utf8', input: 'not json', timeout: 30000,
    env: { ...process.env, MEM0_USER_ID: '', MEM0_API_KEY: '' },
  });
  ok(r.status === 0 && r.stdout.trim() === '{}', '输入不是 JSON 也不崩、不挡提问', r.stdout.slice(0, 60));
}

// ---------------------------------------------------------------------------
g('两条 hook 的失败方向必须相反，这是有意的');
{
  // deny 挂 PreToolUse：解释器缺失时若放行，写入就绕过了脚本的全部把关，
  // 所以必须 `|| exit 2`（PreToolUse 只有 exit 2 才阻断）。
  // recall 挂 UserPromptSubmit：那里非 0 退出码会挡住用户这一轮提问，
  // 取不到经验绝不能是"不许提问"。**照抄 deny 的写法就是把它改坏。**
  const h = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks;
  const deny = h.PreToolUse.find((e) => /mcp__plugin_experience_mem0__/.test(e.matcher || '')).hooks[0].command;
  const recall = h.UserPromptSubmit[0].hooks[0].command;
  ok(/exit 2/.test(deny), 'deny 保留 `|| exit 2`——闸门必须失败关闭', deny);
  ok(!/exit\s+\d/.test(recall), 'recall 不得有 `|| exit N`——检索必须失败开放', recall);
  ok(/recall\.js/.test(recall) && !h.UserPromptSubmit[0].matcher,
    'UserPromptSubmit 无 matcher（它不是工具事件），每轮都触发');
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} 项`}`);
process.exitCode = failures === 0 ? 0 : 1;
