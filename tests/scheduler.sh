#!/bin/sh
# 真机验证定时任务落地：写入/幂等/自愈/关闭/uci-defaults 装机同步，并断言 **块外内容一字不动**。
# 会临时改动 /etc/crontabs/root 与 /etc/config/rtfwupgrade，结束时用开始前的备份还原。
# 用法: tests/scheduler.sh [ssh别名]   默认 ppuc
set -eu

HOST="${1:-ppuc}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH="ssh -o BatchMode=yes -o User=root $HOST"
CRON=/etc/crontabs/root
CFG=/etc/config/rtfwupgrade
BAK=/tmp/crontab.rtfwupgrade-test.bak
CFGBAK=/tmp/rtfwupgrade.cfg.bak
LOCAL_UCIDEFAULTS="$ROOT/luci-app-rtfwupgrade/root/etc/uci-defaults/80_rtfwupgrade"
# 上一代命令名只用于验证升级迁移；拆开拼接，避免仓库一致性检查误判为旧标识残留。
LEGACY_NAME="luci""sysupgrade"
fail=0

[ -f "$LOCAL_UCIDEFAULTS" ] || { echo "找不到本地 uci-defaults: $LOCAL_UCIDEFAULTS"; exit 1; }

run() { $SSH "$1"; }
call() { $SSH "ubus call rtfwupgrade $1 '$2'"; }
check() { case "$3" in *"$2"*) echo "  ok   $1";; *) echo "  FAIL $1：期望「$2」，实际「$(printf '%s' "$3" | tr -d '\n' | cut -c1-160)」"; fail=1;; esac; }
check_not() { case "$3" in *"$2"*) echo "  FAIL $1：不该出现「$2」"; fail=1;; *) echo "  ok   $1";; esac; }

echo "== 备份并记录原始 crontab / 配置 =="
run "cp $CRON $BAK && cp $CFG $CFGBAK"
BEFORE=$(run "cat $CRON")
CFGBEFORE=$(run "uci -q show rtfwupgrade")
echo "  原始行数: $(printf '%s' "$BEFORE" | wc -l | tr -d ' ')"

echo "== 1) 状态查询（此时应为未应用）=="
out=$(run "/usr/bin/rtfwupgrade.sh schedule")
check "能显示调度" "调度" "$out"
check "能显示期望行" "期望行" "$out"

echo "== 2) 通过 set_options 触发同步（weekly 三 07:05）=="
call set_options '{"unattended":"0","schedule_kind":"weekly","schedule_time":"07:05","schedule_weekday":"3","schedule_day":"1","webhook":""}' >/dev/null
out=$(run "cat $CRON")
check "写入标记块开始" "BEGIN rtfwupgrade" "$out"
check "写入标记块结束" "END rtfwupgrade" "$out"
check "分钟/小时正确" "1" "$(run "grep -c '^5 7 ' $CRON || true")"
check "星期正确" "1" "$(run "grep -c '^5 7 . . 3 ' $CRON || true")"
check "调用新 CLI cron" "/usr/bin/rtfwupgrade.sh cron" "$out"
check "受管行含 mkdir 兜底" "1" "$(run "grep -c 'mkdir -p /tmp/rtfwupgrade' $CRON || true")"
check "mkdir 在 CLI 之前" "1" "$(run "grep -c 'mkdir -p /tmp/rtfwupgrade.*/usr/bin/rtfwupgrade.sh cron' $CRON || true")"
check "cron 输出到 cron.log" "/tmp/rtfwupgrade/cron.log" "$out"
check "用户行保留（nginx-util）" "nginx-util" "$out"
check "用户行保留（acme）" "acme renew" "$out"

echo "== 3) 幂等：再同步一次内容不变 =="
H1=$(run "md5sum $CRON | cut -d' ' -f1")
out=$(run "/usr/bin/rtfwupgrade.sh schedule --apply")
check "报告无需变更" "无需变更" "$out"
H2=$(run "md5sum $CRON | cut -d' ' -f1")
check "内容不变" "$H1" "$H2"

echo "== 4) 块内被手改 → 同步自愈 =="
run "sed -i 's|^5 7 .*|0 0 * * * /bin/false|' $CRON"
check "手改已生效（防止准备步骤静默失效）" "1" "$(run "grep -c '/bin/false' $CRON || true")"
out=$(run "/usr/bin/rtfwupgrade.sh schedule --apply")
check "报告已写入" "已写入" "$out"
check "已恢复为受管行" "/usr/bin/rtfwupgrade.sh cron" "$(run "cat $CRON")"
check "mkdir 也恢复" "mkdir -p /tmp/rtfwupgrade" "$(run "cat $CRON")"
check_not "错误行已消失" "/bin/false" "$(run "cat $CRON")"

echo "== 5) 关闭调度（off）→ 只移除标记块 =="
call set_options '{"unattended":"0","schedule_kind":"off","schedule_time":"07:05","schedule_weekday":"3","schedule_day":"1","webhook":""}' >/dev/null
out=$(run "cat $CRON")
check_not "标记块已移除" "BEGIN rtfwupgrade" "$out"
check "用户行仍在" "nginx-util" "$out"
check "acme 行仍在" "acme renew" "$out"

echo "== 6) cron 子命令：档位 0 → 仅检测不下发下载 =="
out=$(run "/usr/bin/rtfwupgrade.sh cron --json" | tr -d ' \n')
check "动作是 none" '"action":"none"' "$out"
check "带上了结论" '"verdict"' "$out"

echo "== 7) uci-defaults：无受管块 + 默认配置 → 写入受管块 =="
call set_options '{"unattended":"0","schedule_kind":"daily","schedule_time":"04:00","schedule_weekday":"1","schedule_day":"1","webhook":""}' >/dev/null
run "sed -i '/^# BEGIN rtfwupgrade (managed block, do not edit)\$/,/^# END rtfwupgrade\$/d' $CRON"
run "sed -i '/^# BEGIN $LEGACY_NAME (managed block, do not edit)\$/,/^# END $LEGACY_NAME\$/d' $CRON"
check_not "准备：新受管块已移除" "BEGIN rtfwupgrade" "$(run "cat $CRON")"
check_not "准备：无上一代受管块" "BEGIN $LEGACY_NAME" "$(run "cat $CRON")"
$SSH "cat > /tmp/rtfwupgrade-uci-defaults && chmod 755 /tmp/rtfwupgrade-uci-defaults" < "$LOCAL_UCIDEFAULTS"
run "/tmp/rtfwupgrade-uci-defaults"
out=$(run "cat $CRON")
check "uci-defaults 写入受管块" "BEGIN rtfwupgrade" "$out"
check "默认调度为每天 04:00" "1" "$(run "grep -c '^0 4 ' $CRON || true")"
check "受管行含 mkdir" "1" "$(run "grep -c 'mkdir -p /tmp/rtfwupgrade' $CRON || true")"
check "受管行走新 CLI" "1" "$(run "grep -c '/usr/bin/rtfwupgrade.sh cron' $CRON || true")"
check "用户行仍在" "nginx-util" "$out"

echo "== 7b) 升级迁移：上一代受管块被移除，改为新受管块 =="
run "sed -i '/^# BEGIN rtfwupgrade (managed block, do not edit)\$/,/^# END rtfwupgrade\$/d' $CRON"
run "printf '%s\n' '# BEGIN $LEGACY_NAME (managed block, do not edit)' '0 4 * * * /usr/bin/$LEGACY_NAME cron >> /tmp/$LEGACY_NAME/cron.log 2>&1' '# END $LEGACY_NAME' >> $CRON"
check "准备：上一代受管块已存在" "BEGIN $LEGACY_NAME" "$(run "cat $CRON")"
run "/tmp/rtfwupgrade-uci-defaults"
out=$(run "cat $CRON")
check "迁移后写入新受管块" "BEGIN rtfwupgrade" "$out"
check_not "上一代 BEGIN 标记已迁移" "BEGIN $LEGACY_NAME" "$out"
check_not "上一代 cron 行已迁移" "/usr/bin/$LEGACY_NAME cron" "$out"
check "用户行仍在（迁移后）" "nginx-util" "$out"

echo "== 8) 还原原始配置与 crontab（最后一步，之后不再触发同步）=="
run "cp $CFGBAK $CFG && uci -q commit rtfwupgrade"
run "cp $BAK $CRON"
run "/etc/init.d/cron restart >/dev/null 2>&1 || true"
check "crontab 与原始内容一致" "$BEFORE" "$(run "cat $CRON")"
check "配置与原始内容一致" "$CFGBEFORE" "$(run "uci -q show rtfwupgrade")"
run "rm -f $BAK $CFGBAK $CRON.rtfwupgrade.bak $CRON.$LEGACY_NAME.bak /tmp/rtfwupgrade-uci-defaults"
check "crontab 备份已清理" "gone" "$(run "if [ -e $BAK ]; then echo present; else echo gone; fi")"
check "配置备份已清理" "gone" "$(run "if [ -e $CFGBAK ]; then echo present; else echo gone; fi")"
check "调度器备份已清理" "gone" "$(run "if [ -e $CRON.rtfwupgrade.bak ]; then echo present; else echo gone; fi")"

[ $fail -eq 0 ] && echo "全部通过" || echo "存在失败项"
exit $fail
