'use strict';
//
// intent-drift —— 目标一「进入 spec 前确立意图，spec 下所做的变更都不能
// 偏离 spec 的意图」在**提交那一刻**的执行者。
//
// ## 为什么挂提交，不挂编辑
//
// 编辑是过程，提交是结论。一次需求要改几十次文件，在每次 `Edit` 上问
// "偏离了吗"既昂贵又没意义——中间态本来就可能暂时不像原意图。
// **提交是作者自己认为"这一步完成了"的时刻**，也是最后一个改起来还便宜
// 的时刻（`git commit --amend`）。
//
// 靠 `if: "Bash(git commit *)"` 精确到参数，其余 Bash 调用一概不触发。
//
// ## 为什么是提醒，不是拦截（2026-09-04 用户裁定）
//
// 它解决的是"**忘了对照**"，不是"不许偏离"。偏离与否是需要人判断的事，
// 而"是不是把该对照的东西摆到了面前"是机器能保证的事。
//
// 因此本脚本**不做语义判断**，只做三件机器做得好的事：
//   1. 把意图锚里那几问摆出来
//   2. 列出本次实际要提交的文件
//   3. 对「明确不做的」里能机械比对的条目，逐条实际比对并点名
//
// **判断留给读到它的人和模型。** 一个会自己下"偏离/未偏离"结论的脚本，
// 判错时比没有更糟：它会让人以为对照过了。
//
// ## 输出用 systemMessage
//
// 官方文档：`additionalContext` 支持 `PreToolUse` / `UserPromptSubmit` /
// `PostToolBatch` / 两个 `ModelSwitch`；而 `systemMessage` 是通用字段。
// **同一份文档还让 `fact-priority` 栽过一次**——它首版在 `PostToolUse` 上
// 用了 `additionalContext`，那里根本不支持，于是一声不响地什么都不做。
// 这里不重犯：用通用字段。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ANCHOR = 'Intent.md';
// 摘出锚里的两节。标题允许「四、明确不做的」这类带序号的写法。
const SECTION_NOT_DOING = /^#{1,3}\s*[一二三四五六七八九十\d、.]*\s*明确不做的?\s*$/m;
const SECTION_HOW_DRIFT = /^#{1,3}\s*[一二三四五六七八九十\d、.]*\s*怎样算偏离\s*$/m;

const git = (args, cwd) => {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000,
  });
  return r.error || r.status !== 0 ? null : String(r.stdout);
};

/** 取某一节的正文，到下一个同级或更高级标题为止。 */
function sectionBody(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^#{1,3}\s+\S/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/**
 * 条目 = 以 `-` / `*` / `+` / `1.` 开头的行。**只收真正的列表项**——
 * 小节的引导句（"按下面四问检查："）不是判据，混进来会让第 1 问变成一句
 * 答不了的话，人于是学会跳过整段。
 *
 * 空节返回空数组而不是 null：**"这一节是空的"与"没有这一节"是两回事**，
 * 上游要能分开报。
 */
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
function bullets(body) {
  if (!body) return [];
  return body.split('\n')
    .filter((l) => BULLET.test(l) && !/^[-*+]{3,}\s*$/.test(l.trim()))
    .map((l) => l.replace(BULLET, '').trim().replace(/\*\*/g, ''))
    .filter(Boolean);
}

/**
 * 「明确不做的」里能机械比对的那部分。
 *
 * **只认反引号里的东西**——路径、目录、依赖名、标识符。作者写
 * `不引入新的运行时依赖，例如 \`lodash\`` 时，`lodash` 就是可比对的锚。
 *
 * 刻意不做模糊匹配：宁可少点名，不可点错名。一条误报会让人下次直接
 * 忽略整段提醒，而那等于这条 hook 不存在。
 */
function mechanicalTerms(items) {
  const out = [];
  for (const item of items) {
    for (const m of item.matchAll(/`([^`]+)`/g)) {
      const t = m[1].trim();
      // 太短的词（如 `x`）会命中一切，反而制造噪音。
      if (t.length >= 3) out.push({ term: t, from: item });
    }
  }
  return out;
}

/**
 * 逐条比对，命中即点名。**纯函数**——判定逻辑不能藏在读 git、读文件的
 * 那一层里，否则它就只能靠"跑一次看看"来验，而那种用例最容易恒过。
 */
function collisions(terms, files) {
  const hits = [];
  for (const { term, from } of terms) {
    const touched = files.filter((f) => f.includes(term));
    if (touched.length) hits.push(`「${from}」—— 本次改动碰到 ${touched.join('、')}`);
  }
  return hits;
}

/** 本次要提交的文件。取暂存区；`-a` 时补上已跟踪的改动。 */
function stagedFiles(cwd, cmd) {
  const staged = git(['diff', '--cached', '--name-only'], cwd) || '';
  let files = staged.split('\n').map((s) => s.trim()).filter(Boolean);
  if (/\s-[a-zA-Z]*a|--all\b/.test(cmd)) {
    const tracked = git(['diff', '--name-only'], cwd) || '';
    files = [...new Set(files.concat(tracked.split('\n').map((s) => s.trim()).filter(Boolean)))];
  }
  return files;
}

// `git` 的全局选项里，这几个**带一个独立的值**，跳过时要连值一起跳。
const GLOBAL_OPTS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/**
 * 这条命令是不是一次提交。
 *
 * 用分词而不是正则：首版写的是 `git\s+(-[^\s]+\s+)*commit`，它只认单 token
 * 选项，于是 `git -c user.name=a commit` 漏判——**而漏判是静默的**，那次提交
 * 就没有任何提醒，谁也不会发现。
 *
 * 反方向同样要守：`git commitment-scheme` 这类不能误判成提交。
 */
function isCommit(cmd) {
  for (const seg of String(cmd).split(/&&|\|\||;/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    const i = toks.indexOf('git');
    if (i === -1) continue;
    let j = i + 1;
    while (j < toks.length) {
      const t = toks[j];
      if (GLOBAL_OPTS_WITH_VALUE.has(t)) { j += 2; continue; }
      if (t.startsWith('-')) { j += 1; continue; }
      break;
    }
    if (toks[j] === 'commit') return true;
  }
  return false;
}

function build(input) {
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  const cwd = input.cwd || process.cwd();

  // 只管提交。`if` 已经在 harness 侧筛过一道，这里再筛一次——
  // 配置写错时不至于在每条 Bash 上都说话。
  if (!isCommit(cmd)) return null;

  const anchorPath = path.join(cwd, ANCHOR);
  if (!fs.existsSync(anchorPath)) {
    // **锚不存在时说一次，然后闭嘴。** 每次提交都催建文件是噪音；
    // 但一次都不说，目标一就没有任何可见痕迹。
    return `没有找到 ${ANCHOR}——本次提交没有可比对的意图锚。`
      + `若这个仓库需要意图确立，用 intent-lock 建一份；若不需要，忽略本条即可。`;
  }

  let text;
  try { text = fs.readFileSync(anchorPath, 'utf8'); } catch (_) { return null; }

  const notDoing = bullets(sectionBody(text, SECTION_NOT_DOING));
  const howDrift = bullets(sectionBody(text, SECTION_HOW_DRIFT));
  const files = stagedFiles(cwd, cmd);

  const parts = [`提交前对照 ${ANCHOR}（提醒，不阻断）：`];

  // 一、机械比对：明确不做的里那些带反引号的具体名字，本次是否碰到
  const terms = mechanicalTerms(notDoing);
  const hits = collisions(terms, files);
  if (hits.length) {
    parts.push(`⚠ 与「明确不做的」相撞 ${hits.length} 处：\n${hits.map((h) => `  - ${h}`).join('\n')}`);
  } else if (terms.length) {
    parts.push(`「明确不做的」里 ${terms.length} 个可机械比对的条目，本次改动均未触及。`);
  } else if (notDoing.length) {
    // 有条目但一个反引号都没有 → 比对不了，如实说，不要假装查过。
    parts.push(`「明确不做的」有 ${notDoing.length} 条，但**没有可机械比对的条目**（写成反引号里的路径或依赖名才能比对），下面几问请人工过一遍。`);
  }

  // 二、把判据摆出来。**这是本条提醒的主体**——机械比对覆盖不了的部分由它兜。
  if (howDrift.length) {
    parts.push(`本次改动 ${files.length} 个文件。逐问回答：\n${howDrift.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}`);
  } else {
    parts.push(`${ANCHOR} 里没有「怎样算偏离」一节——补上它，这份锚才判得出东西。`);
  }

  parts.push('任何一问答不上，就是偏离：改回去，或明说这是一次意图变更并改锚。**不要悄悄改锚去迁就改动。**');
  return parts.join('\n');
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return emit({}); }
  const msg = build(input);
  return emit(msg ? { systemMessage: msg } : {});
}

if (require.main === module) {
  try { main(); } catch (e) {
    // 提交绝不能因为这条提醒而失败。
    process.stderr.write(`intent-drift 异常：${(e && e.message) || e}\n`);
    emit({});
  }
}

module.exports = { build, isCommit, sectionBody, bullets, mechanicalTerms, collisions, stagedFiles, ANCHOR, SECTION_NOT_DOING, SECTION_HOW_DRIFT };
