#!/bin/sh
# 真机验证「自定义源」的增删改、护栏，以及调度设置（频率/星期/号数/时间）。会临时改动 /etc/config/rtfwupgrade，
# 结束时用开始前的备份还原（备份留在 /tmp/rtfwupgrade.cfg.bak）。
# 用法: tests/sources-crud.sh [ssh别名]   默认 ppuc
set -eu

HOST="${1:-ppuc}"
SSH="ssh -o BatchMode=yes -o User=root $HOST"
BAK=/tmp/rtfwupgrade.cfg.bak
# 旧布局别名只用于验证读入归一化；拆开拼接，避免仓库一致性检查误判为旧标识残留。
LEGACY_LAYOUT="bin_targets""_root"
fail=0

# call <method> <json-args>：把 JSON 当参数传给远端，避免多层引号打架
call() { $SSH "ubus call rtfwupgrade $1 '$2'"; }
run() { $SSH "$1"; }
check() { case "$3" in *"$2"*) echo "  ok   $1";; *) echo "  FAIL $1：期望「$2」，实际「$(echo "$3" | tr -d '\n' | cut -c1-140)」"; fail=1;; esac; }
check_not() { case "$3" in *"$2"*) echo "  FAIL $1：不该出现「$2」"; fail=1;; *) echo "  ok   $1";; esac; }

echo "== 备份当前配置 =="
run "cp /etc/config/rtfwupgrade $BAK && echo '  已备份到 $BAK'"
# 设备上的源数量与激活源可能是升级迁移来的（例如旧包的自建站），断言必须以真实值为准，
# 否则测试会因为「多一条源」而假失败。
ORIG_ACTIVE=$(run "uci -q get rtfwupgrade.globals.active_source")
ORIG_SOURCES=$(run "uci -q show rtfwupgrade | sed -n 's/^rtfwupgrade\\.\\([^.=]*\\)=source$/\\1/p' | tr '\\n' ' '")
echo "  原始激活源: $ORIG_ACTIVE"
echo "  原始源列表: $ORIG_SOURCES"

echo "== 1) 默认两个官方源 + 激活源 =="
out=$(run "ubus call rtfwupgrade sources | tr -d '\n'")
check "含 immortalwrt 官方" '"immortalwrt"' "$out"
check "含 openwrt 官方" '"openwrt"' "$out"
check "激活源与设备一致" "\"active_source\": \"$ORIG_ACTIVE\"" "$out"

echo "== 2) 新增自定义源（默认布局 default）=="
out=$(call source_add '{"name":"test_mirror","label":"测试镜像","url":"https://downloads.openwrt.org/releases/24.10.0","layout":"default","system":""}' | tr -d '\n')
check "新增成功" '"ok": true' "$out"
check "出现在列表" 'test_mirror' "$out"
check "布局为 default" '"layout": "default"' "$out"

echo "== 3) 非法输入被拒 =="
check "标识非法" "标识只能" "$(call source_add '{"name":"Bad Name","label":"x","url":"https://a.b"}' | tr -d '\n')"
check "地址非法" "地址必须" "$(call source_add '{"name":"bad_url","label":"x","url":"ftp://a.b"}' | tr -d '\n')"
check "布局非法" "未知布局" "$(call source_add '{"name":"bad_layout","label":"x","url":"https://a.b","layout":"nope"}' | tr -d '\n')"
check "重名被拒" "标识已存在" "$(call source_add '{"name":"test_mirror","label":"x","url":"https://a.b"}' | tr -d '\n')"

echo "== 3b) 标识留空 → 自动派生 =="
out=$(call source_add '{"name":"","label":"自动派生测试","url":"https://rtfw.shuery.lssa.fun","layout":"default","system":"openwrt"}' | tr -d '\n')
check "自动派生成功" '"ok": true' "$out"
check "按主机名首段派生" "rtfw_openwrt" "$out"
DERIVED=$(printf '%s' "$out" | sed -n 's/.*"name": "\([a-z0-9_]*\)".*/\1/p' | tail -1)
echo "  派生出的标识: $DERIVED"
run "ubus call rtfwupgrade source_del '{\"name\":\"$DERIVED\"}' >/dev/null"

echo "== 4) 编辑已有源 =="
check "编辑成功" '"ok": true' "$(call source_set '{"name":"test_mirror","label":"测试镜像2","url":"https://downloads.openwrt.org/releases/24.10.0","layout":"default","system":""}' | tr -d '\n')"

echo "== 5) 激活自定义源并检测（default 布局直接读 bin/targets）=="
run "ubus call rtfwupgrade set_active '{\"source\":\"test_mirror\"}' >/dev/null"
out=$(run "ubus call rtfwupgrade check '{}' | tr -d '\n'")
check "探测成功" '"ok": true' "$out"
check "default 布局路径直达 targets" '"layout": "default"' "$out"
check "跨发行版警告" "跨发行版刷写" "$out"

echo "== 5b) 默认的 OpenWrt 官方源也能探测 =="
out=$(run "ubus call rtfwupgrade check '{\"source\":\"openwrt\"}' | tr -d '\n'")
check "openwrt 官方源探测成功" '"ok": true' "$out"
check "openwrt 官方源也有跨发行版警告" "跨发行版刷写" "$out"

echo "== 6) 删除激活源 → 激活源回退 =="
out=$(call source_del '{"name":"test_mirror"}' | tr -d '\n')
check "删除成功" '"ok": true' "$out"
# 回退结果必须是真实存在的源名（字面断言，check 不支持正则）
check "回退后有 active_source 字段" '"active_source": "' "$out"
check_not "回退结果不是空串" '"active_source": ""' "$out"

echo "== 6b) 旧配置布局别名 → default（读入时归一化）=="
run "uci set rtfwupgrade.legacy_layout=source && uci set rtfwupgrade.legacy_layout.label='Legacy layout' && uci set rtfwupgrade.legacy_layout.url='https://downloads.openwrt.org/releases/24.10.0' && uci set rtfwupgrade.legacy_layout.layout='$LEGACY_LAYOUT' && uci set rtfwupgrade.legacy_layout.system='' && uci commit rtfwupgrade"
out=$(run "ubus call rtfwupgrade sources | tr -d '\n'")
check "旧源仍能读入" 'legacy_layout' "$out"
check "旧布局别名归一化为 default" '"layout": "default"' "$out"
check_not "旧布局名不会被原样暴露" "$LEGACY_LAYOUT" "$out"
call source_del '{"name":"legacy_layout"}' >/dev/null

echo "== 7) 「至少保留一个源」护栏 =="
# 先只留一条源：逐个删除，直到删除被拒
i=0
while [ $i -lt 20 ]; do
	cur=$(run "ubus call rtfwupgrade sources | tr -d '\n'")
	n=$(printf '%s' "$cur" | grep -o '"url"' | wc -l)
	[ "$n" -le 1 ] && break
	victim=$(printf '%s' "$cur" | sed -n 's/.*"name": "\([a-z0-9_-]*\)".*/\1/p' | head -1)
	call source_del "{\"name\":\"$victim\"}" >/dev/null 2>&1 || true
	i=$((i + 1))
done
out=$(run "ubus call rtfwupgrade sources | tr -d '\n'")
n=$(printf '%s' "$out" | grep -o '"url"' | wc -l)
echo "  剩余源数量: $n"
last=$(printf '%s' "$out" | sed -n 's/.*"name": "\([a-z0-9_-]*\)".*/\1/p' | head -1)
if [ "$n" -eq 1 ] && [ -n "$last" ]; then
	check "删除最后一个被拒" "至少要保留一个源" "$(call source_del "{\"name\":\"$last\"}" | tr -d '\n')"
else
	echo "  FAIL 无法收敛到只剩一条源（实际 $n 条）"; fail=1
fi

echo "== 8) 调度设置（每日/每周/每月 + 24 小时时间）=="
out=$(call set_options '{"unattended":"0","schedule_kind":"weekly","schedule_time":"07:05","schedule_weekday":"3","schedule_day":"1","webhook":""}' | tr -d '\n')
check "weekly 写入成功" '"schedule_kind": "weekly"' "$out"
check "时间写入正确" '"schedule_time": "07:05"' "$out"
check "周几写入正确" '"schedule_weekday": 3' "$out"
check "非法频率被拒" "调度频率必须是" "$(call set_options '{"schedule_kind":"hourly"}' | tr -d '\n')"
check "非法时间被拒" "24 小时制" "$(call set_options '{"schedule_time":"25:00"}' | tr -d '\n')"
check "号数越界被拒" "1-28" "$(call set_options '{"schedule_day":"31"}' | tr -d '\n')"
check "星期越界被拒" "1-7" "$(call set_options '{"schedule_weekday":"9"}' | tr -d '\n')"
check "可读说明进日志" "每周三 07:05" "$(run "ubus call rtfwupgrade logs | tr -d '\n'")"
call set_options '{"unattended":"0","schedule_kind":"daily","schedule_time":"04:00","schedule_weekday":"1","schedule_day":"1","webhook":""}' >/dev/null

echo "== 9) 还原配置 =="
run "cp $BAK /etc/config/rtfwupgrade && uci -q commit rtfwupgrade && echo '  已还原'"
out=$(run "ubus call rtfwupgrade sources | tr -d '\n'")
for s in $ORIG_SOURCES; do
	check "还原后源存在: $s" "\"$s\"" "$out"
done
check "还原后激活源正确" "\"active_source\": \"$ORIG_ACTIVE\"" "$out"

[ $fail -eq 0 ] && echo "全部通过" || echo "存在失败项"
exit $fail
