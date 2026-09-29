#!/system/bin/sh
# ============================================================================
#  SFS MOD EDITOR  ——  启动器
# ----------------------------------------------------------------------------
#  用法（需要 root）：
#      su -c "sh /data/local/tmp/sfs_mod.sh"
#
#  执行后：
#    - 若已有修改器在运行，先请它干净退出（避免叠加出多层悬浮窗）
#    - 自动等待游戏启动
#    - 注入 /data/local/tmp/sfs_mod.js
#    - 在游戏里点窗口标题栏右上角的【✕】即可停止本脚本
#    - 想再用时，重新执行一遍本脚本
#
#  需要的文件（都在 /data/local/tmp）：
#      sfs_mod.js         修改器脚本
#      frida-inject-16    Frida 16.7.19 的 frida-inject
# ============================================================================

PKG=com.StefMorojna.SpaceflightSimulator
DIR=/data/local/tmp
JS=$DIR/sfs_mod.js
INJ=$DIR/frida-inject-16
OUT=$DIR/sfs_mod.out
D=/sdcard/Android/data/$PKG/files
STOP=$D/sfs_mod.stop
LOG=$D/mod.log

echo "==============================================="
echo " SFS MOD EDITOR  启动器"
echo "==============================================="

# ---- 前置检查 ----
if [ ! -f "$JS" ]; then
    echo "[×] 找不到 $JS"
    echo "    请先把 sfs_mod.js 推送到 $DIR"
    exit 1
fi
if [ ! -x "$INJ" ]; then
    if [ ! -f "$INJ" ]; then
        echo "[×] 找不到 $INJ"
        echo "    请先把 frida-inject-16 推送到 $DIR 并 chmod 755"
        exit 1
    fi
    chmod 755 "$INJ" 2>/dev/null
fi

# ---- 清理上一次的残留 ----
# ★★ 这里必须小心。本修改器用 Java.registerClass 给按钮/滑条装了 onClick
#    与 onSeekBarChangeListener，它们是 Frida 提供的 JNI 方法。
#    如果**在悬浮窗还挂着监听器时**杀掉 frida-inject，脚本被卸载，这些方法入口
#    就变成悬空指针，游戏下一次触摸就会段错误崩掉
#    （栈：View.dispatchTouchEvent → art_quick_generic_jni_trampoline → <unknown>）。
#    所以：只有当修改器自己报告 state=stopped（已移除悬浮窗 + 清空监听器）时，
#    才允许 pkill。否则先请它自己走安全关闭流程。
STATE=$D/sfs_mod.state
if pgrep -f frida-inject-16 >/dev/null 2>&1; then
    if [ "$(cat "$STATE" 2>/dev/null)" = "stopped" ]; then
        echo "[*] 上一次的修改器已处于停止态，安全清理它的进程..."
        pkill -f frida-inject-16 2>/dev/null
        sleep 1
    else
        echo "[*] 检测到修改器仍在运行，先请它走安全关闭流程..."
        touch "$STOP"
        W=0
        while [ $W -lt 20 ]; do
            [ "$(cat "$STATE" 2>/dev/null)" = "stopped" ] && break
            pgrep -f frida-inject-16 >/dev/null 2>&1 || break
            W=$((W + 1))
            sleep 1
        done
        if [ "$(cat "$STATE" 2>/dev/null)" = "stopped" ]; then
            echo "[√] 已安全停止，清理进程。"
            pkill -f frida-inject-16 2>/dev/null
            sleep 1
        else
            echo "[!] 它没有响应停止请求，强制结束。"
            echo "    注意：这种情况下旧悬浮窗可能残留，重启游戏可彻底清除。"
            pkill -f frida-inject-16 2>/dev/null
            sleep 1
        fi
    fi
fi
rm -f "$STOP"
rm -f "$STATE"
sleep 1

# ---- 等游戏进程 ----
echo "[*] 等待游戏启动（$PKG）..."
WAIT=0
while true; do
    PID=$(pidof $PKG)
    if [ -n "$PID" ]; then
        break
    fi
    WAIT=$((WAIT + 1))
    if [ $WAIT -ge 120 ]; then
        echo "[×] 等了 120 秒游戏还没起来，退出。"
        echo "    请先手动打开游戏，再执行本脚本。"
        exit 1
    fi
    sleep 1
done
echo "[*] 游戏进程 PID = $PID"

# ---- 等场景加载（Unity 起来需要几秒）----
echo "[*] 等待场景加载（10 秒）..."
sleep 10

# ★ 注入前必须重新确认 PID。
#   刚才那 10 秒里游戏如果自己重启了，之前记下的 PID 就失效了，
#   frida-inject 会报 "Unable to find process with pid NNNNN" 而注入失败。
PID_NOW=$(pidof $PKG)
if [ -z "$PID_NOW" ]; then
    echo "[×] 游戏进程不见了（大概刚重启），请重新执行一次本脚本。"
    exit 1
fi
if [ "$PID_NOW" != "$PID" ]; then
    echo "[!] 游戏 PID 变了（$PID → $PID_NOW），改用新 PID 注入。"
    PID=$PID_NOW
fi

# ---- 注入 ----
echo ""
echo "[*] 清空旧日志..."
rm -f "$LOG"

echo "[*] 注入中..."
$INJ -p $PID -s $JS > "$OUT" 2>&1 &
INJ_PID=$!
sleep 3

if ! kill -0 $INJ_PID 2>/dev/null; then
    echo "[×] 注入进程已退出，可能是注入失败。下面是输出："
    echo "-----------------------------------------------"
    cat "$OUT"
    echo "-----------------------------------------------"
    exit 1
fi

cat <<EOF

===============================================
 [√] 已注入成功，修改器已在游戏中运行
===============================================
 窗口操作：
   · 按住标题栏 "≡ SFS MOD EDITOR" 拖动窗口
   · 拖右下角小方块改窗口大小
   · 点标题栏右上角【✕】= 停止修改器并结束本脚本
   · 点【HIDE】= 只收起窗口，修改器仍在运行

 想停止：在游戏里点标题栏的【✕】，或按 Ctrl+C
===============================================

EOF

# ---- 等待关闭信号 ----
while true; do
    if [ -f "$STOP" ]; then
        echo ""
        echo "[*] 收到游戏内【✕】关闭信号。"
        echo "    （修改器脚本此时已经自己卸载完钩子了，这里再等 2 秒做缓冲）"
        sleep 2
        break
    fi
    if ! kill -0 $INJ_PID 2>/dev/null; then
        echo ""
        echo "[*] 注入进程已结束（游戏可能已退出）。"
        break
    fi
    sleep 1
done

# ---- 收尾 ----
# ★★ 故意不杀注入进程。见文件开头那段说明：在悬浮窗还挂着 Frida 的 JNI 监听器时
#    卸载脚本 = 悬空指针 = 下次触摸直接崩游戏。修改器自己已经进入"钩子空操作"状态，
#    游戏行为等同于原版；这个进程只是空转，几乎不耗 CPU。
#    下次执行本脚本时，会读到它留下的 state=stopped，那时再安全地清理掉。
rm -f "$STOP"
echo ""
echo "[√] 修改器已停止。"
echo "    · 悬浮窗已移除，旋转步长 / 网格吸附等改动已停用（游戏恢复原版行为）"
echo "    · 注入进程会留在后台空转（这是刻意的，避免卸载脚本导致游戏段错误）"
echo "    · 想再用就重新执行一遍本脚本，它会先自动清掉这个空转进程"
