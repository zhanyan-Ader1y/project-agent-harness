// evals/fixtures/repo —— 符号存在性检查的受控仓库。
//
// 为什么需要它：符号检查搜索整个 cwd。若直接对着本项目测，
// 测试文件里写下的"编造符号"会被自己搜到，用例永远通不过——
// 自指测量。fixture 把搜索范围隔离到这个目录。

class ZzWidget {
  attachToList(list) {
    return list;
  }
}

module.exports = { ZzWidget };
