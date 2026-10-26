#!/usr/bin/env ucode
'use strict';
// 语义通道解析的单元测试：这几条回归过（default 布局的 'current' 曾解析成空串，
// 导致整条刷写护栏链失效），所以单独固化成断言。

let source = require('rtfwupgrade.source');

let pass = 0, fail = 0;
function eq(name, got, want) {
	if (got === want) { print(sprintf("ok   %s\n", name)); pass++; }
	else { print(sprintf("FAIL %s：期望 [%s]，实际 [%s]\n", name, want, got)); fail++; }
}

let snapLoc = { version: 'SNAPSHOT', version_kind: 'snapshot', distribution: 'ImmortalWrt' };
let relLoc  = { version: '25.12.0', version_kind: 'release', distribution: 'ImmortalWrt' };

// default 布局：只有一个 current
let defDisc = { list: [ 'current' ], origin: 'layout' };

eq("default 布局：空串解析为 current", source.resolve_channel(defDisc, snapLoc, ''), 'current');
eq("default 布局：'current' 解析为 current", source.resolve_channel(defDisc, snapLoc, 'current'), 'current');
eq("default 布局：current_channel 为 current", source.current_channel(defDisc, snapLoc), 'current');
eq("default 布局：'current' 无错误",
	length(source.resolve_for_probe(defDisc, snapLoc, 'current', '').error), 0);

// official 布局：快照与发布线
let offDisc = {
	list: [ 'snapshots', 'releases/25.12.2', 'releases/25.12.1', 'releases/24.10.6' ],
	origin: '.versions.json',
	stable: '25.12.2',
	oldstable: '24.10.6'
};

eq("official：空串（SNAPSHOT 本机）为 snapshots", source.resolve_channel(offDisc, snapLoc, ''), 'snapshots');
eq("official：'current'（SNAPSHOT 本机）为 snapshots", source.resolve_channel(offDisc, snapLoc, 'current'), 'snapshots');
eq("official：snapshot 为 snapshots", source.resolve_channel(offDisc, snapLoc, 'snapshot'), 'snapshots');
eq("official：stable 为源公布的稳定版", source.resolve_channel(offDisc, snapLoc, 'stable'), 'releases/25.12.2');
eq("official：oldstable 为源公布的旧稳定版", source.resolve_channel(offDisc, snapLoc, 'oldstable'), 'releases/24.10.6');
eq("official：具体目录原样透传", source.resolve_channel(offDisc, snapLoc, 'releases/25.12.1'), 'releases/25.12.1');

// 主/子版本需要本机是 release
eq("official：SNAPSHOT 本机的 major 不可用", source.resolve_channel(offDisc, snapLoc, 'major'), '');
eq("official：SNAPSHOT 本机的 minor 不可用", source.resolve_channel(offDisc, snapLoc, 'minor'), '');
eq("official：release 本机的 major 为 25.x 最新", source.resolve_channel(offDisc, relLoc, 'major'), 'releases/25.12.2');
eq("official：release 本机的 minor 为 25.12.x 最新", source.resolve_channel(offDisc, relLoc, 'minor'), 'releases/25.12.2');

// 非法值
eq("非法通道解析为空", source.resolve_channel(offDisc, snapLoc, 'nonsense'), '');

print(sprintf("\n通过 %d 项，失败 %d 项\n", pass, fail));
exit(fail ? 1 : 0);
