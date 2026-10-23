#!/bin/sh
# 一次跑完全部检查：主机侧（Node 渲染/i18n/仓库一致性/语法）+ 真机侧（需要 ssh 别名）。
# 用法: tests/all.sh [ssh别名]     传 "-" 表示跳过真机部分
set -u

HOST="${1:-ppuc}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

step() { echo; echo "### $1"; }
try() { "$@" || { echo "  ↑ 上一步失败"; fail=1; }; }

echo "======== 主机侧 ========"

step "版本一致性（Makefile ↔ version.uc）"
try node "$ROOT/tests/version-check.mjs"

step "i18n 一致性（msgid ↔ po）"
try node "$ROOT/tests/i18n-check.mjs"

step "视图渲染检查（Node 桩）"
try node "$ROOT/tests/render-check.mjs"

step "仓库一致性（旧标识/布局/CLI/菜单/lmo）"
try node "$ROOT/tests/consistency-check.mjs"

step "JS 语法"
bad=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	node --check "$f" || { echo "  语法错误: $f"; bad=1; }
done <<EOF
$(find "$ROOT/luci-app-rtfwupgrade/htdocs" -name '*.js')
EOF
[ $bad -eq 0 ] || fail=1

step "JSON 合法性"
bad=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	python3 -c "import json,sys; json.load(open('$f'))" || { echo "  JSON 非法: $f"; bad=1; }
done <<EOF
$(find "$ROOT/luci-app-rtfwupgrade" -name '*.json')
EOF
[ $bad -eq 0 ] || fail=1

step "shell 检查"
if command -v shellcheck >/dev/null 2>&1; then
	# 包内 uci-defaults 没有 .sh 后缀（靠 shebang 识别），会装到设备上执行，必须一起检查
	for f in "$ROOT"/tests/*.sh "$ROOT"/tools/*.sh "$ROOT"/luci-app-rtfwupgrade/root/etc/uci-defaults/*; do
		[ -f "$f" ] || continue
		try shellcheck "$f"
	done
else
	echo "  （本机无 shellcheck，跳过）"
fi

if [ "$HOST" != "-" ]; then
	echo
	echo "======== 真机侧（${HOST}）========"

	step "CLI 与编译检查"
	try sh "$ROOT/tests/run-on-device.sh" "$HOST"

	step "定时任务（crontab 受管块）"
	try sh "$ROOT/tests/scheduler.sh" "$HOST"

	step "源与设置 CRUD"
	try sh "$ROOT/tests/sources-crud.sh" "$HOST"

	step "下载状态机（5+1 分支）"
	try sh "$ROOT/tests/m2-state-machine.sh" "$HOST"
fi

echo
if [ $fail -eq 0 ]; then
	echo "✅ 全部通过"
else
	echo "❌ 存在失败项"
fi
exit $fail
