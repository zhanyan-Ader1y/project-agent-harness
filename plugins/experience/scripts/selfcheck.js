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
    const entry = cfg.hooks && cfg.hooks.PreToolUse && cfg.hooks.PreToolUse[0];
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
      const N = 20;
      const syms = Array.from({ length: N }, (_, i) => `ZzSelfcheckAbsentSymbol${i}`);
      const t0 = Date.now();
      const r = M.checkSymbols({ metadata: { symbols: syms } }, { cwd: CWD, timeout: 20000, allow: new Set(), mode: 'symbols' });
      const ms = Date.now() - t0;
      const detail = `${N} 个符号 / ${ms}ms（约 ${Math.round(ms / N)}ms 每个）  仓库：${CWD}`;
      if (r.status === 'error') fail('符号检索可用', `${detail}\n        ${r.detail}`);
      else if (ms > 2000) fail('单条 20 符号 ≤ 2000ms 预算', `${detail}\n        超出注入路径的总延迟预算——按此估算，每轮 5 条会严重超支`);
      else if (ms > 1000) warn('接近预算上限', detail);
      else pass('符号检索耗时', detail);
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
