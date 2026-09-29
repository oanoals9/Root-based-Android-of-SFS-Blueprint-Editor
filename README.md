# Blueprint Editer

A **runtime part editor** for **Spaceflight Simulator**, powered by [Frida](https://frida.re/).

It injects a script into the running game process and edits part data live —
**no APK modification, no repackaging, no re-signing.**

[中文说明](README.zh-CN.md)

> ⚠️ **Root is required.** You do **not** need to repackage the APK, but you do need
> an unlocked bootloader plus one of Magisk / KernelSU / APatch.

---

## Supported game version

| | |
|---|---|
| Game | Spaceflight Simulator |
| Package | `com.StefMorojna.SpaceflightSimulator` |
| **Verified version** | **v1.6.00.22 (b713)** |
| Platform | Android arm64 |

> ❗ **Every memory offset in this project is tied to the obfuscated game binary,
> so it only works for the version above.** A game update breaks most functionality.
> This is an inherent limitation, not an engineering problem that can be engineered away.

---

## Features

The panel is organised into collapsible **drawers**. Everything applies to the
**single currently selected part** (when multiple parts are selected, all part
properties are hidden — this is intentional).

### Part Editer (main drawer)

| Drawer | Contents |
|---|---|
| **Position** | `X` / `Y` — the part's position in the build grid |
| **Orientation** | `X` / `Y` / `Z` — size / stretch / rotation |
| **Double 变量** | The part's own `double` parameters, generated dynamically per part type |
| **Bool 变量** | The part's boolean switches (e.g. an engine's `gimbal_on`) |
| **String 变量** | Texture / pattern names (`color_tex` / `shape_tex`) |
| **Burn Marks** | `Burn Angle` / `Burn Intensity` / `Burn X`, plus `Burn Off` |

**The Double / Bool / String drawers are generated dynamically** from the variables
a part actually owns; parts without them don't show the drawer at all.
These three go through the game's own variable system, so **changes are saved into
blueprints**.

### Global settings

| Section | Function |
|---|---|
| **Global Rotation Degrees** | Rotation step used by the build rotate buttons (vanilla: 90°) |
| **Global Grid Snap** | Grid snap step when dragging parts (vanilla: 0.5) |
| **Camera Zoom Range** | Removes the camera zoom limits (free pinch-to-zoom) |

### Controls

- **Number fields**: `label ‹ value ›`. Tap the arrows to step, **or tap the value
  and type it directly.**
- **Switches**: `ON` / `OFF`
- **Window**: drag the title bar to move, drag the cyan square at the bottom-right to
  resize, `HIDE` to collapse, `✕` to stop.
- After `HIDE`, a small button appears at the top-left to bring the window back.

---

## Installation

### 1. Requirements

- A rooted Android device (arm64)
- **`frida-inject` from Frida 16.x**, matching the game's architecture
  — from the [official releases](https://github.com/frida/frida/releases).
  **This project does not bundle any Frida binary** (see *License* below).

### 2. Push the files

```bash
adb push sfs_mod.js         /data/local/tmp/
adb push sfs_mod.sh         /data/local/tmp/
adb push frida-inject-16    /data/local/tmp/     # download it yourself
adb shell su -c "chmod 755 /data/local/tmp/frida-inject-16 /data/local/tmp/sfs_mod.sh"
```

### 3. Run

Start the game first, then:

```bash
adb shell
su -c "sh /data/local/tmp/sfs_mod.sh"
```

The launcher waits for the game process, injects the script, and the panel appears
in-game.

**To stop**: tap the `✕` in the panel's title bar, or press `Ctrl+C`.

---

## The shutdown design (please read before reporting bugs)

**The script is deliberately never unloaded when you stop.** This is not a bug.

The mod registers button and text-field listeners via Frida's `Java.registerClass`.
Those are **JNI methods living inside the target process**. Unloading the script
(`Interceptor.detachAll()`, or simply killing `frida-inject`) turns their entry points
into **dangling pointers** — and then a single touch landing on a not-yet-reclaimed
View crashes the game instantly:

```
signal 11 (SIGSEGV)
#00 pc <unknown>                          ← jumped into unmapped memory
#01 art_quick_generic_jni_trampoline
#06 android.view.View.dispatchTouchEvent
```

So shutdown does this instead:

1. Clear every listener → 2. remove the overlay → 3. turn all hooks into no-ops
→ 4. write a state marker.

**Behaviourally the game is back to vanilla**, but the injector process stays alive,
idling in the background (it uses next to no CPU). The next time you run the launcher,
it reads the state marker and only then safely removes the old process.

> Therefore, after stopping, `ps -A | grep frida-inject` will **still show a process**.
> **That is normal — please do not kill it manually.** Killing it while the overlay is
> still up is exactly what crashes the game.

---

## Known limitations

1. **Only v1.6.00.22 (b713)** — a game update breaks it (see above)
2. **Root is required.** The only root-free options are repackaging the APK with Frida
   Gadget, or running inside a VM/emulator — both have significant drawbacks this
   project does not solve
3. **`Burn X`'s exact visual effect has not been verified** — the reference
   implementation only mapped it to a 0–2 slider without documenting what it does
4. **The String candidate list is not the official full set.** It is the union of the
   official texture list and the names actually found in blueprints on a device, so
   some valid values may still be missing. You can always type a name manually
5. **Multi-select editing is not supported** — the panel collapses on multi-select
6. Numeric precision is capped by the game's internal `float32` (~7 significant digits)
7. The in-game name `Blueprint Editer` is close to the existing `PartEditor` mod by
   another author — please don't confuse the two

---

## Troubleshooting

Logs:

```
/sdcard/Android/data/com.StefMorojna.SpaceflightSimulator/files/mod.log
```

Launcher output:

```
/data/local/tmp/sfs_mod.out
```

| Symptom | Cause |
|---|---|
| `Unable to find process with pid NNNNN` | The game restarted itself after the PID was captured. The launcher now re-checks before injecting; if it still happens, just run it again |
| Panel doesn't appear | Injection failed — check `sfs_mod.out` first |
| A `frida-inject` process remains after stopping | **Normal**, see *The shutdown design* |
| The game crashes when tapping `✕` | Should not happen. If it does, please open an issue with `mod.log` and the crash trace |

---

## How it works

The mod resolves types and fields **by name** through IL2CPP's runtime reflection
exports (`il2cpp_*`), using only a handful of hard-coded offsets (all documented in
the code and the docs). Part parameters are always written through the game's **own
APIs** (the variable list's `SetValue`, `BurnMark`'s `ApplyEverything`, …) rather than
by poking raw memory — that is what makes changes persist into blueprints.

Documentation (currently in Chinese):

- **[docs/architecture.zh-CN.md](docs/architecture.zh-CN.md)** — the overall design and
  *why* it is shaped this way (layered architecture, the two-thread discipline, the four
  classes of write paths, the shutdown design, the verification methodology)
- **[docs/reverse-engineering-notes.zh-CN.md](docs/reverse-engineering-notes.zh-CN.md)**
  — the reference manual (obfuscated-name ↔ real-name tables, field offsets, how each
  feature was located, and the pitfalls hit along the way)

**After a game update**: set `var DEBUG_PROBES = false;` near the top of `sfs_mod.js`
to `true`, re-inject, and select a part. The log will dump the type layouts and method
signatures needed to relocate everything. This is the project's self-recovery path.

---

## License

**This project's own code** (`sfs_mod.js`, `sfs_mod.sh`, docs) is licensed under
[MIT](LICENSE).

**Frida is out of scope.** Frida is primarily under the wxWindows Library Licence
(a variant of LGPL-2.1-or-later). **This repository does not distribute any Frida
binary**; users must obtain it from the official source and comply with its licence.

**This project contains no assets or code from Spaceflight Simulator.** You need to own
a legitimate copy of the game. Modifying a commercial game may violate its terms of
service — **use at your own risk**.
