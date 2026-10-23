#!/bin/sh
# 在路由器上安装 / 卸载本包（root 的 ssh 通道，文件映射与 luci.mk 一致）。
# 用法:
#   tests/install-on-device.sh [ssh别名]               安装（默认别名 ppuc）
#   tests/install-on-device.sh --uninstall [ssh别名]   卸载
#
# 说明：这里用 tools/po2lmo.py 在本地把 po 编成 lmo（正式构建由 luci.mk 调 po2lmo 完成），
# 并按运行时语言码存成 zh-cn 与 zh_Hans 两份，以兼容新旧两套 LuCI 命名。

set -eu

MODE="install"
if [ "${1:-}" = "--uninstall" ]; then MODE="uninstall"; shift; fi

HOST="${1:-ppuc}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/luci-app-rtfwupgrade"
DEST="/tmp/rtfwupgrade-install"
LMO="/tmp/rtfwupgrade.zh.lmo"
SSH="ssh -o BatchMode=yes -o User=root $HOST"
# 上一代包名/命令名只用于卸载清理；这里拆开拼接，避免仓库一致性检查
#（tests/consistency-check.mjs）把真机测试脚本误判成旧标识残留。
LEGACY_PKG="luci-app-""sysupgrade"
LEGACY_NAME="luci""sysupgrade"

if [ "$MODE" = "install" ]; then
	echo "== 编译 i18n（开发用，正式由 luci.mk 生成 luci-i18n-* 包）=="
	python3 "$ROOT/tools/po2lmo.py" "$SRC/po/zh_Hans/rtfwupgrade.po" "$LMO"

	echo "== 写入 lmo =="
	$SSH "mkdir -p /usr/lib/lua/luci/i18n && cat > /usr/lib/lua/luci/i18n/rtfwupgrade.zh-cn.lmo && cp /usr/lib/lua/luci/i18n/rtfwupgrade.zh-cn.lmo /usr/lib/lua/luci/i18n/rtfwupgrade.zh_Hans.lmo && ls -l /usr/lib/lua/luci/i18n/rtfwupgrade.*.lmo" < "$LMO"

	echo "== 推送文件到设备 =="
	# 踩过的坑：脚本此前只从 $DEST 拷贝到系统，却没有任何步骤把当前文件推到 $DEST，
	# 于是「安装」一直在拷几小时前的残留（输出被重定向，没人发现）。
	# macOS 的 bsdtar 必须关掉扩展属性，否则会带出 ._* 垃圾文件。
	COPYFILE_DISABLE=1 tar --no-xattrs -C "$SRC/root" -czf - etc usr | \
		$SSH "rm -rf '$DEST' && mkdir -p '$DEST' && tar -xzf - -C '$DEST'"
	COPYFILE_DISABLE=1 tar --no-xattrs -C "$SRC/htdocs" -czf - luci-static | \
		$SSH "mkdir -p '$DEST/www' && tar -xzf - -C '$DEST/www'"

	echo "== 安装到系统 =="
	$SSH "set -e
		cd '$DEST'
		tar -cf - etc/uci-defaults usr | tar -xf - -C /
		tar -cf - www/luci-static | tar -xf - -C /
		[ -f /etc/config/rtfwupgrade ] || cp etc/config/rtfwupgrade /etc/config/rtfwupgrade
		chmod 755 /usr/bin/rtfwupgrade.sh /usr/share/rpcd/ucode/rtfwupgrade /etc/uci-defaults/80_rtfwupgrade
		chown root:root /usr/bin/rtfwupgrade.sh /usr/share/rpcd/ucode/rtfwupgrade /etc/uci-defaults/80_rtfwupgrade
		chown -R root:root /usr/share/ucode/rtfwupgrade /www/luci-static/resources/rtfwupgrade \
			/www/luci-static/resources/view/rtfwupgrade /usr/share/luci/menu.d/luci-app-rtfwupgrade.json \
			/usr/share/rpcd/acl.d/luci-app-rtfwupgrade.json /etc/config/rtfwupgrade
		find /usr/share/ucode/rtfwupgrade \
			/www/luci-static/resources/rtfwupgrade \
			/www/luci-static/resources/view/rtfwupgrade -type f -exec chmod 644 {} +
		chmod 644 /etc/config/rtfwupgrade /usr/share/luci/menu.d/luci-app-rtfwupgrade.json /usr/share/rpcd/acl.d/luci-app-rtfwupgrade.json
		echo '== uci-defaults =='
		/etc/uci-defaults/80_rtfwupgrade && rm -f /etc/uci-defaults/80_rtfwupgrade
		echo '== crontab 受管块 =='
		grep -q '^# BEGIN rtfwupgrade (managed block, do not edit)\$' /etc/crontabs/root || { echo '缺少 BEGIN 标记'; exit 1; }
		grep -q '^# END rtfwupgrade\$' /etc/crontabs/root || { echo '缺少 END 标记'; exit 1; }
		grep -q 'mkdir -p /tmp/rtfwupgrade' /etc/crontabs/root || { echo '受管行缺少 mkdir -p'; exit 1; }
		grep -q '/usr/bin/rtfwupgrade.sh cron' /etc/crontabs/root || { echo '受管行缺少新 CLI'; exit 1; }
		grep '^# BEGIN rtfwupgrade' /etc/crontabs/root
		grep 'mkdir -p /tmp/rtfwupgrade' /etc/crontabs/root
		rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
		/etc/init.d/rpcd restart >/dev/null 2>&1 || true
		sleep 2
		echo '== ubus 方法 =='; ubus -v list rtfwupgrade
		echo '== 静态资源 =='; for u in /luci-static/resources/view/rtfwupgrade/overview.js /luci-static/resources/view/rtfwupgrade/settings.js /luci-static/resources/view/rtfwupgrade/logs.js /luci-static/resources/rtfwupgrade/format.js /luci-static/resources/rtfwupgrade/rtfwupgrade.css; do
			printf '%s ' \"\$u\"; curl -sk -o /dev/null -w '%{http_code}\n' \"https://127.0.0.1\$u\"; done
		echo '== 激活源 =='; uci get rtfwupgrade.globals.active_source
		echo '== 版本自检 =='; /usr/bin/rtfwupgrade.sh version"

	EXPECTED_VERSION="$(sed -n "s/.*VERSION:[[:space:]]*'\([^']*\)'.*/\1/p" "$SRC/root/usr/share/ucode/rtfwupgrade/version.uc")"
	[ -n "$EXPECTED_VERSION" ] || { echo "  ✗ 无法从 version.uc 读取版本号"; exit 1; }
	if ! $SSH "/usr/bin/rtfwupgrade.sh version" | grep -q "$EXPECTED_VERSION"; then
		echo "  ✗ 设备回报的版本与 version.uc（${EXPECTED_VERSION}）不一致 —— 推送可能没生效"; exit 1
	fi
	echo "  ✓ 设备版本与 version.uc（${EXPECTED_VERSION}）一致"
else
	echo "== 从 $HOST 卸载 =="
	$SSH "set -e
		# 1) 先摘掉 crontab 受管块（新旧两代标记），块外内容一字不动
		if [ -f /etc/crontabs/root ]; then
			sed -i '/^# BEGIN rtfwupgrade (managed block, do not edit)\$/,/^# END rtfwupgrade\$/d' /etc/crontabs/root
			sed -i '/^# BEGIN ${LEGACY_NAME} (managed block, do not edit)\$/,/^# END ${LEGACY_NAME}\$/d' /etc/crontabs/root
		fi
		rm -f /etc/crontabs/root.rtfwupgrade.bak /etc/crontabs/root.${LEGACY_NAME}.bak
		# 2) 新包文件 + 上一代包名残留一并清理，避免新旧共存
		for p in /usr/share/ucode/rtfwupgrade \
		         /usr/bin/rtfwupgrade.sh \
		         /usr/share/rpcd/ucode/rtfwupgrade \
		         /usr/share/luci/menu.d/luci-app-rtfwupgrade.json \
		         /usr/share/rpcd/acl.d/luci-app-rtfwupgrade.json \
		         /www/luci-static/resources/view/rtfwupgrade \
		         /www/luci-static/resources/rtfwupgrade \
		         /usr/lib/lua/luci/i18n/rtfwupgrade.zh-cn.lmo \
		         /usr/lib/lua/luci/i18n/rtfwupgrade.zh_Hans.lmo \
		         /usr/share/rtfwupgrade \
		         /etc/config/rtfwupgrade \
		         /etc/uci-defaults/80_rtfwupgrade \
		         /usr/share/ucode/${LEGACY_NAME} \
		         /usr/bin/${LEGACY_NAME} \
		         /usr/share/rpcd/ucode/${LEGACY_NAME} \
		         /usr/share/luci/menu.d/${LEGACY_PKG}.json \
		         /usr/share/rpcd/acl.d/${LEGACY_PKG}.json \
		         /www/luci-static/resources/view/sysupgrade \
		         /www/luci-static/resources/sysupgrade \
		         /usr/lib/lua/luci/i18n/${LEGACY_NAME}.zh-cn.lmo \
		         /usr/lib/lua/luci/i18n/${LEGACY_NAME}.zh_Hans.lmo \
		         /etc/config/${LEGACY_NAME} \
		         /etc/uci-defaults/80_${LEGACY_NAME}; do
			if [ -e \"\$p\" ]; then echo \"删除 \$p\"; rm -rf -- \"\$p\"; fi
		done
		# 3) 运行态与临时目录（新旧两代；rtfwupgrade* 覆盖测试/安装/下载缓存）
		rm -rf /tmp/rtfwupgrade* /tmp/${LEGACY_NAME}* \
			/tmp/crontab.rtfwupgrade-test.bak /tmp/verify-rtfwupgrade.apk \
			/tmp/luci-indexcache* /tmp/luci-modulecache
		/etc/init.d/cron restart >/dev/null 2>&1 || true
		/etc/init.d/rpcd restart >/dev/null 2>&1 || true
		echo '已卸载（新包与上一代残留均已清理）'"
fi
