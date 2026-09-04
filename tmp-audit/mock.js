// 一次性 mock mem0 REST 端点，用于核实失败分支。用完删。
const https = require('https');
const fs = require('fs');

const mode = process.argv[2] || 'retracted';
const srv = https.createServer(
  { key: fs.readFileSync('/tmp/k.pem'), cert: fs.readFileSync('/tmp/c.pem') },
  (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      process.stderr.write(`REQ ${req.method} ${req.url} :: ${body.slice(0, 300)}\n`);
      if (req.url.includes('/search')) {
        if (mode === 'html200') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html>proxy says hi</html>');
        }
        if (mode === 'empty200') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end('{"detail":"filters not supported"}');
        }
        // 默认：服务端忽略 status 过滤，回三条（confirmed / candidate / retracted）
        const mk = (id, status) => ({
          id,
          memory: `经验 ${id}（status=${status}）`,
          metadata: {
            repo: 'project-agent-harness', commit: 'c', author: 'a',
            at: '2026-01-01', lens: 'logic', files: 'README.md', status,
          },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results: [mk('m1', 'confirmed'), mk('m2', 'candidate'), mk('m3', 'retracted')] }));
      }
      // add
      if (mode === 'add500body200') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"error":"quota exceeded, nothing stored"}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"results":[{"id":"new","event":"ADD"}]}');
    });
  },
);
srv.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${srv.address().port}\n`);
});
