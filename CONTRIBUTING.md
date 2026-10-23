# 贡献约定

## 提交规范

`<emoji> <type>(<scope>): <中文简述>`

- 沿用本仓库既有的 emoji + Conventional Commits 风格，**subject 用中文**。
- type：`feat` / `fix` / `docs` / `chore` / `refactor` / `test` / `perf` / `style`。
- scope 白名单：`init` `luci` `backend` `source` `upgrade` `pkg` `ci` `docs` `deps` `tests`。
- 示例：`✨ feat(source): 支持从 .versions.json 发现发行版通道`、
  `🐛 fix(backend): 修正 gmtime 月份偏移`。

## 分支与发布

- 单 `main` 分支 + 短生命周期特性分支，PR 必须过 CI。
- 发布用 tag：`vX.Y.Z`，与 `luci-app-rtfwupgrade/Makefile` 的 `PKG_VERSION` **保持一致**；
  每次发版递增 `PKG_RELEASE`（同版本重打包时）。
- 产物发布在 GitHub Release（24.10 SDK 出 `.ipk`，25.12/main SDK 出 `.apk`）。

## 许可证规则（GPL-2.0-or-later）

- 本项目按 `GPL-2.0-or-later` 分发，源码文件不强制加头部声明，`LICENSE` 为准。
- **可以**并入 GPL-2.0-only 的代码（例如 `luci-app-attendedsysupgrade`），
  但必须在该文件保留原始版权与许可声明，并在提交信息中说明来源。
- **不要 vendor LuCI 源码**：LuCI 主体是 Apache-2.0，一旦并入整个作品必须切换到 GPLv3，
  会把 GPLv3 的 Installation Information 条款带进固件分发。运行时依赖 LuCI 即可。

## 代码约定

### ucode（后端）

- 模块用顶层 `return { ... }` 导出；**模块间用 dotted require**（`require('rtfwupgrade.util')`），
  库文件必须放在 `root/usr/share/ucode/rtfwupgrade/` 下（ucode 默认搜索路径是 `/usr/share/ucode`）。
- **`rtfwupgrade` 作为内部标识保持单 token，不要改成 `rtfw-upgrade`**：ucode 的 `require()`
  只接受字母/数字/下划线（`ucode/src/lib.c` 里 `!isalnum(*q) && *q != '_'` 直接判失败），
  带连字符会让 CLI 与 rpcd 插件一起加载失败（真机 A/B 实测：只差一个连字符，
  带连字符的目录报 `No module named …`）。包名/CLI/菜单/视图**可以**带连字符，
  但本项目统一用合成词，与官方 `luci-app-attendedsysupgrade`（包名带连字符、内部名
  `attendedsysupgrade`）同构；OpenWrt 的连字符惯例只用于「两个真词之间」
  （`package-manager` / `argon-config` / `ddns-go`），而 `rtfw` 是缩写。
- 已踩过的坑，别再踩：
    - 没有 `isNaN()`：用 `n != n` 判定 NaN（`int('abc')` 返回 NaN 且 `type` 是 `double`）。
    - **函数声明不会提升**：`function a()` 调用后面定义的 `function b()` 会报
      `access to undeclared variable b` —— 依赖顺序必须是「先定义后使用」。
    - 没有 `strftime()`：用 `gmtime()` 的字段自己格式化；注意 `mon` 是 **1 基**、日期字段是 `mday`。
    - `substr()` **按字节**切：中文字符 3 字节，`substr('日一二三', 2, 1)` 会切出半个字（显示成 `�`）。
      要按字符取内容就用数组映射，别切多字节字符串。
    - `require()` 不吃绝对路径，也没有 `dofile()`；模块必须放 `/usr/share/ucode/<pkg>/` 并用 dotted require；
      `-L <dir>` 只对调试/测试有意义。
    - `fs.popen(cmd, 'r')` + `fp.close()` 取退出码；命令里用 `2>/dev/null` 抑制 stderr。
- 所有远端读取走 `util.http_get()`（内部是设备自带 curl），不要另起下载实现。
- 读 UCI 前先 `ctx.load(CONFIG)`：rpcd 是常驻进程，显式 reload 才不会被进程内的旧快照骗到。
- 源只有「存在」与「激活」两种状态，**不要再引入 enabled 之类的中间态**：一个被禁用的源
  被设为激活源时，回退逻辑会静默换成别的源，排查成本极高（本项目已经踩过一次）。

### i18n

- 源码里的用户可见字符串一律用**英文 msgid** 并包 `_()`，中文放**包内** `luci-app-rtfwupgrade/po/zh_Hans/rtfwupgrade.po`
  （官方约定：po 在包内，构建时由 luci.mk 为每个语言生成 `luci-i18n-rtfwupgrade-<lang>` 语言包）；
  menu.d 的标题同样走这套（LuCI 会用应用的 catalog 翻译菜单）。
- 正式构建由 `luci.mk` 调 **po2lmo** 生成语言包；po2lmo 由 luci-base 提供，
  所以构建需要完整 feeds（`feeds update -a && feeds install -a`），不能只装 luci feed。
- **真机装机脚本**（开发流程，不走 SDK）用 `tools/po2lmo.py` 本地生成，并按运行时语言码同时装
  `rtfwupgrade.zh-cn.lmo` 与 `rtfwupgrade.zh_Hans.lmo`（新旧命名兼容）。
- 语言包命名由 luci.mk 映射：`po/zh_Hans` → 包名 `luci-i18n-rtfwupgrade-zh-cn`。

### shell

- POSIX `sh`，`shellcheck` 零告警（配置见 `.shellcheckrc`）。覆盖范围必须包括
  `tests/*.sh`、`tools/*.sh` 与**包内** `luci-app-rtfwupgrade/root/etc/uci-defaults/*`
  （CI 与 `tests/all.sh` 都按这个范围跑；装机脚本同样会被安装到设备上执行，不能漏检）。
- **`$VAR` 后面紧跟中文/全角字符时必须写 `${VAR}`**：否则 shell 会把多字节字符当成变量名的一部分，
  报 `HOST）: unbound variable` 这类莫名错误（已踩过两次：`$HOST）`、`$IMG 大小`）。

### LuCI 前端

- `htdocs/luci-static/resources/view/rtfwupgrade/*.js`，`useTabs` 由 prettier 统一。
- 只通过 rpcd ubus 对象 `rtfwupgrade` 访问后端，不在前端拼命令。
- **浏览器端没有 `sprintf`**：用 `'%s %s'.format(a, b)`（LuCI 的 `String.prototype.format`）。
  这个错误在 Node 静态检查里也能暴露 —— 先跑 `node tests/render-check.mjs`。
- `_()` **不消费占位符**：写 `_('共 %d 条').format(n)`，不要写 `_('共 %d 条', n)`。
  Node 桩里也必须如实保留占位符，否则断言会假失败（已踩过一次）。
- 引用其它模块用 `'require rtfwupgrade.format as fmt';`：`as` 别名受支持
  （luci.js 的正则 `/^require[ \t]+(\S+)(?:[ \t]+as[ \t]+([a-zA-Z_]\S*))?$/`），
  不写 `as` 时变量名是模块路径把非字母数字换成下划线（`rtfwupgrade_format`）。

## 改代码时的纪律

- **脚本化改动必须带断言**：用 python/sed 批量改文件时，每个 `replace`/`sed` 后都要断言"确实改了"。
  已经踩过两次静默失败：一次是 `--apply` 参数解析分支没插进去（搜索串多带了一个 `else`），
  一次是 po 清理误删了 menu.d 用的 `Overview`。改完必须跑对应检查（`tests/*.sh`、`node tests/*.mjs`）。
- **新增包内文件后必须先 `git add`**：`tools/build-local.sh` 与 CI 都用 `git archive HEAD` 取源码，
  **未提交的新文件会被静默排除**，本地照常出货、CI 产物却缺文件。本仓库历史上就因此让 CLI 主程序
  一直没进过仓库（`.gitignore` 写了非锚定的 `bin/`）。CI 有「包目录文件必须都已入库」的断言兜底
  （`git status --ignored --short -- luci-app-rtfwupgrade`，命中 `??` 或 `!!` 即失败），
  但本地 `tools/build-local.sh` 会把这个疏漏完全掩盖掉 —— 别依赖 CI 才发现。
- **刷写路径的护栏是不可协商的**：任何新增的刷写入口（CLI、rpcd、cron、将来别的什么）都必须先过
  `flash.guards()` 再谈执行，不允许复制一份判断或用「已经检查过了」跳过它。护栏的顺序与
  阻断语义是安全边界（镜像未校验、判定不是 update/rebuild、跨发行版、上一笔未结案），
  少一条就是把设备刷成砖的入口。自动路径额外禁用 force。

## 测试

- `python3 tools/inspect-package.py <产物>`：**离线核对构建产物**（.ipk 是 gzip 包裹的 tar，
  内层 data.tar.gz；.apk 是 apk v3 的 ADB 格式，需设备侧用 `tests/verify-apk.sh` 深验）。
  主包应含代码/视图/配置/菜单/ACL 且**不含 lmo**；`luci-i18n-rtfwupgrade-<lang>` 语言包应恰好含一个 lmo。
- `node tests/i18n-check.mjs`：比对代码/menu.d 用到的 msgid 与 po 条目，缺翻译即失败（会列出文件与 msgid）。
  它专治一类静默问题：msgid 写得不一致时界面残留英文，而静态检查与渲染检查都发现不了
  （`_()` 在 Node 桩里是恒等函数）。
- `node tests/render-check.mjs`：**无浏览器渲染检查**。按 luci.js 的规则把视图的
  `'require … as …'` 指令绑成参数（正则与 luci.js 一致），用桩跑 `load()` / `render()` / 事件处理器，
  fixture 取自真机 `ubus call` 的真实输出。它能抓住 `sprintf is not defined` 这类**只有浏览器才暴露**的错误。
- `node tests/consistency-check.mjs`：仓库一致性检查（**静态、无设备、无网络**）：
  旧标识/旧布局名残留、Makefile 的 `+ucode-mod-digest` 与 `/etc/config/rtfwupgrade`、
  scheduler 的 cron 行（`mkdir -p /tmp/rtfwupgrade` + `/usr/bin/rtfwupgrade.sh`）、
  菜单标题与其中文翻译、CLI 路径与 lmo 命名。旧标识只允许出现在精确白名单的迁移代码里。
- `tests/scheduler-unit.uc`：CI 的 ucode 容器作业运行的行为回归 —— 同步时块外 nginx-util/acme
  行必须保留、新旧受管块同时移除、关闭调度只移除自己的块（防止 `strip_block()` 返回数组被误当文本）。
- `tests/flash-unit.uc`：刷写路径的**行为级回归**，与 `tests/scheduler-unit.uc` 同法跑
  （`ucode -L luci-app-rtfwupgrade/root/usr/share/ucode tests/flash-unit.uc`）。它**绝不真刷**：
  只断言护栏的阻断/放行组合、`flash-pending` 的落盘顺序（落盘失败必须不刷）、
  `boot_check()` 的两支收敛与「不重复上报」。因为要写 `/etc/rtfwupgrade.flash.json`，
  它需要可写的 `/etc`；在只读环境下会**自动 skip**（以退出码区分 skip 与失败），
  所以主机侧跑全量检查时不会假失败。
- `tests/run-on-device.sh [ssh别名]`：把包内文件同步到路由器 `/tmp`，做全量 `ucode -c` 编译检查，
  并跑 `version / sources / status / check` 多组真机场景（用实际默认源名
  `immortalwrt_official` / `openwrt_official` / `rtfw_immortalwrt`，不再使用已删除的旧别名）。
- `tests/install-on-device.sh [ssh别名]`：装机（含 i18n 编译），`--uninstall` 卸载。
- `tests/scheduler.sh [ssh别名]`：真机验证定时任务 —— 写入/幂等/块内被手改后自愈/关闭时只移除标记块，
  并断言**块外内容一字不动**（含你原有的 nginx-util 与 acme 两行）；结束时用备份还原。
- `tests/sources-crud.sh [ssh别名]`：真机验证自定义源的增删改与护栏（非法输入、重名、标识自动派生、
  激活源自愈、至少保留一条源）**以及调度设置**（频率/星期/号数/时间的合法与非法输入），
  会临时改动配置并在结束时用备份还原。
- `tests/m2-state-machine.sh [ssh别名]`：真机验证下载状态机的 5 条分支。**不真下载**（不受 CDN 速度影响）：
  用 `check` 拿候选镜像的 url/size/sha256、用 HEAD 拿 etag/last-modified，再伪造「部分文件 + 状态」，
  断言续传命中、ETag 变化拒绝续传、体积不符判失败、成功路径写完成事件、cleanup 杀进程组。
- macOS 打包务必带 `COPYFILE_DISABLE=1 tar --no-xattrs`，否则 `._*` 元数据文件会混进归档。
- 逻辑改动的验收标准：在真机上跑通上述场景，且结论与预期一致（见脚本内注释）。

## 里程碑

|     | 内容                                                                                                                        | 状态               |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| M1  | 检测闭环：源抽象、两种 layout、判据、CLI、rpcd、LuCI 概览页                                                                 | 已完成并在真机验证 |
| M2  | 下载与校验（`curl -C -` 续传、`profiles.json.images[].sha256`、`file_size_limits.image` 下载前校验）                        | 已完成并在真机验证 |
| M3  | 刷写（`sysupgrade -k -c`、7 条阻断护栏、四态状态机）、刷写日志、刷写类 webhook（`flash_started`/`flash_ok`/`flash_failed`） | 已完成/已落地      |
| M4  | 定时检测（`/etc/crontabs/root` 标记块）、ipk+apk 双产物 CI                                                                  | 已落地             |

webhook 事件全貌：检测到 `update` / `rebuild` 时投递 `check_update`，检测失败投递 `check_failed`
（其余不打扰）；下载收尾投递 `download_done`；刷写发起投递 `flash_started`，重启后由开机闭环
投递 `flash_ok` 或 `flash_failed`。未配置 webhook 时静默跳过。
