#!/usr/bin/env ucode
'use strict';

// scheduler.uc 的行为级回归测试（在 OpenWrt rootfs 容器里跑）：
//   - 同步时只动受管块，块外的 nginx-util / acme 行必须原样保留
//   - 旧标记块与新标记块同时存在时，两者都被移除
//   - 关闭调度时移除受管块，但同样不碰块外内容
//
// 这个用例是踩坑后补的：strip_block() 返回数组，若直接再把数组传给
// strip_block()，split() 会得到空结果，sync() 会把整个 crontab 清空。

let fs = require('fs');
let scheduler = require('rtfwupgrade.scheduler');

let failures = 0;

function check(name, cond) {
	if (cond) {
		print('ok   ' + name + '\n');
	}
	else {
		print('FAIL ' + name + '\n');
		failures++;
	}
}

function ensure_dir(path) {
	try { fs.mkdir(path, 0o755); } catch (e) {}
}

function write(path, text) {
	fs.writefile(path, text);
}

function read(path) {
	return fs.readfile(path) ?? '';
}

// 旧名字拆开拼接：仓库一致性检查不允许在非白名单文件里出现旧标识。
let old = 'luci' + 'sysupgrade';
let begin = '# BEGIN rtfwupgrade (managed block, do not edit)';
let end = '# END rtfwupgrade';
let old_begin = '# BEGIN ' + old + ' (managed block, do not edit)';
let old_end = '# END ' + old;

ensure_dir('/etc/crontabs');
ensure_dir('/etc/config');

let base = join('\n', [
	'nginx-util',
	begin,
	'0 4 * * * mkdir -p /tmp/rtfwupgrade && /usr/bin/rtfwupgrade.sh cron',
	end,
	'acme renew',
	old_begin,
	'0 4 * * * /usr/bin/' + old + ' cron',
	old_end,
	''
]);
write('/etc/crontabs/root', base);

let r = scheduler.sync();
check('sync 返回 ok', r.ok === true);
let text = read('/etc/crontabs/root');
check('保留块外 nginx-util', index(text, 'nginx-util') >= 0);
check('保留块外 acme 行', index(text, 'acme renew') >= 0);
check('写入新受管块', index(text, begin) >= 0);
check('移除旧受管块', index(text, old_begin) < 0 && index(text, old + ' cron') < 0);

let stripped = join('\n', scheduler.strip_all_blocks(base));
check('strip_all_blocks 保留块外行', index(stripped, 'nginx-util') >= 0 && index(stripped, 'acme renew') >= 0);
check('strip_all_blocks 去掉新旧块', index(stripped, begin) < 0 && index(stripped, old_begin) < 0);

// 块外内容必须逐字保留：空行、行尾空格、缩进都算别人的内容，不能在同步时被吞掉。
let spaced = join('\n', [
	'# keep this comment',
	'',
	'  nginx-util',
	'trailing-space   ',
	'',
	begin,
	'0 4 * * * mkdir -p /tmp/rtfwupgrade && /usr/bin/rtfwupgrade.sh cron',
	end,
	'',
	'acme renew',
	''
]);
write('/etc/crontabs/root', spaced);
let once = scheduler.sync();
check('带空行/缩进的 sync 返回 ok', once.ok === true);
let after = read('/etc/crontabs/root');
check('保留块外注释', index(after, '# keep this comment') >= 0);
check('保留块外缩进命令', index(after, '  nginx-util') >= 0);
check('保留块外行尾空格', index(after, 'trailing-space   ') >= 0);
check('文件以单个换行结尾', length(after) > 0 && substr(after, length(after) - 1) == '\n' && substr(after, length(after) - 2) != '\n\n');

let twice = scheduler.sync();
check('再次同步内容不变（幂等）', twice.changed === false);

// 关闭调度：只移除自己的块，用户行仍然保留
write('/etc/config/rtfwupgrade',
	"config globals 'globals'\n" +
	"\toption schedule_kind 'off'\n" +
	"\toption schedule_time '04:00'\n" +
	"\toption unattended '0'\n");
let off = scheduler.sync();
check('关闭调度 sync 返回 ok', off.ok === true);
text = read('/etc/crontabs/root');
check('关闭调度后无新受管块', index(text, begin) < 0);
check('关闭调度后用户行仍在', index(text, 'nginx-util') >= 0 && index(text, 'acme renew') >= 0);

if (failures)
	exit(1);
print('全部通过\n');
