#!/usr/bin/env python3
"""检查构建产物内容：列出文件清单与 control 元数据，并核对关键文件。

支持两种真实格式：
  .ipk —— gzip 包裹的 tar，内含 data.tar.gz / control.tar.gz（不是 ar！实测）
  .apk —— apk v3 的 ADB 格式，主机侧读不了，请用 tests/verify-apk.sh 在设备上校验

用法: tools/inspect-package.py <产物路径> [...]
"""
import io
import os
import sys
import tarfile

REQUIRED = [
    'usr/share/ucode/rtfwupgrade/util.uc',
    'usr/share/ucode/rtfwupgrade/check.uc',
    'usr/share/ucode/rtfwupgrade/scheduler.uc',
    'usr/bin/rtfwupgrade.sh',
    'usr/share/rpcd/ucode/rtfwupgrade',
    'www/luci-static/resources/view/rtfwupgrade/overview.js',
    'www/luci-static/resources/view/rtfwupgrade/settings.js',
    'www/luci-static/resources/view/rtfwupgrade/logs.js',
    'www/luci-static/resources/rtfwupgrade/format.js',
    'www/luci-static/resources/rtfwupgrade/rtfwupgrade.css',
    'etc/config/rtfwupgrade',
    'usr/share/rtfwupgrade/config.default',
    'usr/share/luci/menu.d/luci-app-rtfwupgrade.json',
    'usr/share/rpcd/acl.d/luci-app-rtfwupgrade.json',
    'etc/uci-defaults/80_rtfwupgrade',
]
META = ('Package', 'Version', 'Architecture', 'License', 'Depends', 'Installed-Size')
I18N_PREFIX = 'luci-i18n-rtfwupgrade-'


def check_ipk(path, name):
    outer = tarfile.open(path, 'r:gz')
    data = tarfile.open(fileobj=io.BytesIO(outer.extractfile('./data.tar.gz').read()), mode='r:gz')
    names = [ n.lstrip('./') for n in data.getnames() ]

    print('== control ==')
    ctrl = tarfile.open(fileobj=io.BytesIO(outer.extractfile('./control.tar.gz').read()), mode='r:gz')
    for line in ctrl.extractfile('./control').read().decode().splitlines():
        if line.split(':')[0] in META:
            print('  ', line)

    return names


def main():
    bad = 0
    for path in sys.argv[1:]:
        print('== %s ==' % path)

        if not os.path.exists(path):
            print('  ✗ 文件不存在（glob 没展开？）')
            bad = 1
            continue

        if path.endswith('.apk'):
            with open(path, 'rb') as fh:
                magic = fh.read(4)
            print('  apk v3 魔数:', magic.decode('latin1'), '（内容请用 tests/verify-apk.sh 在设备上校验）' if magic == b'ADBd' else '✗ 魔数不对')
            if magic != b'ADBd':
                bad = 1
            continue

        names = check_ipk(path, path)
        # 过滤 macOS 归档带出的 ._ 元数据文件，避免把 `._foo.lmo` 当成真实语言文件
        lmo = [ n for n in names if n.endswith('.lmo') and not n.split('/')[-1].startswith('._') ]
        print('== 内容：%d 个文件 ==' % len(names))

        if I18N_PREFIX in os.path.basename(path):
            # 语言包（luci.mk 按 po/<lang>/ 生成）：应恰好含一个
            # /usr/lib/lua/luci/i18n/rtfwupgrade.<lang>.lmo
            stem = os.path.splitext(os.path.basename(path))[0]
            lang = stem.split(I18N_PREFIX, 1)[1].split('_', 1)[0]
            want = 'rtfwupgrade.%s.lmo' % lang
            got = lmo[0].split('/')[-1] if lmo else ''
            ok = len(lmo) == 1 and got == want
            print('  %-56s %s' % ('%s（期望 %s）' % (got or '无 lmo', want), '✓' if ok else '✗'))
            if not ok:
                bad = 1
            continue

        for want in REQUIRED:
            ok = want in names
            print('  %-56s %s' % (want, '✓' if ok else '✗'))
            if not ok:
                bad = 1

        # 主包不应携带 lmo：翻译由 luci-i18n-* 语言包提供（官方机制）
        print('  %-56s %s' % ('主包内 lmo 数（应为 0）', '✓' if not lmo else '✗ %d 个' % len(lmo)))
        if lmo:
            bad = 1

    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
