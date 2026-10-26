# 源契约

客户端只依赖 **官方 OpenWrt / ImmortalWrt 构建系统一定会产出** 的文件，不发明新格式。
聚合站（如 `rtfw.shuery.lssa.fun`）与单版站（如 `immortalwrt.shuery.lssa.fun`）只要向官方看齐即可被直接支持。

## 必需文件

只有两个，其余一概不读：

| 路径                            | 作用                             | 备注                                                  |
| ------------------------------- | -------------------------------- | ----------------------------------------------------- |
| `<targetdir>/version.buildinfo` | 构建标识，例 `r41386-45474b1733` | 与镜像内 `/etc/os-release` 的 `BUILD_ID` **同源同值** |
| `<targetdir>/profiles.json`     | 目标元数据                       | 见下方字段                                            |

另需**镜像本体** `<targetdir>/<images[].name>`：客户端把 `profiles.json` 里的 `name`
当作文件名，到**同目录**下载。名字不解析含义，但必须逐字对得上。

`<targetdir>/sha256sums` 客户端**从不读取**（sha256 取自 `images[].sha256`），
不产出也不影响任何功能。

## profiles.json 用到的字段

共七组，其余字段发布端可以不产出。**加粗的两项**是界面展示用，缺失不影响判定，
但会让对照表显示不出厂商/型号与发行版：

| 字段                                     | 语义                                                            | 缺失后果                                |
| ---------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| `version_number`                         | `SNAPSHOT` 或 `25.12.2`                                         | 退化为按源码时间比较                    |
| `source_date_epoch`                      | 源码时间戳，等于构建时使用的 `SOURCE_DATE_EPOCH`                | 与上一项同时缺失 → 判为「无法比较」     |
| `profiles.<name>.supported_devices`      | 本机 `board_name`（`bananapi,bpi-r4`）在此列表中                | 找不到 → 「该源未收录此设备」           |
| `profiles.<name>.images[]`               | `type` / `filesystem` / `name` / `size` / `sha256`              | 无 `sysupgrade`+`squashfs` → 无候选镜像 |
| `profiles.<name>.file_size_limits.image` | 镜像体积上限，**下载前**校验（超出即拒绝下载，不是刷写前）      | 退化为不做上限校验（可接受）            |
| **`profiles.<name>.image_prefix`**       | 产物前缀，例 `immortalwrt-mediatek-filogic-bananapi_bpi-r4`     | 判发行版退到镜像名 → 源 `system` → 地址 |
| **`profiles.<name>.titles[0]`**          | `vendor` / `model`，例 `{"vendor":"Bananapi","model":"BPi-R4"}` | 对照表「目标设备」退回 profile 名或前缀 |

`version_code`（`r<rev>-<sha>`）只在 `version.buildinfo` 读不到时作为**后备**使用。

**判发行版为什么要 `image_prefix`**：客户端拿它和本机 `os-release` 的 `ID` 比对，
不一致就警告「跨发行版刷写」。`image_prefix` 是构建系统自己写的前缀，比从域名猜可靠；
两者都取不到时才会退回 `system` 段与地址。因此**建议产出它**，否则跨发行版护栏可能漏判。

**明确不要求**：顶层 `target`、`git_commit`、`stable_version` / `oldstable_version` /
`upcoming_version`，以及 `<targetdir>/sha256sums` —— 客户端一概不读。
（`git_commit` 只存在于 snapshot、release 没有，本来也不能作判据。）

## 可选文件

| 路径                                            | 作用                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `<base>/.versions.json`                         | 用 `versions_list` 做通道发现；缺失则退化为单通道 `['snapshots']`                  |
| 同文件的 `stable_version` / `oldstable_version` | **决定「稳定版」「旧稳定版」两个语义通道指向哪个目录**，缺失则该通道不可选（见下） |

`stable_version` / `oldstable_version` 的用法：客户端把它们拼成 `releases/<版本>`。
用户选了「稳定版」而源上没写这个字段时，界面会明确报「该源没有可用的『稳定版』通道
（源公布的版本：stable=无、oldstable=无）」，**不会**静默回落到 snapshots——
静默回落会给出「来自你没选的通道」的结论。

**什么时候必须产出 `.versions.json`**：站上同时提供 `releases/` 与 `snapshots/` 时。
否则设备跑发行版时找不到 `releases/<ver>`，只能去比 snapshot —— 那正是下文警告的
「推荐降级」场景。**单通道站点（只有 `snapshots/`）可以整个省略。**

`releases/<ver>/targets/...` 目录里的文件名带版本前缀（`immortalwrt-25.12.2-mediatek-filogic-…`），
`snapshots/targets/...` 不带。客户端**不解析文件名**，两种情况都由 `profiles.json` 定位镜像。

## 两种 layout

```text
official   OpenWRT/ImmortalWRT 官方发布页结构（root/releases/release/targets）：
           <base>[/<system>]/{snapshots|releases/<ver>}/targets/<target>/<subtarget>/
           快照位于 root/snapshots/targets，发行版位于 root/releases/<ver>/targets。

default    默认编译输出目录结构（root/targets，即 bin/targets 裸镜像）：
           <base>[/<system>]/targets/<target>/<subtarget>/
```

`official` 的通道目录由 `<base>/.versions.json` 的 `versions_list` 发现（缺失则只有
`snapshots` 一条）；`default` 没有版本目录层级，
直接指向 `bin/targets` 的镜像输出。旧配置中的布局别名只在迁移映射里识别，新配置只写
`official` / `default`。

通道默认是「当前通道」（源段 `channel` 留空），也可选定**语义通道**或**具体目录**。
语义通道如何落到具体目录：

| 语义通道         | 解析为                                           | 依赖                                      |
| ---------------- | ------------------------------------------------ | ----------------------------------------- |
| _（留空）/ 当前_ | `snapshots`，或与本机版本匹配的 `releases/<ver>` | 本机 `VERSION` 与 `version_kind`          |
| `snapshot`       | `snapshots`                                      | —                                         |
| `stable`         | `releases/<stable_version>`                      | `.versions.json` 的 `stable_version`      |
| `oldstable`      | `releases/<oldstable_version>`                   | `.versions.json` 的 `oldstable_version`   |
| `major`          | 最新同主版本 `releases/<ver>`                    | **本机必须是发行版**（SNAPSHOT 无版本号） |
| `minor`          | 最新同子版本 `releases/<ver>`                    | 同上                                      |

也可直接写目录名：`snapshots` 或 `releases/<版本>`。
钉住的通道不在 `versions_list` 里时，客户端**不会**回落到别的通道，而是照旧按该路径请求并
把 404 如实报出来 —— 静默回落会给出「来自你没选的通道」的结论。

`major` / `minor` 以本机版本号为锚点。SNAPSHOT 构建没有版本号，选这两个通道会明确报
「不可用」，而不是悄悄探测 snapshots。

## 给 rtfw / immortalwrt.shuery 的对齐要求

1. 目录结构与官方**逐字同构**（不要把版本目录嵌到额外层级，也不要出现 `public/public` 这类嵌套副本）。
   设备按 `OPENWRT_BOARD`（如 `mediatek/filogic`）拼目录，多一层就读不到。
2. 每个 target 目录产出 `version.buildinfo`、`profiles.json`，以及 `images[].name` 指向的镜像本体。
3. `profiles.json` 里请保留 `image_prefix` 与 `titles`：前者用于判发行版（跨发行版护栏依赖它），
   后者让对照表显示「Bananapi BPi-R4」而不是难读的 profile 名。官方构建系统本就写这两项。
4. 站上同时有 `releases/` 与 `snapshots/` 时，站点根产出 `/.versions.json`，写上
   `versions_list`、`stable_version`、`oldstable_version`；只有 `snapshots/` 的单通道站点可整站省略。
5. **不要求**：`sha256sums`、`upcoming_version`、`profiles.json` 顶层 `target` 与 `git_commit`。

## 反面教材：为什么禁止用发布时间判更新（实测数据）

|                                  | 设备本机                | `rtfw…` 快照             | 官方快照             |
| -------------------------------- | ----------------------- | ------------------------ | -------------------- |
| `version.buildinfo`              | `r0-bf156b6`            | `r0-f7f75e1`             | `r41386-45474b1733`  |
| 源码时间 (`source_date_epoch`)   | 2026-09-29 07:18 UTC    | **2026-07-06** 08:59 UTC | 2026-09-20 02:53 UTC |
| 发布时刻（HTTP `Last-Modified`） | 构建戳 2026-10-02 04:56 | **2026-10-02** 10:24 UTC | 2026-09-20 10:30 UTC |

rtfw 的快照**发布时刻最新、源码却比设备旧近三个月**。按发布时刻判定会主动推荐降级；
按 `source_date_epoch` 判定才得到正确结论「远端更旧（可降级）」。

## 内置源与预设

应用首次安装只预置两个官方源，用于演示两种布局；聚合站与单版本站通过界面「预设」一键填表，
**不会自动创建**：

| 预设             | 地址                                  | 布局       | `system` 段   |
| ---------------- | ------------------------------------- | ---------- | ------------- |
| OpenWrt 官方     | `https://downloads.openwrt.org`       | `official` | 空            |
| ImmortalWrt 官方 | `https://downloads.immortalwrt.org`   | `official` | 空            |
| 多发行版聚合站   | `https://rtfw.shuery.lssa.fun`        | `official` | `immortalwrt` |
| 单版本发布站     | `https://immortalwrt.shuery.lssa.fun` | `default`  | 空            |

两个官方源是内置的（`/etc/config/rtfwupgrade` 里就有），后两个只是预设模板。
`system` 段只在 `official` 布局下参与拼路径（`<base>/<system>/…`），它让一个地址可以
在子目录下托管多个发行版。

## 已知的发布端问题（实测）

以下为 2026-10 实测结果，供修站时对照：

| 站点                          | `profiles.json` | `.versions.json` | `releases/` | 说明                      |
| ----------------------------- | --------------- | ---------------- | ----------- | ------------------------- |
| `downloads.openwrt.org`       | 200             | 200              | 有          | 通道数 74                 |
| `downloads.immortalwrt.org`   | 200             | 200              | 有          | 通道数 25                 |
| `rtfw.shuery.lssa.fun`        | 200             | **404**          | 无          | 只有 `snapshots/`，单通道 |
| `immortalwrt.shuery.lssa.fun` | 200             | **404**          | 无          | 只有 `targets/`，单通道   |

两个自建站都是**单通道**，因此不产出 `.versions.json` 是符合契约的；代价是设备跑发行版时
无法选「稳定版 / 旧稳定版 / 当前主版本」这些通道 —— 那些通道需要 `releases/<ver>` 目录。

- `rtfw.shuery.lssa.fun` 没有可浏览目录（全站 SPA，裸路径 404/301），
  唯一全局索引 `/assets/web/data/index.json` 是发布脚本副产物，客户端不依赖它。
- 站点上存在一个嵌套的 `public/{immortalwrt,openwrt}` 遗留副本（上传的 zip 自带顶层 `public/`
  被解包所致）。设备按 `OPENWRT_BOARD` 拼路径，多一层就读不到，需要清掉。
