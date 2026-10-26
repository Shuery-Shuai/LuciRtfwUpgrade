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
	// 记录每一次弹窗：一个用例里可能连开好几个，只看最后一个会漏掉先前的（例如切源警告后面还有删除确认）
	const modals = { shown: 0, hidden: 0, list: [] };
	const rpcCalls = {};

	const makeEl = (tag, attrs, children) => {
		const el = {
			tag,
			attrs: attrs || {},
			children: [],
			get firstChild() {
				return this.children[0] || null;
			},
			// 忠于真实 DOM：只接受 Node。传数组或裸字符串会抛同样的 TypeError，
			// 否则桩会把「嵌套数组」这类缺陷悄悄吞掉，测试全绿而浏览器崩。
			appendChild(child) {
				if (child === null || child === undefined) return child;
				if (!(typeof child === 'object' && child !== null && 'tag' in child))
					throw new TypeError(
						"Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'."
					);
				this.children.push(child);
				return child;
			},
			appendText(text) {
				this.children.push(String(text));
			},
			removeChild_all() {},
			removeChild(child) {
				const i = this.children.indexOf(child);
				if (i >= 0) this.children.splice(i, 1);
				return child;
			}
		};
		// 复现 LuCI DOM.append()：数组里的非节点值用 createTextNode 包装，
		// 顶层非节点值走 innerHTML；两者都不会把数组交给 appendChild。
		const add = (target, v) => {
			if (v === null || v === undefined) return;
			if (Array.isArray(v)) return v.forEach(x => add(target, x));
			if (typeof v === 'object' && v !== null && 'tag' in v) return target.appendChild(v);
			target.appendText(v);
		};
		add(el, children);
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
		// 真实 DOM 的空串子节点会被 createTextNode 包装；桩里同样需要它
		document: {
			createTextNode: text => ({ tag: '#text', attrs: {}, children: [String(text)] }),
			createDocumentFragment: () => ({ tag: '#fragment', attrs: {}, children: [], appendChild(c) { this.children.push(c); return c; } })
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
			// 真实 LuCI 的 ui.showModal 返回 Promise（弹窗关闭时 resolve），
			// 桩必须一致：否则被测代码里的 .then() 会抛错，走的路径与浏览器不同。
			showModal: (title, children) => {
				modals.shown++;
				// 记下每次弹窗，供 expectModal 断言（handler 触发的弹窗没有返回值可拿）
				modals.list.push({ title, children: children || [] });
				return Promise.resolve({ title, children });
			},
			hideModal: () => {
				modals.hidden++;
			}
		},
		// 记录每个 rpc 方法的调用次数：用来断言「用户取消时没有真的发请求」
		rpcCalls,
		rpc: {
			declare: spec => (...a) => {
				rpcCalls[spec.method] = (rpcCalls[spec.method] || 0) + 1;
				return Promise.resolve(methods[spec.method]);
			}
		},
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

	return { ctx, modules, notifications, polled, modals, rpcCalls };
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
const baseChannels = {
	ok: true,
	source: 'immortalwrt',
	layout: 'official',
	pinned: '',
	channels: [
		{ value: 'snapshot', dir: 'snapshots', available: true },
		{ value: 'stable', dir: 'releases/25.12.2', available: true },
		{ value: 'oldstable', dir: 'releases/24.10.6', available: true },
		{ value: 'major', dir: 'releases/25.12.2', available: true },
		{ value: 'minor', dir: 'releases/25.12.2', available: true }
	],
	list: ['snapshots', 'releases/25.12.2', 'releases/24.10.6'],
	origin: '.versions.json',
	stable: '25.12.2',
	oldstable: '24.10.6',
	local_version: 'SNAPSHOT',
	locked: false,
	cached: true
};

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
			check: baseStatus.last,
			channels: baseChannels,
			set_channel: { ok: true, channel: 'stable', sources: baseSources.sources }
		},
		handlers: [
			'handleCheck',
			'handleDownload',
			'handleCancel',
			'handleCleanup'
		],
		cases: [
			{
				name: '无下载',
				data: baseStatus,
				// 概览页只展示通道，切换入口在设置页
				expect: ['Download image', 'Current channel', 'snapshots', 'Change in settings'],
				expectAbsent: ['Follow this device', 'Switch channel']
			},
			{
				// 浏览器跑着升级前的旧 JS：界面过期，必须提示强制刷新
				name: '页面在跑旧代码',
				data: { ...baseStatus, version: '0.0.0_stale' },
				expect: ['The page is running stale code', '0.0.0_stale', 'Ctrl+Shift+R']
			},
			{
				// 检测结果由另一个源产生：必须显式说明，否则用户会当成激活源的结果
				name: '结果来自另一个源',
				data: {
					...baseStatus,
					config: { ...baseStatus.config, active_source: 'own_build' },
					last: {
						...baseStatus.last,
						source: {
							name: 'immortalwrt',
							label: 'ImmortalWrt 官方',
							url: 'https://downloads.immortalwrt.org',
							layout: 'official',
							system: ''
						}
					}
				},
				expect: ['Result came from another source', 'own_build', 'ImmortalWrt 官方']
			},
			{
				// 已确认过来源，但激活源被换成了别的：要求放行才能刷写
				name: '切了源但未确认（需要放行）',
				data: {
					...baseStatus,
					config: {
						...baseStatus.config,
						active_source: 'openwrt',
						current_firmware_source: 'immortalwrt'
					}
				},
				expect: [
					'Cross-source change',
					'from immortalwrt to openwrt',
					'Allow cross-source change',
					'Change in settings',
					'Flash firmware',
					'This cannot be undone'
				],
				// 「此操作不可逆」与确认勾选必须排在跨源警告之后
				expectOrder: ['Cross-source change', 'This cannot be undone', 'I confirm: flash this image']
			},
			{
				// 切源未确认 + 跨发行版警告：两块独立并存，各有各的勾选
				name: '切源未确认与跨发行版刷写同时成立',
				data: {
					...baseStatus,
					config: {
						...baseStatus.config,
						active_source: 'openwrt',
						current_firmware_source: 'immortalwrt'
					},
					last: {
						...baseStatus.last,
						remote: {
							...baseStatus.last.remote,
							warnings: ['该源属于 OpenWrt，而本机运行 ImmortalWrt：跨发行版刷写属于「换系统」，配置文件可能不兼容。']
						}
					}
				},
				expect: [
					'Cross-source change',
					'Allow cross-source change',
					'Cross-distribution flashing',
					'Allow cross-distribution flashing'
				]
			},
			{
				// 已确认且与激活源一致：没有跨源提示
				name: '已确认来源时无跨源提示',
				data: {
					...baseStatus,
					config: {
						...baseStatus.config,
						active_source: 'immortalwrt',
						current_firmware_source: 'immortalwrt'
					}
				},
				expect: ['Flash firmware'],
				expectAbsent: ['Cross-source change', 'Confirm the firmware source']
			},
			{
				// 从未确认过来源：提示去设置页确认，而不是要求放行
				name: '首次使用未确认来源',
				data: {
					...baseStatus,
					config: { ...baseStatus.config, active_source: 'immortalwrt', current_firmware_source: '' }
				},
				expect: ['Confirm the firmware source', 'Go to sources', 'Flash firmware'],
				expectAbsent: ['Cross-source change'],
				// 提示必须排在「检查更新」之上：用户还没点按钮就该看到
				expectOrder: ['Confirm the firmware source', 'Check for updates'],
				// 点「检查更新」时必须弹窗拦截，而不是直接发起检测
				expectModal: [
					'Confirm the firmware source first',
					'no confirmed firmware source yet',
					'What to do',
					'Continue anyway',
					'Go to sources'
				],
				// 触发一次检查，验证弹窗确实出现
				handlers: ['handleCheck']
			},
			{
				// 未确认来源时点「检查更新」：只弹窗，绝不发请求。
				// 曾经的缺陷：返回 Promise 等用户点击，取消后调用链悬空，
				// 按钮停在加载态、请求却照样发出。现在必须一条都不发。
				name: '未确认来源时取消，不发请求',
				data: {
					...baseStatus,
					config: { ...baseStatus.config, active_source: 'immortalwrt', current_firmware_source: '' }
				},
				expectModal: ['Confirm the firmware source first', 'Continue anyway'],
				// 取消弹窗后 check 接口一次都不该被调用
				expectNoRpc: ['check'],
				handlers: ['handleCheck']
			},
			{
				// 通道来源是「由布局决定」这类实现细节时，不展示括号说明
				// 所有通道一律标注来源，保证同一列语义一致：
				// 不能只有 .versions.json 那几种带解释、其余留白。
				name: '布局决定的通道同样标注来源',
				data: {
					...baseStatus,
					last: {
						...baseStatus.last,
						remote: { ...baseStatus.last.remote, channel: 'current', channel_origin: 'layout' }
					}
				},
				expect: ['current (layout)']
			},
			{
				// 有实际意义的来源（.versions.json / config / override）照常显示
				name: '版本发现来源照常显示',
				data: baseStatus,
				expect: ['snapshots (.versions.json)']
			},
			{
				// 本机列只认 current_firmware_source：已确认时显示该源名称
				name: '固件来源按已确认源显示',
				data: {
					...baseStatus,
					config: { ...baseStatus.config, active_source: 'immortalwrt', current_firmware_source: 'immortalwrt' }
				},
				expect: ['Firmware source', 'ImmortalWrt 官方']
			},
			{
				// 未确认时本机列必须是「未知」——不能拿镜像内的文件去猜
				name: '固件来源未确认时显示未知',
				data: {
					...baseStatus,
					config: { ...baseStatus.config, active_source: 'immortalwrt', current_firmware_source: '' }
				},
				expect: ['Firmware source', 'Unknown'],
				expectAbsent: ['Shuery-Shuai/ImmortalWrt-BPI-R4-Firmware', '自有构建']
			},
			{
				// 刷写区按判定结果给出分级提示：fixture 的 last 是 downgrade
				name: '刷写提示随判定结果分级（降级）',
				data: baseStatus,
				expect: ['The remote build is older', 'this is a downgrade', 'This cannot be undone']
			},
			{
				name: '刷写提示随判定结果分级（可升级）',
				data: {
					...baseStatus,
					last: { ...baseStatus.last, verdict: { ...baseStatus.last.verdict, state: 'update', label: '有可用更新' } }
				},
				expect: ['Ready to upgrade', 'normal upgrade', 'in the result section below', 'This cannot be undone']
			},
			{
				// 目标设备取自 profiles.json 的 titles（vendor + model），
				// 本地用 /tmp/sysinfo 的 model —— 都给人看，而不是机器标识
				name: '目标设备显示厂商与型号',
				data: baseStatus,
				expect: ['Target device', 'Bananapi BPi-R4', 'Banana Pi BPI-R4']
			},
			{
				name: '通道已钉住旧稳定版',
				methods: {
					channels: { ...baseChannels, pinned: 'oldstable' }
				},
				expect: ['Old stable release', 'releases/24.10.6', 'Change in settings']
			},
			{
				// 钉住的通道已被源下架：仍要列出来并标警告，不能悄悄回落到「当前通道」
				// 源上已没有旧稳定版线：该项置灰并可被识别出来
				name: '旧稳定版在源上不可用',
				methods: {
					channels: {
						...baseChannels,
						pinned: 'oldstable',
						channels: [
							{ value: 'snapshot', dir: 'snapshots', available: true },
							{ value: 'stable', dir: 'releases/25.12.2', available: true },
							{ value: 'oldstable', dir: '', available: false },
							{ value: 'major', dir: 'releases/25.12.2', available: true },
							{ value: 'minor', dir: 'releases/25.12.2', available: true }
						]
					}
				},
				// 通道已下架时目录为空，只读展示仍要标出名称
				expect: ['Old stable release', 'Change in settings']
			},
			{
				// default 布局（root/targets）的通道恒为 current：要显示，但没有任何可选项
				name: '无下载（default 布局通道固定为 current）',
				methods: {
					channels: {
						ok: true,
						source: 'own_build',
						layout: 'default',
						locked: true,
						pinned: 'current',
						list: ['current'],
						origin: 'layout',
						stable: '',
						oldstable: '',
						cached: false
					}
				},
				// default 布局只有 current：概览页同样只读展示（标签由 layout 决定）
				expect: ['Download image', 'current', 'Change in settings'],
				expectAbsent: ['Follow this device']
			},
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
			channels: baseChannels,
			set_channel: { ok: true, channel: 'stable' },
			set_active: { ok: true, active_source: 'immortalwrt', config: { sources: baseSources.sources } },
			source_add: { ok: true, sources: baseSources.sources, active_source: 'immortalwrt' },
			source_set: { ok: true, sources: baseSources.sources, active_source: 'immortalwrt' },
			source_del: { ok: true, sources: baseSources.sources, active_source: 'immortalwrt' }
		},
		handlers: [
			'handleSaveOptions',
			// 切换激活源必须先弹警告：这里选中另一个源但不确认，只验证弹窗文案
			// 已确认过来源（immortalwrt）后再切到 openwrt：应弹「切换源」警告，
			// 且「从 A」的 A 必须取已确认源，而不是当前激活源。
			{
				name: 'handleSaveActive',
				args: [],
				setup: v => {
					v.currentFirmwareSource = 'immortalwrt';
					v.active = 'openwrt';
				}
			},
			{ name: 'handleDelete', args: ['openwrt'] },
			{ name: 'doDelete', args: ['openwrt'] },
			'handleAdvancedAdd',
			{ name: 'handleEdit', args: ['openwrt'] },
			'handleEditSave'
		],
		cases: [
			{
				// 首次设置来源：current_firmware_source 为空，不是「切换」。
				// 要弹专门的确认框说明这一步的作用与风险，而不是沿用「从 A 换到 B」。
				name: '首次设置来源弹确认框',
				data: {
					...baseStatus,
					layouts: ['official', 'default'],
					config: {
						...baseStatus.config,
						sources: baseSources.sources,
						active_source: baseSources.active_source,
						current_firmware_source: ''
					}
				},
				expectModal: [
					'Confirm the firmware source',
					'Set the firmware source for this device to',
					'Why this matters',
					'This becomes the reference for every later comparison',
					'Set as firmware source'
				],
				// 首次设置不该出现「切换」的说法
				expectModalAbsent: ['Move the active source from', 'Switch source'],
				handlers: [{ name: 'handleSaveActive', args: [], setup: v => { v.active = 'shuery'; } }]
			},
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
					// 更新通道区块必须在「检测源」与「检测与通知」之间
					'Update channel',
					'Current channel',
					'snapshots',
					// 每个通道的定义与取数策略要逐条列出
					'What each channel means',
					'Always probes the snapshots directory',
					'within the same major version as this device',
					'Detection and notification',
					// 说明区按布局类型 / 操作两组呈现
					'Layouts',
					'Actions',
					'Save and apply',
					'Save settings',
					// 档位说明：分段讲清「可升级」的判定与自动刷写的附加条件
					'How "update" is decided',
					'For level 2 to flash, all of these must hold',
					'sha256 verified on an earlier run',
					'Scheduled task',
					'Scheduled task status',
					'Written to crontab',
					'Time (24h)',
					'Edit',
					'Delete',
					'Preset',
					'Advanced',
					// 两种布局的名称与目录结构说明（路径渲染成行内代码块，故单独断言路径本身）
					'OpenWRT/ImmortalWRT official release page directory structure',
					'root/releases/release/targets',
					'Default build output directory structure',
					'root/targets'
				],
				expect: [
					// 折叠区的标题始终可见，细节才收起（这里讲的是定时任务状态，不是网络诊断）
					'Task diagnostics',
					'Identifier',
					'auto-generated when empty',
					'internal UCI section name',
					// 编辑对话框：标题 + 标识只读说明（source_set 回调已在上面的 after 里跑过）
					'Edit source',
					'It is the UCI section name and cannot be changed.'
				],
				// 路径必须渲染成 <code> 行内代码块，而不是普通文本
				requireCode: ['root/releases/release/targets', 'root/targets'],
				// 用户默认只看到「成了没有」：Wanted 那行长命令收进 Diagnostics 折叠区，
				// 展开前不该出现（否则默认界面被超长 cron 占满）。
				// Applied 只在它与期望不一致时才输出——同步状态下本就不该有这一行。
				expectFolded: ['Wanted'],
				expectAbsent: ['Applied'],
				// 切换激活源的警告弹窗：必须在保存前讲清后果
				expectModal: [
					'Switch active source',
					'Move the active source from',
					'What this changes',
					'The last check result is discarded',
					'unattended level 2',
					'Switch source',
				],
				// 对话框（高级 / 编辑）里只应出现布局说明，不应重复「操作」那组文案：
				// 用户已经在执行那个动作，再解释按钮怎么点只会让人困惑。
				expectModalAbsent: [
					'The last table row is quick add',
					'Press Advanced when you need to set the identifier'
				],
				after: async function (view) {
					// 快速添加：缺必填 → 警告；填好 → 成功
					await view.handleQuickAdd();
					view.rowEls.label.value = '测试源';
					view.rowEls.url.value = 'https://rtfw.shuery.lssa.fun';
					await view.handleQuickAdd();
					// 高级对话框
					await view.handleAdvanced();
					// 编辑对话框：入口 → 保存回调（source_set）
					const editModal = await view.handleEdit('openwrt');
					await view.handleEditSave();
					return [
						view.advNode,
						{ attrs: {}, children: [editModal?.title || ''] },
						...(editModal?.children || [])
					];
				},
				orderSequences: [
					['Active', 'Name', 'Layout', 'Address', 'System', 'Actions'],
					['Preset', 'Source label', 'Layout', 'Address', 'System', 'Actions'],
					['Check sources', 'Update channel', 'Detection and notification']
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
						{ ts: 1791118050, level: 'warn', event: 'source', message: '该源上已没有通道 stable' },
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
					'Shown 3 of 3 events',
					'sha256 不匹配',
					'Raw downloader output',
					'Raw scheduled-task output',
					'Scheduled-task log: /tmp/rtfwupgrade/cron.log',
					'未检测：2026-10-02 04:00 UTC',
				],
				// 级别与事件都用徽标呈现，整行按级别着色
				// 三种级别各有一行，整行都要带对应类名
				requireClass: 'rtfw-log-error',
				expectAllClasses: [
					// 整行按级别着色
					'rtfw-log-info',
					'rtfw-log-warn',
					'rtfw-log-error',
					// 事件与级别是两类标签、两套样式，不能共用同一个徽标类
					'rtfw-log-event',
					'rtfw-log-level',
					'rtfw-log-event-check',
					'rtfw-log-event-download'
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
		// 用例的 data 要喂给「该视图主接口」：overview/settings 用 status，logs 用 logs。
		// 否则日志用例的 data 会被完全忽略（load() 走的是 callLogs）。
		var primary = spec.file.indexOf('logs.js') >= 0 ? 'logs' : 'status';
		if (!c.methods || !(primary in c.methods)) methods[primary] = c.data;

		const { ctx, modules, notifications, polled, modals, rpcCalls } = makeContext(methods);

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

			// 折叠区（<details> 子树）里的文案不算「展开前可见」。
			const textOutsideDetails = (function () {
				const out = [];
				(function walk(node) {
					if (node === null || node === undefined) return;
					if (typeof node === 'string' || typeof node === 'number') return out.push(String(node));
					if (Array.isArray(node)) return node.forEach(walk);
					if (typeof node !== 'object') return;
					if (node.tag === 'details') return;
					Object.values(node.attrs || {}).forEach(v => {
						if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
					});
					(node.children || []).forEach(walk);
				})(tree);
				return out;
			})();

			if (c.expectPre) {
				const pre = textOutsideDetails.join(' ');
				const miss = c.expectPre.filter(x => !pre.includes(x));
				if (miss.length) throw new Error('展开前缺少文案: ' + miss.join(', '));
			}

			// 折叠区（<details> 内）的文案在展开前不该出现在默认界面上。
			// 只收 <details> 子树，不把整棵树当「折叠内容」，否则断言恒为假。
			if (c.expectFolded) {
				const folded = [];
				(function walkFolded(node) {
					if (!node || typeof node !== 'object') return;
					if (Array.isArray(node)) return node.forEach(walkFolded);
					if (node.tag === 'details') return collectText(node, folded);
					(node.children || []).forEach(walkFolded);
				})(tree);
				const foldedText = folded.join(' ');
				const pre = textOutsideDetails.join(' ');
				for (const s of c.expectFolded) {
					if (foldedText.includes(s)) continue;
					throw new Error('折叠区缺少文案（应放进 details）: ' + s);
				}
				// 同一份文案不得同时裸露在折叠区之外
				const leaked = c.expectFolded.filter(s => pre.includes(s));
				if (leaked.length) throw new Error('本该折叠的文案泄漏到默认界面: ' + leaked.join(', '));
			}

			// 同步状态下不该出现的文案（例如与期望相同的 Applied 行）
			if (c.expectAbsent) {
				const all = collectText(tree).join(' ');
				const present = c.expectAbsent.filter(s => all.includes(s));
				if (present.length) throw new Error('不该出现的文案仍在界面上: ' + present.join(', '));
			}

			let extraTree = null;

			if (c.after) extraTree = await c.after(view);

			const text = collectText(tree).join(' ') + ' ' + (extraTree ? collectText(extraTree).join(' ') : '');
			globalThis.__lastText = text;

			// 表格必须带 rtfw-table（固定布局 + 表头同侧对齐），否则会出现表头与内容错位

			// 指定类名必须出现在渲染树里（例如日志行按级别加的 rtfw-log-error）
			if (c.requireClass && !JSON.stringify(tree).includes(c.requireClass))
				throw new Error('缺少类名: ' + c.requireClass);
			// 多个类名必须同时存在（日志的 info/warn/error 三种行样式）
			if (c.expectAllClasses) {
				const treeStr = JSON.stringify(tree);
				const miss = c.expectAllClasses.filter(x => !treeStr.includes(x));
				if (miss.length) throw new Error('缺少类名: ' + miss.join(', '));
			}

			// 指定文案必须落在 <code> 元素里（行内代码块）
			if (c.requireCode) {
				const codes = [];
				(function walkCode(node) {
					if (!node || typeof node !== 'object') return;
					if (Array.isArray(node)) return node.forEach(walkCode);
					if (node.tag === 'code') codes.push(collectText(node).join(''));
					(node.children || []).forEach(walkCode);
				})(tree);

				const lostCode = c.requireCode.filter(s => !codes.some(c2 => c2.includes(s)));
				if (lostCode.length) throw new Error('未渲染成行内代码块: ' + lostCode.join(', '));
			}

			// expectPre / expect / expectAbsent 都是可选的：某个用例可以只断言弹窗或 rpc
			const missing = (c.expect || []).filter(s => !text.includes(s));
			if (missing.length) throw new Error('渲染结果缺少文案: ' + missing.join(', '));

			// 弹窗文案单独断言：它由 after 主动弹出，不应混进默认界面文本里
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

			// 用例可用 c.handlers 覆盖 spec 级 handler，便于在同一个视图里测不同入口
			for (const handler of (c.handlers || spec.handlers || [])) {
				const name = typeof handler === 'string' ? handler : handler.name;
				const args = typeof handler === 'string' ? [fakeEv()] : handler.args;

				// 有些处理器依赖渲染后的内部状态（例如“当前激活源”），先让用例摆好再调用
				if (typeof handler === 'object' && typeof handler.setup === 'function') handler.setup(view);

				if (typeof view[name] === 'function') await view[name](...args);
			}

			// 指定 rpc 方法必须被调用过（例如首次确认来源应直接写入，不弹警告）
			if (c.expectRpc) {
				const miss = c.expectRpc.filter(m => !(rpcCalls[m] > 0));
				if (miss.length) throw new Error('应当调用的接口没有被调用: ' + miss.join(', '));
			}

			// 指定 rpc 方法一次都不该被调用（例如用户取消弹窗后不应真的发请求）
			if (c.expectNoRpc) {
				const hit = c.expectNoRpc.filter(m => (rpcCalls[m] || 0) > 0);
				if (hit.length) throw new Error('不该调用的接口被调用了: ' + hit.map(m => m + '×' + rpcCalls[m]).join(', '));
			}

			// 弹窗里不该出现的文案（例如对话框内不该重复表格下方的操作说明）
			if (c.expectModalAbsent) {
				// 对话框内容有两条来路：after 返回的树（如 view.advNode），
				// 以及桩记录的 showModal 调用。两边都要查，少一边就会漏判。
				const parts = [];
				if (extraTree) parts.push(collectText(extraTree).join(' '));
				modals.list.forEach(m => parts.push(collectText(m.children).join(' ')));

				const inertText = parts.join(' ');
				const leaked = c.expectModalAbsent.filter(s => inertText.includes(s));
				if (leaked.length) throw new Error('弹窗里出现了不该有的文案: ' + leaked.join(', '));
			}

			// 弹窗断言放在 handler 之后：弹窗正是 handler 触发的（after 里的弹窗也算）
			if (c.expectModal) {
				const parts = [];
				if (extraTree) parts.push(collectText(extraTree).join(' '));
				modals.list.forEach(m => parts.push(m.title || '', collectText(m.children).join(' ')));

				const modalText = parts.join(' ');
				const lost = c.expectModal.filter(s => !modalText.includes(s));
				if (lost.length) throw new Error('警告弹窗缺少文案: ' + lost.join(', '));
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
