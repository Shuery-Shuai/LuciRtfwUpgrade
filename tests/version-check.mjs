#!/usr/bin/env node
// 版本一致性检查：Makefile 的 PKG_VERSION 必须与包内 version.uc 相同。
// 存在的意义：这两个值分处两处，改一个忘一个时，用户看到的版本号会与实际包名不符
//（已踩过：CLI 报 0.1.0、rpcd 报 0.1.0_alpha1）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'luci-app-rtfwupgrade');

const pkgVersion = fs.readFileSync(path.join(PKG, 'Makefile'), 'utf8').match(/^PKG_VERSION:=(.+)$/m)?.[1].trim();
const modVersion = fs.readFileSync(path.join(PKG, 'root/usr/share/ucode/rtfwupgrade/version.uc'), 'utf8')
	.match(/VERSION:\s*'([^']+)'/)?.[1];

console.log(`Makefile PKG_VERSION = ${pkgVersion}`);
console.log(`version.uc  VERSION   = ${modVersion}`);

if (!pkgVersion || !modVersion) {
	console.log('\n✗ 有一侧没解析出来（文件被改动？）');
	process.exit(1);
}

if (pkgVersion !== modVersion) {
	console.log('\n✗ 不一致：请把 version.uc 的 VERSION 改成与 PKG_VERSION 相同');
	process.exit(1);
}

console.log('\n✓ 一致');
