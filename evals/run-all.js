#!/usr/bin/env node
'use strict';
// 跑齐 evals/ 下的全部用例。
//
// DESIGN.md 的门禁：skills/ hooks/ scripts/ 任一变更即跑，冒烟集必须 100%
// 通过才可合入。本文件是那个门禁的执行者——在它存在之前，DESIGN.md 里
// 那条规则和它要取代的那些规则形状一样：写了，但没有执行者。
//
// 用法：node evals/run-all.js   （任一用例失败即退出码 1）

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

if (files.length === 0) {
  process.stderr.write('evals/ 下没有 *.test.js\n');
  process.exitCode = 1;
} else {
  let failed = 0;
  for (const f of files) {
    const r = spawnSync(process.execPath, [path.join(dir, f)], {
      stdio: 'inherit', timeout: 180000,
    });
    const bad = r.error || r.status !== 0;
    if (bad) failed++;
    process.stdout.write(`\n===== ${bad ? 'FAIL' : 'PASS'}  ${f}${r.error ? `  (${r.error.code || r.error.message})` : ''}\n`);
  }
  process.stdout.write(`\n${failed === 0 ? `全部通过（${files.length} 份）` : `${failed}/${files.length} 份未通过`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
