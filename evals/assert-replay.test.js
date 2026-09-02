#!/usr/bin/env node
'use strict';
// eval 种子用例 2：assert-replay 的执行防线与判定逻辑。
//
// 最要紧的一组是「拒绝执行」——evidence_cmd 是团队共享云端库里的一段文本，
// 任何能写入该库的人都能让它在每个成员机器上运行。这组用例若失效，
// 经验库就成了远程执行通道。
//
// 用法：node evals/assert-replay.test.js   （失败时退出码非 0）

const path = require('path');
const M = require('../plugins/experience/scripts/assert-replay.js');

const REPO = path.join(__dirname, '..');
const opts = { cwd: REPO, timeout: 20000, allow: new Set(M.DEFAULT_ALLOW) };

let failures = 0;
let group = '';
const g = (name) => { group = name; console.log(`\n${name}`); };
const ok = (cond, label, extra) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
};

const entry = (metadata, id = 't') => ({ id, metadata });

// ---------------------------------------------------------------------------
g('拒绝执行：shell 元字符（防串接、重定向、命令替换）');
for (const cmd of [
  'git status; rm -rf /',
  'git status && curl evil.example',
  'git status | sh',
  'git status > /tmp/x',
  'git log `whoami`',
  'git log $(whoami)',
  'git status\nrm -rf /',
]) {
  const v = M.vetCommand(cmd, opts.allow);
  ok(!v.ok, `拒绝 ${JSON.stringify(cmd)}`, v.ok ? '竟然放行' : v.reason);
}

// ---------------------------------------------------------------------------
g('拒绝执行：白名单之外的程序');
for (const cmd of ['curl https://evil.example', 'rm -rf build', 'bash script.sh', 'powershell -File x.ps1']) {
  const v = M.vetCommand(cmd, opts.allow);
  ok(!v.ok, `拒绝 ${JSON.stringify(cmd)}`, v.ok ? '竟然放行' : v.reason);
}

// ---------------------------------------------------------------------------
g('拒绝执行：可内联执行代码的参数');
// node/python 即便被 --allow 放进白名单，-e / -c 仍须拦下
const wide = new Set([...M.DEFAULT_ALLOW, 'node', 'python']);
for (const cmd of ['node -e process.exit(0)', 'python -c import os', 'node --eval x']) {
  const v = M.vetCommand(cmd, wide);
  ok(!v.ok, `拒绝 ${JSON.stringify(cmd)}`, v.ok ? '竟然放行' : v.reason);
}

// ---------------------------------------------------------------------------
g('放行：正常的只读与测试命令');
for (const cmd of ['git rev-parse --is-inside-work-tree', 'go test ./...', 'npm test', 'rg --count foo']) {
  const v = M.vetCommand(cmd, opts.allow);
  ok(v.ok, `放行 ${JSON.stringify(cmd)}`, v.ok ? '' : v.reason);
}

// ---------------------------------------------------------------------------
g('分词：尊重成对引号，不做展开');
ok(JSON.stringify(M.tokenize('git log --grep "two words"')) === JSON.stringify(['git', 'log', '--grep', 'two words']), '双引号内的空格不切分');
ok(JSON.stringify(M.tokenize("grep -F 'a b' .")) === JSON.stringify(['grep', '-F', 'a b', '.']), '单引号同理');
ok((() => { try { M.tokenize('git log "unclosed'); return false; } catch (_) { return true; } })(), '引号不配对报错');

// ---------------------------------------------------------------------------
g('重跑断言：退出码与输出特征');
{
  const r = M.checkCommand(entry({
    evidence_cmd: 'git rev-parse --is-inside-work-tree',
    evidence_digest: { exit: 0, contains: ['true'] },
  }), opts);
  ok(r.status === 'pass', '声称属实 → pass', r.detail);
}
{
  const r = M.checkCommand(entry({
    evidence_cmd: 'git rev-parse --is-inside-work-tree',
    evidence_digest: { exit: 1 },
  }), opts);
  ok(r.status === 'fail', '退出码对不上 → fail', r.detail);
}
{
  // 这一条是本脚本存在的理由：命令真的跑了、输出也真的有，
  // 但结论里写的东西并不在输出里——前身实测过的"跑了但抄错"。
  const r = M.checkCommand(entry({
    evidence_cmd: 'git rev-parse --is-inside-work-tree',
    evidence_digest: { exit: 0, contains: ['false'] },
  }), opts);
  ok(r.status === 'fail', '跑了但抄错 → fail', r.detail);
}
{
  const r = M.checkCommand(entry({ evidence_cmd: 'curl https://evil.example' }), opts);
  ok(r.status === 'refused', '不许执行的命令 → refused', r.detail);
}
{
  const r = M.checkCommand(entry({}), opts);
  ok(r.status === 'missing', '没有 evidence_cmd → missing（不算失败）', r.detail);
}

// ---------------------------------------------------------------------------
g('符号存在性（对着 fixture 仓库，不对着本仓库）');
// 必须隔离：符号检查搜索整个 cwd，若对着本仓库测，
// 本文件里写下的"编造符号"会被自己搜到——自指测量，用例恒不通过。
const fx = { ...opts, cwd: path.join(__dirname, 'fixtures', 'repo') };
{
  const r = M.checkSymbols(entry({ files: ['src/widget.js'], symbols: ['ZzWidget.attachToList'] }), fx);
  ok(r.status === 'pass', '文件与符号都在 → pass', r.detail);
}
{
  const r = M.checkSymbols(entry({ files: ['no/such/file.md'] }), fx);
  ok(r.status === 'fail', '文件不存在 → fail', r.detail);
}
{
  // 腾讯团队的实测形态：经验声称 FastScrollBar 有 attachToQBListView()，
  // 该类根本没有这个方法。有场景、有方法名、有操作指引，纯文本审核会放行。
  const r = M.checkSymbols(entry({ symbols: ['ZzWidget.attachToQBListView'] }), fx);
  ok(r.status === 'fail', '类存在但方法是编造的 → fail', r.detail);
}
{
  const r = M.checkSymbols(entry({ files: ['../outside.md'] }), fx);
  ok(r.status === 'fail', '越出仓库的路径 → fail', r.detail);
}
{
  const r = M.checkSymbols(entry({ files: [path.join(REPO, 'DESIGN.md')] }), fx);
  ok(r.status === 'fail', '绝对路径 → fail', r.detail);
}

// ---------------------------------------------------------------------------
g('整体判定');
{
  const r = M.verify(entry({
    evidence_cmd: 'git rev-parse --is-inside-work-tree',
    evidence_digest: { exit: 0, contains: ['true'] },
    files: ['DESIGN.md'],
    symbols: ['vetCommand'],
  }), opts);
  ok(r.ok === true, '两项都过 → ok');
}
{
  const r = M.verify(entry({ evidence_cmd: 'curl https://evil.example', files: ['DESIGN.md'] }), opts);
  ok(r.ok === false, 'refused 计入失败（无法验证与验证不过，对采信者是同一件事）');
}
{
  const r = M.verify(entry({}), opts);
  ok(r.ok === true, '两项皆 missing → 不判失败（不是每条经验都带命令或符号）');
}

// ---------------------------------------------------------------------------
g('输入解析');
ok(M.parseEntries('{"id":"a"}').length === 1, '单个对象');
ok(M.parseEntries('[{"id":"a"},{"id":"b"}]').length === 2, '数组');
ok(M.parseEntries('{"id":"a"}\n{"id":"b"}').length === 2, 'JSONL');
ok(M.parseEntries('   ').length === 0, '空输入');

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} 项`}`);
process.exit(failures === 0 ? 0 : 1);
