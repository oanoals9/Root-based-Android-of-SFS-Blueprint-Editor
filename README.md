# Blueprint Editer

Spaceflight Simulator 的**运行时部件编辑修改器**。基于 [Frida](https://frida.re/) 注入，
不修改 APK、不重打包，在游戏运行中直接读写部件数据。

> ⚠️ **需要 root。** 无需重打包 APK，但需要已解锁 Bootloader 并安装
> Magisk / KernelSU / APatch 之一。

---

## 支持的游戏版本

| 项目 | 值 |
|---|---|
| 游戏 | Spaceflight Simulator |
| 包名 | `com.StefMorojna.SpaceflightSimulator` |
| **已验证版本** | **v1.6.00.22 (b713)** |
| 平台 | Android arm64 |

> ❗ **所有内存偏移只对被混淆过的游戏二进制有意义，因此只对上述版本有效。**
> 游戏一更新，绝大多数功能就会失效。这是本项目的根本限制，不是可以绕过的工程问题。

---

## 功能

面板分为若干可折叠的**抽屉**，全部只对**当前选中的单个部件**生效
（多选时不显示任何属性）。

### Part Editer（大抽屉）

| 抽屉 | 内容 |
|---|---|
| **Position** | `X` / `Y` —— 部件在建造网格中的位置 |
| **Orientation** | `X` / `Y` / `Z` —— 尺寸 / 拉伸 / 旋转 |
| **Double 变量** | 部件自带的 `double` 型参数，按部件类型动态生成 |
| **Bool 变量** | 部件自带的开关（如发动机的 `gimbal_on`） |
| **String 变量** | 纹理 / 条纹名（`color_tex` / `shape_tex`） |
| **Burn Marks** | 燃烧痕迹：`Burn Angle` / `Burn Intensity` / `Burn X`，附 `Burn Off` |

**Double / Bool / String 三组是按部件实际拥有的变量动态生成的**，
没有对应变量的部件不会显示该抽屉。这三组走的是游戏自己的变量系统，
**改动可以存进蓝图**。

### 全局设置

| 区块 | 功能 |
|---|---|
| **Global Rotation Degrees** | 建造时按旋转按钮的步进角度（原版 90°） |
| **Global Grid Snap** | 拖动部件时的网格吸附步长（原版 0.5） |
| **Camera Zoom Range** | 解除摄像机缩放上下限（双指自由缩放） |

### 操作方式

- **数值框**：`标签 ‹ 数值 ›`，点箭头按固定步进增减，**也可以直接点进框里输入**
- **开关**：`ON` / `OFF`
- **窗口**：拖标题栏移动、拖右下角青色方块改大小、`HIDE` 收起、`✕` 停止
- `HIDE` 之后左上角会出现一个小按钮把窗口叫回来

---

## 安装

### 1. 准备

需要：

- 已 root 的 Android 设备（arm64）
- 与游戏**架构匹配**的 [Frida](https://github.com/frida/frida/releases) **16.x**
  中的 `frida-inject`（**本项目不附带 Frida 二进制，请自行下载** —— 见下方"许可证"）

### 2. 推送文件

```bash
adb push sfs_mod.js         /data/local/tmp/
adb push sfs_mod.sh         /data/local/tmp/
adb push frida-inject-16    /data/local/tmp/     # 自行下载
adb shell su -c "chmod 755 /data/local/tmp/frida-inject-16 /data/local/tmp/sfs_mod.sh"
```

### 3. 运行

先打开游戏，然后：

```bash
adb shell
su -c "sh /data/local/tmp/sfs_mod.sh"
```

脚本会等待游戏进程、注入脚本，并在游戏中显示面板。

**停止**：点面板标题栏的 `✕`，或按 `Ctrl+C`。

---

## 停止机制（重要，请先读）

**停止修改器时，脚本不会被卸载。** 这不是 bug，是刻意设计。

原因是本修改器用 Frida 的 `Java.registerClass` 给按钮和输入框装了监听器 ——
这些是**运行在目标进程里的 JNI 方法**。一旦卸载脚本（`Interceptor.detachAll()`
或直接杀掉 `frida-inject`），这些方法的入口地址就会变成悬空指针；
此时只要有**一次触摸**落到还没回收的 View 上，游戏就会立刻段错误崩溃。

崩溃栈长这样：

```
signal 11 (SIGSEGV)
#00 pc <unknown>                          ← 跳到未映射内存
#01 art_quick_generic_jni_trampoline
#06 android.view.View.dispatchTouchEvent
```

所以停止时的做法是：

1. 清空所有监听器 → 2. 移除悬浮窗 → 3. 把钩子全部转入"空操作"
→ 4. 写状态标记

**行为上等同游戏恢复原版**，但注入进程会留在后台空转（几乎不耗 CPU）。
下次执行 `.sh` 时，脚本会读到状态标记，那时才安全地清理掉旧进程。

> 所以停止后 `ps -A | grep frida-inject` 仍能看到一个进程，**这是正常的**。
> **请不要手动去杀它** —— 在还有悬浮窗时杀它就会崩游戏。

---

## 已知限制

1. **只支持 v1.6.00.22 (b713)**，游戏更新即失效（见上）
2. **必须 root**。无 root 方案只有"重打包 APK 注入 Frida Gadget"或"虚拟机"，
   两者都有明显代价，本项目不提供
3. **`Burn X` 的确切作用未查证** —— 参考实现只是把它映射成 0–2 的滑块，
   没有说明它在视觉上控制什么
4. **String 变量的候选名不是官方全集** —— 它是"设备上蓝图里实际出现过的名字"
   与官方纹理清单的并集，可能仍缺少某些合法值（界面上可直接手动输入兜底）
5. **多选不支持属性编辑** —— 多选时面板收起，这是刻意行为
6. 数值精度上限受游戏内部 `float32` 限制（约 7 位有效数字）
7. 界面上的 `Blueprint Editer` 拼写与社区已有的 `PartEditor` mod 名称接近，
   请注意区分

---

## 排查

日志：

```
/sdcard/Android/data/com.StefMorojna.SpaceflightSimulator/files/mod.log
```

启动器输出：

```
/data/local/tmp/sfs_mod.out
```

常见问题：

| 现象 | 原因 |
|---|---|
| `Unable to find process with pid NNNNN` | 拿 PID 后游戏自己重启了。启动器已加注入前复核，若仍出现请重跑 |
| 面板不出现 | 注入失败，先看 `sfs_mod.out` |
| 停止后仍有 `frida-inject` 进程 | **正常**，见"停止机制" |
| 点 `✕` 后游戏崩溃 | 不应该发生。若发生请附 `mod.log` 与崩溃栈提交 issue |

---

## 技术说明

本修改器通过 IL2CPP 的运行期反射接口（`il2cpp_*` 导出）做类型与字段的
**按名查找**，只在少数几处使用硬编码偏移（均已在文档与代码注释中标注）。
部件参数的读写一律走游戏**自己的 API**（变量列表的 `SetValue` /
`BurnMark` 的 `ApplyEverything` 等），而不是裸写内存 —— 这样才能存进蓝图。

详细文档：

- **[docs/原理总结.md](docs/原理总结.md)** —— 整体是怎么设计的、为什么这样设计
  （三层架构、两条线程的纪律、写入路径分四类、关闭流程的原理、验证方法学）
- **[docs/技术笔记.md](docs/技术笔记.md)** —— 逆向参考手册
  （混淆名与真实名的对照表、字段偏移、逐个功能的探测过程与踩坑记录）

**游戏更新后怎么修**：把 `sfs_mod.js` 顶部的 `var DEBUG_PROBES = false;`
改成 `true`，重新注入并选中一个部件，日志会把类型布局与方法签名全部打印出来
—— 这是本项目在游戏更新后自我恢复的手段。详见原理总结第 13 节。

---

## 许可证

**本项目自身**（`sfs_mod.js` / `sfs_mod.sh` / 文档）以 [MIT](LICENSE) 授权。

**Frida 不在本项目范围内。** Frida 主要使用 wxWindows Library Licence
（LGPL-2.1-or-later 的变体）。本项目**不分发 Frida 二进制**，使用者需自行从
官方渠道获取并遵守其许可证。

**本项目不包含 Spaceflight Simulator 的任何资源或代码。** 使用者需自行拥有
该游戏的正版。修改商业游戏可能违反其服务条款，**风险自负**。
