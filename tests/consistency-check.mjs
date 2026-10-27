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

		// 用 lstat 分类，不要用 Dirent.isDirectory()：后者按「链接本身」判定，
		// 指向目录的软链会被当成普通文件推进 out，随后读它就会抛 EISDIR 把整个检查崩掉。
		// 软链/管道/设备一并跳过 —— 本检查只扫仓库里的真实文本文件，跟链走还会读出
		// 仓库外面的内容。throwIfNoEntry 兜住 readdir 与 lstat 之间被删掉的竞态。
		const st = fs.lstatSync(abs, { throwIfNoEntry: false });
		if (!st) continue;

		if (st.isDirectory()) walk(abs, out);
		else if (st.isFile()) out.push(abs);
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

	// ── M3 刷写能力 ────────────────────────────────────────────────────────
	// 这组断言防的是「功能还在、入口没了」：子命令在第 398 行附近的 case 分派里，
	// 删掉一个 case 不会让任何编译或渲染检查报错，只有真机上敲命令才会发现。
	// 因此这里要求出现完整的 case 语句，而不是只搜关键词（'flash' 会命中 flash-status）。
	const FLASH = 'luci-app-rtfwupgrade/root/usr/share/ucode/rtfwupgrade/flash.uc';
	const INITD = 'luci-app-rtfwupgrade/root/etc/init.d/rtfwupgrade';
	const KEEPD = 'luci-app-rtfwupgrade/root/lib/upgrade/keep.d/rtfwupgrade';
	const ACL = 'luci-app-rtfwupgrade/root/usr/share/rpcd/acl.d/luci-app-rtfwupgrade.json';

	for (const cmd of ['flash', 'flash-status', 'flash-clear']) {
		expect(`CLI 提供子命令「${cmd}」`, cliText.includes(`case '${cmd}':`));
	}
	for (const flag of ['--yes', '--force', '--boot-check']) {
		expect(`CLI 提供参数「${flag}」`, cliText.includes(flag));
	}

	// 文件存在性：flash.uc 是 M3 的全部逻辑，init.d 是开机闭环的唯一入口
	// （uci-defaults 是一次性的，重启后不会再跑，所以不能拿它顶替），
	// keep.d 决定状态文件能否跨过重启。
	expect('刷写模块文件为 ucode/rtfwupgrade/flash.uc', exists(FLASH));
	expect('开机钩子为 etc/init.d/rtfwupgrade', exists(INITD));
	expect('keep.d 登记为 lib/upgrade/keep.d/rtfwupgrade', exists(KEEPD));

	// keep.d 里必须正好是状态文件：登记错了，刷写前写的 pending 会在重启时丢掉，
	// boot_check 就永远看不到它，刷写结果再也无法确认。
	const keepd = read(KEEPD);
	expect('keep.d 内容含 /etc/rtfwupgrade.flash.json', keepd.includes('/etc/rtfwupgrade.flash.json'));

	const flashText = read(FLASH);

	// 命令只有一种形态：sysupgrade -c -k <绝对路径>。
	// -n 会关掉保留配置（官方脚本默认 SAVE_CONFIG=1，-n 才清空），
	// 一旦有人"优化"成 -n，刷完设备的配置就没了 —— 这是最贵的一类回归。
	expect('flash.uc 含 sysupgrade -c -k', flashText.includes('sysupgrade -c -k'));
	expect(
		'flash.uc 不含 sysupgrade -n（-n 会丢弃保留配置）',
		// 注释里出现「-n 才关闭」是说明文字，不算：只在代码行（去掉整行注释）里查
		!flashText
			.split('\n')
			.filter(line => !line.trim().startsWith('//'))
			.some(line => /sysupgrade[^'"]*-n\b/.test(line)),
		'代码行里出现了 sysupgrade -n'
	);

	// 起进程必须放在落盘之后：反过来的话，两条语句之间断电就再也查不到这次刷写。
	// 用行号比较，因为顺序本身才是要保护的东西。
	const lines = flashText.split('\n');
	const saveAt = lines.findIndex(line => line.includes('if (!save_state(st))'));
	const runAt = lines.findIndex(line => line.includes("util.run(sprintf('setsid sh -c %s"));
	expect(
		'flash.uc 先落盘 flash-pending 再起 sysupgrade',
		saveAt >= 0 && runAt >= 0 && saveAt < runAt,
		`save_state@${saveAt} sysupgrade@${runAt}`
	);

	// init.d：START=95（在 network/procd 之后、boot 收尾之前，否则读不到 os-release）
	// 且必须调 flash-status --boot-check，否则刷写结果永远不会被确认。
	const initd = read(INITD);
	expect('init.d 含 START=95', /^START=95$/m.test(initd));
	expect('init.d 调 flash-status --boot-check', initd.includes('flash-status --boot-check'));

	// postinst 必须重启 rpcd：rpcd 只在启动时 readdir 一次 /usr/share/rpcd/ucode
	// （ucode.c: rpc_ucode_api_init），没有 inotify 监听。装包写入
	// usr/share/rpcd/ucode/rtfwupgrade 而 rpcd 不重启，ubus 对象 rtfwupgrade 就不存在，
	// 整页报「RPC call to rtfwupgrade/status failed with error -32000: Object not found」，
	// 要等到设备重启才自愈。reload 无效：实测 rpcd 收到 SIGHUP/SIGUSR1 直接退出。
	const postinst = makefile.split('define Package/luci-app-rtfwupgrade/postinst')[1]?.split('endef')[0] ?? '';
	expect('postinst 重启 rpcd 以注册 ucode 对象', /\/etc\/init\.d\/rpcd\s+restart/.test(postinst),
		postinst.trim().slice(0, 140));

	// ACL：漏登记会让 LuCI 界面上按钮点了没反应（ubus 拒绝），而 CLI 却是好的，
	// 只在网页上复现 —— 所以必须在这里兜住。
	const acl = JSON.parse(read(ACL))['luci-app-rtfwupgrade'];
	const aclRead = acl?.read?.ubus?.rtfwupgrade ?? [];
	const aclWrite = acl?.write?.ubus?.rtfwupgrade ?? [];
	expect('ACL read 含 flash_status', aclRead.includes('flash_status'));
	expect('ACL write 含 flash', aclWrite.includes('flash'));
	expect('ACL write 含 flash_clear', aclWrite.includes('flash_clear'));

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

	// 8) 三页标题样式统一：h2 不能被归一化规则吃掉（否则设置/日志页标题与概览页不一致）
	const css = read('luci-app-rtfwupgrade/htdocs/luci-static/resources/rtfwupgrade/rtfwupgrade.css');
	expect('标题归一化只作用于 h3/h4，不含 h2', !/\.rtfw-app h2\s*,/.test(css) && /\.rtfw-app h3,/.test(css));
	expect('概览页根节点带 rtfw-app（与设置/日志页同一作用域）',
		read('luci-app-rtfwupgrade/htdocs/luci-static/resources/view/rtfwupgrade/overview.js')
			.includes("E('div', { class: 'rtfw-app' }"));

	// 9) 行内按钮尺寸统一：添加/高级不得被单独缩小
	expect('添加/高级按钮不再单独覆盖尺寸', !/\.rtfw-rowbtn-ok,\s*\n\.rtfw-rowbtn-plain/.test(css));

	// 10) 勾选框对齐：Argon 给 label>input[type=checkbox] 加了 top/right 偏移，
	//     应用内的勾选框必须复位，否则框与文字不在同一水平线。
	//     同时确认没有用 :has()——现场还有早于其支持起点的浏览器。
	expect('勾选框 label 使用 .rtfw-check 专用类', /\.rtfw-app \.rtfw-check\s*\{/.test(css));
	expect('勾选框复位了主题的 position/top/right 偏移',
		/\.rtfw-check > input\[type='checkbox'\][\s\S]{0,200}position:\s*static/.test(css));
	const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
	expect('未使用 :has() 选择器（老浏览器不支持）', !/:has\(/.test(cssNoComments));

	// 11b) 说明分组：布局说明与操作说明拆开，对话框里只应出现布局那组
	const stText = read('luci-app-rtfwupgrade/htdocs/luci-static/resources/view/rtfwupgrade/settings.js');
	const fnBody = name => {
		const i = stText.indexOf(name + ': function');
		if (i < 0) return '';
		let depth = 0, started = false;
		for (let j = i; j < stText.length; j++) {
			if (stText[j] === '{') { depth++; started = true; }
			else if (stText[j] === '}') { depth--; if (started && depth === 0) return stText.slice(i, j + 1); }
		}
		return '';
	};
	expect('布局说明与操作说明是两个独立函数',
		stText.includes('function layoutHelp(') && stText.includes('function actionsHelp('));
	expect('高级对话框只展示布局说明',
		fnBody('buildAdvancedForm').includes('layoutHelp()') && !fnBody('buildAdvancedForm').includes('actionsHelp()'));
	expect('编辑对话框只展示布局说明',
		fnBody('buildEditForm').includes('layoutHelp()') && !fnBody('buildEditForm').includes('actionsHelp()'));
	// 注意：不要写成 /E\('tfoot'.../ —— prettier 可能把 E(\n'tfoot', 拆成多行，
	// 那样断言会因为「排版变了」而失败，而不是因为「说明被删了」。
	// 这里只认语义：tfoot 存在，且两种说明都出现在它之后的一段窗口里。
	expect('源表格下方同时展示布局与操作说明',
		/(['"]tfoot['"])[\s\S]{0,400}layoutHelp\(\)[\s\S]{0,80}actionsHelp\(\)/.test(stText));

	// 11) 工具栏上下外边距必须对称：曾写成 margin: 0.25rem 0 1rem（上 4px、下 16px）
	const toolbarRule = cssNoComments.match(/\.rtfw-toolbar\s*\{([^}]*)\}/)?.[1] ?? '';
	const toolbarMargin = toolbarRule.match(/margin:\s*([^;]+);/)?.[1]?.trim() ?? '';
	expect('工具栏外边距上下对称', !!toolbarMargin && toolbarMargin.split(/\s+/).length === 2,
		`margin=${JSON.stringify(toolbarMargin)}`);

	console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
	process.exit(failed ? 1 : 0);
}

main();
