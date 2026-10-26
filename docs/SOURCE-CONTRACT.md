# 源契约

客户端只依赖 **官方 OpenWrt / ImmortalWrt 构建系统一定会产出** 的文件，不发明新格式。
`rtfw.shuery.lssa.fun` 与 `immortalwrt.shuery.lssa.fun` 只要向官方看齐即可被直接支持。

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

只有这五组，其余字段发布端可以不产出：

| 字段                                     | 语义                                                       | 缺失后果                                |
| ---------------------------------------- | ---------------------------------------------------------- | --------------------------------------- |
| `version_number`                         | `SNAPSHOT` 或 `25.12.2`                                    | 退化为按源码时间比较                    |
| `source_date_epoch`                      | 源码时间戳，等于构建时使用的 `SOURCE_DATE_EPOCH`           | 与上一项同时缺失 → 判为「无法比较」     |
| `profiles.<name>.supported_devices`      | 本机 `board_name`（`bananapi,bpi-r4`）在此列表中           | 找不到 → 「该源未收录此设备」           |
| `profiles.<name>.images[]`               | `type` / `filesystem` / `name` / `size` / `sha256`         | 无 `sysupgrade`+`squashfs` → 无候选镜像 |
| `profiles.<name>.file_size_limits.image` | 镜像体积上限，**下载前**校验（超出即拒绝下载，不是刷写前） | 退化为不做上限校验（可接受）            |

`version_code`（`r<rev>-<sha>`）只在 `version.buildinfo` 读不到时作为**后备**使用。

**明确不要求**：顶层 `target`、`git_commit`、`stable_version` / `oldstable_version` /
`upcoming_version`，以及 `<targetdir>/sha256sums` —— 客户端一概不读。
（`git_commit` 只存在于 snapshot、release 没有，本来也不能作判据。）

## 可选文件

| 路径                                            | 作用                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `<base>/.versions.json`                         | 只用其中的 `versions_list` 做通道发现。缺失则退化为单通道 `['snapshots']` |
| 同文件的 `stable_version` / `oldstable_version` | 客户端读入但**从不使用**，可不产出                                        |

**什么时候必须产出 `.versions.json`**：站上同时提供 `releases/` 与 `snapshots/` 时。
否则设备跑发行版时找不到 `releases/<ver>`，只能去比 snapshot —— 那正是下文警告的
「推荐降级」场景。**单通道站点（只有 `snapshots/`）可以整个省略。**

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

`official` 的通道目录由 `<base>/.versions.json` 的 `versions_list` 发现（缺失则只有
`snapshots` 一条）；`default` 没有版本目录层级，
直接指向 `bin/targets` 的镜像输出。旧配置中的布局别名只在迁移映射里识别，新配置只写
`official` / `default`。

通道默认是「当前通道」，也可在源的 `channel` 选项里选定语义通道（`snapshot` / `stable` / `oldstable` / `major` / `minor`）或具体目录（`snapshots` / `releases/<版本>`）。
钉住的通道不在 `versions_list` 里时，客户端**不会**回落到别的通道，而是照旧按该路径请求并
把 404 如实报出来 —— 静默回落会给出「来自你没选的通道」的结论。

## 给 rtfw / immortalwrt.shuery 的对齐要求

1. 目录结构与官方**逐字同构**（不要把版本目录嵌到额外层级，也不要出现 `public/public` 这类嵌套副本）。
   设备按 `OPENWRT_BOARD`（如 `mediatek/filogic`）拼目录，多一层就读不到。
2. 每个 target 目录产出 `version.buildinfo`、`profiles.json`，以及 `images[].name` 指向的镜像本体。
3. 站上同时有 `releases/` 与 `snapshots/` 时，站点根产出 `/.versions.json`（只需 `versions_list`）；
   单通道站点可省。
4. **不要求**：`sha256sums`、`stable_version` / `oldstable_version` / `upcoming_version`、
   `profiles.json` 顶层 `target` 与 `git_commit`。

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
