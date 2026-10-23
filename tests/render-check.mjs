#!/usr/bin/env node
// 无浏览器渲染检查：按 luci.js 的加载规则把视图的 'require … as …' 指令绑成参数，
// 再用桩跑 load() / render() / 事件处理器，覆盖下载状态的各个分支。
// 目的：在没有浏览器的环境里抓住 ReferenceError、字段名写错、模块路径写错这类问题。
// 用法: node tests/render-check.mjs
//
// 桩里**故意不提供 sprintf**（浏览器端 LuCI 也没有），只能用 String.prototype.format。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.join(ROOT, 'luci-app-rtfwupgrade/htdocs/luci-static/resources');
const FIX = path.join(ROOT, 'tests/fixtures');

const readFixture = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const baseStatus = readFixture('status.json');
const baseSources = readFixture('sources.json');

// 与 luci.js 完全相同的指令正则
const REQUIRE_RE = /^require[ \t]+(\S+)(?:[ \t]+as[ \t]+([a-zA-Z_]\S*))?$/;

function parseDirectives(source) {
	const deps = [];
	const re = /(['"])(require[ \t]+\S+(?:[ \t]+as[ \t]+[a-zA-Z_]\S*)?)\1[ \t]*;/g;
	let m;
	while ((m = re.exec(source)) !== null) {
		const d = REQUIRE_RE.exec(m[2]);
		if (d) deps.push({ dep: d[1], as: d[2] || d[1].replace(/[^a-zA-Z0-9_]/g, '_') });
	}
	return deps;
}

function collectText(node, out = []) {
	if (node === null || node === undefined) return out;
	if (typeof node === 'string' || typeof node === 'number') out.push(String(node));
	else if (Array.isArray(node)) node.forEach(n => collectText(n, out));
	else if (typeof node === 'object') {
		Object.values(node.attrs || {}).forEach(v => collectText(v, out));
		collectText(node.children, out);
	}
	return out;
}

function makeContext(methods) {
	const notifications = [];
	const polled = { added: 0, removed: 0 };
	const modals = { shown: 0, hidden: 0 };

	const makeEl = (tag, attrs, children) => {
		const el = {
			tag,
			attrs: attrs || {},
			children: [],
			get firstChild() {
				return this.children[0] || null;
			},
			appendChild(child) {
				if (child === null || child === undefined || child === '') return child;
				if (Array.isArray(child)) child.forEach(c => this.appendChild(c));
				else this.children.push(child);
				return child;
			},
			removeChild(child) {
				const i = this.children.indexOf(child);
				if (i >= 0) this.children.splice(i, 1);
				return child;
			}
		};
		el.appendChild(children === undefined ? [] : children);
		return el;
	};

	const ctx = {
		E: makeEl,
		// LuCI 的 _() 只做查表，**不消费占位符**：官方视图写法是 _('...%d').format(x)。
		// 这里如实返回原串（不做翻译），占位符留给 String.prototype.format 处理。
		_: s => String(s),
		L: {
			resource: p => '/luci-static/resources/' + p,
			url: (...p) => '/cgi-bin/luci/' + p.join('/'),
			bind: (fn, self, ...args) => fn.bind(self, ...args),
			env: {}
		},
		Date,
		JSON,
		Math,
		Object,
		Array,
		Promise,
		console
	};

	ctx.globalThis = ctx;
	vm.createContext(ctx);

	vm.runInContext(
		`
		String.prototype.format = function () {
			const args = Array.from(arguments);
			return this.replace(/%[sdf]/g, m => (args.length ? String(args.shift()) : m));
		};
	`,
		ctx
	);

	// LuCI 的 Class.extend 返回构造器；模块必须返回构造器，加载器会 new 出实例
	const makeClass = proto => {
		const Klass = function () {
			Object.assign(this, proto);
		};
		Klass.extend = sub => makeClass(Object.assign({}, proto, sub));
		return Klass;
	};

	const modules = {
		baseclass: { extend: makeClass },
		view: { extend: makeClass },
		ui: {
			createHandlerFn:
				(self, name, ...bound) =>
				(...args) =>
					self[name](...bound, ...args),
			addNotification: (title, children, ...classes) => notifications.push({ title, children, classes }),
			showModal: (title, children) => {
				modals.shown++;
				return { title, children };
			},
			hideModal: () => {
				modals.hidden++;
			}
		},
		rpc: { declare: spec => () => Promise.resolve(methods[spec.method]) },
		poll: {
			add: () => {
				polled.added++;
			},
			remove: () => {
				polled.removed++;
			},
			active: () => false,
			call: () => {},
			start: () => {},
			stop: () => {}
		}
	};

	return { ctx, modules, notifications, polled, modals };
}

function evalModule(ctx, modules, file) {
	const source = fs.readFileSync(file, 'utf8');
	const deps = parseDirectives(source);
	const args = [];

	for (const d of deps) {
		if (!(d.dep in modules)) throw new Error(`模块 ${d.dep} 没有桩（视图要求了它）`);
		args.push({ as: d.as, value: modules[d.dep] });
	}

	const fn = vm.runInContext('(function (' + args.map(a => a.as).join(', ') + ') {\n' + source + '\n})', ctx, {
		filename: file
	});
	const yielded = fn(...args.map(a => a.value));

	// 忠实复现 luci.js：Class.isSubclass(yielded) 不成立就报这条错
	if (typeof yielded !== 'function') throw new Error(`"${file}" factory yields invalid constructor`);

	return { value: new yielded(), deps: deps.map(d => `${d.dep} as ${d.as}`) };
}

const fakeEv = () => ({
	currentTarget: { disabled: false, classList: { add() {}, remove() {} } },
	preventDefault() {}
});
const FILE = '/tmp/rtfwupgrade/immortalwrt-mediatek-filogic-bananapi_bpi-r4-squashfs-sysupgrade.itb';

const VIEWS = [
	{
		file: 'view/rtfwupgrade/overview.js',
		base: { status: baseStatus },
		extra: {
			download: { ok: true, state: 'running', received: 1024, size: 2048, percent: 50 },
			download_status: { state: 'cancelled' },
			cancel: { ok: true },
			cleanup: { ok: true },
			check: baseStatus.last
		},
		handlers: ['handleCheck', 'handleDownload', 'handleCancel', 'handleCleanup'],
		cases: [
			{ name: '无下载', data: baseStatus, expect: ['Download image'] },
			{
				name: '下载中',
				data: {
					...baseStatus,
					download: {
						state: 'running',
						received: 5160906,
						size: 23593558,
						percent: 21,
						resumed_from: 5160906,
						resume_reason: 'ETag/Last-Modified 一致'
					}
				},
				expect: ['Cancel', 'Downloading', '21%', 'Resume check', 'ETag/Last-Modified 一致']
			},
			{
				name: '已校验',
				data: {
					...baseStatus,
					download: { state: 'verified', file: FILE, size: 23593558, sha256: 'a'.repeat(64) }
				},
				expect: ['Downloaded and verified', 'Delete file']
			},
			{
				name: '失败',
				data: {
					...baseStatus,
					download: { state: 'failed', error: 'curl exit 22', resume_reason: '没有已下载的部分' }
				},
				expect: ['Download failed', 'Retry download', 'curl exit 22', 'Resume check', '没有已下载的部分']
			},
			{
				name: '已取消',
				data: {
					...baseStatus,
					download: { state: 'cancelled', resume_reason: 'ETag 变化：abc → def' }
				},
				expect: ['Resume download', 'Download cancelled', 'Resume check', 'ETag 变化：abc → def']
			}
		]
	},
	{
		file: 'view/rtfwupgrade/settings.js',
		base: { status: baseStatus },
		extra: {
			// settings.js 的 load() 用 Promise.all 同时取 status 与 schedule_status
			schedule_status: {
				path: '/etc/crontabs/root',
				schedule: '每天 04:00',
				wanted: '0 4 * * * mkdir -p /tmp/rtfwupgrade && /usr/bin/rtfwupgrade.sh cron >> /tmp/rtfwupgrade/cron.log 2>&1',
				applied: '0 4 * * * mkdir -p /tmp/rtfwupgrade && /usr/bin/rtfwupgrade.sh cron >> /tmp/rtfwupgrade/cron.log 2>&1',
				in_sync: true
			},
			set_options: { ok: true },
			set_active: { ok: true, active_source: 'immortalwrt_official', config: { sources: baseSources.sources } },
			source_add: { ok: true, sources: baseSources.sources, active_source: 'immortalwrt_official' },
			source_set: { ok: true, sources: baseSources.sources, active_source: 'immortalwrt_official' },
			source_del: { ok: true, sources: baseSources.sources, active_source: 'immortalwrt_official' }
		},
		handlers: [
			'handleSaveOptions',
			'handleSaveActive',
			{ name: 'handleDelete', args: ['openwrt_official'] },
			{ name: 'doDelete', args: ['openwrt_official'] },
			'handleAdvancedAdd',
			{ name: 'handleEdit', args: ['openwrt_official'] },
			'handleEditSave'
		],
		cases: [
			{
				name: '设置（快速添加 + 高级/编辑对话框 + 调度状态）',
				data: {
					...baseStatus,
					layouts: ['official', 'default'],
					config: {
						...baseStatus.config,
						sources: baseSources.sources,
						active_source: baseSources.active_source
					}
				},
				expectPre: [
					'Settings',
					'Check sources',
					'Save and apply',
					'Save settings',
					'Scheduled task',
					'Scheduled task status',
					'Written to crontab',
					'Wanted',
					'Applied',
					'Time (24h)',
					'Edit',
					'Delete',
					'Preset',
					'Advanced',
					// 两种布局的名称与目录结构说明
					'OpenWRT/ImmortalWRT official release page structure: root/releases/release/targets',
					'Default build output directory structure: root/targets'
				],
				expect: [
					'Identifier',
					'auto-generated when empty',
					'internal UCI section name',
					// 编辑对话框：标题 + 标识只读说明（source_set 回调已在上面的 after 里跑过）
					'Edit source',
					'It is the UCI section name and cannot be changed.'
				],
				requireClass: 'rtfw-table',
				after: async function (view) {
					// 快速添加：缺必填 → 警告；填好 → 成功
					await view.handleQuickAdd();
					view.rowEls.label.value = '测试源';
					view.rowEls.url.value = 'https://rtfw.shuery.lssa.fun';
					await view.handleQuickAdd();
					// 高级对话框
					await view.handleAdvanced();
					// 编辑对话框：入口 → 保存回调（source_set）
					const editModal = await view.handleEdit('openwrt_official');
					await view.handleEditSave();
					return [
						view.advNode,
						{ attrs: {}, children: [editModal?.title || ''] },
						...(editModal?.children || [])
					];
				},
				orderSequences: [
					['Active', 'Name', 'Layout', 'Address', 'System', 'Actions'],
					['Preset', 'Source label', 'Layout', 'Address', 'System', 'Actions']
				]
			}
		]
	},
	{
		file: 'view/rtfwupgrade/logs.js',
		base: {},
		extra: {
			logs: {
				events: [
					{ ts: 1791118000, level: 'info', event: 'check', message: '远端更旧（可降级）：源码构建时间…' },
					{ ts: 1791118100, level: 'error', event: 'download', message: '下载失败：sha256 不匹配' }
				],
				download_log: 'curl: (22) The requested URL returned error: 404',
				cron_log: '未检测：2026-10-02 04:00 UTC',
				files: {
					events: '/tmp/rtfwupgrade/events.jsonl',
					download_log: '/tmp/rtfwupgrade/download.log',
					cron_log: '/tmp/rtfwupgrade/cron.log'
				}
			},
			logs_clear: { ok: true }
		},
		handlers: ['handleRefresh', 'handleClear'],
		cases: [
			{
				name: '日志（有事件）',
				data: {
					events: [
						{ ts: 1791118000, level: 'info', event: 'check', message: '远端更旧（可降级）：源码构建时间…' },
						{ ts: 1791118100, level: 'error', event: 'download', message: '下载失败：sha256 不匹配' }
					],
					download_log: 'curl: (22) 404',
					cron_log: '未检测：2026-10-02 04:00 UTC',
					files: {
						events: '/tmp/rtfwupgrade/events.jsonl',
						download_log: '/tmp/rtfwupgrade/download.log',
						cron_log: '/tmp/rtfwupgrade/cron.log'
					}
				},
				expect: [
					'Logs',
					'Refresh',
					'Clear log',
					'All levels',
					'All events',
					'Search',
					'Shown 2 of 2 events',
					'sha256 不匹配',
					'Raw downloader output',
					'Raw scheduled-task output',
					'Scheduled-task log: /tmp/rtfwupgrade/cron.log',
					'未检测：2026-10-02 04:00 UTC'
				]
			},
			{
				name: '日志（空态）',
				data: null,
				methods: { logs: { events: [], download_log: '', cron_log: '' } },
				expect: ['No events yet.', 'No downloader output yet.', 'No scheduled-task output yet.']
			}
		]
	}
];

let failed = 0;
let passed = 0;

// 自检：确认加载器真的会拒绝「返回普通对象」的模块（这正是线上崩过的那条错）
{
	const { ctx, modules } = makeContext({});
	const bad = path.join(ROOT, 'tests/fixtures/bad-module.js');
	fs.writeFileSync(bad, "'use strict';\nreturn { hello: 1 };\n");
	try {
		evalModule(ctx, modules, bad);
		console.log('FAIL 自检：普通对象模块应当被拒绝，但没有');
		failed++;
	} catch (e) {
		if (String(e.message).includes('factory yields invalid constructor')) {
			console.log('ok   自检：普通对象模块被正确拒绝');
			passed++;
		} else {
			console.log('FAIL 自检：拒绝原因不符 -> ' + e.message);
			failed++;
		}
	} finally {
		fs.unlinkSync(bad);
	}
}

for (const spec of VIEWS) {
	for (const c of spec.cases) {
		const methods = { ...spec.base, ...spec.extra, ...(c.methods || {}) };
		if (!c.methods || !('status' in c.methods)) methods.status = c.data;

		const { ctx, modules, notifications, polled, modals } = makeContext(methods);

		try {
			modules['rtfwupgrade.format'] = evalModule(
				ctx,
				{ ...modules, 'rtfwupgrade.format': null },
				path.join(RES, 'rtfwupgrade/format.js')
			).value;

			const { value: view } = evalModule(ctx, modules, path.join(RES, spec.file));
			if (typeof view.load !== 'function' || typeof view.render !== 'function')
				throw new Error('导出的对象缺少 load()/render()');

			const data = await view.load();
			const tree = view.render(data);

			if (c.expectPre) {
				const pre = collectText(tree).join(' ');
				const miss = c.expectPre.filter(x => !pre.includes(x));
				if (miss.length) throw new Error('展开前缺少文案: ' + miss.join(', '));
			}

			let extraTree = null;

			if (c.after) extraTree = await c.after(view);

			const text = collectText(tree).join(' ') + ' ' + (extraTree ? collectText(extraTree).join(' ') : '');
			globalThis.__lastText = text;

			// 表格必须带 rtfw-table（固定布局 + 表头同侧对齐），否则会出现表头与内容错位
			if (c.requireClass && !JSON.stringify(tree).includes(c.requireClass))
				throw new Error('缺少容器类: ' + c.requireClass);

			const missing = c.expect.filter(s => !text.includes(s));
			if (missing.length) throw new Error('渲染结果缺少文案: ' + missing.join(', '));

			if (c.orderNodes) {
				// 把渲染树按深度优先拍平为文本序列，只保留非空短文本（表单标签/表头）
				const flat = [];
				(function walk(node) {
					if (!node || typeof node !== 'object') return;
					if (Array.isArray(node)) return node.forEach(walk);
					const own = node.children || [];
					const inner = own
						.filter(x => typeof x === 'string')
						.join(' ')
						.trim();
					if (inner) flat.push(inner);
					own.forEach(walk);
				})(tree);

				const orderTree = c.orderTree === 'extra' && extraTree ? extraTree : tree;
				const flatSrc =
					orderTree === tree
						? flat
						: (function flatten(t) {
								const out = [];
								(function walk(node) {
									if (!node || typeof node !== 'object') return;
									if (Array.isArray(node)) return node.forEach(walk);
									const own = node.children || [];
									const inner = own
										.filter(x => typeof x === 'string')
										.join(' ')
										.trim();
									if (inner) out.push(inner);
									own.forEach(walk);
								})(t);
								return out;
							})(orderTree);

				for (const seq of c.orderSequences || [c.orderNodes]) {
					let at = -1;
					for (const needle of seq) {
						const next = flatSrc.findIndex((t, i) => i > at && t.indexOf(needle) >= 0);
						if (next < 0) throw new Error('顺序断言失败：找不到「' + needle + '」');
						at = next;
					}
				}
			}

			if (c.expectOrder) {
				let pos = -1;
				for (const needle of c.expectOrder) {
					const at = text.indexOf(needle, pos + 1);
					if (at < 0) throw new Error('顺序断言失败：找不到「' + needle + '」');
					if (at < pos)
						throw new Error(
							'顺序断言失败：「' +
								needle +
								'」应出现在「' +
								c.expectOrder[c.expectOrder.indexOf(needle) - 1] +
								'」之后'
						);
					pos = at;
				}
			}

			for (const handler of spec.handlers || []) {
				const name = typeof handler === 'string' ? handler : handler.name;
				const args = typeof handler === 'string' ? [fakeEv()] : handler.args;

				if (typeof view[name] === 'function') await view[name](...args);
			}

			console.log(
				`ok   ${spec.file} · ${c.name}（文本 ${text.length} 字符，通知 ${notifications.length}，弹窗 +${modals.shown}/-${modals.hidden}，poll +${polled.added}/-${polled.removed}）`
			);
			passed++;
		} catch (e) {
			console.log(`FAIL ${spec.file} · ${c.name}: ${e.message}`);
			if (c.debug !== false)
				console.log(
					'     文本片段: ' +
						String(globalThis.__lastText || '')
							.slice(0, 900)
							.replace(/\s+/g, ' ')
				);
			failed++;
		}
	}
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
