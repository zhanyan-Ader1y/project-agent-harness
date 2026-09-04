#!/usr/bin/env node
'use strict';
//
// experience-write —— 经验入库的唯一通道。
//
// hook 拒绝 agent 裸调用 mem0 的写入工具，写入只能走这里。理由有二：
//   1. **查库必须不可跳过**——"是不是第二次"从记忆问题改成查询问题，
//      而记忆问题里没有执行者。跳过查库，甲分支就静默死亡。
//   2. **红线过滤与硬失败要有地方落**——写失败必须硬失败。用户看到
//      "记下了"而实际什么都没写进去，比没有这个功能更坏。
//
// 用法：
//   node experience-write.js <entry.json|->
//   选项：
//     --dry-run         走完全部判定与查库，**不发写入请求**，打印它会发什么
//     --cwd <dir>       写入前自检在哪个仓库里跑（默认当前目录）
//     --user-id <id>    覆盖 MEM0_USER_ID
//     --api-base <url>  覆盖 mem0 REST 根地址
//     --timeout <ms>    单次 HTTP 超时（默认 15000）
//     --quiet           只输出 JSON
//
// 退出码：0 = 已写入（或 --dry-run 全部判定通过）；1 = 判定未通过或写入失败；
//         2 = 用法、输入或配置错误。**任何非 0 都表示库里什么都没多**。
//
// ## 调用方不得自带 status / occurrences / promoted_from
//
// 这三个字段是本脚本的**产出**，不是输入。允许调用方自带，等于让产出经验
// 的 agent 直接把自己的经验标成 confirmed —— 甲分支的闸门就绕过去了，
// 而 hook 拦不到（它拦的是 mcp 工具调用，不是脚本参数）。
//
// ## REST 契约尚未对活端点验证
//
// 路径、鉴权头形状与请求体字段名都在 `scripts/mem0.js`，那里写明了它们
// 没有对活端点跑通过、以及验证手段与它的覆盖范围。
//
// **写入路径尤其没有覆盖**：`selfcheck --mem0` 只发只读检索，不往使用者的
// 共享库里写探针。addPath 只能由**第一条真经验**来验——在那之前不要声称
// 写入路径可用。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mem0 = require('./mem0.js');

const { MEM0 } = mem0;

// 召回前 N 条参与同型判定。**不是相似度阈值**——没有实测过的阈值，
// 凭空写一个 0.85 正是「数字必须来自实跑」要防的那件事。5 与注入条数
// 上限同源。可证伪判据：出现过一次"该判同型却排在第 6 位"，就是 5 太小。
const TOP_K = 5;

// 写入到可查的异步索引延迟，实测约 725ms（2026-09-03）。并发首次撞坑时
// 双方都查不到、各写一条候选，此后互为"第一次"、永不晋级——写完延迟复查
// 一次是唯一不需要服务端事务就能闭合它的办法。留一倍余量。
const INDEX_DELAY_MS = 1500;

const LENSES = ['blackword', 'index', 'logic'];
const HIGH_COST_SIGNALS = ['corrected', 'repeated_failure', 'outside_workspace', 'gate_denied', 'broke_tests'];
const LIMITS = { files: 20, symbols: 20 };
// 本脚本产出、调用方不得自带。见文件头。
const SCRIPT_OWNED = ['status', 'occurrences', 'promoted_from'];

// ===========================================================================
// 形状校验
// ===========================================================================

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * mem0 的 metadata 是**字符串键值模型**（2026-09-03 实测）：数字会被转成
 * 字符串、单元素数组会降级成标量、嵌套对象会被扁平化成 "key.sub" 形式的
 * 字符串数组且不可还原。
 *
 * 因此只允许**字符串与字符串数组**。放行一个数字，取回来就是字符串，
 * `"0" !== 0` 会让这条经验在每次校验时判失败——而失败正是淘汰的对象。
 * 宁可写入时报错，不可入库后慢性失效。
 *
 * **单元素数组不拒绝。** 一条经验只提到一个符号是最常见的形态，拒绝它等于
 * 拒绝大多数经验。降级由 normalizeMetadata 就地做掉，读取端再过 toArray——
 * 这也是 DESIGN 里"读取端一律过 toArray"那句的写入侧对应动作。
 */
function checkMetadataValues(md) {
  const bad = [];
  for (const [k, v] of Object.entries(md)) {
    if (typeof v === 'string') continue;
    if (Array.isArray(v)) {
      if (!v.every((x) => typeof x === 'string')) bad.push(`${k}：数组里有非字符串`);
      continue;
    }
    bad.push(`${k}：${typeof v}（mem0 只存字符串，数字与嵌套对象往返后不可还原）`);
  }
  return bad;
}

/**
 * 把 metadata 化成**与它取回来时一模一样的形状**：单元素数组降级成标量、
 * 空数组与空串整个去掉。
 *
 * 不做这一步也能用（读取端有 toArray），做了是为了消掉一整类意外：
 * 写入自检跑的是这个形状，注入前校验跑的也是这个形状，两者不再可能不同。
 */
function normalizeMetadata(md) {
  const out = {};
  for (const [k, v] of Object.entries(md)) {
    if (Array.isArray(v)) {
      const kept = v.map((x) => String(x)).filter((x) => x.trim() !== '');
      if (kept.length === 0) continue;
      out[k] = kept.length === 1 ? kept[0] : kept;
    } else if (typeof v === 'string') {
      if (v.trim() !== '') out[k] = v;
    } else {
      out[k] = v;   // checkMetadataValues 已经拒过，这里不该到达
    }
  }
  return out;
}

/** @returns {string[]} 问题列表，空数组 = 通过 */
function validate(entry) {
  const p = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['条目不是对象'];
  if (!nonEmpty(entry.information)) p.push('缺 information（一句话：什么做法导致什么错误）');

  const md = entry.metadata;
  if (!md || typeof md !== 'object' || Array.isArray(md)) return p.concat('缺 metadata 或它不是对象');

  for (const k of SCRIPT_OWNED) {
    if (md[k] !== undefined) p.push(`不得自带 ${k}——它是本脚本的产出，自带等于绕过甲分支的闸门`);
  }

  if (!LENSES.includes(md.lens)) p.push(`lens 必须是 ${LENSES.join(' / ')} 之一——三镜头都不命中即不记录`);
  for (const k of ['repo', 'commit', 'author', 'at']) {
    if (!nonEmpty(md[k])) p.push(`缺 ${k}`);
  }

  const files = toArray(md.files);
  const symbols = toArray(md.symbols);
  if (files.length === 0 && symbols.length === 0) {
    // 没有指针就没法在注入前验证它，assert-replay 会判"什么都没判定过"。
    p.push('files 与 symbols 至少要有一个——注入前的机器校验靠它们，两者皆空的条目验不了');
  }
  if (files.length > LIMITS.files) p.push(`files 超过 ${LIMITS.files} 条`);
  if (symbols.length > LIMITS.symbols) p.push(`symbols 超过 ${LIMITS.symbols} 个`);
  for (const f of files) {
    const s = String(f);
    if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.split(/[\\/]/).includes('..') || s.startsWith('~')) {
      p.push(`files 只收仓库相对路径：${JSON.stringify(s)}`);
    }
  }

  // 乙分支：一次就入检索，它的闸门不是次数而是锚。锚缺失即不许走乙分支。
  if (md.high_cost !== undefined) {
    if (!HIGH_COST_SIGNALS.includes(md.high_cost)) {
      p.push(`high_cost 必须是 ${HIGH_COST_SIGNALS.join(' / ')} 之一`);
    }
    if (!nonEmpty(md.high_cost_anchor)) {
      p.push('走乙分支必须带 high_cost_anchor——锚取不到就退回存候选，不能只声称代价高');
    }
  } else if (nonEmpty(md.high_cost_anchor)) {
    p.push('有 high_cost_anchor 却没有 high_cost，说不清它锚的是哪条信号');
  }

  p.push(...checkMetadataValues(md));
  return p;
}

/**
 * 红线：`evidence_output` 不落原文。命令原始输出可能含密钥、内网地址、
 * 客户数据或私有代码，**推到第三方云服务就拿不回来**。
 *
 * 边界说清楚：这一条挡的是"整段输出被贴进来"这个具体形态。它**不是**通用
 * 的密钥扫描器——`evidence_contains` 里的特征串仍然是作者自己写的自由文本，
 * 本脚本不判断它含不含敏感信息。要那一层就得另做，现在没有。
 */
function redline(entry) {
  const md = entry.metadata || {};
  const p = [];
  if (md.evidence_output !== undefined) {
    p.push('evidence_output 不得入库——只留退出码与特征串（evidence_exit / evidence_contains / evidence_absent）');
  }
  return p;
}

// ===========================================================================
// 同型判定：语义锁 ∧ 结构锁
// ===========================================================================

/**
 * 符号的比较键：只剥掉调用与泛型的装饰，**限定符保留**。
 *
 *   ZzWidget.attachToList()  →  ZzWidget.attachToList
 *   Foo::Bar<T>              →  Foo::Bar
 *
 * **不取最后一段标识符**（assert-replay 检索时那么做，那是为了搜得到）。
 * 这里若也取末段，`Foo.get` 与 `Bar.get` 会因为共有一个 `get` 而判同型——
 * 那正是 files 里 README.md 那座桥换了个位置。
 *
 * 代价如实记下：有人写 `attachToList`、有人写 `ZzWidget.attachToList` 时判不出
 * 同型。这是宁可漏判的一处，由 Review 层要求写限定名来补。
 */
const symKey = (s) => String(s).replace(/\(.*$/, '').replace(/<.*$/, '').trim();
const setOf = (v, key = (x) => String(x).trim()) => new Set(toArray(v).map(key).filter(Boolean));
const intersects = (a, b) => [...a].some((x) => b.has(x));

/**
 * 判"这条召回结果与新候选是不是同一个坑"。
 *
 * **语义锁由 mem0 出**（本函数的输入已经是召回前 TOP_K 条），**结构锁在这里**：
 *
 *   symbols 交集非空          —— 项目内标识符跨仓库重名概率低，可单独成锚，
 *                                这也让跨仓库的同一框架坑仍然判得出来
 *   或（repo 相同 ∧ files 交集非空）
 *                             —— README.md、src/index.ts 在任何仓库都有，
 *                                files 单独当锚，它就是那座桥
 *
 * **不做传递闭包**：调用方只拿它判「新候选 vs 每一条召回结果」的直接关系。
 * 因此 A~B、B~C ⟹ A~C 这种桥接式归并在结构上不可能发生。
 *
 * 默认方向是**宁宽勿严**，与 Dedup 相反：漏判同型的后果是库永远为空
 * （最小可用不成立），误判同型的后果只是一条已过 Review 的经验提前进检索，
 * 且仍要过注入前校验、仍可被撤回。两者代价不对等。
 */
function sameKind(candidate, hit) {
  const a = candidate.metadata || {};
  const b = (hit && hit.metadata) || {};
  if (intersects(setOf(a.symbols, symKey), setOf(b.symbols, symKey))) return true;
  const sameRepo = nonEmpty(a.repo) && nonEmpty(b.repo)
    && a.repo.trim().toLowerCase() === String(b.repo).trim().toLowerCase();
  return sameRepo && intersects(setOf(a.files), setOf(b.files));
}

/** 只有 candidate / confirmed 参与同型判定：retracted 是人工撤回，contradicted 暂停召回。 */
const ELIGIBLE = new Set(['candidate', 'confirmed', undefined, '']);

/**
 * 从召回结果里挑晋级目标。**取召回排名最前的那一条**，其余不动——
 * 「多条命中就都算同型」会让一次写入牵动一片，那正是边界污染的起点。
 */
function pickTarget(candidate, hits) {
  for (const h of hits.slice(0, TOP_K)) {
    const st = h && h.metadata && h.metadata.status;
    if (!ELIGIBLE.has(st)) continue;
    if (sameKind(candidate, h)) return h;
  }
  return null;
}

/**
 * 并发下的确定性 tie-break。
 *
 * A、B 同时首次撞坑，各写一条候选，延迟复查时**双方都会看到对方**。若两边
 * 都晋级，库里会多出两条内容相同的 confirmed。取 (at, author) 的字典序：
 * **排在后面的那条负责晋级**，另一条不动。两边看到的是同一对值，因此结论
 * 一定相反，恰好一条晋级。
 *
 * 不用 memory_id 做这件事，是因为 id 由服务端在写入响应里给出，形状未经
 * 实测；at 与 author 是我们自己必填的字段，一定拿得到。
 */
function keyOf(md) {
  return `${String((md && md.at) || '')} ${String((md && md.author) || '')}`;
}
function shouldPromoteOnRace(mine, theirs) {
  return keyOf(mine.metadata) > keyOf(theirs.metadata);
}

// ===========================================================================
// 写入前自检：把 evidence 真的跑一遍
// ===========================================================================

/**
 * `--mode full` 在这里是安全的，且只在这里安全：命令是作者自己写的、在他
 * 自己的机器上跑，"共享库里的陌生命令"这个威胁模型不存在。注入前校验走的
 * 是 `--mode symbols`，那条路一个命令都不执行。
 */
function selfCheck(entry, opts) {
  const script = path.join(__dirname, 'assert-replay.js');
  const r = spawnSync(process.execPath, [script, '-', '--mode', 'full', '--cwd', opts.cwd, '--quiet'], {
    input: JSON.stringify(entry), encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  if (r.error) return { ok: false, detail: `自检没能运行：${r.error.code || r.error.message}` };
  let parsed = null;
  try { parsed = JSON.parse(r.stdout)[0]; } catch (_) { /* 下面统一处理 */ }
  if (!parsed) return { ok: false, detail: `自检输出无法解析：${String(r.stderr).trim().slice(0, 200)}` };
  // skipped 的唯一成因是 repo 不符，而它的后果是"永远写不进去"——不点名
  // 具体是哪两个仓库，作者只会看到一句笼统的"自检未通过"然后反复重试。
  // 这条规则本身是对的：**经验必须由身处该仓库的人写下**，否则 evidence
  // 跑不了、符号查不到，写进去的是一条没人能证伪的断言。
  if (parsed.verdict === 'skipped') {
    return {
      ok: false,
      detail: `条目声称属于仓库 ${JSON.stringify(entry.metadata.repo)}，而自检跑在 ${opts.cwd}——`
        + '经验只能由身处该仓库的人写下，否则它声称的命令与符号在这里都验不了',
    };
  }
  // verified:false 是"没验过"，不是"验证不过"。两者都不许入库——一条自己
  // 都验不了的经验，进了库只会在每个成员的每一轮里被判为不可采信。
  if (parsed.verdict !== 'pass' || parsed.verified !== true) {
    const why = parsed.checks.map((c) => `${c.status} ${c.kind}：${c.detail}`).join('；');
    return { ok: false, detail: `自检未通过（verdict=${parsed.verdict} verified=${parsed.verified}）：${why}` };
  }
  return { ok: true, detail: parsed.checks.map((c) => c.detail).join('；') };
}

// ===========================================================================
// REST
// ===========================================================================

/**
 * 只按 user_id 过滤，**不在服务端按 status 过滤**。
 * 实测确认可用的过滤形状只有 `{AND:[{user_id},{metadata:{status:'confirmed'}}]}`
 * 这一种等值匹配；"candidate 或 confirmed"需要 OR，那个形状没验过。
 * 与其押一个没验过的形状，不如取回来在本地筛——代价是 TOP_K 条里可能混进
 * 已撤回的条目，pickTarget 会跳过它们。
 */
function buildSearchRequest(entry, cfg) {
  return {
    url: cfg.apiBase + MEM0.searchPath,
    body: {
      query: entry.information,
      filters: { AND: [{ user_id: cfg.userId }] },
      top_k: TOP_K,
    },
  };
}

function buildAddRequest(entry, cfg) {
  return {
    url: cfg.apiBase + MEM0.addPath,
    body: {
      messages: [{ role: 'user', content: entry.information }],
      user_id: cfg.userId,
      // 归一化放在构造请求这一层，而不是只放在 applyDecision 里：请求体是
      // 唯一真的出网的东西，形状必须在这里定死，不依赖调用方走了哪条路。
      metadata: normalizeMetadata(entry.metadata),
      // infer:false 跳过整合，条目原样入库。实测（2026-09-03）三条语义高度
      // 相似的经验全部 event=ADD、replaced_by=null——occurrences 与 status
      // 不会被服务端吃掉，甲分支因此成立。
      infer: false,
    },
  };
}

// ===========================================================================

function decideBranch(entry, hits) {
  const target = pickTarget(entry, hits);
  if (target) {
    const prev = Number((target.metadata && target.metadata.occurrences) || 1);
    return {
      branch: '甲',
      status: 'confirmed',
      occurrences: String((Number.isFinite(prev) ? prev : 1) + 1),
      promoted_from: String(target.id || (target.metadata && target.metadata.id) || ''),
      why: '库中已有同型条目（语义锁 ∧ 结构锁），晋级为 confirmed；老候选不动',
    };
  }
  if (nonEmpty(entry.metadata.high_cost)) {
    return {
      branch: '乙',
      status: 'confirmed',
      occurrences: '1',
      why: `单次高代价（${entry.metadata.high_cost}），锚齐备，一次入检索`,
    };
  }
  return {
    branch: '首次',
    status: 'candidate',
    occurrences: '1',
    why: '库中没有同型条目，也不走乙分支——存为候选，不进入检索',
  };
}

function applyDecision(entry, d) {
  const md = { ...entry.metadata, status: d.status, occurrences: d.occurrences };
  if (d.promoted_from) md.promoted_from = d.promoted_from;
  return { ...entry, metadata: normalizeMetadata(md) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(entry, cfg, out) {
  const search = () => mem0.search(cfg, buildSearchRequest(entry, cfg).body);

  const s = await search();
  if (s.error) return { ok: false, detail: s.error };
  out.recalled = s.hits.length;

  const decision = decideBranch(entry, s.hits);
  const final = applyDecision(entry, decision);
  out.decision = decision;
  out.request = buildAddRequest(final, cfg);

  if (cfg.dryRun) return { ok: true, detail: '--dry-run：判定全部完成，未发写入请求' };

  const w = await mem0.add(cfg, out.request.body);
  if (w.error) return { ok: false, detail: w.error };
  out.written = true;

  // 并发竞态的延迟复查。只有刚写下候选时才需要——已经是 confirmed 的条目
  // 不存在"互为第一次"的问题。
  if (decision.status !== 'candidate') return { ok: true, detail: '已写入' };

  await sleep(INDEX_DELAY_MS);
  const again = await search();
  if (again.error) {
    // 复查失败不回滚：候选已经在库里，它本来就是正确的中间状态。
    out.raceCheck = `复查失败（${again.error}）——候选已入库，晋级留待下一次撞上`;
    return { ok: true, detail: '已写入（候选）；并发复查未完成' };
  }
  const mine = keyOf(final.metadata);
  const rival = again.hits.find((h) => keyOf(h.metadata) !== mine
    && ELIGIBLE.has(h.metadata && h.metadata.status)
    && sameKind(final, h));
  if (!rival) {
    out.raceCheck = '复查未发现并发候选';
    return { ok: true, detail: '已写入（候选）' };
  }
  if (!shouldPromoteOnRace(final, rival)) {
    out.raceCheck = '发现并发候选，按 (at, author) 字典序由对方负责晋级';
    return { ok: true, detail: '已写入（候选）' };
  }
  const promoted = applyDecision(entry, {
    status: 'confirmed',
    occurrences: '2',
    promoted_from: String(rival.id || (rival.metadata && rival.metadata.id) || ''),
  });
  const pw = await mem0.add(cfg, buildAddRequest(promoted, cfg).body);
  if (pw.error) {
    out.raceCheck = `发现并发候选但晋级写入失败（${pw.error}）——候选仍在库里`;
    return { ok: true, detail: '已写入（候选）；晋级未完成' };
  }
  out.raceCheck = '发现并发候选，已按 tie-break 晋级';
  return { ok: true, detail: '已写入（候选 + 晋级）' };
}

// ===========================================================================

function main(argv) {
  const cfg = { cwd: process.cwd(), timeout: 15000, dryRun: false, quiet: false };
  const over = {};
  const rest = [];
  const need = (flag, v) => {
    if (v === undefined || String(v).startsWith('-')) throw new Error(`${flag} 缺少取值`);
    return v;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--cwd') cfg.cwd = need('--cwd', argv[++i]);
      else if (a === '--user-id') over.userId = need('--user-id', argv[++i]);
      else if (a === '--api-base') over.apiBase = need('--api-base', argv[++i]);
      else if (a === '--timeout') cfg.timeout = Number(need('--timeout', argv[++i]));
      else if (a === '--dry-run') cfg.dryRun = true;
      else if (a === '--quiet') cfg.quiet = true;
      else if (a.startsWith('--')) throw new Error(`未知选项 ${a}`);
      else rest.push(a);
    }
    if (rest.length !== 1) throw new Error('需要且只需要一个输入（文件路径或 -）');
    if (!Number.isFinite(cfg.timeout) || cfg.timeout <= 0) throw new Error('--timeout 必须是正数');
    if (!fs.existsSync(cfg.cwd) || !fs.statSync(cfg.cwd).isDirectory()) throw new Error(`--cwd 不是存在的目录：${cfg.cwd}`);
    // 缺凭据必须硬失败。挑一个默认 user_id，写进去的取不回来；跳过写入，
    // 用户看到"记下了"而库里什么都没有。两者都是静默失效。
    const c = mem0.resolveConfig(process.env, { ...over, timeout: cfg.timeout });
    if (c.error) throw new Error(c.error);
    Object.assign(cfg, c.cfg);
  } catch (e) {
    process.stderr.write(`${e.message}\n用法：node experience-write.js <entry.json|-> [--dry-run] [--cwd dir] [--user-id id] [--api-base url] [--timeout ms] [--quiet]\n`);
    return Promise.resolve(2);
  }

  let entry;
  try {
    entry = JSON.parse(rest[0] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[0], 'utf8'));
  } catch (e) {
    process.stderr.write(`输入不是合法 JSON：${e.message}\n`);
    return Promise.resolve(2);
  }
  // 一次只收一条。多条候选之间的关系是 Dedup 层的事，而那一层整体延后——
  // 收一个数组等于让调用方以为去重发生过。
  if (Array.isArray(entry)) {
    process.stderr.write('一次只写一条。多条候选之间的去重属 Dedup 层，该层尚未实现\n');
    return Promise.resolve(2);
  }

  const out = { written: false };
  const report = (ok, detail) => {
    out.ok = ok;
    out.detail = detail;
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (!cfg.quiet) {
      process.stderr.write(`${ok ? 'OK  ' : 'FAIL'}  ${detail}\n`);
      if (out.decision) process.stderr.write(`      分支 ${out.decision.branch} → status=${out.decision.status} occurrences=${out.decision.occurrences}\n      ${out.decision.why}\n`);
      if (out.raceCheck) process.stderr.write(`      ${out.raceCheck}\n`);
    }
    return ok ? 0 : 1;
  };

  const problems = validate(entry).concat(redline(entry));
  if (problems.length) {
    out.problems = problems;
    return Promise.resolve(report(false, `形状或红线未通过：${problems.join('；')}`));
  }

  const sc = selfCheck(entry, cfg);
  out.selfCheck = sc;
  if (!sc.ok) return Promise.resolve(report(false, sc.detail));

  return run(entry, cfg, out).then((r) => report(r.ok, r.detail));
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {
  validate, redline, checkMetadataValues, normalizeMetadata, symKey,
  sameKind, pickTarget, decideBranch, applyDecision,
  keyOf, shouldPromoteOnRace, buildSearchRequest, buildAddRequest, selfCheck, main,
  MEM0, TOP_K, INDEX_DELAY_MS, LENSES, HIGH_COST_SIGNALS, LIMITS, SCRIPT_OWNED,
};
