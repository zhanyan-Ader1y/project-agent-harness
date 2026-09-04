#!/usr/bin/env node
'use strict';
// eval 种子用例 3：experience-write 的准入判定。
//
// 这个脚本是经验入库的唯一通道——hook 拒绝 agent 裸调用 mem0 的写入工具，
// 所有把关都落在这里。三组最要紧：
//
//   1. **调用方不得自带 status/occurrences**——自带等于产出经验的 agent 直接
//      把自己的经验标成 confirmed，甲分支的闸门形同虚设，而 hook 拦不到
//      （它拦的是 mcp 工具调用，不是脚本参数）。
//   2. **同型判定不做传递闭包**——桥接式归并一旦发生，边界信息永久丢失。
//   3. **并发 tie-break 恰好一方晋级**——两边都晋级会写出两条内容相同的
//      confirmed，两边都不晋级则永不晋级，正是候选池存在的理由被架空。
//
// 网络那一段（REST 路径、鉴权头形状）**没有用例**：本机没有可用的 key，
// 对活端点验证的手段是 selfcheck.js --mem0，由消费方拿自己的 key 跑。
// 这里只测不需要网络的部分，并如实标出边界。
//
// 用法：node evals/experience-write.test.js   （失败时退出码非 0）

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const W = require('../plugins/experience/scripts/experience-write.js');

const REPO = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'repo');
const SCRIPT = path.join(REPO, 'plugins', 'experience', 'scripts', 'experience-write.js');

let failures = 0;
const g = (name) => console.log(`\n${name}`);
const ok = (cond, label, extra) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
};

// 一条形状完全合法的条目，各用例只改动它关心的那一处。
const base = (md = {}) => ({
  information: '在 ZzWidget 上直接改 list 会绕过刷新，必须调 attachToList',
  metadata: {
    repo: 'repo-fixture',
    commit: 'abc1234',
    author: 'someone',
    at: '2026-09-04',
    lens: 'logic',
    symbols: ['ZzWidget.attachToList'],
    ...md,
  },
});
const problemsOf = (e) => W.validate(e).concat(W.redline(e));
const rejects = (md, label, needle) => {
  const p = problemsOf(base(md));
  ok(p.length > 0 && (!needle || p.some((x) => x.includes(needle))), label, p.join('；') || '竟然放行');
};

// ---------------------------------------------------------------------------
g('形状：合法条目必须放行（否则下面的拒绝用例证明不了任何事）');
ok(problemsOf(base()).length === 0, '基准条目通过', problemsOf(base()).join('；'));

// ---------------------------------------------------------------------------
g('调用方不得自带本脚本的产出字段');
// 这是甲分支闸门的实际执行点。允许自带 status，agent 写一条 confirmed 就
// 直接进检索，"必须撞上第二次"整条规则就没有执行者了。
for (const k of W.SCRIPT_OWNED) {
  rejects({ [k]: k === 'status' ? 'confirmed' : '9' }, `自带 ${k} 被拒`, k);
}

// ---------------------------------------------------------------------------
g('形状：必填与上限');
rejects({ lens: 'vibes' }, 'lens 不在三镜头枚举内被拒', 'lens');
rejects({ lens: undefined }, '缺 lens 被拒', 'lens');
for (const k of ['repo', 'commit', 'author', 'at']) rejects({ [k]: '' }, `缺 ${k} 被拒`, k);
{
  const p = problemsOf({ information: '', metadata: base().metadata });
  ok(p.some((x) => x.includes('information')), '缺 information 被拒', p.join('；'));
}
rejects({ symbols: undefined }, 'files 与 symbols 皆空被拒——注入前没有任何可验证的指针', 'files 与 symbols');
rejects({ symbols: Array.from({ length: W.LIMITS.symbols + 1 }, (_, i) => `S${i}`) }, `symbols 超 ${W.LIMITS.symbols} 被拒`, 'symbols');
for (const bad of ['/etc/passwd', 'C:\\Windows\\win.ini', '../outside.txt', '~/.ssh/id_rsa']) {
  rejects({ files: ['a.js', bad] }, `files 含 ${bad} 被拒`, '仓库相对路径');
}

// ---------------------------------------------------------------------------
g('metadata 只收字符串与多元素字符串数组');
// mem0 的 metadata 是字符串键值模型：数字变字符串、单元素数组降级成标量、
// 嵌套对象被扁平化。放行一个数字，取回来 "0" !== 0，这条经验此后每次校验
// 都判失败——而失败正是淘汰的对象。写入时报错好过入库后慢性失效。
rejects({ evidence_exit: 128 }, '数字被拒', 'evidence_exit');
rejects({ evidence_digest: { exit: 0 } }, '嵌套对象被拒（会被扁平化，不可还原）', 'evidence_digest');
ok(W.checkMetadataValues({ a: 'x', b: ['p', 'q'] }).length === 0, '字符串与字符串数组放行');
{
  // **单元素数组不能拒。** 一条经验只提到一个符号是最常见的形态——早先版本
  // 按"只用多元素数组"拒了它，等于拒绝大多数经验；是本用例先抓到的。
  ok(W.checkMetadataValues({ symbols: ['only-one'] }).length === 0, '单元素数组放行');
  const n = W.normalizeMetadata({ symbols: ['one'], files: ['a', 'b'], empty: [], blank: '  ' });
  ok(n.symbols === 'one', '写入前就降级成标量——与它取回来时的形状一致', JSON.stringify(n));
  ok(Array.isArray(n.files) && n.files.length === 2, '多元素数组保持数组');
  ok(!('empty' in n) && !('blank' in n), '空数组与空串整个去掉');
}

// ---------------------------------------------------------------------------
g('乙分支：闸门是锚，不是次数');
rejects({ high_cost: 'corrected' }, '声称高代价却没有锚 → 被拒，退回走甲分支', 'high_cost_anchor');
rejects({ high_cost: 'because-i-said-so', high_cost_anchor: 'x' }, '不在五条信号枚举内被拒', 'high_cost');
rejects({ high_cost_anchor: 'x' }, '有锚没信号被拒——说不清它锚的是哪条', 'high_cost');
ok(problemsOf(base({ high_cost: 'corrected', high_cost_anchor: '用户原话：不要再用 sleep' })).length === 0,
  '信号 + 锚齐备 → 放行');

// ---------------------------------------------------------------------------
g('红线：evidence_output 不落原文');
rejects({ evidence_output: 'DB_PASSWORD=hunter2\n...' }, '整段命令输出被拒', 'evidence_output');

// ---------------------------------------------------------------------------
g('同型判定：语义锁由 mem0 出，结构锁在这里');
const hit = (md) => ({ id: 'h', metadata: { repo: 'repo-fixture', status: 'candidate', ...md } });
ok(W.sameKind(base(), hit({ symbols: ['ZzWidget.attachToList()'], repo: '别的仓库' })) === true,
  'symbols 交集非空 → 同型，且跨仓库也成立（限定名重名概率低，可单独成锚）');
ok(W.sameKind(base(), hit({ symbols: ['Other.attachToList'] })) === false,
  '**只有末段同名不算同型**——取末段比较会让 Foo.get 与 Bar.get 判同型，那是 README.md 那座桥换了个位置');
ok(W.symKey('Foo::Bar<T>') === 'Foo::Bar' && W.symKey('a.b()') === 'a.b',
  '比较键只剥调用与泛型的装饰，限定符保留');
ok(W.sameKind(base({ symbols: undefined, files: ['src/widget.js'] }), hit({ files: ['src/widget.js'] })) === true,
  'repo 相同 + files 交集非空 → 同型');
ok(W.sameKind(base({ symbols: undefined, files: ['README.md'] }), hit({ repo: '别的仓库', files: ['README.md'] })) === false,
  'repo 不同时 files 交集不算数——README.md 在任何仓库都有，单独当锚它就是桥');
ok(W.sameKind(base({ repo: 'Repo-Fixture', symbols: undefined, files: ['a.js'] }), hit({ files: ['a.js'] })) === true,
  'repo 比较不分大小写');
ok(W.sameKind(base({ symbols: ['ZzUnique'] }), hit({ symbols: ['ZzOther'], files: ['x.js'] })) === false,
  '两把锁都合不上 → 不同型');

{
  // ★ 反桥接：A 与 B 靠 symbols 相连，B 与 C 靠 files 相连，**A 与 C 必须不同型**。
  // 一旦桥接式归并发生，边界信息永久丢失且不可恢复。本脚本不做传递闭包，
  // 只判「新候选 vs 每条召回结果」的直接关系——这条用例守的就是那个"只"字。
  const A = base({ symbols: ['ZzAlpha'], files: ['a.js'] });
  const B = hit({ symbols: ['ZzAlpha'], files: ['b.js'] });
  const C = hit({ symbols: ['ZzGamma'], files: ['b.js'] });
  ok(W.sameKind(A, B) === true, 'A~B 成立（symbols）');
  ok(W.sameKind({ metadata: B.metadata }, C) === true, 'B~C 成立（repo + files）');
  ok(W.sameKind(A, C) === false, '★ A~C 不成立——不做传递闭包，桥接式归并在结构上不可能发生');
}

// ---------------------------------------------------------------------------
g('pickTarget：只取召回排名最前的一条，且跳过不可参与的状态');
{
  const A = base({ symbols: ['ZzAlpha'] });
  const first = { id: 'first', metadata: { repo: 'repo-fixture', status: 'candidate', symbols: ['ZzAlpha'] } };
  const second = { id: 'second', metadata: { repo: 'repo-fixture', status: 'confirmed', symbols: ['ZzAlpha'] } };
  ok(W.pickTarget(A, [first, second]).id === 'first', '多条同型时取排名最前的一条，其余不动');
  ok(W.pickTarget(A, [{ id: 'r', metadata: { status: 'retracted', symbols: ['ZzAlpha'] } }, second]).id === 'second',
    'retracted 不参与晋级（人工撤回过的不该被复活）');
  ok(W.pickTarget(A, [{ id: 'c', metadata: { status: 'contradicted', symbols: ['ZzAlpha'] } }]) === null,
    'contradicted 不参与晋级');
  ok(W.pickTarget(A, []) === null, '空库 → 没有目标');
  const far = Array.from({ length: W.TOP_K }, (_, i) => ({ id: `x${i}`, metadata: { symbols: ['ZzNothing'] } }))
    .concat([{ id: 'beyond', metadata: { repo: 'repo-fixture', symbols: ['ZzAlpha'] } }]);
  ok(W.pickTarget(A, far) === null, `只看召回前 ${W.TOP_K} 条——第 ${W.TOP_K + 1} 条即便同型也不参与`);
}

// ---------------------------------------------------------------------------
g('分支判定：三条路各自的产出');
{
  const A = base({ symbols: ['ZzAlpha'] });
  const target = { id: 'old', metadata: { repo: 'repo-fixture', status: 'candidate', occurrences: '3', symbols: ['ZzAlpha'] } };
  const d1 = W.decideBranch(A, [target]);
  ok(d1.branch === '甲' && d1.status === 'confirmed' && d1.occurrences === '4' && d1.promoted_from === 'old',
    '甲：晋级为 confirmed，occurrences 取老值 +1，promoted_from 指向老候选', JSON.stringify(d1));

  const d2 = W.decideBranch(base({ high_cost: 'corrected', high_cost_anchor: '原话' }), []);
  ok(d2.branch === '乙' && d2.status === 'confirmed' && d2.occurrences === '1',
    '乙：一次入检索——写 candidate 等于乙分支不存在', JSON.stringify(d2));

  const d3 = W.decideBranch(A, []);
  ok(d3.branch === '首次' && d3.status === 'candidate',
    '首次：存候选，不进入检索', JSON.stringify(d3));

  const applied = W.applyDecision(A, d1);
  ok(applied.metadata.status === 'confirmed' && A.metadata.status === undefined,
    'applyDecision 不改动入参（入参还要用于并发复查）');
}

// ---------------------------------------------------------------------------
g('并发 tie-break：恰好一方晋级');
{
  // 双方看到的是同一对 (at, author)，因此结论必须相反。两边都晋级会写出两条
  // 内容相同的 confirmed；两边都不晋级则永不晋级——候选池存在的理由被架空。
  const a = { metadata: { at: '2026-09-04T10:00:00Z', author: 'ann' } };
  const b = { metadata: { at: '2026-09-04T10:00:01Z', author: 'bob' } };
  ok(W.shouldPromoteOnRace(a, b) !== W.shouldPromoteOnRace(b, a), '恰好一方晋级');
  ok(W.shouldPromoteOnRace(b, a) === true, '(at, author) 字典序在后的那条负责晋级');
  const same = { metadata: { at: a.metadata.at, author: 'ann' } };
  ok(W.shouldPromoteOnRace(a, same) === false && W.shouldPromoteOnRace(same, a) === false,
    '两条键完全相同时都不晋级——宁可漏一次晋级，不可写出两条 confirmed');
}

// ---------------------------------------------------------------------------
g('请求体：infer 必须为 false');
{
  const cfg = { apiBase: 'https://api.example', userId: 'team-x' };
  const add = W.buildAddRequest(base({ symbols: ['ZzAlpha'] }), cfg);
  ok(add.body.infer === false, 'infer:false —— 跳过服务端整合，occurrences 与 status 不会被吃掉');
  ok(add.body.user_id === 'team-x', 'user_id 来自配置，脚本不预设默认值');
  ok(add.body.metadata.symbols === 'ZzAlpha', 'metadata 带上，且已降级成取回来时的形状');
  const se = W.buildSearchRequest(base(), cfg);
  ok(se.body.top_k === W.TOP_K, `检索取前 ${W.TOP_K} 条`);
  ok(JSON.stringify(se.body.filters) === JSON.stringify({ AND: [{ user_id: 'team-x' }] }),
    '只按 user_id 过滤——status 的 OR 过滤形状没验过，宁可取回来在本地筛', JSON.stringify(se.body.filters));
}

// ---------------------------------------------------------------------------
g('写入前自检：真的把 evidence 跑一遍');
{
  // 自检用 --mode full（命令是作者自己写的、在他自己机器上跑）。注入前校验
  // 走 --mode symbols，一个命令都不执行——两条路的威胁模型不同。
  const real = { information: 'x', metadata: { repo: 'project-agent-harness', symbols: ['ZzWidget'] } };
  const fake = { information: 'x', metadata: { repo: 'project-agent-harness', symbols: ['ZzFabricatedQq'] } };
  ok(W.selfCheck(real, { cwd: FIXTURE }).ok === true, '符号真的存在 → 自检通过');
  const r = W.selfCheck(fake, { cwd: FIXTURE });
  ok(r.ok === false && /ZzFabricatedQq/.test(r.detail), '编造的符号 → 自检不通过，写入被拦在网络之前', r.detail);
}

// ---------------------------------------------------------------------------
g('CLI 契约：缺配置与判定失败都必须硬失败');
const cli = (args, stdin, env) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO, encoding: 'utf8', input: stdin, timeout: 60000,
    env: { ...process.env, MEM0_API_KEY: 'dummy', MEM0_USER_ID: 'team-x', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};
{
  // 缺凭据必须在任何网络动作之前退出。挑一个默认 user_id，写进去的取不回来；
  // 跳过写入，用户看到"记下了"而库里什么都没有——两者都是静默失效。
  const a = cli(['-'], '{}', { MEM0_USER_ID: '' });
  ok(a.code === 2 && /MEM0_USER_ID/.test(a.err), '缺 MEM0_USER_ID → 退出码 2', a.err.split('\n')[0]);
  const b = cli(['-'], '{}', { MEM0_API_KEY: '' });
  ok(b.code === 2 && /MEM0_API_KEY/.test(b.err), '缺 MEM0_API_KEY → 退出码 2', b.err.split('\n')[0]);
}
{
  const r = cli(['-'], JSON.stringify([base(), base()]));
  ok(r.code === 2 && /一次只写一条/.test(r.err),
    '传数组 → 退出码 2（多条之间的去重属 Dedup 层，该层尚未实现，收数组等于让调用方以为去重发生过）');
}
{
  // 形状不通过时必须退出码 1 且**没有发出任何写入请求**——这条用例的 api key
  // 是假的，若脚本真的走到网络那一步，它不会是这个错误信息。
  const r = cli(['-', '--cwd', FIXTURE], JSON.stringify(base({ status: 'confirmed' })));
  ok(r.code === 1 && /status/.test(r.out), '自带 status → 退出码 1，判定停在网络之前', r.err.split('\n')[0]);
  ok(JSON.parse(r.out).written === false, 'written:false —— 明确告诉调用方库里什么都没多');
}
{
  // 自检跑在 FIXTURE 下，而 FIXTURE 属于本仓库——条目声称的 repo 必须与之相符。
  const here = { repo: 'project-agent-harness' };
  const r = cli(['-', '--cwd', FIXTURE], JSON.stringify(base({ ...here, symbols: ['ZzFabricatedQq'] })));
  ok(r.code === 1 && /ZzFabricatedQq/.test(r.out), '编造的符号 → 退出码 1，写入被自检拦下', r.err.split('\n')[0]);

  // repo 不符时 assert-replay 判 skipped，而 skipped 的后果是"永远写不进去"。
  // 笼统地报"自检未通过"会让作者反复重试却不知道错在哪——本用例先抓到的。
  const w = cli(['-', '--cwd', FIXTURE], JSON.stringify(base({ repo: '别人的仓库' })));
  ok(w.code === 1 && /别人的仓库/.test(w.out) && /身处该仓库/.test(w.out),
    'repo 与当前仓库不符 → 点名是哪两个仓库，而不是笼统的"自检未通过"', w.err.split('\n')[0]);
}
ok(cli(['-', '--bogus'], '{}').code === 2, '未知选项 → 退出码 2');
ok(cli([], '{}').code === 2, '缺少输入 → 退出码 2');
ok(cli(['-'], 'not json').code === 2, '输入不是 JSON → 退出码 2');

// ---------------------------------------------------------------------------
g('能力边界（这些本用例守不住，如实记下）');
{
  const client = path.join(REPO, 'plugins', 'experience', 'scripts', 'mem0.js');
  const src = fs.readFileSync(client, 'utf8');
  ok(/尚未对活端点验证/.test(src),
    'REST 路径与鉴权头未经活端点验证，客户端头部必须明写——去掉这段注释本条即失败');
  ok(/selfcheck\.js/.test(src), '并指明验证手段是 selfcheck.js --mem0（由消费方拿自己的 key 跑）');
  ok(/尚未对活端点验证/.test(fs.readFileSync(SCRIPT, 'utf8')), '写入脚本头部也指回这一点');
  // 写入与检索必须共用同一份契约。各写一份的话，改对了一处、另一处继续错，
  // 表现是"写得进去但检索不到"，两端都不报错。
  const recall = fs.readFileSync(path.join(REPO, 'plugins', 'experience', 'hooks', 'recall.js'), 'utf8');
  ok(/require\(['"]\.\.\/scripts\/mem0\.js['"]\)/.test(recall) && /require\(['"]\.\/mem0\.js['"]\)/.test(fs.readFileSync(SCRIPT, 'utf8')),
    '写入与检索共用同一个 REST 客户端——契约错了只需改一处');
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} 项`}`);
process.exitCode = failures === 0 ? 0 : 1;
