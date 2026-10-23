'use strict';

// UCI 配置读取（/etc/config/rtfwupgrade）。
// 源列表可存多条，但同一时刻只有一条 active_source 生效。
//
// 布局类型只有两种：
//   official  OpenWRT/ImmortalWRT 官方发布页结构 root/releases/release/targets
//   default   默认编译输出目录结构 root/targets
// 旧配置里的 bin_targets_root 只是历史别名，读入时归一化为 default。

let uci = require('uci');

const CONFIG = 'rtfwupgrade';
const LAYOUTS = [ 'official', 'default' ];
const LAYOUT_ALIASES = { bin_targets_root: 'default' };
const SCHEDULE_KINDS = [ 'off', 'daily', 'weekly', 'monthly' ];
// 注意：ucode 的 substr 按字节切，中文字符 3 字节 —— 取星期必须用数组映射
const WEEKDAY_LABELS = [ '一', '二', '三', '四', '五', '六', '日' ];

function normalize_layout(layout) {
	let value = trim(layout ?? '');
	return LAYOUT_ALIASES[value] ?? value;
}

function defaults() {
	return {
		unattended: 0,
		schedule_kind: 'daily',
		schedule_time: '04:00',
		schedule_weekday: 1,
		schedule_day: 1,
		webhook: '',
		active_source: 'immortalwrt_official',
		sources: [
			{ name: 'immortalwrt_official', label: 'ImmortalWrt 官方', url: 'https://downloads.immortalwrt.org', layout: 'official', system: '' },
			{ name: 'openwrt_official', label: 'OpenWrt 官方', url: 'https://downloads.openwrt.org', layout: 'official', system: '' },
			{ name: 'rtfw_immortalwrt', label: 'RTFW 聚合站（immortalwrt）', url: 'https://rtfw.shuery.lssa.fun', layout: 'official', system: 'immortalwrt' }
		]
	};
}

function section_name(s) {
	return s['.name'] ?? s.name ?? '';
}

function load() {
	let g = {};
	let sources = [];

	try {
		let ctx = uci.cursor();

		// rpcd 是长驻进程，而 ucode 的 uci 模块带进程级配置缓存：
		// 不显式 reload 就会读到本进程启动时的旧配置 —— 表现为切换激活源之后
		// 仍然去探测上一个源，结论来源与界面显示不一致。
		ctx.load(CONFIG);

		g = ctx.get_all(CONFIG, 'globals') ?? {};

		ctx.foreach(CONFIG, 'source', function (s) {
			let name = section_name(s);
			if (!length(name))
				return;
			push(sources, {
				name: name,
				label: trim(s.label ?? name),
				url: trim(s.url ?? ''),
				layout: normalize_layout(s.layout ?? 'official'),
				system: trim(s.system ?? '')
			});
		});
	} catch (e) {
		g = {};
		sources = [];
	}

	if (!length(sources))
		sources = defaults().sources;

	// 源只有“存在”与“激活”两种状态：没有 enabled 中间态。
	// 激活源缺失或指向不存在的段时，退回列表里的第一个源。
	let active = trim(g.active_source ?? '');
	let hit = filter(sources, function (s) { return s.name == active; });
	if (!length(hit))
		active = length(sources) ? sources[0].name : '';

	return {
		unattended: int(g.unattended ?? 0),
		schedule_kind: trim(g.schedule_kind ?? 'daily'),
		schedule_time: trim(g.schedule_time ?? '04:00'),
		schedule_weekday: int(g.schedule_weekday ?? 1),
		schedule_day: int(g.schedule_day ?? 1),
		webhook: trim(g.webhook ?? ''),
		active_source: active,
		sources: sources
	};
}

function active(conf) {
	let c = conf ?? load();
	let hit = filter(c.sources, function (s) { return s.name == c.active_source; });
	return length(hit) ? hit[0] : null;
}

// 把调度配置翻成 5 段 cron（scheduler.uc 写 crontabs 用；也用于界面与日志里的可读说明）
function schedule_cron(conf) {
	let kind = trim(conf?.schedule_kind ?? 'daily');
	if (kind == 'off')
		return '';

	let t = match(trim(conf?.schedule_time ?? '04:00'), /^([0-9]{1,2}):([0-9]{2})$/);
	let hour = t ? '' + int(t[1]) : '4';
	let min = t ? '' + int(t[2]) : '0';

	if (kind == 'weekly')
		return sprintf('%s %s * * %d', min, hour, int(conf?.schedule_weekday ?? 1));
	if (kind == 'monthly')
		return sprintf('%s %s %d * *', min, hour, int(conf?.schedule_day ?? 1));

	return sprintf('%s %s * * *', min, hour);
}

function schedule_label(conf) {
	let kind = trim(conf?.schedule_kind ?? 'daily');
	if (kind == 'off')
		return '关闭';

	let time = trim(conf?.schedule_time ?? '04:00');
	if (kind == 'weekly')
		return sprintf('每周%s %s', WEEKDAY_LABELS[int(conf?.schedule_weekday ?? 1) - 1] ?? '?', time);

	if (kind == 'monthly')
		return sprintf('每月 %d 号 %s', int(conf?.schedule_day ?? 1), time);

	return '每天 ' + time;
}

function unattended_label(level) {
	let labels = [ '仅检测并通知', '检测后自动下载', '检测后自动下载并刷写' ];
	return labels[int(level ?? 0)] ?? labels[0];
}

return {
	CONFIG: CONFIG,
	LAYOUTS: LAYOUTS,
	SCHEDULE_KINDS: SCHEDULE_KINDS,
	normalize_layout: normalize_layout,
	schedule_cron: schedule_cron,
	schedule_label: schedule_label,
	defaults: defaults,
	load: load,
	active: active,
	unattended_label: unattended_label
};
