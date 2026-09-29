'use strict';

/* ============================================================================
 *  SFS MOD EDITOR  v6
 *  ---------------------------------------------------------------------------
 *  [1] 选中部件属性（只在"恰好选中 1 个部件"时显示）
 *      BuildManager(RCXLCBBUKYQDMVME).main
 *        +0x58 selector (BuildSelector = JPRIZKDGCTBIACNX)
 *          +0x40 selected : HashSet<Part>   (_count@0x20, _slots@0x18, Slot 16B, value@+8)
 *            -> SFS.Parts.Part
 *                 +0x50 density    : Float_Local (value @+0x10)
 *                 +0x58 orientation: OrientationModule
 *                      +0x20 orientation : Obs<Orientation> -> value @+0x10 -> Orientation
 *                             .x@0x10 .y@0x14 .z@0x18  + ApplyOrientation()
 *                 get_Position/0  set_Position/1  RegenerateMesh/0
 *
 *  [2] 摄像机无限缩放  SFS.Builds.IFBRMEVGGTRWUIVL
 *                      minCameraDistance @0x28 / maxCameraDistance @0x2c
 *
 *  [3] 旋转步长  UJXCFTAXVPMRVLJH.Rotate(float)  —— 角度在 s0 寄存器，onEnter 改写
 *
 *  [4] 网格吸附  HoldGrid(EFYJLFKZYPMXLITO).ADGCOCNILCO/1 里
 *               "fmov s2,#0.5 ; bl <共享吸附函数>" —— 在该函数入口改写 s2
 *
 *  [5] 窗口可拖动（标题栏）＋ 可缩放（右下角手柄）
 *
 *  偏移仅对 v1.6.00.22 (b713) 有效。
 * ==========================================================================*/

var MODLOG = "/sdcard/Android/data/com.StefMorojna.SpaceflightSimulator/files/mod.log";
/* ★ 开发期的探测开关。
 * false = 正式版：所有"一次性 dump 类型/变量/字段布局"的诊断代码都不会执行，日志保持干净。
 * true  = 开发版：会在前几次选中部件时把变量列表、字符串、Burn 类型等全部打印出来，
 *         用于游戏更新后重新定位偏移。要调试时把它改成 true 即可（代码都还在）。 */
var DEBUG_PROBES = false;
/* 关闭标记：JS 里点"关闭"就写这个文件，设备端 sfs_mod.sh 轮询到它就会杀掉注入进程并退出 */
var STOPFILE = "/sdcard/Android/data/com.StefMorojna.SpaceflightSimulator/files/sfs_mod.stop";
/* 状态文件：running / stopped。
 * .sh 靠它判断"上一次的注入进程现在能不能安全杀掉"。 */
var STATEFILE = "/sdcard/Android/data/com.StefMorojna.SpaceflightSimulator/files/sfs_mod.state";
function writeState(s) {
    try { var f = new File(STATEFILE, "w"); f.write(s + "\n"); f.flush(); f.close(); } catch (e) { }
}
function log(s) {
    send(String(s));
    try { var f = new File(MODLOG, "a"); f.write(String(s) + "\n"); f.flush(); f.close(); } catch (e) { }
}

var G = {
    fn: null, domain: null, image: null, coreImage: null,
    objClass: null, compClass: null,
    mgrClass: null, mgrSelOff: -1,
    partCls: null, partDensityOff: -1, partOrientOff: -1,
    mGetGO: null, mGetName: null, mGetPos: null, mSetPos: null,
    omClass: null, mApplyOrient: null,
    camCtlClass: null, menuClass: null, dragClass: null,
    // 实时数据（由主线程钩子填充）
    live: { part: null, name: "", x: 1, y: 1, z: 0, density: 1, px: 0, py: 0, temp: NaN, has: false, props: [], bools: [], strs: [],
    burn: { angle: 0, intensity: 0, x: 0.3, has: false } },
    clickPart: null, clickTick: 0, clickTime: 0, lastSelCount: -99, lastModule: null,
    varsDumped: false, writeTested: false, modPart: null, varApiDumped: false, dictDumped: false, zeroCnt: 0,
    uiDirty: false, allDumped: false, burnDumped: false,
    lastPart: null, lastCount: 0,
    shuttingDown: false,
    // UI 层
    ui: null,
    // 设定值
    zoomUnlimited: true, savedMin: null, savedMax: null,
    rotStep: 90.0, rotHookOn: true, rotHooked: false,
    snapStep: 0.5, snapOn: true, snapHooked: false
};

var ZOOM_MIN = 0.2, ZOOM_MAX = 100000.0;

/* ---------------------------------------------------------------- IL2CPP 层 */

function setupIl2Cpp() {
    var m = Process.findModuleByName("libil2cpp.so");
    if (!m) { log("[-] libil2cpp.so not found"); return false; }
    var E = function (n) { return m.getExportByName(n); };
    var N = function (n, ret, args) { return new NativeFunction(E(n), ret, args); };

    G.fn = {
        domain_get: N("il2cpp_domain_get", "pointer", []),
        thread_attach: N("il2cpp_thread_attach", "pointer", ["pointer"]),
        get_assemblies: N("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]),
        asm_get_image: N("il2cpp_assembly_get_image", "pointer", ["pointer"]),
        img_get_name: N("il2cpp_image_get_name", "pointer", ["pointer"]),
        class_from_name: N("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]),
        cls_get_name: N("il2cpp_class_get_name", "pointer", ["pointer"]),
        cls_get_ns: N("il2cpp_class_get_namespace", "pointer", ["pointer"]),
        cls_get_parent: N("il2cpp_class_get_parent", "pointer", ["pointer"]),
        cls_get_methods: N("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]),
        method_from_name: N("il2cpp_class_get_method_from_name", "pointer", ["pointer", "pointer", "int"]),
        cls_get_type: N("il2cpp_class_get_type", "pointer", ["pointer"]),
        type_get_object: N("il2cpp_type_get_object", "pointer", ["pointer"]),
        runtime_invoke: N("il2cpp_runtime_invoke", "pointer", ["pointer", "pointer", "pointer", "pointer"]),
        object_get_class: N("il2cpp_object_get_class", "pointer", ["pointer"]),
        mth_get_name: N("il2cpp_method_get_name", "pointer", ["pointer"]),
        mth_get_ret: N("il2cpp_method_get_return_type", "pointer", ["pointer"]),
        mth_get_param: N("il2cpp_method_get_param", "pointer", ["pointer", "uint32"]),
        mth_get_pc: N("il2cpp_method_get_param_count", "uint32", ["pointer"]),
        class_get_field: N("il2cpp_class_get_field_from_name", "pointer", ["pointer", "pointer"]),
        class_get_fields: N("il2cpp_class_get_fields", "pointer", ["pointer", "pointer"]),
        field_get_name: N("il2cpp_field_get_name", "pointer", ["pointer"]),
        field_get_type: N("il2cpp_field_get_type", "pointer", ["pointer"]),
        type_get_name: N("il2cpp_type_get_name", "pointer", ["pointer"]),
        array_new: N("il2cpp_array_new", "pointer", ["pointer", "uint64"]),
        string_new: N("il2cpp_string_new", "pointer", ["pointer"]),
        class_from_type: N("il2cpp_class_from_il2cpp_type", "pointer", ["pointer"]),
        class_get_image: N("il2cpp_class_get_image", "pointer", ["pointer"]),
        object_new: N("il2cpp_object_new", "pointer", ["pointer"]),
        field_get_offset: N("il2cpp_field_get_offset", "uint32", ["pointer"]),
        field_static_get: N("il2cpp_field_static_get_value", "void", ["pointer", "pointer"])
    };

    G.domain = G.fn.domain_get();
    if (G.domain.isNull()) return false;
    G.fn.thread_attach(G.domain);

    var cntPtr = Memory.alloc(4);
    var arr = G.fn.get_assemblies(G.domain, cntPtr);
    var n = cntPtr.readU32();
    for (var i = 0; i < n; i++) {
        var a = arr.add(i * Process.pointerSize).readPointer();
        var im = G.fn.asm_get_image(a);
        var np = G.fn.img_get_name(im);
        if (np.isNull()) continue;
        var an = np.readUtf8String();
        if (an === "Assembly-CSharp.dll") G.image = im;
        if (an === "UnityEngine.CoreModule.dll") G.coreImage = im;
    }
    if (!G.image || !G.coreImage) { log("[-] images missing"); return false; }

    var cn = function (ns, nm) { return G.fn.class_from_name(G.image, Memory.allocUtf8String(ns), Memory.allocUtf8String(nm)); };
    var cc = function (ns, nm) { return G.fn.class_from_name(G.coreImage, Memory.allocUtf8String(ns), Memory.allocUtf8String(nm)); };

    G.objClass = cc("UnityEngine", "Object");
    G.compClass = cc("UnityEngine", "Component");
    G.mGetGO = G.fn.method_from_name(G.compClass, Memory.allocUtf8String("get_gameObject"), 0);
    G.mGetName = G.fn.method_from_name(G.objClass, Memory.allocUtf8String("get_name"), 0);

    G.omClass = cn("SFS.Parts.Modules", "OrientationModule");
    G.mApplyOrient = G.fn.method_from_name(G.omClass, Memory.allocUtf8String("ApplyOrientation"), 0);
    G.camCtlClass = cn("SFS.Builds", "IFBRMEVGGTRWUIVL");
    G.menuClass = cn("SFS.Builds", "UJXCFTAXVPMRVLJH");
    G.dragClass = cn("SFS.Builds", "EFYJLFKZYPMXLITO");
    G.mgrClass = cn("SFS.Builds", "RCXLCBBUKYQDMVME");

    function fOff(k, nm) {
        if (!k || k.isNull()) return -1;
        var f = G.fn.class_get_field(k, Memory.allocUtf8String(nm));
        return (f && !f.isNull()) ? G.fn.field_get_offset(f) : -1;
    }
    G.mgrSelOff = fOff(G.mgrClass, "selector");
    G.partCls = cn("SFS.Parts", "Part");
    try { G.strCls = cn("System", "String"); } catch (e) { G.strCls = null; }
    /* Part Editor 里改完变量后必须调 AdaptModule.UpdateAdaptation(part)，
     * 否则自适应形状（油箱高度那类）不会跟着更新。 */
    try {
        var adaptCls = cn("SFS.Parts.Modules", "AdaptModule");
        G.adaptM = (adaptCls && !adaptCls.isNull())
            ? G.fn.method_from_name(adaptCls, Memory.allocUtf8String("UpdateAdaptation"), 1) : null;
    } catch (e) { G.adaptM = null; }
    G.partDensityOff = fOff(G.partCls, "density");
    G.partOrientOff = fOff(G.partCls, "orientation");
    G.mGetPos = G.fn.method_from_name(G.partCls, Memory.allocUtf8String("get_Position"), 0);
    G.mSetPos = G.fn.method_from_name(G.partCls, Memory.allocUtf8String("set_Position"), 1);
    G.mRegen = G.fn.method_from_name(G.partCls, Memory.allocUtf8String("RegenerateMesh"), 0);

    log("[*] 类: part=" + !G.partCls.isNull() + " orient=" + !G.omClass.isNull()
        + " cam=" + !G.camCtlClass.isNull() + " menu=" + !G.menuClass.isNull()
        + " drag=" + !G.dragClass.isNull() + " mgr=" + !G.mgrClass.isNull());
    log("[*] 偏移: mgr.selector@" + G.mgrSelOff + "  part.density@" + G.partDensityOff
        + "  part.orientation@" + G.partOrientOff);
    return true;
}

function invoke(method, obj, args) {
    if (!method || method.isNull()) return null;
    try { G.fn.thread_attach(G.domain); } catch (e) { }
    var buf = ptr(0);
    if (args && args.length) {
        buf = Memory.alloc(8 * args.length);
        for (var q = 0; q < args.length; q++) buf.add(8 * q).writePointer(args[q]);
    }
    var exc = Memory.alloc(Process.pointerSize); exc.writePointer(ptr(0));
    var r = G.fn.runtime_invoke(method, obj, buf, exc);
    if (!exc.readPointer().isNull()) return null;
    return r;
}

/* Il2CppString: 长度 s32@0x10，UTF-16 字符 @0x14 */
function jstr(p) {
    if (!p || p.isNull()) return "?";
    try {
        var L = p.add(0x10).readS32();
        if (L < 0 || L > 300) return "";
        return p.add(0x14).readUtf16String(L);
    } catch (e) { return ""; }
}

/* 关闭修改器。
 * ★★ 核心设计：不调用 Interceptor.detachAll()，也不让脚本被卸载。
 *
 * 为什么：本脚本用 Java.registerClass 给按钮/滑条装了 onClick 与
 *   onSeekBarChangeListener。这些是 Frida 提供的 **JNI 方法**，入口地址指向
 *   已加载的 agent。一旦脚本被卸载（detachAll 或杀掉 frida-inject），这些入口
 *   就变成悬空指针；此时只要有 View 还挂着它们、或有一次触摸正在分发，游戏就会
 *      android.view.View.dispatchTouchEvent
 *        → art_quick_generic_jni_trampoline
 *          → pc <unknown>            ← 跳到未映射内存
 *            → SIGSEGV 游戏崩
 *
 *   （这就是"点 ✕ 游戏跟着关"的根因。等 900ms 再 detach 只是概率变低，没消除。）
 *
 * 现在的做法：所有钩子回调开头都有 `if (G.shuttingDown) return;`，
 *   所以只要把 shuttingDown 置位，就等于钩子全部失效、游戏回到原版行为，
 *   而且**没有任何代码被卸载**，不可能出现悬空指针。
 *   注入进程会在后台空转（几乎不耗 CPU），等用户下次执行 .sh 时，
 *   由 .sh 读到 state=stopped 后再安全地杀掉它（那时悬浮窗已移除、监听器已清空）。
 */
function shutdownMod() {
    if (G.shuttingDown) return;
    G.shuttingDown = true;
    log("[*] 收到关闭指令（钩子转入空操作，不卸载脚本）");

    /* ① 立刻移除悬浮窗。本函数在 Android 主线程的 onClick 里被调用，
     *    此刻就在主线程上，直接调即可；不要用 Java.scheduleOnMainThread。 */
    try {
        if (G.ui && G.ui.removeViews) { G.ui.removeViews(); log("[*] 悬浮窗已移除"); }
        else log("[!] G.ui.removeViews 不可用");
    } catch (e) { log("[!] 移除悬浮窗失败: " + e); }

    /* ② 还原"非钩子类"的改动。
     *    摄像机缩放上限是**直接写内存**（不是 Interceptor 钩子），所以 shuttingDown
     *    拦不住它，必须显式还原；否则"停止后游戏恢复原版"这句话就不成立。
     *    （Orientation/Position 那种改在部件实例上的，本来就属于用户想要的结果，不还原。） */
    try {
        if (G.zoomUnlimited && G.savedMin !== null) {
            setZoomLimits(G.savedMin, G.savedMax);
            G.zoomUnlimited = false;
            log("[*] 摄像机缩放限制已还原 (" + G.savedMin + " / " + G.savedMax + ")");
        }
    } catch (e) { log("[!] 还原缩放限制失败: " + e); }

    /* ③ 停掉定时器，之后不再做任何托管调用 */
    try { if (G.uiTimer) clearInterval(G.uiTimer); } catch (e) { }
    try { if (G.uiTimer2) clearInterval(G.uiTimer2); } catch (e) { }
    try { if (G.tickTimer) clearInterval(G.tickTimer); } catch (e) { }

    /* ③ 先落状态，再落停止标记（顺序不能反：.sh 看到 stopped 才敢动手） */
    writeState("stopped");

    setTimeout(function () {
        try {
            var f = new File(STOPFILE, "w");
            f.write("stop\n"); f.flush(); f.close();
            log("[*] 已写入停止标记；钩子已停用，游戏恢复原版行为，且脚本仍驻留（不会崩）");
        } catch (e) { log("[!] 写停止标记失败: " + e); }
    }, 300);
}

/* ============================================================ 选中部件读取 */

function findFieldDeep(k, nm) {
    var c = k, depth = 0;
    while (c && !c.isNull() && depth++ < 10) {
        var f = G.fn.class_get_field(c, Memory.allocUtf8String(nm));
        if (f && !f.isNull()) return G.fn.field_get_offset(f);
        c = G.fn.cls_get_parent(c);
    }
    return -1;
}

/* 纯内存读取选中部件（可从任意线程安全调用） */
function readSelectionRaw() {
    try {
        if (!G.mgrClass || G.mgrClass.isNull() || G.mgrSelOff <= 0) return null;
        var fMain = G.fn.class_get_field(G.mgrClass, Memory.allocUtf8String("main"));
        if (!fMain || fMain.isNull()) return null;
        var b0 = Memory.alloc(Process.pointerSize);
        G.fn.field_static_get(fMain, b0);
        var mgr = b0.readPointer();
        if (mgr.isNull()) return null;
        var sel = mgr.add(G.mgrSelOff).readPointer();
        if (sel.isNull()) return null;
        var selCls = G.fn.object_get_class(sel);
        var offSel = findFieldDeep(selCls, "selected");
        if (offSel <= 0) return null;
        var set = sel.add(offSel).readPointer();
        if (set.isNull()) return null;
        var setCls = G.fn.object_get_class(set);
        var cOff = findFieldDeep(setCls, "_count");
        var sOff = findFieldDeep(setCls, "_slots");
        if (cOff <= 0 || sOff <= 0) return null;
        var cnt = set.add(cOff).readS32();
        if (cnt < 0 || cnt > 10000) return null;
        if (cnt < 1) return { count: cnt, part: null };
        var slots = set.add(sOff).readPointer();
        if (slots.isNull()) return { count: cnt, part: null };
        for (var si = 0; si < 32; si++) {
            var cand = slots.add(0x20).add(si * 16).add(8).readPointer();
            if (plausiblePtr(cand)) return { count: cnt, part: cand };
        }
        return { count: cnt, part: null };
    } catch (e) { return null; }
}

/* 部件内的 Obs 值对象 */
function orientObjOf(part) {
    try {
        if (!partAlive(part)) return null;
        var om = part.add(G.partOrientOff).readPointer();
        if (om.isNull()) return null;
        var obs = om.add(0x20).readPointer();
        if (obs.isNull()) return null;
        var o = obs.add(0x10).readPointer();
        return (o && !o.isNull()) ? o : null;
    } catch (e) { return null; }
}

function densityObsOf(part) {
    try {
        if (!partAlive(part)) return null;
        var d = part.add(G.partDensityOff).readPointer();
        return (d && !d.isNull()) ? d : null;
    } catch (e) { return null; }
}

/* Part.Position (Vector2 属性)。
 * 重要：get_Position 是 0 参数方法，runtime_invoke 的 params 数组必须为空，
 *   否则会违反调用约定而破坏内存（实测直接把游戏进程搞崩）。
 *   返回值 r 指向运行时装箱的结果对象，Vector2 在 r+0x10 / r+0x14。 */
var posLogN = 0;
function readPosition(part) {
    if (!G.mGetPos || G.mGetPos.isNull()) return null;
    try {
        var r = invoke(G.mGetPos, part, []);
        if (r === null || r.isNull()) return null;
        var x = r.add(0x10).readFloat(), y = r.add(0x14).readFloat();
        if (posLogN++ < 3) log("[POS] r=" + r + "  (" + x + ", " + y + ")");
        if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 1e5 || Math.abs(y) > 1e5) return null;
        return { x: x, y: y };
    } catch (e) { return null; }
}

/* 校验一个 Part 指针是否仍然可用。
 * 必须做：复制/删除部件时 SFS 会销毁旧对象，锁存的指针会变成野指针，
 *   拿它去调托管方法（get_gameObject / get_Position）会卡死甚至崩溃游戏。
 *   判据两条（都是纯内存读，很便宜）：
 *     ① object_get_class 出来的类型必须仍是 SFS.Parts.Part
 *     ② UnityEngine.Object.m_CachedPtr (@0x10) 非 0 —— 对象被 Destroy 后会被清零
 */
function partAlive(p) { return partAliveWhy(p) === ""; }

/* 是否 SFS.Parts.Part（含其子类）——按父类链判断，避免只认精确类而漏掉派生类 */
function isPartClass(k) {
    if (!k || k.isNull()) return false;
    if (k.equals(G.partCls)) return true;
    try {
        var c = k, n = 0;
        while (!c.isNull() && n < 12) {
            c = G.fn.cls_get_parent(c);
            n++;
            if (!c.isNull() && c.equals(G.partCls)) return true;
        }
    } catch (e) { }
    return false;
}

/* 安全指针判定：64 位地址落在用户态可读区间，且该地址所在内存段确实可读。
 * 必须做：字段值里经常出现 0x3f800000（float 1.0）这类"看着像指针"的数字，
 *   直接喂给 il2cpp_object_get_class 会让游戏段错误（JS 的 try/catch 兜不住）。 */
function plausiblePtr(v) {
    if (!v || v.isNull()) return false;
    try {
        if (v.compare(ptr("0x10000")) < 0) return false;
        if (v.compare(ptr("0x8000000000")) > 0) return false;
        return Process.findRangeByAddress(v) !== null;
    } catch (e) { return false; }
}

/* 返回空串表示可用，否则返回不可用的原因（用于诊断） */
function partAliveWhy(p) {
    if (!p || p.isNull()) return "指针为空";
    if (!plausiblePtr(p)) return "指针不在可读内存段 " + p;
    try {
        var k = G.fn.object_get_class(p);
        if (k.isNull()) return "取不到类";
        if (!isPartClass(k)) {
            var nm = "";
            try {
                nm = (G.fn.cls_get_ns(k).isNull() ? "" : G.fn.cls_get_ns(k).readUtf8String())
                    + "." + G.fn.cls_get_name(k).readUtf8String();
            } catch (e) { nm = "(?)"; }
            return "类型不是 Part，而是 " + nm;
        }
        var cached = p.add(0x10).readPointer();
        if (cached.isNull()) return "m_CachedPtr 为 0（对象已被销毁）";
        return "";
    } catch (e) { return "读取异常: " + e; }
}

/* 在一个对象（及其成员，深度 1~2 层）里按【类型】找出 Part 实例。
 * 这是替代"猜 HashSet 内存布局"的做法：只用类/字段元数据 + 类型比较，
 *   不依赖任何硬编码偏移，游戏更新后也不容易失效。 */
var findPartLogN = 0;
function findPartInObject(obj, depth) {
    if (depth > 2 || !plausiblePtr(obj)) return null;
    var k = G.fn.object_get_class(obj);
    if (k.isNull()) return null;
    if (isPartClass(k)) return obj;
    var it = Memory.alloc(Process.pointerSize); it.writePointer(ptr(0));
    var f, n = 0;
    while ((f = G.fn.class_get_fields(k, it)) && !f.isNull() && n < 40) {
        var off = G.fn.field_get_offset(f);
        if (off > 0) {
            try {
                var v = obj.add(off).readPointer();
                if (plausiblePtr(v)) {
                    var c = G.fn.object_get_class(v);
                    if (!c.isNull()) {
                        if (isPartClass(c)) return v;
                        if (depth < 2) { var r = findPartInObject(v, depth + 1); if (r) return r; }
                    }
                }
            } catch (e) { }
        }
        n++;
    }
    return null;
}

/* 把对象的字段结构打出来（诊断用，最多几次）。
 * depth>1 时会继续展开子对象的字段，用来定位"部件被谁持有"。 */
function dumpObjFields(obj, tag, depth) {
    if (!plausiblePtr(obj)) { log("   " + tag + " = " + obj + " (不可读)"); return; }
    if (depth === undefined) depth = 1;
    var k = G.fn.object_get_class(obj);
    var pad = depth >= 2 ? "        " : "   ";
    log(pad + "=== " + tag + " " + obj + " 类型=" + partAliveWhyType(k) + " ===");
    var it = Memory.alloc(Process.pointerSize); it.writePointer(ptr(0));
    var f, n = 0;
    while ((f = G.fn.class_get_fields(k, it)) && !f.isNull() && n < 40) {
        var off = G.fn.field_get_offset(f);
        if (off > 0) {
            var nm = "?", ft = "";
            try { nm = G.fn.field_get_name(f).readUtf8String(); } catch (e) { }
            try {
                var tp = G.fn.field_get_type(f);
                if (tp && !tp.isNull()) ft = G.fn.type_get_name(tp).readUtf8String();
            } catch (e) { }
            var v = ptr(0), ty = "";
            try { v = obj.add(off).readPointer(); } catch (e) { }
            try { if (plausiblePtr(v)) { var c2 = G.fn.object_get_class(v); if (!c2.isNull()) ty = partAliveWhyType(c2); } } catch (e) { }
            log("      +0x" + off.toString(16) + "  " + ft + " " + nm
                + "  = " + v + (ty ? ("  -> " + ty) : ""));
            if (depth >= 2 && ty && plausiblePtr(v) && !isPartClass(G.fn.object_get_class(v))) {
                try { dumpObjFields(v, nm, depth - 1); } catch (e) { }
            }
        }
        n++;
    }
}
function partAliveWhyType(k) {
    if (!k || k.isNull()) return "(空类)";
    try {
        return (G.fn.cls_get_ns(k).isNull() ? "" : G.fn.cls_get_ns(k).readUtf8String())
            + "." + G.fn.cls_get_name(k).readUtf8String();
    } catch (e) { return "(?)"; }
}

/* 单选时直接从托管集合里取出那个元素。
 * 用 HashSet<T>.CopyTo(T[], int) + il2cpp_array_new 造一个托管数组，
 *   再从数组里读第 0 个元素 —— 全程走托管 API，不碰任何内存布局假设。
 *   （这正是修掉"取消 A 之后指针还停在 A"的关键：那条手写槽位扫描
 *     扫的是哈希桶里的残留内容，取出来的可能根本不是当前选中的部件。） */
var copyToM = null, copyToCls = null, idxZero = null;
function selPartManaged() {
    try {
        var set = selSetObj();
        if (!set) return null;
        var k = G.fn.object_get_class(set);
        if (k.isNull()) return null;
        if (!copyToM || !copyToCls || !copyToCls.equals(k)) {
            copyToM = null; copyToCls = k;
            var c = k, d = 0;
            while (!c.isNull() && d++ < 8) {
                var m = G.fn.method_from_name(c, Memory.allocUtf8String("CopyTo"), 2);
                if (m && !m.isNull()) { copyToM = m; break; }
                c = G.fn.cls_get_parent(c);
            }
        }
        if (!copyToM) return null;
        if (!idxZero) { idxZero = Memory.alloc(8); idxZero.writeS32(0); }
        var arr = G.fn.array_new(G.partCls, 4);
        if (arr.isNull()) return null;
        invoke(copyToM, set, [arr, idxZero]);
        var len = arr.add(0x18).readU32();
        if (len < 1 || len > 4) return null;
        var p0 = arr.add(0x20).readPointer();
        return (plausiblePtr(p0) && isPartClass(G.fn.object_get_class(p0))) ? p0 : null;
    } catch (e) { return null; }
}

/* 取 BuildSelector.selected 集合对象（纯内存读，对象指针本身是可靠的） */
function selSetObj() {
    try {
        if (!G.mgrClass || G.mgrClass.isNull() || G.mgrSelOff <= 0) return null;
        var fMain = G.fn.class_get_field(G.mgrClass, Memory.allocUtf8String("main"));
        if (!fMain || fMain.isNull()) return null;
        var b0 = Memory.alloc(Process.pointerSize);
        G.fn.field_static_get(fMain, b0);
        var mgr = b0.readPointer();
        if (!plausiblePtr(mgr)) return null;
        var sel = mgr.add(G.mgrSelOff).readPointer();
        if (!plausiblePtr(sel)) return null;
        var offSel = findFieldDeep(G.fn.object_get_class(sel), "selected");
        if (offSel <= 0) return null;
        var set = sel.add(offSel).readPointer();
        return plausiblePtr(set) ? set : null;
    } catch (e) { return null; }
}

/* 选中集合的元素个数。
 * 走托管 API HashSet<T>.get_Count，不再猜内存布局（猜布局那条路已证明是错的）。
 *   返回 -1 表示"读不到"，调用方必须当成"未知"，绝不能当成 0。 */
var cntMethod = null, cntCls = null;
function selCount() {
    try {
        var set = selSetObj();
        if (!set) return -1;
        var k = G.fn.object_get_class(set);
        if (k.isNull()) return -1;
        if (!cntMethod || !cntCls || !cntCls.equals(k)) {
            cntMethod = null; cntCls = k;
            var c = k, d = 0;
            while (!c.isNull() && d++ < 8) {
                var m = G.fn.method_from_name(c, Memory.allocUtf8String("get_Count"), 0);
                if (m && !m.isNull()) { cntMethod = m; break; }
                c = G.fn.cls_get_parent(c);
            }
        }
        if (!cntMethod) return -1;
        var r = invoke(cntMethod, set, []);
        if (r === null || r.isNull()) return -1;
        /* 基本类型返回值的包装方式在 IL2CPP 里不统一，两种都试 */
        var probes = [r.toInt32(), r.add(0x10).readS32()];
        for (var i = 0; i < probes.length; i++) {
            var n = probes[i];
            if (n >= 0 && n <= 100000) return n;
        }
        return -1;
    } catch (e) { return -1; }
}

/* 从部件自身解析出"形状模块"。
 * 为什么需要：点击钩子能给出被点中的模块，但**框选**（多选/单选框选）不经过点击钩子，
 * 那时 G.lastModule 是空的，属性就一个都读不出来。
 * PolygonData 是形状模块的基类，所以在部件自己的字段里找一个它的派生类实例即可。 */
function clsIsNamed(k, want) {
    if (!k || k.isNull()) return false;
    try {
        var c = k, d = 0;
        while (!c.isNull() && d++ < 12) {
            if (G.fn.cls_get_name(c).readUtf8String() === want) return true;
            c = G.fn.cls_get_parent(c);
        }
    } catch (e) { }
    return false;
}
function findShapeModule(part) {
    if (!partAlive(part)) return null;
    var k = G.fn.object_get_class(part);
    if (k.isNull()) return null;
    var it = Memory.alloc(Process.pointerSize); it.writePointer(ptr(0));
    var f, n = 0;
    while ((f = G.fn.class_get_fields(k, it)) && !f.isNull() && n < 60) {
        var off = G.fn.field_get_offset(f);
        if (off > 0) {
            try {
                var v = part.add(off).readPointer();
                if (plausiblePtr(v) && clsIsNamed(G.fn.object_get_class(v), "PolygonData")) {
                    log("[PROP] 从部件自身解析到形状模块 @" + ("0x" + off.toString(16)) + " = " + v
                        + "  (" + partAliveWhyType(G.fn.object_get_class(v)) + ")");
                    return v;
                }
            } catch (e) { }
        }
        n++;
    }
    return null;
}

/* ============ 部件参数的"可写"通道（需求① 路线 B） ============
 * 实测 SFS.Variables.Composed_Float（以及同族的 Float_Local 等变量对象）的布局：
 *     +0x1c  System.Single   value            ← 值本身
 *     +0x20  System.Action   onChange         ← 无参委托，改完必须触发它
 *     +0x28  System.Action<Single,Single>  onChangeOldNew
 * Composed_Float 还自带 input(System.String) / compiled 委托 —— 说明它是
 * **表达式驱动**的：只改 value 不触发 onChange，下一帧就会被重算覆盖。
 * 所以写入 = 写 value + 调 onChange。 */
var actInvokeM = null, actInvokeCls = null;
function fireAction(actionObj) {
    if (!plausiblePtr(actionObj)) return false;
    var k = G.fn.object_get_class(actionObj);
    if (k.isNull()) return false;
    if (!actInvokeM || !actInvokeCls || !actInvokeCls.equals(k)) {
        actInvokeM = null; actInvokeCls = k;
        var c = k, d = 0;
        while (!c.isNull() && d++ < 8) {
            var m = G.fn.method_from_name(c, Memory.allocUtf8String("Invoke"), 0);
            if (m && !m.isNull()) { actInvokeM = m; break; }
            c = G.fn.cls_get_parent(c);
        }
    }
    if (!actInvokeM) return false;
    invoke(actInvokeM, actionObj, []);
    return true;
}

/* 把值写进一个变量对象，并触发它的 onChange。
 * dryRun=true 时写回原值（零改动，只验证通道）。 */
function writeVarValue(varObj, val, dryRun) {
    if (!plausiblePtr(varObj)) return false;
    try {
        var old = varObj.add(0x1c).readFloat();
        var target = dryRun ? old : val;
        varObj.add(0x1c).writeFloat(target);
        var cb = varObj.add(0x20).readPointer();
        var fired = fireAction(cb);
        if (!dryRun) {
            log("[WRITE] " + old.toFixed(4) + " → " + target.toFixed(4)
                + "   onChange=" + (fired ? "已触发" : "未找到 Invoke"));
        }
        return fired;
    } catch (e) { log("[WRITE] 异常: " + e); return false; }
}

/* ================= 需求①：部件参数（蓝图 "N" 列）的正式读写通道 =================
 * 依据 cucumber-sp/PartEditor（GUI.cs）与实测确认的混淆签名：
 *   GDNBKJPJMEI/0  () -> Dictionary<String,Double>                 = GetSaveDictionary()
 *   AGPHHELNDPF/3  (String, Double, ValueTuple<Bool,Bool>) -> Void = SetValue(name, value, (true,true))
 * 写入后必须 part.RegenerateMesh() + AdaptModule.UpdateAdaptation(part)。
 * 实测油箱的 5 个键：width_original / width_a / width_b / height / fuel_percent。
 * ★ 之前直接写 Composed_Float.value 的做法只能改"求值结果"，存不进蓝图，已废弃。 */

function findMethodByName(cls, name, argc) {
    var c = cls, d = 0;
    while (!c.isNull() && d++ < 8) {
        var m = G.fn.method_from_name(c, Memory.allocUtf8String(name), argc);
        if (m && !m.isNull()) return m;
        c = G.fn.cls_get_parent(c);
    }
    return null;
}

/* 基本类型返回值会被 IL2CPP 装箱，值在 +0x10；但包装方式不统一，两路都试并做范围校验。
 * （不做校验就会读出 -1736827104 这种垃圾值） */
function pickInt(r) {
    if (!r || r.isNull()) return -1;
    var ps = [r.toInt32(), r.add(0x10).readS32()];
    for (var i = 0; i < ps.length; i++) if (ps[i] >= 0 && ps[i] <= 100000) return ps[i];
    return -1;
}

/* System.String 在 mscorlib，用 il2cpp_class_from_name 配游戏自身 image 找不到，
 * 改从"真实的字符串对象"反推。 */
var _strCls = null;
function strClass() {
    if (_strCls && !_strCls.isNull()) return _strCls;
    try {
        if (G.live.part && G.mGetGO && G.mGetName) {
            var go = invoke(G.mGetGO, G.live.part, []);
            if (go && !go.isNull()) {
                var nm = invoke(G.mGetName, go, []);
                if (nm && !nm.isNull()) _strCls = G.fn.object_get_class(nm);
            }
        }
    } catch (e) { }
    return _strCls;
}
function cstr(s) { return G.fn.string_new(Memory.allocUtf8String(s)); }

/* 取部件的 doubleVariables 列表对象 */
function varListOf(part) {
    if (!partAlive(part)) return null;
    var off = findFieldDeep(G.partCls, "variablesModule");
    if (off <= 0) return null;
    var vm = part.add(off).readPointer();
    if (!plausiblePtr(vm)) return null;
    var dl = vm.add(0x20).readPointer();          // doubleVariables @0x20
    return plausiblePtr(dl) ? dl : null;
}

var mGetSaveDict = null, mGetItem = null, mSetValue = null;

/* 返回 { list, dict, names:[...], values:[...] }，失败返回 null */
function readVarTable(part) {
    try {
        var dl = varListOf(part);
        if (!dl) return null;
        var lc = G.fn.object_get_class(dl);
        if (!mGetSaveDict) mGetSaveDict = findMethodByName(lc, "GDNBKJPJMEI", 0);
        if (!mGetSaveDict) { log("[VAR] 找不到 GetSaveDictionary"); return null; }
        var dict = invoke(mGetSaveDict, dl, []);
        if (!plausiblePtr(dict)) return null;

        var dk = G.fn.object_get_class(dict);
        var mCnt = findMethodByName(dk, "get_Count", 0);
        var mKeys = findMethodByName(dk, "get_Keys", 0);
        if (!mGetItem) mGetItem = findMethodByName(dk, "get_Item", 1);
        if (!mCnt || !mKeys || !mGetItem) { log("[VAR] 字典方法缺失"); return null; }
        var cnt = pickInt(invoke(mCnt, dict, []));
        if (cnt <= 0) return { list: dl, dict: dict, names: [], values: [] };

        var scls = strClass();
        if (!scls) { log("[VAR] 取不到 System.String 类"); return null; }
        var keys = invoke(mKeys, dict, []);
        if (!plausiblePtr(keys)) return null;
        var mCopy = findMethodByName(G.fn.object_get_class(keys), "CopyTo", 2);
        if (!mCopy) return null;
        var zz = Memory.alloc(8); zz.writeS32(0);
        var arr = G.fn.array_new(scls, cnt);
        invoke(mCopy, keys, [arr, zz]);

        var names = [], values = [];
        for (var i = 0; i < cnt && i < 40; i++) {
            var sp = arr.add(0x20).add(i * 8).readPointer();
            if (sp.isNull()) continue;
            var nm = jstr(sp);
            names.push(nm);
            var rv = invoke(mGetItem, dict, [sp]);
            values.push((rv && !rv.isNull()) ? rv.add(0x10).readDouble() : NaN);
        }
        return { list: dl, dict: dict, names: names, values: values };
    } catch (e) { log("[VAR] 读取异常: " + e); return null; }
}

/* 按变量名写入：SetValue(name, value, (true,true)) + RegenerateMesh + UpdateAdaptation */
function writeVarByName(part, name, val, skipRefresh) {
    try {
        var dl = varListOf(part);
        if (!dl) { log("[VAR] 取不到变量列表"); return false; }
        if (!mSetValue) mSetValue = findMethodByName(G.fn.object_get_class(dl), "AGPHHELNDPF", 3);
        if (!mSetValue) { log("[VAR] 找不到 SetValue"); return false; }
        var dbl = Memory.alloc(8); dbl.writeDouble(val);
        /* ValueTuple<bool,bool> 是结构体，按值传参 → 参数数组里放"指向该结构体的指针" */
        var tup = Memory.alloc(8); tup.writeU8(1); tup.add(1).writeU8(1);
        invoke(mSetValue, dl, [cstr(name), dbl, tup]);
        if (!skipRefresh) {
            try { if (G.mRegen && !G.mRegen.isNull()) invoke(G.mRegen, part, []); } catch (e) { }
            try { if (G.adaptM && !G.adaptM.isNull()) invoke(G.adaptM, ptr(0), [part]); } catch (e) { }
        }
        return true;
    } catch (e) { log("[VAR] 写入异常: " + e); return false; }
}

/* width_original / width_a / width_b 三者必须联动写入。
 * 依据 SFSBuildSettings 的 PartModifiers.cs：
 *     newWidthUpper = width_a + delta
 *     newWidthLower = width_b + delta
 *     newWidthOriginal = Math.Min(newWidthUpper, newWidthLower)   // 不一致时取较小值
 * 也就是说 width_original 是"派生摘要"，游戏**不会**从它反推 a/b。
 * 只写单个变量就会出现"改了 width_original，a/b 不动"的怪现象。 */
function writePartParam(part, name, val) {
    var cur = {};
    for (var i = 0; i < G.live.props.length; i++) cur[G.live.props[i].name] = G.live.props[i].value;
    var hasAB = (cur.width_a !== undefined && cur.width_b !== undefined);

    if (name === "width_original" && hasAB) {
        var delta = val - (cur.width_original || 0);
        var na = cur.width_a + delta, nb = cur.width_b + delta;
        var no = Math.min(na, nb);
        writeVarByName(part, "width_original", no, true);
        writeVarByName(part, "width_a", na, true);
        writeVarByName(part, "width_b", nb);      // 最后一次负责刷新网格
        /* 面板立刻跟上（周期重读也会兜底） */
        for (var j = 0; j < G.live.props.length; j++) {
            if (G.live.props[j].name === "width_original") G.live.props[j].value = no;
            if (G.live.props[j].name === "width_a") G.live.props[j].value = na;
            if (G.live.props[j].name === "width_b") G.live.props[j].value = nb;
        }
        log("[VAR] width 联动: a=" + na.toFixed(3) + " b=" + nb.toFixed(3) + " original=" + no.toFixed(3));
        return true;
    }

    var ok = writeVarByName(part, name, val);
    /* 直接改 width_a / width_b 时，同步把 width_original 修正为两者较小值 */
    if ((name === "width_a" || name === "width_b") && cur.width_original !== undefined) {
        var a2 = (name === "width_a") ? val : cur.width_a;
        var b2 = (name === "width_b") ? val : cur.width_b;
        if (isFinite(a2) && isFinite(b2)) {
            var no2 = Math.min(a2, b2);
            writeVarByName(part, "width_original", no2);
            for (var k2 = 0; k2 < G.live.props.length; k2++) {
                if (G.live.props[k2].name === name) G.live.props[k2].value = val;
                if (G.live.props[k2].name === "width_original") G.live.props[k2].value = no2;
            }
        }
    }
    return ok;
}

/* 数值显示格式：保留到 dec 位小数，然后去掉末尾多余的 0 和小数点。
 * 为什么不直接用 toFixed(2)：那样会把用户输入的 5.12235 显示成 5.12。
 * 为什么又要去尾零：Part 的坐标底层是 float32，10 会变成 10.000001 这类值，
 *   不去零就会显示成一串噪声。
 * 取 5 位：float32 对 5.12235 这类值精度足够，而 10.000001 会规整回 "10"。 */
function fmtNum(v, dec) {
    if (!isFinite(v)) return "--";
    var s = v.toFixed(dec === undefined ? 5 : dec);
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
}

/* 各参数的步进 / 显示小数位
 * 按用户要求：所有数值步长统一为 0.05，显示 2 位小数。
 * （fuel_percent 是 0–1 的比例，0.05 即每按一次 5%） */
function varScaler(name) {
    if (name === "fuel_percent") return { min: 0, max: 1, step: 0.05, dec: 5 };
    return { min: 0, max: 10, step: 0.05, dec: 5 };
}

/* 一次性：把三个变量列表（double / bool / string）全部 dump 出来。
 * 用于实现 Bool / String 抽屉 —— 需要先知道：
 *   ① 三个列表的 GetSaveDictionary 方法名是否通用（同一个泛型基类，很可能通用）
 *   ② 各自的键名
 *   ③ 值怎么从 get_Item 的返回对象里读（double 在 +0x10 是 8 字节；
 *      bool 是 1 字节；string 是 Il2CppString* 指针） */
function dumpAllVarLists(part) {
    var offs = [["doubleVariables", 0x20], ["boolVariables", 0x28], ["stringVariables", 0x30]];
    var vo = findFieldDeep(G.partCls, "variablesModule");
    if (vo <= 0) { log("[DUMP] 取不到 variablesModule 字段"); return; }
    var vm = part.add(vo).readPointer();
    if (!plausiblePtr(vm)) { log("[DUMP] variablesModule 指针不可用"); return; }
    for (var i = 0; i < offs.length; i++) {
        var nm = offs[i][0], off = offs[i][1];
        try {
            var lst = vm.add(off).readPointer();
            log("[DUMP] ==== " + nm + " @" + ("0x" + off.toString(16)) + " = " + lst + " ====");
            if (!plausiblePtr(lst)) { log("[DUMP]   不可用"); continue; }
            var lc = G.fn.object_get_class(lst);
            log("[DUMP]   类 = " + partAliveWhyType(lc));
            var mGet = findMethodByName(lc, "GDNBKJPJMEI", 0);
            log("[DUMP]   GetSaveDictionary = " + mGet);
            if (!mGet) continue;
            var dict = invoke(mGet, lst, []);
            if (!plausiblePtr(dict)) { log("[DUMP]   字典不可用: " + dict); continue; }
            var dk = G.fn.object_get_class(dict);
            var mCnt = findMethodByName(dk, "get_Count", 0);
            var mKeys = findMethodByName(dk, "get_Keys", 0);
            var mItem = findMethodByName(dk, "get_Item", 1);
            var cnt = mCnt ? pickInt(invoke(mCnt, dict, [])) : -1;
            log("[DUMP]   Count = " + cnt + "  (Keys=" + mKeys + " Item=" + mItem + ")");
            if (cnt <= 0 || !mKeys || !mItem) continue;
            var scls = strClass();
            if (!scls) { log("[DUMP]   取不到 System.String 类"); continue; }
            var keys = invoke(mKeys, dict, []);
            if (!plausiblePtr(keys)) continue;
            var mCopy = findMethodByName(G.fn.object_get_class(keys), "CopyTo", 2);
            if (!mCopy) { log("[DUMP]   KeyCollection 无 CopyTo"); continue; }
            var zz = Memory.alloc(8); zz.writeS32(0);
            var arr = G.fn.array_new(scls, cnt);
            invoke(mCopy, keys, [arr, zz]);
            for (var k = 0; k < cnt && k < 30; k++) {
                var sp = arr.add(0x20).add(k * 8).readPointer();
                if (sp.isNull()) continue;
                var kv = jstr(sp);
                var rv = invoke(mItem, dict, [sp]);
                var shown = "?";
                if (rv && !rv.isNull()) {
                    if (nm === "doubleVariables") shown = "" + rv.add(0x10).readDouble();
                    else if (nm === "boolVariables") shown = (rv.add(0x10).readU8() ? "true" : "false");
                    else {
                        var stp = rv.add(0x10).readPointer();
                        shown = plausiblePtr(stp) ? ("\"" + jstr(stp) + "\"") : "null";
                    }
                }
                log("[DUMP]      " + kv + " = " + shown);
            }
        } catch (e) { log("[DUMP] " + nm + " 异常: " + e); }
    }
}

/* 一次性：把部件里能捞到的字符串 / 字符串数组全打出来。
 * 目的：String 变量（实测键名是 shape_tex / color_tex）默认值是 null，
 * 说明"可选的条纹名"不在变量列表里，而在别处。如果它在某个字符串数组里，
 * 这个递归扫描就能捞到形如 "Default" / "White" / "Orange" 的名字。
 * ★ 只读、只打日志；深度和访问次数都设了上限，避免扫到奇怪对象上出事。 */
function harvestStrings(part) {
    var seen = 0, found = [];
    var scls = strClass();
    if (!scls) { log("[STR] 取不到 System.String 类"); return; }
    function scan(obj, depth, path) {
        if (depth > 3 || seen > 500 || !plausiblePtr(obj)) return;
        seen++;
        var k = G.fn.object_get_class(obj);
        if (k.isNull()) return;
        var tn = partAliveWhyType(k);
        /* 字符串数组 */
        if (tn.indexOf("System.String") === 0 && tn.indexOf("[]") > 0) {
            var len = obj.add(0x18).readU32();
            var items = [];
            for (var i = 0; i < len && i < 24; i++) {
                var sp = obj.add(0x20).add(i * 8).readPointer();
                items.push(plausiblePtr(sp) ? ("\"" + jstr(sp) + "\"") : "null");
            }
            found.push(path + "  = [" + items.join(", ") + "]  (len=" + len + ")");
            return;
        }
        /* 单个字符串 */
        if (k.equals(scls)) {
            found.push(path + "  = \"" + jstr(obj) + "\"");
            return;
        }
        /* 其它对象：继续下钻 */
        var it = Memory.alloc(Process.pointerSize); it.writePointer(ptr(0));
        var f, n = 0;
        while ((f = G.fn.class_get_fields(k, it)) && !f.isNull() && n < 40) {
            var off = G.fn.field_get_offset(f);
            if (off > 0) {
                var fn = "?";
                try { fn = G.fn.field_get_name(f).readUtf8String(); } catch (e) { }
                try {
                    var v = obj.add(off).readPointer();
                    if (plausiblePtr(v)) scan(v, depth + 1, path + "." + fn);
                } catch (e) { }
            }
            n++;
        }
    }
    try { scan(part, 0, "part"); } catch (e) { log("[STR] 扫描异常: " + e); }
    log("[STR] 共 " + found.length + " 条（访问了 " + seen + " 个对象）:");
    for (var i = 0; i < found.length && i < 80; i++) log("[STR]   " + found[i]);
}

/* ================= Bool 变量列表（开关） =================
 * 实测（b713）：boolVariables@0x28，与 double 同构，只是方法指针各自独立：
 *   GDNBKJPJMEI/0 = GetSaveDictionary、AGPHHELNDPF/3 = SetValue
 *   值从 get_Item 返回的装箱对象 +0x10 读 1 字节
 * 实测发动机的键：engine_on / gimbal_on / heat_on__for_creative_use */
var BOOL_OFF = 0x28;
var mBoolGetDict = null, mBoolSetValue = null, mBoolGetItem = null;

function boolListOf(part) {
    if (!partAlive(part)) return null;
    var off = findFieldDeep(G.partCls, "variablesModule");
    if (off <= 0) return null;
    var vm = part.add(off).readPointer();
    if (!plausiblePtr(vm)) return null;
    var bl = vm.add(BOOL_OFF).readPointer();
    return plausiblePtr(bl) ? bl : null;
}

function readBoolTable(part) {
    try {
        var bl = boolListOf(part);
        if (!bl) return null;
        var bc = G.fn.object_get_class(bl);
        if (!mBoolGetDict) mBoolGetDict = findMethodByName(bc, "GDNBKJPJMEI", 0);
        if (!mBoolGetDict) { log("[BOOL] 找不到 GetSaveDictionary"); return null; }
        var dict = invoke(mBoolGetDict, bl, []);
        if (!plausiblePtr(dict)) return null;
        var dk = G.fn.object_get_class(dict);
        var mCnt = findMethodByName(dk, "get_Count", 0);
        var mKeys = findMethodByName(dk, "get_Keys", 0);
        if (!mBoolGetItem) mBoolGetItem = findMethodByName(dk, "get_Item", 1);
        if (!mCnt || !mKeys || !mBoolGetItem) return null;
        var cnt = pickInt(invoke(mCnt, dict, []));
        if (cnt <= 0) return { names: [], values: [] };
        var scls = strClass();
        if (!scls) return null;
        var keys = invoke(mKeys, dict, []);
        if (!plausiblePtr(keys)) return null;
        var mCopy = findMethodByName(G.fn.object_get_class(keys), "CopyTo", 2);
        if (!mCopy) return null;
        var zz = Memory.alloc(8); zz.writeS32(0);
        var arr = G.fn.array_new(scls, cnt);
        invoke(mCopy, keys, [arr, zz]);
        var names = [], values = [];
        for (var i = 0; i < cnt && i < 40; i++) {
            var sp = arr.add(0x20).add(i * 8).readPointer();
            if (sp.isNull()) continue;
            names.push(jstr(sp));
            var rv = invoke(mBoolGetItem, dict, [sp]);
            values.push((rv && !rv.isNull()) ? (rv.add(0x10).readU8() !== 0) : false);
        }
        return { names: names, values: values };
    } catch (e) { log("[BOOL] 读取异常: " + e); return null; }
}

function writeBoolVar(part, name, val) {
    try {
        var bl = boolListOf(part);
        if (!bl) { log("[BOOL] 取不到 bool 列表"); return false; }
        if (!mBoolSetValue) mBoolSetValue = findMethodByName(G.fn.object_get_class(bl), "AGPHHELNDPF", 3);
        if (!mBoolSetValue) { log("[BOOL] 找不到 SetValue"); return false; }
        /* System.Boolean 是 1 字节的值类型，按值传参 → 参数数组里放指向它的指针 */
        var b = Memory.alloc(8); b.writeU8(val ? 1 : 0);
        var tup = Memory.alloc(8); tup.writeU8(1); tup.add(1).writeU8(1);
        invoke(mBoolSetValue, bl, [cstr(name), b, tup]);
        try { if (G.mRegen && !G.mRegen.isNull()) invoke(G.mRegen, part, []); } catch (e) { }
        try { if (G.adaptM && !G.adaptM.isNull()) invoke(G.adaptM, ptr(0), [part]); } catch (e) { }
        return true;
    } catch (e) { log("[BOOL] 写入异常: " + e); return false; }
}

/* ================= String 变量列表（条纹/纹理名） =================
 * 实测（b713）：stringVariables@0x30，键名 color_tex / shape_tex，默认值 null。
 * 值从 get_Item 返回的装箱对象 +0x10 读 Il2CppString* 指针。
 * 写入时参数是引用类型 → 参数数组里直接放字符串指针（空串按 null 处理，表示还原默认）。 */
var STR_OFF = 0x30;
var mStrGetDict = null, mStrSetValue = null, mStrGetItem = null;

/* 候选名 = 用户提供的原版纹理清单 + 设备蓝图里实际用过的值（去重）。
 * 已按用户实测结果剔除不生效的名字：
 *   color_tex 去掉 R_USA 0 / R_USA 1 / R_USA - Skin / RStripes / RStripes 1 /
 *              RStripes 2 / Blue / Cone
 *   shape_tex 去掉 Interstage_Full
 *   其中 Blue / Cone 是"只出现在蓝图里、图上没有"的（疑似他人自制或 mod 内容），
 *   R_USA* / RStripes* / Interstage_Full 是"只出现在图上"的（疑似显示名与
 *   内部键拼写不一致）。两类都被证实不可用。
 * ★ 本表仅供 ‹ › 循环，数值框仍可自由输入其他名字。 */
var STR_CANDIDATES = {
    color_tex: [
        "Color_Black", "Color_Gray", "Color_White", "Color_Orange",
        "Metal", "Metal_2", "Metal_3", "Metal_4", "Strut_Gray", "Strut_Gray_2",
        "Gold_Foil", "Arrows", "Array",
        "Pattern_Bars", "Pattern_Bars_Half", "Pattern_Bars_Band",
        "Pattern_Half", "Pattern_Cone", "Pattern_Squares",
        "Nozzle_2", "Nozzle_3",
        "A USA",
        "SV_S1_Flag", "SV_S1_USA", "SV_S2", "SV_S3"
    ],
    shape_tex: [
        "Flat", "Flat Smooth", "Flat Smooth 4", "Flat Faces",
        "Edges Thin", "Edges Thin Top", "Edges thin Bottom",
        "Edges Faces", "Edges Faces Top", "Edges Faces Bottom", "Edges Smooth",
        "Rivets", "Half Rivets", "Strut", "Strut 2", "Strut 3",
        "Fairing", "Fairing Edges", "Interstage",
        "Nozzle_4", "Metal Bands", "RA Capsule 1", "RA Capsule 2"
    ]
};
function strCandidates(name) { return STR_CANDIDATES[name] || []; }

function strListOf(part) {
    if (!partAlive(part)) return null;
    var off = findFieldDeep(G.partCls, "variablesModule");
    if (off <= 0) return null;
    var vm = part.add(off).readPointer();
    if (!plausiblePtr(vm)) return null;
    var sl = vm.add(STR_OFF).readPointer();
    return plausiblePtr(sl) ? sl : null;
}

function readStrTable(part) {
    try {
        var sl = strListOf(part);
        if (!sl) return null;
        var sc = G.fn.object_get_class(sl);
        if (!mStrGetDict) mStrGetDict = findMethodByName(sc, "GDNBKJPJMEI", 0);
        if (!mStrGetDict) { log("[STR] 找不到 GetSaveDictionary"); return null; }
        var dict = invoke(mStrGetDict, sl, []);
        if (!plausiblePtr(dict)) return null;
        var dk = G.fn.object_get_class(dict);
        var mCnt = findMethodByName(dk, "get_Count", 0);
        var mKeys = findMethodByName(dk, "get_Keys", 0);
        if (!mStrGetItem) mStrGetItem = findMethodByName(dk, "get_Item", 1);
        if (!mCnt || !mKeys || !mStrGetItem) return null;
        var cnt = pickInt(invoke(mCnt, dict, []));
        if (cnt <= 0) return { names: [], values: [] };
        var scls = strClass();
        if (!scls) return null;
        var keys = invoke(mKeys, dict, []);
        if (!plausiblePtr(keys)) return null;
        var mCopy = findMethodByName(G.fn.object_get_class(keys), "CopyTo", 2);
        if (!mCopy) return null;
        var zz = Memory.alloc(8); zz.writeS32(0);
        var arr = G.fn.array_new(scls, cnt);
        invoke(mCopy, keys, [arr, zz]);
        var names = [], values = [];
        for (var i = 0; i < cnt && i < 40; i++) {
            var sp = arr.add(0x20).add(i * 8).readPointer();
            if (sp.isNull()) continue;
            names.push(jstr(sp));
            var rv = invoke(mStrGetItem, dict, [sp]);
            var stp = (rv && !rv.isNull()) ? rv.add(0x10).readPointer() : ptr(0);
            values.push(plausiblePtr(stp) ? jstr(stp) : "");
        }
        return { names: names, values: values };
    } catch (e) { log("[STR] 读取异常: " + e); return null; }
}

function writeStrVar(part, name, val) {
    try {
        var sl = strListOf(part);
        if (!sl) { log("[STR] 取不到 string 列表"); return false; }
        if (!mStrSetValue) mStrSetValue = findMethodByName(G.fn.object_get_class(sl), "AGPHHELNDPF", 3);
        if (!mStrSetValue) { log("[STR] 找不到 SetValue"); return false; }
        /* 字符串是引用类型 → 参数数组里直接放指针；空串按 null（还原默认外观） */
        var sp2 = (val === null || val === "") ? ptr(0) : cstr(val);
        var tup = Memory.alloc(8); tup.writeU8(1); tup.add(1).writeU8(1);
        invoke(mStrSetValue, sl, [cstr(name), sp2, tup]);
        try { if (G.mRegen && !G.mRegen.isNull()) invoke(G.mRegen, part, []); } catch (e) { }
        try { if (G.adaptM && !G.adaptM.isNull()) invoke(G.adaptM, ptr(0), [part]); } catch (e) { }
        return true;
    } catch (e) { log("[STR] 写入异常: " + e); return false; }
}

/* ================= Burn Marks 探测 =================
 * 参考 SFSPlayer-sys/BurnEditor。功能 = 发动机喷焰在部件上的烧灼痕迹，
 * 可调 Burn Angle / Burn Intensity / Burn X（Top/Bottom 是曲面编码文本，用户明确不要）。
 * 关键调用链（来自参考的 ApplyBurnEffect）：
 *   burnMark = part.burnMark   (SFS.Parts.Modules.BurnMark，可为 null)
 *   若为 null → part.gameObject.AddComponent<BurnMark>() + Initialize()
 *   save = new BurnMark.BurnSave { angle, intensity, x, top="", bottom="" }
 *   burnMark.burn = save.FromSave()      // 把字符串解码成 Line2[] 曲面
 *   burnMark.SetOpacity(1f, true); burnMark.ApplyEverything();
 * 另外参考还挂了 PartSave 构造函数的 Postfix 去写 __instance.burns ——
 * 说明游戏不会自动从 burnMark 反推存档，必须自己插进去，否则存不进蓝图。 */
function dumpFieldsOf(k, tag, max, recurseSave) {
    if (!k || k.isNull()) { log("[BURN] " + tag + " = null"); return; }
    log("[BURN] === " + tag + "  " + partAliveWhyType(k) + " ===");
    var it = Memory.alloc(Process.pointerSize); it.writePointer(ptr(0));
    var f, n = 0;
    while ((f = G.fn.class_get_fields(k, it)) && !f.isNull() && n < (max || 40)) {
        var off = 0, nm = "?", tp = "", tptr = null;
        try { off = G.fn.field_get_offset(f); } catch (e) { }
        try { nm = G.fn.field_get_name(f).readUtf8String(); } catch (e) { }
        try {
            tptr = G.fn.field_get_type(f);
            if (tptr && !tptr.isNull()) tp = G.fn.type_get_name(tptr).readUtf8String();
        } catch (e) { }
        log("[BURN]    +0x" + off.toString(16) + "  " + tp + "  " + nm);
        /* 只对名字里带 Save 的类型继续下钻，用来找到 BurnSave 的字段布局 */
        if (recurseSave && tptr && !tptr.isNull() && tp.indexOf("Save") >= 0) {
            try {
                var ck = G.fn.class_from_type(tptr);
                if (ck && !ck.isNull()) dumpFieldsOf(ck, tag + "." + nm, 20, false);
            } catch (e) { }
        }
        n++;
    }
}

function dumpBurnTypes() {
    log("[BURN] Part.burnMark 偏移 = " + findFieldDeep(G.partCls, "burnMark"));
    var img = null;
    try { img = G.fn.class_get_image(G.partCls); } catch (e) { }
    log("[BURN] Part 所在 image = " + img);

    var bmCls = null;
    try {
        bmCls = G.fn.class_from_name(img, Memory.allocUtf8String("SFS.Parts.Modules"),
                                     Memory.allocUtf8String("BurnMark"));
    } catch (e) { }
    log("[BURN] BurnMark 类 = " + bmCls);
    if (plausiblePtr(bmCls)) {
        dumpFieldsOf(bmCls, "BurnMark 字段", 40, true);
        /* BurnMark 的方法（要 Initialize / ApplyEverything / SetOpacity） */
        var cx = bmCls, dep = 0;
        while (!cx.isNull() && dep < 5) {
            var i2 = Memory.alloc(Process.pointerSize); i2.writePointer(ptr(0));
            var m, k2 = 0;
            while ((m = G.fn.cls_get_methods(cx, i2)) && !m.isNull() && k2 < 40) {
                var mn = "?", pc = 0;
                try { mn = G.fn.mth_get_name(m).readUtf8String(); } catch (e) { }
                try { pc = G.fn.mth_get_pc(m); } catch (e) { }
                log("[BURN]    方法[" + dep + "] " + mn + "/" + pc);
                k2++;
            }
            cx = G.fn.cls_get_parent(cx);
            dep++;
        }
    }

    /* PartSave：先按常见命名空间试，都拿不到就报出来 */
    var nsList = ["SFS.Parts", "SFS.Parts.Modules", "SFS", ""];
    for (var i = 0; i < nsList.length; i++) {
        var c = null;
        try {
            c = G.fn.class_from_name(img, Memory.allocUtf8String(nsList[i]),
                                     Memory.allocUtf8String("PartSave"));
        } catch (e) { }
        if (plausiblePtr(c)) {
            log("[BURN] PartSave 命中：命名空间 \"" + nsList[i] + "\"  " + c);
            log("[BURN]   burns 偏移 = " + findFieldDeep(c, "burns"));
            dumpFieldsOf(c, "PartSave 字段", 40, true);
            var cm = G.fn.method_from_name(c, Memory.allocUtf8String(".ctor"), 1);
            log("[BURN]   PartSave..ctor/1 = " + cm);
            return;
        }
    }
    log("[BURN] PartSave 未在候选命名空间中找到");
}

/* 无过滤地把一个类（含父类链）的字段全打出来。
 * 上一版我自作聪明加了"字段类型名含 Save 才下钻"的条件，结果正好漏掉了
 *   Burn（名字不含 Save），只探到一半。这次不做任何筛选。 */
function dumpClsDeep(k, tag) {
    if (!k || k.isNull()) { log("[BURN2] " + tag + " = null"); return; }
    var cx = k, dep = 0;
    while (!cx.isNull() && dep < 6) {
        var nm = "", ns = "";
        try { nm = G.fn.cls_get_name(cx).readUtf8String(); } catch (e) { }
        try { ns = G.fn.cls_get_ns(cx).readUtf8String(); } catch (e) { }
        log("[BURN2] " + tag + "  类[" + dep + "] = " + cx + "   " + ns + "." + nm);
        var it = Memory.alloc(Process.pointerSize); it.writePointer(ptr(0));
        var f, n = 0;
        while ((f = G.fn.class_get_fields(cx, it)) && !f.isNull() && n < 40) {
            var off = 0, fn = "?", ft = "";
            try { off = G.fn.field_get_offset(f); } catch (e) { }
            try { fn = G.fn.field_get_name(f).readUtf8String(); } catch (e) { }
            try {
                var tp = G.fn.field_get_type(f);
                if (tp && !tp.isNull()) ft = G.fn.type_get_name(tp).readUtf8String();
            } catch (e) { }
            log("[BURN2]      +0x" + off.toString(16) + "  " + ft + "  " + fn);
            n++;
        }
        cx = G.fn.cls_get_parent(cx);
        dep++;
    }
}

function dumpMethodSig(cls, name, argc, tag) {
    try {
        var m = G.fn.method_from_name(cls, Memory.allocUtf8String(name), argc);
        if (!m || m.isNull()) { log("[BURN2] " + tag + " " + name + "/" + argc + " 未找到"); return; }
        var ret = "?";
        try {
            var rt = G.fn.mth_get_ret(m);
            if (rt && !rt.isNull()) ret = G.fn.type_get_name(rt).readUtf8String();
        } catch (e) { }
        var pars = [];
        for (var q = 0; q < argc; q++) {
            try {
                var pt = G.fn.mth_get_param(m, q);
                pars.push((pt && !pt.isNull()) ? G.fn.type_get_name(pt).readUtf8String() : "?");
            } catch (e) { pars.push("?"); }
        }
        log("[BURN2] " + tag + " " + name + "/" + argc + "  (" + pars.join(", ") + ")  ->  " + ret);
    } catch (e) { log("[BURN2] " + tag + " " + name + " 签名异常: " + e); }
}

function dumpBurnDeep() {
    var img = null;
    try { img = G.fn.class_get_image(G.partCls); } catch (e) { }

    /* ---------- A. PartSave.burns 的类型 ---------- */
    var psCls = null;
    try {
        psCls = G.fn.class_from_name(img, Memory.allocUtf8String("SFS.Parts"),
                                     Memory.allocUtf8String("PartSave"));
    } catch (e) { }
    log("[BURN2] ===== A. PartSave = " + psCls + " =====");
    if (plausiblePtr(psCls)) {
        var bf = null;
        try { bf = G.fn.class_get_field(psCls, Memory.allocUtf8String("burns")); } catch (e) { }
        log("[BURN2] burns 字段 = " + bf);
        if (bf && !bf.isNull()) {
            try { log("[BURN2] burns 偏移 = 0x" + G.fn.field_get_offset(bf).toString(16)); } catch (e) { }
            var bt = null;
            try { bt = G.fn.field_get_type(bf); } catch (e) { }
            log("[BURN2] burns 类型指针 = " + bt);
            if (bt && !bt.isNull()) {
                var bc = null;
                try { bc = G.fn.class_from_type(bt); } catch (e) { }
                dumpClsDeep(bc, "BurnSave(字段类型)");
                /* 备用路径：按名字直接找（嵌套类型有时要靠这条路） */
                var alt = null;
                try {
                    alt = G.fn.class_from_name(img, Memory.allocUtf8String("SFS.Parts.Modules"),
                                               Memory.allocUtf8String("BurnSave"));
                } catch (e) { }
                if (plausiblePtr(alt) && (!bc || alt.compare(bc) !== 0)) dumpClsDeep(alt, "BurnSave(按名字)");
            }
        }
    }

    /* ---------- B. BurnMark.burn 的类型 + 关键方法签名 ---------- */
    var bmCls = null;
    try {
        bmCls = G.fn.class_from_name(img, Memory.allocUtf8String("SFS.Parts.Modules"),
                                     Memory.allocUtf8String("BurnMark"));
    } catch (e) { }
    log("[BURN2] ===== B. BurnMark = " + bmCls + " =====");
    if (plausiblePtr(bmCls)) {
        var bu = null;
        try { bu = G.fn.class_get_field(bmCls, Memory.allocUtf8String("burn")); } catch (e) { }
        if (bu && !bu.isNull()) {
            var ut = null;
            try { ut = G.fn.field_get_type(bu); } catch (e) { }
            if (ut && !ut.isNull()) {
                var uc = null;
                try { uc = G.fn.class_from_type(ut); } catch (e) { }
                dumpClsDeep(uc, "Burn(字段类型)");
            }
        }
        dumpMethodSig(bmCls, "SetBurn", 6, "BurnMark");
        dumpMethodSig(bmCls, "SetOpacity", 2, "BurnMark");
        dumpMethodSig(bmCls, "ApplyEverything", 0, "BurnMark");
        dumpMethodSig(bmCls, "Initialize", 0, "BurnMark");
    }
}

/* 把一个类（含父类链）的方法全打出来 */
function dumpMethodsOf(k, tag, max) {
    if (!k || k.isNull()) { log("[BURN3] " + tag + " = null"); return; }
    var cx = k, dep = 0;
    while (!cx.isNull() && dep < 5) {
        var nm = "", ns = "";
        try { nm = G.fn.cls_get_name(cx).readUtf8String(); } catch (e) { }
        try { ns = G.fn.cls_get_ns(cx).readUtf8String(); } catch (e) { }
        log("[BURN3] " + tag + " 类[" + dep + "] " + ns + "." + nm);
        var it = Memory.alloc(Process.pointerSize); it.writePointer(ptr(0));
        var m, n = 0;
        while ((m = G.fn.cls_get_methods(cx, it)) && !m.isNull() && n < (max || 40)) {
            var mn = "?", pc = 0, ret = "?", pars = [];
            try { mn = G.fn.mth_get_name(m).readUtf8String(); } catch (e) { }
            try { pc = G.fn.mth_get_pc(m); } catch (e) { }
            try {
                var rt = G.fn.mth_get_ret(m);
                if (rt && !rt.isNull()) ret = G.fn.type_get_name(rt).readUtf8String();
            } catch (e) { }
            for (var q = 0; q < pc && q < 8; q++) {
                try {
                    var pt = G.fn.mth_get_param(m, q);
                    pars.push((pt && !pt.isNull()) ? G.fn.type_get_name(pt).readUtf8String() : "?");
                } catch (e) { pars.push("?"); }
            }
            log("[BURN3]    [" + dep + "] " + mn + "/" + pc
                + "  (" + pars.join(", ") + ")  ->  " + ret);
            n++;
        }
        cx = G.fn.cls_get_parent(cx);
        dep++;
    }
}

function dumpBurnFinal() {
    var img = null;
    try { img = G.fn.class_get_image(G.partCls); } catch (e) { }

    /* BurnSave：重点是找 FromSave（参考 mod 靠它把字符串曲面解码成 Line2[]） */
    var psCls = null;
    try {
        psCls = G.fn.class_from_name(img, Memory.allocUtf8String("SFS.Parts"),
                                     Memory.allocUtf8String("PartSave"));
    } catch (e) { }
    if (plausiblePtr(psCls)) {
        var bf = G.fn.class_get_field(psCls, Memory.allocUtf8String("burns"));
        if (bf && !bf.isNull()) {
            var bt = G.fn.field_get_type(bf);
            if (bt && !bt.isNull()) {
                var bc = G.fn.class_from_type(bt);
                log("[BURN3] ===== BurnSave 方法表 =====");
                dumpMethodsOf(bc, "BurnSave", 30);
                var fs = null;
                try {
                    fs = G.fn.method_from_name(bc, Memory.allocUtf8String("FromSave"), 0);
                } catch (e) { }
                log("[BURN3] BurnSave.FromSave/0 = " + fs);
            }
        }
    }

    /* Burn：看有没有可直接用的构造/赋值入口 */
    var bmCls = null;
    try {
        bmCls = G.fn.class_from_name(img, Memory.allocUtf8String("SFS.Parts.Modules"),
                                     Memory.allocUtf8String("BurnMark"));
    } catch (e) { }
    if (plausiblePtr(bmCls)) {
        var bu = G.fn.class_get_field(bmCls, Memory.allocUtf8String("burn"));
        if (bu && !bu.isNull()) {
            var ut = G.fn.field_get_type(bu);
            if (ut && !ut.isNull()) {
                var uc = G.fn.class_from_type(ut);
                log("[BURN3] ===== Burn 方法表 =====");
                dumpMethodsOf(uc, "Burn", 30);
            }
        }
    }
}

/* ================= Burn Marks 实现（第一批：只做底层写入） =================
 * 不接 UI，用一个固定测试值触发，每一步都打日志，便于定位是哪一环断的。 */
var burnMarkCls = null, burnCls = null, burnSaveCls = null;
var mBurnFromSave = null, mBurnSetOpacity = null, mBurnApplyAll = null, mBurnInit = null, goAddComp = null;

function burnResolveClasses() {
    if (burnMarkCls && !burnMarkCls.isNull()) return true;
    var img = null;
    try { img = G.fn.class_get_image(G.partCls); } catch (e) { return false; }
    try {
        burnMarkCls = G.fn.class_from_name(img, Memory.allocUtf8String("SFS.Parts.Modules"),
                                           Memory.allocUtf8String("BurnMark"));
    } catch (e) { }
    if (!plausiblePtr(burnMarkCls)) { log("[BURN4] 取不到 BurnMark 类"); return false; }
    try {
        var bf = G.fn.class_get_field(burnMarkCls, Memory.allocUtf8String("burn"));
        burnCls = G.fn.class_from_type(G.fn.field_get_type(bf));
        var psCls = G.fn.class_from_name(img, Memory.allocUtf8String("SFS.Parts"),
                                         Memory.allocUtf8String("PartSave"));
        var psf = G.fn.class_get_field(psCls, Memory.allocUtf8String("burns"));
        burnSaveCls = G.fn.class_from_type(G.fn.field_get_type(psf));
    } catch (e) { log("[BURN4] 解析类型异常: " + e); }
    if (!plausiblePtr(burnSaveCls)) { log("[BURN4] 取不到 BurnSave 类"); return false; }
    try { mBurnFromSave = G.fn.method_from_name(burnSaveCls, Memory.allocUtf8String("MGNDIANAJJH"), 0); } catch (e) { }
    try { mBurnSetOpacity = G.fn.method_from_name(burnMarkCls, Memory.allocUtf8String("SetOpacity"), 2); } catch (e) { }
    try { mBurnApplyAll = G.fn.method_from_name(burnMarkCls, Memory.allocUtf8String("ApplyEverything"), 0); } catch (e) { }
    try { mBurnInit = G.fn.method_from_name(burnMarkCls, Memory.allocUtf8String("Initialize"), 0); } catch (e) { }
    try {
        var goCls = G.fn.class_from_name(img, Memory.allocUtf8String("UnityEngine"),
                                         Memory.allocUtf8String("GameObject"));
        if (plausiblePtr(goCls)) goAddComp = G.fn.method_from_name(goCls, Memory.allocUtf8String("AddComponent"), 1);
    } catch (e) { }
    log("[BURN4] 类型解析：BurnMark=" + burnMarkCls + "  Burn=" + burnCls + "  BurnSave=" + burnSaveCls);
    log("[BURN4] 方法解析：FromSave=" + mBurnFromSave + "  SetOpacity=" + mBurnSetOpacity
        + "  ApplyEverything=" + mBurnApplyAll + "  Initialize=" + mBurnInit
        + "  AddComponent=" + goAddComp);
    return true;
}

/* 把 angle/intensity/x 应用到部件的烧灼痕迹上。返回是否成功。 */
function burnApply(part, angle, intensity, x) {
    if (!partAlive(part)) { log("[BURN4] 部件不可用"); return false; }
    if (!burnResolveClasses()) return false;
    try {
        /* ① 取 burnMark */
        var bm = part.add(0x78).readPointer();
        log("[BURN4] ① burnMark = " + bm);
        if (!plausiblePtr(bm)) {
            /* 需要新建组件：gameObject.AddComponent(BurnMark) —— 参数要传 System.Type 反射对象 */
            var go = invoke(G.mGetGO, part, []);
            log("[BURN4] ② gameObject = " + go);
            if (!plausiblePtr(go)) { log("[BURN4] ② 取不到 gameObject"); return false; }
            /* ★ GameObject 在 UnityEngine.CoreModule 里，用游戏自身 image 的
             *   class_from_name("UnityEngine","GameObject") 找不到，所以从对象本身反推它的类。 */
            if (!goAddComp || goAddComp.isNull()) {
                try {
                    var goClsNow = G.fn.object_get_class(go);
                    goAddComp = G.fn.method_from_name(goClsNow, Memory.allocUtf8String("AddComponent"), 1);
                    log("[BURN4] ② GameObject 类 = " + goClsNow + "  AddComponent/1 = " + goAddComp);
                } catch (e) { log("[BURN4] ② 反推 AddComponent 异常: " + e); }
            }
            if (!goAddComp || goAddComp.isNull()) { log("[BURN4] ② 没有 AddComponent/1"); return false; }
            var tpObj = G.fn.type_get_object(G.fn.cls_get_type(burnMarkCls));
            log("[BURN4] ② Type 反射对象 = " + tpObj);
            if (!plausiblePtr(tpObj)) { log("[BURN4] ② 取不到 Type 对象"); return false; }
            var comp = invoke(goAddComp, go, [tpObj]);
            log("[BURN4] ② AddComponent 结果 = " + comp);
            if (!plausiblePtr(comp)) { log("[BURN4] ② AddComponent 失败"); return false; }
            part.add(0x78).writePointer(comp);
            bm = comp;
        }
        /* ③ 造 BurnSave 并填值（top/bottom 留空串） */
        var sv = G.fn.object_new(burnSaveCls);
        log("[BURN4] ③ BurnSave 对象 = " + sv);
        if (!plausiblePtr(sv)) { log("[BURN4] ③ object_new 失败"); return false; }
        sv.add(0x10).writeFloat(angle);
        sv.add(0x14).writeFloat(intensity);
        sv.add(0x18).writeFloat(x);
        sv.add(0x20).writePointer(cstr(""));
        sv.add(0x28).writePointer(cstr(""));
        /* ④ FromSave() → 运行时 Burn */
        if (!mBurnFromSave || mBurnFromSave.isNull()) { log("[BURN4] ④ 没有 FromSave"); return false; }
        var bu = invoke(mBurnFromSave, sv, []);
        log("[BURN4] ④ FromSave() -> Burn = " + bu);
        if (!plausiblePtr(bu)) { log("[BURN4] ④ FromSave 返回空（空曲面？）"); return false; }
        /* ⑤ 赋值 + 初始化 */
        bm.add(0x20).writePointer(bu);
        log("[BURN4] ⑤ burn 已写入");
        if (mBurnInit && !mBurnInit.isNull()) { try { invoke(mBurnInit, bm, []); } catch (e) { } }
        /* ⑥ SetOpacity(1.0, true) —— 两个值类型参数，各传"指向值的指针" */
        if (!mBurnSetOpacity || mBurnSetOpacity.isNull()) { log("[BURN4] ⑥ 没有 SetOpacity"); return false; }
        var pf = Memory.alloc(4); pf.writeFloat(1.0);
        var pb = Memory.alloc(1); pb.writeU8(1);
        invoke(mBurnSetOpacity, bm, [pf, pb]);
        log("[BURN4] ⑥ SetOpacity(1.0,true) 完成");
        /* ⑦ ApplyEverything */
        if (!mBurnApplyAll || mBurnApplyAll.isNull()) { log("[BURN4] ⑦ 没有 ApplyEverything"); return false; }
        invoke(mBurnApplyAll, bm, []);
        log("[BURN4] ⑦ ApplyEverything 完成 —— 底层链路走通");
        return true;
    } catch (e) { log("[BURN4] 异常: " + e); return false; }
}

/* ================= Burn Marks（第二批：持久化到蓝图） =================
 * 参考 mod 的做法是挂 PartSave 的构造函数，在 Postfix 里写 __instance.burns。
 * 我这里不自己维护参数表，而是【直接从部件当前的 burnMark.burn 反推】——
 * 这样不管参数是怎么改上去的（我们的 UI、别的 mod、游戏本身），都能正确保存。
 * BurnSave..ctor/1(Burn) 就是现成的"运行时 → 存档"转换构造。 */
var mPartSaveCtor = null, mBurnSaveCtorFromBurn = null;

function installBurnSaveHook() {
    if (!burnResolveClasses()) { log("[BURN5] 类型解析失败，钩子未安装"); return false; }
    try {
        var img = G.fn.class_get_image(G.partCls);
        var psCls = G.fn.class_from_name(img, Memory.allocUtf8String("SFS.Parts"),
                                         Memory.allocUtf8String("PartSave"));
        if (!plausiblePtr(psCls)) { log("[BURN5] 取不到 PartSave 类"); return false; }
        mPartSaveCtor = G.fn.method_from_name(psCls, Memory.allocUtf8String(".ctor"), 1);
        if (!mPartSaveCtor || mPartSaveCtor.isNull()) { log("[BURN5] 找不到 PartSave..ctor/1"); return false; }
        mBurnSaveCtorFromBurn = G.fn.method_from_name(burnSaveCls, Memory.allocUtf8String(".ctor"), 1);
        log("[BURN5] PartSave..ctor/1 = " + mPartSaveCtor.readPointer()
            + "   BurnSave..ctor/1 = " + mBurnSaveCtorFromBurn);
        Interceptor.attach(mPartSaveCtor.readPointer(), {
            onEnter: function (args) {
                try {
                    if (G.shuttingDown) return;
                    this.psObj = args[0];
                    this.partObj = args[1];
                } catch (e) { }
            },
            onLeave: function () {
                try {
                    if (G.shuttingDown) return;
                    var ps = this.psObj, pt = this.partObj;
                    if (!plausiblePtr(ps) || !plausiblePtr(pt)) return;
                    var bm = pt.add(0x78).readPointer();
                    if (!plausiblePtr(bm)) return;
                    var bu = bm.add(0x20).readPointer();
                    if (!plausiblePtr(bu)) return;
                    var sv = G.fn.object_new(burnSaveCls);
                    if (!plausiblePtr(sv)) { log("[BURN5] object_new 失败"); return; }
                    if (mBurnSaveCtorFromBurn && !mBurnSaveCtorFromBurn.isNull()) {
                        invoke(mBurnSaveCtorFromBurn, sv, [bu]);
                    }
                    ps.add(0x48).writePointer(sv);
                    var tp = sv.add(0x20).readPointer(), bp = sv.add(0x28).readPointer();
                    log("[BURN5] burns 已写入 PartSave=" + ps
                        + "  angle=" + sv.add(0x10).readFloat()
                        + " intensity=" + sv.add(0x14).readFloat()
                        + " x=" + sv.add(0x18).readFloat()
                        + " top=" + (tp.isNull() ? "null" : ("\"" + jstr(tp) + "\""))
                        + " bottom=" + (bp.isNull() ? "null" : ("\"" + jstr(bp) + "\"")));
                } catch (e) { log("[BURN5] onLeave 异常: " + e); }
            }
        });
        log("[+] BurnSave 持久化钩子已安装");
        return true;
    } catch (e) { log("[BURN5] 安装异常: " + e); return false; }
}

/* 读出部件当前的烧灼痕迹参数。没有痕迹时返回默认值（x 默认 0.3，与参考实现一致）。 */
function burnRead(part) {
    var out = { angle: 0, intensity: 0, x: 0.3, has: false };
    try {
        if (!partAlive(part)) return out;
        var bm = part.add(0x78).readPointer();
        if (!plausiblePtr(bm)) return out;
        var bu = bm.add(0x20).readPointer();
        if (!plausiblePtr(bu)) return out;
        out.angle = bu.add(0x10).readFloat();
        out.intensity = bu.add(0x14).readFloat();
        out.x = bu.add(0x18).readFloat();
        out.has = true;
    } catch (e) { }
    return out;
}

/* 清除烧灼痕迹（对应参考实现里 angle==0 && intensity==0 的分支） */
function burnClear(part) {
    try {
        if (!partAlive(part)) return false;
        var bm = part.add(0x78).readPointer();
        if (!plausiblePtr(bm)) return true;      // 本来就没有
        if (!burnResolveClasses()) return false;
        if (mBurnSetOpacity && !mBurnSetOpacity.isNull()) {
            var pf = Memory.alloc(4); pf.writeFloat(0.0);
            var pb = Memory.alloc(1); pb.writeU8(1);
            invoke(mBurnSetOpacity, bm, [pf, pb]);
        }
        bm.add(0x20).writePointer(ptr(0));
        log("[BURN] 已清除烧灼痕迹（部件 " + part + "）");
        return true;
    } catch (e) { log("[BURN] 清除异常: " + e); return false; }
}

/* 各 Burn 参数的范围与步进 */
function burnScaler(name) {
    if (name === "angle") return { min: 0, max: 360, step: 15, dec: 0 };
    if (name === "intensity") return { min: 0, max: 1.5, step: 0.05, dec: 2 };
    return { min: 0, max: 2, step: 0.01, dec: 2 };        // x
}

/* 读一个模块对象上的数值属性。
 * 目标部件（比如油箱）的 width_a / width_b / height_a / height_b 这类值，
 * 不在 VariablesModule 的变量列表里（实测默认部件三个列表全空），
 * 而是挂在具体模块上（如 SFS.Parts.Modules.SimplePipe / CustomPipe）。 */
function readModuleProps(mod) {
    var out = [];
    if (!plausiblePtr(mod)) return out;
    var k = G.fn.object_get_class(mod);
    if (k.isNull()) return out;
    var it = Memory.alloc(Process.pointerSize); it.writePointer(ptr(0));
    var f, n = 0;
    while ((f = G.fn.class_get_fields(k, it)) && !f.isNull() && n < 60) {
        var off = G.fn.field_get_offset(f);
        if (off > 0) {
            try {
                var nm = G.fn.field_get_name(f).readUtf8String();
                var v = mod.add(off).readPointer();
                if (plausiblePtr(v)) {
                    var vc = G.fn.object_get_class(v);
                    var cn = partAliveWhyType(vc);
                    if (/(Composed_Float|Float_Local|Float_Reference|Single_Reference|Double_Reference|Float_Variable)$/.test(cn)) {
                        /* 实测：Composed_Float 直接把 +0x10 当 float 读出来全是 0.000，
                         *   所以它的值不在固定偏移。这里把它的字段摊开（名称/类型/该偏移的 f32），
                         *   同时扫 +0x10..+0x40 找第一个"非零且有限"的浮点当候选值。 */
                        var dbg = [], cand = null, co = -1;
                        try {
                            /* 必须沿父类链走：il2cpp_class_get_fields 只返回该类
                             *   **自己声明**的字段，Composed_Float 真正持值的 value
                             *   字段在父类里，只看本类会漏掉。 */
                            var cc = vc, dep = 0;
                            while (!cc.isNull() && dep < 8) {
                                dbg.push("-- 类[" + dep + "] " + partAliveWhyType(cc) + " 的字段 --");
                                var i2 = Memory.alloc(Process.pointerSize); i2.writePointer(ptr(0));
                                var g, m = 0;
                                while ((g = G.fn.class_get_fields(cc, i2)) && !g.isNull() && m < 14) {
                                    var go = G.fn.field_get_offset(g);
                                    if (go > 0) {
                                        var gn = "?", gt = "";
                                        try { gn = G.fn.field_get_name(g).readUtf8String(); } catch (e) { }
                                        try {
                                            var tp = G.fn.field_get_type(g);
                                            if (tp && !tp.isNull()) gt = G.fn.type_get_name(tp).readUtf8String();
                                        } catch (e) { }
                                        var fv = NaN, fp = ptr(0);
                                        try { fv = v.add(go).readFloat(); } catch (e) { }
                                        try { fp = v.add(go).readPointer(); } catch (e) { }
                                        dbg.push("+0x" + go.toString(16).padStart(2, "0") + " " + gt + " " + gn
                                            + "  f32=" + (isFinite(fv) ? fv.toFixed(4) : "?")
                                            + "  ptr=" + fp);
                                    }
                                    m++;
                                }
                                cc = G.fn.cls_get_parent(cc);
                                dep++;
                            }
                        } catch (e) { }
                        for (var q = 0x10; q <= 0x40; q += 4) {
                            var qv = v.add(q).readFloat();
                            if (isFinite(qv) && Math.abs(qv) > 1e-9 && Math.abs(qv) < 1e6) { cand = qv; co = q; break; }
                        }
                        out.push({ name: nm, cls: cn, value: (cand === null ? 0 : cand),
                                   off: co, debug: dbg, vo: v, modOff: off });
                    }
                }
            } catch (e) { }
        }
        n++;
    }
    return out;
}

var pollTick = 0;
var dbgSel = -99, dbgTick = 0, whyLogN = 0;
function pollMainThread() {
    if (G.shuttingDown) return;
    pollTick++;
    /* 节流从 12 降到 4（约 15 Hz）。
     * 原来约 4~5 Hz，快速"框选→取消框选"会整个漏掉中间状态，
     * 表现就是"修改器比实际操作慢一步"。 */
    if (pollTick % 4 !== 0) return;
    dbgTick++;
    if (dbgTick % 120 === 0) log("[HB] 心跳 tick=" + dbgTick + "  (HoldGrid.Update 正在被调用)");
    /* 锁存对象失效（被销毁 / 复制重建）就立刻丢弃，避免拿野指针去调托管方法 */
    if (G.lastPart) {
        var w2 = partAliveWhy(G.lastPart);
        if (w2 !== "") {
            log("[SEL] 锁存部件已失效(" + w2 + ")，清除");
            G.lastPart = null;
        }
    }
    /* 择来源优先级：
     *   ① 托管读取（selCount / selPartManaged）—— 权威，能正确反映"取消选中/改选别的部件"
     *   ② OnPartClick 钩子 —— 点按时立即生效
     *   ③ 手写槽位扫描 —— 已证明不可靠，只在①②都拿不到时做最后兜底
     * 关键：托管读取失败（null）时**不覆盖**已有锁存，免得把本来能用的点选功能弄坏；
     *       只有拿到权威结果时才改写锁存 —— 这正是修掉"取消 A 后指针仍停在 A"的地方。 */
    var sc = selCount();
    if (sc !== G.lastSelCount) {
        G.lastSelCount = sc;
        log("[SEL] 选中数量 = " + (sc < 0 ? "读不到" : sc));
    }
    if (sc > 1) {
        if (G.lastPart) log("[SEL] 多选(" + sc + " 个) → 收起 PART 面板，不显示任何部件属性");
        G.lastPart = null;
        G.zeroCnt = 0;
        dbgSel = 0;
        G.live.has = false;
        G.uiDirty = true;
        return;
    }
    if (sc === 0) {
        /* ★ 集合确实为空（取消框选 / 点空白结束框选）——必须清掉锁存。
         * 原来这里没有分支，于是"取消框选后 selPartManaged() 返回 null"被当成
         * "读取失败"，锁存被保留，目标就停在旧部件上、PART 区也永远不关。
         * 做两次连续确认，避免刚点选时读到瞬时 0 把刚锁存的目标误清。 */
        G.zeroCnt = (G.zeroCnt || 0) + 1;
        if (G.zeroCnt >= 2) {
            if (G.lastPart) log("[SEL] 选中数量=0（连续 2 次确认）→ 清空目标，收起 PART 面板");
            G.lastPart = null;
            dbgSel = 0;
            G.live.has = false;
            G.uiDirty = true;
            return;
        }
    } else {
        G.zeroCnt = 0;
    }
    var mp = selPartManaged();
    if (mp) {
        if (!G.lastPart || !G.lastPart.equals(mp)) {
            log("[SEL] 托管读取到当前选中部件 " + mp + "（数量=" + sc + "）→ 目标切换");
        }
        G.lastPart = mp;
    }
    /* 兜底：只有托管读取失败、且当前没有锁存时才用（这条路径已知不可靠） */
    var r = (!mp && !G.lastPart) ? readSelectionRaw() : null;
    if (r && r.part) {
        var why = partAliveWhy(r.part);
        if (why === "") { G.lastPart = r.part; G.lastCount = r.count; }
        else if (!G.badSel || !G.badSel.equals(r.part)) {
            G.badSel = r.part;
            log("[SEL] (兜底通道)取出的对象不可用: " + r.part + " 原因=" + why);
        }
    }

    var part = G.lastPart;
    if (!part || part.isNull()) {
        if (dbgSel !== 0) { dbgSel = 0; log("[SEL] 未选中部件 → 面板收起"); }
        G.live.has = false; return;
    }
    if (dbgSel !== 1 || !G.live.part || !G.live.part.equals(part)) {
        dbgSel = 1;
        log("[SEL] 当前部件 " + part + (mp ? "（托管读取）" : "（钩子锁存）"));
    }
    if (!G.live.part || !G.live.part.equals(part)) {
        // 部件变了：做一次托管调用取名字与坐标
        G.live.part = part;
        G.live.name = "";
        G.live.pos = "";
        G.uiDirty = true;      // 立刻把新部件的面板刷出来
        /* 换了部件：三个小抽屉都收起，避免上一个部件的展开状态串到新部件。
         * （G.drawers / G.bigDrawer 由 buildUI 挂上；UI 还没建好时为空数组） */
        var dlist = G.drawers || [];
        for (var rd = 0; rd < dlist.length; rd++) {
            var dd = dlist[rd];
            if (G.bigDrawer && dd === G.bigDrawer) continue;   // 大抽屉保持用户当前状态
            dd.open = false;
            try {
                cVis(dd.box, 8);
                cTxt(dd.head, "\u25B8 " + dd.title);
            } catch (e) { }
        }
        try {
            var go = invoke(G.mGetGO, part, []);
            if (go !== null && !go.isNull()) G.live.name = jstr(invoke(G.mGetName, go, []));
        } catch (e) { }
        try {
            var v2 = readPosition(part);
            if (v2) G.live.pos = v2.x.toFixed(2) + ", " + v2.y.toFixed(2);
        } catch (e) { }

        /* 需求①：读目标部件的"数值属性"。
         * 蓝图里的 width_original / width_a / width_b / height 不在部件的变量列表里
         * （实测默认部件三个变量列表全空），而是挂在具体模块上，所以从被点中的模块读。 */
        G.live.props = [];
        try {
            /* 正式通道：变量列表（GetSaveDictionary），这是蓝图 "N" 的数据源，
             *   写回去能存进蓝图。旧的"读形状模块 Composed_Float"已废弃。 */
            var vt = readVarTable(part);
            if (vt && vt.names.length) {
                for (var vi2 = 0; vi2 < vt.names.length; vi2++) {
                    G.live.props.push({
                        name: vt.names[vi2],
                        value: (isFinite(vt.values[vi2]) ? vt.values[vi2] : 0)
                    });
                }
                var s2 = "";
                for (var qi2 = 0; qi2 < G.live.props.length; qi2++) {
                    s2 += "  " + G.live.props[qi2].name + "=" + G.live.props[qi2].value.toFixed(4);
                }
                log("[VAR] 部件参数:" + s2);
            } else {
                log("[VAR] 该部件的 doubleVariables 为空或读取失败");
            }
        } catch (e) { log("[VAR] 取参数异常: " + e); }

        /* Bool 变量（开关形式） */
        G.live.bools = [];
        try {
            var bt = readBoolTable(part);
            if (bt && bt.names.length) {
                for (var bi = 0; bi < bt.names.length; bi++) {
                    G.live.bools.push({ name: bt.names[bi], value: !!bt.values[bi] });
                }
                var bstr = "";
                for (var bi2 = 0; bi2 < G.live.bools.length; bi2++) {
                    bstr += "  " + G.live.bools[bi2].name + "=" + G.live.bools[bi2].value;
                }
                log("[BOOL] 部件开关:" + bstr);
            }
        } catch (e) { log("[BOOL] 取开关异常: " + e); }

        /* String 变量（条纹/纹理名：color_tex / shape_tex） */
        G.live.strs = [];
        try {
            var st2 = readStrTable(part);
            if (st2 && st2.names.length) {
                for (var si = 0; si < st2.names.length; si++) {
                    G.live.strs.push({ name: st2.names[si], value: st2.values[si] || "" });
                }
                var sstr = "";
                for (var si2 = 0; si2 < G.live.strs.length; si2++) {
                    sstr += "  " + G.live.strs[si2].name + "=\"" + G.live.strs[si2].value + "\"";
                }
                log("[STR] 部件条纹:" + sstr);
            }
        } catch (e) { log("[STR] 取条纹异常: " + e); }
        try {
            /* 优先用点击钩子给出的模块；框选建立选中时它为空，就从部件自身解析 */
            var useMod = G.lastModule;
            if (!plausiblePtr(useMod) || G.modPart === null || !G.modPart.equals(part)) {
                var fm = findShapeModule(part);
                if (fm) { useMod = fm; G.lastModule = fm; G.modPart = part; }
            }
            var pr = [];
            if (pr.length) {
                /* 诊断输出：把每个变量对象的字段布局摊开，用来确定值到底存在哪个偏移。
                 * 确定之后这段会简化成只显示数值。 */
                for (var qi = 0; qi < pr.length; qi++) {
                    log("[PROP] " + pr[qi].name + "  类=" + pr[qi].cls
                        + "  猜测值@" + (pr[qi].off >= 0 ? ("0x" + pr[qi].off.toString(16)) : "无")
                        + "=" + pr[qi].value.toFixed(4));
                    for (var di = 0; di < pr[qi].debug.length; di++) log("        " + pr[qi].debug[di]);
                }
            } else {
                log("[PROP] 模块上没有可读数值属性 (module=" + G.lastModule + ")");
            }

            /* 零风险自检（只在第一次选中部件时做一次）：
             *   把读到的值**原样**写回去并触发 onChange —— 不改变任何数据，
             *   只用来确认"写 value + 调 onChange"这条通道是否真的通。
             *   通过之后才值得把它接到滑条上。 */
            if (DEBUG_PROBES && !G.writeTested && pr.length) {
                G.writeTested = true;
                for (var ti = 0; ti < pr.length; ti++) {
                    var raw = pr[ti].vo.add(0x1c).readFloat();
                    var fired = writeVarValue(pr[ti].vo, raw, true);
                    log("[WRITE-TEST] " + pr[ti].name + "  当前值=" + raw.toFixed(4)
                        + "  原样写回 + onChange = " + (fired ? "✔ 通道通" : "✘ 未触发"));
                    /* 写回后隔一次采集再读一遍，看值有没有被守住 */
                    (function (e) {
                        setTimeout(function () {
                            try {
                                var back = e.vo.add(0x1c).readFloat();
                                log("[WRITE-TEST] " + e.name + " 1 秒后回读 = " + back.toFixed(4)
                                    + (Math.abs(back - e.value) < 1e-3 ? "  (值保持)" : "  (被改变/重算)"));
                            } catch (er) { }
                        }, 1000);
                    })({ vo: pr[ti].vo, name: pr[ti].name, value: raw });
                }
            }
        } catch (e) { log("[PROP] 读取异常: " + e); }

        /* 关键验证：把 GetSaveDictionary() 的键枚举出来。
         * 那些键就是蓝图 "N" 里的字段名（width_original / width_a / ...）。
         * 若默认部件这里为空，说明"默认值不存进字典"，那么界面就不能靠字典生成，
         * 需要另想办法拿合法变量名 —— 这个结果直接决定需求①怎么实现。 */
        if (DEBUG_PROBES && !G.dictDumped) {
            G.dictDumped = true;
            try {
                var vmd = part.add(findFieldDeep(G.partCls, "variablesModule")).readPointer();
                var dl = plausiblePtr(vmd) ? vmd.add(0x20).readPointer() : null;
                log("[DICT] doubleVariables = " + dl);
                if (plausiblePtr(dl)) {
                    var mGet = null, cxx = G.fn.object_get_class(dl), dd = 0;
                    while (!cxx.isNull() && dd++ < 6) {
                        var t = G.fn.method_from_name(cxx, Memory.allocUtf8String("GDNBKJPJMEI"), 0);
                        if (t && !t.isNull()) { mGet = t; break; }
                        cxx = G.fn.cls_get_parent(cxx);
                    }
                    log("[DICT] GetSaveDictionary 方法 = " + mGet);
                    if (mGet) {
                        var dict = invoke(mGet, dl, []);
                        log("[DICT] 字典对象 = " + dict);
                        if (plausiblePtr(dict)) {
                            var dk = G.fn.object_get_class(dict);
                            var mCnt = null, mKeys = null, c2 = dk, d3 = 0;
                            while (!c2.isNull() && d3++ < 6) {
                                if (!mCnt) mCnt = G.fn.method_from_name(c2, Memory.allocUtf8String("get_Count"), 0);
                                if (!mKeys) mKeys = G.fn.method_from_name(c2, Memory.allocUtf8String("get_Keys"), 0);
                                c2 = G.fn.cls_get_parent(c2);
                            }
                            var cnt = -1;
                            if (mCnt) {
                                var cr = invoke(mCnt, dict, []);
                                if (cr && !cr.isNull()) {
                                    /* 和 selCount() 一样：返回值装箱方式不统一，两路都试并做范围校验。
                                     *   （上一版这里直接 toInt32()，读出来是 -1736827104 这种垃圾值） */
                                    var cps = [cr.toInt32(), cr.add(0x10).readS32()];
                                    for (var ci = 0; ci < cps.length; ci++) {
                                        if (cps[ci] >= 0 && cps[ci] <= 100000) { cnt = cps[ci]; break; }
                                    }
                                    if (cnt < 0) {
                                        log("[DICT] Count 读取失败 raw=" + cr
                                            + "  toInt32=" + cr.toInt32()
                                            + "  +0x10=" + cr.add(0x10).readS32());
                                    }
                                }
                            }
                            log("[DICT] Count = " + cnt + "   （get_Keys=" + mKeys + "）");
                            /* System.String 在 mscorlib 里，用 cn("System","String") 找
                             * （那是从游戏自己的 image 里找）会失败。改从"真实的字符串对象"
                             * 反推它的类：部件的 GameObject 名字就是一个 Il2CppString。 */
                            if (!G.strCls || G.strCls.isNull()) {
                                try {
                                    var gop = invoke(G.mGetGO, part, []);
                                    if (gop && !gop.isNull()) {
                                        var nmp = invoke(G.mGetName, gop, []);
                                        if (nmp && !nmp.isNull()) G.strCls = G.fn.object_get_class(nmp);
                                    }
                                } catch (e) { }
                                log("[DICT] 反推 System.String 类 = " + G.strCls);
                            }
                            if (mKeys && cnt > 0 && G.strCls && !G.strCls.isNull()) {
                                var keys = invoke(mKeys, dict, []);
                                log("[DICT] KeyCollection = " + keys);
                                if (plausiblePtr(keys)) {
                                    var mCopy = null, c3 = G.fn.object_get_class(keys), d4 = 0;
                                    while (!c3.isNull() && d4++ < 6) {
                                        var t2 = G.fn.method_from_name(c3, Memory.allocUtf8String("CopyTo"), 2);
                                        if (t2 && !t2.isNull()) { mCopy = t2; break; }
                                        c3 = G.fn.cls_get_parent(c3);
                                    }
                                    if (mCopy) {
                                        var zz = Memory.alloc(8); zz.writeS32(0);
                                        var arr2 = G.fn.array_new(G.strCls, cnt);
                                        invoke(mCopy, keys, [arr2, zz]);
                                        for (var ai = 0; ai < cnt && ai < 40; ai++) {
                                            var sp = arr2.add(0x20).add(ai * 8).readPointer();
                                            log("[DICT] 键[" + ai + "] = " + (sp.isNull() ? "null" : jstr(sp)));
                                        }
                                    } else log("[DICT] KeyCollection 上没有 CopyTo");
                                }
                            }
                        }
                    }
                }
            } catch (e) { log("[DICT] 异常: " + e); }
        }

        /* 一次性探测：确认本版本里变量列表类的方法名。
         * 参考 Part Editor：正确通道是
         *     variablesModule.doubleVariables.GetSaveDictionary()   ← 键名就是蓝图 "N" 的字段
         *     variablesModule.doubleVariables.SetValue(name, value, (true,true))
         * 但在本版本（b713，类名/方法名混淆）里，这些方法名是否被改过需要实测确认。 */
        if (DEBUG_PROBES && !G.varApiDumped) {
            G.varApiDumped = true;
            try {
                var vmo = findFieldDeep(G.partCls, "variablesModule");
                var vmv = vmo > 0 ? part.add(vmo).readPointer() : null;
                if (plausiblePtr(vmv)) {
                    ["doubleVariables", "boolVariables", "stringVariables"].forEach(function (fn) {
                        try {
                            var fo = findFieldDeep(G.fn.object_get_class(vmv), fn);
                            if (fo <= 0) { log("[API] " + fn + " 字段未找到"); return; }
                            var lst = vmv.add(fo).readPointer();
                            log("[API] " + fn + " @" + ("0x" + fo.toString(16)) + " = " + lst);
                            if (!plausiblePtr(lst)) return;
                            var lc = G.fn.object_get_class(lst), cx = lc, dep = 0;
                            while (!cx.isNull() && dep < 5) {
                                var i9 = Memory.alloc(Process.pointerSize); i9.writePointer(ptr(0));
                                var m9, k9 = 0;
                                while ((m9 = G.fn.cls_get_methods(cx, i9)) && !m9.isNull() && k9 < 40) {
                                    var n9 = "?", p9 = 0, rt9 = "?", pa9 = [];
                                    try { n9 = G.fn.mth_get_name(m9).readUtf8String(); } catch (e) { }
                                    try { p9 = G.fn.mth_get_pc(m9); } catch (e) { }
                                    /* 用"参数类型 + 返回类型"来给混淆方法定身份：
                                     *   返回 Dictionary<string,double> 的那个必然是 GetSaveDictionary()。 */
                                    try {
                                        var rtp = G.fn.mth_get_ret(m9);
                                        if (rtp && !rtp.isNull()) rt9 = G.fn.type_get_name(rtp).readUtf8String();
                                    } catch (e) { }
                                    for (var pi9 = 0; pi9 < p9; pi9++) {
                                        try {
                                            var ptp = G.fn.mth_get_param(m9, pi9);
                                            if (ptp && !ptp.isNull()) pa9.push(G.fn.type_get_name(ptp).readUtf8String());
                                        } catch (e) { pa9.push("?"); }
                                    }
                                    log("[API]    [" + dep + "] " + n9 + "/" + p9
                                        + "  (" + pa9.join(", ") + ")  ->  " + rt9);
                                    k9++;
                                }
                                cx = G.fn.cls_get_parent(cx);
                                dep++;
                            }
                        } catch (e) { log("[API] " + fn + " 探测异常: " + e); }
                    });
                } else log("[API] 取不到 variablesModule");
            } catch (e) { log("[API] 异常: " + e); }
        }

        /* 前 5 次选中部件各 dump 一次（不是只 dump 一次）——
         * 因为不确定哪一类部件才有 Bool / String 项，这样才能多试几种。
         * 只打日志，不碰界面逻辑。 */
        if (DEBUG_PROBES && (G.dumpCount || 0) < 5) {
            G.dumpCount = (G.dumpCount || 0) + 1;
            log("[DUMP] ---- 第 " + G.dumpCount + " 次 dump ----");
            try { dumpAllVarLists(part); } catch (e) { log("[DUMP] 异常: " + e); }
            try { harvestStrings(part); } catch (e) { log("[STR] 异常: " + e); }
            /* 一次性：Burn Marks 相关类型探测（BurnMark / BurnSave / PartSave） */
            if (!G.burnDumped) {
                G.burnDumped = true;
                try { dumpBurnTypes(); } catch (e) { log("[BURN] 异常: " + e); }
                try { dumpBurnDeep(); } catch (e) { log("[BURN2] 异常: " + e); }
                try { dumpBurnFinal(); } catch (e) { log("[BURN3] 异常: " + e); }
                /* Burn Marks：读出当前值填进 UI（不再写死测试值） */
                try {
                    G.live.burn = burnRead(part);
                    log("[BURN6] burnMark(=0x" + (G.live.burn.has ? "有" : "无") + ")  angle="
                        + G.live.burn.angle + " intensity=" + G.live.burn.intensity
                        + " x=" + G.live.burn.x);
                } catch (e) { log("[BURN6] 读取异常: " + e); }
            }        }

        /* 一次性：列出 VariablesModule 的方法，找"写入部件参数"的 API。
         * 为什么必须找这个：Composed_Float 是**表达式驱动**的
         * （字段 input 是 System.String，compiled 是委托），直接写内存里的值
         * 会被下一帧的表达式重算覆盖。只有走游戏自己的通道才能既改值又触发重算。 */
        if (DEBUG_PROBES && !G.varsDumped) {
            G.varsDumped = true;
            try {
                var vo = findFieldDeep(G.partCls, "variablesModule");
                var vm = vo > 0 ? part.add(vo).readPointer() : null;
                log("[VARS] variablesModule@" + vo + " = " + vm);
                if (plausiblePtr(vm)) {
                    var vcl = G.fn.object_get_class(vm);
                    var cx = vcl, d2 = 0;
                    while (!cx.isNull() && d2 < 6) {
                        log("[VARS] 类[" + d2 + "] " + partAliveWhyType(cx));
                        var i3 = Memory.alloc(Process.pointerSize); i3.writePointer(ptr(0));
                        var mm, k2 = 0;
                        while ((mm = G.fn.cls_get_methods(cx, i3)) && !mm.isNull() && k2 < 40) {
                            var mn = "?";
                            try { mn = G.fn.mth_get_name(mm).readUtf8String(); } catch (e) { }
                            var pc = 0;
                            try { pc = G.fn.mth_get_pc(mm); } catch (e) { }
                            log("[VARS]    " + mn + "/" + pc);
                            k2++;
                        }
                        cx = G.fn.cls_get_parent(cx);
                        d2++;
                    }
                }
            } catch (e) { log("[VARS] 异常: " + e); }
        }
    }
    // temperature 是 Part 上的普通 float（@0xa0）
    try { G.live.temp = part.add(0xa0).readFloat(); } catch (e) { G.live.temp = NaN; }
    var o = orientObjOf(part);
    if (o) {
        G.live.x = o.add(0x10).readFloat();
        G.live.y = o.add(0x14).readFloat();
        G.live.z = o.add(0x18).readFloat();
    }
    var d = densityObsOf(part);
    if (d) G.live.density = d.add(0x10).readFloat();
    // Position 需要托管调用；降低频率（每 5 次采集读一次 ≈ 1 秒）
    if (pollTick % 60 === 0) {
        var v2 = readPosition(part);
        if (v2) { G.live.px = v2.x; G.live.py = v2.y; }
    }
    /* 周期性重读参数值。
     * 为什么必须做：G.live.props 原先只在"切换部件"时读一次，于是
     *   ① width_a / width_b 这种被 width_original 影响的派生值不会自动更新，
     *      要手动刷新才变（Part Editor 里是自动跟上的）；
     *   ② 拖完 fuel_percent 后，面板拿的还是旧值 → 滑条弹回 100%，
     *      而油箱实际燃料并没有变回去。
     * 只重读值（get_Item），不重建界面，开销很小。 */
    if (G.live.has && G.live.props.length && (pollTick % 24 === 0)) {
        try {
            var vt2 = readVarTable(part);
            if (vt2 && vt2.names.length) {
                for (var ri = 0; ri < G.live.props.length; ri++) {
                    for (var ni = 0; ni < vt2.names.length; ni++) {
                        if (vt2.names[ni] === G.live.props[ri].name) {
                            if (isFinite(vt2.values[ni])) G.live.props[ri].value = vt2.values[ni];
                            break;
                        }
                    }
                }
            }
        } catch (e) { }
    }

    G.live.has = true;
}

function writeOrientation(x, y, z) {
    var part = G.live.part;
    if (!part || part.isNull()) return;
    var o = orientObjOf(part);
    if (!o) return;
    o.add(0x10).writeFloat(x);
    o.add(0x14).writeFloat(y);
    o.add(0x18).writeFloat(z);
    var om = part.add(G.partOrientOff).readPointer();
    invoke(G.mApplyOrient, om, []);
}

/* Density 滑条已按需求移除。
 * 这里保留说明：Part.density @+0x50 是 Float_Local（真实值在 +0x10），
 * 但这个字段是"裸写不生效"的 —— 直接改内存不会触发游戏重算质量/配平，
 * 必须走它的 onChange 链路。所以即使以后要加回来，也不能只改内存。
 * 相关辅助函数 densityObsOf() / G.live.density 仍保留（只读，用于诊断）。 */

/* set_Position(Vector2)：结构体参数按指针放进参数数组 */
function writePosition(x, y) {
    var part = G.live.part;
    if (!partAlive(part)) return;
    if (!G.mSetPos || G.mSetPos.isNull()) return;
    try {
        var v = Memory.alloc(8);
        v.writeFloat(x);
        v.add(4).writeFloat(y);
        invoke(G.mSetPos, part, [v]);
        invoke(G.mRegen, part, []);
        G.live.px = x; G.live.py = y;
    } catch (e) { log("[POS] write err " + e); }
}

/* ========================================================== 旋转步长 / 网格吸附 */

function installRotateHook() {
    if (G.rotHooked) return true;
    if (!G.menuClass || G.menuClass.isNull()) return false;
    var m = G.fn.method_from_name(G.menuClass, Memory.allocUtf8String("Rotate"), 1);
    if (!m || m.isNull()) { log("[-] Rotate 未找到"); return false; }
    var fp = m.readPointer();
    if (fp.isNull()) return false;
    Interceptor.attach(fp, {
        onEnter: function () {
            try {
                if (G.shuttingDown) return;
                if (!G.rotHookOn) return;
                var orig = this.context.s0;
                if (!isFinite(orig) || Math.abs(orig) < 1e-6) return;
                this.context.s0 = (orig < 0 ? -1 : 1) * G.rotStep;
            } catch (e) { }
        }
    });
    G.rotHooked = true;
    log("[+] Rotate 钩子 @" + fp + "  步长=" + G.rotStep);
    return true;
}

function installDragSnapHook() {
    if (G.snapHooked) return true;
    if (!G.dragClass || G.dragClass.isNull()) return false;
    var helper = null;
    try {
        var mAd = G.fn.method_from_name(G.dragClass, Memory.allocUtf8String("ADGCOCNILCO"), 1);
        if (mAd && !mAd.isNull()) {
            var p = mAd.readPointer(), lastHalf = -1;
            for (var i = 0; i < 2000; i++) {
                var ins;
                try { ins = Instruction.parse(p); } catch (e) { break; }
                if (ins.mnemonic === "fmov" && /^s2, #0\.50000000$/.test(ins.opStr)) lastHalf = i;
                if (ins.mnemonic === "bl" && lastHalf >= 0 && (i - lastHalf) <= 4) { helper = ptr(parseInt(ins.opStr.replace(/^#/, ""), 16)); break; }
                p = ins.next;
            }
        }
    } catch (e) { log("[!] 推导吸附函数失败: " + e); }
    if (!helper) { log("[-] 未找到共享吸附函数"); return false; }
    Interceptor.attach(helper, {
        onEnter: function () {
            try {
                if (G.shuttingDown) return;
                if (!G.snapOn) return;
                var g = this.context.s2;
                if (isFinite(g) && Math.abs(g - 0.5) < 1e-4) this.context.s2 = G.snapStep;
            } catch (e) { }
        }
    });
    G.snapHooked = true;
    log("[+] Grid Snap 钩子 @" + helper);
    return true;
}

/* 用 HoldGrid.Update 当"主线程心跳"，在里面安全地读选中部件 */
function installTickHook() {
    if (!G.dragClass || G.dragClass.isNull()) return false;
    var m = G.fn.method_from_name(G.dragClass, Memory.allocUtf8String("Update"), 0);
    if (!m || m.isNull()) { log("[-] HoldGrid.Update 未找到"); return false; }
    Interceptor.attach(m.readPointer(), {
        onEnter: function () { try { pollMainThread(); } catch (e) { } }
    });
    log("[+] 主线程心跳钩子 (HoldGrid.Update)");

    /* 诊断/兜底：游戏自己的"点击部件"回调。
     * 实测点选时这个回调一定会触发，而且参数很可能就是 Part —— 直接拿它当选择结果，
     * 比从 HashSet 内部槽位里扒指针可靠得多。 */
    if (G.menuClass && !G.menuClass.isNull()) {
        var mc = G.fn.method_from_name(G.menuClass, Memory.allocUtf8String("OnPartClick"), 1);
        if (mc && !mc.isNull()) {
            Interceptor.attach(mc.readPointer(), {
                onEnter: function (args) {
                    try {
                        if (G.shuttingDown) return;
                        var p = args[1];
                        if (!p || p.isNull()) return;
                        var k = G.fn.object_get_class(p);
                        var isPart = isPartClass(k);
                        var nm = partAliveWhyType(k);
                        clickN++;
                        if (clickN <= 6) log("[CLICK] OnPartClick #" + clickN + "  arg=" + p + "  类型=" + nm + "  isPart=" + isPart);

                        /* 核心修复：不再依赖 HashSet 内部布局。
                         * 实测（本版本 b713）OnPartClick 的闭包参数布局：
                         *    +0x10  SFS.Parts.Part   GCKHBKIAAKL   ← 就是被点击的部件
                         *    +0x18  PolygonData      HGGGFFPMKDF
                         * 所以优先直读 +0x10；万一该字段为空，再退回到"按类型递归搜索"。
                         * 顺序很重要：递归搜索会先命中 +0x10 之外的 Part
                         *   （实测 4 次不同的点击都返回同一个指针，那是共享闭包里的部件，
                         *    不是被点中的那个），所以必须把 +0x10 放在最前面。 */
                        var found = null, src = "";
                        if (isPart) { found = p; src = "回调参数本身"; }
                        if (!found) {
                            try {
                                var v10 = p.add(0x10).readPointer();
                                if (plausiblePtr(v10) && isPartClass(G.fn.object_get_class(v10))) {
                                    found = v10; src = "参数 +0x10";
                                }
                            } catch (e) { }
                        }
                        if (!found) {
                            found = findPartInObject(p, 0);
                            if (found) src = "参数成员按类型搜索(兜底)";
                        }

                        if (clickN <= 2 && !isPart) dumpObjFields(p, "OnPartClick 参数", 2);

                        if (found) {
                            var w = partAliveWhy(found);
                            if (w === "") {
                                /* 顺带记下被点中的"模块"（闭包 +0x18）——
                                 * 油箱的 width_a / width_b / height_a / height_b
                                 * 就挂在这类模块上（SimplePipe / CustomPipe）。 */
                                var modu = null;
                                try {
                                    var v18 = p.add(0x18).readPointer();
                                    if (plausiblePtr(v18)) modu = v18;
                                } catch (e) { }
                                G.lastPart = found;
                                G.lastModule = modu;
                                G.clickPart = found;
                                G.clickTick = pollTick;
                                G.clickTime = Date.now();
                                G.uiDirty = true;      // 让 UI 立刻刷出来，不等最长 600ms 的定时器
                                log("[CLICK] #" + clickN + " ✔ 识别到部件 " + found + " (来源=" + src + ")"
                                    + "  模块=" + modu + (modu ? ("(" + partAliveWhyType(G.fn.object_get_class(modu)) + ")") : ""));
                            } else log("[CLICK] #" + clickN + " ✘ 找到候选 " + found + " 但不可用: " + w);
                        } else {
                            log("[CLICK] #" + clickN + " ✘ 参数里没找到任何 Part 类型对象");
                        }
                    } catch (e) { log("[CLICK] 异常: " + e); }
                }
            });
            log("[+] OnPartClick 钩子 @" + mc.readPointer());
        } else log("[-] OnPartClick 未找到");

        // 点空白 → 清除锁存（面板收起）
        var me = G.fn.method_from_name(G.menuClass, Memory.allocUtf8String("OnEmptyClick"), 0);
        if (me && !me.isNull()) {
            Interceptor.attach(me.readPointer(), {
                /* 点空白 → 清除选中（面板收起）。
                 * 但是实测"点击部件"这一下之后，游戏紧接着也会调一次 OnEmptyClick，
                 *   如果直接清除，面板会闪一下就消失（用户看到的就是"识别不到"）。
                 *   所以加一个时间窗：刚发生过 OnPartClick 就忽略这次的 OnEmptyClick。 */
                onEnter: function () {
                    try {
                        if (G.shuttingDown) return;
                        var dt = Date.now() - (G.clickTime || 0);
                        if (dt < 600) return;
                        if (G.lastPart) log("[SEL] OnEmptyClick → 清除选中");
                        G.lastPart = null;
                    } catch (e) { }
                }
            });
            log("[+] OnEmptyClick 钩子 @" + me.readPointer());
        } else log("[-] OnEmptyClick 未找到");

        /* 复制部件：SFS 会销毁/重建部件对象，旧指针失效。
         * 这里在复制动作开始时清掉锁存，下一轮从选择集合重新取（通常新部件会被选中）。 */
        try {
            var gridCls = G.fn.class_from_name(G.image, Memory.allocUtf8String("SFS.Builds"), Memory.allocUtf8String("XLWLMWADJSNARUWV"));
            if (!gridCls.isNull()) {
                var md = G.fn.method_from_name(gridCls, Memory.allocUtf8String("Duplicate"), 0);
                if (md && !md.isNull()) {
                    Interceptor.attach(md.readPointer(), {
                        onEnter: function () {
                            try {
                                if (G.shuttingDown) return;
                                G.lastPart = null;
                                log("[SEL] Duplicate → 清除锁存，等待新部件");
                            } catch (e) { }
                        }
                    });
                    log("[+] Duplicate 钩子 @" + md.readPointer());
                } else log("[-] Duplicate 未找到");
            }
        } catch (e) { log("[!] Duplicate 钩子失败: " + e); }
    }
    return true;
}
var clickN = 0;

/* ================================================================ 摄像机 */

var CAM_MIN_OFF = 0x28, CAM_MAX_OFF = 0x2c;

function camValid() {
    var c = G.camPtr;
    if (!c || c.isNull()) return false;
    try {
        var k = G.fn.object_get_class(c);
        return !k.isNull() && k.equals(G.camCtlClass);
    } catch (e) { return false; }
}

function readZoomLimits() {
    if (!camValid()) return null;
    var c = G.camPtr;
    return { min: c.add(CAM_MIN_OFF).readFloat(), max: c.add(CAM_MAX_OFF).readFloat() };
}

function setZoomLimits(mn, mx) {
    if (!camValid()) return false;
    var c = G.camPtr;
    c.add(CAM_MIN_OFF).writeFloat(mn);
    c.add(CAM_MAX_OFF).writeFloat(mx);
    return true;
}

/* 只在主线程调用（内部是托管调用） */
function acquireCam() {
    try {
        if (!G.camCtlClass || G.camCtlClass.isNull()) return null;
        var mFOOT = G.fn.method_from_name(G.objClass, Memory.allocUtf8String("FindObjectsOfType"), 1);
        if (!mFOOT || mFOOT.isNull()) return null;
        var ra = invoke(mFOOT, ptr(0), [G.fn.type_get_object(G.fn.cls_get_type(G.camCtlClass))]);
        if (ra === null || ra.add(0x18).readU32() < 1) return null;
        var p = ra.add(0x20).readPointer();
        if (p.isNull()) return null;
        G.camPtr = p;
        return p;
    } catch (e) { return null; }
}

/* --------------------------------------------------------------- UI 层 */

function buildUI() {
    Java.perform(function () {
        var act = null, found = [];
        try {
            Java.choose("android.app.Activity", {
                onMatch: function (a) { try { found.push(a); } catch (e) { } },
                onComplete: function () { }
            });
        } catch (e) { log("[-] Java.choose: " + e); }
        for (var i = 0; i < found.length; i++) {
            try {
                var pn = found[i].getPackageName();
                if (pn && pn.indexOf("StefMorojna") >= 0) { act = found[i]; break; }
            } catch (e) { }
        }
        if (act === null && found.length > 0) act = found[0];
        if (act === null) { log("[-] no Activity"); return; }

        Java.scheduleOnMainThread(function () {
            try {
                var JString = Java.use("java.lang.String");
                var LinearLayout = Java.use("android.widget.LinearLayout");
                var FrameLayout = Java.use("android.widget.FrameLayout");
                var ScrollView = Java.use("android.widget.ScrollView");
                var TextView = Java.use("android.widget.TextView");
var EditText = Java.use("android.widget.EditText");
var InputType = Java.use("android.text.InputType");
var BufferType = Java.use("android.widget.TextView$BufferType");
                var Button = Java.use("android.widget.Button");
                var SeekBar = Java.use("android.widget.SeekBar");
                var View = Java.use("android.view.View");
                var Gravity = Java.use("android.view.Gravity");
                var Color = Java.use("android.graphics.Color");
                var FLP = Java.use("android.widget.FrameLayout$LayoutParams");
                var LLP = Java.use("android.widget.LinearLayout$LayoutParams");

                function cInt(o, m, v) { o[m].overload('int').call(o, v); }
                function cFloat(o, m, v) { o[m].overload('float').call(o, v); }
                function cTxt(o, s) { o.setText.overload('java.lang.CharSequence').call(o, JString.$new(s)); }
/* EditText 上 setText 只有双参数重载 (CharSequence, BufferType)，
 *   用单参数的 cTxt 会报 "specified argument types do not match"。
 *   同时保留单参数兜底，以防某些机型/版本反过来。 */
function cTxtField(o, s) {
    try {
        o.setText.overload('java.lang.CharSequence', 'android.widget.TextView$BufferType')
            .call(o, JString.$new(s), BufferType.EDITABLE.value);
    } catch (e) {
        try { o.setText.overload('java.lang.CharSequence').call(o, JString.$new(s)); }
        catch (e2) { log("[UI] cTxtField 失败: " + e2); }
    }
}
                function cColor(o, hex) { o.setTextColor.overload('int').call(o, Color.parseColor(hex)); }
                function cAdd(p, c) { p.addView.overload('android.view.View').call(p, c); }
                function cAddLP(p, c, lp) { p.addView.overload('android.view.View', 'android.view.ViewGroup$LayoutParams').call(p, c, lp); }
                function cVis(o, v) { o.setVisibility.overload('int').call(o, v); }

                var ctx = act;
                var C_BG = Color.argb(255, 16, 18, 22);
                var C_GOLD = "#FFD54F", C_WHITE = "#FFFFFF", C_GREY = "#9E9E9E", C_CYAN = "#4DD0E1";

                /* ---------- 结构：FrameLayout > [LinearLayout(标题+ScrollView)] + 缩放手柄 ---------- */
                var holder = FrameLayout.$new(ctx);
                holder.setBackgroundColor(C_BG);

                var col = LinearLayout.$new(ctx);
                cInt(col, "setOrientation", 1);

                /* 标题栏 = [标题(可拖动)] + [✕ 关闭] ，关闭按钮永远可见不用滚动 */
                var header = LinearLayout.$new(ctx);
                cInt(header, "setOrientation", 0);
                header.setBackgroundColor(Color.argb(255, 30, 34, 40));

                var titleView = TextView.$new(ctx);
                cTxt(titleView, "\u2261  Blueprint Editer");
                cFloat(titleView, "setTextSize", 15.0);
                cColor(titleView, C_GOLD);
                titleView.setPadding.overload('int', 'int', 'int', 'int').call(titleView, 24, 14, 24, 14);

                var closeX = Button.$new(ctx);
                cTxt(closeX, "\u2715");
                /* HIDE 挪到标题栏，紧挨 ✕（原来在面板底部，要滚下去才能按到） */
                var hideB = Button.$new(ctx);
                cTxt(hideB, "HIDE");

                var lpTitle = LLP.$new(0, -2);
                lpTitle.weight.value = 1.0;
                cAddLP(header, titleView, lpTitle);
                cAdd(header, hideB);
                cAdd(header, closeX);

                /* 不用 ScrollView：它会对任何 ACTION_DOWN 返回 true，
                 *   导致整个面板矩形都在吞触摸，游戏收不到下面的点击。
                 *   换成普通 LinearLayout —— 只有控件本身（滑条/按钮）拦触摸，
                 *   控件之间的空白会穿透给游戏。 */
                var panel = LinearLayout.$new(ctx);
                cInt(panel, "setOrientation", 1);
                panel.setPadding.overload('int', 'int', 'int', 'int').call(panel, 30, 16, 30, 24);

                cAddLP(col, header, LLP.$new(-1, -2));
                cAddLP(col, panel, LLP.$new(-1, -2));
                cAddLP(holder, col, FLP.$new(-1, -1));

                var handle = View.$new(ctx);
                handle.setBackgroundColor(Color.argb(200, 77, 208, 225));
                var lpHandle = FLP.$new(60, 60);
                lpHandle.gravity.value = (Gravity.END.value | Gravity.BOTTOM.value);
                cAddLP(holder, handle, lpHandle);

                /* ---------- 控件工厂 ---------- */
                function head(txt, col2) {
                    var t = TextView.$new(ctx);
                    cTxt(t, txt); cFloat(t, "setTextSize", 14.0); cColor(t, col2);
                    cAdd(panel, t); return t;
                }
                function label(txt, sz) {
                    var t = TextView.$new(ctx);
                    cTxt(t, txt); cFloat(t, "setTextSize", sz || 12.0); cColor(t, C_WHITE);
                    cAdd(panel, t); return t;
                }
                function bar(maxp, prog) {
                    var b = SeekBar.$new(ctx);
                    cInt(b, "setMax", maxp);
                    cInt(b, "setProgress", prog);
                    cAdd(panel, b);
                    return b;
                }
                function btn(txt) {
                    var b = Button.$new(ctx);
                    cTxt(b, txt);
                    cAdd(panel, b);
                    return b;
                }
                /* 往指定的容器里加控件（上面三个工厂都是固定加到 panel 的） */
                function labelIn(parent, txt, sz) {
                    var t = TextView.$new(ctx);
                    cTxt(t, txt); cFloat(t, "setTextSize", sz || 12.0); cColor(t, C_WHITE);
                    cAdd(parent, t); return t;
                }
                function barIn(parent, maxp, prog) {
                    var b = SeekBar.$new(ctx);
                    cInt(b, "setMax", maxp);
                    cInt(b, "setProgress", prog);
                    cAdd(parent, b);
                    return b;
                }
                /* 数值输入行：标签  [‹]  [可直接输入的数值框]  [›] */
                var pendingArrows = [];      // clicker 创建前先登记，之后统一绑定
                var pendingFields = [];      // committer 创建前先登记，之后统一绑定
                function numRow(parent, labelText, tagStr) {
                    var row = LinearLayout.$new(ctx);
                    cInt(row, "setOrientation", 0);              // HORIZONTAL
                    var lb = TextView.$new(ctx);
                    cTxt(lb, labelText); cFloat(lb, "setTextSize", 12.0); cColor(lb, C_WHITE);
                    cAddLP(row, lb, LLP.$new(0, -2, 1.0));       // 占满剩余宽度
                    var bMinus = Button.$new(ctx); cTxt(bMinus, "\u2039");
                    var bPlus = Button.$new(ctx); cTxt(bPlus, "\u203A");
                    var val = EditText.$new(ctx);
                    cTxtField(val, "--"); cFloat(val, "setTextSize", 12.0); cColor(val, C_WHITE);
                    /* 数字输入：允许小数与负号；单行；居中 */
                    try {
                        cInt(val, "setInputType",
                            InputType.TYPE_CLASS_NUMBER.value
                            | InputType.TYPE_NUMBER_FLAG_DECIMAL.value
                            | InputType.TYPE_NUMBER_FLAG_SIGNED.value);
                        cInt(val, "setMaxLines", 1);
                        cInt(val, "setGravity", Gravity.CENTER.value);
                    } catch (e) { log("[UI] EditText 配置失败: " + e); }
                    cAdd(row, bMinus); cAddLP(row, val, LLP.$new(-2, -2)); cAdd(row, bPlus);
                    /* 输入框也带上 key（不带方向），提交时按同一个 key 分发；
                     * 失焦 / 按回车时提交。 */
                    try {
                        val.setTag.overload('java.lang.Object').call(val, JString.$new(tagStr));
                        if (committer) attachField(val, committer);
                        else pendingFields.push(val);
                    } catch (e) { log("[UI] 输入框绑定失败: " + e); }
                    /* 用 tag 记住"改哪一项、往哪个方向"，点击时在 Clicker 里统一分发 */
                    try {
                        bMinus.setTag.overload('java.lang.Object').call(bMinus, JString.$new(tagStr + "|-1"));
                        bPlus.setTag.overload('java.lang.Object').call(bPlus, JString.$new(tagStr + "|1"));
                    } catch (e) { log("[UI] setTag 失败: " + e); }
                    try {
                        if (clicker) {
                            bMinus.setOnClickListener.overload('android.view.View$OnClickListener').call(bMinus, clicker);
                            bPlus.setOnClickListener.overload('android.view.View$OnClickListener').call(bPlus, clicker);
                        } else {
                            /* clicker 还没创建（PART 的行比它先建），先登记，稍后统一绑 */
                            pendingArrows.push(bMinus); pendingArrows.push(bPlus);
                        }
                    } catch (e) { log("[UI] 箭头监听失败: " + e); }
                    cAdd(parent, row);
                    return { row: row, lab: lb, val: val, bMinus: bMinus, bPlus: bPlus };
                }

                /* ---------- 抽屉（可开合的分组） ----------
                 * 头部是一个整行的 Button，内容是一个 LinearLayout，默认 GONE。
                 * 头部用 tag "DRW:<id>" 标识，在 Clicker 里统一分发。 */
                var drawers = [];
                function drawer(parent, title, defaultOpen) {
                    var h = Button.$new(ctx);
                    cTxt(h, (defaultOpen ? "\u25BE " : "\u25B8 ") + title);
                    cAdd(parent, h);
                    var box = LinearLayout.$new(ctx);
                    cInt(box, "setOrientation", 1);
                    cVis(box, defaultOpen ? 0 : 8);
                    cAdd(parent, box);
                    var id = drawers.length;
                    var d = { id: id, head: h, box: box, title: title, open: !!defaultOpen };
                    drawers.push(d);
                    try {
                        h.setTag.overload('java.lang.Object').call(h, JString.$new("DRW:" + id));
                        if (clicker) h.setOnClickListener.overload('android.view.View$OnClickListener').call(h, clicker);
                        else pendingArrows.push(h);        // clicker 还没建好，稍后统一绑
                    } catch (e) { log("[UI] 抽屉头绑定失败: " + e); }
                    return d;
                }
                function toggleDrawer(id) {
                    var d = drawers[id];
                    if (!d) return;
                    d.open = !d.open;
                    cVis(d.box, d.open ? 0 : 8);
                    cTxt(d.head, (d.open ? "\u25BE " : "\u25B8 ") + d.title);   // ▾ / ▸
                }

                /* Bool 行：标签 + 一个开关按钮（点一下切换 开/关） */
                function boolRow(parent, labelText, tagStr) {
                    var row = LinearLayout.$new(ctx);
                    cInt(row, "setOrientation", 0);
                    var lb = TextView.$new(ctx);
                    cTxt(lb, labelText); cFloat(lb, "setTextSize", 12.0); cColor(lb, C_WHITE);
                    cAddLP(row, lb, LLP.$new(0, -2, 1.0));
                    var btn2 = Button.$new(ctx);
                    cTxt(btn2, "--");
                    cAddLP(row, btn2, LLP.$new(-2, -2));
                    try {
                        btn2.setTag.overload('java.lang.Object').call(btn2, JString.$new(tagStr));
                        if (clicker) btn2.setOnClickListener.overload('android.view.View$OnClickListener').call(btn2, clicker);
                        else pendingArrows.push(btn2);
                    } catch (e) { log("[UI] 开关绑定失败: " + e); }
                    cAdd(parent, row);
                    return { row: row, lab: lb, btn: btn2 };
                }

                /* ---------- PART ---------- */
                head("Part Editer", C_CYAN);
                var labPart = label("Select a part", 13.0);
                var labInfo = label("", 11.0);

                var DEF = {
                    px: { lo: 0.1, hi: 5.0, scale: 10, off: 0 },
                    py: { lo: 0.1, hi: 5.0, scale: 10, off: 0 },
                    pz: { lo: -180, hi: 180, scale: 1, off: 180 },
                    den: { lo: 0.1, hi: 8.0, scale: 20, off: 0 },
                    posx: { lo: 0, hi: 20, scale: 10, off: 0 },
                    posy: { lo: 0, hi: 100, scale: 10, off: 0 }
                };
                function maxOf(k) { var d = DEF[k]; return Math.round(d.hi * d.scale + d.off); }
                function toProg(k, v) { var d = DEF[k]; return Math.round(v * d.scale + d.off); }
                function toVal(k, p) { var d = DEF[k]; return (p - d.off) / d.scale; }

                /* PART 的位置 / 朝向也改成"标签 ‹ 数值 ›"（照 Part Editor 的样式）。
                 * 用一张描述表驱动，读值/写值各给一个闭包，避免再写一套重复逻辑。 */
                var partNumDefs = [
                    { lab: "X", step: 0.05, dec: 5,
                      get: function () { return G.live.px; },
                      set: function (v) { writePosition(v, G.live.py); } },
                    { lab: "Y", step: 0.05, dec: 5,
                      get: function () { return G.live.py; },
                      set: function (v) { writePosition(G.live.px, v); } },
                    { lab: "X", step: 0.05, dec: 5,
                      get: function () { return G.live.x; },
                      set: function (v) { G.live.x = v; writeOrientation(v, G.live.y, G.live.z); } },
                    { lab: "Y", step: 0.05, dec: 5,
                      get: function () { return G.live.y; },
                      set: function (v) { G.live.y = v; writeOrientation(G.live.x, v, G.live.z); } },
                    { lab: "Z", step: 0.5, dec: 5,
                      get: function () { return G.live.z; },
                      set: function (v) { G.live.z = v; writeOrientation(G.live.x, G.live.y, v); } }
                ];
                /* 大抽屉：PART 的全部属性内容都收在里面（默认展开，否则选中部件后一片空白） */
                var bigD = drawer(panel, "Part Editer", false);
                /* 小抽屉：位置 / 朝向 / Double 变量 */
                var posD = drawer(bigD.box, "Position");
                var orientD = drawer(bigD.box, "Orientation");
                var dblD = drawer(bigD.box, "Double 变量");
                var boolD = drawer(bigD.box, "Bool 变量");
                var strD = drawer(bigD.box, "String 变量");
                /* Burn Marks 抽屉（放在 String 变量 下面） */
                var burnD = drawer(bigD.box, "Burn Marks");
                var burnBox = burnD.box;
                var burnRows = {};        // "angle" / "intensity" / "x" -> {val}
                var burnOffBtn = null;
                (function () {
                    var defs = [["angle", "Burn Angle"], ["intensity", "Burn Intensity"], ["x", "Burn X"]];
                    for (var bi3 = 0; bi3 < defs.length; bi3++) {
                        try {
                            var nrB = numRow(burnBox, defs[bi3][1], "BURN:" + defs[bi3][0]);
                            burnRows[defs[bi3][0]] = { val: nrB.val, name: defs[bi3][0] };
                        } catch (e) { log("[UI] 建 Burn 行失败: " + e); }
                    }
                    try {
                        burnOffBtn = Button.$new(ctx);
                        cTxt(burnOffBtn, "Burn Off");
                        burnOffBtn.setTag.overload('java.lang.Object').call(burnOffBtn, JString.$new("BURNOFF:0"));
                        if (clicker) burnOffBtn.setOnClickListener
                            .overload('android.view.View$OnClickListener').call(burnOffBtn, clicker);
                        else pendingArrows.push(burnOffBtn);
                        cAdd(burnBox, burnOffBtn);
                    } catch (e) { log("[UI] 建 Burn Off 失败: " + e); }
                })();
                /* ★ pollMainThread 是顶层函数，看不到 buildUI 里的局部变量，
                 *   所以抽屉状态要挂到 G 上，否则切换部件时重置抽屉会静默失败。 */
                G.drawers = drawers;
                G.bigDrawer = bigD;
                G.boolDrawer = boolD;

                var partNumRows = [];
                for (var pd = 0; pd < partNumDefs.length; pd++) {
                    /* 前两项（Position X/Y）进 Position 抽屉，后三项进朝向抽屉 */
                    var hostBox = (pd < 2) ? posD.box : orientD.box;
                    var nrP = numRow(hostBox, partNumDefs[pd].lab, "PART:" + pd);
                    partNumRows.push({ def: partNumDefs[pd], nr: nrP });
                }
                /* Double 变量的内容容器就用 Double 抽屉的 box（动态行往里加） */
                var propBox = dblD.box;
                var propRows = [];       // [{name, lab, val, sc, row}]
                var propSig = "";        // 参数名集合的指纹，变了才重建
                var boolBox = boolD.box;
                var boolRows = [];       // [{name, row, btn}]
                var boolSig = "";
                var strBox = strD.box;
                var strRows = [];        // [{name, row, val}]
                var strSig = "";

                /* 没选中部件时：把大抽屉的头和内容一起藏起来，只留 "Select a part" */
                var partViews = [bigD.head, bigD.box];

                /* ---------- STEP ---------- */
                head("Global Rotation Degrees", C_CYAN);
                var labRot = label("Rotate step:  --");
                var barRot = bar(180, 90);
                var rotBtn = btn("ROT STEP: ON");

                /* ---------- GRID SNAP ---------- */
                head("Global Grid Snap", C_CYAN);
                var labSnap = label("Grid snap:  --");
                var barSnap = bar(100, 10);
                var snapBtn = btn("SNAP: ON");

                /* ---------- CAMERA ---------- */
                head("Camera Zoom Range", C_CYAN);
                var labCam = label("Zoom limit:  --");
                var camBtn = btn("ZOOM: UNLIMITED");

                /* ---------- 底部 ----------
                 * RELOAD 已按要求移除；HIDE 已挪到标题栏，所以这里不再需要底部行。
                 * toggle 是 HIDE 之后显示在左上角的小按钮，仍然要加进去。 */
                var toggle = Button.$new(ctx); cTxt(toggle, "Blueprint Editer"); cVis(toggle, 8);

                var sfx = "" + (Date.now() % 1000000);
                var uiTick = 0, uiErr = 0;

                /* ---------- 同步显示 ---------- */
                var syncing = false;
                var partShown = null;      // null = 还不确定，第一次刷新时设定
                function refreshPartLabels() {
                    var p = G.live;
                    // 整组显示 / 隐藏
                    if (partShown !== p.has) {
                        partShown = p.has;
                        for (var vi = 0; vi < partViews.length; vi++) cVis(partViews[vi], p.has ? 0 : 8);
                        /* 上面统一置成可见会把大抽屉的内容也放出来，
                         * 这里按它自己的开合状态纠正回去（用户收起过就保持收起） */
                        if (p.has) { try { cVis(bigD.box, bigD.open ? 0 : 8); } catch (e) { } }
                    }
                    if (!p.has) {
                        cTxt(labPart, "Select a part  (点击 / 框选一个部件)");
                        cTxt(labInfo, "");
                        return;
                    }
                    cTxt(labPart, p.name || "(part)");
                    cTxt(labInfo, "temp: " + (isFinite(p.temp) ? p.temp.toFixed(1) : "--")
                        + "   拖动标题栏移窗 \u00B7 右下角改大小");
                    /* PART 位置/朝向：数值框显示（不再有滑条位置要维护） */
                    for (var pv2 = 0; pv2 < partNumRows.length; pv2++) {
                        var d2 = partNumRows[pv2].def, cv2 = d2.get();
                        /* 正在输入的那一格不要覆盖，否则打字会被冲掉 */
                        try { if (partNumRows[pv2].nr.val.hasFocus()) continue; } catch (e) { }
                        cTxtField(partNumRows[pv2].nr.val, fmtNum(cv2, d2.dec));
                    }

                    /* 部件参数：名称集合变了才重建滑条（重建会先把旧行设成 GONE，
                     * 不占布局空间）。 */
                    var psig = "";
                    for (var pi = 0; pi < p.props.length; pi++) psig += p.props[pi].name + ";";
                    if (psig !== propSig) {
                        propSig = psig;
                        /* ★ 必须把"整行"从 propBox 里摘掉。
                         * 之前这里只隐藏 lab 并去隐藏一个已经不存在了的 bar 字段，
                         * 结果数值框和两个箭头全都留在界面上 —— 就是切换不同类部件时
                         * 那些"没有标签、只剩数字和箭头"的空白残留。
                         * 顺便清掉输入框的焦点监听（Frida 的 JNI 方法，别留悬挂引用）。 */
                        for (var pq = 0; pq < propRows.length; pq++) {
                            var orow = propRows[pq].row;
                            if (orow) {
                                try {
                                    propRows[pq].val.setOnFocusChangeListener
                                        .overload('android.view.View$OnFocusChangeListener')
                                        .call(propRows[pq].val, null);
                                } catch (e) { }
                                try {
                                    propRows[pq].val.setOnEditorActionListener
                                        .overload('android.widget.TextView$OnEditorActionListener')
                                        .call(propRows[pq].val, null);
                                } catch (e) { }
                                try { propBox.removeView.overload('android.view.View').call(propBox, orow); }
                                catch (e) { try { cVis(orow, 8); } catch (e2) { } }
                            }
                        }
                        propRows = [];
                        for (var pj = 0; pj < p.props.length; pj++) {
                            try {
                                var e2 = p.props[pj];
                                var nr2 = numRow(propBox, e2.name, "VAR:" + e2.name);
                                propRows.push({ name: e2.name, lab: nr2.lab, val: nr2.val,
                                                sc: varScaler(e2.name), row: nr2.row });
                            } catch (e3) { log("[UI] 建参数行失败: " + e3); }
                        }
                        /* Double 抽屉：该部件没有 Double 项时整组（含抽屉头）隐藏；
                         * 有的话按抽屉自身的开合状态显示。 */
                        try {
                            var hasDbl = (p.props.length > 0);
                            if (!hasDbl) {
                                dblD.open = false;
                                cVis(dblD.head, 8);
                                cVis(propBox, 8);
                                cTxt(dblD.head, "\u25B8 " + dblD.title);
                            } else {
                                cVis(dblD.head, 0);
                                cVis(propBox, dblD.open ? 0 : 8);
                            }
                        } catch (e) { }
                        if (propRows.length) log("[UI] 已建立 " + propRows.length + " 条部件参数滑条");
                    }

                    /* ---- Bool 抽屉：名字集合变了才重建开关行 ---- */
                    var bsg = "";
                    for (var q1 = 0; q1 < p.bools.length; q1++) bsg += p.bools[q1].name + ";";
                    if (bsg !== boolSig) {
                        boolSig = bsg;
                        for (var q2 = 0; q2 < boolRows.length; q2++) {
                            var brow = boolRows[q2].row;
                            if (brow) {
                                try {
                                    boolRows[q2].btn.setOnClickListener
                                        .overload('android.view.View$OnClickListener').call(boolRows[q2].btn, null);
                                } catch (e) { }
                                try { boolBox.removeView.overload('android.view.View').call(boolBox, brow); }
                                catch (e) { try { cVis(brow, 8); } catch (e2) { } }
                            }
                        }
                        boolRows = [];
                        for (var q3 = 0; q3 < p.bools.length; q3++) {
                            try {
                                var br3 = boolRow(boolBox, p.bools[q3].name, "BOOL:" + p.bools[q3].name);
                                boolRows.push({ name: p.bools[q3].name, row: br3.row, btn: br3.btn });
                            } catch (e4) { log("[UI] 建开关行失败: " + e4); }
                        }
                        if (boolRows.length) log("[UI] 已建立 " + boolRows.length + " 个开关");
                    }
                    /* 开关的显示值 + 抽屉显隐 */
                    for (var q4 = 0; q4 < boolRows.length && q4 < p.bools.length; q4++) {
                        cTxt(boolRows[q4].btn, p.bools[q4].value ? "ON" : "OFF");
                    }
                    try {
                        var hasBool = (p.bools.length > 0);
                        if (!hasBool) {
                            boolD.open = false;
                            cVis(boolD.head, 8); cVis(boolBox, 8);
                            cTxt(boolD.head, "\u25B8 " + boolD.title);
                        } else {
                            cVis(boolD.head, 0);
                            cVis(boolBox, boolD.open ? 0 : 8);
                        }
                    } catch (e) { }
                    /* ---- String 抽屉：条纹名，‹ › 循环候选 + 数值框可自由输入 ---- */
                    var ssg = "";
                    for (var w1 = 0; w1 < p.strs.length; w1++) ssg += p.strs[w1].name + ";";
                    if (ssg !== strSig) {
                        strSig = ssg;
                        for (var w2 = 0; w2 < strRows.length; w2++) {
                            var srow = strRows[w2].row;
                            if (srow) {
                                try {
                                    strRows[w2].val.setOnFocusChangeListener
                                        .overload('android.view.View$OnFocusChangeListener').call(strRows[w2].val, null);
                                } catch (e) { }
                                try {
                                    strRows[w2].val.setOnEditorActionListener
                                        .overload('android.widget.TextView$OnEditorActionListener').call(strRows[w2].val, null);
                                } catch (e) { }
                                try { strBox.removeView.overload('android.view.View').call(strBox, srow); }
                                catch (e) { try { cVis(srow, 8); } catch (e2) { } }
                            }
                        }
                        strRows = [];
                        for (var w3 = 0; w3 < p.strs.length; w3++) {
                            try {
                                var sr3 = numRow(strBox, p.strs[w3].name, "STR:" + p.strs[w3].name);
                                /* ★ numRow 默认是纯数字输入，条纹名是字母，必须改成文本输入 */
                                try {
                                    sr3.val.setInputType.overload('int')
                                        .call(sr3.val, InputType.TYPE_CLASS_TEXT.value);
                                } catch (e6) { log("[UI] 条纹框改文本输入失败: " + e6); }
                                strRows.push({ name: p.strs[w3].name, row: sr3.row, val: sr3.val });
                            } catch (e5) { log("[UI] 建条纹行失败: " + e5); }
                        }
                        if (strRows.length) log("[UI] 已建立 " + strRows.length + " 条条纹行");
                    }
                    for (var w4 = 0; w4 < strRows.length && w4 < p.strs.length; w4++) {
                        try {
                            if (strRows[w4].val.hasFocus()) continue;   // 正在输入就别覆盖
                        } catch (e) { }
                        cTxtField(strRows[w4].val,
                            p.strs[w4].value ? p.strs[w4].value : "(默认)");
                    }
                    try {
                        var hasStr = (p.strs.length > 0);
                        if (!hasStr) {
                            strD.open = false;
                            cVis(strD.head, 8); cVis(strBox, 8);
                            cTxt(strD.head, "\u25B8 " + strD.title);
                        } else {
                            cVis(strD.head, 0);
                            cVis(strBox, strD.open ? 0 : 8);
                        }
                    } catch (e) { }

                    /* Burn Marks：显示当前值 */
                    try {
                        var bbv = p.burn || { angle: 0, intensity: 0, x: 0.3 };
                        var bnames = ["angle", "intensity", "x"];
                        for (var q5 = 0; q5 < bnames.length; q5++) {
                            var rr5 = burnRows[bnames[q5]];
                            if (!rr5) continue;
                            try { if (rr5.val.hasFocus()) continue; } catch (e) { }
                            cTxtField(rr5.val, fmtNum(bbv[bnames[q5]], burnScaler(bnames[q5]).dec));
                        }
                    } catch (e) { }

                    /* 位置/朝向已改用数值框，这里不再同步滑条进度 */
                }
                function refreshOtherLabels() {
                    cTxt(labRot, "Rotate step:  " + G.rotStep.toFixed(1) + "\u00B0" + (G.rotHookOn ? "  [CUSTOM]" : "  [VANILLA]"));
                    cTxt(labSnap, "Grid snap:  " + G.snapStep.toFixed(2) + (G.snapOn ? "  [ON]" : "  [VANILLA 0.5]"));
                    var lim = readZoomLimits();
                    cTxt(labCam, lim === null ? "Zoom limit:  n/a"
                        : ("Zoom limit:  " + lim.min.toFixed(2) + " ~ " + lim.max.toFixed(2)
                            + (G.zoomUnlimited ? "  [UNLIMITED]" : "  [NORMAL]")));
                }
                function syncBars() {
                    var p = G.live;
                    syncing = true;
                    try {
                        if (p.has) {
                            /* 位置/朝向没有滑条了，无需 setProgress */
                            /* 部件参数：把当前值显示到数值框（不再有滑条位置要维护） */
                            for (var pk = 0; pk < propRows.length && pk < p.props.length; pk++) {
                                var rr = propRows[pk];
                                var cur = p.props[pk].value;
                                if (!isFinite(cur)) continue;
                                try { if (rr.val.hasFocus()) continue; } catch (e) { }
                                cTxtField(rr.val, fmtNum(cur, rr.sc.dec));
                            }
                        }
                    } catch (e) { }
                    syncing = false;
                }

                /* ---------- 滑条监听 ---------- */
                var Slider = Java.registerClass({
                    name: "io.sfsmod.S" + sfx,
                    implements: [Java.use("android.widget.SeekBar$OnSeekBarChangeListener")],
                    methods: {
                        onProgressChanged: function (sb, progress, fromUser) {
                            try {
                                 if (!fromUser || syncing) return;
                                /* 位置/朝向/部件参数都已改用"数值框 + 箭头"，
                                 * 这里只剩 STEP 与 GRID SNAP 两条滑条 */
                                if (sb.equals(barRot)) { G.rotStep = progress < 1 ? 1 : progress; refreshOtherLabels(); }
                                else if (sb.equals(barSnap)) { G.snapStep = Math.round(progress) * 0.05; refreshOtherLabels(); }
                            } catch (e) { log("[UI] slider: " + e); }
                        },
                        onStartTrackingTouch: function (sb) { },
                        onStopTrackingTouch: function (sb) { }
                    }
                });
                var slider = Slider.$new();
                [barRot, barSnap].forEach(function (b) {
                    b.setOnSeekBarChangeListener.overload('android.widget.SeekBar$OnSeekBarChangeListener').call(b, slider);
                });

                /* ---------- 按钮 ---------- */
                /* 数值框的左右箭头：按步进增减并写回（走 SetValue，能存进蓝图） */
                function stepVar(name, dir) {
                    if (!G.live.part || !partAlive(G.live.part)) { log("[VAR] 没有目标部件"); return; }
                    var sc = varScaler(name);
                    var cur = 0, found = false;
                    for (var i = 0; i < G.live.props.length; i++) {
                        if (G.live.props[i].name === name) { cur = G.live.props[i].value; found = true; }
                    }
                    if (!found) { log("[VAR] 找不到参数 " + name); return; }
                    var nv = cur + dir * sc.step;
                    if (nv < sc.min) nv = sc.min;
                    if (nv > sc.max) nv = sc.max;
                    /* 0.05 这类步进会产生浮点误差，按小数位归整一下 */
                    nv = parseFloat(nv.toFixed(6));
                    var ok = writePartParam(G.live.part, name, nv);
                    log("[VAR] " + name + "  " + cur.toFixed(sc.dec) + " → " + nv.toFixed(sc.dec)
                        + (ok ? " ✔" : " ✘"));
                    refreshPartLabels(); syncBars();
                }

                /* ---------- 数值输入框：失焦 / 回车时提交 ---------- */
                function fieldKeyOf(v) {
                    try {
                        var tg = v.getTag();
                        if (tg === null) return "";
                        return Java.cast(tg, JString).toString();
                    } catch (e) { return ""; }
                }
                /* 按 key 写值：key 形如 "VAR:name" 或 "PART:序号" */
                function applyKeyValue(key, nv) {
                    if (!isFinite(nv)) return false;
                    if (key.indexOf("VAR:") === 0) {
                        var vn = key.substring(4), sc = varScaler(vn);
                        if (nv < sc.min) nv = sc.min;
                        if (nv > sc.max) nv = sc.max;
                        nv = parseFloat(nv.toFixed(6));
                        log("[VAR] 输入 " + vn + " = " + nv.toFixed(sc.dec));
                        return writePartParam(G.live.part, vn, nv);
                    }
                    if (key.indexOf("PART:") === 0) {
                        var d = partNumDefs[parseInt(key.substring(5), 10)];
                        if (!d) return false;
                        /* 只保留 6 位，够 float32 用，同时避免浮点尾巴 */
                        nv = parseFloat(nv.toFixed(6));
                        log("[UI] 输入 " + d.lab + " = " + nv.toFixed(d.dec));
                        d.set(nv);
                        return true;
                    }
                    log("[UI] 未知 key: " + key);
                    return false;
                }
                function commitField(v) {
                    try {
                        var key = fieldKeyOf(v);
                        if (!key) return;
                        var raw = Java.cast(v, TextView).getText().toString().trim();
                        /* 条纹名是字符串，不能按数字解析 */
                        if (key.indexOf("STR:") === 0) {
                            applyStrValue(key.substring(4), raw);
                            refreshPartLabels(); syncBars();
                            return;
                        }
                        /* Burn Marks 的参数是数值，直接写 */
                        if (key.indexOf("BURN:") === 0) {
                            var bv = parseFloat(raw);
                            if (isFinite(bv)) applyBurnParam(key.substring(5), bv);
                            else log("[BURN] 输入无效: \"" + raw + "\"");
                            refreshPartLabels(); syncBars();
                            return;
                        }
                        var nv = parseFloat(raw);
                        if (!isFinite(nv)) { log("[UI] 输入无效: \"" + raw + "\""); }
                        else applyKeyValue(key, nv);
                        refreshPartLabels(); syncBars();
                    } catch (e) { log("[UI] 提交失败: " + e); }
                }
                function attachField(v, cb) {
                    try {
                        v.setOnFocusChangeListener.overload('android.view.View$OnFocusChangeListener').call(v, cb);
                        v.setOnEditorActionListener.overload('android.widget.TextView$OnEditorActionListener').call(v, cb);
                    } catch (e) { log("[UI] 输入框监听失败: " + e); }
                }

                var Committer = Java.registerClass({
                    name: "io.sfsmod.T" + sfx,
                    implements: [Java.use("android.view.View$OnFocusChangeListener"),
                                 Java.use("android.widget.TextView$OnEditorActionListener")],
                    methods: {
                        onFocusChange: function (v, hasFocus) {
                            if (!hasFocus) { try { commitField(v); } catch (e) { } }
                        },
                        onEditorAction: function (v, actionId, ev) {
                            try {
                                commitField(v);
                                /* 收起软键盘 */
                                var imm = Java.cast(ctx, Java.use("android.content.Context"))
                                    .getSystemService("input_method");
                                if (imm !== null) {
                                    Java.cast(imm, Java.use("android.view.inputmethod.InputMethodManager"))
                                        .hideSoftInputFromWindow(v.getWindowToken(), 0);
                                }
                                v.clearFocus();
                            } catch (e) { }
                            return true;
                        }
                    }
                });

                /* PART 位置/朝向的箭头：按各自步进增减后写回 */
                function stepPart(idx, dir) {
                    var d = partNumDefs[idx];
                    if (!d) return;
                    if (!G.live.part || !partAlive(G.live.part)) { log("[UI] 没有目标部件"); return; }
                    var cur = d.get();
                    if (!isFinite(cur)) { log("[UI] " + d.lab + " 当前值不可读"); return; }
                    var nv = parseFloat((cur + dir * d.step).toFixed(6));
                    d.set(nv);
                    log("[UI] " + d.lab + "  " + fmtNum(cur, d.dec) + " → " + fmtNum(nv, d.dec));
                    refreshPartLabels(); syncBars();
                }

                /* String 条纹：写入某个名字 */
                function applyStrValue(name, val) {
                    if (!G.live.part || !partAlive(G.live.part)) { log("[STR] 没有目标部件"); return false; }
                    var ok = writeStrVar(G.live.part, name, val);
                    for (var i = 0; i < G.live.strs.length; i++) {
                        if (G.live.strs[i].name === name) G.live.strs[i].value = val || "";
                    }
                    G.uiDirty = true;
                    log("[STR] " + name + " = \"" + (val || "") + "\"" + (ok ? " ✔" : " ✘"));
                    return ok;
                }
                /* String 条纹：在候选列表里前后循环 */
                function cycleStr(name, dir) {
                    if (!G.live.part || !partAlive(G.live.part)) { log("[STR] 没有目标部件"); return; }
                    var list = strCandidates(name);
                    if (!list.length) { log("[STR] " + name + " 没有候选列表（请直接在框里输入名字）"); return; }
                    var cur = "";
                    for (var i = 0; i < G.live.strs.length; i++) {
                        if (G.live.strs[i].name === name) cur = G.live.strs[i].value || "";
                    }
                    var idx = list.indexOf(cur);
                    var nxt = (idx < 0)
                        ? (dir > 0 ? 0 : list.length - 1)
                        : ((idx + dir + list.length) % list.length);
                    applyStrValue(name, list[nxt]);
                    refreshPartLabels(); syncBars();
                }

                /* ---------- Burn Marks：改一个参数并立刻应用 ---------- */
                function applyBurnParam(name, val) {
                    if (!G.live.part || !partAlive(G.live.part)) { log("[BURN] 没有目标部件"); return; }
                    if (!G.live.burn) G.live.burn = { angle: 0, intensity: 0, x: 0.3, has: false };
                    var bb = G.live.burn;
                    if (name === "angle") bb.angle = val;
                    else if (name === "intensity") bb.intensity = val;
                    else bb.x = val;
                    /* angle 与 intensity 同时为 0 就是"不要痕迹"（与参考实现同语义） */
                    if (bb.angle === 0 && bb.intensity === 0) {
                        burnClear(G.live.part);
                        bb.has = false;
                    } else {
                        bb.has = burnApply(G.live.part, bb.angle, bb.intensity, bb.x);
                    }
                    log("[BURN] " + name + " = " + val
                        + "   (angle=" + bb.angle + " intensity=" + bb.intensity + " x=" + bb.x + ")"
                        + (bb.has ? " ✔" : ""));
                    G.uiDirty = true;
                }
                function stepBurn(name, dir) {
                    var sc = burnScaler(name);
                    var bb = G.live.burn || { angle: 0, intensity: 0, x: 0.3 };
                    var nv = bb[name] + dir * sc.step;
                    if (nv < sc.min) nv = sc.min;
                    if (nv > sc.max) nv = sc.max;
                    applyBurnParam(name, parseFloat(nv.toFixed(4)));
                }
                function burnOff() {
                    if (!G.live.part || !partAlive(G.live.part)) { log("[BURN] 没有目标部件"); return; }
                    burnClear(G.live.part);
                    G.live.burn = { angle: 0, intensity: 0, x: 0.3, has: false };
                    log("[BURN] Burn Off 已执行");
                    G.uiDirty = true;
                }

                /* Bool 开关：读当前值取反后写回 */
                function toggleBool(name) {
                    if (!G.live.part || !partAlive(G.live.part)) { log("[BOOL] 没有目标部件"); return; }
                    var cur = null;
                    for (var i = 0; i < G.live.bools.length; i++) {
                        if (G.live.bools[i].name === name) cur = G.live.bools[i].value;
                    }
                    if (cur === null) { log("[BOOL] 找不到开关 " + name); return; }
                    var nv = !cur;
                    var ok = writeBoolVar(G.live.part, name, nv);
                    log("[BOOL] " + name + "  " + cur + " → " + nv + (ok ? " ✔" : " ✘"));
                    for (var j = 0; j < G.live.bools.length; j++) {
                        if (G.live.bools[j].name === name) G.live.bools[j].value = nv;
                    }
                    G.uiDirty = true;
                }

                var Clicker = Java.registerClass({
                    name: "io.sfsmod.C" + sfx,
                    implements: [Java.use("android.view.View$OnClickListener")],
                    methods: {
                        onClick: function (v) {
                            var t = "";
                            try { t = Java.cast(v, Java.use("android.widget.TextView")).getText().toString(); } catch (e0) { }
                            /* 数值框的箭头用 tag 传递"改哪个变量、往哪个方向" */
                            var tag = "";
                            try {
                                var tg = v.getTag();
                                if (tg !== null) tag = Java.cast(tg, JString).toString();
                            } catch (e0) { }
                            /* Burn Off 按钮 */
                            if (tag && tag.indexOf("BURNOFF:") === 0) {
                                try { burnOff(); } catch (e2) { log("[UI] BurnOff 异常: " + e2); }
                                return;
                            }
                            /* Burn Marks 的箭头（tag 形如 "BURN:angle|-1"） */
                            if (tag && tag.indexOf("BURN:") === 0) {
                                try {
                                    var bs2 = tag.split("|");
                                    stepBurn(bs2[0].substring(5), parseInt(bs2[1], 10));
                                } catch (e2) { log("[UI] Burn 箭头异常: " + e2); }
                                return;
                            }
                            /* Bool 开关（tag 形如 "BOOL:<变量名>"） */
                            if (tag && tag.indexOf("BOOL:") === 0) {
                                try { toggleBool(tag.substring(5)); }
                                catch (e2) { log("[UI] 开关切换失败: " + e2); }
                                return;
                            }
                            /* 抽屉开合（tag 形如 "DRW:<id>"，没有方向段） */
                            if (tag && tag.indexOf("DRW:") === 0) {
                                try { toggleDrawer(parseInt(tag.substring(4), 10)); }
                                catch (e2) { log("[UI] 抽屉切换失败: " + e2); }
                                return;
                            }
                            if (tag && tag.indexOf("|") > 0) {
                                try {
                                    var ps2 = tag.split("|");
                                    var key2 = ps2[0], dir2 = parseInt(ps2[1], 10);
                                    if (key2.indexOf("VAR:") === 0) stepVar(key2.substring(4), dir2);
                                    else if (key2.indexOf("PART:") === 0) stepPart(parseInt(key2.substring(5), 10), dir2);
                                    else if (key2.indexOf("STR:") === 0) cycleStr(key2.substring(4), dir2);
                                    else log("[UI] 未知 tag: " + tag);
                                } catch (e2) { log("[UI] 箭头处理失败: " + e2); }
                                return;
                            }
                            try {
                                if (t === "\u2715") {
                                    shutdownMod();
                                } else if (t === "HIDE") { cVis(holder, 8); cVis(toggle, 0); }
                                else if (t === "Blueprint Editer") { cVis(toggle, 8); cVis(holder, 0); }
                                else if (t.indexOf("ROT STEP") === 0) {
                                    G.rotHookOn = !G.rotHookOn;
                                    cTxt(rotBtn, G.rotHookOn ? "ROT STEP: ON" : "ROT STEP: OFF");
                                    refreshOtherLabels();
                                } else if (t.indexOf("SNAP") === 0) {
                                    G.snapOn = !G.snapOn;
                                    cTxt(snapBtn, G.snapOn ? "SNAP: ON" : "SNAP: VANILLA");
                                    refreshOtherLabels();
                                } else if (t.indexOf("ZOOM") === 0) {
                                    if (G.zoomUnlimited) { if (G.savedMin !== null) setZoomLimits(G.savedMin, G.savedMax); G.zoomUnlimited = false; cTxt(camBtn, "ZOOM: NORMAL"); }
                                    else { applyZoomUnlimited(); cTxt(camBtn, "ZOOM: UNLIMITED"); }
                                    refreshOtherLabels();
                                }
                            } catch (e) { log("[UI] click: " + e); }
                        }
                    }
                });
                var clicker = Clicker.$new();
                /* 把早先登记下来的箭头按钮补上监听 */
                for (var pa = 0; pa < pendingArrows.length; pa++) {
                    try {
                        pendingArrows[pa].setOnClickListener
                            .overload('android.view.View$OnClickListener')
                            .call(pendingArrows[pa], clicker);
                    } catch (e) { log("[UI] 补绑箭头失败: " + e); }
                }
                pendingArrows = [];
                var committer = Committer.$new();
                for (var pf = 0; pf < pendingFields.length; pf++) {
                    try { attachField(pendingFields[pf], committer); }
                    catch (e) { log("[UI] 补绑输入框失败: " + e); }
                }
                pendingFields = [];
                [hideB, closeX, rotBtn, snapBtn, camBtn, toggle].forEach(function (b) {
                    b.setOnClickListener.overload('android.view.View$OnClickListener').call(b, clicker);
                });

                /* ---------- 拖动 / 缩放 ---------- */
                var dispW = 620;
                /* 初始尺寸固定为 620 × 1030（按用户要求的"初始分辨率"）。
                 * 原来高度是 WRAP_CONTENT（-2），会随内容多少忽高忽低。
                 * ★ 注意：没有 ScrollView（它会吞掉所有触摸事件），
                 *   所以内容超过这个高度时会被裁掉，需要拖右下角小方块放大。 */
                var lp = FLP.$new(dispW, 1030);
                lp.gravity.value = (Gravity.START.value | Gravity.TOP.value);
                lp.leftMargin.value = 16;
                lp.topMargin.value = 90;

                var sRX = 0, sRY = 0, sL = 0, sT = 0, sW = 0, sH = 0;

                var DragL = Java.registerClass({
                    name: "io.sfsmod.D" + sfx,
                    implements: [Java.use("android.view.View$OnTouchListener")],
                    methods: {
                        onTouch: function (v, e) {
                            try {
                                var a = e.getAction();
                                if (a === 0) { sRX = e.getRawX(); sRY = e.getRawY(); sL = lp.leftMargin.value; sT = lp.topMargin.value; }
                                else if (a === 2) {
                                    lp.leftMargin.value = Math.round(sL + (e.getRawX() - sRX));
                                    lp.topMargin.value = Math.round(sT + (e.getRawY() - sRY));
                                    holder.setLayoutParams(lp);
                                }
                            } catch (er) { }
                            return true;
                        }
                    }
                });
                var dragL = DragL.$new();
                header.setOnTouchListener.overload('android.view.View$OnTouchListener').call(header, dragL);

                var ResizeL = Java.registerClass({
                    name: "io.sfsmod.R" + sfx,
                    implements: [Java.use("android.view.View$OnTouchListener")],
                    methods: {
                        onTouch: function (v, e) {
                            try {
                                var a = e.getAction();
                                if (a === 0) {
                                    sRX = e.getRawX(); sRY = e.getRawY();
                                    sW = lp.width.value > 0 ? lp.width.value : holder.getWidth();
                                    sH = lp.height.value > 0 ? lp.height.value : holder.getHeight();
                                }
                                else if (a === 2) {
                                    lp.width.value = Math.max(360, Math.round(sW + (e.getRawX() - sRX)));
                                    lp.height.value = Math.max(300, Math.round(sH + (e.getRawY() - sRY)));
                                    holder.setLayoutParams(lp);
                                }
                            } catch (er) { }
                            return true;
                        }
                    }
                });
                var resizeL = ResizeL.$new();
                handle.setOnTouchListener.overload('android.view.View$OnTouchListener').call(handle, resizeL);

                /* ---------- 挂到 decorView ---------- */
                var decor = act.getWindow().getDecorView();
                var ViewGroup = Java.use("android.view.ViewGroup");
                var decorVG = Java.cast(decor, ViewGroup);
                var decorLP = FLP.$new(-2, -2);
                decorLP.gravity.value = (Gravity.START.value | Gravity.TOP.value);
                // holder 用 lp 添加（带位置和尺寸），toggle 用最小参数
                decorVG.addView.overload('android.view.View', 'android.view.ViewGroup$LayoutParams').call(decorVG, holder, lp);
                holder.setLayoutParams(lp);
                decorVG.addView.overload('android.view.View', 'android.view.ViewGroup$LayoutParams').call(decorVG, toggle, decorLP);

                G.ui = {
                    holder: holder, toggle: toggle, labPart: labPart, labInfo: labInfo,
                    refreshPartLabels: refreshPartLabels, refreshOtherLabels: refreshOtherLabels,
                    syncBars: syncBars, isSyncing: function () { return syncing; },
                    removeViews: function () {
                        /* 先把监听器清空，再摘 View。
                         * 监听器是 Frida 的 JNI 方法，清空后再也没有任何 View 引用它，
                         * 这样即使之后脚本被卸载，也不可能被触摸调到悬空指针。 */
                        try {
                            [holder, toggle, hideB, closeX,
                             rotBtn, snapBtn, camBtn, barRot, barSnap].forEach(function (v) {
                                try { v.setOnClickListener.overload('android.view.View$OnClickListener').call(v, null); } catch (e) { }
                                try { v.setOnTouchListener.overload('android.view.View$OnTouchListener').call(v, null); } catch (e) { }
                                try { v.setOnSeekBarChangeListener.overload('android.widget.SeekBar$OnSeekBarChangeListener').call(v, null); } catch (e) { }
                            });
                        } catch (e) { }
                        /* 抽屉头的 onClick 同样是 Frida 的 JNI 方法，必须清空 */
                        try {
                            for (var rr2 = 0; rr2 < drawers.length; rr2++) {
                                try {
                                    drawers[rr2].head.setOnClickListener
                                        .overload('android.view.View$OnClickListener')
                                        .call(drawers[rr2].head, null);
                                } catch (e) { }
                            }
                            /* Bool 开关按钮的 onClick 同理 */
                            for (var rr3 = 0; rr3 < boolRows.length; rr3++) {
                                try {
                                    boolRows[rr3].btn.setOnClickListener
                                        .overload('android.view.View$OnClickListener')
                                        .call(boolRows[rr3].btn, null);
                                } catch (e) { }
                            }
                            /* Burn Off 按钮的 onClick 同理 */
                            try {
                                if (burnOffBtn) burnOffBtn.setOnClickListener
                                    .overload('android.view.View$OnClickListener').call(burnOffBtn, null);
                            } catch (e) { }
                        } catch (e) { }
                        /* 数值输入框的 焦点/编辑器 监听同样是 Frida 的 JNI 方法，
                         * 必须一并清空，否则脚本卸载后触摸到它就会跳到悬空指针。 */
                        try {
                            var allFields = [];
                            for (var rf = 0; rf < partNumRows.length; rf++) allFields.push(partNumRows[rf].nr.val);
                            for (var rg = 0; rg < propRows.length; rg++) allFields.push(propRows[rg].val);
                            for (var rg2 = 0; rg2 < strRows.length; rg2++) allFields.push(strRows[rg2].val);
                            for (var rb in burnRows) { if (burnRows[rb] && burnRows[rb].val) allFields.push(burnRows[rb].val); }
                            for (var rh = 0; rh < allFields.length; rh++) {
                                try { allFields[rh].setOnFocusChangeListener.overload('android.view.View$OnFocusChangeListener').call(allFields[rh], null); } catch (e) { }
                                try { allFields[rh].setOnEditorActionListener.overload('android.widget.TextView$OnEditorActionListener').call(allFields[rh], null); } catch (e) { }
                            }
                        } catch (e) { }
                        try { decorVG.removeView.overload('android.view.View').call(decorVG, holder); } catch (e) { }
                        try { decorVG.removeView.overload('android.view.View').call(decorVG, toggle); } catch (e) { }
                    }
                };

                cInt(barRot, "setProgress", Math.round(G.rotStep));
                cInt(barSnap, "setProgress", Math.round(G.snapStep / 0.05));

                // 摄像机实例：借一次主线程调用（此处就在主线程）
                try { acquireCam(); } catch (e) { log("[UI] acquireCam 失败: " + e); }
                /* 必须把 G.zoomUnlimited 的状态真正落到内存上。
                 *   原来只有按 ZOOM 按钮时才调 applyZoomUnlimited()，而 zoomUnlimited
                 *   默认是 true —— 于是启动后标签写着 [UNLIMITED]、内存里却还是
                 *   原来的 10~60。加了"停止时还原缩放限制"之后这个不一致就暴露了：
                 *   停止会写回 10/60，再注入时看着就像"缩放功能坏了"。 */
                try {
                    if (G.zoomUnlimited) applyZoomUnlimited();
                    var limNow = readZoomLimits();
                    log("[UI] 缩放状态 = " + (G.zoomUnlimited ? "UNLIMITED" : "NORMAL")
                        + (limNow ? ("  当前限制 " + limNow.min + " ~ " + limNow.max) : "  (读不到)"));
                } catch (e) { log("[UI] 启动应用缩放失败: " + e); }

                refreshPartLabels(); refreshOtherLabels();

                /* ---------- 定时把采集到的数据刷到 UI（纯 Java，不做托管调用） ---------- */
                G.uiTimer = setInterval(function () {
                    if (G.shuttingDown) return;
                    try {
                        Java.scheduleOnMainThread(function () {
                            try {
                                if (G.ui.isSyncing()) return;
                                G.ui.refreshPartLabels();
                                G.ui.syncBars();
                                if (uiTick++ === 0) log("[UI] 定时刷新已生效");
                            } catch (e) { if (uiErr++ < 2) log("[UI] 定时刷新内部错误: " + e); }
                        });
                    } catch (e) { if (uiErr++ < 2) log("[UI] scheduleOnMainThread 失败: " + e); }
                }, 600);

                /* ---------- 立即刷新通道 ----------
                 * 主刷新是 600ms 定时器，点完部件要等最长 600ms 面板才亮，手感迟钝。
                 * 这里用 80ms 的快速轮询检查"脏标记"，只有真的变了才做实际刷新，
                 * 稳态下几乎零开销。 */
                G.uiTimer2 = setInterval(function () {
                    if (G.shuttingDown || !G.uiDirty) return;
                    G.uiDirty = false;
                    try {
                        Java.scheduleOnMainThread(function () {
                            try {
                                if (G.ui.isSyncing()) { G.uiDirty = true; return; }
                                G.ui.refreshPartLabels();
                                G.ui.syncBars();
                            } catch (e) { }
                        });
                    } catch (e) { G.uiDirty = true; }
                }, 80);

                log("[+] MOD EDITOR v6 READY  (选中部件属性 + 步长 + 网格吸附 + 无限缩放 + 可拖动/缩放窗口)");
                log("[*] rotHookOn=" + G.rotHookOn + " rotHooked=" + G.rotHooked
                    + "  snapOn=" + G.snapOn + " snapHooked=" + G.snapHooked);
                /* 告诉 .sh：现在悬浮窗挂着监听器，**不能**直接杀注入进程（会悬空指针崩游戏） */
                writeState("running");
            } catch (e) {
                log("[!] UI error: " + e + "\n" + (e.stack || ""));
            }
        });
    });
}

function applyZoomUnlimited() {
    var lim = readZoomLimits();
    if (lim === null) return false;
    if (G.savedMin === null) { G.savedMin = lim.min; G.savedMax = lim.max; }
    setZoomLimits(ZOOM_MIN, ZOOM_MAX);
    G.zoomUnlimited = true;
    return true;
}

/* 监听 .sh 写的停止标记 —— 让"从终端停止"也能走同一条安全关闭路径。
 * 注意：这里只做纯 JS 文件判断，不碰托管代码，所以放在定时器里是安全的。 */
function stopFileExists() {
    try { if (File.exists && File.exists(STOPFILE)) return true; } catch (e) { }
    try { var f = new File(STOPFILE, "r"); if (f) { try { f.close(); } catch (e2) { } return true; } } catch (e) { }
    return false;
}
function installStopWatcher() {
    G.stopTimer = setInterval(function () {
        if (G.shuttingDown) return;
        try { if (stopFileExists()) { log("[*] .sh 请求停止"); shutdownMod(); } } catch (e) { }
    }, 1000);
    log("[+] 停止标记轮询已启动");
}

/* ------------------------------------------------------------------ 启动 */

var tries = 60;
(function poll() {
    var m = Process.findModuleByName("libil2cpp.so");
    var ready = false;
    if (m) {
        try {
            var dg = new NativeFunction(m.getExportByName("il2cpp_domain_get"), "pointer", []);
            if (!dg().isNull()) ready = true;
        } catch (e) { }
    }
    if (ready) {
        if (!setupIl2Cpp()) { log("[-] setup failed"); return; }
        installRotateHook();
        installDragSnapHook();
        installTickHook();
        installStopWatcher();
        try { installBurnSaveHook(); } catch (e) { log("[BURN5] 安装失败: " + e); }
        log("[*] 5s 后建 UI ...");
        setTimeout(buildUI, 5000);
        return;
    }
    if (tries-- <= 0) { log("[-] timeout"); return; }
    setTimeout(poll, 1000);
})();
