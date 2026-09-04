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
g('被禁止的做法必须有一条走得通的替代路径');
{
  // **这一组是 2026-09-04 那次真实凭据泄露的直接产物。**
  // DESIGN 禁止静态 headers，让人改用 headersHelper 指向
  // scripts/auth-headers.sh——**而那个脚本从来没被写出来过**。
  // 照文档配会失败，于是唯一走得通的就是被禁止的那条。
  //
  // **一条规则挡住了唯一的替代路径，等于没有规则。**
  const helper = path.join(REPO, 'plugins', 'experience', 'scripts', 'auth-headers.js');
  ok(fs.existsSync(helper), 'headersHelper 指向的脚本真的存在', helper);

  const design = fs.readFileSync(path.join(REPO, 'DESIGN.md'), 'utf8');
  // 取整行，不去解析里面的转义引号——上一版的正则在 `node \"` 处就断了，
  // 于是断言对着半截字符串跑，这条用例自己就成了它要防的东西。
  const snippet = design.split('\n').find((l) => l.includes('"headersHelper"')) || '';
  ok(snippet.includes('auth-headers.js'), 'DESIGN 的示例指向 .js 而非从未存在的 .sh', snippet);
  ok(snippet.includes('node'), 'DESIGN 的示例以 node 调用——本项目脚本不依赖 shebang 与可执行位', snippet);

  if (fs.existsSync(helper)) {
    // 契约（官方文档）：往 stdout 输出一个字符串键值的 JSON 对象。
    const good = spawnSync(process.execPath, [helper], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
      env: { ...process.env, MEM0_API_KEY: 'zz-eval-fake-key' },
    });
    let parsed = null;
    try { parsed = JSON.parse(good.stdout); } catch (_) { /* 下面报 */ }
    ok(good.status === 0 && parsed && typeof parsed === 'object' && !Array.isArray(parsed),
      '有 key 时输出字符串键值的 JSON 对象', `code=${good.status} out=${good.stdout.slice(0, 60)}`);
    ok(parsed && Object.values(parsed).every((v) => typeof v === 'string'),
      '取值全是字符串（契约要求）', JSON.stringify(parsed));
    ok(parsed && /^Bearer /.test(parsed.Authorization || ''),
      'MCP 侧用 Bearer——2026-09-03 对活端点实测过', JSON.stringify(parsed));

    // 取不到 key 时**不许**输出 {} 或空 header：前者静默退回 OAuth 浏览器
    // 登录（CI 里正是配它要避免的），后者拿坏 header 去连、服务端 401，
    // 而用户看到的是"检索不到经验"。两种都是静默失效。
    const bare = spawnSync(process.execPath, [helper], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
      env: { ...process.env, MEM0_API_KEY: '' },
    });
    ok(bare.status !== 0, '缺 key 时非 0 退出，响亮地失败', `code=${bare.status}`);
    ok(bare.stdout.trim() === '', '缺 key 时 stdout 为空——不输出 {} 也不输出空 header', JSON.stringify(bare.stdout));
    ok(/MEM0_API_KEY/.test(bare.stderr), '缺 key 时说清缺的是什么', bare.stderr.split('\n')[0]);
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
