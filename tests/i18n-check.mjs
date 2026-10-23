#!/usr/bin/env node
// i18n 检查：把视图/menu.d 里用到的 msgid 与 po 里的条目比对，列出缺失项。
// 存在的意义：msgid 一旦与 po 不一致（例如代码写 _('Add source')、po 写 "Add a source"），
// 界面就会残留英文，而静态检查与渲染检查都发现不了（_() 在 Node 桩里是恒等函数）。
// 用法: node tests/i18n-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'luci-app-rtfwupgrade');

function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

// 1) 收集代码里的 msgid：_('…')
const used = new Map();
for (const f of walk(path.join(PKG, 'htdocs')).filter(f => f.endsWith('.js'))) {
	const src = fs.readFileSync(f, 'utf8');
	for (const m of src.matchAll(/_\(\s*(['"])((?:(?!\1).)*)\1/g)) {
		const id = m[2];
		if (id) used.set(id, path.relative(ROOT, f));
	}
}

// 2) menu.d 的标题也会被翻译
for (const f of walk(path.join(PKG, 'root')).filter(f => f.endsWith('menu.d') || f.includes('menu.d'))) {
	if (!f.endsWith('.json')) continue;
	const menu = JSON.parse(fs.readFileSync(f, 'utf8'));
	for (const node of Object.values(menu)) if (node && node.title) used.set(node.title, path.relative(ROOT, f));
}

// 3) po 里的 msgid
const PO = path.join(PKG, 'po/zh_Hans/rtfwupgrade.po');
const po = fs.readFileSync(PO, 'utf8');
const translated = new Set();
for (const m of po.matchAll(/^msgid\s+"((?:[^"\\]|\\.)*)"/gm)) {
	// msgid "" 是 po 头（Project-Id-Version 那段），不是可翻译条目；
	// 把它算进来会让统计永远比实际多 1 条，看起来像有残留条目。
	if (!m[1]) continue;
	translated.add(m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'));
}

const missing = [...used.entries()].filter(([id]) => !translated.has(id));
const unused = [...translated].filter(id => id && !used.has(id));

console.log(`msgid 使用 ${used.size} 条，po 提供 ${translated.size} 条`);

if (missing.length) {
	console.log('\n缺少翻译（界面会残留英文/源语言）：');
	for (const [id, file] of missing) console.log(`  - ${JSON.stringify(id)}   ← ${file}`);
}

if (unused.length) {
	console.log('\npo 里未被使用（可清理，不影响功能）：');
	for (const id of unused.slice(0, 12)) console.log(`  - ${JSON.stringify(id)}`);
	if (unused.length > 12) console.log(`  …共 ${unused.length} 条`);
}

process.exit(missing.length ? 1 : 0);
