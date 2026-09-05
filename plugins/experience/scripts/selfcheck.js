#!/usr/bin/env node
'use strict';
//
// selfcheck —— 装到你的项目之后，用它确认这个插件在**你的环境里**真的在工作。
//
// 为什么需要它：本插件的强制点全部是静默失效型的。deny 闸门在 node 不在
// PATH 时会放行且不留痕；符号检索在只有 grep 的机器上慢几倍；MCP 连不上时
// 检索静默为空。**这些失效你在正常使用中看不见**——你会以为闸门在、经验在，
// 实际都不在。
//
// 用法：
//   node plugins/experience/scripts/selfcheck.js [--cwd <你的仓库>] [--mem0]
//     --mem0   额外探测云端 mem0 端点（需要 MEM0_API_KEY 环境变量）
//
// 退出码：0 = 全部通过；1 = 有项未通过。
//
// 输出是给人看的，也是给我看的——出问题时整段贴回来即可。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const cwdIdx = argv.indexOf('--cwd');
const CWD = cwdIdx !== -1 && argv[cwdIdx + 1] ? argv[cwdIdx + 1] : process.cwd();
const WITH_MEM0 = argv.includes('--mem0');

let failed = 0;
const line = (mark, name, detail) => console.log(`  ${mark}  ${name}${detail ? `\n        ${detail}` : ''}`);
const pass = (n, d) => line('ok  ', n, d);
const fail = (n, d) => { failed++; line('FAIL', n, d); };
const warn = (n, d) => line('warn', n, d);
const head = (s) => console.log(`\n${s}`);

// ---------------------------------------------------------------------------
head('运行环境');

pass('Node', `${process.version}  ${process.platform}/${process.arch}`);

{
  // deny 闸门靠 `node "<path>"` 启动。路径含空格、node 不在 PATH，都会让它
  // 起不来——而起不来的后果是闸门放行。
  const r = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.error || r.status !== 0) {
    fail('`node` 在 PATH 中', `闸门靠它启动，起不来即放行。错误：${r.error ? r.error.code : `退出码 ${r.status}`}`);
  } else {
    pass('`node` 在 PATH 中', String(r.stdout).trim());
  }
}

if (/\s/.test(PLUGIN_ROOT)) {
  warn('插件路径含空格', `${PLUGIN_ROOT}\n        hooks.json 已用双引号包路径，但若你自行改过命令，空格会让它断开`);
} else {
  pass('插件路径无空格');
}

// ---------------------------------------------------------------------------
head('闸门：拦截对 mem0 写入与删除工具的直接调用');

{
  const hooksPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(hooksPath, 'utf8')); } catch (e) {
    fail('hooks.json 可解析', e.message);
  }

  if (cfg) {
    // 按内容定位——同一事件下新增 hook 时，按下标会取到另一条。
    const entry = cfg.hooks && cfg.hooks.PreToolUse
      && cfg.hooks.PreToolUse.find((e) => /mcp__plugin_experience_mem0__/.test(e.matcher || ''));
    const matcher = entry && entry.matcher;

    // matcher 有两个静默失效点：插件的 MCP 工具名带 plugin 前缀；
    // 只含字母数字与 _ - , | 的匹配值按精确字符串比较，一个工具也匹配不到。
    const matches = (m, tool) => {
      if (m === undefined || m === '' || m === '*') return true;
      if (/^[A-Za-z0-9_\-, |]+$/.test(m)) return m.split(/[|,]/).map((s) => s.trim()).filter(Boolean).includes(tool);
      return new RegExp(m).test(tool);
    };
    const mustHit = ['add_memory', 'update_memory', 'delete_memory', 'delete_all_memories', 'delete_entities'];
    const mustPass = ['search_memories', 'get_memories'];
    const pre = 'mcp__plugin_experience_mem0__';
    const missed = mustHit.filter((t) => !matches(matcher, pre + t));
    const wrong = mustPass.filter((t) => matches(matcher, pre + t));

    if (missed.length) fail('matcher 命中全部写入与删除工具', `漏掉：${missed.join(', ')}\n        matcher = ${matcher}`);
    else if (wrong.length) fail('matcher 不误伤检索类工具', `误伤：${wrong.join(', ')}`);
    else pass('matcher 覆盖正确', matcher);

    // 命令实跑——闸门真正的证明。分别在可用与不可用两种解释器下跑。
    const raw = entry && entry.hooks && entry.hooks[0] && entry.hooks[0].command;
    if (!raw) {
      fail('hooks.json 里有 command');
    } else {
      const cmd = raw.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN_ROOT);
      const runIn = (c) => (process.platform === 'win32'
        ? spawnSync('cmd', ['/c', c], { encoding: 'utf8', windowsHide: true, timeout: 20000, windowsVerbatimArguments: true })
        : spawnSync('sh', ['-c', c], { encoding: 'utf8', windowsHide: true, timeout: 20000 }));

      const r = runIn(cmd);
      let decision = null;
      try { decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch (_) { /* 下面报 */ }
      if (decision === 'deny') pass('闸门命令实跑输出 deny 决策');
      else fail('闸门命令实跑输出 deny 决策', `stdout=${JSON.stringify(String(r.stdout).slice(0, 120))}\n        stderr=${String(r.stderr).trim().slice(0, 120)}`);

      // fail-open 检查：把解释器换成不存在的程序，命令仍须以 exit 2 结束。
      // PreToolUse 只有 exit 2 才阻断——其余非零算非阻断错误，工具照常执行。
      const broken = cmd.replace(/^node\b/, 'zz-no-such-interpreter-qq');
      const b = runIn(broken);
      if (b.status === 2) pass('解释器缺失时仍然阻断（exit 2）');
      else fail('解释器缺失时仍然阻断（exit 2）', `实得退出码 ${b.status}——闸门会在这种环境下静默放行`);
    }
  }
}

// ---------------------------------------------------------------------------
head('符号检索：注入前校验靠它');

{
  const backends = [
    ['rg', ['--version']],
    ['grep', ['--version']],
  ];
  const available = [];
  for (const [prog, args] of backends) {
    const r = spawnSync(prog, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (!r.error && r.status === 0) available.push(prog);
  }
  if (available.length === 0) {
    fail('rg 或 grep 至少有一个可用', '两者都没有 → 符号存在性检查一律判"无法判定"，注入前校验会拒掉每一条经验');
  } else if (!available.includes('rg')) {
    warn('只有 grep 可用', 'grep 比 rg 慢数倍，下面的耗时会直接反映这一点');
    pass('检索后端', available.join(', '));
  } else {
    pass('检索后端', available.join(', '));
  }

  if (available.length) {
    // 实测耗时——注入前校验挂在每一轮用户提示上，这个数字决定它能不能用。
    let M = null;
    try { M = require(path.join(__dirname, 'assert-replay.js')); } catch (e) { fail('assert-replay.js 可加载', e.message); }
    if (M) {
      // 量的必须是**真实跑的那条路**：整轮一次的批量检索（5 条 × 20 符号
      // = 100 个）。量逐符号的老路会给出一个与实际无关的数字。
      const N = 100;
      const syms = Array.from({ length: N }, (_, i) => `ZzSelfcheckAbsentSymbol${i}`);
      const o = { cwd: CWD, timeout: 20000, allow: new Set(), mode: 'symbols' };
      const t0 = Date.now();
      const r = M.repoHasIdentifiers(syms, o);
      const ms = Date.now() - t0;
      const detail = `每轮最坏 ${N} 个符号（5 条 × 20）/ ${ms}ms  仓库：${CWD}`;
      if (r.undetermined) fail('符号检索可用', `${detail}\n        ${r.undetermined}`);
      else if (ms > 2000) fail('整轮符号检索 ≤ 2000ms 预算', `${detail}\n        超出注入前校验的总延迟预算，每轮提示都会付这笔钱`);
      else if (ms > 1000) warn('接近预算上限', detail);
      else pass('符号检索耗时', detail);

      // 对照：批量比逐个快多少，取决于仓库规模。打出来供人判断这台机器
      // 上的账是否成立——它也是"批量真的接进主路径了"的一个旁证。
      const t1 = Date.now();
      for (let i = 0; i < 10; i++) M.repoHasIdentifier(syms[i], o);
      const per = (Date.now() - t1) / 10;
      pass('批量 vs 逐个', `逐个约 ${Math.round(per)}ms/个 → ${N} 个需约 ${Math.round(per * N)}ms；批量实测 ${ms}ms`);
    }
  }
}

// ---------------------------------------------------------------------------
head('assert-replay：证据重跑与形状兼容');

{
  let M = null;
  try { M = require(path.join(__dirname, 'assert-replay.js')); } catch (_) { /* 上面已报 */ }
  if (M) {
    const o = { cwd: CWD, timeout: 20000, allow: new Set(), mode: 'full' };

    const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: CWD, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (inRepo.error || inRepo.status !== 0) {
      warn('--cwd 不是 git 仓库', `${CWD}\n        跨仓库跳过判定与 git 类证据命令都无法工作`);
    } else {
      const r = M.checkCommand({
        metadata: { evidence_cmd: 'git rev-parse --is-inside-work-tree', evidence_exit: '0', evidence_contains: 'true' },
      }, o);
      if (r.status === 'pass') pass('重跑一条内建证据命令');
      else fail('重跑一条内建证据命令', `${r.status}：${r.detail}`);
    }

    // mem0 把 metadata 序列化成字符串键值：数字变字符串、单元素数组降级、
    // 嵌套对象扁平化。读取端必须认得往返之后的形状。
    const rt = M.readDigest({ evidence_exit: '0', evidence_contains: 'true' });
    if (rt.exit === 0 && rt.contains.length === 1) pass('认得 mem0 往返后的 metadata 形状');
    else fail('认得 mem0 往返后的 metadata 形状', JSON.stringify(rt));

    const flat = M.readDigest({ evidence_digest: ['exit.0', 'contains.true'] });
    if (flat.invalid) pass('扁平化后的旧形状被判为无法解析，不静默当作"没声称"');
    else fail('扁平化后的旧形状被判为无法解析', JSON.stringify(flat));

    // 执行边界：来自共享库的命令不得越界。
    const hostile = ['cat ~/.ssh/id_rsa', 'git ls-remote --upload-pack=/tmp/x .', '/tmp/fakebin/git'];
    const leaked = hostile.filter((c) => M.vetCommand(c, o).ok);
    if (leaked.length) fail('执行边界拦住越界命令', `放行了：${leaked.join(' | ')}`);
    else pass('执行边界拦住越界命令', `${hostile.length} 条样例全部拒绝`);
  }
}

// ---------------------------------------------------------------------------
head('配置：两个值必须由你的项目自己给');

{
  // 本插件不预设默认值——默认 scope 会让两个不相干的团队共用同一个库。
  // 缺任何一个，整条经验链路都不工作，而**表现是"没有相关经验"**。
  const uid = process.env.MEM0_USER_ID || '';
  const key = process.env.MEM0_API_KEY || '';
  if (uid.trim()) pass('MEM0_USER_ID 已设置', `scope = ${uid}（团队里所有人必须是同一个值）`);
  else fail('MEM0_USER_ID 已设置', '放 .claude/settings.json 的 env，它不是凭据，该进版本库');
  if (key.trim()) pass('MEM0_API_KEY 已设置', `${key.slice(0, 4)}…（长度 ${key.length}）`);
  else fail('MEM0_API_KEY 已设置', '放 .claude/settings.local.json 的 env 或密钥库，不进版本库');
}

// ---------------------------------------------------------------------------
head("检索、写入与读时约束：三条链路真的跑得起来");

{
  // 检索挂在每一轮用户提示上。它必须**永远**输出可解析的 JSON 并以 0 退出——
  // UserPromptSubmit 上非 0 的退出码会挡住用户提问，"取不到经验"绝不能升级
  // 成"不许提问"。这里连输入都给它一段非 JSON，仍然要求它规矩地退出。
  const hook = path.join(PLUGIN_ROOT, 'hooks', 'recall.js');
  const r = spawnSync(process.execPath, [hook], {
    input: 'not json at all', encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, MEM0_USER_ID: '', MEM0_API_KEY: '' },
  });
  let okJson = false;
  try { JSON.parse(r.stdout); okJson = true; } catch (_) { /* 下面报 */ }
  if (r.status === 0 && okJson) pass('检索 hook 在最坏输入下仍规矩退出', '输出可解析、退出码 0，不会挡住提问');
  else fail('检索 hook 在最坏输入下仍规矩退出', `code=${r.status} stdout=${String(r.stdout).slice(0, 80)}`);

  // 目标四在"读的那一刻"的执行者。它也是静默失效型：node 不在 PATH 时
  // 什么都不注入，而"没有注入"与"这份文档不需要降级"看起来完全一样。
  const fp = path.join(PLUGIN_ROOT, 'hooks', 'fact-priority.js');
  const fpr = spawnSync(process.execPath, [fp], {
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'docs/architecture/x.md' } }),
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  let fpj = null;
  try { fpj = JSON.parse(fpr.stdout); } catch (_) { /* 下面报 */ }
  if (fpr.status === 0 && fpj && /以代码为准/.test(fpj.systemMessage || '')) {
    pass('读到架构描述时会注入优先级约束', '描述类 / spec / ADR 三类各有说法');
  } else {
    fail('读到架构描述时会注入优先级约束', `code=${fpr.status} out=${String(fpr.stdout).slice(0, 80)}`);
  }

  // 写入必须硬失败。这里故意送一条自带 status 的条目——它绕过的正是
  // "必须撞上第二次才进检索"那道闸门，脚本必须拒绝且什么都不写。
  const write = path.join(PLUGIN_ROOT, 'scripts', 'experience-write.js');
  const bad = JSON.stringify({
    information: 'x',
    metadata: { repo: 'r', commit: 'c', author: 'a', at: '2026-01-01', lens: 'logic', symbols: ['Zz'], status: 'confirmed' },
  });
  const w = spawnSync(process.execPath, [write, '-', '--quiet', '--cwd', CWD], {
    input: bad, encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, MEM0_USER_ID: 'selfcheck', MEM0_API_KEY: 'selfcheck' },
  });
  let out = null;
  try { out = JSON.parse(w.stdout); } catch (_) { /* 下面报 */ }
  if (w.status === 1 && out && out.written === false && /status/.test(out.detail || '')) {
    pass('写入通道拒绝自带 status 的条目', '退出码 1，且明说库里什么都没多');
  } else {
    fail('写入通道拒绝自带 status 的条目', `code=${w.status} ${String(w.stdout).slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------------------
head('mem0 连通性');

if (!WITH_MEM0) {
  console.log('  skip  未加 --mem0，跳过（需要 MEM0_API_KEY）');
} else if (!process.env.MEM0_API_KEY) {
  fail('MEM0_API_KEY 已设置', '加了 --mem0 但环境变量为空');
} else {
  let url = null;
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.mcp.json'), 'utf8'));
    url = mcp.mcpServers && mcp.mcpServers.mem0 && mcp.mcpServers.mem0.url;
    if (url) pass('.mcp.json 里的端点', url);
    else fail('.mcp.json 里有 mem0 端点');
  } catch (e) { fail('.mcp.json 可解析', e.message); }

  if (url) {
    (async () => {
      // ---- 一、MCP 那一侧：工具名必须与 deny hook 的 matcher 对得上 ----
      try {
        const r = await fetch(url.endsWith('/') ? url : `${url}/`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.MEM0_API_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
        const text = await r.text();
        const names = [...text.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
        if (r.status === 401) fail('mem0 认证', 'HTTP 401——key 无效或已轮换');
        else if (!r.ok) fail('mem0 可达', `HTTP ${r.status}`);
        else if (!names.includes('add_memory')) fail('工具名与 matcher 一致', `实得：${names.join(', ') || '(解析不出)'}\n        matcher 假定写入工具名为 add_memory`);
        else pass('mem0 可达且工具名一致', `${names.length} 个工具`);
      } catch (e) {
        fail('mem0 可达', e.message);
      }

      // ---- 二、REST 那一侧：写入与检索真正走的路 ----
      //
      // **这一段是 2026-09-04 补的，补之前上面那半段是唯一的探活。**
      // 而写入脚本与检索 hook 一条都不走 MCP，它们走 api.mem0.ai 的 REST。
      // 于是三个文件里"验证手段是 selfcheck --mem0"那句话指向了一个
      // 根本不验证 REST 的检查——**声称有执行者而执行者不在那一层**。
      //
      // 只发只读检索，**绝不写**：拿别人的库做探活不能留下痕迹。
      const mem0 = require(path.join(__dirname, 'mem0.js'));
      const uid = process.env.MEM0_USER_ID || '';
      if (!uid.trim()) {
        fail('REST 契约可验证', '缺 MEM0_USER_ID，检索需要它作 scope');
      } else {
        // 鉴权头形状本身就是待验的东西之一，所以两种都试，报告哪种成立。
        const schemes = [['Token', (k) => `Token ${k}`], ['Bearer', (k) => `Bearer ${k}`]];
        let done = false;
        for (const [label, make] of schemes) {
          if (done) break;
          const target = `${mem0.MEM0.base}${mem0.MEM0.searchPath}`;
          try {
            const r = await fetch(target, {
              method: 'POST',
              headers: { Authorization: make(process.env.MEM0_API_KEY), 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: 'selfcheck probe', filters: { AND: [{ user_id: uid }] }, top_k: 1 }),
            });
            const body = await r.text();
            if (r.status === 401 || r.status === 403) continue;   // 换一种鉴权头再试
            if (r.status === 404) {
              fail('REST 检索路径正确', `${target} → HTTP 404，路径不对（这条契约本就未经实测）`);
              done = true;
              break;
            }
            if (!r.ok) {
              fail('REST 检索可用', `${target} → HTTP ${r.status}：${body.slice(0, 160)}`);
              done = true;
              break;
            }
            let json = null;
            try { json = JSON.parse(body); } catch (_) { /* 下面报 */ }
            const container = Array.isArray(json) ? '顶层数组'
              : (json && Array.isArray(json.results)) ? 'results'
                : (json && Array.isArray(json.memories)) ? 'memories' : null;
            if (!container) {
              fail('REST 响应形状认得出', `实得：${body.slice(0, 160)}\n        mem0.js 的 hitsOf 认三种：顶层数组 / results / memories`);
            } else {
              pass('REST 检索路径与鉴权头已实测',
                `${mem0.MEM0.searchPath}  鉴权头 "${label} <key>"  响应容器：${container}`);
              if (label !== 'Token') {
                fail('mem0.js 的 authHeader 与实测一致',
                  `实测成立的是 "${label}"，而 mem0.js 里写的是 "Token"——**写入与检索都会 401**`);
              }
            }
            done = true;
          } catch (e) {
            fail('REST 可达', `${target}：${e.message}`);
            done = true;
          }
        }
        if (!done) fail('REST 鉴权', 'Token 与 Bearer 两种鉴权头都被拒（401/403）——key 无效，或该 key 没有 REST 权限');
      }

      // 写入路径**不探活**：往使用者的共享库里塞一条探针经验，等于用自检
      // 污染真实数据。REST 的 add 路径只能等第一条真经验去验。
      warn('REST 写入路径未探活', `${mem0.MEM0.addPath} 只能由第一次真实写入来验证——自检不往你的库里写东西`);
      finish();
    })();
    return;
  }
}

finish();

function finish() {
  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项未通过`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
