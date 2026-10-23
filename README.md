# LuciRtfwUpgrade

检测 ImmortalWrt / OpenWrt 路由器固件更新的 LuCI 应用。**做检测 + 下载、不刷写**：读取本机构建标识，
与配置的发布源比对，给出「有更新 / 已是最新 / 远端更旧（可降级）/ 同版本不同构建 / 无法比较」，
候选镜像可下载到 `/tmp` 并按源站公布的 sha256 校验。

> 当前里程碑：**M1（检测闭环）与 M2（下载 + sha256/体积校验）** 均已在 Banana Pi BPI-R4
> （ImmortalWrt SNAPSHOT，apk-tools 3.0.5）上验证通过：下载 28.8 MB 镜像并与源站公布值比对一致，
> 续传/ETag 变化/sha256 不匹配等分支由 `tests/m2-state-machine.sh` 断言覆盖。
> M4 已落地：**定时任务**（写入 `/etc/crontabs/root` 的受管标记块，块外内容一字不动，
> 见 `tests/scheduler.sh`）与**双产物 CI**（`.apk` / `.ipk`；构建先用 `tools/build-local.sh`
> 在本地 Docker 里验证）。**M3（刷写）仍暂缓**。

## 它做什么 / 不做什么

|      |                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 做   | 读取本机 `BUILD_ID` / `OPENWRT_BUILD_DATE`，探测远端 `version.buildinfo` / `profiles.json`，判定更新状态  |
| 做   | 多源管理，但**同一时刻只激活一个源**（切换式）                                                            |
| 做   | 按 `board_name` 在远端 `profiles.json.supported_devices` 中自动匹配 profile                               |
| 做   | 下载候选镜像到 `/tmp`（`curl -C -` 续传，续传前比对 ETag/Last-Modified）、按源站 sha256 校验、可取消/清理 |
| 不做 | 调用 `sysupgrade` 刷写（M3 暂缓）                                                                         |
| 不做 | 依赖任何非官方字段（不读 HTTP `Last-Modified`、不读文件 mtime、不解析文件名日期）                         |

## 判据

| 用途                 | 本机字段                                      | 远端字段                               |
| -------------------- | --------------------------------------------- | -------------------------------------- |
| 身份（是否同一构建） | `/usr/lib/os-release` → `BUILD_ID`            | `<dir>/version.buildinfo`              |
| 方向（谁更新）       | `OPENWRT_BUILD_DATE`（= `SOURCE_DATE_EPOCH`） | `profiles.json` → `source_date_epoch`  |
| 方向（发行版通道）   | `VERSION`（如 `25.12.2`）                     | `profiles.json` → `version_number`     |
| 通道发现             | —                                             | 根 `/.versions.json`（官方格式，可选） |

**为什么不用发布时间**：实测 `rtfw.shuery.lssa.fun` 的 immortalwrt 快照发布于 2026-10-02（最新），
但其源码是上游 2026-07-06 的提交；而设备跑的是 2026-09-29 的源码。
按发布时间判定会**推荐用户降级**。详见 `docs/SOURCE-CONTRACT.md`。

## 源与布局

| layout     | 结构                                                                                                   | 路径模板                                                                      | 例子                                  |
| ---------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------- |
| `official` | OpenWRT/ImmortalWRT 官方发布页结构（`root/releases/release/targets`，快照为 `root/snapshots/targets`） | `<base>[/<system>]/{snapshots\|releases/<ver>}/targets/<target>/<subtarget>/` | `https://downloads.immortalwrt.org`   |
| `default`  | 默认编译输出目录结构（`root/targets`，即 `bin/targets` 裸镜像）                                        | `<base>[/<system>]/targets/<target>/<subtarget>/`                             | `https://immortalwrt.shuery.lssa.fun` |

内置三条默认源：**ImmortalWrt 官方**、**OpenWrt 官方**、**RTFW 聚合站（immortalwrt）**，都是
`official` 布局；自建编译产物用 `default` 布局。在「设置 → 检测源」里可以**新增/删除/编辑**
任意遵循上述目录结构的静态镜像（标识、名称、地址、布局、系统段），并可一键套用预设。
同一时刻只有一条源处于激活状态。

> 选到与本机不同族的源时（例如设备跑 ImmortalWrt、源是 OpenWrt 官方），探测会给出
> **跨发行版警告**：那属于「换系统」而不是升级，配置文件可能不兼容 —— 常见的后果是刷完配置错乱。

## 安装

```sh
# SDK 内
./scripts/feeds update -a && ./scripts/feeds install luci-base
cp -r luci-app-rtfwupgrade package/
make package/luci-app-rtfwupgrade/compile V=s
```

产物：`bin/packages/*/base/luci-app-rtfwupgrade_*.{ipk,apk}`（24.10 SDK → ipk；25.12/main SDK → apk）。

> 从旧包升级：新配置仍为默认内容时，`80_rtfwupgrade` 会把旧配置迁移到
> `/etc/config/rtfwupgrade`（旧布局别名会在读入时归一化）；如果已经在新配置里改过，
> 则保留新配置。旧包的菜单/ACL/视图需要卸载旧包后才会消失，避免新旧两套入口并存。

## 使用

```sh
rtfwupgrade.sh status         # 本机标识 + 最近一次检测结果
rtfwupgrade.sh sources        # 已配置的源与激活源
rtfwupgrade.sh check          # 检测（激活源）
rtfwupgrade.sh check --source rtfw_immortalwrt --json
rtfwupgrade.sh check --channel releases/25.12.2   # 仅本次指定通道目录
rtfwupgrade.sh cron           # 定时任务入口（crontab 调用的就是它）
rtfwupgrade.sh schedule       # 查看调度与实际 crontab 是否一致
rtfwupgrade.sh schedule --apply  # 把调度写进 /etc/crontabs/root（只动自己的标记块）
rtfwupgrade.sh version        # 版本号
```

> `rtfwupgrade.sh` 是 **ucode 可执行脚本**（shebang `/usr/bin/env ucode`），`.sh` 只是项目约定的文件名，
> 不需要用 `sh rtfwupgrade.sh` 启动。

`cron` 按无人值守档位行动：0 只检测（有更新/失败时按配置投递 webhook），1 在判定为
`update` / `rebuild` 时自动下载，2 还需要刷写能力（M3 暂缓：触发自动下载时会额外记一条事件
说明刷写未实现，而不是静默失败）。

LuCI 界面：**系统 → 路由器固件更新**（英文菜单 **Router Firmware Update**），三个页面（概览/设置/日志）

| 页面 | 作用                                                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 概览 | 状态徽标 + 本机/远端对照 + 判定依据 + 候选镜像 + 镜像下载（进度/取消/续传/删除）+ 全部镜像折叠列表                                                        |
| 设置 | **检测源**（表格内增删改、单选激活、预设）与**检测通知**（无人值守档位、**定时任务：每日／每周几／每月几号 + 24 小时制时间**、crontab 同步状态、webhook） |
| 日志 | 检测/源/设置/下载事件（最新在前），**支持按级别、事件类型与内容模糊筛选**；另有下载器原始输出与 cron 输出尾部；可刷新与清空                               |

配置：`/etc/config/rtfwupgrade`（`unattended` 0/1/2，默认 0 = 仅检测并通知；
`schedule_kind` / `schedule_time` / `schedule_weekday` / `schedule_day` 控制定时任务）。

## 开发与测试

```sh
# 主机侧全部静态检查（不需要设备）
sh tests/all.sh -

# 只读验证：同步到路由器 /tmp 并跑 M1 闭环（无需 root）
sh tests/run-on-device.sh ppuc

# 装机验证：安装到系统（走 root 的 ssh 通道，映射同 luci.mk：htdocs/ → /www/）
sh tests/install-on-device.sh ppuc
sh tests/install-on-device.sh --uninstall ppuc     # 卸载

node --check luci-app-rtfwupgrade/htdocs/luci-static/resources/view/rtfwupgrade/overview.js
```

`tests/all.sh` 会依次跑版本一致性、i18n、视图渲染、仓库一致性（旧标识/布局/工具链残留）、
JS 语法、JSON 合法性与 shellcheck；真机部分再跑 `run-on-device.sh` / `scheduler.sh` /
`sources-crud.sh` / `m2-state-machine.sh`。

CI 另在 OpenWrt rootfs 容器里做两件事：全量 `ucode -c` 编译检查，以及
`tests/scheduler-unit.uc` 的行为回归（crontab 的块外内容必须逐字保留、新旧受管块同时移除、
关闭调度只移除自己的块）。

## i18n 与打包结构（跟随官方约定）

```
luci-app-rtfwupgrade/
├── Makefile
├── htdocs/luci-static/resources/{view/rtfwupgrade/*.js,rtfwupgrade/{format.js,rtfwupgrade.css}}
├── root/…                       # ucode 库、CLI、rpcd 对象、菜单、ACL、配置
└── po/zh_Hans/rtfwupgrade.po    # 翻译源就在包内
```

构建时由 `luci.mk` 为 `po/` 下的**每个语言目录生成一个独立语言包**
（`luci-i18n-rtfwupgrade-zh-cn` 等，安装 `rtfwupgrade.<lang>.lmo` 到 `/usr/lib/lua/luci/i18n/`，
例如 `rtfwupgrade.zh-cn.lmo`），
主包只含代码与配置 —— 这是 LuCI 生态的标准做法，别的语言可以直接加 `po/<lang>/` 参与。

开发时（`tests/install-on-device.sh`）用 `tools/po2lmo.py` 在本地把 po 编成 lmo 再投到设备，
省掉整套 SDK 构建；正式产物仍由 luci.mk 生成。

## 许可证

GPL-2.0-or-later，见 `LICENSE`。约定见 `CONTRIBUTING.md`。
