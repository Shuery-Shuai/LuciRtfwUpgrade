#!/bin/sh
# 用真机的 apk-tools 深验 luci-app-rtfwupgrade 的 .apk 产物内容
#（apk v3 是 ADB 格式，主机侧 tar 读不了）。
# 用法: tests/verify-apk.sh [ssh别名] <本地 apk 路径>
set -eu

HOST="${1:-ppuc}"
APK="${2:?用法: tests/verify-apk.sh [ssh别名] <本地 apk 路径>}"
SSH="ssh -o BatchMode=yes -o User=root $HOST"
REMOTE=/tmp/verify-rtfwupgrade.apk
fail=0

echo "== 传到路由器并读取 =="
$SSH "cat > $REMOTE" < "$APK"
echo "  远端体积: $($SSH "wc -c < $REMOTE" | tr -d ' ') 字节"

# apk v3 是 ADB 格式：adbdump 出的是树，manifest 才是扁平清单（需 --allow-untrusted，
# 因为我们的产物没有用设备信任的密钥签名）
echo "== apk manifest（扁平文件清单）=="
DUMP=$($SSH "apk --allow-untrusted manifest $REMOTE 2>/dev/null")
echo "  文件数: $(printf '%s' "$DUMP" | grep -c sha256 || true)"

echo "== 逐个断言关键文件 =="
# 语言包（luci-i18n-rtfwupgrade-*）只应含 lmo；主包应含代码、视图、配置、菜单与 ACL
case "$(basename "$APK")" in
	*luci-i18n-rtfwupgrade-*)
		WANT="usr/lib/lua/luci/i18n/rtfwupgrade.zh-cn.lmo"
		;;
	*luci-app-rtfwupgrade*)
		WANT="usr/share/ucode/rtfwupgrade/util.uc usr/share/ucode/rtfwupgrade/check.uc usr/share/ucode/rtfwupgrade/scheduler.uc usr/bin/rtfwupgrade.sh usr/share/rpcd/ucode/rtfwupgrade www/luci-static/resources/view/rtfwupgrade/overview.js www/luci-static/resources/view/rtfwupgrade/settings.js www/luci-static/resources/view/rtfwupgrade/logs.js www/luci-static/resources/rtfwupgrade/format.js www/luci-static/resources/rtfwupgrade/rtfwupgrade.css etc/config/rtfwupgrade usr/share/rtfwupgrade/config.default etc/uci-defaults/80_rtfwupgrade usr/share/luci/menu.d/luci-app-rtfwupgrade.json usr/share/rpcd/acl.d/luci-app-rtfwupgrade.json"
		;;
	*)
		echo "  FAIL 无法识别的产物名：$(basename "$APK")"; fail=1; WANT=""
		;;
esac

for want in $WANT; do
	case "$DUMP" in
		*"$want"*) echo "  ok   $want";;
		*) echo "  FAIL 缺少 $want"; fail=1;;
	esac
done

$SSH "rm -f $REMOTE"
[ $fail -eq 0 ] && echo "产物内容校验通过" || echo "存在缺失项"
exit $fail
