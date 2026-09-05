#!/usr/bin/env node
'use strict';
//
// recall —— `UserPromptSubmit` 上的经验检索与注入。
//
// 这是"下一次相关提问时它自动回到上下文里"那半句的执行者。
//
// **为什么挂 UserPromptSubmit 而不是 SessionStart**：SessionStart 那一刻用户
// 还没提问，检索没有查询词，只能注入全部（= 571 行常驻控制面的云端版）或
// 注入无关内容；而且它一次性触发，会话中途换话题就没有第二次检索。
//
// **为什么校验在注入前做，而不是让 agent 自己去跑**："取回后请先跑
// evidence_cmd 再采信"是一条对 agent 的要求，没有执行者——TRACE 量到的
// 57.5% 就是这个形状。改成注入前的机器动作，agent 想跳过也跳不掉。
//
// 时间账（每一轮用户提示都要付）：
//   检索 ≤ 1,500 ms（网络往返，超时即注入空）
//   校验 ≤ 2,000 ms（assert-replay --mode symbols，整轮一次批量检索）
//   合计最坏 ≈ 3,500 ms
// 校验这条在 DESIGN 的「上下文预算」里；**检索那条是本文件新增的**，
// 改动它必须同时改 DESIGN 里的数字并说明依据。
//
// 失败一律注入空——不能因为经验取不到就挡住用户的提问。代价是"库里没有
// 相关经验"与"检索坏了"看起来一样，缓解手段有两个：配置错误在每个会话
// 里提示一次（见下），连通性由 selfcheck.js --mem0 覆盖。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mem0 = require('../scripts/mem0.js');

const SEARCH_TIMEOUT_MS = 1500;
const VERIFY_BUDGET_MS = 2000;
// 双上限，两条都来自 DESIGN 的「上下文预算」。超出即截断。
const MAX_ENTRIES = 5;
const MAX_TOKENS = 1500;

// 随附的使用约束只有这一句。它不要求 agent 主动做什么，只在冲突发生时给出
// 优先级——**经验是参考，事实只有架构与代码**。
const PREAMBLE = '以下是团队共享的历史经验，仅供参考；与当前代码冲突时一律以代码为准。';

/**
 * token 估算，**不是实测**：CJK 字符按 1 个 token 计，其余按 4 字符 1 个。
 * 用途只是给注入量封顶，估高比估低安全——估高只是少注入一条。
 */
function estimateTokens(s) {
  let cjk = 0;
  for (const ch of s) if (/[　-鿿＀-￯]/.test(ch)) cjk++;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

/** mem0 的响应字段名未经实测，几种常见写法都认；认不出就跳过这一条，不猜。 */
function sentenceOf(hit) {
  for (const k of ['memory', 'text', 'content', 'information']) {
    if (typeof hit[k] === 'string' && hit[k].trim() !== '') return hit[k].trim();
  }
  return null;
}

/**
 * 逐条跑 assert-replay，**只放行判定过且通过的**。
 *
 *   verdict !== 'pass'  → 断言为假，不注入
 *   verified !== true   → 没验过（工具不可用、属于别的仓库、超预算），
 *                         不注入。"没验过"不等于"验证不过"，但在注入路径上
 *                         两者的处置相同：不可采信。
 */
function verified(entries, cwd) {
  const script = path.join(__dirname, '..', 'scripts', 'assert-replay.js');
  const r = spawnSync(process.execPath, [
    // **必须是 symbols，永远不能是 full。** 这条路挂在每一轮用户提示上，
    // 而 evidence_cmd 是共享云库里的一段文本——改成 full 就等于让任何能
    // 写入该库的人，在每个成员的每一轮提示里执行命令。assert-replay 那五道
    // 执行边界存在的全部理由，就是不让这条路成为热路径。
    //
    // 2026-09-04 这一行真的被改成过 full 并推上了远端，而**当时没有任何
    // 用例守着它**——mode 换了，recall.test.js 照样全绿。现在有了。
    script, '-', '--mode', 'symbols', '--cwd', cwd, '--budget', String(VERIFY_BUDGET_MS), '--quiet',
  ], {
    input: entries.map((e) => JSON.stringify(e)).join('\n'),
    encoding: 'utf8',
    timeout: VERIFY_BUDGET_MS + 3000,
    windowsHide: true,
  });
  if (r.error) return { error: `校验没能运行：${r.error.code || r.error.message}` };
  let results;
  try { results = JSON.parse(r.stdout); } catch (_) { return { error: '校验输出无法解析' }; }
  const keep = [];
  results.forEach((res, i) => {
    if (res.verdict === 'pass' && res.verified === true) keep.push(entries[i]);
  });
  return { keep, dropped: results.length - keep.length };
}

function render(entries) {
  const lines = [PREAMBLE];
  let tokens = estimateTokens(PREAMBLE);
  let used = 0;
  for (const e of entries) {
    if (used >= MAX_ENTRIES) break;
    const md = e.metadata || {};
    const where = [md.repo, md.commit].filter(Boolean).join(' @ ');
    const line = `- ${e.information}${where ? `（${where}）` : ''}`;
    const t = estimateTokens(line);
    if (tokens + t > MAX_TOKENS) break;
    lines.push(line);
    tokens += t;
    used++;
  }
  return used === 0 ? null : lines.join('\n');
}

/** 配置错误每个会话只提示一次——每轮都提示会变成噪音，一次都不提示是静默失效。 */
function warnOnce(sessionId, message) {
  const safe = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '');
  const marker = path.join(os.tmpdir(), `experience-recall-${safe}.warned`);
  try {
    if (fs.existsSync(marker)) return null;
    fs.writeFileSync(marker, '');
  } catch (_) { /* 写不了标记就每轮提示，噪音好过静默 */ }
  return message;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { /* 用空输入继续 */ }
  const prompt = String(input.prompt || '').trim();
  const cwd = input.cwd || process.cwd();
  if (prompt === '') return emit({});

  const c = mem0.resolveConfig(process.env, { timeout: SEARCH_TIMEOUT_MS });
  if (c.error) {
    const msg = warnOnce(input.session_id, `经验检索未启用：${c.error}`);
    return emit(msg ? { systemMessage: msg } : {});
  }

  // **只检索 confirmed。** candidate 是"只撞上过一次"，contradicted 暂停召回，
  // retracted 永久排除。这个等值过滤形状是 2026-09-03 实测确认可用的那一个。
  const s = await mem0.search(c.cfg, {
    query: prompt,
    filters: { AND: [{ user_id: c.cfg.userId }, { metadata: { status: 'confirmed' } }] },
    topK: MAX_ENTRIES,
  });
  if (s.error) {
    process.stderr.write(`${s.error}\n`);   // 瞬时故障不打扰用户，--debug 里看得到
    return emit({});
  }

  const entries = [];
  for (const h of s.hits) {
    const sentence = sentenceOf(h);
    if (sentence) entries.push({ id: h.id, information: sentence, metadata: h.metadata || {} });
  }
  if (entries.length === 0) return emit({});

  const v = verified(entries, cwd);
  if (v.error) {
    process.stderr.write(`${v.error}\n`);
    return emit({});
  }
  const text = render(v.keep);
  if (!text) return emit({});

  return emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  });
}

if (require.main === module) {
  main().catch((e) => {
    // 检索出任何意外都不能挡住用户的提问。
    process.stderr.write(`recall 异常：${(e && e.message) || e}\n`);
    emit({});
  });
}

module.exports = { estimateTokens, sentenceOf, verified, render, warnOnce, MAX_ENTRIES, MAX_TOKENS, PREAMBLE, SEARCH_TIMEOUT_MS, VERIFY_BUDGET_MS };
