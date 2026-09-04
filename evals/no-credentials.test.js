#!/usr/bin/env node
'use strict';
// eval 种子用例 5：仓库里不得出现凭据。
//
// **这条用例的由来值得写下来。** `DESIGN.md` 里早就有一句「**不得使用静态
// `headers` 字段**——那等于把 key 提交进版本库」，但它只是一句话，**没有
// 执行者**。2026-09-04，本仓库刚配好公开远端的当天，`.mcp.json` 里就被写进
// 了一个真实的 `Authorization: Bearer m0-…` 和一对 oauth 凭据。
//
// 没提交，是因为有人在提交前看了一眼——而本项目的提交流程用的是
// `git add -A`。**换句话说，拦住它的不是任何机制。**
//
// 这正是本项目的中心论点在自己身上应验：**写成条款而执行者不在那一层的
// 规则，会被一致地、有记录地绕过。** 现在它有执行者了。
//
// 用法：node evals/no-credentials.test.js   （失败时退出码非 0）

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');

let failures = 0;
const g = (name) => console.log(`\n${name}`);
const ok = (cond, label, extra) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
};

// ---------------------------------------------------------------------------
g('.mcp.json 不得携带任何静态凭据');
{
  const p = path.join(REPO, 'plugins', 'experience', '.mcp.json');
  const raw = fs.readFileSync(p, 'utf8');
  const cfg = JSON.parse(raw);
  const server = (cfg.mcpServers && cfg.mcpServers.mem0) || {};

  // `headers` 是官方支持的静态字段，写上去就等于把 key 提交进版本库。
  // 需要用 key 的场景（CI、无浏览器）走 headersHelper——它指向一个脚本，
  // 由脚本从环境变量或密钥库吐出 header，凭据本身不进文件。
  ok(server.headers === undefined,
    '没有静态 headers 字段（要用 key 走 headersHelper）', JSON.stringify(server.headers));
  ok(server.oauth === undefined,
    '没有内联 oauth clientSecret', JSON.stringify(server.oauth));

  // 兜底：无论换成哪个字段名，凭据形态的字符串一律不许出现。
  const shapes = [
    [/m0-[A-Za-z0-9]{16,}/, 'mem0 key 形态（m0-…）'],
    [/\b(Bearer|Token)\s+[A-Za-z0-9_\-]{20,}/, '内联的 Authorization 值'],
    [/"(clientSecret|client_secret|api_?key|apiKey|password|secret)"\s*:\s*"[^"]{8,}"/i, '凭据形态的键值对'],
  ];
  for (const [re, what] of shapes) {
    ok(!re.test(raw), `不含${what}`, (raw.match(re) || [''])[0].slice(0, 12) + '…');
  }
}

// ---------------------------------------------------------------------------
g('整个已跟踪的仓库都不得出现凭据');
{
  // 只扫 git 已跟踪的文件——未跟踪的本地文件（.env、settings.local.json）
  // 本来就是凭据该待的地方，扫它们只会制造噪音。
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', timeout: 30000 });
  if (ls.error || ls.status !== 0) {
    ok(false, 'git ls-files 可用', ls.error ? ls.error.message : `退出码 ${ls.status}`);
  } else {
    const files = ls.stdout.split('\0').filter(Boolean);
    ok(files.length > 0, `扫描已跟踪文件`, `${files.length} 个`);

    // 本文件自己在讲这些形态，必须排除，否则是自指测量——
    // 与 evals/fixtures/repo 隔离出来防自指是同一个道理。
    const SELF = 'evals/no-credentials.test.js';
    const hits = [];
    for (const f of files) {
      if (f === SELF) continue;
      let text;
      try { text = fs.readFileSync(path.join(REPO, f), 'utf8'); } catch (_) { continue; }
      const m = text.match(/m0-[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      if (m) hits.push(`${f}：${m[0].slice(0, 12)}…`);
    }
    ok(hits.length === 0, '没有真实凭据被跟踪', hits.join('；'));
  }
}

// ---------------------------------------------------------------------------
g('规矩本身还在文档里——删掉它，这组用例就成了没人知道为什么的检查');
{
  const design = fs.readFileSync(path.join(REPO, 'DESIGN.md'), 'utf8');
  ok(/不得使用静态 `headers` 字段/.test(design), 'DESIGN 仍写明不得使用静态 headers');
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} 项`}`);
process.exitCode = failures === 0 ? 0 : 1;
