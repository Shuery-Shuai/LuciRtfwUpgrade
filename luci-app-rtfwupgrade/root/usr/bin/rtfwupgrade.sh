#!/usr/bin/env ucode
'use strict';

// luci-app-rtfwupgrade CLI（检测 + 下载，不刷写）

let util = require('rtfwupgrade.util');
let local = require('rtfwupgrade.local');
let config = require('rtfwupgrade.config');
let check = require('rtfwupgrade.check');
let state = require('rtfwupgrade.state');
let scheduler = require('rtfwupgrade.scheduler');
let download = require('rtfwupgrade.download');
let eventlog = require('rtfwupgrade.eventlog');

let version = require('rtfwupgrade.version');
const VERSION = version.VERSION;

function usage() {
	print("用法: rtfwupgrade.sh <命令> [选项]\n\n");
	print("命令:\n");
	print("  status           本机标识与最近一次检测结果\n");
	print("  sources          已配置的源（含激活源）\n");
	print("  check            检测更新（默认使用激活源）\n");
	print("  cron             定时任务入口：检测 + 按无人值守档位自动下载\n");
	print("  schedule         查看/同步 crontab 定时任务（--apply 写入）\n");
	print("  version          版本号\n\n");
	print("选项:\n");
	print("  --source <name>  仅本次使用指定源\n");
	print("  --channel <dir>  仅本次使用指定通道目录（如 releases/25.12.2）\n");
	print("  --json           以 JSON 输出\n");
	print("  --apply          仅 schedule：把调度写入 crontab\n");
}

function parse_argv(argv) {
	let o = { cmd: '', source: '', channel: '', json: false, apply: false };
	let i = 0;

	while (i < length(argv)) {
		let a = trim(argv[i] ?? '');
		if (a == '--json')
			o.json = true;
		else if (a == '--apply')
			o.apply = true;
		else if (a == '--source') { i++; o.source = trim(argv[i] ?? ''); }
		else if (a == '--channel') { i++; o.channel = trim(argv[i] ?? ''); }
		else if (a == '-h' || a == '--help') { o.cmd = 'help'; }
		else if (!length(o.cmd)) { o.cmd = a; }
		i++;
	}
	return o;
}

function run_check(opts, conf) {
	return check.run({
		conf: conf ?? config.load(),
		source: opts.source,
		channel: opts.channel
	});
}

// 定时任务入口：检测（check.uc 已记录事件/投递 webhook）→ 按档位决定是否自动下载
function run_cron(opts) {
	let conf = config.load();
	let r = run_check(opts, conf);
	let out = {
		ok: r.ok,
		ts: util.now_epoch(),
		verdict: r.verdict?.state ?? '',
		label: r.verdict?.label ?? '',
		unattended: conf.unattended,
		action: 'none'
	};

	// update 与 rebuild 都意味着远端有一份新构建；downgrade 不自动下载。
	if ((r.verdict?.state == 'update' || r.verdict?.state == 'rebuild') && conf.unattended >= 1) {
		let d = download.start(opts.source ?? '', opts.channel ?? '');

		if (d.state == 'running') {
			out.action = 'download';
		}
		else if (d.state == 'verified') {
			out.action = d.skipped ? 'already-downloaded' : 'verified';
		}
		else {
			out.action = 'download-failed';
			out.error = d.error ?? '?';
			eventlog.append('error', 'download', '自动下载失败：' + (d.error ?? '?'));
		}

		if (conf.unattended >= 2) {
			out.note = '档位 2 需要刷写能力，尚未实现（M3）';
			eventlog.append('warn', 'cron', '无人值守档位 2 需要刷写能力，当前仅下载');
		}
	}

	return out;
}

function fmt_size(bytes) {
	let n = int(bytes ?? 0);
	if (!n)
		return '未知';
	if (n >= 1048576)
		return sprintf('%.1f MB', n / 1048576.0);
	return sprintf('%.1f KB', n / 1024.0);
}

function print_check_human(r) {
	let loc = r.local ?? {};
	let rem = r.remote ?? {};
	let vs = r.verdict ?? {};

	print(sprintf('本机   : %s (%s %s)\n', loc.hostname ?? '', loc.distribution ?? '', loc.version ?? ''));
	print(sprintf('板型   : %s [%s]\n', loc.board_name ?? '?', loc.target ?? '?'));
	print(sprintf('构建   : %s @ %s\n', loc.build_id ?? '?', loc.build_date_iso ?? '?'));

	if (rem.ok) {
		print(sprintf('源     : %s <%s> [%s]\n', rem.label ?? '', rem.url ?? '', rem.layout ?? ''));
		print(sprintf('通道   : %s（来自 %s）\n', rem.channel ?? '', rem.channel_origin ?? ''));
		print(sprintf('远端   : %s @ %s\n', rem.version_code ?? '?', rem.source_date_iso || '?'));
	}
	else {
		print(sprintf('源     : %s <%s>\n', rem.label ?? r.source?.label ?? '', rem.url ?? r.source?.url ?? ''));
	}

	print(sprintf('结论   : %s\n', vs.label ?? '未知'));
	print(sprintf('依据   : %s\n', vs.evidence ?? ''));

	if (rem.image != null)
		print(sprintf('镜像   : %s (%s)\n', rem.image.name ?? '', fmt_size(rem.image.size)));

	if (length(rem.warnings ?? []))
		for (let w in rem.warnings)
			print(sprintf('提示   : %s\n', w));

	if (!r.ok)
		print(sprintf('错误   : %s\n', rem.error ?? r.error ?? '探测失败'));
}

function print_status_human(s) {
	let loc = s.local ?? {};
	print(sprintf('主机   : %s\n', loc.hostname ?? ''));
	print(sprintf('系统   : %s %s (%s)\n', loc.distribution ?? '', loc.version ?? '', loc.version_kind ?? ''));
	print(sprintf('板型   : %s [%s] %s\n', loc.board_name ?? '?', loc.board_path ?? loc.target ?? '?', loc.model ?? ''));
	print(sprintf('构建   : %s @ %s\n', loc.build_id ?? '?', loc.build_date_iso ?? '?'));

	let last = s.last;
	if (last == null) {
		print("最近   : 尚未检测\n");
		return;
	}
	print(sprintf('最近   : %s（%s）\n', last.verdict?.label ?? '未知', util.iso_utc(last.ts) || ('epoch ' + (last.ts ?? 0))));
	let rid = trim(last.remote?.version_code ?? '');
	print(sprintf('       源 %s，远端 %s\n', last.source?.label ?? last.remote?.label ?? '?', length(rid) ? rid : '-'));
}

function print_sources_human(conf) {
	for (let s in conf.sources) {
		print(sprintf('%s %-22s %-10s %s\n',
			(s.name == conf.active_source) ? '*' : ' ',
			s.name, s.layout, s.url + (length(s.system) ? (' / ' + s.system) : '')));
	}
	print(sprintf("激活源  : %s\n", conf.active_source ?? '无'));
	print(sprintf("无人值守: %d 档（%s）\n", conf.unattended, config.unattended_label(conf.unattended)));
	print(sprintf("调度    : %s\n", config.schedule_label(conf)));
	print(sprintf("定时行  : %s\n", scheduler.cron_line(conf) || '（关闭）'));
}

let opts = parse_argv(ARGV ?? []);
let conf = config.load();

switch (opts.cmd) {
case 'check': {
	let r = run_check(opts, conf);
	if (opts.json) print(sprintf('%J\n', r));
	else print_check_human(r);
	exit(r.ok ? 0 : 1);
	break;
}
case 'status': {
	let r = {
		version: VERSION,
		ts: util.now_epoch(),
		local: local.identity(),
		config: conf,
		last: state.load_last()
	};
	if (opts.json) print(sprintf('%J\n', r));
	else print_status_human(r);
	break;
}
case 'sources': {
	let r = { config: conf };
	if (opts.json) print(sprintf('%J\n', r));
	else print_sources_human(conf);
	break;
}
case 'cron': {
	let r = run_cron(opts);
	if (opts.json) print(sprintf('%J\n', r));
	else print(sprintf('%s：%s（档位 %d，动作 %s%s）\n',
		r.label || '未检测', r.verdict || '-', r.unattended, r.action,
		r.error ? ('，' + r.error) : ''));
	break;
}
case 'schedule': {
	let st = scheduler.status();
	if (opts.apply) {
		let r = scheduler.sync();
		if (opts.json) print(sprintf('%J\n', r));
		else print((r.changed ? '已写入：' : '无需变更：') + (r.line || '（定时任务已关闭）') + "\n");
		break;
	}
	if (opts.json) print(sprintf('%J\n', st));
	else {
		print(sprintf('调度    : %s\n', st.schedule || '关闭'));
		print(sprintf('期望行  : %s\n', st.wanted || '（无）'));
		print(sprintf('实际行  : %s\n', st.applied || '（无）'));
		print(sprintf('是否一致: %s\n', st.in_sync ? '是' : '否'));
	}
	break;
}
case 'version':
	print(VERSION + "\n");
	break;
default:
	usage();
	exit(1);
}
