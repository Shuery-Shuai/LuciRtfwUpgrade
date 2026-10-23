'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require rtfwupgrade.format as fmt';

var callStatus = rpc.declare({ object: 'rtfwupgrade', method: 'status' });
var callCheck = rpc.declare({ object: 'rtfwupgrade', method: 'check', params: ['source', 'channel'] });
var callDownload = rpc.declare({ object: 'rtfwupgrade', method: 'download', params: ['source', 'channel'] });
var callDownloadStatus = rpc.declare({ object: 'rtfwupgrade', method: 'download_status' });
var callCancel = rpc.declare({ object: 'rtfwupgrade', method: 'cancel' });
var callCleanup = rpc.declare({ object: 'rtfwupgrade', method: 'cleanup' });
var callFlash = rpc.declare({ object: 'rtfwupgrade', method: 'flash', params: ['source', 'channel', 'force'] });
var callFlashStatus = rpc.declare({ object: 'rtfwupgrade', method: 'flash_status' });
var callFlashClear = rpc.declare({ object: 'rtfwupgrade', method: 'flash_clear' });

function sheet() {
	return E('link', { rel: 'stylesheet', href: L.resource('rtfwupgrade/rtfwupgrade.css') });
}

function replace(node, children) {
	while (node.firstChild) node.removeChild(node.firstChild);
	(children || []).forEach(function (c) {
		if (c) node.appendChild(c);
	});
}

// 刷写卡片要显示镜像文件名：后端给的是绝对路径，只留最后一段
function basename(path) {
	var parts = String(path || '').split('/');

	return parts[parts.length - 1] || '';
}

// 跨发行版警告来自后端（source.uc 的中文提示，按项目约定不翻译），
// 这里只负责识别它：force 勾选框是否出现由它决定。
function isCrossDistro(w) {
	return /跨发行版|cross-distribut/i.test(String(w || ''));
}

// 续传检查：后端在 start() 里判断能否 -C - 续传，并把原因写进 resume_reason。
// 失败/取消/进行中都要让用户看到“为什么这次没有续传”。
function resumeNote(d) {
	return E('p', { class: 'rtfw-muted' }, _('Resume check: %s').format((d && d.resume_reason) || '-'));
}

return view.extend({
	load: function () {
		return Promise.all([
			callStatus(),
			callFlashStatus().catch(function () {
				return null;
			})
		]);
	},

	render: function (loaded) {
		// load() 用 Promise.all 同时取状态与刷写状态；这里兼容只传单个 status 的情况
		// （刷写状态缺失时按 idle 渲染）。
		var status = (Array.isArray(loaded) ? loaded[0] : loaded) || {};
		var flashStatus = Array.isArray(loaded) ? loaded[1] : null;
		var conf = status.config || {};
		var loc = status.local || {};

		this.activeSource = conf.active_source || '';
		this.download = status.download || { state: 'idle' };
		this.last = status.last || null;
		this.flash = this.normalizeFlash(flashStatus);
		this.flashConfirm = false;
		this.flashForce = false;
		this.flashErrors = [];
		this.resultNode = E('div', {}, E('p', { class: 'rtfw-muted' }, _('No check has been run yet.')));

		var view = E('div', {}, [
			sheet(),
			E('h2', {}, _('Router Firmware Update')),
			E(
				'p',
				{ class: 'rtfw-muted' },
				_(
					'Detection and image download are read-only. Flashing is a separate step and only runs after an explicit confirmation.'
				)
			),

			E('div', { class: 'rtfw-toolbar' }, [
				E(
					'button',
					{
						class: 'btn cbi-button cbi-button-action',
						click: ui.createHandlerFn(this, 'handleCheck')
					},
					_('Check for updates')
				)
			]),

			E('h3', {}, _('Local system')),
			E('div', { class: 'rtfw-grid' }, [
				fmt.stat(_('Build id'), loc.build_id),
				fmt.stat(_('Source date'), (loc.build_date_iso || '').replace(' UTC', ''), 'OPENWRT_BUILD_DATE'),
				fmt.stat(_('Board'), loc.board_name, loc.board_path),
				fmt.stat(_('Distribution'), (loc.distribution || '') + ' ' + (loc.version || ''))
			]),

			(this.downloadNode = E('div', {}, this.buildDownload())),

			(this.flashNode = E('div', {}, this.buildFlash())),

			E('h3', {}, _('Result')),
			this.resultNode
		]);

		if (status.last && status.last.verdict) replace(this.resultNode, this.buildResult(status.last, true));

		if (this.download.state === 'running') this.startPolling();

		return view;
	},

	buildResult: function (res, cached) {
		var vs = res.verdict || {};
		var rem = res.remote || {};
		var loc = res.local || {};
		var nodes = [];

		nodes.push(
			E('div', { class: 'rtfw-toolbar' }, [
				fmt.badge(vs.state, vs.label),
				E(
					'span',
					{ class: 'rtfw-muted' },
					'%s %s'.format(
						cached ? _('cached result from') : _('checked at'),
						new Date((res.ts || 0) * 1000).toISOString().replace('T', ' ').substr(0, 16) + ' UTC'
					)
				)
			])
		);

		nodes.push(
			E('div', { class: 'rtfw-grid' }, [
				fmt.stat(_('Local build id'), loc.build_id),
				fmt.stat(_('Local source date'), (loc.build_date_iso || '').replace(' UTC', '')),
				fmt.stat(_('Remote build id'), rem.version_code || '-'),
				fmt.stat(
					_('Remote source date'),
					(rem.source_date_iso || '').replace(' UTC', ''),
					rem.channel ? _('channel') + ': ' + rem.channel : ''
				)
			])
		);

		if (!res.ok)
			nodes.push(fmt.callout('danger', _('Detection failed'), rem.error || res.error || _('Unknown error')));

		nodes.push(
			fmt.kvTable(
				[_('Item'), _('Local'), _('Remote')],
				[
					[_('Build id'), loc.build_id, rem.version_code],
					[_('Source date'), loc.build_date_iso, rem.source_date_iso],
					[
						_('Channel'),
						loc.version,
						rem.channel ? rem.channel + ' (' + (rem.channel_origin || '') + ')' : ''
					],
					[_('Source'), '-', (rem.label || '') + ' <' + (rem.url || '') + '>'],
					[_('Profile'), loc.board_name, rem.profile_name]
				]
			)
		);

		nodes.push(
			fmt.callout(
				vs.state === 'downgrade' ? 'warning' : vs.state === 'update' ? 'success' : '',
				_('Verdict basis'),
				vs.evidence || '-'
			)
		);

		if (rem.image) {
			nodes.push(E('h3', {}, _('Candidate image')));
			nodes.push(
				fmt.kvTable(
					[_('Item'), _('Value')],
					[
						[_('File'), rem.image.name],
						[
							_('Size'),
							fmt.fmtSize(rem.image.size) +
								(rem.image_limit ? ' / %s'.format(fmt.fmtSize(rem.image_limit)) : '')
						],
						['sha256', rem.image.sha256]
					]
				)
			);
		}

		if ((rem.images || []).length > 1) {
			nodes.push(
				E('details', { class: 'rtfw-images' }, [
					E('summary', {}, _('All images (%d)').format(rem.images.length)),
					fmt.callout(
						'warning',
						_('Do not flash these by hand'),
						_(
							'Only the squashfs sysupgrade image is offered as an upgrade candidate. Preloader, BL31/U-Boot, GPT and sdcard images rewrite the boot chain or the partition table; a wrong pick bricks the device instead of failing the upgrade.'
						)
					),
					fmt.kvTable(
						[_('Type'), _('Filesystem'), _('File'), _('Size')],
						rem.images.map(function (i) {
							return [i.type || '-', i.filesystem || '-', i.name || '-', fmt.fmtSize(i.size)];
						})
					)
				])
			);
		}

		(rem.warnings || []).forEach(function (w) {
			nodes.push(fmt.callout('warning', _('Warning'), w));
		});

		return nodes;
	},

	// 刷写状态也兼容桩环境返回 undefined：一律落到四态里的 idle
	normalizeFlash: function (st) {
		var s = st || {};
		var states = ['idle', 'flash-pending', 'boot-confirmed', 'flash-failed'];
		var state = states.indexOf(s.state) >= 0 ? s.state : 'idle';

		return {
			state: state,
			trigger: s.trigger || '',
			source: s.source || '',
			channel: s.channel || '',
			file: s.file || '',
			sha256: s.sha256 || '',
			size: s.size || 0,
			target_build_id: s.target_build_id || '',
			target_version: s.target_version || '',
			previous_build_id: s.previous_build_id || '',
			started: s.started || 0,
			finished: s.finished || 0,
			error: s.error || ''
		};
	},

	// 待刷写状态优先读状态文件（它才是真正要写入设备的那个文件）；
	// 没有待刷写记录时回落到已下载并校验过的那个文件（绝对路径，命令要用的就是它）。
	// name 只用于展示，path 才是真正写进 sysupgrade 参数里的东西。
	flashTarget: function () {
		var rem = (this.last && this.last.remote) || {};
		var img = rem.image || {};
		var st = this.flash || {};
		var dl = this.download || {};
		var pending = st.state !== 'idle' && st.state !== undefined;
		var path = (pending && st.file) || (dl.state === 'verified' && dl.file) || '';

		return {
			version: (pending && st.target_version) || rem.version_number || rem.version_code || '',
			build_id: (pending && st.target_build_id) || rem.version_code || '',
			name: path ? basename(path) : img.name || '',
			path: path,
			size: (pending && st.size) || dl.size || img.size || 0
		};
	},

	crossDistroWarnings: function () {
		var rem = (this.last && this.last.remote) || {};

		return (rem.warnings || []).filter(isCrossDistro);
	},

	flashLocalErrors: function (st) {
		var errors = [];
		var state = this.normalizeFlash(st).state;

		if (state === 'flash-pending')
			errors.push(_('A flash is already pending. Reboot the router and let the boot check confirm it first.'));

		if (!this.last || !this.last.ok)
			errors.push(_('Run a check first: nothing tells which image this device should be flashed with.'));

		if (!this.download || this.download.state !== 'verified')
			errors.push(_('The image has not been downloaded and verified yet.'));

		if (this.crossDistroWarnings().length && !this.flashForce)
			errors.push(
				_('This source belongs to a different distribution. Tick the cross-distribution override first.')
			);

		return errors;
	},

	// 四项核对 + 不可逆警示 + 确认勾选 + 状态机展示
	buildFlash: function () {
		var self = this;
		var st = this.flash || { state: 'idle' };
		var target = this.flashTarget();
		var cross = this.crossDistroWarnings();
		var nodes = [E('h3', {}, _('Flash firmware'))];

		if (st.state === 'flash-pending')
			nodes.push(
				fmt.callout(
					'warning',
					_('Waiting for reboot confirmation'),
					_(
						'The image was written and sysupgrade was started. The state is confirmed after the router reboots.'
					)
				)
			);

		if (st.state === 'boot-confirmed')
			nodes.push(
				fmt.callout(
					'success',
					_('Flash confirmed after reboot'),
					_('The build id after reboot matches the target: %s').format(st.target_build_id || '-')
				)
			);

		if (st.state === 'flash-failed')
			nodes.push(
				fmt.callout(
					'danger',
					_('Flash not confirmed'),
					_('After reboot the build id is %s while the target was %s.').format(
						st.previous_build_id || '-',
						st.target_build_id || '-'
					) + (st.error ? ' ' + st.error : '')
				)
			);

		nodes.push(
			E('div', { class: 'rtfw-grid' }, [
				fmt.stat(_('Target version'), target.version),
				fmt.stat(_('Target build id'), target.build_id),
				fmt.stat(_('Image file'), target.name || '-', target.path || ''),
				fmt.stat(_('Image size'), fmt.fmtSize(target.size))
			])
		);

		nodes.push(
			fmt.callout(
				'danger',
				_('This cannot be undone'),
				_(
					'Flashing reboots the router: the network drops until it is back, and everything written to /tmp is lost. Existing configuration is kept, because sysupgrade runs with -k -c.'
				)
			)
		);

		if (st.state === 'flash-failed') {
			nodes.push(
				E('div', { class: 'rtfw-toolbar' }, [
					E(
						'button',
						{
							class: 'btn cbi-button cbi-button-reset',
							click: ui.createHandlerFn(this, 'handleFlashClear')
						},
						_('Clear flash state')
					)
				])
			);
		}

		this.flashConfirmBox = E('input', {
			type: 'checkbox',
			checked: this.flashConfirm ? 'checked' : null,
			change: function (ev) {
				self.flashConfirm = !!ev.target.checked;
				self.syncFlashButton();
			}
		});

		nodes.push(
			E('div', { class: 'rtfw-toolbar' }, [
				E('label', {}, [this.flashConfirmBox, ' ' + _('I confirm: flash this image and reboot the router.')])
			])
		);

		if (cross.length) {
			this.flashForceBox = E('input', {
				type: 'checkbox',
				checked: this.flashForce ? 'checked' : null,
				change: function (ev) {
					self.flashForce = !!ev.target.checked;
					self.syncFlashButton();
				}
			});

			nodes.push(
				fmt.callout('warning', _('Cross-distribution change'), [
					E(
						'ul',
						{},
						cross.map(function (w) {
							return E('li', {}, w);
						})
					),
					E('div', { class: 'rtfw-toolbar' }, [
						E('label', {}, [this.flashForceBox, ' ' + _('Allow cross-distribution flashing (force)')])
					])
				])
			);
		}

		this.flashErrorNode = E('div', {}, this.buildFlashErrors());

		nodes.push(this.flashErrorNode);

		this.flashButton = E(
			'button',
			{
				class: 'btn cbi-button cbi-button-negative',
				disabled: this.flashBlocked() ? 'disabled' : null,
				click: ui.createHandlerFn(this, 'handleFlashNow')
			},
			_('Flash now')
		);

		nodes.push(E('div', { class: 'rtfw-toolbar' }, [this.flashButton]));

		nodes.push(
			E(
				'p',
				{ class: 'rtfw-muted' },
				_('The command is: %s').format('sysupgrade -k -c ' + (target.path || '/tmp/rtfwupgrade/<image>'))
			)
		);

		return nodes;
	},

	buildFlashErrors: function () {
		var errors = this.flashErrors || [];

		if (!errors.length) return [E('span', { class: 'rtfw-muted' }, _('No blocking problem found so far.'))];

		return [
			fmt.callout(
				'danger',
				_('Flashing is blocked'),
				E(
					'ul',
					{},
					errors.map(function (e) {
						return E('li', {}, e);
					})
				)
			)
		];
	},

	flashBlocked: function () {
		if (!this.flashConfirm) return true;
		if (this.crossDistroWarnings().length && !this.flashForce) return true;

		return false;
	},

	syncFlashButton: function () {
		if (this.flashButton) this.flashButton.disabled = this.flashBlocked();
	},

	renderFlash: function () {
		if (this.flashNode) replace(this.flashNode, this.buildFlash());
	},

	buildDownload: function () {
		var d = this.download || { state: 'idle' };
		var nodes = [E('h3', {}, _('Image download'))];

		switch (d.state) {
			case 'running':
				nodes.push(E('div', { class: 'rtfw-bar' }, E('span', { style: 'width:' + (d.percent || 0) + '%' })));
				nodes.push(
					E(
						'div',
						{ class: 'rtfw-muted' },
						'%s / %s（%d%%）%s'.format(
							fmt.fmtSize(d.received),
							fmt.fmtSize(d.size),
							d.percent || 0,
							d.resumed_from ? _('resumed') : ''
						)
					)
				);
				if (d.resume_reason) nodes.push(resumeNote(d));
				nodes.push(
					fmt.callout(
						'',
						_('Downloading…'),
						_(
							'The file goes to /tmp (RAM). Flashing is a separate step and only runs after an explicit confirmation.'
						)
					)
				);
				nodes.push(
					E('div', { class: 'rtfw-toolbar' }, [
						E(
							'button',
							{
								class: 'btn cbi-button cbi-button-reset',
								click: ui.createHandlerFn(this, 'handleCancel')
							},
							_('Cancel')
						)
					])
				);
				break;

			case 'verified':
				nodes.push(
					fmt.callout(
						'success',
						_('Downloaded and verified'),
						_('The sha256 matches the one published by the source. The image is ready to flash.')
					)
				);
				nodes.push(
					fmt.kvTable(
						[_('Item'), _('Value')],
						[
							[_('File'), d.file],
							[_('Size'), fmt.fmtSize(d.size)],
							['sha256', d.sha256]
						]
					)
				);
				nodes.push(
					E('div', { class: 'rtfw-toolbar' }, [
						E(
							'button',
							{
								class: 'btn cbi-button cbi-button-reset',
								click: ui.createHandlerFn(this, 'handleCleanup')
							},
							_('Delete file')
						)
					])
				);
				break;

			case 'failed':
				nodes.push(fmt.callout('danger', _('Download failed'), d.error || _('Unknown error')));
				if (d.resume_reason) nodes.push(resumeNote(d));
				nodes.push(
					E('div', { class: 'rtfw-toolbar' }, [
						E(
							'button',
							{
								class: 'btn cbi-button cbi-button-action',
								click: ui.createHandlerFn(this, 'handleDownload')
							},
							_('Retry download')
						),
						E(
							'button',
							{
								class: 'btn cbi-button cbi-button-reset',
								click: ui.createHandlerFn(this, 'handleCleanup')
							},
							_('Delete file')
						)
					])
				);
				break;

			case 'cancelled':
				nodes.push(
					fmt.callout(
						'warning',
						_('Download cancelled'),
						_(
							'The partial file is kept, so a retry resumes instead of starting over (the ETag is compared first).'
						)
					)
				);
				if (d.resume_reason) nodes.push(resumeNote(d));
				nodes.push(
					E('div', { class: 'rtfw-toolbar' }, [
						E(
							'button',
							{
								class: 'btn cbi-button cbi-button-action',
								click: ui.createHandlerFn(this, 'handleDownload')
							},
							_('Resume download')
						),
						E(
							'button',
							{
								class: 'btn cbi-button cbi-button-reset',
								click: ui.createHandlerFn(this, 'handleCleanup')
							},
							_('Delete file')
						)
					])
				);
				break;

			default:
				nodes.push(
					E(
						'div',
						{ class: 'rtfw-muted' },
						_('Downloads the candidate image to /tmp and verifies its sha256. Flashing is a separate step.')
					)
				);
				nodes.push(
					E('div', { class: 'rtfw-toolbar' }, [
						E(
							'button',
							{
								class: 'btn cbi-button cbi-button-action',
								click: ui.createHandlerFn(this, 'handleDownload')
							},
							_('Download image')
						)
					])
				);
		}

		return nodes;
	},

	renderDownload: function () {
		if (this.downloadNode) replace(this.downloadNode, this.buildDownload());
		// 下载状态决定刷写按钮的前提条件（必须 verified），卡片要跟着一起刷新
		this.renderFlash();
	},

	startPolling: function () {
		if (this.pollFn) return;

		this.pollFn = L.bind(this.pollDownload, this);
		poll.add(this.pollFn);
	},

	stopPolling: function () {
		if (!this.pollFn) return;

		poll.remove(this.pollFn);
		this.pollFn = null;
	},

	pollDownload: function () {
		var self = this;

		return callDownloadStatus().then(function (d) {
			self.download = d || { state: 'idle' };
			self.renderDownload();
			if (self.download.state !== 'running') self.stopPolling();
		});
	},

	handleCheck: function (ev) {
		var self = this;
		var btn = ev.currentTarget;

		btn.disabled = true;
		btn.classList.add('spinning');

		return callCheck(this.activeSource, '')
			.then(function (res) {
				replace(self.resultNode, self.buildResult(res, false));
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Check failed: ') + (err.message || err)), 'error');
			})
			.finally(function () {
				btn.disabled = false;
				btn.classList.remove('spinning');
			});
	},

	handleDownload: function () {
		var self = this;

		return callDownload(this.activeSource, '')
			.then(function (res) {
				if (!res || res.ok === false) throw new Error((res && res.error) || _('Download failed'));

				self.download = res;
				self.renderDownload();
				if (res.state === 'running') self.startPolling();
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Download failed: ') + (err.message || err)), 'error');
			});
	},

	handleCancel: function () {
		var self = this;

		return callCancel()
			.then(function (res) {
				if (!res || res.ok === false) throw new Error((res && res.error) || _('Cancel failed'));

				return self.pollDownload();
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Cancel failed: ') + (err.message || err)), 'error');
			});
	},

	handleCleanup: function () {
		var self = this;

		return callCleanup()
			.then(function () {
				self.download = { state: 'idle' };
				self.renderDownload();
				ui.addNotification(null, E('p', {}, _('Downloaded file deleted.')), 'info');
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Delete failed: ') + (err.message || err)), 'error');
			});
	},

	// 点击后先取一次 flash_status 与本地必要条件，任何一条不满足就逐条列出并中止；
	// 全部通过才把 force 传成 '1'（后端只认字符串 '1'）。
	handleFlashNow: function () {
		var self = this;

		return callFlashStatus()
			.catch(function () {
				return null;
			})
			.then(function (st) {
				self.flash = self.normalizeFlash(st);
				self.flashErrors = self.flashLocalErrors(st);

				if (self.flashErrors.length) {
					replace(self.flashErrorNode, self.buildFlashErrors());
					ui.addNotification(
						null,
						E('p', {}, _('Flashing is blocked: fix the problems listed above.')),
						'error'
					);
					return false;
				}

				return callFlash(self.activeSource, '', self.flashForce ? '1' : '').then(function (res) {
					if (!res || res.ok === false) {
						self.flashErrors =
							res && res.errors && res.errors.length
								? res.errors
								: [(res && res.error) || _('Unknown error')];
						replace(self.flashErrorNode, self.buildFlashErrors());
						ui.addNotification(
							null,
							E('p', {}, _('Flashing failed: ') + ((res && res.error) || _('Unknown error'))),
							'error'
						);
						return false;
					}

					// 立刻切到 pending，避免用户重复点第二次刷写
					var tgt = self.flashTarget();

					self.flashErrors = [];
					self.flash = self.normalizeFlash({
						state: 'flash-pending',
						trigger: 'manual',
						source: self.activeSource,
						file: tgt.path,
						size: tgt.size,
						target_build_id: tgt.build_id,
						target_version: tgt.version
					});
					self.flashConfirm = false;
					self.renderFlash();
					return true;
				});
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Flashing failed: ') + (err.message || err)), 'error');
			});
	},

	handleFlashClear: function () {
		var self = this;

		return callFlashClear()
			.then(function () {
				self.flash = self.normalizeFlash(null);
				self.flashErrors = [];
				self.renderFlash();
				ui.addNotification(null, E('p', {}, _('Flash state cleared.')), 'info');
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Clear failed: ') + (err.message || err)), 'error');
			});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
