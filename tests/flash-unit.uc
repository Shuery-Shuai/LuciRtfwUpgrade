#!/usr/bin/env ucode
'use strict';

// flash.uc（M3 刷写）行为级回归测试。
//
// 跑法（PATH 必须前置，见下）：
//   PATH=/tmp/rtfwupgrade-unit/bin:$PATH \
//     ucode -L luci-app-rtfwupgrade/root/usr/share/ucode tests/flash-unit.uc
//
// 三条安全前提，缺一不可：
//   1) 假 sysupgrade：/tmp/rtfwupgrade-unit/bin/sysupgrade 是本脚本自己写的 shell 垫片，
//      只把收到的参数记进 sysupgrade.called，绝不刷写。flash.start() 最终执行
//      util.run('setsid sh -c sysupgrade ...')，而 ucode **没有 setenv()**，
//      所以 PATH 只能在进程启动时前置 —— 调用方必须按上面的跑法来。
//   2) 互锁断言：碰任何刷写代码之前，先断言 'command -v sysupgrade' 解析到的是垫片；
//      解析不到就 exit(1) 中止。真机上 /sbin/sysupgrade 真实存在，这是最后一道闸：
//      宁可测试失败，也绝不让真 sysupgrade 被跑到。
//   3) 不走网络：假 curl 只按 URL 末段（version.buildinfo / profiles.json）吐固定 fixture，
//      其余 URL 一律 exit 22。全程没有任何真实请求。
//
// 不依赖 root：flash 的状态文件是常量 /etc/rtfwupgrade.flash.json，普通用户写不进 /etc。
// ensure_state_writable() 先探测可写性，不可写就 SKIP 并说明原因，绝不因此 FAIL；
// 纯配置断言（normalize_unattended 等）不碰 /etc，照跑不受影响。
//
// 还有个雷：download.status() 只有在 state == 'running' 时才会调 group_alive()/kill_group()，
// 后者会 kill -TERM/-KILL 整个进程组。所以伪造的 download.json 一律用 state = 'verified'，
// 绝不写 'running' 加一个可能真实存在的 pid —— 否则可能杀掉宿主机上无关的进程组。

let fs = require('fs');

const ROOT = '/tmp/rtfwupgrade-unit';
const BIN = ROOT + '/bin';
const FIX = ROOT + '/fixtures';
const SHIM = BIN + '/sysupgrade';
const CURL = BIN + '/curl';
const MARK = ROOT + '/sysupgrade.called';

const STATE = '/etc/rtfwupgrade.flash.json';
const CFG = '/etc/config/rtfwupgrade';
const BOARD = '/tmp/sysinfo/board_name';
const LAST = '/tmp/rtfwupgrade.last.json';
const DLDIR = '/tmp/rtfwupgrade';
const DLSTATE = DLDIR + '/download.json';
const FLOG = DLDIR + '/flash.log';

// 若设备已有真实 board_name 就沿用它（见 prepare_board），不覆盖系统的真身
let BOARDNAME = 'rtfwupgrade-unit,testboard';
const IMGFILE = DLDIR + '/unit-image.bin';
const IMGSIZE = 4096;
const REMOTE_BUILD = 'unit-target-build';
const SHA = 'unitfixturesha256unitfixturesha256unitfixturesha256unitfixture';

// ucode 的 let 不会提升（strict 模式下引用尚未声明的 let 会直接报
// "access to undeclared variable"），而下面的断言小工具在定义处就要闭包引用 flash，
// 所以这三个模块先声明、后赋值。
let flash = null;
let config = null;
let local = null;

let failed = 0;
let passed = 0;
let skipped = 0;

function check(name, cond) {
	if (cond) {
		print('ok   ' + name + '\n');
		passed++;
	}
	else {
		print('FAIL ' + name + '\n');
		failed++;
	}
}

function skip(name, why) {
	print('SKIP ' + name + (length(why ?? '') ? ('：' + why) : '') + '\n');
	skipped++;
}

// ── 文件小工具 ─────────────────────────────────────────────────────────────
function read(path) {
	return fs.readfile(path);
}

function put(path, text) {
	try {
		return fs.writefile(path, text);
	} catch (e) {
		return null;
	}
}

function rm(path) {
	try { fs.unlink(path); } catch (e) {}
}

function mkdir(path) {
	try { fs.mkdir(path, 0o755); } catch (e) {}
}

function rm_r(path) {
	try {
		let items = fs.lsdir(path);
		if (items != null) {
			for (let it in items)
				rm_r(path + '/' + it);
			try { fs.rmdir(path); } catch (e) {}
			return;
		}
	} catch (e) {}
	rm(path);
}

function run(cmd) {
	let fp = fs.popen(cmd, 'r');
	if (fp == null)
		return { code: 127, output: '' };
	let out = fp.read('all');
	let code = fp.close();
	return { code: code ?? 127, output: out ?? '' };
}

function first_text_of(v) {
	return length(trim(v ?? '')) ? trim(v) : '?';
}

function has_text(text, pat) {
	if (type(pat) == 'string')
		return index(text, pat) >= 0;
	return match(text, pat) != null;
}

// fs.writefile 写失败返回 null（成功返回写入字节数），不一定抛异常 —— 真机实测如此，
// flash.save_state() 正是靠这个返回值判断「状态文件到底写进去没有」。
function probe_write(path) {
	let r = null;
	try { r = fs.writefile(path, 'probe'); } catch (e) { return false; }
	if (r == null)
		return false;
	rm(path);
	return true;
}

// 探测 STATE 本身的可写性，但绝不吃掉设备上已存在的真实刷写记录
function probe_state_writable() {
	let orig = read(STATE);
	let r = null;
	try { r = fs.writefile(STATE, 'probe'); } catch (e) { r = null; }

	if (r == null) {
		if (orig != null)
			put(STATE, orig);
		return false;
	}

	if (orig != null)
		put(STATE, orig);
	else
		rm(STATE);
	return true;
}

function blank(n) {
	let s = '';
	while (length(s) < n) {
		let want = n - length(s);
		let chunk = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
		s += (want >= length(chunk)) ? chunk : substr(chunk, 0, want);
	}
	return s;
}

// ── 假 sysupgrade / 假 curl ────────────────────────────────────────────────
function install_shims() {
	rm_r(ROOT);
	// fs.mkdir 不递归：父目录必须先存在，否则子目录静默创建失败
	mkdir(ROOT);
	mkdir(BIN);
	mkdir(FIX);

	// 只记录参数，什么也不执行
	put(SHIM, join('\n', [
		'#!/bin/sh',
		'out=' + MARK,
		': > "$out"',
		'echo "argc=$#" >> "$out"',
		'for a in "$@"; do echo "arg=$a" >> "$out"; done',
		''
	]));

	// 只按文件名吐 fixture；其它 URL 一律失败（顺带证明测试没走网络）
	put(CURL, join('\n', [
		'#!/bin/sh',
		'url=""',
		'prev=""',
		'for a in "$@"; do',
		'\tcase "$prev" in --url) url="$a";; esac',
		'\tprev="$a"',
		'done',
		'case "$url" in',
		'\t*/version.buildinfo) f=' + FIX + '/version.buildinfo;;',
		'\t*/profiles.json) f=' + FIX + '/profiles.json;;',
		'\t*) exit 22;;',
		'esac',
		'[ -f "$f" ] || exit 22',
		'cat "$f"',
		''
	]));

	run('chmod 755 ' + SHIM + ' ' + CURL);
	put(FIX + '/version.buildinfo', REMOTE_BUILD + '\n');
}

// 互锁：真实 sysupgrade 必须不可达；返回 true 才允许继续
function shim_is_active() {
	return trim(run('command -v sysupgrade').output ?? '') == SHIM;
}

function shim_args() {
	let text = read(MARK);
	if (text == null)
		return null;

	let args = [];
	for (let line in split(text, '\n')) {
		let s = trim(line);
		if (!length(s) || substr(s, 0, 5) == 'argc=')
			continue;
		if (substr(s, 0, 4) == 'arg=')
			push(args, substr(s, 4));
	}
	return args;
}

function wait_marker() {
	for (let i = 0; i < 20; i++) {
		if (read(MARK) != null)
			return true;
		run('sleep 1');
	}
	return false;
}

// ── fixture 配置 ──────────────────────────────────────────────────────────
// 三个源：plain 不带发行版特征，openwrt / immortalwrt 各带一个。
// 跨发行版护栏（f）是否触发取决于**本机 distribution**，所以运行时挑那个与本机
// 发行版不匹配的源 —— 容器（OpenWrt）与真机（ImmortalWrt）都能命中。
function cfg_text(allow_cross) {
	return join('\n', [
		"config globals 'globals'",
		"\toption active_source 'unit_plain'",
		"\toption flash_allow_cross_distro '" + (allow_cross ? '1' : '0') + "'",
		"\toption unattended '0'",
		'',
		"config source 'unit_plain'",
		"\toption label 'Unit plain'",
		"\toption url 'file://" + ROOT + "/remote/plain'",
		"\toption layout 'default'",
		"\toption system ''",
		'',
		"config source 'unit_openwrt'",
		"\toption label 'Unit openwrt'",
		"\toption url 'file://" + ROOT + "/remote/openwrt'",
		"\toption layout 'default'",
		"\toption system 'openwrt'",
		'',
		"config source 'unit_immortal'",
		"\toption label 'Unit immortalwrt'",
		"\toption url 'file://" + ROOT + "/remote/immortal'",
		"\toption layout 'default'",
		"\toption system 'immortalwrt'",
		''
	]);
}

// cfg_text2()：与 cfg_text() 同一批源，但把 globals 写活 ——
// 用来构造「用户已确认过某个来源」的场景（h 条跨源护栏需要 current_firmware_source）。
//   confirmed  写进 current_firmware_source 的段名；空串 = 从未确认
//   active     写进 active_source 的段名
//   allow      写进 flash_allow_cross_distro（1 = 手工路径默认放行跨发行版）
function cfg_text2(confirmed, active, allow) {
	return join('\n', [
		"config globals 'globals'",
		"\toption active_source '" + active + "'",
		(length(confirmed) ? "\toption current_firmware_source '" + confirmed + "'" : ''),
		"\toption flash_allow_cross_distro '" + (int(allow ?? 0) ? '1' : '0') + "'",
		"\toption unattended '0'",
		'',
		"config source 'unit_plain'",
		"\toption label 'Unit plain'",
		"\toption url 'file://" + ROOT + "/remote/plain'",
		"\toption layout 'default'",
		"\toption system ''",
		'',
		"config source 'unit_openwrt'",
		"\toption label 'Unit openwrt'",
		"\toption url 'file://" + ROOT + "/remote/openwrt'",
		"\toption layout 'default'",
		"\toption system 'openwrt'",
		'',
		"config source 'unit_immortal'",
		"\toption label 'Unit immortalwrt'",
		"\toption url 'file://" + ROOT + "/remote/immortal'",
		"\toption layout 'default'",
		"\toption system 'immortalwrt'",
		''
	]);
}

// images: 'ok' | 'noimage' | 'badfs'；epoch 控制「远端比本机旧」那条警告
function set_profiles(images, epoch) {
	let img = null;
	if (images == 'ok')
		img = [ { type: 'sysupgrade', filesystem: 'squashfs', name: 'unit-image.bin', size: IMGSIZE, sha256: SHA } ];
	else if (images == 'noimage')
		img = [ { type: 'factory', filesystem: 'squashfs', name: 'factory.bin', size: 1, sha256: 'x' } ];
	else if (images == 'badfs')
		// pick_image 只挑 type == 'sysupgrade'，所以能走到「type!=sysupgrade 或
		// filesystem!=squashfs」这条的只有 filesystem 半边
		img = [ { type: 'sysupgrade', filesystem: 'ext4', name: 'unit-image.bin', size: IMGSIZE, sha256: SHA } ];

	let meta = {
		version_number: 'R25.12-unit',
		source_date_epoch: epoch,
		profiles: {}
	};
	meta.profiles.rtfwupgrade_unit_testboard = {
		supported_devices: [ BOARDNAME ],
		images: img
	};
	put(FIX + '/profiles.json', sprintf('%J', meta));
}

// 伪造下载器状态：flash 读的 download.status() 对非 'running' 状态原样返回文件内容，
// 所以这里写什么就等于「下载器已是」什么。
function put_download(over) {
	let st = {
		state: 'verified',
		pid: 0,
		url: 'file://' + ROOT + '/remote/plain/unit-image.bin',
		file: IMGFILE,
		size: IMGSIZE,
		sha256: SHA,
		verified: true,
		source: 'unit_plain',
		channel: 'current',
		version_code: REMOTE_BUILD,
		remote: {
			source: 'unit_plain',
			file: IMGFILE,
			version_code: REMOTE_BUILD,
			channel: 'current',
			source_date_epoch: 4000000000,
			image: { name: 'unit-image.bin', size: IMGSIZE, sha256: SHA }
		},
		started: 1,
		finished: 1,
		error: ''
	};

	for (let k in keys(over ?? {}))
		st[k] = over[k];

	mkdir(DLDIR);
	put(IMGFILE, blank(IMGSIZE));
	put(DLSTATE, sprintf('%J', st));
}

function put_verdict(v) {
	put(LAST, sprintf('%J', { verdict: { state: v } }));
}

function put_state(obj) {
	put(STATE, sprintf('%J', obj));
}

// 复位成「护栏全过」的基线；每个用例只破坏一个条件
function baseline(allow_cross) {
	put(CFG, cfg_text(allow_cross ? 1 : 0));
	put(BOARD, BOARDNAME);
	put_verdict('update');
	set_profiles('ok', 4000000000);
	put_download(null);
	rm(STATE);
	rm(MARK);
	rm(FLOG);
}

// ── 断言小工具 ────────────────────────────────────────────────────────────
function errors_of(g) {
	return sprintf('%J', g.errors ?? []);
}

function blocked(name, opts, pat) {
	let g = flash.guards(opts) ?? {};
	let hit = false;
	for (let e in (g.errors ?? []))
		if (has_text(e, pat))
			hit = true;

	let cond = (g.ok == false) && hit;
	check(name, cond);
	if (!cond)
		print('     errors=' + errors_of(g) + '\n');
}

function allowed(name, opts) {
	let g = flash.guards(opts) ?? {};
	let cond = g.ok == true;
	check(name, cond);
	if (!cond)
		print('     errors=' + errors_of(g) + '\n');
}

function warned(name, opts, pat) {
	let g = flash.guards(opts) ?? {};
	let hit = false;
	for (let w in (g.warnings ?? []))
		if (has_text(w, pat))
			hit = true;

	let cond = (g.ok == true) && hit;
	check(name, cond);
	if (!cond)
		print('     warnings=' + sprintf('%J', g.warnings ?? []) + ' errors=' + errors_of(g) + '\n');
}

// ── 被覆盖的真实文件：测试自己建的一律删掉，动过别人的原样还回去 ──────────
// ucode 没有 undefined，所以用「读到的内容 + 是否真的读到过」两个字段区分
// 「原本存在但为空」与「原本不存在」—— 后者测试结束后要删掉，不能新建一个空文件。
//
// 这里的字段逐个写全，不写成 [path, key] 的表再统一处理：让"我动过哪些文件"
// 一眼可见。真机核对时发现早期版本会顺手删掉设备的 download.rc（那是别人的
// 下载续传状态），就属于这里漏记。
let backup = {
	cfg: null, cfg_seen: false,
	board: null, board_seen: false,
	last: null, last_seen: false,
	dlstate: null, dlstate_seen: false,
	dlrc: null, dlrc_seen: false,
	img: null, img_seen: false,
	flog: null, flog_seen: false
};

// events.jsonl 是追加写的日志：测试会往里写 flash 事件（eventlog.append 无法关闭），
// 所以只把测试期间新增的部分截掉，绝不删掉设备原有的历史记录。
const EVENTS = DLDIR + '/events.jsonl';
let events_before = null;
let events_seen = false;

// snapshot() 只在确认环境可写之后才调用；提前收尾（/etc 不可写、uci 不可用）时
// 一次都没拍过快照，此时 cleanup() 里所有 backup.*_seen 都是 false，
// 照字面执行就会把设备上**别人的**状态文件全删掉（真机实测：SKIP 路径把设备原有的
// events.jsonl 删了）。用这个标志把「没拍过快照」与「拍过、但文件原本不存在」区分开。
let snapshotted = false;

function snapshot() {
	snapshotted = true;
	backup.cfg = read(CFG);
	backup.cfg_seen = backup.cfg != null;
	backup.board = read(BOARD);
	backup.board_seen = backup.board != null;
	backup.last = read(LAST);
	backup.last_seen = backup.last != null;
	backup.dlstate = read(DLSTATE);
	backup.dlstate_seen = backup.dlstate != null;
	backup.dlrc = read(DLDIR + '/download.rc');
	backup.dlrc_seen = backup.dlrc != null;
	backup.img = read(IMGFILE);
	backup.img_seen = backup.img != null;
	backup.flog = read(FLOG);
	backup.flog_seen = backup.flog != null;
	events_before = read(EVENTS);
	events_seen = events_before != null;
}

// 容器里没有 /tmp/sysinfo/board_name；真机上有，且是系统真身 —— 有就沿用，不覆盖
function prepare_board() {
	let cur = trim(read(BOARD) ?? '');
	if (length(cur)) {
		// 真机上 board_name 是系统真身：沿用它的值，绝不覆盖
		BOARDNAME = cur;
		return;
	}

	// 容器 rootfs 没有 /tmp/sysinfo/board_name（tmpfs，开机才生成），这里自己建一个，
	// 测试结束按 backup.board_seen == false 删掉。
	mkdir('/tmp/sysinfo');
	put(BOARD, BOARDNAME);
}

function restore(path, orig, seen) {
	if (!seen)
		rm(path);
	else
		put(path, orig);
}

function cleanup() {
	// 没拍过快照 = 测试根本没碰过这些文件，一个都不许动
	if (snapshotted) {
		restore(CFG, backup.cfg, backup.cfg_seen);
		restore(BOARD, backup.board, backup.board_seen);
		restore(LAST, backup.last, backup.last_seen);
		restore(DLSTATE, backup.dlstate, backup.dlstate_seen);
		restore(DLDIR + '/download.rc', backup.dlrc, backup.dlrc_seen);
		restore(IMGFILE, backup.img, backup.img_seen);
		restore(FLOG, backup.flog, backup.flog_seen);
		rm(STATE);

		// events.jsonl：只截掉测试追加的尾巴，保留设备原有历史
		// （eventlog.append 没有开关，flash 的每个事件都会写进去；测试结束后必须还原）
		if (!events_seen)
			rm(EVENTS);
		else if ((read(EVENTS) ?? '') != events_before)
			put(EVENTS, events_before);
	}

	// 这两样永远是测试自己建的，任何路径都清掉
	rm(MARK);
	rm_r(ROOT);
}

// finish() 必须**终止进程**：它是所有提前收尾分支（环境不可写、uci 不可用）
// 与正常收尾共用的出口。ucode 的 exit() 会结束整个脚本，否则 print 完摘要后
// 会继续往下执行，把「跳过的后半段」当成第二轮又跑一遍。
function finish() {
	cleanup();

	if (skipped > 0)
		print(sprintf('\n通过 %d 项，跳过 %d 项，失败 %d 项\n', passed, skipped, failed));
	if (failed)
		exit(1);
	print('全部通过\n');
	exit(0);
}

// ── 前置：环境可写吗 ──────────────────────────────────────────────────────
// 状态文件是常量 /etc/...；/etc 不可写就无法驱动 guards/start/boot_check，
// 这时必须 SKIP 而不是 FAIL —— 设备上的普通用户正是这种情况。
function ensure_state_writable() {
	let reasons = [];

	if (!probe_state_writable())
		push(reasons, STATE + '（/etc）不可写');

	mkdir('/etc/config');
	if (!probe_write('/etc/config/.rtfwupgrade-unit.probe'))
		push(reasons, '/etc/config 不可写');

	mkdir('/tmp/sysinfo');
	if (!probe_write('/tmp/sysinfo/.rtfwupgrade-unit.probe'))
		push(reasons, '/tmp/sysinfo 不可写');

	mkdir(DLDIR);
	if (!probe_write(DLDIR + '/.rtfwupgrade-unit.probe'))
		push(reasons, DLDIR + ' 不可写');

	return { ok: length(reasons) == 0, reasons: reasons };
}

// ── 纯配置断言（不碰 /etc，任何环境都跑）──────────────────────────────────
function config_checks() {
	let c = null;
	try { c = require('rtfwupgrade.config'); } catch (e) {
		skip('config.uc 可加载', '' + e);
		return;
	}

	if (c == null || type(c.normalize_unattended) != 'function') {
		skip('config.uc 提供 normalize_unattended', 'require 返回 null');
		return;
	}

	// 档位只认 0/1/2：手改配置写进来的 3 / 99 / -1 不能被当成「全自动」
	check('normalize_unattended(0) 仍为 0', c.normalize_unattended(0) == 0);
	check('normalize_unattended(1) 仍为 1', c.normalize_unattended(1) == 1);
	check('normalize_unattended(2) 仍为 2', c.normalize_unattended(2) == 2);
	check('normalize_unattended(3) 落回 0（越界档位不得被当成自动刷写）', c.normalize_unattended(3) == 0);
	check('normalize_unattended(99) 落回 0', c.normalize_unattended(99) == 0);
	check('normalize_unattended(-1) 落回 0', c.normalize_unattended(-1) == 0);
	check("normalize_unattended('abc') 落回 0（int() 得 NaN 也不能漏出去）", c.normalize_unattended('abc') == 0);
	check("normalize_unattended('') 落回 0", c.normalize_unattended('') == 0);
	check('normalize_unattended(null) 落回 0', c.normalize_unattended(null) == 0);

	// 开关：非零一律开启，非法值必须关闭而不是「碰巧为真」
	check('normalize_switch(0) 为 0', c.normalize_switch(0) == 0);
	check('normalize_switch(1) 为 1', c.normalize_switch(1) == 1);
	check('normalize_switch(2) 归为 1（非零即开启）', c.normalize_switch(2) == 1);
	check("normalize_switch('abc') 为 0", c.normalize_switch('abc') == 0);
	check("normalize_switch('') 为 0", c.normalize_switch('') == 0);
	check('normalize_switch(null) 为 0', c.normalize_switch(null) == 0);

	// 2 = 自动下载并刷写，这一档是 M3 新增语义，不能被悄悄改回「只下载」
	check('unattended_label(2) 仍是「检测后自动下载并刷写」',
		c.unattended_label(2) == '检测后自动下载并刷写');
}

// ── 主流程 ────────────────────────────────────────────────────────────────
install_shims();
prepare_board();

// 互锁：解析不到假 sysupgrade 就立刻中止，绝不带着真 sysupgrade 往下跑
if (!shim_is_active()) {
	print('FAIL PATH 未前置假 sysupgrade：真实 sysupgrade 可达，拒绝继续（有真刷风险）\n');
	print('     请这样调用：PATH=' + BIN + ':$PATH ucode -L <libdir> tests/flash-unit.uc\n');
	cleanup();
	exit(1);
}
check('互锁：PATH 解析到的 sysupgrade 是假垫片（真刷不可达）', shim_is_active());

let gate = ensure_state_writable();

if (!gate.ok) {
	skip('刷写状态文件可写（/etc）', join('、', gate.reasons));
	print('\n==== 刷写行为断言全部跳过：' + join('；', gate.reasons) + ' ====\n');
	print('（这些断言需要写 /etc，普通用户环境无法驱动；纯配置断言仍照跑）\n\n');
	config_checks();
	finish();
}

flash = require('rtfwupgrade.flash');
config = require('rtfwupgrade.config');
local = require('rtfwupgrade.local');

snapshot();

check('flash.STATE 为 /etc/rtfwupgrade.flash.json', flash.STATE == STATE);
check('flash.LOG 为 /tmp/rtfwupgrade/flash.log', flash.LOG == FLOG);

// fixture 配置必须真的被 config.load() 读到，否则下面所有 probe 都是空谈
baseline(false);
let srcs = config.load().sources ?? [];
let have = filter(srcs, function (s) { return s.name == 'unit_plain'; });
check('fixture 配置被 config.load() 读到（uci 可用）', length(have) == 1);
if (!length(have)) {
	skip('刷写行为断言', 'config.load() 读不到 fixture 源（uci 模块缺失？）');
	config_checks();
	finish();
}

let ME = local.identity();
let CROSS = (index(lc(ME.distribution ?? ''), 'immortalwrt') >= 0) ? 'unit_openwrt' : 'unit_immortal';
let P_OPT = { source: 'unit_plain', channel: 'current' };

// 基线自检：护栏全过时必须是 ok:true，否则后面的「阻断」用例就没有对照意义
allowed('基线（完整下载记录 + update + sysupgrade/squashfs）护栏通过', P_OPT);

// ── 1) 无下载：a/b/c/d 四项同时报出 ──────────────────────────────────────
rm(DLSTATE);
rm(LAST);
let g0 = flash.guards(P_OPT) ?? {};
let four = [];
for (let sub in [ '镜像未下载或未通过校验', '缺少 sha256', '记录的路径不是绝对路径', '不是 update/rebuild' ]) {
	let hit = false;
	for (let e in (g0.errors ?? []))
		if (has_text(e, sub))
			hit = true;
	if (hit)
		push(four, sub);
}
check('无下载且无判定时 guards 返回 ok:false', g0.ok == false);
check('无下载时 errors 非空', length(g0.errors ?? []) > 0);
check('无下载时 a/b/c/d 四项阻断同时命中', length(four) == 4);
if (length(four) != 4)
	print('     只命中 ' + sprintf('%J', four) + ' 全部 errors=' + errors_of(g0) + '\n');

// ── 2) 八条阻断项逐条命中 ────────────────────────────────────────────────
// a 下载状态不是 verified
baseline(false);
put_download({ state: 'failed' });
blocked('a 条：下载状态 failed 时阻断', P_OPT, '镜像未下载或未通过校验');

// b verified 标记 / sha256 缺一不可
baseline(false);
put_download({ verified: false });
blocked('b 条（verified=false）：阻断', P_OPT, '缺少 sha256');
baseline(false);
put_download({ sha256: '' });
blocked('b 条（sha256 为空）：阻断', P_OPT, '缺少 sha256');

// c 记录的镜像必须存在且体积相符
baseline(false);
put_download({ file: 'unit-image.bin' });
blocked('c 条（记录路径非绝对）：阻断', P_OPT, '记录的路径不是绝对路径');
baseline(false);
put_download({ size: 0 });
blocked('c 条（记录体积未知）：阻断', P_OPT, '记录的体积未知');
baseline(false);
put_download({ size: IMGSIZE - 1 });
blocked('c 条（实际体积与记录不符）：阻断', P_OPT, sprintf('记录 %d 字节，实际', IMGSIZE - 1));

// d 判定必须是 update / rebuild
baseline(false);
put_verdict('noop');
blocked('d 条：判定不是 update/rebuild 时阻断', P_OPT, '不是 update/rebuild');

// e 探测失败 / 无 sysupgrade 镜像 / 不是 squashfs
baseline(false);
blocked('e 条（未知源，探测失败）：阻断', { source: 'nope', channel: 'current' }, '远端探测失败');
baseline(false);
set_profiles('noimage', 4000000000);
blocked('e 条（该 profile 无 sysupgrade 镜像）：阻断', P_OPT, '没有 sysupgrade 镜像');
baseline(false);
set_profiles('badfs', 4000000000);
blocked('e 条（filesystem 不是 squashfs）：阻断', P_OPT, 'filesystem=ext4');

// f 跨发行版：只有手工路径能放行
//
// 这里刻意**不**用「guards 的 errors 里有没有跨发行版」当作「环境能否构造」的判据：
// 那样一来，有人删掉 f 条护栏时 guards 就不再报错，用例会走 SKIP 而不是 FAIL ——
// 护栏被删反而变绿。所以先用 source.probe() 独立确认远端确实发出了跨发行版警告，
// 再断言 guards 必须拦住它（probe 直读，guards 无论怎么改都不影响这个判据）。
baseline(false);
let CROSS_OPT = { source: CROSS, channel: 'current' };
let cross_warned = false;
try {
	let sp = require('rtfwupgrade.source');
	let pconf = config.load();
	let psrc = filter(pconf.sources, function (s) { return s.name == CROSS; })[0] ?? null;
	if (psrc != null) {
		let pr = sp.probe(psrc, ME, 'current') ?? {};
		for (let w in (pr.warnings ?? []))
			if (has_text(w, /跨发行版/))
				cross_warned = true;
	}
} catch (e) {
	cross_warned = false;
}

if (!cross_warned) {
	skip('f 条：跨发行版阻断', '本机发行版 ' + first_text_of(ME.distribution) + ' 与两个 fixture 源都同族，构造不出跨发行版警告');
}
else {
	check('f 条：远端发出跨发行版警告时 guards 必须拦住', (flash.guards(CROSS_OPT) ?? {}).ok == false);
	allowed('f 条：force=true 放行跨发行版（手工路径）', { source: CROSS, channel: 'current', force: true });
	blocked('f 条：trigger=auto 时 force 也不放行', { source: CROSS, channel: 'current', force: true, trigger: 'auto' }, /跨发行版/);
	put(CFG, cfg_text(1));
	allowed('f 条：配置 flash_allow_cross_distro=1 放行（手工持久默认）', { source: CROSS, channel: 'current' });
	blocked('f 条：配置=1 时 trigger=auto 仍不放行', { source: CROSS, channel: 'current', trigger: 'auto' }, /跨发行版/);
	put(CFG, cfg_text(0));
}

// g 上一次没结案
baseline(false);
put_state({ state: 'flash-pending', started: 1700000000, target_build_id: REMOTE_BUILD });
blocked('g 条：已存在 flash-pending 时阻断', P_OPT, '上一次刷写尚未确认结果');
rm(STATE);

// ── 2h) h 条：跨源（这次用的源 != 用户确认过的源）────────────────────────
//
// 这条原来只在前端拦（doSetActive / 刷写按钮），直接调 ubus 或走 CLI 都能绕过。
// 现在下沉到 flash.uc，这里把它锁住：判据是**段名比较**，不依赖探测结果。
//
// 用 cfg_text2() 单独构造带 current_firmware_source 的配置，
// 因为老 cfg_text() 刻意不写该字段（它模拟的是「从未确认」的首次使用状态）。
baseline(false);
put(CFG, cfg_text2('unit_plain', 'unit_openwrt'));
check('h 条基线：确认源 == 激活源时不阻断', (flash.guards(P_OPT) ?? {}).ok == true);

// 显式指定一个与确认源不同的源（模拟 --source 或直接调 ubus 绕过界面）
blocked('h 条：本次源不是已确认来源时阻断', { source: 'unit_openwrt', channel: 'current' }, '跨源更换');

// 自动路径一律不放行：cron 不该从用户没认可的源刷写
blocked(
	'h 条：trigger=auto 时即使 force 也阻断',
	{ source: 'unit_openwrt', channel: 'current', force: true, trigger: 'auto' },
	'跨源更换'
);

// 手工路径带 force 放行
allowed('h 条：force=true 放行跨源（手工路径）', { source: 'unit_openwrt', channel: 'current', force: true });

// flash_allow_cross_distro 是**跨发行版**的持久默认，不该悄悄放行跨源：
// 跨源要求的是「当场确认」，所以这里必须仍然阻断。
put(CFG, cfg_text2('unit_plain', 'unit_openwrt', 1));
blocked(
	'h 条：flash_allow_cross_distro=1 不覆盖跨源',
	{ source: 'unit_openwrt', channel: 'current' },
	'跨源更换'
);
put(CFG, cfg_text2('unit_plain', 'unit_openwrt', 0));

// 首次使用（current_firmware_source 为空）不算跨源：只由概览页引导，不阻断。
// 这里必须用**同族源**（unit_plain，system 为空），否则 f 条跨发行版护栏会把它拦下，
// 测到的就不是 h 条了 —— 这条曾因此误报，根因在用例构造而不是产品逻辑。
put(CFG, cfg_text2('', 'unit_plain'));
allowed('h 条：从未确认来源时不阻断（首次使用）', { source: 'unit_plain', channel: 'current' });
put(CFG, cfg_text(0));

// ── 3) 两条不阻断的警告 ──────────────────────────────────────────────────
baseline(false);
put_verdict('rebuild');
warned('rebuild 判定只提示不阻断', P_OPT, 'rebuild');
check('rebuild 判定不阻断（warnings 非空但 ok:true）', (flash.guards(P_OPT) ?? {}).ok == true);

baseline(false);
if (ME.build_date > 0) {
	set_profiles('ok', 1000000000);
	warned('远端 source_date_epoch 较旧只提示不阻断', P_OPT, '远端 source_date_epoch 较旧');
}
else {
	skip('远端 source_date_epoch 较旧只提示不阻断', '本机读不到 OPENWRT_BUILD_DATE，无法比较');
}

// ── 4) start()：护栏不过时不落盘、不起 sysupgrade ────────────────────────
baseline(false);
put_download({ state: 'failed' });
rm(MARK);
rm(FLOG);
let sf = flash.start(P_OPT) ?? {};
check('start 护栏不过时返回 ok:false', sf.ok == false);
check('start 护栏不过时不写状态文件（没有记录就不能刷）', read(STATE) == null);
check('start 护栏不过时没有启动 sysupgrade（假垫片未被调用）', read(MARK) == null);
check('start 护栏不过时 flash.log 里没有发起记录', read(FLOG) == null);

// 顺序铁律的正面：落盘 flash-pending → 起进程，且命令只有 -c -k 这一种形态
baseline(false);
let started = flash.start(P_OPT) ?? {};
check('start 护栏通过时返回 ok:true 且状态为 flash-pending', started.ok == true && started.state == 'flash-pending');

let pending = flash.status() ?? {};
check('start 后 status().state 为 flash-pending', pending.state == 'flash-pending');

// 13 个状态字段齐全且无多余字段
let want = sort([ 'state', 'trigger', 'source', 'channel', 'file', 'sha256', 'size',
	'target_build_id', 'target_version', 'previous_build_id', 'started', 'finished', 'error' ]);
let got = sort(keys(pending));
check('pending 状态文件恰好 13 个字段', length(got) == 13);
check('13 个字段名齐全（state/trigger/source/channel/file/sha256/size/target_build_id/target_version/previous_build_id/started/finished/error）',
	join(',', got) == join(',', want));
check('pending 记录的 file 就是下载记录里的绝对路径', pending.file == IMGFILE);
check('pending 记录的 size 与下载记录一致', pending.size == IMGSIZE);
check('pending 的 sha256 与下载记录一致', pending.sha256 == SHA);
check('pending 的 target_build_id 取自已下载镜像（dl.remote），不取此刻 probe',
	pending.target_build_id == REMOTE_BUILD);
check('pending 的 previous_build_id 是本机 BUILD_ID', pending.previous_build_id == trim(ME.build_id ?? ''));
check('pending 的 trigger 为 manual', pending.trigger == 'manual');
check('pending 的 finished 为 0（尚未结案）', pending.finished == 0);
check('pending 的 started 已盖上时间戳', pending.started > 0);

// 假垫片：证明真正被执行的是「sysupgrade -c -k <绝对路径>」，且没有 -n
if (!wait_marker()) {
	check('假 sysupgrade 被调用', false);
}
else {
	let args = shim_args() ?? [];
	check('假 sysupgrade 收到 3 个参数', length(args) == 3);
	check('命令形态为 sysupgrade -c -k（保留配置）',
		length(args) == 3 && args[0] == '-c' && args[1] == '-k');
	check('命令里的镜像路径是绝对路径且与记录一致', length(args) == 3 && args[2] == IMGFILE);
	check('命令里没有 -n（关掉保留配置）', index(' ' + join(' ', args) + ' ', ' -n ') < 0);

	let flog = read(FLOG) ?? '';
	check('flash.log 记录了发起行与 sysupgrade -c -k', index(flog, 'sysupgrade -c -k') >= 0);
}

flash.clear();

// ── 5/6/7) boot_check ────────────────────────────────────────────────────
// 非 pending：changed:false 且不动文件
baseline(false);
put_state({ state: 'boot-confirmed', target_build_id: REMOTE_BUILD, started: 1700000000, finished: 1700000100, error: '' });
let before = read(STATE);
let b1 = flash.boot_check() ?? {};
check('boot_check 非 pending 时 changed:false', b1.changed == false);
check('boot_check 非 pending 时不改状态文件（逐字相同）', read(STATE) == before);

if (!length(trim(ME.build_id ?? ''))) {
	skip('boot_check 的两个分支', '本机读不到 BUILD_ID，无法构造「相同/不同」两种结果');
}
else {
	// 目标 == 本机 BUILD_ID -> boot-confirmed
	baseline(false);
	put_state({
		state: 'flash-pending', trigger: 'manual', source: 'unit_plain', channel: 'current',
		file: IMGFILE, sha256: SHA, size: IMGSIZE,
		target_build_id: trim(ME.build_id ?? ''), target_version: 'R25.12-unit',
		previous_build_id: 'r0-unit-prev', started: 1700000000, finished: 0, error: ''
	});
	let b2 = flash.boot_check() ?? {};
	check('boot_check 目标==本机 BUILD_ID 时 changed:true', b2.changed == true);
	check('boot_check 目标==本机 BUILD_ID 时判为 boot-confirmed', b2.state == 'boot-confirmed');
	let st2 = flash.status() ?? {};
	check('boot-confirmed 已回写并盖上 finished', st2.state == 'boot-confirmed' && st2.finished > 0);
	check('boot-confirmed 清空 error', trim(st2.error ?? '') == '');

	// 第二次调用不得重复上报
	let b3 = flash.boot_check() ?? {};
	check('boot_check 第二次调用 changed:false（不重复上报）', b3.changed == false);
	check('boot_check 第二次调用后状态仍为 boot-confirmed', (flash.status() ?? {}).state == 'boot-confirmed');

	// 目标 != 本机 BUILD_ID -> flash-failed
	baseline(false);
	put_state({
		state: 'flash-pending', trigger: 'manual', source: 'unit_plain', channel: 'current',
		file: IMGFILE, sha256: SHA, size: IMGSIZE,
		target_build_id: 'r999999-unit-different', target_version: 'R99.9-unit',
		previous_build_id: trim(ME.build_id ?? ''), started: 1700000000, finished: 0, error: ''
	});
	let b4 = flash.boot_check() ?? {};
	check('boot_check 目标!=本机 BUILD_ID 时判为 flash-failed', b4.state == 'flash-failed');
	let st4 = flash.status() ?? {};
	check('flash-failed 已回写并盖上 finished', st4.state == 'flash-failed' && st4.finished > 0);
	check('flash-failed 带上了「构建标识未变」的 error', has_text(st4.error ?? '', /构建标识未变/));
}

// ── 8) clear ─────────────────────────────────────────────────────────────
let cl = flash.clear() ?? {};
check('clear 返回 ok:true', cl.ok == true);
check('clear 之后 status().state 为 idle', (flash.status() ?? {}).state == 'idle');
check('clear 之后状态文件消失', read(STATE) == null);

// ── 10/11/12) 配置归一化（纯函数，与容器/真机无关）──────────────────────
config_checks();

finish();
