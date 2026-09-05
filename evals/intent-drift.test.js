#!/usr/bin/env node
'use strict';
// eval 种子用例 8：目标一在提交那一刻的执行者。
//
// 目标一是「进入 spec 前确立意图，spec 下所做的所有变更都不能偏离 spec 的
// 意图」。它此前**一个执行者都没有**——四条目标里最空的一条。
//
// 2026-09-04 用户裁定：**判定偏离时提醒，不拦截**。因此这条 hook 解决的是
// "忘了对照"，不是"不许偏离"。守三件事：
//   1. 只在提交时说话，别的 Bash 一概不吭声
//   2. **不假装查过没查的东西**——「明确不做的」里没有可机械比对的条目时，
//      必须说"比对不了"，不能说"均未触及"
//   3. **永远不挡住提交**：不输出任何 permissionDecision，退出码恒为 0
//
// 用法：node evals/intent-drift.test.js   （失败时退出码非 0）

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const D = require('../plugins/experience/hooks/intent-drift.js');

const REPO = path.join(__dirname, '..');
const HOOK = path.join(REPO, 'plugins', 'experience', 'hooks', 'intent-drift.js');
const HOOKS_JSON = path.join(REPO, 'plugins', 'experience', 'hooks', 'hooks.json');

let failures = 0;
const g = (name) => console.log(`\n${name}`);
const ok = (cond, label, extra) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
};
const commit = (cwd, cmd = 'git commit -m x') => D.build({ tool_input: { command: cmd }, cwd });

// ---------------------------------------------------------------------------
g('只在提交时说话');
{
  const cwd = REPO;
  for (const c of ['git status', 'git add -A', 'ls', 'npm test', 'git log --oneline',
    'git commitment-scheme']) {
    ok(commit(cwd, c) === null, `不触发：${c}`);
  }
  for (const c of ['git commit -m x', 'git commit', 'git -c user.name=a commit -m y',
    'git add -A && git commit -m z', 'git --no-pager commit --amend',
    'git -C /tmp/repo commit -m q']) {
    ok(commit(cwd, c) !== null, `触发：${c}`);
  }
  // 首版用正则 `git\s+(-[^\s]+\s+)*commit`，只认单 token 选项，于是
  // `git -c user.name=a commit` 漏判——**漏判是静默的**，那次提交不会有
  // 任何提醒，谁也不会发现。改成分词后两个方向都测。
  ok(D.isCommit('git -c a=b -c c=d commit'), '多个带值全局选项仍认得出');
  ok(!D.isCommit('git commitment-scheme'), '`commitment-scheme` 不是提交');
  ok(!D.isCommit('echo "git commit" > note.txt'), '只是提到 commit 的字符串不算');
  ok(!D.isCommit(''), '空命令不算');
}

// ---------------------------------------------------------------------------
g('小节解析：只收真正的列表项');
{
  // **这一条是先抓到的缺陷**：首版把小节的引导句也当成了条目，于是
  // 「怎样算偏离」的第 1 问变成"按下面四问检查："——一句答不了的话。
  // 人看到第一问就答不上，会学会跳过整段，整条提醒因此作废。
  const body = '按下面四问检查，任何一问答不上就是偏离：\n\n1. **甲？** 说明\n2. 乙？\n\n结尾一句话。';
  const b = D.bullets(body);
  ok(b.length === 2, '引导句与结尾句都不算条目', `实得 ${b.length}：${b.join(' | ')}`);
  ok(b[0] === '甲？ 说明' && b[1] === '乙？', '条目内容正确、去掉了序号与加粗', b.join(' | '));
  ok(D.bullets('') .length === 0 && D.bullets(null).length === 0, '空节返回空数组，不崩');
  ok(D.bullets('- 甲\n---\n- 乙').length === 2, '分隔线不算条目');
}
{
  const text = '# 意图\n\n## 四、明确不做的\n\n- 不引入 `lodash`\n\n## 五、怎样算偏离\n\n1. 甲？\n';
  ok(D.bullets(D.sectionBody(text, D.SECTION_NOT_DOING)).length === 1, '带中文序号的标题认得出');
  ok(D.bullets(D.sectionBody(text, D.SECTION_HOW_DRIFT)).length === 1, '小节到下一个标题为止');
  ok(D.sectionBody(text, /^#{1,3}\s*不存在的一节\s*$/m) === null, '没有的小节返回 null（与"空节"区分）');
}

// ---------------------------------------------------------------------------
g('机械比对：只认反引号，且宁可少点名');
{
  const items = ['不引入 `lodash`', '不新建 `docs/architecture/` 目录', '不做过度设计', '别碰 `x`'];
  const terms = D.mechanicalTerms(items);
  ok(terms.length === 2, '只有反引号里的、且长度 ≥3 的才算', terms.map((t) => t.term).join(', '));
  ok(terms.some((t) => t.term === 'lodash') && terms.some((t) => t.term === 'docs/architecture/'),
    '取到的是 lodash 与 docs/architecture/');
  ok(!terms.some((t) => t.term === 'x'),
    '`x` 太短被丢弃——它会命中一切，一条误报会让人下次忽略整段提醒');

  const hits = D.collisions(terms, ['src/a.js', 'docs/architecture/modules.md']);
  ok(hits.length === 1 && /docs\/architecture\//.test(hits[0]), '碰到即点名，并说出碰到的是哪个文件', hits[0]);
  ok(D.collisions(terms, ['src/a.js']).length === 0, '没碰到就不点名');
}

// ---------------------------------------------------------------------------
g('★ 不假装查过没查的东西');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-intent-'));
  const write = (s) => fs.writeFileSync(path.join(tmp, 'Intent.md'), s);
  try {
    // 情形一：有「明确不做的」但一个反引号都没有 → 比对不了，必须说出来。
    // 说成"均未触及"就是**把没验证的说成验证过**，正是本项目要防的。
    write('# 意图\n\n## 四、明确不做的\n\n- 不做过度设计\n- 不为完整而产出工件\n\n## 五、怎样算偏离\n\n1. 甲？\n');
    const a = commit(tmp);
    ok(/没有可机械比对的条目/.test(a), '无可比对条目时如实说"比对不了"', (a || '').split('\n')[1]);
    ok(!/均未触及/.test(a), '**不得**说成"均未触及"');

    // 情形二：有可比对条目、且确实没碰到 → 才可以说"均未触及"
    write('# 意图\n\n## 四、明确不做的\n\n- 不引入 `zz-forbidden-pkg`\n\n## 五、怎样算偏离\n\n1. 甲？\n');
    const b = commit(tmp);
    ok(/均未触及/.test(b), '有可比对条目且未碰到时才说"均未触及"', (b || '').split('\n')[1]);

    // 情形三：缺「怎样算偏离」→ 说锚判不出东西，而不是沉默
    write('# 意图\n\n## 四、明确不做的\n\n- 不引入 `zz-x`\n');
    ok(/没有「怎样算偏离」一节/.test(commit(tmp)), '缺判据小节时点出来');

    // 情形四：没有锚 → 说一次
    fs.unlinkSync(path.join(tmp, 'Intent.md'));
    ok(/没有找到 Intent\.md/.test(commit(tmp)), '没有锚时说明白，并指向 intent-lock');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
g('对着本仓库真实的 Intent.md 跑一遍');
{
  const msg = commit(REPO);
  ok(typeof msg === 'string' && msg.length > 0, '产出提醒');
  ok(/提醒，不阻断/.test(msg), '措辞上明确它不阻断');
  ok(/逐问回答/.test(msg), '把「怎样算偏离」那几问摆了出来');
  ok(!/按下面四问检查/.test(msg), '引导句没有混进判据里（首版的缺陷）');
}

// ---------------------------------------------------------------------------
g('★ 永远不挡住提交');
const run = (stdin) => {
  const r = spawnSync(process.execPath, [HOOK], { cwd: REPO, encoding: 'utf8', input: stdin, timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* 下面断言 */ }
  return { code: r.status, json, out: r.stdout };
};
{
  for (const bad of ['not json', '', 'null', '[]', '{"tool_input":null}',
    JSON.stringify({ tool_input: { command: 'git commit -m x' }, cwd: '/zz/no/such/dir' })]) {
    const r = run(bad);
    ok(r.code === 0 && r.json !== null, `畸形/异常输入仍规矩退出：${JSON.stringify(bad).slice(0, 40)}`, `code=${r.code}`);
    ok(r.json && r.json.hookSpecificOutput === undefined && r.json.permissionDecision === undefined,
      '不输出任何权限决定——这是提醒，不是拦截');
  }
  const good = run(JSON.stringify({ tool_input: { command: 'git commit -m x' }, cwd: REPO }));
  ok(good.code === 0, '正常路径退出码 0');
  ok(good.json && typeof good.json.systemMessage === 'string',
    '用 systemMessage 输出（通用字段；additionalContext 在 PreToolUse 之外多处不支持）');
}

// ---------------------------------------------------------------------------
g('hooks.json 接线');
{
  const pre = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks.PreToolUse;
  const entry = pre.find((e) => JSON.stringify(e).includes('intent-drift'));
  ok(!!entry, 'PreToolUse 里有 intent-drift 这一条');
  if (entry) {
    ok(entry.matcher === 'Bash', "matcher 是 'Bash'", JSON.stringify(entry.matcher));
    ok(entry.hooks[0].if === 'Bash(git commit *)',
      "靠 if 精确到参数——否则每条 Bash 都要起一个进程", JSON.stringify(entry.hooks[0].if));
    ok(!/exit\s+\d/.test(entry.hooks[0].command), '不得有 `|| exit N`——提交不能被它挡住');
  }
  // deny 那条必须还在，且没被这次改动挤掉。
  ok(pre.some((e) => /mcp__plugin_experience_mem0__/.test(e.matcher || '')),
    '原有的 mem0 deny 闸门仍在 PreToolUse 里');
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} 项`}`);
process.exitCode = failures === 0 ? 0 : 1;
