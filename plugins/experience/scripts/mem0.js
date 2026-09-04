'use strict';
//
// mem0 REST 客户端 —— 写入脚本与检索 hook 共用。
//
// **共用是有意的**：下面的路径与鉴权头形状若是错的，两条路会同时错，
// 而修它只需改一处。各写一份的话，改对了一处、另一处继续错，表现是
// "写得进去但检索不到"，两端都不报错。
//
// ## 这份契约尚未对活端点验证
//
// 路径、鉴权头形状、请求体字段名来自 mem0 平台 API 的公开文档，
// **本机没有可用的 key，因此没有对活端点跑通过**。
// 已实测的只有 MCP 那一侧（`mcp.mem0.ai`，2026-09-03，11 个工具、
// `infer:false` 不整合、metadata 是字符串键值模型、`user_id` 是显式参数）。
//
// 验证手段是 `selfcheck.js --mem0`：消费方用自己的 key 发一次**只读**检索，
// 确认 searchPath 与鉴权头形状（`Token` 与 `Bearer` 都试，报告哪种成立）。
//
// **它覆盖不到 addPath。** 自检不往使用者的共享库里写探针——那等于用探活
// 污染真实数据。写入路径只能由第一条真经验来验。
//
// **在只读那一步通过之前，不要声称检索路径可用；在第一条真经验写成之前，
// 不要声称写入路径可用。**
//
// （这段话本身有过一次教训：2026-09-04 之前，`selfcheck --mem0` 只探 MCP，
// 一次也没碰过 REST——而三个文件都写着"验证手段是它"。**声称有执行者，
// 而执行者不在那一层**，正是本项目要防的形状，这次发生在自己身上。）

const https = require('https');
const { URL } = require('url');

const MEM0 = {
  base: 'https://api.mem0.ai',
  addPath: '/v1/memories/',
  searchPath: '/v2/memories/search/',
  authHeader: (key) => `Token ${key}`,
};

/**
 * 凭据与 scope **必须由引入插件的项目显式配置，本模块不预设默认值**。
 *
 * 一个默认 user_id 不是"开箱即用"——它会让两个不相干的团队共用同一个库，
 * 别人的经验进你的每一轮提示。scope 就是共享边界，边界不能有默认值。
 *
 * @returns {{cfg: object} | {error: string}}
 */
function resolveConfig(env, over = {}) {
  const cfg = {
    apiBase: String(over.apiBase || env.MEM0_API_BASE || MEM0.base).replace(/\/$/, ''),
    apiKey: String(over.apiKey || env.MEM0_API_KEY || ''),
    userId: String(over.userId || env.MEM0_USER_ID || ''),
    timeout: over.timeout || 15000,
  };
  if (cfg.userId.trim() === '') {
    return { error: '缺 MEM0_USER_ID——共享库的 scope 必须由项目显式配置（.claude/settings.json 的 env，该进版本库）' };
  }
  if (cfg.apiKey.trim() === '') {
    return { error: '缺 MEM0_API_KEY——凭据只能从环境变量取（.claude/settings.local.json 或密钥库，不进版本库）；headersHelper 只管 MCP 检索那条路' };
  }
  return { cfg };
}

function postJson(urlStr, body, cfg) {
  const u = new URL(urlStr);
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: cfg.timeout,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: MEM0.authHeader(cfg.apiKey),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* 保留原文供报错 */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`超时 ${cfg.timeout}ms`)); });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(payload);
    req.end();
  });
}

/** 响应形状未经实测，三种常见容器都认；认不出就当空，不猜。 */
function hitsOf(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.results)) return json.results;
  if (json && Array.isArray(json.memories)) return json.memories;
  return [];
}

async function search(cfg, { query, filters, topK }) {
  const r = await postJson(cfg.apiBase + MEM0.searchPath, { query, filters, top_k: topK }, cfg);
  if (r.error) return { error: `检索失败：${r.error}` };
  if (r.status < 200 || r.status >= 300) return { error: `检索返回 ${r.status}：${String(r.text).slice(0, 200)}` };
  return { hits: hitsOf(r.json) };
}

async function add(cfg, body) {
  const r = await postJson(cfg.apiBase + MEM0.addPath, body, cfg);
  if (r.error) return { error: `写入失败：${r.error}` };
  if (r.status < 200 || r.status >= 300) return { error: `写入返回 ${r.status}：${String(r.text).slice(0, 200)}` };
  return { json: r.json };
}

module.exports = { MEM0, resolveConfig, postJson, search, add, hitsOf };
