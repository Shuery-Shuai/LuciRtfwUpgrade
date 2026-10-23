'use strict';
'require view';
'require rpc';
'require ui';
'require rtfwupgrade.format as fmt';

var callStatus = rpc.declare({ object: 'rtfwupgrade', method: 'status' });
var callSetOptions = rpc.declare({
	object: 'rtfwupgrade',
	method: 'set_options',
	params: ['unattended', 'schedule_kind', 'schedule_time', 'schedule_weekday', 'schedule_day', 'webhook']
});
var callSetActive = rpc.declare({ object: 'rtfwupgrade', method: 'set_active', params: ['source'] });
var callSourceAdd = rpc.declare({
	object: 'rtfwupgrade',
	method: 'source_add',
	params: ['name', 'label', 'url', 'layout', 'system']
});
var callSourceDel = rpc.declare({ object: 'rtfwupgrade', method: 'source_del', params: ['name'] });
var callSourceSet = rpc.declare({
	object: 'rtfwupgrade',
	method: 'source_set',
	params: ['name', 'label', 'url', 'layout', 'system']
});
var callScheduleStatus = rpc.declare({ object: 'rtfwupgrade', method: 'schedule_status' });

var SCHEDULE_KINDS = [
	{ value: 'off', text: _('Disabled') },
	{ value: 'daily', text: _('Daily') },
	{ value: 'weekly', text: _('Weekly') },
	{ value: 'monthly', text: _('Monthly') }
];

var WEEKDAYS = [_('Monday'), _('Tuesday'), _('Wednesday'), _('Thursday'), _('Friday'), _('Saturday'), _('Sunday')];

var PRESETS = [
	{
		text: _('ImmortalWrt official'),
		short: 'ImmortalWrt',
		label: _('ImmortalWrt official'),
		url: 'https://downloads.immortalwrt.org',
		layout: 'official',
		system: ''
	},
	{
		text: _('OpenWrt official'),
		short: 'OpenWrt',
		label: _('OpenWrt official'),
		url: 'https://downloads.openwrt.org',
		layout: 'official',
		system: ''
	},
	{
		text: _('RTFW mirror'),
		short: 'RTFW',
		label: _('RTFW mirror'),
		url: 'https://rtfw.shuery.lssa.fun',
		layout: 'official',
		system: 'immortalwrt'
	},
	{
		text: _('Own bin/targets mirror'),
		short: _('Own'),
		label: _('Own build mirror'),
		url: 'https://immortalwrt.shuery.lssa.fun',
		layout: 'default',
		system: ''
	}
];

// 布局说明：只支持两种目录结构，官方站与自建 bin/targets 站各对应一种。
// 描述按用户确认的措辞原样落地（不带 official:/default: 前缀），
// 英文是 msgid，中文译文只放在 po/zh_Hans 里。
function layoutHint(kind) {
	if (kind === 'official')
		return _('OpenWRT/ImmortalWRT official release page structure: root/releases/release/targets');
	if (kind === 'default') return _('Default build output directory structure: root/targets');

	return kind;
}

// 布局说明：表格外单独出现时必须先说清「这是布局类型的说明」，
// 否则两行目录结构会像孤立文本。标题 + 每条带 official/default 代码标记。
function layoutHelp() {
	return E('div', { class: 'rtfw-layout-help' }, [
		E('div', { class: 'rtfw-layout-help-title' }, _('Layout types')),
		E('ul', { class: 'rtfw-layout-list' }, [
			E('li', {}, [E('span', { class: 'rtfw-layout-key' }, 'official'), ' — ', layoutHint('official')]),
			E('li', {}, [E('span', { class: 'rtfw-layout-key' }, 'default'), ' — ', layoutHint('default')])
		])
	]);
}

function layoutTitle() {
	return layoutHint('official') + '\n' + layoutHint('default');
}

function sheet() {
	return E('link', { rel: 'stylesheet', href: L.resource('rtfwupgrade/rtfwupgrade.css') });
}

function replace(node, children) {
	while (node.firstChild) node.removeChild(node.firstChild);
	(children || []).forEach(function (c) {
		if (c) node.appendChild(c);
	});
}

function field(title, control, hint) {
	return E('div', { class: 'cbi-value' }, [
		E('label', { class: 'cbi-value-title' }, title),
		E('div', { class: 'cbi-value-field' }, [control, hint ? E('div', { class: 'rtfw-muted' }, hint) : ''])
	]);
}

return view.extend({
	load: function () {
		return Promise.all([
			callStatus(),
			callScheduleStatus().catch(function () {
				return null;
			})
		]);
	},

	render: function (loaded) {
		// load() 用 Promise.all 同时取状态与定时任务状态；这里同时兼容旧测试
		// 只传单个 status 对象的情况（schedule 缺失时状态块显示“暂无”）。
		var status = Array.isArray(loaded) ? loaded[0] || {} : loaded || {};
		var schedule = Array.isArray(loaded) ? loaded[1] : (loaded && loaded.schedule) || null;
		var conf = status.config || {};
		var self = this;

		this.data = {
			unattended: '' + (conf.unattended || 0),
			kind: conf.schedule_kind || 'daily',
			time: conf.schedule_time || '04:00',
			weekday: '' + (conf.schedule_weekday || 1),
			day: '' + (conf.schedule_day || 1),
			webhook: conf.webhook || ''
		};
		this.sources = conf.sources || [];
		this.active = conf.active_source || '';
		this.layouts = status.layouts || ['official', 'default'];
		this.form = { name: '', label: '', url: '', layout: 'official', system: '' };

		this.sourcesNode = E('div', {}, this.buildSources());
		this.scheduleNode = E('div', {}, this.buildScheduleExtra());
		this.schedule = schedule || null;
		this.scheduleStatusNode = E('div', {}, this.buildScheduleStatus(this.schedule));
		this.adv = { preset: '', name: '', label: '', url: '', layout: 'official', system: '' };
		this.edit = null;
		this.editNode = null;

		return E('div', { class: 'rtfw-app' }, [
			sheet(),
			E('h2', {}, _('Settings')),

			E('h3', {}, _('Check sources')),
			E(
				'p',
				{ class: 'rtfw-muted' },
				_(
					'Only one source is active at a time. Switching discards the previous check result, so that a verdict can never come from a source you are not looking at.'
				)
			),
			this.sourcesNode,

			E('h3', {}, _('Detection and notification')),

			field(
				_('Unattended level'),
				E(
					'select',
					{
						class: 'cbi-input-select',
						change: function (ev) {
							self.data.unattended = ev.target.value;
						}
					},
					['0', '1', '2'].map(function (v) {
						return E(
							'option',
							{ value: v, selected: v === self.data.unattended ? 'selected' : null },
							v +
								' — ' +
								[_('detect and notify'), _('download automatically'), _('flash automatically')][
									parseInt(v, 10)
								]
						);
					})
				),
				_(
					'0: detect and notify only. 1: also download automatically. 2: also flash automatically, but only when the verdict is an update; a rebuild is downloaded and left alone, and the automatic path never flashes across distributions.'
				)
			),

			field(
				_('Scheduled task'),
				E(
					'select',
					{
						class: 'cbi-input-select',
						change: function (ev) {
							self.data.kind = ev.target.value;
							replace(self.scheduleNode, self.buildScheduleExtra());
						}
					},
					SCHEDULE_KINDS.map(function (o) {
						return E(
							'option',
							{ value: o.value, selected: o.value === self.data.kind ? 'selected' : null },
							o.text
						);
					})
				),
				_(
					'Runs unattended on this schedule. It will be written into /etc/crontabs/root inside its own marked block and never touches your existing entries.'
				)
			),

			this.scheduleNode,

			this.scheduleStatusNode,

			field(
				_('Webhook URL'),
				E('input', {
					class: 'cbi-input-text',
					type: 'text',
					placeholder: 'https://example.invalid/hook',
					value: self.data.webhook,
					input: function (ev) {
						self.data.webhook = ev.target.value;
					}
				}),
				_('POST JSON when update events happen. Leave empty to disable.')
			),

			E('div', { class: 'rtfw-toolbar' }, [
				E(
					'button',
					{
						class: 'btn cbi-button cbi-button-action',
						click: ui.createHandlerFn(this, 'handleSaveOptions')
					},
					_('Save settings')
				)
			]),

			fmt.callout(
				'',
				_('Where settings live'),
				_(
					'Everything is stored in /etc/config/rtfwupgrade, which is preserved by sysupgrade -k together with the rest of the configuration.'
				)
			)
		]);
	},

	buildSources: function () {
		var self = this;

		var rows = this.sources.map(function (s) {
			return E('tr', {}, [
				E(
					'td',
					{ class: 'rtfw-col-check' },
					E('input', {
						type: 'radio',
						name: 'rtfw-active-source',
						value: s.name,
						checked: s.name === self.active ? 'checked' : null,
						change: function (ev) {
							self.active = ev.target.value;
						}
					})
				),
				E('td', { class: 'rtfw-col-name', title: _('identifier') + ': ' + s.name }, s.label || s.name),
				E('td', { class: 'rtfw-mono rtfw-col-layout' }, s.layout || '-'),
				E('td', { class: 'rtfw-mono' }, s.url || '-'),
				E('td', { class: 'rtfw-mono rtfw-col-system' }, s.system ? s.system : '-'),
				E(
					'td',
					{ class: 'rtfw-col-action' },
					E('div', { class: 'rtfw-rowactions' }, [
						E(
							'button',
							{
								class: 'rtfw-rowbtn rtfw-rowbtn-edit',
								click: ui.createHandlerFn(self, 'handleEdit', s.name)
							},
							_('Edit')
						),
						E(
							'button',
							{
								class: 'rtfw-rowbtn',
								click: ui.createHandlerFn(self, 'handleDelete', s.name)
							},
							_('Delete')
						)
					])
				)
			]);
		});

		return [
			E('table', { class: 'table rtfw-table rtfw-sources' }, [
				E(
					'thead',
					{},
					E('tr', {}, [
						E('th', { class: 'rtfw-col-check' }, _('Active')),
						E('th', { class: 'rtfw-col-name' }, _('Name')),
						E('th', { class: 'rtfw-col-layout' }, _('Layout')),
						E('th', {}, _('Address')),
						E('th', { class: 'rtfw-col-system' }, _('System')),
						E('th', { class: 'rtfw-col-action' }, _('Actions'))
					])
				),
				E('tbody', {}, rows.concat([this.buildAddRow()])),
				// 布局说明紧跟快速添加行，新增源时能直接看到两种结构的区别
				E('tfoot', {}, E('tr', {}, E('td', { class: 'rtfw-layout-cell', colspan: '6' }, layoutHelp())))
			]),
			E(
				'p',
				{ class: 'rtfw-muted' },
				_(
					'The last row is the quick add: fill the required fields and press Add. Use Advanced when you need to set the identifier yourself.'
				)
			),
			E('div', { class: 'rtfw-toolbar' }, [
				E(
					'button',
					{
						class: 'btn cbi-button cbi-button-action',
						click: ui.createHandlerFn(this, 'handleSaveActive')
					},
					_('Save and apply')
				)
			])
		];
	},

	// 表格最后一行的快速添加：顺序与列一致，只有必填项
	buildAddRow: function () {
		var self = this;
		var els = (this.rowEls = {});

		function text(key, ph) {
			var el = E('input', { class: 'cbi-input-text', type: 'text', placeholder: ph });
			els[key] = el;
			return el;
		}

		els.preset = E(
			'select',
			{
				class: 'cbi-input-select',
				change: function (ev) {
					var preset = PRESETS[parseInt(ev.target.value, 10)];

					if (!preset) return;

					els.label.value = preset.label;
					els.url.value = preset.url;
					els.layout.value = preset.layout;
					els.system.value = preset.system;
				}
			},
			[E('option', { value: '' }, _('Preset'))].concat(
				PRESETS.map(function (preset, i) {
					return E('option', { value: '' + i }, preset.short);
				})
			)
		);

		// 布局下拉只显示 official / default；具体目录结构放在标题与表格下方的说明里
		els.layout = E(
			'select',
			{ class: 'cbi-input-select', title: layoutTitle() },
			this.layouts.map(function (l) {
				return E(
					'option',
					{ value: l, selected: l === 'official' ? 'selected' : null, title: layoutHint(l) },
					l
				);
			})
		);

		return E('tr', { class: 'rtfw-addrow' }, [
			E('td', { class: 'rtfw-col-check' }, els.preset),
			E('td', { class: 'rtfw-col-name' }, text('label', _('Source label'))),
			E('td', { class: 'rtfw-col-layout' }, els.layout),
			E('td', {}, text('url', 'https://example.invalid/immortalwrt')),
			E('td', { class: 'rtfw-col-system' }, text('system', _('optional placeholder'))),
			E('td', { class: 'rtfw-col-action rtfw-addcell' }, [
				E(
					'button',
					{ class: 'rtfw-rowbtn rtfw-rowbtn-ok', click: ui.createHandlerFn(this, 'handleQuickAdd') },
					_('Add')
				),
				E(
					'button',
					{ class: 'rtfw-rowbtn rtfw-rowbtn-plain', click: ui.createHandlerFn(this, 'handleAdvanced') },
					_('Advanced')
				)
			])
		]);
	},

	// 「高级」对话框：完整参数（含标识）
	buildAdvancedForm: function () {
		var self = this;
		var adv = this.adv;

		function bind(key) {
			return function (ev) {
				adv[key] = ev.target.value;
			};
		}

		return E('div', { class: 'rtfw-modal-form' }, [
			field(
				_('Preset'),
				E(
					'select',
					{
						class: 'cbi-input-select',
						change: function (ev) {
							var preset = PRESETS[parseInt(ev.target.value, 10)];

							self.adv = {
								preset: ev.target.value,
								name: '',
								label: preset ? preset.label : '',
								url: preset ? preset.url : '',
								layout: preset ? preset.layout : 'official',
								system: preset ? preset.system : ''
							};
							replace(self.advNode, self.buildAdvancedForm());
						}
					},
					[E('option', { value: '' }, _('— pick a preset —'))].concat(
						PRESETS.map(function (preset, i) {
							return E(
								'option',
								{ value: '' + i, selected: adv.preset === '' + i ? 'selected' : null },
								preset.text
							);
						})
					)
				),
				_('fills the fields below; you can edit everything afterwards')
			),

			field(
				_('Source label'),
				E('input', {
					class: 'cbi-input-text',
					type: 'text',
					value: adv.label,
					placeholder: _('My mirror'),
					input: bind('label')
				}),
				_('shown in the table; free text, duplicates allowed')
			),

			field(
				_('Layout'),
				E(
					'select',
					{
						class: 'cbi-input-select',
						title: layoutTitle(),
						change: bind('layout')
					},
					this.layouts.map(function (l) {
						return E(
							'option',
							{ value: l, selected: l === adv.layout ? 'selected' : null, title: layoutHint(l) },
							l
						);
					})
				),
				layoutHelp()
			),

			field(
				_('Address'),
				E('input', {
					class: 'cbi-input-text',
					type: 'text',
					value: adv.url,
					placeholder: 'https://example.invalid/immortalwrt',
					input: bind('url')
				})
			),

			field(
				_('System'),
				E('input', {
					class: 'cbi-input-text',
					type: 'text',
					value: adv.system,
					placeholder: _('optional, e.g. immortalwrt'),
					input: bind('system')
				}),
				_('path segment for mirrors that host several systems, e.g. rtfw/immortalwrt')
			),

			field(
				_('Identifier'),
				E('input', {
					class: 'cbi-input-text',
					type: 'text',
					value: adv.name,
					placeholder: _('auto-generated when empty'),
					input: bind('name')
				}),
				_(
					'internal UCI section name (lower-case letters, digits, underscore); normally you do not need to set it'
				)
			),

			E('div', { class: 'right rtfw-toolbar' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel') + '\u00a0'),
				E(
					'button',
					{
						class: 'btn cbi-button cbi-button-action',
						click: ui.createHandlerFn(this, 'handleAdvancedAdd')
					},
					_('Add')
				)
			])
		]);
	},

	// 「编辑」对话框：标识（UCI 段名）只读，label/layout/url/system 可改。
	// 编辑状态单独放在 this.edit，绝不复用「添加」的 this.adv。
	buildEditForm: function () {
		var self = this;
		var ed = this.edit || {};

		function bind(key) {
			return function (ev) {
				ed[key] = ev.target.value;
			};
		}

		return E('div', { class: 'rtfw-modal-form' }, [
			field(
				_('Identifier'),
				E('input', {
					class: 'cbi-input-text',
					type: 'text',
					value: ed.name || '',
					readonly: 'readonly',
					disabled: 'disabled'
				}),
				_('It is the UCI section name and cannot be changed.')
			),

			field(
				_('Source label'),
				E('input', {
					class: 'cbi-input-text',
					type: 'text',
					value: ed.label || '',
					placeholder: _('My mirror'),
					input: bind('label')
				}),
				_('shown in the table; free text, duplicates allowed')
			),

			field(
				_('Layout'),
				E(
					'select',
					{
						class: 'cbi-input-select',
						title: layoutTitle(),
						change: bind('layout')
					},
					this.layouts.map(function (l) {
						return E(
							'option',
							{ value: l, selected: l === ed.layout ? 'selected' : null, title: layoutHint(l) },
							l
						);
					})
				),
				layoutHelp()
			),

			field(
				_('Address'),
				E('input', {
					class: 'cbi-input-text',
					type: 'text',
					value: ed.url || '',
					placeholder: 'https://example.invalid/immortalwrt',
					input: bind('url')
				})
			),

			field(
				_('System'),
				E('input', {
					class: 'cbi-input-text',
					type: 'text',
					value: ed.system || '',
					placeholder: _('optional, e.g. immortalwrt'),
					input: bind('system')
				}),
				_('path segment for mirrors that host several systems, e.g. rtfw/immortalwrt')
			),

			E('div', { class: 'right rtfw-toolbar' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel') + '\u00a0'),
				E(
					'button',
					{
						class: 'btn cbi-button cbi-button-action',
						click: ui.createHandlerFn(this, 'handleEditSave')
					},
					_('Save')
				)
			])
		]);
	},

	// 定时任务状态：crontab 里的受管块是否与当前配置一致
	buildScheduleStatus: function (sch) {
		if (!sch)
			return [
				fmt.callout(
					'',
					_('Scheduled task status'),
					_('The schedule status is not available yet. Save the settings once to sync the crontab.')
				)
			];

		var wanted = sch.wanted || '';
		var applied = sch.applied || '';
		var state = '';
		var tone = '';
		var detail = '';

		if (!wanted && !applied) {
			state = _('Not written');
			detail = _('The scheduled task is off, so no crontab entry is expected.');
		} else if (!wanted) {
			state = _('Out of sync');
			tone = 'warning';
			detail = _('A managed crontab block is still present; save the settings to remove it.');
		} else if (!applied) {
			state = _('Not written');
			detail = _('The managed block has not been written yet; save the settings to write it.');
		} else if (sch.in_sync) {
			state = _('Written to crontab');
			tone = 'success';
			detail = _('The managed block matches the current schedule.');
		} else {
			state = _('Out of sync');
			tone = 'warning';
			detail = _('The managed block differs from the current schedule; save the settings to rewrite it.');
		}

		// 两行 cron 都很长，并排放在固定宽度表格里会挤成一行看不清；
		// 改成上下堆叠：标签一行、命令独占整行并允许横向滚动。
		function line(label, value) {
			return E('div', { class: 'rtfw-schedule-line' }, [
				E('div', { class: 'rtfw-schedule-label' }, label),
				E('div', { class: 'rtfw-schedule-value' }, value || '-')
			]);
		}

		return [
			fmt.callout(tone, _('Scheduled task status'), [
				E('div', { class: 'rtfw-schedule-state' }, [
					E('span', { class: 'rtfw-badge rtfw-tone-' + (tone || 'muted') }, state),
					E('span', { class: 'rtfw-muted' }, ' ' + detail)
				]),
				line(_('Wanted'), wanted),
				line(_('Applied'), applied),
				E('div', { class: 'rtfw-schedule-path' }, _('Crontab path: %s').format(sch.path || '-'))
			])
		];
	},

	buildScheduleExtra: function () {
		var self = this;
		var d = this.data;
		var out = [];

		if (d.kind === 'off') return [E('p', { class: 'rtfw-muted' }, _('The scheduled check is disabled.'))];

		if (d.kind === 'weekly')
			out.push(
				field(
					_('Weekday'),
					E(
						'select',
						{
							class: 'cbi-input-select',
							change: function (ev) {
								self.data.weekday = ev.target.value;
							}
						},
						WEEKDAYS.map(function (t, i) {
							return E(
								'option',
								{ value: '' + (i + 1), selected: '' + (i + 1) === d.weekday ? 'selected' : null },
								t
							);
						})
					)
				)
			);

		if (d.kind === 'monthly')
			out.push(
				field(
					_('Day of month'),
					E(
						'select',
						{
							class: 'cbi-input-select',
							change: function (ev) {
								self.data.day = ev.target.value;
							}
						},
						Array.from({ length: 28 }, function (_, i) {
							return E(
								'option',
								{ value: '' + (i + 1), selected: '' + (i + 1) === d.day ? 'selected' : null },
								'' + (i + 1)
							);
						})
					),
					_('1-28 only, so that every month triggers')
				)
			);

		out.push(
			field(
				_('Time (24h)'),
				E('input', {
					class: 'cbi-input-text',
					type: 'time',
					value: d.time,
					input: function (ev) {
						self.data.time = ev.target.value;
					}
				})
			)
		);

		return out;
	},

	handleQuickAdd: function () {
		var self = this;
		var els = this.rowEls || {};
		var v = {
			name: '',
			label: ((els.label && els.label.value) || '').trim(),
			url: ((els.url && els.url.value) || '').trim(),
			layout: (els.layout && els.layout.value) || 'official',
			system: ((els.system && els.system.value) || '').trim()
		};

		if (!v.label || !v.url) {
			ui.addNotification(
				null,
				E('p', {}, _('Quick add needs a label and an address at least — use Advanced for the rest.')),
				'warning'
			);
			return Promise.resolve(false);
		}

		return this.addSource(v).then(function (ok) {
			if (ok) {
				['label', 'url', 'system'].forEach(function (k) {
					if (self.rowEls[k]) self.rowEls[k].value = '';
				});
				if (self.rowEls.preset) self.rowEls.preset.value = '';
			}
			return ok;
		});
	},

	handleAdvanced: function () {
		this.adv = { preset: '', name: '', label: '', url: '', layout: 'official', system: '' };
		this.advNode = E('div', {}, this.buildAdvancedForm());

		return ui.showModal(_('Add source'), [this.advNode]);
	},

	handleAdvancedAdd: function () {
		var self = this;

		return this.addSource(this.adv).then(function (ok) {
			if (ok) ui.hideModal();
			return ok;
		});
	},

	// 快速添加与高级对话框共用的落地逻辑
	addSource: function (v) {
		var self = this;

		return callSourceAdd(v.name, v.label, v.url, v.layout, v.system)
			.then(function (res) {
				if (!res || res.ok === false) throw new Error((res && res.error) || _('Add failed'));

				self.refreshSources(res);
				ui.addNotification(null, E('p', {}, _('Source added.')), 'info');
				return true;
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Add failed: ') + (err.message || err)), 'error');
				return false;
			});
	},

	// 编辑入口：从表格行取当前值，放进独立的 this.edit 状态
	handleEdit: function (name) {
		var src = (this.sources || []).filter(function (x) {
			return x.name === name;
		})[0];

		if (!src) {
			ui.addNotification(null, E('p', {}, _('Update failed')), 'error');
			return Promise.resolve(false);
		}

		this.edit = {
			name: src.name,
			label: src.label || '',
			url: src.url || '',
			layout: src.layout || 'official',
			system: src.system || ''
		};
		this.editNode = E('div', {}, this.buildEditForm());

		return ui.showModal(_('Edit source'), [this.editNode]);
	},

	handleEditSave: function () {
		var self = this;
		var ed = this.edit;

		if (!ed) return Promise.resolve(false);

		return callSourceSet(ed.name, ed.label, ed.url, ed.layout, ed.system)
			.then(function (res) {
				if (!res || res.ok === false) throw new Error((res && res.error) || _('Update failed'));

				self.refreshSources(res);
				ui.hideModal();
				ui.addNotification(null, E('p', {}, _('Source updated.')), 'info');
				return true;
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Update failed: ') + (err.message || err)), 'error');
				return false;
			});
	},

	refreshSources: function (res) {
		if (res && res.sources) {
			this.sources = res.sources;
			this.active = res.active_source || this.active;
			replace(this.sourcesNode, this.buildSources());
		}
	},

	handleDelete: function (name) {
		var src =
			(this.sources || []).filter(function (x) {
				return x.name === name;
			})[0] || {};

		return ui.showModal(_('Delete source'), [
			E(
				'p',
				{},
				_(
					'Delete source %s? Its section is removed from the configuration and the last check result is discarded.'
				).format(src.label || name)
			),
			E('div', { class: 'right' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel') + '\u00a0'),
				E(
					'button',
					{
						class: 'btn cbi-button cbi-button-negative',
						click: ui.createHandlerFn(this, 'doDelete', name)
					},
					_('Delete')
				)
			])
		]);
	},

	doDelete: function (name) {
		var self = this;

		ui.hideModal();

		return callSourceDel(name)
			.then(function (res) {
				if (!res || res.ok === false) throw new Error((res && res.error) || _('Delete failed'));

				self.refreshSources(res);
				ui.addNotification(null, E('p', {}, _('Source deleted.')), 'info');
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Delete failed: ') + (err.message || err)), 'error');
			});
	},

	handleSaveActive: function () {
		var self = this;

		return callSetActive(this.active)
			.then(function (res) {
				if (!res || res.ok === false) throw new Error((res && res.error) || _('Save failed'));

				ui.addNotification(null, E('p', {}, _('Active source updated.')), 'info');
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Save failed: ') + (err.message || err)), 'error');
			});
	},

	// 保存后刷新定时任务状态：优先重新查询，查询失败时用 set_options 返回的 sync 结果兜底
	refreshScheduleStatus: function (fallback) {
		var self = this;

		return callScheduleStatus()
			.then(function (sch) {
				self.schedule = sch || null;
			})
			.catch(function () {
				self.schedule = fallback
					? {
							path: '',
							schedule: fallback.schedule || '',
							wanted: fallback.line || '',
							applied: fallback.ok ? fallback.line || '' : '',
							in_sync: fallback.ok === true
						}
					: null;
			})
			.then(function () {
				replace(self.scheduleStatusNode, self.buildScheduleStatus(self.schedule));
			});
	},

	handleSaveOptions: function () {
		var self = this;
		var d = this.data;

		return callSetOptions(d.unattended, d.kind, d.time, d.weekday, d.day, d.webhook)
			.then(function (res) {
				if (!res || res.ok === false) throw new Error((res && res.error) || _('Save failed'));

				ui.addNotification(null, E('p', {}, _('Settings saved.')), 'info');
				return self.refreshScheduleStatus(res.schedule);
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Save failed: ') + (err.message || err)), 'error');
			});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
