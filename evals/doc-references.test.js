#!/usr/bin/env node
'use strict';
// eval 种子用例 7：文档提到的文件必须真的存在。
//
// **这条用例是 2026-09-04 一次真实事故的产物。**
// `DESIGN.md` 让人把 `.mcp.json` 的 `headersHelper` 指向
// `${CLAUDE_PLUGIN_ROOT}/scripts/auth-headers.sh`，而**那个脚本从来没被
// 写出来过**。照文档配会失败，于是唯一走得通的就是被明令禁止的静态
// `headers` 字段——真实凭据因此被写进了那个文件。
//
// **一条规则挡住了唯一的替代路径，等于没有规则。** 而这里的根因更浅：
// 文档指向了一个不存在的东西，且没有任何机器会去核对。
//
// 同一形态在两天内出现三次（另两次：`.claude/rules/` 路径作用域规则——
// 插件根本不能提供 rules；`selfcheck --mem0` 声称验 REST 而只探 MCP）。
// 这一条只覆盖其中最机械、也最容易自动核对的那一类：**路径**。
//
// 用法：node evals/doc-references.test.js   （失败时退出码非 0）

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

// 反引号里、看起来是本仓库相对路径的东西。
const PATH_RE = /`((?:plugins|evals|docs|scripts|hooks|skills|\.github)\/[A-Za-z0-9_./@-]+\.(?:js|md|json|ya?ml|sh))`/g;

// **不属于本仓库的引用**。每一条都要写清为什么，否则这个列表会变成
// 让用例闭嘴的地方——那样它就成了自己要防的东西。
const EXTERNAL = [
  // 前身仓库 Themis 的路径，本仓库只引用它的结论；本地提炼件另有其文件。
  { prefix: 'docs/plan/', why: '前身仓库 Themis 的路径，不在本仓库' },
  // 消费方项目里的文件，由使用者自己建。
  { prefix: 'docs/architecture/', why: '消费方项目里的目录，本仓库没有也不该有' },
  { prefix: 'skills/experience-intake/dedup.md', why: '延后项，刻意不建空壳' },
];

const isExternal = (p) => EXTERNAL.find((e) => p.startsWith(e.prefix));

// ---------------------------------------------------------------------------
g('文档里提到的每一个仓库路径都必须存在');
{
  const ls = spawnSync('git', ['ls-files', '-z', '*.md'], { cwd: REPO, encoding: 'utf8', timeout: 30000 });
  if (ls.error || ls.status !== 0) {
    ok(false, 'git ls-files 可用', ls.error ? ls.error.message : `退出码 ${ls.status}`);
  } else {
    const docs = ls.stdout.split('\0').filter(Boolean);
    ok(docs.length > 0, '扫描已跟踪的 Markdown', `${docs.length} 份`);

    const missing = [];
    const skipped = [];
    let checked = 0;
    for (const doc of docs) {
      const text = fs.readFileSync(path.join(REPO, doc), 'utf8');
      for (const m of text.matchAll(PATH_RE)) {
        const p = m[1];
        const ext = isExternal(p);
        if (ext) { skipped.push(`${p}（${ext.why}）`); continue; }
        checked++;
        // 插件内的文档用 `scripts/x.js` 这种相对写法，两处都试。
        if (fs.existsSync(path.join(REPO, p))) continue;
        if (fs.existsSync(path.join(REPO, 'plugins', 'experience', p))) continue;
        missing.push(`${doc} → ${p}`);
      }
    }
    ok(missing.length === 0, `${checked} 个路径引用全部指向真实文件`, missing.join('；'));
    if (skipped.length) {
      console.log(`        （另有 ${new Set(skipped).size} 类已声明为仓库外引用，见 EXTERNAL）`);
    }
  }
}

// ---------------------------------------------------------------------------
g('这条检查本身必须抓得住那次事故');
{
  // RED：把当初那个写法放回去，用例必须失败。**不改真文件**，只对同一段
  // 正则与存在性判断跑一遍——否则这条断言证明不了任何事。
  const sample = '配法：`scripts/auth-headers.sh`';
  const hits = [...sample.matchAll(PATH_RE)].map((m) => m[1]);
  ok(hits.length === 1 && hits[0] === 'scripts/auth-headers.sh', '正则抓得到那个路径', hits.join(','));
  const exists = fs.existsSync(path.join(REPO, hits[0]))
    || fs.existsSync(path.join(REPO, 'plugins', 'experience', hits[0]));
  ok(!exists && !isExternal(hits[0]),
    '且它确实不存在、也不在仓库外引用列表里——当初写进文档时本条会失败');

  // 反向：现在真正在用的那个必须存在。
  const now = 'scripts/auth-headers.js';
  ok(fs.existsSync(path.join(REPO, 'plugins', 'experience', now)), `而现行的 ${now} 存在`);
}

// ---------------------------------------------------------------------------
g('仓库外引用列表不得变成让用例闭嘴的地方');
{
  ok(EXTERNAL.every((e) => typeof e.why === 'string' && e.why.trim().length >= 6),
    '每一条豁免都写明了为什么', EXTERNAL.map((e) => e.prefix).join(', '));
  ok(EXTERNAL.length <= 6, '豁免条目保持个位数——长了就说明在拿它掩盖问题', `${EXTERNAL.length} 条`);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} 项`}`);
process.exitCode = failures === 0 ? 0 : 1;
