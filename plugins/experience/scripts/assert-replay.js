#!/usr/bin/env node
'use strict';
//
// assert-replay —— 目标四的执行者。
//
// 一条经验不是事实，它必须携带指向事实的指针。本脚本负责真的去跑那个指针：
//   1. 重跑断言：按 evidence_cmd 实际执行，比对声称的退出码与输出特征
//   2. 符号存在性：经验声称存在的文件与标识符，是否真的在代码库里
//
// 四个消费方：写入自检、注入前校验、库审计、淘汰判定。
//
// 用法：
//   node assert-replay.js <entry.json>      单条
//   node assert-replay.js -                 从 stdin 读 JSON 或 JSONL
//   选项：
//     --cwd <dir>       在哪个仓库里跑与查（默认当前目录）
//     --timeout <ms>    单条命令超时（默认 30000）
//     --allow <a,b,c>   追加允许执行的程序名
//     --quiet           只输出 JSON，不输出人类可读摘要
//
// 退出码：0 = 全部通过；1 = 有条目未通过；2 = 用法或输入错误。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// 命令白名单
//
// 为什么需要：经验条目来自团队共享的云端库，evidence_cmd 是库里的一段文本。
// 直接交给 shell 执行，等于让任何能写入该库的人在每个成员机器上执行命令。
// 红线过滤挡的是数据出去，这里挡的是代码进来，方向相反、同样必要。
//
// 三道防线，缺一不可：
//   1. 拒绝含 shell 元字符的命令——没有串接、重定向、命令替换
//   2. 不经 shell 执行（spawnSync 的 shell: false），元字符即便漏网也不生效
//   3. 程序名必须在白名单内，且内联执行代码的参数一律拒绝
// ---------------------------------------------------------------------------

const DEFAULT_ALLOW = [
  // 只读检视
  'git', 'rg', 'grep', 'ls', 'find', 'wc', 'head', 'tail', 'cat', 'test', 'diff',
  // 常见测试与构建入口——它们跑的是本仓库自己的代码，不引入新的信任边界
  'go', 'npm', 'pnpm', 'yarn', 'make', 'cargo', 'pytest', 'mvn', 'gradle', 'dotnet',
];

// 这些程序能从参数里直接执行任意代码，白名单对它们无意义
const INLINE_CODE_FLAGS = new Set(['-e', '-c', '--eval', '--exec', '-Command']);

const SHELL_METACHARS = /[;&|<>`$(){}\n\r]/;

/** 按空白切分，尊重成对引号；不做任何展开。 */
function tokenize(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new Error('引号不配对');
  if (has) out.push(cur);
  return out;
}

/** @returns {{ok: true, argv: string[]} | {ok: false, reason: string}} */
function vetCommand(cmd, allow) {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    return { ok: false, reason: 'evidence_cmd 为空' };
  }
  const meta = cmd.match(SHELL_METACHARS);
  if (meta) {
    return { ok: false, reason: `含 shell 元字符 ${JSON.stringify(meta[0])}——不允许串接、重定向或命令替换` };
  }
  let argv;
  try {
    argv = tokenize(cmd);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (argv.length === 0) return { ok: false, reason: 'evidence_cmd 为空' };

  const exe = path.basename(argv[0]).replace(/\.(exe|cmd|bat)$/i, '');
  if (!allow.has(exe)) {
    return { ok: false, reason: `程序 ${JSON.stringify(exe)} 不在白名单内（--allow 可追加）` };
  }
  const inline = argv.slice(1).find((a) => INLINE_CODE_FLAGS.has(a));
  if (inline) {
    return { ok: false, reason: `参数 ${JSON.stringify(inline)} 可内联执行任意代码` };
  }
  return { ok: true, argv };
}

// ---------------------------------------------------------------------------
// 检查一：重跑断言
// ---------------------------------------------------------------------------

/**
 * evidence_digest 是「退出码 + 输出摘要」的可判定形式：
 *   { "exit": 0, "contains": ["ok  "], "absent": ["FAIL"] }
 * 三项都可省；全省则只要求命令能跑起来。
 *
 * 不比对完整输出，因为重跑几乎不会逐字节相同（时间戳、路径、耗时）。
 * 比对退出码与特征串既稳定，又能抓住"跑了但抄错"——前身实测过的形态是：
 * 原始输出 11 行就贴在紧邻处，结论里却写了 10。
 */
function checkCommand(entry, opts) {
  const cmd = entry.metadata && entry.metadata.evidence_cmd;
  if (cmd === undefined || cmd === null || cmd === '') {
    return { kind: 'command', status: 'missing', detail: '条目没有 evidence_cmd' };
  }

  const vet = vetCommand(cmd, opts.allow);
  if (!vet.ok) {
    return { kind: 'command', status: 'refused', detail: vet.reason, cmd };
  }

  const [exe, ...args] = vet.argv;
  const r = spawnSync(exe, args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    encoding: 'utf8',
    shell: false,          // 关键：不经 shell
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (r.error) {
    const why = r.error.code === 'ETIMEDOUT' ? `超时（>${opts.timeout}ms）` : r.error.message;
    return { kind: 'command', status: 'fail', detail: `无法执行：${why}`, cmd };
  }

  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const want = (entry.metadata && entry.metadata.evidence_digest) || {};
  const problems = [];

  if (want.exit !== undefined && r.status !== want.exit) {
    problems.push(`退出码 声称 ${want.exit}，实为 ${r.status}`);
  }
  for (const s of toArray(want.contains)) {
    if (!output.includes(s)) problems.push(`输出不含声称的 ${JSON.stringify(s)}`);
  }
  for (const s of toArray(want.absent)) {
    if (output.includes(s)) problems.push(`输出含本应不存在的 ${JSON.stringify(s)}`);
  }

  return problems.length === 0
    ? { kind: 'command', status: 'pass', detail: `退出码 ${r.status}`, cmd }
    : { kind: 'command', status: 'fail', detail: problems.join('；'), cmd };
}

// ---------------------------------------------------------------------------
// 检查二：符号存在性
// ---------------------------------------------------------------------------

/**
 * 覆盖的是"编造一个根本不存在的符号"这个主要形态——腾讯团队的实测案例：
 * 经验称应调用 FastScrollBar.attachToQBListView()，该类根本没有这个方法。
 * 纯文本审核会放行，因为它有场景、有方法名、有操作指引。
 *
 * 本实现是语言无关的存在性检查（标识符是否在仓库中出现过），
 * 不判断归属（方法属于哪个类）。归属需要语言服务，按语言分别接，尚未做。
 * 这个边界必须说明：它能抓"不存在"，抓不住"存在但归属错了"。
 */
function checkSymbols(entry, opts) {
  const md = entry.metadata || {};
  const files = toArray(md.files);
  const symbols = toArray(md.symbols);

  if (files.length === 0 && symbols.length === 0) {
    return { kind: 'symbol', status: 'missing', detail: '条目没有 files 也没有 symbols' };
  }

  const problems = [];

  for (const f of files) {
    if (path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) {
      problems.push(`路径 ${JSON.stringify(f)} 不是仓库相对路径`);
      continue;
    }
    if (!fs.existsSync(path.join(opts.cwd, f))) {
      problems.push(`文件不存在：${f}`);
    }
  }

  for (const sym of symbols) {
    // 取最后一段标识符：FastScrollBar.attachToQBListView -> attachToQBListView
    const ident = String(sym).split(/[.#:]/).filter(Boolean).pop();
    if (!ident || !/^[A-Za-z_$][\w$]*$/.test(ident)) {
      problems.push(`符号 ${JSON.stringify(sym)} 不含可检索的标识符`);
      continue;
    }
    if (!repoHasIdentifier(ident, opts)) {
      problems.push(`符号在仓库中查无踪迹：${sym}`);
    }
  }

  return problems.length === 0
    ? { kind: 'symbol', status: 'pass', detail: `${files.length} 个文件、${symbols.length} 个符号均存在` }
    : { kind: 'symbol', status: 'fail', detail: problems.join('；') };
}

function repoHasIdentifier(ident, opts) {
  for (const [exe, args] of [
    ['rg', ['--fixed-strings', '--word-regexp', '--quiet', '--', ident, '.']],
    ['grep', ['-r', '-F', '-w', '-q', '--', ident, '.']],
  ]) {
    const r = spawnSync(exe, args, {
      cwd: opts.cwd, timeout: opts.timeout, shell: false, windowsHide: true, encoding: 'utf8',
    });
    if (r.error) continue;          // 该工具不可用，换下一个
    return r.status === 0;
  }
  // rg 与 grep 都不可用：不能把"查不到工具"当成"符号不存在"
  throw new Error('rg 与 grep 均不可用，无法做符号存在性检查');
}

// ---------------------------------------------------------------------------

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function verify(entry, opts) {
  const checks = [];
  checks.push(checkCommand(entry, opts));
  try {
    checks.push(checkSymbols(entry, opts));
  } catch (e) {
    checks.push({ kind: 'symbol', status: 'error', detail: e.message });
  }

  // missing 不算失败：不是每条经验都有命令或符号。
  // refused / error 算失败——无法验证与验证不过，对采信者是同一件事。
  const bad = checks.filter((c) => c.status === 'fail' || c.status === 'refused' || c.status === 'error');
  return {
    id: entry.id || (entry.metadata && entry.metadata.id) || null,
    ok: bad.length === 0,
    checks,
  };
}

function parseEntries(text) {
  const t = text.trim();
  if (t === '') return [];
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : [v];
  } catch (_) {
    // JSONL
    return t.split('\n').filter((l) => l.trim()).map((l, i) => {
      try { return JSON.parse(l); } catch (e) { throw new Error(`第 ${i + 1} 行不是合法 JSON：${e.message}`); }
    });
  }
}

function main(argv) {
  const opts = {
    cwd: process.cwd(),
    timeout: 30000,
    allow: new Set(DEFAULT_ALLOW),
    quiet: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--allow') String(argv[++i]).split(',').forEach((s) => s.trim() && opts.allow.add(s.trim()));
    else if (a === '--quiet') opts.quiet = true;
    else rest.push(a);
  }
  if (rest.length !== 1) {
    process.stderr.write('用法：node assert-replay.js <entry.json|-> [--cwd dir] [--timeout ms] [--allow a,b] [--quiet]\n');
    return 2;
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
    process.stderr.write('--timeout 必须是正数（毫秒）\n');
    return 2;
  }

  let text;
  try {
    text = rest[0] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[0], 'utf8');
  } catch (e) {
    process.stderr.write(`读取输入失败：${e.message}\n`);
    return 2;
  }

  let entries;
  try {
    entries = parseEntries(text);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  const results = entries.map((e) => verify(e, opts));
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');

  if (!opts.quiet) {
    for (const r of results) {
      const head = `${r.ok ? 'PASS' : 'FAIL'}  ${r.id || '(无 id)'}`;
      process.stderr.write(`${head}\n`);
      for (const c of r.checks) {
        process.stderr.write(`    ${c.status.padEnd(8)} ${c.kind.padEnd(8)} ${c.detail}\n`);
      }
    }
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { tokenize, vetCommand, checkCommand, checkSymbols, verify, parseEntries, DEFAULT_ALLOW };
