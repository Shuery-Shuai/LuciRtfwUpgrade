#!/usr/bin/env node
// 仓库一致性检查（静态、无设备、无网络）：
//   - 旧标识/旧布局名只能出现在精确白名单的迁移代码里
//   - Makefile 的依赖与配置文件路径
//   - scheduler 的 cron 行（mkdir + CLI 路径）
//   - 菜单标题与中文翻译、CLI 路径、lmo 命名
// 用法: node tests/consistency-check.mjs
//
// 存在的意义：重命名（LuciSysUpgrade → LuciRtfwUpgrade）最容易漏的是字符串，
// 编译器/渲染检查都发现不了；这里用仓库文本扫描 + 关键文件断言兜底。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;

function ok(name) {
	console.log(`ok   ${name}`);
	passed++;
}

function fail(name, detail) {
	console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`);
	failed++;
}

function expect(name, cond, detail) {
	if (cond) ok(name);
	else fail(name, detail);
}

function read(rel) {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
	return fs.existsSync(path.join(ROOT, rel));
}

// ── 旧标识扫描 ──────────────────────────────────────────────────────────────
// 白名单登记到「文件 + 旧 token」级别：整文件跳过太粗，会把新引入的残留一起放过。
// 目前只允许三处兼容/迁移代码命中（见 docs/ARCHITECTURE.md「自定义源」「定时任务落地」）。
const LEGACY_TOKENS = ['luci-app-sysupgrade', 'lucisysupgrade', 'bin_targets_root', 'lsu-'];
const LEGACY_ALLOW = {
	'luci-app-rtfwupgrade/root/usr/share/ucode/rtfwupgrade/config.uc': ['bin_targets_root'],
	'luci-app-rtfwupgrade/root/usr/share/ucode/rtfwupgrade/scheduler.uc': ['lucisysupgrade', 'bin_targets_root'],
	'luci-app-rtfwupgrade/root/etc/uci-defaults/80_rtfwupgrade': ['lucisysupgrade']
};
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.prettierrc.json') continue;
		if (SKIP_DIRS.has(entry.name)) continue;

		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(abs, out);
		else out.push(abs);
	}
	return out;
}

function main() {
	// 1) 旧标识残留
	const leaks = [];
	for (const abs of walk(ROOT)) {
		const rel = path.relative(ROOT, abs);
		if (rel === SELF) continue;

		const buf = fs.readFileSync(abs);
		if (buf.includes(0)) continue; // 二进制文件跳过

		const text = buf.toString('utf8');
		if (!LEGACY_TOKENS.some(t => text.includes(t))) continue;

		const allowed = LEGACY_ALLOW[rel] || [];
		text.split('\n').forEach((line, i) => {
			for (const token of LEGACY_TOKENS) {
				if (!line.includes(token)) continue;
				if (allowed.includes(token)) continue;
				leaks.push(`${rel}:${i + 1} 出现旧标识 ${JSON.stringify(token)}`);
			}
		});
	}
	expect('仓库文本无白名单外的旧标识', leaks.length === 0, leaks.slice(0, 20).join('\n  '));
	if (leaks.length > 20) console.log(`  …共 ${leaks.length} 处`);

	// CLI 路径统一为 /usr/bin/rtfwupgrade.sh：裸 /usr/bin/rtfwupgrade 是重命名前的旧路径
	const bareCli = [];
	for (const abs of walk(ROOT)) {
		const rel = path.relative(ROOT, abs);
		if (rel === SELF) continue;

		const buf = fs.readFileSync(abs);
		if (buf.includes(0)) continue;

		buf.toString('utf8')
			.split('\n')
			.forEach((line, i) => {
				if (/\/usr\/bin\/rtfwupgrade(?![\w.])/.test(line)) bareCli.push(`${rel}:${i + 1} ${line.trim()}`);
			});
	}
	expect('仓库内无裸 /usr/bin/rtfwupgrade 旧路径', bareCli.length === 0, bareCli.slice(0, 10).join('\n  '));

	// 2) Makefile：digest 依赖 + 配置文件
	const makefile = read('luci-app-rtfwupgrade/Makefile');
	expect('Makefile 依赖含 +ucode-mod-digest', /\+ucode-mod-digest\b/.test(makefile));
	expect('Makefile conffiles 含 /etc/config/rtfwupgrade', makefile.includes('/etc/config/rtfwupgrade'));

	// 迁移逻辑依赖「默认配置模板」与包内 conffile 完全一致；不一致时旧配置不会被识别为可迁移。
	const etcConfig = read('luci-app-rtfwupgrade/root/etc/config/rtfwupgrade');
	const defaultConfig = read('luci-app-rtfwupgrade/root/usr/share/rtfwupgrade/config.default');
	expect('默认配置模板与 /etc/config 一致', etcConfig === defaultConfig);

	// 3) scheduler：cron 行必须建目录并使用新 CLI
	const scheduler = read('luci-app-rtfwupgrade/root/usr/share/ucode/rtfwupgrade/scheduler.uc');
	const cronFn = scheduler.split('function cron_line')[1]?.split('// 去掉指定标记块')[0] ?? '';
	const cronDir = scheduler.match(/const DIR = '([^']+)'/)?.[1];
	expect(
		'scheduler cron 行含 mkdir -p /tmp/rtfwupgrade',
		cronFn.includes('mkdir -p') && cronDir === '/tmp/rtfwupgrade',
		`cron_line=${JSON.stringify(cronFn.trim().slice(0, 160))} DIR=${cronDir}`
	);
	expect('scheduler cron 行调用 /usr/bin/rtfwupgrade.sh', scheduler.includes("CMD = '/usr/bin/rtfwupgrade.sh cron'"));
	expect('scheduler 使用新受管块标记', scheduler.includes('# BEGIN rtfwupgrade'));

	// 4) 包布局与 CLI
	const cli = 'luci-app-rtfwupgrade/root/usr/bin/rtfwupgrade.sh';
	expect('CLI 路径为 root/usr/bin/rtfwupgrade.sh', exists(cli));
	expect('旧 CLI 文件已不存在', !exists('luci-app-rtfwupgrade/root/usr/bin/rtfwupgrade'));
	expect('UCI 配置为 /etc/config/rtfwupgrade', exists('luci-app-rtfwupgrade/root/etc/config/rtfwupgrade'));
	expect('ucode 库目录为 rtfwupgrade', exists('luci-app-rtfwupgrade/root/usr/share/ucode/rtfwupgrade/util.uc'));
	expect('rpcd 对象为 rtfwupgrade', exists('luci-app-rtfwupgrade/root/usr/share/rpcd/ucode/rtfwupgrade'));
	expect('uci-defaults 为 80_rtfwupgrade', exists('luci-app-rtfwupgrade/root/etc/uci-defaults/80_rtfwupgrade'));
	expect('旧包目录已不存在', !exists('luci-app-sysupgrade'));

	const cliText = read(cli);
	for (const word of ['cron', 'schedule', 'version', '--channel', '--apply']) {
		expect(`CLI 提供「${word}」`, cliText.includes(word));
	}

	// 5) 菜单标题与中文翻译
	const menu = JSON.parse(read('luci-app-rtfwupgrade/root/usr/share/luci/menu.d/luci-app-rtfwupgrade.json'));
	const rootMenu = menu['admin/system/rtfwupgrade/'];
	expect('菜单根路径为 admin/system/rtfwupgrade', rootMenu != null);
	expect('菜单标题为 Router Firmware Update', rootMenu?.title === 'Router Firmware Update');
	expect('菜单依赖 ACL 为 luci-app-rtfwupgrade', rootMenu?.depends?.acl?.includes('luci-app-rtfwupgrade'));

	const po = read('luci-app-rtfwupgrade/po/zh_Hans/rtfwupgrade.po');
	const menuMsg = po.match(/msgid "Router Firmware Update"\s*\nmsgstr "([^"]*)"/);
	expect('po 提供菜单标题中文翻译 路由器固件更新', menuMsg?.[1] === '路由器固件更新');

	// 6) lmo 命名（官方机制：po/zh_Hans → luci-i18n-rtfwupgrade-zh-cn → rtfwupgrade.zh-cn.lmo）
	expect('po 路径为 po/zh_Hans/rtfwupgrade.po', exists('luci-app-rtfwupgrade/po/zh_Hans/rtfwupgrade.po'));
	const inspect = read('tools/inspect-package.py');
	expect('语言包检查按 rtfwupgrade.<lang>.lmo 命名', inspect.includes('rtfwupgrade.%s.lmo'));
	expect('语言包名为 luci-i18n-rtfwupgrade-zh-cn', read('README.md').includes('luci-i18n-rtfwupgrade-zh-cn'));
	expect('文档声明 lmo 名为 rtfwupgrade.zh-cn.lmo', read('CONTRIBUTING.md').includes('rtfwupgrade.zh-cn.lmo'));

	// 7) 布局白名单
	const config = read('luci-app-rtfwupgrade/root/usr/share/ucode/rtfwupgrade/config.uc');
	expect('布局白名单为 official/default', /LAYOUTS\s*=\s*\[\s*'official'\s*,\s*'default'\s*\]/.test(config));

	console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
	process.exit(failed ? 1 : 0);
}

main();
