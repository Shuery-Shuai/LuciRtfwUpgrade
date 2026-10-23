# 架构

## 组件

```
LuCI 视图 (JS)                     CLI
htdocs/.../view/rtfwupgrade/        root/usr/bin/rtfwupgrade.sh
        │  ubus                        │
        ▼                              ▼
rpcd ucode 对象                  同一套库
root/usr/share/rpcd/ucode/       root/usr/share/ucode/rtfwupgrade/*.uc
rtfwupgrade                        │
        └──────────────┬──────────────┘
                       ▼
        util.uc（curl 取文本）  local.uc（本机标识）
        source.uc（源探测）     verdict.uc（判定）  state.uc（/tmp 缓存）
        check.uc（检测编排 + 事件日志 + 检测 webhook）
                       │
                       ▼
        <源>/…/version.buildinfo、profiles.json、.versions.json
```

前端只经 rpcd ubus 对象访问后端（ACL：`ubus.rtfwupgrade.*` + `uci.rtfwupgrade`），
不在前端拼命令，也不给前端任意文件读写权限。

## 数据流（M1 检测）

1. `local.identity()` 读 `/usr/lib/os-release` 与 `/tmp/sysinfo/*` →
   `board_name`、`board_path`（`mediatek/filogic`）、`BUILD_ID`、`OPENWRT_BUILD_DATE`、`version_kind`。
2. `config.load()` 读 UCI，得到源列表与**唯一激活源**（`active_source` 失效时回退到列表第一条源）。
3. `source.discover()` 取 `<base>/.versions.json`：成功则通道列表 = `snapshots` + 每个 `releases/<ver>`；
   失败则回退 `['snapshots']`；`default` 布局直接返回 `['current']`。
4. `source.pick_channel()` 通道跟随本机：snapshot 看 `snapshots`；release 看同版本线的最新 release。
5. `source.probe()` 读 `version.buildinfo` 与 `profiles.json`，用 `supported_devices` 匹配 profile
   （回退：`board_name` 的 `,`→`_`），并从 `images[]` 里挑 `type=sysupgrade` + `filesystem=squashfs` 的候选。
6. `verdict.compare()` 先比身份（`BUILD_ID` vs `version.buildinfo`），再定方向
   （release 用 `version_number` 语义比较；snapshot 用 `source_date_epoch` ↔ `OPENWRT_BUILD_DATE`）。
7. `check.uc` 统一收口：结果写入 `/tmp/rtfwupgrade.last.json`，同时追加 `check` 事件；
   判定为 `update` / `rebuild` 或检测失败时投递检测 webhook。CLI 与 rpcd 都走这条路径，避免「界面有日志、cron 没有」。

## 判定状态

| state          | 含义               | 触发条件                           |
| -------------- | ------------------ | ---------------------------------- |
| `same`         | 已是最新           | 两侧构建标识相同                   |
| `update`       | 有可用更新         | 远端版本更高 / 远端源码更新        |
| `downgrade`    | 远端更旧（可降级） | 远端版本更低 / 远端源码更旧        |
| `rebuild`      | 同版本、不同构建   | 版本号或源码时间相同但构建标识不同 |
| `incomparable` | 无法比较           | 探测失败或缺少可比字段             |

## 自定义源

- 源 = UCI 段（`config source '<name>'`），由「设置」页的检测源表格**增删改**。
- 新建段必须声明类型：ucode 的 uci 模块里是 `ctx.set(CONFIG, name, 'source')`（三参形式）；
  用四参形式写 `type` 选项会返回 null（已实测）。
- 校验：标识 `^[a-z0-9][a-z0-9_-]{0,31}$`、地址必须 http(s)、布局白名单（`config.LAYOUTS` = `official` / `default`）。
- 布局语义：`official` 是 OpenWRT/ImmortalWRT 官方发布页结构（`root/releases/release/targets`，
  快照为 `root/snapshots/targets`）；`default` 是默认编译输出目录结构（`root/targets`）。
  旧配置里的布局别名只在 `config.uc` 的迁移映射里识别，新写入一律用新值。
- 删除激活源时，回退结果会**写实**回 UCI，避免留下悬空的 `active_source`；
  最后一条源不允许删除。
- 源与运行系统不同族时（按 `system` 段与地址判族），探测结果附带**跨发行版警告**。

## i18n 与打包（对照官方）

- 结构对照 `feeds/luci/applications/luci-app-acl`：`Makefile` + `htdocs/` + `po/<lang>/<name>.po`。
- `luci.mk:326-351`：为 `po/` 下每个语言目录生成 `Package/luci-i18n-<basename>-<lang>`，
  其 install 步骤执行 `po2lmo <po> $(LUCI_LIBRARYDIR)/i18n/<name>.<lang>.lmo`
  （`LUCI_LIBRARYDIR` = `/usr/lib/lua/luci`）。
- 因此：**po 必须在包内**，语言包由构建产出；主包不携带 `.lmo`。
- 这套机制的构建前提是 `po2lmo`（由 `luci-base` 构建）→ 需要完整 feeds
  （`luci-base` 依赖 `liblua`，来自 packages feed）。CI 与 `tools/build-local.sh` 都按此配置。
- 设备侧开发流程不走 SDK：`tools/po2lmo.py`（po2lmo 的 Python 移植，哈希实现已用真实
  `base.zh-cn.lmo` 反查校验）在本地生成 lmo 后投到设备。

## 调度设置

- UCI：`schedule_kind`（off/daily/weekly/monthly）、`schedule_time`（24 小时制 `HH:MM`）、
  `schedule_weekday`（1=周一…7=周日）、`schedule_day`（1-28）。
- `config.schedule_cron()` 负责翻译成 5 段 cron，写 crontabs 直接用它：
  `daily 04:30 → 30 04 * * *`、`weekly 三 07:05 → 05 07 * * 3`、`monthly 15 23:59 → 59 23 15 * *`。
- 号数限制 1-28：29-31 号在部分月份不会触发，这个坑对"每月检查"是致命的。
- 校验在 `set_options` 里做（频率白名单、时间正则、星期 1-7、号数 1-28），非法即拒。

## 定时任务落地（M4）

- `scheduler.uc` 负责把调度写进 `/etc/crontabs/root` 的**受管标记块**：
    ```
    # BEGIN rtfwupgrade (managed block, do not edit)
    0 4 * * * mkdir -p /tmp/rtfwupgrade && /usr/bin/rtfwupgrade.sh cron >> /tmp/rtfwupgrade/cron.log 2>&1
    # END rtfwupgrade
    ```
- 三条安全约定：**只动标记块**（块外的 nginx-util / acme 等原样保留）、写前备份到
  `<crontab>.rtfwupgrade.bak`、内容一致就不写文件也不重启 cron（幂等）。
- 旧版本遗留的标记块（旧应用名/旧 CLI 路径）在同步时先删除，再写入新块，避免同一份 crontab 里
  同时跑新旧两套命令。
- 触发点：`set_options` 成功后自动同步；`/etc/uci-defaults/80_rtfwupgrade` 在**首次启动**
  （S10boot 跑 uci-defaults）时同步一次：此时新配置仍为默认内容就把旧配置迁移到
  `/etc/config/rtfwupgrade`，已改过则保留新配置；卸载时清理自己的标记块。
  安装后若不重启，最长要等到下一次开机才会写入受管块，可手动跑
  `rtfwupgrade.sh schedule --apply`。
- 手动可用 `rtfwupgrade.sh schedule` 查看期望/实际 cron 行，`rtfwupgrade.sh schedule --apply` 写入。
- `rtfwupgrade.sh cron` 是定时入口：检测 → **记录 `check` 事件** → 档位 ≥1 且判定为 `update` / `rebuild` 时自动下载；
  档位 2 需要的刷写能力尚未实现，触发自动下载时会向事件日志写一条 `warn`/`cron` 说明
  「刷写未实现，当前仅下载」（不会静默假装完成）。

## 事件日志

- `eventlog.uc` 往 `/tmp/rtfwupgrade/events.jsonl` 追加单行 JSON：`{ts, level, event, message, data?}`。
- `event` 目前有 `check` / `source` / `options` / `download` / `cron`；`level` 为 `info|warn|error`。
  检测（无论来自 CLI、cron 还是 rpcd）、源增删改、设置保存、下载开始/结束/取消都会留痕。
- 超过 256 KB 时丢弃前半段做轮转（从换行处切，避免半行）。
- `logs` 方法返回最近事件 + `download.log` 尾部 + `cron.log` 尾部；`logs_clear` 清空事件与 `cron.log`
  （已下载的镜像不受影响）。
- 界面「日志」页只读展示；写日志的钩子在 `check.uc`、rpcd 插件与 `download.uc` 里。
- webhook：检测到 `update` / `rebuild` 时投递 `check_update`，检测失败投递 `check_failed`，
  下载收尾投递 `download_done`（已是最新/远端更旧不打扰）；未配置 webhook 时静默跳过。

## 下载状态机（M2）

```
idle ──download──▶ running ──(进程组退出)──▶ verified | failed
                     │
                     └──cancel──▶ cancelled ──download──▶ running（续传，resumed_from>0）
```

- 落盘：`/tmp/rtfwupgrade/<镜像名>`；状态：`download.json`；退出码：`download.rc`（后台命令写）。
- **收尾不依赖守护进程**：`status()` 发现进程组已退出就做体积/sha256 校验并投递 webhook，
  再写回状态；因此重启 rpcd 也不会丢状态机。
- **取消按进程组杀**（`kill -TERM -<pgid>`）：只杀组长会留下孤儿 curl 继续写文件（已实测踩坑）；
  `cleanup`（删除文件）同样会先杀进程组，否则 curl 会把删掉的文件重新写出来；它只删下载产物，
  保留 `events.jsonl` 与 `cron.log`（清日志是「日志」页的显式动作）。
- **续传保护**：只有 `ETag` **与** `Last-Modified` 都与上次一致才允许 `-C -`，否则删掉残片重下；
  判定原因写进 `resume_reason`，界面上能看到为什么没续传。
- 启动前会清扫残留下载进程，避免两个 curl 同时写同一个文件。
- `file_size_limits.image` 在**下载前**校验：镜像超过 profile 上限直接拒绝下载，
  不是刷写前才检查（本项目不刷写）。

## 状态与幂等

- 持久配置：`/etc/config/rtfwupgrade`（随 `sysupgrade -k` 备份）。
- 运行态：`/tmp`（`rtfwupgrade.last.json`、`rtfwupgrade/download.json`）；掉电即丢，天然幂等。
- M3 暂缓：刷写三态日志（`downloaded → flash-pending → boot-confirmed`）与刷写类 webhook 事件；
  检测 webhook（`check_update` / `check_failed`）与下载完成 webhook（`download_done`）已实现。

## 不做的事

- 不使用 HTTP `Last-Modified`、文件 mtime、文件名里的日期作为更新判据（原因见 `SOURCE-CONTRACT.md`）。
- 不碰原生 `view/system/flash.js`，不接管系统刷写入口。
