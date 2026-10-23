# 源契约

客户端只依赖 **官方 OpenWrt / ImmortalWrt 构建系统一定会产出** 的文件，不发明新格式。
`rtfw.shuery.lssa.fun` 与 `immortalwrt.shuery.lssa.fun` 只要向官方看齐即可被直接支持。

## 必需文件

| 路径                            | 作用                             | 备注                                                  |
| ------------------------------- | -------------------------------- | ----------------------------------------------------- |
| `<targetdir>/version.buildinfo` | 构建标识，例 `r41386-45474b1733` | 与镜像内 `/etc/os-release` 的 `BUILD_ID` **同源同值** |
| `<targetdir>/profiles.json`     | 目标元数据                       | 见下方字段                                            |

## profiles.json 用到的字段

| 字段                                     | 语义                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `target`                                 | `mediatek/filogic`                                         |
| `version_number`                         | `SNAPSHOT` 或 `25.12.2`                                    |
| `version_code`                           | `r<rev>-<sha>`（release/snapshot 都有）                    |
| `source_date_epoch`                      | 源码时间戳，等于构建时使用的 `SOURCE_DATE_EPOCH`           |
| `profiles.<name>.supported_devices`      | 本机 `board_name`（`bananapi,bpi-r4`）在此列表中           |
| `profiles.<name>.images[]`               | `type` / `filesystem` / `name` / `size` / `sha256`         |
| `profiles.<name>.file_size_limits.image` | 镜像体积上限，**下载前**校验（超出即拒绝下载，不是刷写前） |

注意：`git_commit` **只在 snapshot 的 profiles.json 里存在**（release 没有），因此不能作为判据。

## 可选文件

| 路径                    | 作用                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `<base>/.versions.json` | 通道发现：`stable_version` / `oldstable_version` / `upcoming_version` / `versions_list`。缺失则退化为单通道 `snapshots` |

`releases/<ver>/targets/...` 目录里的文件名带版本前缀（`immortalwrt-25.12.2-mediatek-filogic-…`），
`snapshots/targets/...` 不带。客户端**不解析文件名**，两种情况都由 `profiles.json` 定位镜像。

## 两种 layout

```
official   OpenWRT/ImmortalWRT 官方发布页结构（root/releases/release/targets）：
           <base>[/<system>]/{snapshots|releases/<ver>}/targets/<target>/<subtarget>/
           快照位于 root/snapshots/targets，发行版位于 root/releases/<ver>/targets。

default    默认编译输出目录结构（root/targets，即 bin/targets 裸镜像）：
           <base>[/<system>]/targets/<target>/<subtarget>/
```

`official` 的通道目录由 `<base>/.versions.json` 发现；`default` 没有版本目录层级，
直接指向 `bin/targets` 的镜像输出。旧配置中的布局别名只在迁移映射里识别，新配置只写
`official` / `default`。

## 给 rtfw / immortalwrt.shuery 的三条对齐要求

1. 目录结构与官方**逐字同构**（不要把版本目录嵌到额外层级，也不要出现 `public/public` 这类嵌套副本）。
2. 每个 target 目录产出 `version.buildinfo`、`profiles.json`、`sha256sums`。
3. 站点根产出官方格式的 `/.versions.json`。

## 反面教材：为什么禁止用发布时间判更新（实测数据）

|                                  | 设备本机                | `rtfw…` 快照             | 官方快照             |
| -------------------------------- | ----------------------- | ------------------------ | -------------------- |
| `version.buildinfo`              | `r0-bf156b6`            | `r0-f7f75e1`             | `r41386-45474b1733`  |
| 源码时间 (`source_date_epoch`)   | 2026-09-29 07:18 UTC    | **2026-07-06** 08:59 UTC | 2026-09-20 02:53 UTC |
| 发布时刻（HTTP `Last-Modified`） | 构建戳 2026-10-02 04:56 | **2026-10-02** 10:24 UTC | 2026-09-20 10:30 UTC |

rtfw 的快照**发布时刻最新、源码却比设备旧近三个月**。按发布时刻判定会主动推荐降级；
按 `source_date_epoch` 判定才得到正确结论「远端更旧（可降级）」。

## 已知的发布端问题（待修）

- `rtfw.shuery.lssa.fun` 没有可浏览目录（全站 SPA，裸路径 404/301），且唯一全局索引
  `/assets/web/data/index.json` 是发布脚本副产物（`version: "1.0"`，852 KB）——客户端不依赖它。
- 站点上存在一个嵌套的 `public/{immortalwrt,openwrt}` 遗留副本（上传的 zip 自带顶层 `public/` 被解包所致），
  且 live 站点**只有 `snapshots/`，没有 `releases/`**。版本目录目前只存在于该遗留副本里。
