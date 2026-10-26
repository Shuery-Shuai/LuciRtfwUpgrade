#!/bin/sh
# 把包内文件同步到路由器的 /tmp，在真机上跑 M1 检测闭环（无需 root，不改动系统）。
# 用法: tests/run-on-device.sh [ssh 别名]   默认别名: ppuc

set -eu

HOST="${1:-ppuc}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/luci-app-rtfwupgrade"
# 只读用途，全程以普通用户执行；安装脚本用另一个目录
DEST="/tmp/rtfwupgrade-test"
LIBDIR="$DEST/usr/share/ucode"
CLI="$DEST/usr/bin/rtfwupgrade.sh"

echo "== 同步到 $HOST:$DEST =="
# COPYFILE_DISABLE: 阻止 macOS bsdtar 写入 ._* 扩展属性文件
COPYFILE_DISABLE=1 tar --no-xattrs -C "$SRC/root" -czf - etc usr \
	| ssh "$HOST" "rm -rf '$DEST' && mkdir -p '$DEST/www' && tar -xzf - -C '$DEST' && chmod +x '$CLI'"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$SRC/htdocs" -czf - luci-static \
	| ssh "$HOST" "tar -xzf - -C '$DEST/www'"

run() {
	ssh "$HOST" "ucode -L '$LIBDIR' '$CLI' $1" || true
}

echo; echo "== ucode 编译检查 =="
ssh "$HOST" "fail=0; for f in \$(find '$LIBDIR/rtfwupgrade' -name '*.uc') '$DEST/usr/share/rpcd/ucode/rtfwupgrade' '$CLI'; do
	ucode -c \"\$f\" >/dev/null 2>&1 || { echo \"FAIL \$f\"; fail=1; }; done; [ \$fail -eq 0 ] && echo 'all ucode files compile'"

echo; echo "== lib 路径 =="
ssh "$HOST" "test -f '$LIBDIR/rtfwupgrade/util.uc' && echo 'lib 路径正确: $LIBDIR/rtfwupgrade'"

echo; echo "== version =="; run version
echo; echo "== sources =="; run sources
echo; echo "== status =="; run status
echo; echo "== check：激活源（默认 immortalwrt）=="; run check
echo "== check：ImmortalWrt 官方源 =="; run "check --source immortalwrt"
echo "== check：OpenWrt 官方源（跨发行版，预期出现警告）=="; run "check --source openwrt"
echo "== check：RTFW 聚合站（预期：远端更旧 / 可降级）=="; run "check --source rtfw_immortalwrt"
echo "== check --json（激活源，截断 400 字节）=="; run "--json check" | head -c 400; echo
