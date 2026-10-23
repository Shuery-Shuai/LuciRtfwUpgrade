include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-rtfwupgrade
PKG_VERSION:=0.1.0_alpha1
PKG_RELEASE:=1

PKG_LICENSE:=GPL-2.0-or-later
PKG_MAINTAINER:=Shuery-Shuai <2463253700@qq.com>

LUCI_TITLE:=LuCI app for router firmware updates
LUCI_DESCRIPTION:=Detects and downloads available ImmortalWrt/OpenWrt firmware \
 updates for the running device by comparing official build metadata \
 (BUILD_ID / OPENWRT_BUILD_DATE) against a configured release source.
# digest 用于校验镜像 sha256；curl 需要 ca-bundle 才能访问 https 源站。
LUCI_DEPENDS:=+luci-base +rpcd +rpcd-mod-ucode +curl +ucode-mod-digest +ca-bundle
LUCI_PKGARCH:=all

define Package/luci-app-rtfwupgrade/conffiles
/etc/config/rtfwupgrade
endef

# 卸载时移除自动写入的 crontab 受管块，避免残留任务调用已删除的 CLI。
define Package/luci-app-rtfwupgrade/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	[ -f /etc/crontabs/root ] && sed -i '/^# BEGIN rtfwupgrade (managed block, do not edit)$$/,/^# END rtfwupgrade$$/d' /etc/crontabs/root
	rm -f /etc/crontabs/root.rtfwupgrade.bak
	rm -f /tmp/rtfwupgrade.last.json
	rm -rf /tmp/rtfwupgrade
	/etc/init.d/cron restart >/dev/null 2>&1 || true
}
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
