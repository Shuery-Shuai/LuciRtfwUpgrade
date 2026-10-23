'use strict';

// 源探测。只读取官方/构建系统一定自带的文件：
//   <dir>/version.buildinfo   构建标识（r<rev>-<sha>），与镜像内 BUILD_ID 同源
//   <dir>/profiles.json       目标元数据（version_number / source_date_epoch / profiles[]）
//   <base>/.versions.json     官方通道发现（可选，缺失则回退单通道）
//
// 两种 layout：
//   official  OpenWRT/ImmortalWRT 官方发布页结构
//             <base>[/<system>]/{snapshots|releases/<ver>}/targets/<target>/<subtarget>/
//   default   默认编译输出目录结构
//             <base>[/<system>]/targets/<target>/<subtarget>/

let util = require('rtfwupgrade.util');

function url_join(segments) {
	let url = '';

	for (let seg in segments) {
		let s = trim(seg ?? '');
		while (length(s) && substr(s, 0, 1) == '/')
			s = substr(s, 1);
		while (length(s) && substr(s, length(s) - 1) == '/')
			s = substr(s, 0, length(s) - 1);
		if (length(s))
			url += (length(url) ? '/' : '') + s;
	}
	return url;
}

// 从源的 system 段与地址猜它属于哪个发行版族；用于提醒「跨发行版更换 ≠ 升级」
function distro_hint(url, system) {
	for (let probe in [ lc(system ?? ''), lc(url ?? '') ]) {
		if (match(probe, /immortalwrt/))
			return 'immortalwrt';
		if (match(probe, /openwrt/))
			return 'openwrt';
	}

	return '';
}

function distro_label(hint) {
	if (hint == 'immortalwrt') return 'ImmortalWrt';
	if (hint == 'openwrt') return 'OpenWrt';

	return hint;
}

function target_path(local) {
	let path = trim(local?.board_path ?? '');
	if (length(path))
		return path;

	return trim((local?.target ?? '') + '/' + (local?.subtarget ?? ''), '/');
}

function dir_of(src, channel, local) {
	let target = target_path(local);

	if (src.layout == 'default')
		return url_join([ src.url, src.system, 'targets', target ]);

	return url_join([ src.url, src.system, channel, 'targets', target ]);
}

function discover(src) {
	if (src.layout != 'official')
		return { list: [ 'current' ], origin: 'layout' };

	let res = util.http_get(url_join([ src.url, src.system, '.versions.json' ]), 15);
	if (!res.ok)
		return { list: [ 'snapshots' ], origin: 'default' };

	let parsed = util.parse_json(res.body);
	if (!parsed.ok)
		return { list: [ 'snapshots' ], origin: 'default' };

	let v = parsed.value ?? {};
	let list = [ 'snapshots' ];
	for (let ver in (v.versions_list ?? []))
		push(list, 'releases/' + ver);

	return {
		list: list,
		origin: '.versions.json',
		stable: trim(v.stable_version ?? ''),
		oldstable: trim(v.oldstable_version ?? '')
	};
}

function series_of(version) {
	let m = match(trim(version ?? ''), /^([0-9]+)\.([0-9]+)/);
	return m ? (m[1] + '.' + m[2]) : '';
}

// 通道跟随本机：snapshot 看 snapshots，release 看同版本线
function pick_channel(disc, local) {
	let list = disc.list ?? [];
	if (local.version_kind != 'release')
		return list[0] ?? 'snapshots';

	let exact = 'releases/' + local.version;
	if (index(list, exact) >= 0)
		return exact;

	let series = series_of(local.version);
	let same = filter(list, function (c) {
		return match(c, /^releases\//) && series_of(substr(c, 9)) == series;
	});
	return length(same) ? same[0] : (list[0] ?? 'snapshots');
}

function match_profile(meta, local) {
	let profiles = meta?.profiles ?? {};
	let board = trim(local?.board_name ?? '');

	if (length(board)) {
		for (let name in keys(profiles)) {
			let p = profiles[name] ?? {};
			if (index(p.supported_devices ?? [], board) >= 0)
				return { name: name, profile: p };
		}
	}

	let guess = replace(board, /,/g, '_');
	if (length(guess) && profiles[guess] != null)
		return { name: guess, profile: profiles[guess] };

	return null;
}

// 只把 squashfs 的 sysupgrade 镜像作为升级候选；其余镜像仅在高级列表中出现
function pick_image(images) {
	let sysup = filter(images ?? [], function (i) { return i.type == 'sysupgrade'; });
	let squash = filter(sysup, function (i) { return i.filesystem == 'squashfs'; });

	if (length(squash)) return squash[0];
	if (length(sysup)) return sysup[0];
	return null;
}

function probe(src, local, channel_override) {
	let disc = discover(src);
	let channel = length(trim(channel_override ?? '')) ? trim(channel_override) : pick_channel(disc, local);
	let dir = dir_of(src, channel, local);

	let out = {
		ok: false,
		source: src.name,
		label: src.label,
		url: src.url,
		layout: src.layout,
		system: src.system,
		channel: channel,
		channel_origin: disc.origin,
		channels: disc.list,
		stable: disc.stable ?? '',
		oldstable: disc.oldstable ?? '',
		dir: dir,
		version_code: '',
		version_number: '',
		source_date_epoch: 0,
		source_date_iso: '',
		profile_name: '',
		image: null,
		images: [],
		image_limit: 0,
		warnings: [],
		error: ''
	};

	if (!length(src.url)) {
		out.error = '源未配置 url';
		return out;
	}

	let bi = util.http_get(url_join([ dir, 'version.buildinfo' ]), 15);
	if (bi.ok)
		out.version_code = trim(bi.body);
	else
		push(out.warnings, 'version.buildinfo 不可读');

	let pj = util.http_get(url_join([ dir, 'profiles.json' ]), 25);
	if (!pj.ok) {
		out.error = 'profiles.json 不可读：' + dir;
		return out;
	}

	let parsed = util.parse_json(pj.body);
	if (!parsed.ok) {
		out.error = 'profiles.json 解析失败：' + parsed.error;
		return out;
	}

	let meta = parsed.value ?? {};
	out.version_number = trim(meta.version_number ?? '');
	out.source_date_epoch = util.epoch_or_zero(meta.source_date_epoch);
	out.source_date_iso = util.iso_utc(out.source_date_epoch);

	if (!length(out.version_code))
		out.version_code = trim(meta.version_code ?? '');

	let hit = match_profile(meta, local);
	if (hit == null) {
		out.error = '该源未收录此设备（board_name=' + (local.board_name ?? '?') + '）';
		return out;
	}

	out.profile_name = hit.name;
	out.images = hit.profile.images ?? [];
	out.image = pick_image(out.images);
	out.image_limit = util.epoch_or_zero((hit.profile.file_size_limits ?? {}).image);

	if (out.image == null)
		push(out.warnings, '该 profile 没有 sysupgrade 镜像');

	let hint = distro_hint(src.url, src.system);
	if (length(hint) && length(local?.distribution) && index(lc(local.distribution), hint) < 0)
		push(out.warnings, sprintf('该源属于 %s，而本机运行 %s：跨发行版更换属于「换系统」，配置文件可能不兼容，不要当成普通升级',
			distro_label(hint), local.distribution));

	out.ok = true;
	return out;
}

return {
	url_join: url_join,
	dir_of: dir_of,
	discover: discover,
	distro_hint: distro_hint,
	series_of: series_of,
	pick_channel: pick_channel,
	match_profile: match_profile,
	pick_image: pick_image,
	probe: probe
};
