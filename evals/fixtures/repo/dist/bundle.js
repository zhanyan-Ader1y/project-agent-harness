// 位于被 .gitignore 忽略的目录中。符号检查必须仍能找到 zzBundledOnlySymbol，
// 否则说明 --no-ignore 没有生效，rg 与 grep 的语义就没有统一。
function zzBundledOnlySymbol() {
  return 1;
}

module.exports = { zzBundledOnlySymbol };
