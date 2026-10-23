#!/bin/sh
# 一次跑完全部检查：主机侧（Node 渲染/i18n/仓库一致性/语法）+ 真机侧（需要 ssh 别名）。
# 用法: tests/all.sh [ssh别名]     传 "-" 表示跳过真机部分
set -u

HOST="${1:-ppuc}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

step() { echo; echo "### $1"; }
try() { "$@" || { echo "  ↑ 上一步失败"; fail=1; }; }

# 刷写行为回归（M3）：把当前工作区的 ucode 库投到设备 /tmp，用 -L 指过去跑
# tests/flash-unit.uc —— 与 run-on-device.sh 同一套路，测的是本地代码而不是
# 设备上已安装的那份。
#
# 为什么不能放在主机侧：flash.uc 要 OpenWrt 的 ucode 运行时（fs/uci/digest 模块、
# gmtime）以及只有设备上才有的 /usr/lib/os-release 与 /tmp/sysinfo，主机侧跑不了。
# 容器侧另由 CI 的「刷写行为回归」一步覆盖，这里在真机上验真实发行版/真实 board_name。
#
# 普通用户 /etc 不可写 -> 刷写行为断言自动 SKIP、纯配置断言照跑，不算失败；
# 全程用假 sysupgrade（PATH 前置），不会真刷设备。
flash_unit() {
	host="$1"
	dest=/tmp/rtfwupgrade-unit-lib
	COPYFILE_DISABLE=1 tar --no-xattrs -C "$ROOT/luci-app-rtfwupgrade/root/usr/share/ucode" -czf - rtfwupgrade \
		| ssh "$host" "rm -rf '$dest' && mkdir -p '$dest' && tar -xzf - -C '$dest'" || return 1
	COPYFILE_DISABLE=1 tar --no-xattrs -C "$ROOT/tests" -czf - flash-unit.uc \
		| ssh "$host" "tar -xzf - -C /tmp" || return 1
	ssh "$host" "PATH=/tmp/rtfwupgrade-unit/bin:\$PATH ucode -L '$dest' /tmp/flash-unit.uc"
	code=$?
	ssh "$host" "rm -rf '$dest' /tmp/flash-unit.uc"
	return "$code"
}

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

	# 刷写行为回归（M3）：
	#   必须在真机上跑，而不是主机侧 —— flash.uc 依赖 OpenWrt 的 ucode 运行时
	#   （fs/uci/digest 模块、gmtime、以及只有设备上才有的 /usr/lib/os-release
	#   与 /tmp/sysinfo），主机侧没有 ucode 跑不了。
	#   容器侧另有 CI 的一步（.github/workflows/ci.yml「刷写行为回归」）覆盖，
	#   这里在真机上再跑一遍，验的是真实发行版与真实 board_name 下的行为。
	#   普通用户 /etc 不可写 -> 刷写行为断言自动 SKIP，纯配置断言照跑，不算失败；
	#   传 -r 用 root 才会把全部断言都跑到（仍是假 sysupgrade，绝不真刷）。
	step "刷写状态机（护栏/boot_check/命令形态）"
	# 直接调用而不是走 try()：try() 是 "$@" 间接调用，shellcheck 看不到，会误报 SC2329
	flash_unit "$HOST" || { echo "  ↑ 上一步失败"; fail=1; }
fi

echo
if [ $fail -eq 0 ]; then
	echo "✅ 全部通过"
else
	echo "❌ 存在失败项"
fi
exit $fail
