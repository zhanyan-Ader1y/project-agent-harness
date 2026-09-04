#!/usr/bin/env node
'use strict';
//
// assert-replay —— 目标四的执行者。
//
// 一条经验不是事实，它必须携带指向事实的指针。本脚本负责真的去跑那个指针：
//   1. 重跑断言：按 evidence_cmd 实际执行，比对声称的退出码与输出特征
//   2. 符号存在性：经验声称存在的文件与标识符，是否真的在代码库里
//
// 用法：
//   node assert-replay.js <entry.json>      单条
//   node assert-replay.js -                 从 stdin 读 JSON 或 JSONL
//   选项：
//     --mode <m>        symbols（默认）| full。见下「两个安全面完全不对称的检查」
//     --cwd <dir>       在哪个仓库里跑与查（默认当前目录，必须存在）
//     --timeout <ms>    单条命令/检索超时（默认 30000）
//     --budget <ms>     整轮总延迟上限，超出即停止并把剩余条目判为未验证
//                       （symbols 模式默认 2000；full 模式默认不限）
//                       符号检索整轮只扫一遍仓库，见 prescanSymbols
//     --allow <a,b,c>   追加允许执行的程序；追加的程序**不允许携带任何选项**
//     --backend <name>  强制符号检索后端（rg | grep），默认按可用性回退
//     --quiet           只输出 JSON，不输出人类可读摘要
//
// ## 两个安全面完全不对称的检查
//
// 本脚本做的两件事，威胁面差了一个量级：
//
//   符号存在性  唯一的不可信输入是标识符字符串，被 ^[A-Za-z_$][\w$]*$ 收死，
//               命令行由脚本自己拼。**近乎零攻击面。**
//   重跑断言    整条命令来自共享云库。**全部防御成本在这里。**
//
// 因此按消费方分层，而不是一律全跑：
//
//   写入自检      full     命令是作者自己写的、在他自己机器上跑，威胁模型消失
//   注入前校验    symbols  挂在每轮提示上——这条路径**不执行任何命令**
//   人工离线审计  full     由人触发、偶尔跑，边界在这条路径上仍然全副武装
//
// **默认是 symbols。执行命令必须显式 --mode full**——让粗心的调用方
// 默认拿到安全的那一半，而不是反过来。
//
// 退出码：0 = 无失败；1 = 有条目未通过；2 = 用法或输入错误。
//
// 输出的每条结果带三个判定字段，消费方必须区别对待：
//   verdict   pass | fail | skipped
//   ok        没有检出失败（skipped 也是 true）
//   verified  **是否真的验证过**。skipped、工具不可用等情形为 false。
//             淘汰判定只能对 verdict==='fail' 且 verified===true 的条目生效；
//             注入前校验必须把 verified===false 当作不可采信。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ===========================================================================
// 执行边界
//
// evidence_cmd 是团队共享云端库里的一段文本，重跑它等于让任何能写入该库的
// 人在每个成员机器上执行命令。红线过滤挡的是数据出去，这里挡的是代码进来。
//
// 两轮独立评审各实测出一批可执行的攻击，形态逐轮变深：
//
// 第一轮（程序名白名单不构成边界）：
//   "/tmp/fakebin/git.exe"                        basename 是 git，执行的是别的
//   "git ls-remote --upload-pack=/tmp/payload"    git 会真的拉起那个程序
//   "find . -maxdepth 0 -fprintf /tmp/x line"     写出带换行的任意文件
//
// 第二轮（词法路径检查不构成边界）：
//   "cat ~/.gitconfig"        MSYS 的 coreutils 从非 Cygwin 父进程启动时
//   "cat ~/.ssh/*.pub"        会**自行**做 tilde 展开与 globbing，不经 shell 也一样
//   "cat etc-link/hosts"      符号链接在词法上完全合规（任何平台）
//
// 教训是同一条：**边界必须画在它真正生效的那一层。** 在字符串上画，看不见
// ~ 会变成什么，也看不见链接指向哪。因此现在是五道：
//   1. 拒绝 shell 元字符、glob 字符、控制字符、~ 开头、反斜杠转义引号
//   2. 不经 shell 执行——元字符即便漏网也不生效
//   3. 程序名必须是裸名——含路径分隔符一律拒绝，杜绝假冒二进制
//   4. 子命令与**每一个选项**都必须被显式允许，未列举即拒绝
//   5. 每个路径形态的参数做 **realpath 物理围栏**，必须落在 realpath(cwd) 之内
//
// 拒绝是安全的失败方向。要放宽只能改 COMMAND_RULES，是一次有意的动作。
// ===========================================================================

const N = /^-n?\d+$/; // -5 / -n5 这类计数短选项

// 用 Object.create(null)：普通对象字面量会让 "toString" / "__proto__" /
// "hasOwnProperty" 等原型链上的成员被当成"命中的规则"，随后 rule.flags
// 为 undefined 而抛异常，一条 12 字节的畸形条目就能废掉整批校验。
const COMMAND_RULES = Object.assign(Object.create(null), {
  git: {
    // 只留读操作。branch / tag 曾在此列，实测能在成员机器上真的建出 ref。
    subcommands: ['status', 'log', 'rev-parse', 'show', 'diff', 'ls-files', 'grep',
      'describe', 'blame', 'shortlog', 'cat-file', 'ls-tree'],
    flags: ['--oneline', '--porcelain', '--stat', '--numstat', '--name-only', '--name-status',
      '--short', '--abbrev-ref', '--verify', '--is-inside-work-tree', '--show-toplevel',
      '--count', '--all', '--no-color', '--color', '--pretty', '--format', '--grep',
      '--author', '--since', '--until', '--max-count', '--follow', '--reverse',
      '-n', '-q', '-w', '-i', '-l', '--word-regexp', '--fixed-strings', '--', N],
    // 不允许：--upload-pack --receive-pack --exec-path -c --config-env
    //         --output -O --pager --ext-diff --textconv
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

  // 测试入口。子命令收得很紧：install / run / get / exec 会从公网拉第三方
  // 代码执行，信任边界会从"本仓库"扩大到"任意包名"。
  // singleDashLong：这些程序用 -run / -count 这类单横线长选项，不能按
  // 组合短选项展开——否则 -run 会被拆成 -r -u -n 而全部拒绝。
  go: {
    subcommands: ['test', 'vet', 'list', 'build'],
    singleDashLong: true,
    flags: ['-run', '-count', '-v', '-short', '-race', '-timeout', '-tags', '-json', '--'],
  },
  npm: { subcommands: ['test'], flags: ['--'] },
  pnpm: { subcommands: ['test'], flags: ['--'] },
  yarn: { subcommands: ['test'], flags: ['--'] },
  cargo: { subcommands: ['test'], flags: ['--quiet', '-q', '--'] },
  pytest: { subcommands: null, flags: ['-q', '-x', '-v', '-k', '--maxfail', '--tb', '--'] },
  // make 的变量覆盖走位置参数（make SHELL=/tmp/evil.sh 能改掉每条 recipe 的
  // 执行程序），因此位置参数不许含 =。
  make: { subcommands: null, flags: [], noEqualsInPositional: true },
});

// 上一版白名单里被移除的程序，及理由（不要再加回来，除非能逐个选项收紧）：
//   find    -fprintf / -fls 写任意文件，-exec 起任意程序
//   mvn     <group>:<artifact>:<ver>:run 执行任意插件
//   gradle  init script / 任务即代码
//   dotnet  dotnet <任意.dll>

const SHELL_METACHARS = /[;&|<>`$(){}\n\r]/;
const GLOB_CHARS = /[*?[\]]/;      // 被调程序会自行展开，不经 shell 也一样
const CONTROL_CHARS = /[\x00-\x1f\x7f]/; // NUL 会让 spawnSync 抛异常

const LIMITS = { files: 20, symbols: 20 };

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

/** 词法围栏：绝对路径与 .. 路径段。realpath 之前的第一道。 */
function escapesRepo(value) {
  if (value === '') return false;
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return true;
  return value.split(/[\\/]/).includes('..');
}

/**
 * 物理围栏：若该值确实指向一个存在的路径，解析符号链接后必须仍在 realpath(cwd)
 * 之内。解析不到（多半是模式串而非路径）就交给词法围栏。
 *
 * 这一道是词法检查补不上的：etc-link -> C:\Windows\System32\drivers\etc
 * 在词法上完全合规。
 */
function escapesRepoPhysically(value, realCwd) {
  if (value === '') return false;
  let real;
  try {
    real = fs.realpathSync.native(path.resolve(realCwd, value));
  } catch (_) {
    return false;   // 不是现存路径
  }
  const rel = path.relative(realCwd, real);
  return rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/** 选项名归一。整名优先——否则 go 的 -run 会被拆成 -r -u -n 而全部拒绝。 */
function normalizeFlags(arg, rule) {
  const name = arg.split('=')[0];
  if (rule && rule.singleDashLong) return [name];
  if (flagAllowed(name, (rule && rule.flags) || [])) return [name];
  if (/^-[A-Za-z]{2,}$/.test(name)) return name.slice(1).split('').map((c) => `-${c}`);
  return [name];
}

function flagAllowed(name, allowed) {
  return allowed.some((a) => (a instanceof RegExp ? a.test(name) : a === name));
}

/**
 * @param {string} cmd
 * @param {{allow: Set<string>, cwd: string}} opts
 * @returns {{ok: true, argv: string[]} | {ok: false, reason: string}}
 */
function vetCommand(cmd, opts) {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    return { ok: false, reason: 'evidence_cmd 为空' };
  }
  for (const [re, why] of [
    [CONTROL_CHARS, '含控制字符'],
    [SHELL_METACHARS, '含 shell 元字符——不允许串接、重定向或命令替换'],
    [GLOB_CHARS, '含 glob 字符——被调程序会自行展开，不经 shell 也一样'],
  ]) {
    const m = cmd.match(re);
    if (m) return { ok: false, reason: `${why}：${JSON.stringify(m[0])}` };
  }
  if (/\\["']/.test(cmd)) {
    // 分词器不支持反斜杠转义，会把 \" 里的 " 当成闭合引号、静默改写参数。
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
    return { ok: false, reason: `程序名含路径分隔符：${JSON.stringify(prog)}——只允许裸程序名，由 PATH 解析` };
  }

  const rule = Object.prototype.hasOwnProperty.call(COMMAND_RULES, prog)
    ? COMMAND_RULES[prog]
    : (opts.allow.has(prog) ? { subcommands: null, flags: [] } : null);
  if (!rule) return { ok: false, reason: `程序 ${JSON.stringify(prog)} 不在允许列表内` };

  let realCwd;
  try {
    realCwd = fs.realpathSync.native(opts.cwd);
  } catch (e) {
    return { ok: false, reason: `无法解析 --cwd：${e.message}` };
  }

  const vetValue = (v, label) => {
    if (v.startsWith('~')) return `${label}以 ~ 开头——被调程序会展开到 home：${JSON.stringify(v)}`;
    if (escapesRepo(v)) return `${label}越出仓库：${JSON.stringify(v)}——绝对路径与 .. 一律拒绝`;
    if (escapesRepoPhysically(v, realCwd)) return `${label}经符号链接指向仓库之外：${JSON.stringify(v)}`;
    return null;
  };

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
      for (const name of normalizeFlags(arg, rule)) {
        if (!flagAllowed(name, rule.flags)) {
          return { ok: false, reason: `${prog} 不允许选项 ${JSON.stringify(name)}——未列举的选项一律拒绝` };
        }
      }
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const bad = vetValue(arg.slice(eq + 1), '选项取值');
        if (bad) return { ok: false, reason: bad };
      }
    } else {
      // 位置参数也要拆一次 = ：make SHELL=/tmp/evil.sh 走的正是这条。
      const eq = arg.indexOf('=');
      if (eq !== -1 && rule.noEqualsInPositional) {
        return { ok: false, reason: `${prog} 的位置参数不允许含 = ：${JSON.stringify(arg)}` };
      }
      for (const part of eq === -1 ? [arg] : [arg.slice(0, eq), arg.slice(eq + 1)]) {
        const bad = vetValue(part, '参数');
        if (bad) return { ok: false, reason: bad };
      }
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
 * 否则淘汰判据「evidence_cmd 跑不通 → 标 stale」拿不到信号。复现型命令
 * （期望非零退出码）必须显式写 exit，否则会被判失败。
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
  if (opts.mode !== 'full') {
    // 注入路径不执行任何命令。这是设计如此，不是缺口，所以 not-run
    // 既不判失败也不影响 verified——但结果里带 mode，调用方据此知道
    // 这一维**没有查过**，不得把 verified:true 读成"命令也验过了"。
    return { kind: 'command', status: 'not-run', detail: `mode=${opts.mode}：本路径不执行命令，需 --mode full`, cmd };
  }

  const vet = vetCommand(cmd, opts);
  if (!vet.ok) return { kind: 'command', status: 'refused', detail: vet.reason, cmd };

  const [prog, ...args] = vet.argv;
  // 预算必须在花时间的那一层生效。只在 verify 入口查一次，等于让一条刚好
  // 卡在 deadline 前开始的条目再花满一个 --timeout（默认 30 秒）。
  const budgetedTimeout = opts.deadline
    ? Math.max(200, Math.min(opts.timeout, opts.deadline - Date.now()))
    : opts.timeout;
  const r = spawnSync(prog, args, {
    cwd: opts.cwd,
    timeout: budgetedTimeout,
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
    return { kind: 'command', status: 'fail', detail: `被信号 ${r.signal || '未知'} 终止`, cmd };
  }

  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const want = readDigest(md);
  if (want.invalid) return { kind: 'command', status: 'error', detail: `无法判定：${want.invalid}`, cmd };
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
  // 上限防的是单条条目失控——实测一条 300 符号的条目耗时 13.5 秒。
  // 整轮延迟不靠这个上限控，靠 prescanSymbols 的批量检索。
  if (files.length > LIMITS.files || symbols.length > LIMITS.symbols) {
    return {
      kind: 'symbol',
      status: 'fail',
      detail: `条目声称 ${files.length} 个文件、${symbols.length} 个符号，超出上限（各 ${LIMITS.files}/${LIMITS.symbols}）`,
    };
  }

  const problems = [];
  const undetermined = [];

  for (const f of files) {
    const s = String(f);
    if (s.trim() === '' || s === '.' || s === './') {
      problems.push(`路径 ${JSON.stringify(s)} 不指向具体文件——空断言恒真，不接受`);
    } else if (s.startsWith('~') || escapesRepo(s)) {
      problems.push(`路径 ${JSON.stringify(s)} 不是仓库相对路径`);
    } else if (escapesRepoPhysically(s, opts.realCwd || opts.cwd)) {
      problems.push(`路径 ${JSON.stringify(s)} 经符号链接指向仓库之外`);
    } else if (!fs.existsSync(path.join(opts.cwd, s))) {
      problems.push(`文件不存在：${s}`);
    }
  }

  for (const sym of symbols) {
    const ident = identOf(sym);
    if (!ident) {
      problems.push(`符号 ${JSON.stringify(sym)} 不含可检索的标识符`);
      continue;
    }

    // 首选整轮一次的批量检索结果（见 prescanSymbols）。
    if (opts._symbolScan) {
      if (!opts._symbolScan.has(ident)) problems.push(`符号在仓库中查无踪迹：${sym}`);
      continue;
    }
    // 批量整批失败时不再逐个去撞同一堵墙——没有后端就是没有后端，
    // 100 次注定 ENOENT 的 spawn 只是把"查不动"这个结论拖慢。
    if (opts._symbolScanFailed) {
      undetermined.push(`${sym}（${opts._symbolScanFailed}）`);
      continue;
    }

    // 退路：逐个查。批量未跑过（直接调用本函数）时走这里，结论与批量一致。
    // 预算必须在**花时间的那一层**检查，不能只在条目之间：每个符号一次
    // 全仓检索、单次上限 opts.timeout，20 个符号最坏 20 × timeout，而注入
    // 前校验挂在每轮用户提示上——只在 verify 入口查一次 deadline，等于声称
    // 了一个限不住的上界。
    if (opts.deadline && Date.now() > opts.deadline) {
      undetermined.push(`剩余符号未检索（超出总延迟预算 ${opts.budget}ms）`);
      break;
    }
    // 单次检索也不得超出剩余预算，否则一次 30 秒的检索就能吃掉整轮。
    const budgeted = opts.deadline
      ? { ...opts, timeout: Math.max(200, Math.min(opts.timeout, opts.deadline - Date.now())) }
      : opts;
    const r = repoHasIdentifier(ident, budgeted);
    if (r.undetermined) undetermined.push(`${sym}（${r.undetermined}）`);
    else if (!r.found) problems.push(`符号在仓库中查无踪迹：${sym}`);
  }

  if (problems.length > 0) return { kind: 'symbol', status: 'fail', detail: problems.join('；') };
  if (undetermined.length > 0) {
    // 查不动 ≠ 不存在。判 error 并让整条 verified=false，否则一台没装
    // rg 也没装 grep 的机器跑一次全库审计会把所有带 symbols 的条目标 stale。
    return { kind: 'symbol', status: 'error', detail: `无法判定：${undetermined.join('；')}` };
  }
  return { kind: 'symbol', status: 'pass', detail: `${files.length} 个文件、${symbols.length} 个符号均存在` };
}

/**
 * 取最后一段标识符，容忍调用形态与泛型：
 *   ZzWidget.attachToList()  -> attachToList
 *   Foo::Bar<T>              -> Bar
 * @returns {string|null} null = 不含可检索的标识符
 */
function identOf(sym) {
  const ident = String(sym).replace(/\(.*$/, '').replace(/<.*$/, '').split(/[.#:]/).filter(Boolean).pop();
  return ident && /^[A-Za-z_$][\w$]*$/.test(ident) ? ident : null;
}

const BACKENDS = {
  // rg 默认尊重 .gitignore、跳过隐藏目录与二进制；grep -r 全都搜。
  // 若不统一，同一条经验在装了 rg 和没装 rg 的机器上会得到相反结论。
  // 统一为「搜全部工作树文件，排除 .git，跳过二进制」。
  rg: (ident) => ['rg', ['--no-ignore', '--hidden', '--glob', '!.git/**',
    '--fixed-strings', '--word-regexp', '--quiet', '--', ident, '.']],
  grep: (ident) => ['grep', ['-r', '-I', '-s', '-F', '-w', '-q', '--exclude-dir=.git', '--', ident, '.']],
};

/**
 * 批量形态：与 BACKENDS 搜同一批文件、同一套匹配语义，只是一次带多个 pattern，
 * 并把 `--quiet` 换成 `-o`（只输出匹配串本身）。`-F -w` 下匹配串恒等于 pattern，
 * 因此去重后的输出就是"命中了哪些符号"，未出现的即不存在——逐符号的判定不丢。
 *
 * **不用 --max-count 压输出量**：它是每文件的总匹配上限，跨 pattern 生效。
 * 一个被 A 刷屏的文件会把只在该文件出现的 B 挤掉，B 于是被误判为不存在——
 * 那正是"把一条正确经验判死"的组合。宁可靠 maxBuffer 兜底后退回逐个查。
 */
const BATCH_BACKENDS = {
  rg: (idents) => ['rg', ['--no-ignore', '--hidden', '--glob', '!.git/**',
    '--fixed-strings', '--word-regexp', '--only-matching', '--no-filename', '--no-line-number',
    ...idents.flatMap((s) => ['-e', s]), '--', '.']],
  grep: (idents) => ['grep', ['-r', '-I', '-s', '-F', '-w', '-o', '-h', '--exclude-dir=.git',
    ...idents.flatMap((s) => ['-e', s]), '--', '.']],
};

// 分块只为躲命令行长度上限，不为性能——批量的收益来自"少扫几遍仓库"，
// 200 个 pattern 一次已经把 100 个符号的常见规模收进单次调用。
const BATCH_SIZE = 200;
// 输出是全部匹配串。特定到具体符号的标识符不会刷屏，但 symbols 里写一个
// 极常见的词（如 get）就会。超出即判定失败并退回逐个查，不静默截断。
const BATCH_MAX_BUFFER = 32 * 1024 * 1024;

/** @returns {{found: Set<string>} | {undetermined: string}} */
function repoHasIdentifiers(idents, opts) {
  const names = opts.backend ? [opts.backend] : ['rg', 'grep'];
  const notes = [];
  for (const name of names) {
    const make = BATCH_BACKENDS[name];
    if (!make) return { undetermined: `未知后端 ${name}` };

    const found = new Set();
    let failed = null;
    for (let i = 0; i < idents.length; i += BATCH_SIZE) {
      const t = opts.deadline
        ? Math.max(200, Math.min(opts.timeout, opts.deadline - Date.now()))
        : opts.timeout;
      const [prog, args] = make(idents.slice(i, i + BATCH_SIZE));
      const r = spawnSync(prog, args, {
        cwd: opts.cwd, timeout: t, shell: false, windowsHide: true,
        encoding: 'utf8', maxBuffer: BATCH_MAX_BUFFER,
      });
      if (r.error) {
        // 只有"这个工具不在"才换下一个后端；其余（超时、缓冲溢出）如实上报。
        if (r.error.code === 'ENOENT') { notes.push(`${prog} 未安装`); failed = '__next__'; break; }
        failed = `${prog}: ${r.error.code || r.error.message}`;
        break;
      }
      // 0 = 有匹配、1 = 无匹配，两者都是正常结论；≥2 才是出错。
      if (r.status !== 0 && r.status !== 1) {
        failed = `${prog} 退出码 ${r.status}：${(r.stderr || '').trim().slice(0, 120)}`;
        break;
      }
      for (const line of String(r.stdout).split('\n')) {
        const s = line.trim();
        if (s) found.add(s);
      }
    }
    if (failed === '__next__') continue;
    if (failed) return { undetermined: failed };
    return { found };
  }
  return { undetermined: notes.join('、') || '没有可用的检索后端' };
}

/**
 * 整轮一次的符号检索。**成本几乎全在"扫一遍仓库"这个固定开销上，不在符号
 * 数量上**——一次调用带 100 个 pattern 与带 1 个 pattern 扫的是同一遍。
 *
 * 实测（Themis 仓库，405 个跟踪文件 / 18 MB，ripgrep 15.1.0），100 个符号：
 *   rg    逐个 6,404 ms → 批量 122 ms
 *   grep  逐个 16,843 ms → 批量 205 ms
 *
 * 2,000 ms 的注入前预算原先靠"不出机器的本地缓存"来平，而缓存已明确不做
 * （2026-09-04）。**这里存的是一次批量检索的结果分发，不是跨轮缓存**：它挂在
 * opts 上、随进程结束消失，下一轮提示重新扫。
 *
 * 失败不影响正确性，只影响速度与可判定性：拿不到批量结果时 checkSymbols
 * 退回逐个查（本函数没跑过）或整体判为查不动（本函数跑了但失败）。
 */
function prescanSymbols(entries, opts) {
  const idents = new Set();
  for (const e of entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const md = e.metadata;
    if (md === null || typeof md !== 'object' || Array.isArray(md)) continue;
    const syms = toArray(md.symbols);
    // 超上限的条目会先被判失败，不必为它扫。
    if (syms.length === 0 || syms.length > LIMITS.symbols) continue;
    for (const s of syms) {
      const i = identOf(s);
      if (i) idents.add(i);
    }
  }
  if (idents.size === 0) { opts._symbolScan = new Set(); return; }
  if (opts.deadline && Date.now() > opts.deadline) {
    opts._symbolScanFailed = `超出总延迟预算（${opts.budget}ms），未做符号检索`;
    return;
  }
  const r = repoHasIdentifiers([...idents], opts);
  if (r.undetermined) opts._symbolScanFailed = r.undetermined;
  else opts._symbolScan = r.found;
}

/** @returns {{found: boolean} | {undetermined: string}} */
function repoHasIdentifier(ident, opts) {
  const names = opts.backend ? [opts.backend] : ['rg', 'grep'];
  const notes = [];
  for (const name of names) {
    const make = BACKENDS[name];
    if (!make) return { undetermined: `未知后端 ${name}` };
    const [prog, args] = make(ident);
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
    return { undetermined: `${prog} 退出码 ${r.status}：${(r.stderr || '').trim().slice(0, 120)}` };
  }
  return { undetermined: notes.join('、') || '没有可用的检索后端' };
}

// ===========================================================================

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * 读取期望值，同时认两种形状——**因为 mem0 的 metadata 是字符串键值模型**，
 * 实测（2026-09-03）往返后：数字变字符串、单元素数组降级成标量、
 * 嵌套对象被扁平化成 `key.subkey` 形式的字符串数组。
 *
 *   手写条目：  evidence_digest: { exit: 0, contains: ["ok"] }
 *   往返之后：  evidence_exit: "0", evidence_contains: "ok"（单元素已降级）
 *
 * 因此扁平字段优先（那是从库里取回的真实形状），退回嵌套（手写与本地测试）。
 * 退出码统一转数字比较——`"0" !== 0` 会让每一条往返过的经验都判失败。
 */
function readDigest(md) {
  const raw = md.evidence_digest;
  // mem0 把嵌套对象扁平化成 ["exit.0","contains.ok"] 这种字符串数组。
  // 上一版对这个形状什么都不做——nested 分支不匹配、扁平字段又不存在，
  // 于是 digest 静默消失、退回"默认期望 0"。一条声称 exit:128 的复现型
  // 经验会因此被判 fail 且 verified:true，**正是唯一可据以淘汰的组合**。
  // 拒绝比误解安全，与 vetCommand 对反斜杠引号的处理同理。
  if (raw !== undefined && raw !== null && (Array.isArray(raw) || typeof raw !== 'object')) {
    return { invalid: `evidence_digest 形状无法解析（${Array.isArray(raw) ? '数组，多半是 mem0 扁平化后的形状' : typeof raw}）——请改用 evidence_exit / evidence_contains / evidence_absent` };
  }
  const nested = raw && typeof raw === 'object' ? raw : {};
  // 空值等同于"没写"——字符串键值模型里空串就是没有值，此时退回嵌套形状。
  const present = (v) => v !== undefined && v !== null && String(v).trim() !== '' && !(Array.isArray(v) && v.length === 0);
  const pick = (flat, nest) => (present(flat) ? flat : nest);

  const rawExit = pick(md.evidence_exit, nested.exit);
  const out = {
    contains: toArray(pick(md.evidence_contains, nested.contains)).map(String),
    absent: toArray(pick(md.evidence_absent, nested.absent)).map(String),
  };
  if (present(rawExit)) {
    const n = Number(rawExit);
    // 存在但转不成数 → 判非法，不静默掉进"默认期望 0"
    if (!Number.isFinite(n)) return { invalid: `退出码 ${JSON.stringify(rawExit)} 不是数字` };
    out.exit = n;
  }
  return out;
}

/**
 * 经验跨仓库共享。拿一个仓库当 --cwd 跑全库审计，来自其它仓库的条目会集体
 * 判为文件不存在、命令跑不通——一次审计就能把大半个库误标为失效。
 *
 * 但 repo 是条目自带的字段，因此它同时是一个**条目可自选的免检开关**。
 * 出口在 verified：跳过的条目 verified=false，注入前校验必须把它当作不可
 * 采信（不注入），淘汰判定必须不对它生效。这样"自称属于别的仓库"换来的
 * 是不被采用，而不是免检通过。
 */
function belongsToRepo(entry, opts) {
  const claimed = entry.metadata && entry.metadata.repo;
  if (claimed === undefined || claimed === null) return { belongs: true };
  if (typeof claimed !== 'string' || claimed.trim() === '') {
    return { belongs: true, malformed: 'repo 不是非空字符串' };
  }
  // 探测结果只跟 --cwd 有关，与条目无关。上一版每条都跑两次 git、
  // 硬编码 10 秒超时——实测 5 条空条目里 617ms 全在这里，而注入前校验
  // 挂在每轮提示上。改为整轮算一次并复用，超时由剩余预算派生。
  if (!opts._repoProbe) {
    const t = opts.deadline ? Math.max(200, Math.min(10000, opts.deadline - Date.now())) : 10000;
    const run = (args) => {
      const r = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: t });
      return r.error || r.status !== 0 ? null : String(r.stdout).trim();
    };
    opts._repoProbe = { top: run(['rev-parse', '--show-toplevel']), origin: run(['remote', 'get-url', 'origin']) };
  }
  const { top, origin } = opts._repoProbe;
  if (top === null && origin === null) return { belongs: true };   // 判不出来，不跳过

  const want = claimed.trim().toLowerCase().replace(/\.git$/, '');
  const names = [];
  if (top) names.push(path.basename(top).toLowerCase());
  if (origin) {
    // 取 remote URL 的最后一到两段，做**整段相等**比较——用 includes 会让
    // repo:"a" 命中几乎任何仓库。
    const segs = origin.toLowerCase().replace(/\.git$/, '').split(/[\\/:]/).filter(Boolean);
    if (segs.length) names.push(segs[segs.length - 1]);
    if (segs.length >= 2) names.push(`${segs[segs.length - 2]}/${segs[segs.length - 1]}`);
  }
  return { belongs: names.includes(want) };
}

function verify(entry, opts) {
  const fail = (detail, id = null) => ({
    id, mode: opts.mode, verdict: 'fail', ok: false, verified: false,
    checks: [{ kind: 'entry', status: 'error', detail }],
  });

  // 总延迟预算：注入前校验挂在每轮用户提示上，必须有上界。超出预算的
  // 条目判为**未验证**而不是失败——"没来得及查"与"查出问题"是两回事，
  // 而 verified:false 在注入路径上的效果就是不注入，自我限流。
  if (opts.deadline && Date.now() > opts.deadline) {
    const id = (entry && typeof entry === 'object' && !Array.isArray(entry))
      ? (entry.id || (entry.metadata && entry.metadata.id) || null) : null;
    return {
      id, mode: opts.mode, verdict: 'fail', ok: false, verified: false,
      checks: [{ kind: 'entry', status: 'error', detail: `超出总延迟预算（${opts.budget}ms），本条未校验` }],
    };
  }

  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return fail(`条目不是对象：${JSON.stringify(entry)}`);
  }
  const id = entry.id || (entry.metadata && entry.metadata.id) || null;
  if (entry.metadata !== undefined && (entry.metadata === null || typeof entry.metadata !== 'object' || Array.isArray(entry.metadata))) {
    return fail('metadata 不是对象', id);
  }

  try {
    const b = belongsToRepo(entry, opts);
    if (b.malformed) return fail(b.malformed, id);
    if (!b.belongs) {
      return {
        id,
        mode: opts.mode,
        verdict: 'skipped',
        ok: true,
        verified: false,   // 关键：没验过就是没验过，消费方不得当作通过
        checks: [{ kind: 'entry', status: 'skipped', detail: `条目属于仓库 ${entry.metadata.repo}，与当前 --cwd 不符` }],
      };
    }

    const checks = [checkCommand(entry, opts), checkSymbols(entry, opts)];

    // verified 的含义是"**真的判定过**"，不是"没出错"。
    //
    // 上一版写的是 `verified: !unverifiable`，于是 missing 与 not-run 都被
    // 算成"验过了"：一条 {"metadata":{}} 的空条目返回 verdict=pass、
    // verified=true，而注入规则只排除 fail 与 verified:false——**什么都没验
    // 的条目原样注入**，"注入前机器验过它声称的符号真的存在"这句话是空的。
    // 而 verified 这个字段正是为了防"把没验证的说成验证过"才加的。
    //
    // 现在：至少有一项 check 给出 pass 或 fail 才算判定过。
    //   fail     是判定（断言为假），计入 verified
    //   refused  不是判定（我们拒绝去验），不计入——因此不会据以淘汰
    //   error    是无法判定
    //   missing / not-run 什么也没判
    const decided = checks.some((c) => c.status === 'pass' || c.status === 'fail');
    const bad = checks.some((c) => c.status === 'fail' || c.status === 'refused');
    const unverifiable = checks.some((c) => c.status === 'error');
    const verified = decided && !unverifiable;

    if (!decided) {
      checks.push({
        kind: 'entry',
        status: 'error',
        detail: `没有任何一项被判定过（mode=${opts.mode}）——条目至少要带 symbols 或 files 才能在注入前被验证`,
      });
    }

    return {
      id,
      mode: opts.mode,
      verdict: bad || unverifiable || !decided ? 'fail' : 'pass',
      ok: !(bad || unverifiable || !decided),
      verified,
      checks,
    };
  } catch (e) {
    // 单条的异常必须留在单条内。否则共享库里一条畸形条目会让整批中止，
    // 而注入前校验挂在每轮提示上——每个成员的每一轮都会拿不到结论。
    return fail(`校验时异常：${(e && e.message) || e}`, id);
  }
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

const MODES = ['symbols', 'full'];
const DEFAULT_BUDGET = { symbols: 2000, full: 0 }; // 0 = 不限

function main(argv) {
  const opts = {
    cwd: process.cwd(), timeout: 30000, allow: new Set(), quiet: false,
    backend: null, mode: 'symbols', budget: null,
  };
  const rest = [];
  const needValue = (flag, v) => {
    if (v === undefined || String(v).startsWith('-')) throw new Error(`${flag} 缺少取值`);
    return v;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--cwd') opts.cwd = needValue('--cwd', argv[++i]);
      else if (a === '--mode') opts.mode = needValue('--mode', argv[++i]);
      else if (a === '--budget') opts.budget = Number(needValue('--budget', argv[++i]));
      else if (a === '--timeout') opts.timeout = Number(needValue('--timeout', argv[++i]));
      else if (a === '--backend') opts.backend = needValue('--backend', argv[++i]);
      else if (a === '--allow') String(needValue('--allow', argv[++i])).split(',').forEach((s) => s.trim() && opts.allow.add(s.trim()));
      else if (a === '--quiet') opts.quiet = true;
      else if (a.startsWith('--')) throw new Error(`未知选项 ${a}`);
      else rest.push(a);
    }
    if (rest.length !== 1) throw new Error('需要且只需要一个输入（文件路径或 -）');
    if (!MODES.includes(opts.mode)) throw new Error(`--mode 只能是 ${MODES.join(' 或 ')}`);
    if (opts.budget === null) opts.budget = DEFAULT_BUDGET[opts.mode];
    if (!Number.isFinite(opts.budget) || opts.budget < 0) throw new Error('--budget 必须是非负数（毫秒，0 表示不限）');
    if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error('--timeout 必须是正数（毫秒）');
    if (opts.backend && !BACKENDS[opts.backend]) throw new Error(`--backend 只能是 ${Object.keys(BACKENDS).join(' 或 ')}`);
    if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) throw new Error(`--cwd 不是存在的目录：${opts.cwd}`);
    opts.realCwd = fs.realpathSync.native(opts.cwd);
  } catch (e) {
    process.stderr.write(`${e.message}\n用法：node assert-replay.js <entry.json|-> [--mode symbols|full] [--cwd dir] [--budget ms] [--timeout ms] [--allow a,b] [--backend rg|grep] [--quiet]\n`);
    return 2;
  }
  if (opts.budget > 0) opts.deadline = Date.now() + opts.budget;

  let entries;
  try {
    const text = rest[0] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[0], 'utf8');
    entries = parseEntries(text);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  // 符号检索整轮一次，在逐条校验之前。预算是整轮的，这一步也吃预算。
  prescanSymbols(entries, opts);

  const results = entries.map((e) => verify(e, opts));
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');

  if (!opts.quiet) {
    for (const r of results) {
      process.stderr.write(`${r.verdict.toUpperCase().padEnd(7)} [${r.mode}] ${r.verified ? '' : '[未验证] '}${r.id || '(无 id)'}\n`);
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
  tokenize, normalizeFlags, escapesRepo, escapesRepoPhysically, vetCommand, readDigest,
  checkCommand, checkSymbols, repoHasIdentifier, repoHasIdentifiers, prescanSymbols,
  identOf, belongsToRepo, verify,
  parseEntries, main, COMMAND_RULES, BACKENDS, BATCH_BACKENDS, BATCH_SIZE,
  LIMITS, MODES, DEFAULT_BUDGET,
};
