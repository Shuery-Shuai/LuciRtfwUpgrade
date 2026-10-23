'use strict';
'require view';
'require rpc';
'require ui';
'require rtfwupgrade.format as fmt';

var callLogs = rpc.declare({ object: 'rtfwupgrade', method: 'logs' });
var callClear = rpc.declare({ object: 'rtfwupgrade', method: 'logs_clear' });

var LEVEL_CLASS = { info: '', warn: 'warning', error: 'danger' };

function sheet() {
	return E('link', { rel: 'stylesheet', href: L.resource('rtfwupgrade/rtfwupgrade.css') });
}

function replace(node, children) {
	while (node.firstChild) node.removeChild(node.firstChild);
	(children || []).forEach(function (c) {
		if (c) node.appendChild(c);
	});
}

function stamp(ts) {
	if (!ts) return '-';

	return new Date(ts * 1000).toISOString().replace('T', ' ').substr(0, 19) + ' UTC';
}

return view.extend({
	load: function () {
		return callLogs();
	},

	render: function (data) {
		var self = this;

		this.data = data || { events: [], download_log: '', cron_log: '' };
		this.filters = { level: '', event: '', q: '' };
		this.logNode = E('div', {}, this.buildLog());

		function pick(label, options, key, onchange) {
			return E('label', { class: 'rtfw-filter' }, [
				E('span', {}, label),
				E(
					'select',
					{ class: 'cbi-input-select', change: onchange },
					options.map(function (o) {
						return E('option', { value: o.value }, o.text);
					})
				)
			]);
		}

		return E('div', { class: 'rtfw-app' }, [
			sheet(),
			E('h2', {}, _('Logs')),
			E(
				'p',
				{ class: 'rtfw-muted' },
				_(
					'Detection, source, download and flash events, newest first. Stored in RAM (/tmp), so a reboot clears them; a pending flash result is kept separately until it is confirmed.'
				)
			),

			E('div', { class: 'rtfw-toolbar' }, [
				E(
					'button',
					{
						class: 'btn cbi-button cbi-button-action',
						click: ui.createHandlerFn(this, 'handleRefresh')
					},
					_('Refresh')
				),
				E(
					'button',
					{
						class: 'btn cbi-button cbi-button-reset',
						click: ui.createHandlerFn(this, 'handleClear')
					},
					_('Clear log')
				)
			]),

			E('div', { class: 'rtfw-filters' }, [
				pick(
					_('Level'),
					[
						{ value: '', text: _('All levels') },
						{ value: 'info', text: 'info' },
						{ value: 'warn', text: 'warn' },
						{ value: 'error', text: 'error' }
					],
					'level',
					function (ev) {
						self.filters.level = ev.target.value;
						self.renderLog();
					}
				),

				pick(
					_('Event'),
					[
						{ value: '', text: _('All events') },
						{ value: 'check', text: 'check' },
						{ value: 'source', text: 'source' },
						{ value: 'options', text: 'options' },
						{ value: 'download', text: 'download' },
						{ value: 'cron', text: 'cron' }
					],
					'event',
					function (ev) {
						self.filters.event = ev.target.value;
						self.renderLog();
					}
				),

				E('label', { class: 'rtfw-filter' }, [
					E('span', {}, _('Search')),
					E('input', {
						class: 'cbi-input-text',
						type: 'text',
						placeholder: _('substring of the message'),
						input: function (ev) {
							self.filters.q = ev.target.value;
							self.renderLog();
						}
					})
				])
			]),

			this.logNode
		]);
	},

	renderLog: function () {
		replace(this.logNode, this.buildLog());
	},

	filtered: function () {
		var f = this.filters || {};
		var q = (f.q || '').toLowerCase();

		return ((this.data && this.data.events) || []).filter(function (e) {
			if (f.level && e.level !== f.level) return false;
			if (f.event && e.event !== f.event) return false;
			if (
				q &&
				String(e.message || '')
					.toLowerCase()
					.indexOf(q) < 0
			)
				return false;

			return true;
		});
	},

	buildLog: function () {
		var all = (this.data && this.data.events) || [];
		var events = this.filtered();
		var nodes = [];

		if (all.length)
			nodes.push(E('p', { class: 'rtfw-muted' }, _('Shown %d of %d events').format(events.length, all.length)));

		if (!events.length) {
			nodes.push(
				E('p', { class: 'rtfw-muted' }, all.length ? _('No events match the filter.') : _('No events yet.'))
			);
		} else {
			nodes.push(
				fmt.kvTable(
					[
						{ text: _('Time'), class: 'rtfw-col-time' },
						{ text: _('Event'), class: 'rtfw-col-layout' },
						_('Detail')
					],
					events.map(function (e) {
						return [stamp(e.ts), (e.event || '-') + ' · ' + (e.level || '-'), e.message || ''];
					})
				)
			);
		}

		var raw = (this.data && this.data.download_log) || '';
		var cron = (this.data && this.data.cron_log) || '';
		var files = (this.data && this.data.files) || {};

		nodes.push(
			E('details', { class: 'rtfw-images' }, [
				E('summary', {}, _('Raw downloader output (tail)')),
				raw
					? E('pre', { class: 'rtfw-mono', style: 'max-height:22rem;overflow:auto' }, raw)
					: E('p', { class: 'rtfw-muted' }, _('No downloader output yet.'))
			])
		);

		// 定时任务的原始输出（/tmp/rtfwupgrade/cron.log）与下载器输出并列展示。
		// 后端 rpcd logs 新增 cron_log 字段后自动生效；旧后端没有这个字段时显示空态。
		nodes.push(
			E('details', { class: 'rtfw-images' }, [
				E('summary', {}, _('Raw scheduled-task output (tail)')),
				cron
					? E('pre', { class: 'rtfw-mono', style: 'max-height:22rem;overflow:auto' }, cron)
					: E('p', { class: 'rtfw-muted' }, _('No scheduled-task output yet.'))
			])
		);

		if (files.events)
			nodes.push(
				E('p', { class: 'rtfw-muted' }, _('Files: %s , %s').format(files.events, files.download_log || '-'))
			);

		if (files.cron_log)
			nodes.push(E('p', { class: 'rtfw-muted' }, _('Scheduled-task log: %s').format(files.cron_log)));

		return nodes;
	},

	handleRefresh: function () {
		var self = this;

		return callLogs()
			.then(function (data) {
				self.data = data || { events: [], download_log: '', cron_log: '' };
				replace(self.logNode, self.buildLog());
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Refresh failed: ') + (err.message || err)), 'error');
			});
	},

	handleClear: function () {
		var self = this;

		return callClear()
			.then(function () {
				return self.handleRefresh();
			})
			.then(function () {
				ui.addNotification(null, E('p', {}, _('Log cleared.')), 'info');
			})
			.catch(function (err) {
				ui.addNotification(null, E('p', {}, _('Clear failed: ') + (err.message || err)), 'error');
			});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
