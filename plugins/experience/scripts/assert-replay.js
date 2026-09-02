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
//     --cwd <dir>       在哪个仓库里跑与查（默认当前目录，必须存在）
//     --timeout <ms>    单条命令超时（默认 30000）
//     --allow <a,b,c>   追加允许执行的程序；追加的程序**不允许携带任何选项**
//     --quiet           只输出 JSON，不输出人类可读摘要
//
// 退出码：0 = 无失败；1 = 有条目未通过；2 = 用法或输入错误。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ===========================================================================
// 执行边界
//
// evidence_cmd 是团队共享云端库里的一段文本，重跑它等于让任何能写入该库的
// 人在每个成员机器上执行命令。红线过滤挡的是数据出去，这里挡的是代码进来。
//
// 2026-09-02 的落地评审实测证明：**只按程序名做白名单不构成边界。**
// 三条无 shell 元字符、通过程序名白名单、且全部返回 pass 的攻击：
//   - "/tmp/fakebin/git.exe"                       basename 是 git，执行的是别的
//   - "git ls-remote --upload-pack=/tmp/payload"   git 会真的拉起那个程序
//   - "find . -maxdepth 0 -fprintf /tmp/x line\n"  写出带换行的任意文件
// 同族还有 rg --pre、npm install（postinstall）、go run …@latest、make -f。
//
// 因此边界下沉到**子命令 + 逐个选项**：
//   1. 程序名必须是裸名——含路径分隔符一律拒绝，杜绝假冒二进制
//   2. 子命令必须在该程序的允许列表内
//   3. **每一个选项都必须被显式允许**，未列举即拒绝（而非列举危险项去拦）
//   4. 所有位置参数与选项取值都必须落在 --cwd 之内（拒绝绝对路径与 .. 段）
//
// 拒绝是安全的失败方向：被拒按失败计，不按"没检查"计。要放宽必须改这张表，
// 是一次有意的动作。
// ===========================================================================

// 选项名归一：--flag=value -> --flag；组合短选项 -rn 展开为 -r -n
function normalizeFlags(arg) {
  const name = arg.split('=')[0];
  if (/^-[A-Za-z]{2,}$/.test(name)) return name.slice(1).split('').map((c) => `-${c}`);
  return [name];
}

const N = /^-n?\d+$/; // -5 / -n5 这类计数短选项

const COMMAND_RULES = {
  git: {
    subcommands: ['status', 'log', 'rev-parse', 'show', 'diff', 'ls-files', 'grep',
      'describe', 'blame', 'shortlog', 'cat-file', 'branch', 'tag', 'ls-tree'],
    flags: ['--oneline', '--porcelain', '--stat', '--numstat', '--name-only', '--name-status',
      '--short', '--abbrev-ref', '--verify', '--is-inside-work-tree', '--show-toplevel',
      '--count', '--all', '--no-color', '--color', '--pretty', '--format', '--grep',
      '--author', '--since', '--until', '--max-count', '--follow', '--reverse',
      '-n', '-q', '-w', '-i', '-l', '-c1', '--word-regexp', '--fixed-strings', '--', N],
    // 显式不允许（列在此处仅为说明；判定靠上面的允许列表）：
    //   --upload-pack --receive-pack --exec-path -c --config-env --output -O --pager
    //   --ext-diff --textconv  —— 全部能拉起外部程序或写宿主配置
  },
  rg: {
    subcommands: null,
    flags: ['--count', '--count-matches', '--files-with-matches', '--quiet', '--fixed-strings',
      '--word-regexp', '--ignore-case', '--no-ignore', '--hidden', '--glob', '--type',
      '--max-count', '--line-number', '--no-heading', '--color', '--no-filename',
      '-c', '-l', '-q', '-F', '-w', '-i', '-g', '-t', '-m', '-n', '-N', '-e', '--'],
    // 不允许：--pre --hostname-bin（每个文件调外部程序）
  },
  grep: {
    subcommands: null,
    flags: ['-r', '-R', '-n', '-i', '-w', '-F', '-E', '-q', '-l', '-L', '-c', '-o', '-v',
      '-h', '-I', '-s', '-a', '--include', '--exclude', '--exclude-dir', '--color', '--'],
  },
  ls: { subcommands: null, flags: ['-l', '-a', '-1', '-R', '-h', '-d', '--color', '--'] },
  wc: { subcommands: null, flags: ['-l', '-c', '-w', '-m', '--'] },
  head: { subcommands: null, flags: ['-n', '-c', '--', N] },
  tail: { subcommands: null, flags: ['-n', '-c', '--', N] },
  cat: { subcommands: null, flags: ['-n', '-A', '--'] },
  diff: { subcommands: null, flags: ['-u', '-r', '-q', '-N', '-w', '-b', '--brief', '--'] },

  // 测试与构建入口。子命令收得很紧：install / run / get / exec 这类会从公网
  // 拉第三方代码执行，信任边界会从"本仓库"扩大到"任意包名"。
  go: {
    subcommands: ['test', 'vet', 'list', 'build'],
    flags: ['-run', '-count', '-v', '-short', '-race', '-timeout', '-tags', '-json', '--'],
    // 不允许：run / install / get / generate 子命令；-exec -toolexec -ldflags 选项
  },
  npm: { subcommands: ['test'], flags: ['--'] },
  pnpm: { subcommands: ['test'], flags: ['--'] },
  yarn: { subcommands: ['test'], flags: ['--'] },
  cargo: { subcommands: ['test'], flags: ['--quiet', '-q', '--'] },
  pytest: { subcommands: null, flags: ['-q', '-x', '-v', '-k', '--maxfail', '--tb', '--'] },
  make: { subcommands: null, flags: [] }, // 无选项：挡住 -f /tmp/evil.mk
};

// 上一版白名单里被本次移除的程序，及理由（不要再加回来，除非能逐个选项收紧）：
//   find    -fprintf / -fls 写任意文件，-exec 起任意程序
//   mvn     <group>:<artifact>:<ver>:run 执行任意插件
//   gradle  init script / 任务即代码
//   dotnet  dotnet <任意.dll>
//   test    无用

const SHELL_METACHARS = /[;&|<>`$(){}\n\r]/;

/** 按空白切分，尊重成对引号；不做任何展开。反斜杠转义不支持，见 vetCommand。 */
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

/** 位置参数与选项取值必须落在仓库内：拒绝绝对路径与 .. 路径段。 */
function escapesRepo(value) {
  if (value === '') return false;
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.split(/[\\/]/).includes('..');
}

function flagAllowed(name, allowed) {
  return allowed.some((a) => (a instanceof RegExp ? a.test(name) : a === name));
}

/** @returns {{ok: true, argv: string[]} | {ok: false, reason: string}} */
function vetCommand(cmd, extraAllow) {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    return { ok: false, reason: 'evidence_cmd 为空' };
  }
  const meta = cmd.match(SHELL_METACHARS);
  if (meta) {
    return { ok: false, reason: `含 shell 元字符 ${JSON.stringify(meta[0])}——不允许串接、重定向或命令替换` };
  }
  if (/\\["']/.test(cmd)) {
    // 分词器不支持反斜杠转义，会把 \" 里的 " 当成闭合引号，静默改写参数。
    // 拒绝比误解安全——评审者在库里读到的命令，必须就是实际执行的那条。
    return { ok: false, reason: '含反斜杠转义的引号——分词器不支持，会静默改写参数' };
  }

  let argv;
  try {
    argv = tokenize(cmd);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (argv.length === 0) return { ok: false, reason: 'evidence_cmd 为空' };

  const prog = argv[0];
  if (/[\\/]/.test(prog)) {
    // 上一版取 basename 判白名单、却执行原样路径，于是 /tmp/evil/git 被放行。
    return { ok: false, reason: `程序名含路径分隔符：${JSON.stringify(prog)}——只允许裸程序名，由 PATH 解析` };
  }

  const rule = COMMAND_RULES[prog] || (extraAllow.has(prog) ? { subcommands: null, flags: [] } : null);
  if (!rule) {
    return { ok: false, reason: `程序 ${JSON.stringify(prog)} 不在允许列表内` };
  }

  let i = 1;
  if (rule.subcommands) {
    const sub = argv[1];
    if (sub === undefined || !rule.subcommands.includes(sub)) {
      return { ok: false, reason: `${prog} 的子命令 ${JSON.stringify(sub ?? '(缺失)')} 不被允许，可用：${rule.subcommands.join(' / ')}` };
    }
    i = 2;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('-') && arg !== '-') {
      for (const name of normalizeFlags(arg)) {
        if (!flagAllowed(name, rule.flags)) {
          return { ok: false, reason: `${prog} 不允许选项 ${JSON.stringify(name)}——未列举的选项一律拒绝` };
        }
      }
      const eq = arg.indexOf('=');
      if (eq !== -1 && escapesRepo(arg.slice(eq + 1))) {
        return { ok: false, reason: `选项取值越出仓库：${JSON.stringify(arg)}` };
      }
    } else if (escapesRepo(arg)) {
      return { ok: false, reason: `参数越出仓库：${JSON.stringify(arg)}——绝对路径与 .. 一律拒绝` };
    }
  }

  return { ok: true, argv };
}

// ===========================================================================
// 检查一：重跑断言
// ===========================================================================

/**
 * evidence_digest 是「退出码 + 输出摘要」的可判定形式：
 *   { "exit": 0, "contains": ["ok  "], "absent": ["FAIL"] }
 * 三项均可省；**省略 exit 时默认期望 0**——「命令跑不通」必须能被检出，
 * 否则淘汰判据「evidence_cmd 跑不通 → 标 stale」拿不到信号。
 *
 * 不比对完整输出：重跑几乎不会逐字节相同（时间戳、路径、耗时）。比对退出码
 * 与特征串既稳定，又抓得住"跑了但抄错"——前身实测过的形态是原始输出 11 行
 * 就贴在紧邻处，结论里却写了 10。
 */
function checkCommand(entry, opts) {
  const md = entry.metadata || {};
  const cmd = md.evidence_cmd;
  if (cmd === undefined || cmd === null || String(cmd).trim() === '') {
    return { kind: 'command', status: 'missing', detail: '条目没有 evidence_cmd' };
  }

  const vet = vetCommand(cmd, opts.allow);
  if (!vet.ok) {
    return { kind: 'command', status: 'refused', detail: vet.reason, cmd };
  }

  const [prog, ...args] = vet.argv;
  const r = spawnSync(prog, args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    encoding: 'utf8',
    shell: false,          // 关键：不经 shell
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (r.error) {
    const c = r.error.code;
    const why = c === 'ETIMEDOUT' ? `超时（>${opts.timeout}ms）`
      : c === 'ENOBUFS' ? '输出超过 8MB 上限'
        : c === 'ENOENT' ? `找不到程序 ${prog}`
          : r.error.message;
    return { kind: 'command', status: 'fail', detail: `无法完成：${why}`, cmd };
  }
  if (r.status === null) {
    // 被信号杀死（SIGSEGV、OOM kill 等）。没有退出码可比，不能算通过。
    return { kind: 'command', status: 'fail', detail: `被信号 ${r.signal || '未知'} 终止`, cmd };
  }

  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const want = md.evidence_digest && typeof md.evidence_digest === 'object' ? md.evidence_digest : {};
  const wantExit = want.exit === undefined ? 0 : want.exit;
  const problems = [];

  if (r.status !== wantExit) {
    problems.push(want.exit === undefined
      ? `退出码 ${r.status}（未声称 exit 时默认期望 0）`
      : `退出码 声称 ${want.exit}，实为 ${r.status}`);
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

// ===========================================================================
// 检查二：符号存在性
// ===========================================================================

/**
 * 覆盖的是"编造一个根本不存在的符号"这个主要形态——腾讯团队的实测案例：
 * 经验称应调用 FastScrollBar.attachToQBListView()，该类根本没有这个方法。
 * 纯文本审核会放行，因为它有场景、有方法名、有操作指引。
 *
 * 边界：语言无关的标识符存在性检查，**不判断归属**（方法属于哪个类）。
 * 抓得住"不存在"，抓不住"存在但归属错了"。归属需要按语言接语言服务，未做。
 */
function checkSymbols(entry, opts) {
  const md = entry.metadata || {};
  const files = toArray(md.files);
  const symbols = toArray(md.symbols);

  if (files.length === 0 && symbols.length === 0) {
    return { kind: 'symbol', status: 'missing', detail: '条目没有 files 也没有 symbols' };
  }

  const problems = [];
  const undetermined = [];

  for (const f of files) {
    const s = String(f);
    if (s.trim() === '' || s === '.' || s === './') {
      problems.push(`路径 ${JSON.stringify(s)} 不指向具体文件——空断言恒真，不接受`);
      continue;
    }
    if (escapesRepo(s)) {
      problems.push(`路径 ${JSON.stringify(s)} 不是仓库相对路径`);
      continue;
    }
    if (!fs.existsSync(path.join(opts.cwd, s))) {
      problems.push(`文件不存在：${s}`);
    }
  }

  for (const sym of symbols) {
    // 取最后一段标识符，容忍调用形态与泛型：
    //   ZzWidget.attachToList()  -> attachToList
    //   Foo::Bar<T>              -> Bar
    const ident = String(sym).replace(/\(.*$/, '').replace(/<.*$/, '').split(/[.#:]/).filter(Boolean).pop();
    if (!ident || !/^[A-Za-z_$][\w$]*$/.test(ident)) {
      problems.push(`符号 ${JSON.stringify(sym)} 不含可检索的标识符`);
      continue;
    }
    const r = repoHasIdentifier(ident, opts);
    if (r.undetermined) undetermined.push(`${sym}（${r.undetermined}）`);
    else if (!r.found) problems.push(`符号在仓库中查无踪迹：${sym}`);
  }

  if (problems.length > 0) return { kind: 'symbol', status: 'fail', detail: problems.join('；') };
  if (undetermined.length > 0) {
    // 查不动 ≠ 不存在。判 error（计入失败）而不是 fail，让调用方知道是工具问题。
    return { kind: 'symbol', status: 'error', detail: `无法判定：${undetermined.join('；')}` };
  }
  return { kind: 'symbol', status: 'pass', detail: `${files.length} 个文件、${symbols.length} 个符号均存在` };
}

/**
 * rg 与 grep 的默认语义完全不同——rg 尊重 .gitignore、跳过隐藏目录与二进制，
 * grep -r 全都搜。若不统一，同一条经验在装了 rg 和没装 rg 的机器上会得到
 * 相反结论：一边把 dist/ 里的符号判成"查无踪迹"（误杀），另一边因为某条
 * commit message 提过这个词就判"存在"（放过编造）。
 *
 * 统一为「搜全部工作树文件，但排除 .git，跳过二进制」。
 *
 * @returns {{found: boolean} | {undetermined: string}}
 */
function repoHasIdentifier(ident, opts) {
  const backends = [
    // rg 默认即跳过二进制文件；grep 需显式 -I 才能与之一致。
    ['rg', ['--no-ignore', '--hidden', '--glob', '!.git/**',
      '--fixed-strings', '--word-regexp', '--quiet', '--', ident, '.']],
    ['grep', ['-r', '-I', '-s', '-F', '-w', '-q', '--exclude-dir=.git', '--', ident, '.']],
  ];
  const notes = [];
  for (const [prog, args] of backends) {
    const r = spawnSync(prog, args, {
      cwd: opts.cwd, timeout: opts.timeout, shell: false, windowsHide: true, encoding: 'utf8',
    });
    if (r.error) {
      // 只有"这个工具不在"才换下一个；超时、缓冲溢出等要如实上报，
      // 不能静默降级成另一个工具再报一个与事实无关的错。
      if (r.error.code === 'ENOENT') { notes.push(`${prog} 未安装`); continue; }
      return { undetermined: `${prog}: ${r.error.code || r.error.message}` };
    }
    if (r.status === 0) return { found: true };
    if (r.status === 1) return { found: false };
    // >= 2 是工具自身出错（权限、编码），不是"没找到"
    return { undetermined: `${prog} 退出码 ${r.status}：${(r.stderr || '').trim().slice(0, 120)}` };
  }
  return { undetermined: notes.join('、') || 'rg 与 grep 均不可用' };
}

// ===========================================================================

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * 经验跨仓库共享。拿一个仓库当 --cwd 跑全库审计，来自其它仓库的条目会集体
 * 判为文件不存在、命令跑不通——一次审计就能把大半个库误标为失效。
 * 因此先判本条是否属于当前仓库；判不出来时**不跳过**（宁可多验，不可漏验）。
 */
function belongsToRepo(entry, opts) {
  const claimed = entry.metadata && entry.metadata.repo;
  if (!claimed) return true;
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 });
    return r.error || r.status !== 0 ? null : String(r.stdout).trim();
  };
  const top = run(['rev-parse', '--show-toplevel']);
  const origin = run(['remote', 'get-url', 'origin']);
  if (top === null && origin === null) return true;   // 判不出来，不跳过
  const c = String(claimed).toLowerCase();
  const hay = [top && path.basename(top), origin].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(c) || (top !== null && path.basename(top).toLowerCase() === c);
}

function verify(entry, opts) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      id: null,
      verdict: 'fail',
      ok: false,
      checks: [{ kind: 'entry', status: 'error', detail: `条目不是对象：${JSON.stringify(entry)}` }],
    };
  }
  const id = entry.id || (entry.metadata && entry.metadata.id) || null;
  if (entry.metadata !== undefined && (entry.metadata === null || typeof entry.metadata !== 'object' || Array.isArray(entry.metadata))) {
    return { id, verdict: 'fail', ok: false, checks: [{ kind: 'entry', status: 'error', detail: 'metadata 不是对象' }] };
  }

  if (!belongsToRepo(entry, opts)) {
    return {
      id,
      verdict: 'skipped',
      ok: true,
      checks: [{ kind: 'entry', status: 'skipped', detail: `条目属于仓库 ${entry.metadata.repo}，与当前 --cwd 不符` }],
    };
  }

  const checks = [checkCommand(entry, opts), checkSymbols(entry, opts)];
  // missing 不算失败：不是每条经验都带命令或符号。
  // refused / error 算失败——无法验证与验证不过，对采信者是同一件事。
  const bad = checks.some((c) => c.status === 'fail' || c.status === 'refused' || c.status === 'error');
  return { id, verdict: bad ? 'fail' : 'pass', ok: !bad, checks };
}

function parseEntries(text) {
  const t = text.trim();
  if (t === '') return [];
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : [v];
  } catch (_) {
    // JSONL —— 行号必须是原始行号，不能是过滤后的下标
    const out = [];
    text.split('\n').forEach((line, idx) => {
      if (line.trim() === '') return;
      try { out.push(JSON.parse(line)); } catch (e) { throw new Error(`第 ${idx + 1} 行不是合法 JSON：${e.message}`); }
    });
    return out;
  }
}

function main(argv) {
  const opts = { cwd: process.cwd(), timeout: 30000, allow: new Set(), quiet: false };
  const rest = [];
  const needValue = (flag, v) => {
    if (v === undefined || String(v).startsWith('--')) throw new Error(`${flag} 缺少取值`);
    return v;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--cwd') opts.cwd = needValue('--cwd', argv[++i]);
      else if (a === '--timeout') opts.timeout = Number(needValue('--timeout', argv[++i]));
      else if (a === '--allow') String(needValue('--allow', argv[++i])).split(',').forEach((s) => s.trim() && opts.allow.add(s.trim()));
      else if (a === '--quiet') opts.quiet = true;
      else if (a.startsWith('--')) throw new Error(`未知选项 ${a}`);
      else rest.push(a);
    }
    if (rest.length !== 1) throw new Error('需要且只需要一个输入（文件路径或 -）');
    if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error('--timeout 必须是正数（毫秒）');
    if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) throw new Error(`--cwd 不是存在的目录：${opts.cwd}`);
  } catch (e) {
    process.stderr.write(`${e.message}\n用法：node assert-replay.js <entry.json|-> [--cwd dir] [--timeout ms] [--allow a,b] [--quiet]\n`);
    return 2;
  }

  let entries;
  try {
    const text = rest[0] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[0], 'utf8');
    entries = parseEntries(text);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  let results;
  try {
    results = entries.map((e) => verify(e, opts));
  } catch (e) {
    // 内部异常必须退 2，不能与"有条目未通过"的 1 撞码——
    // 否则调用方会把一次崩溃读成一次正常的验证失败。
    process.stderr.write(`内部错误：${e && e.stack ? e.stack : e}\n`);
    return 2;
  }

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');

  if (!opts.quiet) {
    for (const r of results) {
      process.stderr.write(`${r.verdict.toUpperCase().padEnd(7)} ${r.id || '(无 id)'}\n`);
      for (const c of r.checks) {
        process.stderr.write(`    ${c.status.padEnd(9)} ${c.kind.padEnd(8)} ${c.detail}\n`);
      }
    }
  }
  return results.some((r) => r.verdict === 'fail') ? 1 : 0;
}

if (require.main === module) {
  // 不用 process.exit：stdout 接管道时是异步写，直接退出可能截断输出。
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  tokenize, normalizeFlags, escapesRepo, vetCommand, checkCommand, checkSymbols,
  repoHasIdentifier, belongsToRepo, verify, parseEntries, main, COMMAND_RULES,
};
