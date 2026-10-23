#!/bin/sh
# 在本地 Docker 里用官方 SDK 构建两种包格式（25.12 → .apk，24.10 → .ipk）。
# 目的：推送前先验证 Makefile 与打包布局；CI 的矩阵与此等价。
#
# 结构说明：容器脚本通过 heredoc 从 stdin 交给 bash -s，因此脚本内部可以自由使用引号
# （早先把整段脚本放进单引号参数里，被内层单引号截断过两次）。
#
# 用法: tools/build-local.sh
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-/tmp/rtfw-build}"
mkdir -p "$WORK"

docker run --rm -i \
	-v "$WORK:/build" \
	-v rtfw-build-work:/work \
	-v "$REPO:/src:ro" \
	ubuntu:22.04 bash -s <<'INNER'
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq wget xz-utils zstd ca-certificates git make gcc g++ \
	python3 python3-distutils gawk bzip2 gettext file unzip rsync zip \
	libncurses-dev libssl-dev zlib1g-dev >/dev/null 2>&1

build() {
	v="$1"; url="$2"
	echo "=== SDK $v ==="

	# SDK 归档缓存在挂载点，解包与构建都在命名卷里（原生 Linux 文件系统）
	if ! tar --zstd -tf "/build/sdk-$v.tar.zst" >/dev/null 2>&1; then
		echo "  下载 SDK…"
		wget -q -c --tries=3 --timeout=30 -O "/build/sdk-$v.tar.zst.part" "$url" || { echo "  下载失败"; return 1; }
		mv "/build/sdk-$v.tar.zst.part" "/build/sdk-$v.tar.zst"
	fi

	if [ ! -f "/work/$v/Makefile" ]; then
		echo "  解包 SDK…"
		rm -rf "/work/$v"; mkdir -p "/work/$v"
		tar --zstd -xf "/build/sdk-$v.tar.zst" -C "/work/$v" --strip-components=1
	fi

	cd "/work/$v"
	rm -rf package/luci-app-rtfwupgrade
	# 用 git 干净树构建（与 CI 的 checkout 一致）。直接拷贝工作区会掩盖
	# 被 .gitignore 误伤的文件 —— 已踩过：CLI 主程序缺失只在 CI 暴露。
	rm -rf "/work/src-$v"; mkdir -p "/work/src-$v"
	git -C /src archive HEAD luci-app-rtfwupgrade | tar -x -C "/work/src-$v"
	cp -r "/work/src-$v/luci-app-rtfwupgrade" package/

	# 官方 i18n 机制需要 po2lmo（luci-base 提供），而 luci-base 依赖 liblua → 需要全套 feeds
	if [ ! -d feeds/luci/.git ] || [ ! -d feeds/packages/.git ]; then
		echo "  拉取 feeds（全套，官方 i18n 机制需要）…"
		./scripts/feeds update -a >/tmp/feeds-$v.log 2>&1 || { tail -15 /tmp/feeds-$v.log; return 1; }
	fi
	./scripts/feeds install -a >>/tmp/feeds-$v.log 2>&1 || true

	echo "  配置…"
	make defconfig >>/tmp/feeds-$v.log 2>&1 || { echo "  defconfig 失败："; tail -10 /tmp/feeds-$v.log; return 1; }

	echo "  编译本包…"

	if make package/luci-app-rtfwupgrade/compile V=s >/tmp/build-$v.log 2>&1; then
		echo "  编译成功"
	else
		echo "  编译返回非零，错误行："
		grep -nE "Error [0-9]|error:|No rule|not found" /tmp/build-$v.log | tail -8 | sed "s/^/    /"
	fi

	# 清掉 SDK 里上一轮累积的旧产物，避免同一个包名出现多个时间戳
	find bin -name "*rtfwupgrade*" -type f -delete 2>/dev/null
	rm -rf "/build/out-$v"; mkdir -p "/build/out-$v"
	find bin -name "*rtfwupgrade*" -type f -exec cp {} "/build/out-$v/" \; 2>/dev/null

	echo "  --- 产物 ---"
	ls -l "/build/out-$v" 2>/dev/null | tail -3

	# 不信任 make 的退出码：用统一工具核对产物内容
	# （.ipk 是 gzip 包裹的 tar，内层 data.tar.gz；.apk 是 apk v3 的 ADB 格式）
	echo "  --- 内容校验 ---"
	python3 /src/tools/inspect-package.py /build/out-$v/* 2>&1 | sed "s/^/    /"
}

build 25.12.0 "https://downloads.openwrt.org/releases/25.12.0/targets/x86/64/openwrt-sdk-25.12.0-x86-64_gcc-14.3.0_musl.Linux-x86_64.tar.zst"
build 24.10.6 "https://downloads.openwrt.org/releases/24.10.6/targets/x86/64/openwrt-sdk-24.10.6-x86-64_gcc-13.3.0_musl.Linux-x86_64.tar.zst"

echo "=== 双产物构建结束 ==="
INNER
