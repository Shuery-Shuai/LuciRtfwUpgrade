# LuciRtfwUpgrade

**在路由器上把「固件更新」做完 —— 检测、下载、校验、刷写、结果确认，全程留在 LuCI 里。**

<p>
<img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Shuery-Shuai/LuciSysUpgrade/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white">
<img alt="Release" src="https://img.shields.io/github/v/release/Shuery-Shuai/LuciSysUpgrade?include_prereleases&label=release&logo=github">
<img alt="License" src="https://img.shields.io/github/license/Shuery-Shuai/LuciSysUpgrade?label=license&color=blue">
<img alt="OpenWrt" src="https://img.shields.io/badge/OpenWrt-24.10%20%7C%2025.12-00a2e8?logo=openwrt&logoColor=white">
<img alt="ImmortalWrt" src="https://img.shields.io/badge/ImmortalWrt-supported-orange">
<img alt="ucode" src="https://img.shields.io/badge/ucode-powered-blueviolet">
</p>

它读取本机构建标识（`BUILD_ID` / `OPENWRT_BUILD_DATE`），与**你配置的发布源**比对，给出
「有更新 / 已是最新 / 远端更旧（可降级）/ 同版本不同构建 / 无法比较」；候选镜像可下载到 `/tmp`
并按源站公布的 `sha256` 校验；通过 **7 条阻断护栏**后可用 `sysupgrade -k -c` 刷写；设备重启后
由**开机闭环**自证结果（成功与失败各投递一次 webhook）。检测与刷写都留痕，`cron` 能在无人值守档位下
把整条链路跑完。

> [!WARNING]
>
> 刷写会重启设备。默认档位下**必须人工确认**（`flash` 只报告，加 `--yes` 才动手）；
> 只有把无人值守档位设成 `2`、且本次判定恰好是 `update` 时，才会自动刷写。
>
> 只支持 **sysupgrade + squashfs** 镜像。factory 镜像会重写引导链或分区表，本项目一律拒绝。

> [!NOTE]
>
> 仓库 slug 沿用历史的 `LuciSysUpgrade`，项目名与包内标识统一为 **`rtfwupgrade`**
> （ucode 的 `require()` 不接受连字符，因此内部名是合成词；包名/CLI/菜单仍可带连字符）。

## 目录

- [✨ 特性](#-特性)
- [🧭 判据：为什么不看发布时间](#-判据为什么不看发布时间)
- [🏗️ 架构](#-架构)
- [🚀 快速开始](#-快速开始)
- [🛠️ 使用](#-使用)
- [🔥 刷写](#-刷写)
- [⚙️ 配置与检测源](#-配置与检测源)
- [🔔 定时任务与通知](#-定时任务与通知)
- [🧪 开发与测试](#-开发与测试)
- [📦 仓库结构](#-仓库结构)
- [📚 文档](#-文档)
- [🤝 贡献](#-贡献)
- [📄 许可证](#-许可证)

## ✨ 特性

- 🔍 **检测**：多源管理、通道自动跟随本机（snapshot / release 线）、按 `board_name` 在
  `profiles.json` 的 `supported_devices` 里自动匹配 profile，并从 `images[]` 挑出
  `sysupgrade` + `squashfs` 候选。
- ⬇️ **下载**：`curl -C -` 续传，续传前必须 `ETag` **与** `Last-Modified` 双双一致，
  否则删残片重下；下载前就按 `file_size_limits.image` 拒绝超大镜像；取消按**进程组**杀，不留孤儿 curl。
- ✅ **校验**：按源站 `profiles.json` 公布的 `sha256` + 体积双重核对，
  `verified` 标记与 sha256 缺一不可。
- 🔥 **刷写**：命令恒为 `sysupgrade -k -c <绝对路径>`（保留配置 + 已装包列表），7 条护栏全过才发起。
- ♻️ **闭环**：`flash-pending → boot-confirmed / flash-failed`，四态状态机跨重启存活，
  非法值一律按 `idle` 处理。
- 🕒 **定时**：调度写进 `/etc/crontabs/root` 的**受管标记块**，块外的 nginx-util / acme 一行不动。
- 🔔 **通知**：通用 webhook（POST JSON），检测/下载/刷写共六类事件，未配置时静默跳过。
- 🌐 **界面**：LuCI「系统 → 路由器固件更新」三页（概览 / 设置 / 日志），i18n 跟随官方 `po/` 机制。
- 🚫 **不碰非官方字段**：不读 HTTP `Last-Modified`、不读文件 mtime、不解析文件名里的日期。

## 🧭 判据：为什么不看发布时间

| 用途                 | 本机字段                                      | 远端字段                               |
| -------------------- | --------------------------------------------- | -------------------------------------- |
| 身份（是否同一构建） | `/usr/lib/os-release` → `BUILD_ID`            | `<dir>/version.buildinfo`              |
| 方向（谁更新）       | `OPENWRT_BUILD_DATE`（= `SOURCE_DATE_EPOCH`） | `profiles.json` → `source_date_epoch`  |
| 方向（发行版通道）   | `VERSION`（如 `25.12.2`）                     | `profiles.json` → `version_number`     |
| 通道发现             | —                                             | 根 `/.versions.json`（官方格式，可选） |

**实测反例**：`rtfw.shuery.lssa.fun` 的 immortalwrt 快照发布于 2026-10-02（看上去最新），
但其源码是上游 2026-07-06 的提交，而设备跑的是 2026-09-29 的源码 —— 按发布时间判定会**推荐用户降级**。
因此方向只由「源码时间戳」与「发行版版本号」决定，契约细节见 [docs/SOURCE-CONTRACT.md](docs/SOURCE-CONTRACT.md)。

判定结果恰好五个取值：

| state          | 含义               | 触发条件                           |
| -------------- | ------------------ | ---------------------------------- |
| `same`         | 已是最新           | 两侧构建标识相同                   |
| `update`       | 有可用更新         | 远端版本更高 / 远端源码更新        |
| `downgrade`    | 远端更旧（可降级） | 远端版本更低 / 远端源码更旧        |
| `rebuild`      | 同版本、不同构建   | 版本号或源码时间相同但构建标识不同 |
| `incomparable` | 无法比较           | 探测失败或缺少可比字段             |

## 🏗️ 架构

前端只经 rpcd 的 ubus 对象 `rtfwupgrade` 访问后端（ACL：`ubus.rtfwupgrade.*` + `uci.rtfwupgrade`），
不在前端拼命令，也不给前端任意文件读写权限。CLI 与 rpcd 共用同一套 ucode 库。

```mermaid
graph TD
    A["LuCI 视图（JS）<br/>htdocs/.../view/rtfwupgrade"] -->|ubus| C["rpcd ucode 对象"]
    B["CLI<br/>/usr/bin/rtfwupgrade.sh"] --> D["ucode 库<br/>/usr/share/ucode/rtfwupgrade"]
    C --> D
    D --> E["util.uc — curl 取文本"]
    D --> F["local.uc — 本机标识"]
    D --> G["source.uc — 源与通道探测"]
    D --> H["verdict.uc — 判定"]
    D --> I["download.uc — 下载状态机"]
    D --> J["flash.uc — 7 条护栏 + 四态状态机"]
    D --> K["scheduler.uc — crontab 受管块"]
    E --> L["源站：version.buildinfo / profiles.json / .versions.json"]
    J --> M["sysupgrade -k -c → 重启"]
    M --> N["init.d/rtfwupgrade（START=95）<br/>flash-status --boot-check"]
```

开机闭环是一条**不经过前端**的路径：`/etc/init.d/rtfwupgrade` → `rtfwupgrade.sh flash-status --boot-check`
→ `flash.boot_check()`，结果回写状态文件并投递刷写 webhook。因此即使 LuCI 没打开、rpcd 被重启，
刷写也一定会被结案。

## 🚀 快速开始

### 1. 装包（推荐：直接用 Release 产物）

到 [Releases](https://github.com/Shuery-Shuai/LuciSysUpgrade/releases/latest) 下载对应格式的包：
25.12 / main 用 apk，24.10 用 opkg，二者由 CI 的 SDK 矩阵分别构建。

```sh
# 25.12 / main（apk-tools）
apk add --allow-untrusted ./luci-app-rtfwupgrade-0.2.0_alpha2-r1.apk

# 24.10（opkg）
opkg install ./luci-app-rtfwupgrade_0.2.0_alpha2-r1_all.ipk
```

中文界面需额外装语言包（主包只含代码与配置，`.lmo` 由官方机制单独打包）：

```sh
apk add --allow-untrusted ./luci-i18n-rtfwupgrade-zh-cn-0.apk
# 或
opkg install ./luci-i18n-rtfwupgrade-zh-cn_0_all.ipk
```

装完刷新一次 LuCI，入口在 **系统 → 路由器固件更新**（英文菜单 **Router Firmware Update**）。
`postinst` 会自动 enable + start 开机闭环服务；从**重命名前的旧包**升级时，
`80_rtfwupgrade` 会在首次启动把旧配置迁移到 `/etc/config/rtfwupgrade`（新配置已被改过则保留新配置）。
旧包的菜单/ACL/视图需要卸载旧包后才会消失，避免新旧两套入口并存。

### 2. 或者从源码编译（SDK）

```sh
# SDK 内
./scripts/feeds update -a && ./scripts/feeds install -a
cp -r luci-app-rtfwupgrade package/
make package/luci-app-rtfwupgrade/compile V=s
```

产物：`bin/packages/*/base/luci-app-rtfwupgrade_*.{ipk,apk}`，外加每个语言目录对应的
`luci-i18n-rtfwupgrade-<lang>` 语言包（24.10 SDK → ipk；25.12 / main SDK → apk）。
必须 `feeds install -a`：`po2lmo` 由 `luci-base` 构建，而它依赖 packages feed 的 `liblua`。

> [!TIP]
>
> 推 CI 前想在本地验证打包，跑 `tools/build-local.sh` —— 它在 Docker 里用两份官方 SDK
> 复刻 CI 矩阵，产物再用 `tools/inspect-package.py` 离线核对（主包不得含 `.lmo`）。

## 🛠️ 使用

命令行入口 `/usr/bin/rtfwupgrade.sh` 是 **ucode 可执行脚本**（shebang `/usr/bin/env ucode`），
`.sh` 只是项目约定的文件名，**不需要**用 `sh rtfwupgrade.sh` 启动。

```sh
rtfwupgrade.sh status         # 本机标识 + 最近一次检测结果
rtfwupgrade.sh sources        # 已配置的源与激活源
rtfwupgrade.sh check          # 检测（激活源）
rtfwupgrade.sh check --source openwrt_official --json
rtfwupgrade.sh check --channel releases/25.12.2   # 仅本次指定通道目录
rtfwupgrade.sh flash          # 刷写检查：打印 7 条护栏与将要执行的命令，不刷写
rtfwupgrade.sh flash --yes    # 护栏全部通过才真正刷写（设备随后重启）
rtfwupgrade.sh flash-status   # 刷写状态（idle / flash-pending / boot-confirmed / flash-failed）
rtfwupgrade.sh flash-clear    # 明确放弃一笔未确认的刷写，状态回 idle
rtfwupgrade.sh cron           # 定时任务入口（crontab 调用的就是它）
rtfwupgrade.sh schedule       # 查看调度与实际 crontab 是否一致
rtfwupgrade.sh version        # 版本号
```

| 选项           | 适用范围             | 说明                                              |
| -------------- | -------------------- | ------------------------------------------------- |
| `--source`     | `check` / `flash` 等 | 仅本次使用指定源，不改写 `active_source`          |
| `--channel`    | `check` / `flash`    | 仅本次使用指定通道目录（如 `releases/25.12.2`）   |
| `--json`       | 所有查询类命令       | 以 JSON 输出                                      |
| `--apply`      | 仅 `schedule`        | 把调度写入 `/etc/crontabs/root`                   |
| `--yes`        | 仅 `flash`           | 护栏通过时真正刷写                                |
| `--force`      | 仅 `flash`           | **只**放行「跨发行版」一条护栏，其余 6 条照旧阻断 |
| `--boot-check` | 仅 `flash-status`    | 开机自检：结案 `flash-pending` 并投递刷写 webhook |

`--yes` 才是「同意刷写」：不加它时 `flash` 恒以退出码 0 退出、只做报告；加了它则在护栏阻断
或发起失败时退出码为 1。

### LuCI 界面

| 页面 | 作用                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 概览 | 状态徽标 + 本机/远端对照 + 判定依据 + 候选镜像 + 下载（进度/取消/续传/删除）+ **刷写**（四态展示、目标四项核对、跨发行版放行勾选、「我确认」勾选框、清除状态）+ 全部镜像折叠列表 |
| 设置 | **检测源**（表格内增删改、单选激活、预设一键套用）与**检测通知**（无人值守档位、定时任务、crontab 同步状态、webhook）                                                            |
| 日志 | 检测/源/设置/下载事件（最新在前），支持按级别、事件类型与内容模糊筛选；另有下载器与 cron 输出尾部；可刷新与清空                                                                  |

<!-- TODO: 补充三页界面截图（overview / settings / logs），建议放在 docs/assets/ 下引用 -->

## 🔥 刷写

命令只有一种形态：`sysupgrade -k -c <镜像绝对路径>`（不加 `-n`，即保留配置）。

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> flash-pending: 护栏全过，状态先落盘再起进程
    flash-pending --> boot-confirmed: 重启后 BUILD_ID == 目标构建
    flash-pending --> flash-failed: 重启后 BUILD_ID != 目标构建
    flash-pending --> idle: flash-clear（明确放弃）
    boot-confirmed --> idle: flash-clear
    flash-failed --> idle: flash-clear
```

| state            | 含义                                     |
| ---------------- | ---------------------------------------- |
| `idle`           | 没有状态文件                             |
| `flash-pending`  | 状态已落盘、刷写已发起（重启前）         |
| `boot-confirmed` | 重启后本机 `BUILD_ID` 等于记录的目标构建 |
| `flash-failed`   | 重启后本机 `BUILD_ID` 与记录的目标不一致 |

### 七条阻断护栏（全部阻断，不是警告）

顺序固定 a→g，全部在 `flash.guards()` 里；`start()` 复用同一份判定，不重复拉 `profiles.json`。
**任何新增的刷写入口（CLI、rpcd、cron、将来别的什么）都必须先过它。**

| #   | 条件                                                                        | 挡住的问题                                   |
| --- | --------------------------------------------------------------------------- | -------------------------------------------- |
| a   | 下载状态 != `verified`                                                      | 镜像没下完或校验没过                         |
| b   | `verified != true` 或 `sha256` 为空                                         | 没有可比对的校验依据                         |
| c   | 记录的 `file` 非绝对路径 / 体积未知 / 实际体积 != 记录体积                  | 文件被换掉、截断或不在了                     |
| d   | `verdict` 不是 `update` 也不是 `rebuild`                                    | 不该为一次没有依据的刷写重启设备             |
| e   | probe 失败 / `image` 为 null / `type!=sysupgrade` 或 `filesystem!=squashfs` | factory 类镜像会重写引导链或分区表，刷了变砖 |
| f   | 跨发行版（按 `system` 段与地址判族）且未 force 放行                         | 换系统不是升级，配置可能不兼容               |
| g   | 上一笔状态仍是 `flash-pending`                                              | 先重启结案，或 `flash-clear` 明确放弃        |

另有 2 条**不阻断**的提示：`rebuild` 只下载不刷、远端 `source_date_epoch` 较旧。

```sh
rtfwupgrade.sh check           # 1. 看结论与依据
# 2. 在概览页点「下载」并等状态变成 verified（或让档位 1 自动下载）
rtfwupgrade.sh flash           # 3. 只报告：7 条护栏 + 将要执行的命令
rtfwupgrade.sh flash --yes     # 4. 设备重启；开机后由 boot-check 自动结案
```

状态文件是 `/etc/rtfwupgrade.flash.json`（放 `/etc` 才跨得过重启，由
`/lib/upgrade/keep.d/rtfwupgrade` 在 sysupgrade 时登记保留；包内 `root/` 前缀会被剥离）。
`sysupgrade` 末尾走 `ubus call system sysupgrade`、命令不会返回，因此只能 `setsid` 后台起、
输出重定向进 `/tmp/rtfwupgrade/flash.log` —— **绝不能同步等待**，也**必须先把状态落盘再起进程**。

## ⚙️ 配置与检测源

配置文件 `/etc/config/rtfwupgrade`（conffile，升级时保留）：

| 选项                       | 取值                                   | 默认    | 说明                                                                 |
| -------------------------- | -------------------------------------- | ------- | -------------------------------------------------------------------- |
| `unattended`               | `0` / `1` / `2`                        | `0`     | 0 仅检测并通知；1 自动下载；2 自动下载并在判定为 `update` 时自动刷写 |
| `schedule_kind`            | `off` / `daily` / `weekly` / `monthly` | `daily` | 定时检测频率                                                         |
| `schedule_time`            | `HH:MM`（24 小时制）                   | `04:00` | 触发时间                                                             |
| `schedule_weekday`         | `1`（周一）… `7`（周日）               | `1`     | 仅 `weekly` 使用                                                     |
| `schedule_day`             | `1`–`28`                               | `1`     | 仅 `monthly` 使用；29–31 号在部分月份不触发，因此禁止                |
| `webhook`                  | URL 或空                               | 空      | 通用 POST JSON 通知，留空则关闭                                      |
| `active_source`            | 源标识                                 | 见下    | **同一时刻只有一条源激活**                                           |
| `flash_allow_cross_distro` | `0` / `1`                              | `0`     | 仅决定**手工**刷写是否默认放行跨发行版护栏；自动路径永远无视它       |

档位的边界是硬的：**只有判定为 `update` 才可能自动刷**，`rebuild`（同版本、不同构建）只下载；
自动路径**永不使用 force**，所以跨发行版护栏在无人值守下无法放行 —— 定时任务不该把设备刷成另一个发行版。

### 检测源与布局

内置三条默认源（都是 `official` 布局）：**ImmortalWrt 官方**、**OpenWrt 官方**、**RTFW 聚合站（immortalwrt）**；
自建编译产物用 `default` 布局。在「设置 → 检测源」里可**新增/删除/编辑**任意遵循下列目录结构的静态镜像。

| layout     | 结构                                                                                           | 路径模板                                                                      | 例子                                  |
| ---------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| `official` | OpenWRT/ImmortalWRT 官方发布页（`root/releases/<ver>/targets`，快照 `root/snapshots/targets`） | `<base>[/<system>]/{snapshots\|releases/<ver>}/targets/<target>/<subtarget>/` | `https://downloads.immortalwrt.org`   |
| `default`  | 默认编译输出目录（`root/targets`，即 `bin/targets` 裸镜像）                                    | `<base>[/<system>]/targets/<target>/<subtarget>/`                             | `https://immortalwrt.shuery.lssa.fun` |

> [!IMPORTANT]
>
> 选到与本机**不同族**的源（例如设备跑 ImmortalWrt、源是 OpenWrt 官方）时，探测会给出跨发行版警告：
> 那属于「换系统」而不是升级，配置文件可能不兼容 —— 常见后果是刷完配置错乱。

校验规则：标识 `^[a-z0-9][a-z0-9_-]{0,31}$`、地址必须 http(s)、布局走白名单；
删除激活源时回退结果会**写实**回 UCI，避免悬空的 `active_source`；最后一条源不允许删除。
源只有「存在」与「激活」两种状态 —— 不引入 `enabled` 之类的中间态。

## 🔔 定时任务与通知

调度被写进 `/etc/crontabs/root` 的**受管标记块**，块外内容一字不动：

```text
# BEGIN rtfwupgrade (managed block, do not edit)
0 4 * * * mkdir -p /tmp/rtfwupgrade && /usr/bin/rtfwupgrade.sh cron >> /tmp/rtfwupgrade/cron.log 2>&1
# END rtfwupgrade
```

三条安全约定：**只动标记块**、写前备份到 `<crontab>.rtfwupgrade.bak`、内容一致就不写文件也不重启 cron（幂等）。
旧版本遗留的标记块在同步时先删除再写新块，避免同一份 crontab 里跑两套命令。
触发点：`set_options` 成功后自动同步、`80_rtfwupgrade` 在首次启动同步一次、卸载时清理自己的块；
手动可跑 `rtfwupgrade.sh schedule --apply`。

webhook 事件（字段只加不减，未配置时静默跳过）：

| 事件            | 时机                                                   |
| --------------- | ------------------------------------------------------ |
| `check_update`  | 检测到 `update` / `rebuild`（已是最新/远端更旧不打扰） |
| `check_failed`  | 检测失败                                               |
| `download_done` | 下载收尾（含失败原因）                                 |
| `flash_started` | 刷写已发起（重启前）                                   |
| `flash_ok`      | 重启后开机闭环确认成功                                 |
| `flash_failed`  | 重启后开机闭环确认失败                                 |

运行态都放 `/tmp/rtfwupgrade/`：`rtfwupgrade.last.json`（最近检测）、`download.json`（下载状态）、
`events.jsonl`（事件日志，超过 256 KB 时从换行处轮转）、`cron.log`、`flash.log` —— 掉电即丢，天然幂等。

## 🧪 开发与测试

```sh
# 主机侧全部静态检查（不需要设备、不需要网络）
sh tests/all.sh -

# 只读验证：同步到路由器 /tmp 并跑 M1 闭环（无需 root）
sh tests/run-on-device.sh ppuc

# 装机验证：安装到系统（走 root 的 ssh 通道，映射同 luci.mk：htdocs/ → /www/）
sh tests/install-on-device.sh ppuc
sh tests/install-on-device.sh --uninstall ppuc

node --check luci-app-rtfwupgrade/htdocs/luci-static/resources/view/rtfwupgrade/overview.js
```

| 入口                                           | 覆盖内容                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `tests/all.sh`                                 | 汇总入口：版本一致性、i18n、视图渲染、仓库一致性、JS 语法、JSON 合法性、shellcheck，再跑真机部分  |
| `tests/version-check.mjs`                      | `Makefile` 的 `PKG_VERSION` ↔ `version.uc`（唯一版本来源）                                        |
| `tests/i18n-check.mjs`                         | 代码/`menu.d` 用到的 msgid 与 `po/` 一致性（缺翻译即失败）                                        |
| `tests/render-check.mjs`                       | 无浏览器渲染检查（Node 桩 + 真机 fixture），抓 `sprintf is not defined` 这类只在浏览器暴露的错误  |
| `tests/consistency-check.mjs`                  | 旧标识/旧布局残留、包布局、cron 行、菜单与 lmo 命名（静态、无设备、无网络）                       |
| `tests/scheduler-unit.uc`                      | crontab 受管块行为回归：块外内容逐字保留、新旧块同时移除、关闭只移除自己的块                      |
| `tests/flash-unit.uc`                          | 刷写行为回归：护栏阻断/放行组合、落盘失败必须不刷、`boot_check()` 两支收敛且不重复上报            |
| `tests/m2-state-machine.sh`                    | 真机下载状态机 5 条分支（不真下载：伪造残片与状态，断言续传/ETag 变化/体积不符/cleanup 杀进程组） |
| `tests/scheduler.sh` / `tests/sources-crud.sh` | 真机验证 crontab 与自定义源/调度的 CRUD 护栏，结束时用备份还原                                    |
| `tests/verify-apk.sh`                          | 设备侧 apk v3 深验（ADB 格式，主机侧只能验到外层）                                                |
| `tools/inspect-package.py`                     | 离线核对产物：主包含代码/视图/配置/菜单/ACL 且**不含 lmo**，语言包恰好一个 lmo                    |

CI 另在 OpenWrt rootfs 容器里做两件事：全量 `ucode -c` 编译检查，以及
`tests/scheduler-unit.uc` / `tests/flash-unit.uc` 的行为回归；`prettier --check` 与 `shellcheck` 是**阻塞项**。
打 tag（`v<PKG_VERSION>`）触发双产物构建：25.12 SDK → `.apk`，24.10 SDK → `.ipk`。

> [!CAUTION]
>
> **新增包内文件后必须先 `git add`**：CI 与 `tools/build-local.sh` 都按 HEAD 的源码取包，
> 未跟踪的新文件会被静默排除 —— 本地照常出货、CI 产物却缺文件。仓库曾有 `.gitignore` 写成非锚定的
> `bin/` 把 CLI 主程序忽略掉的历史，现在 CI 有「包目录文件必须都已入库」的断言兜底。

## 📦 仓库结构

```text
luci-app-rtfwupgrade/
├── Makefile                          # 包定义：依赖、conffiles、postinst/postrm
├── htdocs/luci-static/resources/
│   ├── view/rtfwupgrade/*.js         # overview / settings / logs 三个视图
│   └── rtfwupgrade/{format.js,rtfwupgrade.css}
├── root/                             # root/ 前缀会被剥离，落到设备上的绝对路径
│   ├── usr/bin/rtfwupgrade.sh        # CLI（ucode 脚本）
│   ├── usr/share/rpcd/ucode/rtfwupgrade
│   ├── usr/share/ucode/rtfwupgrade/*.uc
│   ├── usr/share/luci/menu.d/…
│   ├── usr/share/rpcd/acl.d/…
│   ├── etc/config/rtfwupgrade
│   ├── etc/init.d/rtfwupgrade        # 开机闭环，START=95
│   ├── etc/uci-defaults/80_rtfwupgrade
│   └── lib/upgrade/keep.d/rtfwupgrade
└── po/zh_Hans/rtfwupgrade.po         # 翻译源就在包内

docs/            ARCHITECTURE.md、SOURCE-CONTRACT.md
tests/           主机侧 .mjs + 真机侧 .sh + ucode 行为回归
tools/           build-local.sh、inspect-package.py、po2lmo.py
```

i18n 跟随官方约定：源码里用户可见的字符串一律英文 msgid + `_()`，中文放包内 `po/zh_Hans/`；
构建时 `luci.mk` 为 `po/` 下**每个语言目录**生成独立语言包（如 `luci-i18n-rtfwupgrade-zh-cn`，
安装 `rtfwupgrade.zh-cn.lmo` 到 `/usr/lib/lua/luci/i18n/`），主包只含代码与配置 ——
别的语言直接加 `po/<lang>/` 即可参与。真机开发流程用 `tools/po2lmo.py` 本地编 lmo，省掉整套 SDK。

## 📚 文档

- [架构与数据流](docs/ARCHITECTURE.md) —— 组件、M1 检测数据流、下载/刷写状态机、幂等约定、事件日志。
- [源契约](docs/SOURCE-CONTRACT.md) —— 发布端只需产出 `version.buildinfo` 与 `profiles.json`，其余字段可选。
- [Sysupgrade 官方说明](https://openwrt.org/docs/guide-user/installation/sysupgrade)
- [OpenWrt 构建系统](https://openwrt.org/docs/guide-developer/toolchain/use-buildsystem)

## 🤝 贡献

约定见 [CONTRIBUTING.md](CONTRIBUTING.md)：提交用 `<emoji> <type>(<scope>): <中文简述>`，
单一 `main` 分支 + 短生命周期特性分支，PR 必须过 CI；发版 tag 必须与 `PKG_VERSION` 一致。
**刷写路径的护栏是不可协商的** —— 新增任何刷写入口都必须先过 `flash.guards()`，不允许复制一份判断。

```sh
npx --yes prettier@3 --write "**/*.{js,json,yml,md}"   # 格式（CI 是阻塞检查）
sh tests/all.sh -                                       # 全部主机侧检查
```

## 📄 许可证

[GPL-2.0-or-later](LICENSE)。可以并入 GPL-2.0-only 的代码（需保留原版权与许可声明并注明来源），
但**不要 vendor LuCI 源码**（Apache-2.0 会迫使整个作品切到 GPLv3）；运行时依赖 LuCI 即可。

## 🙏 致谢

思路参考 OpenWrt 官方 `luci-app-attendedsysupgrade` 与 `sysupgrade` 脚本的既有约定；
判据与源契约来自对 ImmortalWrt 快照构建元数据的实测。感谢 LuCI / ucode 生态。
