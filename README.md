# 墨港 · InkPort

> 英文仓库名：`inkport` · 中文名：墨港

给文石 Leaf5C（以及同类 BOOX 设备）的 BooxDrop 换一个有用的前端。

原版 BooxDrop 把文件当成“待下载附件”：图片不能放大、PDF 不能翻、书库没封面、搜索和文件夹操作也别扭。墨港直接调用设备 8085 端口上的 BooxDrop API，提供图片灯箱、PDF/视频/文本页内预览、书库封面、网格/列表、搜索、上传、新建文件夹、重命名和删除。

有两种部署方式：

| 方式 | 改设备？ | 适用场景 | 功能完整度 |
| --- | --- | --- | --- |
| **电脑代理版** | 否 | Mac 常开，电脑/手机浏览器访问 | 最完整：服务端缩略图、缓存、Range、自动发现 |
| **设备接管版** | 安装同代码克隆，停用原应用 | `http://boox.local:8085/` 直接变成墨港 | 文件浏览/上传/预览完整；Onyx 系统级子功能可能受限 |

---

## 0. 操作顺序总览

如果从零开始，按这个顺序做：

1. **准备环境**：Node ≥ 23、pnpm；设备接管还需要 adb 和 USB 调试。
2. **二选一部署**：
   - 电脑代理版：`pnpm install` → `pnpm build` → `pnpm start` → 打开 `127.0.0.1:8787`。
   - 设备接管版：准备原 APK/工具 → `pnpm update:device` → 验证 8085。
3. **日常更新**：改完代码后 `pnpm update:device`。
4. **需要回退**：`pnpm restore:device`。
5. **可选备用**：`pnpm build:standalone` 生成单文件，放进设备用。

设备接管版当前不在系统分区里改文件，也不 root；它通过“克隆包 + 停用原包”实现，原理和风险见 [docs/DEVICE-PATCH.md](docs/DEVICE-PATCH.md)。

---

## 1. 环境准备

### 1.1 通用

```bash
node -v      # 需要 ≥ 23
pnpm -v
pnpm install
```

`pnpm install` 会安装 Vite、sharp 等依赖。`pnpm-workspace.yaml` 已允许 sharp/esbuild 的构建脚本；如果 pnpm 提示 ignored builds，执行一次 `pnpm approve-builds --all`。

### 1.2 设备接管额外需要

- Leaf5C 打开 **开发者选项 → USB 调试**，用 USB 连接 Mac；
- `adb devices` 能看到 `device`（不是 `unauthorized`）；
- 本机已有：
  - `apk/EasyTransfer.apk`：原系统 APK 备份；
  - `apk/apktool.jar`：APK 解包/回包；
  - `apk/android-14/`：Android build-tools（`zipalign`、`apksigner`、`aapt2`）；
  - `apk/debug.keystore`：克隆包的签名密钥。

这些文件在 `.gitignore` 中。若换一台机器或删了 `apk/`，需要重新准备：

```bash
mkdir -p apk
adb exec-out cat /system/app/EasyTransfer/EasyTransfer.apk > apk/EasyTransfer.apk

# Apktool
curl -L https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar -o apk/apktool.jar

# Android build-tools（Apple Silicon 上 zipalign 需要 Rosetta；脚本已处理）
curl -L https://dl.google.com/android/repository/build-tools_r34-macosx.zip -o /tmp/build-tools.zip
unzip -q /tmp/build-tools.zip -d apk
# 解压后目录是 apk/android-14/
```

`debug.keystore` 不存在时，`patch-device.sh` 会自动生成。**不要删除它**：克隆包用它签名，删了之后无法覆盖升级，只能卸载重装（数据会丢）。

---

## 2. 电脑代理版（不改设备）

### 2.1 启动

```bash
pnpm install
pnpm build
pnpm start
```

打开 <http://127.0.0.1:8787>。首次默认连接 `boox.local:8085`；`boox.local` 是 mDNS 占位地址，如果解析不到，点右上角设置 →「自动发现局域网设备」，或填写设备 IP。

### 2.2 配置

```bash
cp .env.example .env
# BOOX_HOST=boox.local:8085
# PORT=8787
# BIND=127.0.0.1
pnpm start
```

- 手机访问：`BIND=0.0.0.0`，手机打开 `http://<电脑局域网 IP>:8787`。
- 代理版会做 CORS 转发、sharp WebP 缩略图、原文件缓存和 Range 支持；设备本身不需要安装任何东西。
- 缓存位于 `.cache/`，可以随时整个删除。

### 2.3 为什么需要代理

浏览器直接访问设备 API 会受 CORS、缩略图尺寸和 Range 支持限制。代理层统一解决了这些问题；设备接管版则通过“同源页面”绕开 CORS，两者是不同路线。

---

## 3. 设备接管版（把 8085 页面换掉）

### 3.1 先理解方案

不能直接覆盖原 APK：

- 原 `EasyTransfer.apk` 是系统应用、Onyx 私钥签名；
- `/system/app` 只读；
- 用调试证书 `adb install -r` 会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`；
- `pm uninstall --user 0` 只对用户隐藏，签名检查仍会失败。

所以方案是：

1. 把原 APK 的包名改成 `com.onyx.easytransfer.mod`；
2. 把 `assets/index.html` 替换成同源的墨港页面；
3. 增加一个 `BOOT_COMPLETED` 接收器，开机启动原有的 `TransferService`（服务内部会调用 `DataBundle.startServer()`）；
4. 用调试证书重新签名，作为普通应用安装；
5. 停用原应用，让克隆独占 8085。

API、存储权限、设备信息、文件服务都复用原 BooxDrop 代码，所以上传/下载/删除/书库行为一致。

### 3.2 一条命令完成

确保 `adb devices` 正常，然后：

```bash
pnpm update:device
```

它按顺序做：

1. `pnpm build:embedded` 生成同源单文件 `dist-embedded/InkPort-embedded.html`；
2. 解码 `apk/EasyTransfer.apk`；
3. 修改 Manifest、加入 `BootReceiver`、替换 `assets/index.html`；
4. 回包、`zipalign`、用 `apk/debug.keystore` 签名；
5. 覆盖安装 `com.onyx.easytransfer.mod`；
6. 停用原 `com.onyx.easytransfer`，加入 Doze 白名单；
7. 启动克隆的前台服务；
8. 轮询设备 Wi-Fi IP 的 8085，直到返回 `墨港`。

成功时会输出：

```
InkPort is now serving at http://<设备 IP>:8085/.
```

只想先生成 APK、不安装：

```bash
pnpm patch:device
# 产物：apk/clone-boot-signed.apk
```

注意：`patch:device` 只重打包，**不会**自动重新构建前端。改过页面代码时先执行 `pnpm build:embedded`，或者直接用 `pnpm update:device`（它包含构建步骤）。

手动安装/接管（等价于 `update:device` 的后半段）：

```bash
adb install -r apk/clone-boot-signed.apk
adb shell am force-stop com.onyx.easytransfer
adb shell pm disable-user --user 0 com.onyx.easytransfer
adb shell am start-foreground-service -n com.onyx.easytransfer.mod/com.onyx.easytransfer.service.TransferService
```

### 3.3 验证

```bash
# 页面标题应为 墨港
curl -s http://boox.local:8085/ | grep -o '<title>[^<]*'

# 设备 API 应正常
curl -s http://boox.local:8085/api/device

# 原应用在 disabled 列表，克隆在 enabled 列表
adb shell pm list packages -d | grep easytransfer
adb shell pm list packages -e | grep easytransfer

# 前台服务应在运行
adb shell dumpsys activity services com.onyx.easytransfer.mod | grep isForeground
```

浏览器打开 `http://boox.local:8085/`，应看到墨港的「最近 / 图片 / 书库 / 文件」。

设备 IP 用这条命令查：

```bash
adb shell 'ip -4 addr show wlan0' | awk '/inet /{print $2}'
```

### 3.4 更新页面

以后改了代码：

```bash
pnpm update:device
```

会重新构建、重打包、覆盖安装（同一调试签名，应用数据保留），再启动服务。因为页面在 APK 的 `assets/index.html` 里，**不能只替换一个文件**；必须重打包。

### 3.5 恢复原版

```bash
pnpm restore:device
```

或手动：

```bash
adb uninstall com.onyx.easytransfer.mod
adb shell pm install-existing --user 0 com.onyx.easytransfer
adb shell pm enable com.onyx.easytransfer
adb shell am start -n com.onyx.easytransfer/com.onyx.easytransfer.main.MainActivity
```

恢复后 8085 会重新返回原版 BOOX Drop。原系统 APK 一直在 `/system/app/EasyTransfer/`，不会被删除。

### 3.6 开机与保活

- 克隆 Manifest 里加了 `RECEIVE_BOOT_COMPLETED` 和 `BOOT_COMPLETED` 接收器；
- 接收器启动 `TransferService`，`onStartCommand` 调用 `DataBundle.startServer()`；
- 服务是前台服务，已加入 Doze 白名单；
- 实测重启后约 10–20 秒恢复 8085；锁屏 35 秒后 8085 仍返回 200。

如果 8085 没起来，先看：

```bash
adb shell dumpsys activity services com.onyx.easytransfer.mod
adb logcat -d -t 200 | grep -iE 'easytransfer|AndroidRuntime'
```

---

## 4. 独立单文件版（备用）

不想装克隆包，或者想从文件管理器直接打开时：

```bash
pnpm build:standalone
```

生成 `InkPort.html`（约 78 KB，根目录和 `dist-standalone/` 各一份）。上传到设备：

```bash
curl -F 'dir=/storage/emulated/0/Download' \
     -F 'file=@InkPort.html;filename=InkPort.html' \
     http://boox.local:8085/api/storage/upload
```

然后在设备上打开。注意 Android 13 的 Chrome 会因 scoped storage 拒绝读取 `Download` 下的 `file://`（`ERR_ACCESS_DENIED`）。更稳的方式：

1. 用文件管理器的“打开方式 → 浏览器”；
2. 或复制到 Chrome 自己的外部目录 `/sdcard/Android/data/org.chromium.chrome/files/InkPort/`；
3. 或在 Termux 里起一个本地静态服务：
   ```bash
   pkg install python
   termux-setup-storage
   cd /sdcard/Download && python -m http.server 8000
   ```
   然后打开 `http://127.0.0.1:8000/InkPort.html`。

单文件版默认访问 `http://127.0.0.1:8085`；如果浏览器访问不到，点右上角设置改成设备 Wi-Fi 地址（如 `boox.local:8085`）。它用 canvas 在浏览器里生成缩略图、把 PDF 取成 Blob 再交给阅读器，不依赖电脑代理。

---

## 5. 开发

```bash
pnpm dev:server   # 终端 1：代理服务（8787）
pnpm dev          # 终端 2：Vite（5173，/d 已代理到 8787）
npx tsc --noEmit
pnpm build             # 代理版（dist/）
pnpm build:standalone  # 单文件版（InkPort.html）
pnpm build:embedded    # 同源单文件（嵌入克隆用）
```

`src/mode.ts` 区分三种客户端模式：

- `proxy`：电脑代理版，走 `/d/*`；
- `direct`：单文件设备版，绝对地址访问设备；
- `embedded`：设备接管版，`location.origin` 同源访问。

---

## 6. 快捷键

| 键 | 作用 |
| --- | --- |
| `/` | 聚焦搜索 |
| `R` | 刷新 |
| `G` | 切换网格 / 列表 |
| `Esc` | 关闭浮层 |
| `←` / `→` | 上一张 / 下一张图片 |
| `+` / `-` / `0` / `1` | 放大 / 缩小 / 适应窗口 / 原始大小 |
| `R` / `D` / `P` / `Delete` | 旋转 / 下载 / 幻灯片 / 删除（灯箱内） |

---

## 7. 工作原理

### 7.1 电脑代理版

```
浏览器 ──> 墨港 (127.0.0.1:8787) ──> Leaf5C BooxDrop (<device-ip>:8085)
                │
                ├── /d/api/*    转发 JSON API（列表、重命名、删除、建目录）
                ├── /d/file     流式读取原文件，写缓存，支持 Range
                ├── /d/thumb    用 sharp 生成 WebP 缩略图并缓存
                ├── /d/upload   原样转发 multipart 上传
                └── /d/discover 扫描局域网 8085 端口
```

缓存位于 `.cache/`（`files/` 原文件、`thumbs/` 缩略图），可以随时整个删除。文件 URL 带列表里的 `updatedAt` 作为版本号，删除缓存后会自动重新拉取。

### 7.2 设备接管版

`assets/index.html` 被替换为同源单文件页面，页面使用当前 8085 源请求 `/api/*`；没有代理、没有 CORS、没有固定 IP。图片缩略图由浏览器 canvas 生成，PDF 先取 Blob，视频直接播放。详见 [docs/DEVICE-PATCH.md](docs/DEVICE-PATCH.md)。

用到的设备接口（逆向自 BooxDrop 前端）：

- `GET /api/media/list?args={"mediaType":"Recent","limit":60,...}`
- `GET /api/storage?args={"dir":"/storage/emulated/0/Pictures",...}`
- `GET /api/library?limit=1000&offset=0`
- `GET /api/storage/file?args=<urlencoded path>`
- `GET /api/storage/thumbnail?args=<urlencoded path>`
- `POST /api/storage/upload`（multipart：`dir` + `file`）
- `POST /api/storage/rename`、`POST /api/storage/directory`、`DELETE /api/storage/delete`
- `POST /api/storage/directory/delete`（`selectedMap`）

---

## 8. 局限性

### 8.1 设备接管版

- **不 root，不能真正替换系统 APK**：原应用是被禁用，实际服务来自调试签名的克隆包 `com.onyx.easytransfer.mod`。
- **调试签名不是系统签名**：依赖 Onyx 系统权限的子功能（投屏、微信互传等）可能不完整；文件浏览、上传、下载、删除、重命名、书库、图片/PDF 预览已实测正常。
- **系统 OTA / 恢复出厂** 可能重新启用原应用、覆盖或清除克隆；需要按本文重做。系统 OTA 也可能更换原 APK，`apk/EasyTransfer.apk` 备份需要更新。
- **恢复原版后设置可能丢失**：克隆使用独立数据目录；原应用被 `pm uninstall --user 0` 后设备名等设置可能需要重新配置。
- **8085 对局域网开放且无鉴权**：和原 BooxDrop 一样，同网段的人都能读写设备文件。
- **当前克隆实例按 Wi-Fi 地址监听**：请使用 `http://<设备 IP>:8085`，不要依赖 `127.0.0.1`；DHCP 换 IP 后需要重启克隆服务/应用。
- **不能只改 `assets/index.html` 文件**：页面在 APK 里，每次更新都要重打包、重签名、覆盖安装。
- **`apk/debug.keystore` 不能丢**：丢了无法覆盖升级，只能卸载重装。
- **只针对这台设备/这个固件**：`EasyTransfer.apk` 版本、Manifest 结构可能随固件变化；换设备需重新拉取并确认补丁目标。
- **单文件版在 Android 13 的 Chrome 受限**：`file://` 读取 `Download` 会被 scoped storage 拒绝，需要文件管理器、本地 HTTP 服务或 Chrome 自己的外部目录。

### 8.2 页面本身

- **不内置 EPUB 渲染**：书库显示封面/元数据并支持下载；PDF 可直接阅读。要页内读 EPUB 可以再接 epub.js。
- **最近页封面来自 `/api/library`**：不在书库索引中的 EPUB/PDF 仍显示类型图标；TXT/HTML 等本来就没有封面。
- **设备接管版视频不支持 Range**：BooxDrop 的文件接口 `Accept-Ranges: none`，视频能播放，但拖动进度条可能不精确；代理版通过本地缓存补上了 Range。
- **设备接管版首次加载图片较慢**：图片网格需要在设备浏览器里读取原图、用 canvas 生成缩略图（并发 3 个，内存缓存）；代理版有服务端 WebP 缩略图。
- **大 PDF**：超过 300 MB 在设备接管版会提示下载后阅读，避免一次性读入内存。
- **浏览器主页**：Chrome Android 通常没有“自定义主页”；把 `http://<设备 IP>:8085/` 加书签或“添加到主屏幕”即可。NeoBrowser 若支持“启动页”，可直接填这个地址。
- **设备 API 无鉴权**：不要把 8085 暴露到公网。

---

## 9. 目录

```
server/index.ts     代理、缓存、缩略图、上传、发现
src/main.ts         应用状态、四个视图、事件、上传队列
src/lightbox.ts     图片灯箱（缩放/平移/旋转/幻灯片）
src/preview.ts      图片以外格式的页内预览
src/dialog.ts       输入/确认对话框
src/api.ts          BooxDrop API 客户端（proxy/direct/embedded）
src/format.ts       格式化与图标
src/styles.css      主题与布局
src/mode.ts         三种客户端模式
src/deferred.ts     Chrome 111 兼容的 Promise 辅助
scripts/inline.ts   把构建产物压成单文件
scripts/patch-device.sh     重打包 BooxDrop 克隆（Manifest + BootReceiver + index.html）
scripts/update-device.sh    构建并覆盖安装克隆
scripts/restore-booxdrop.sh 卸载克隆，恢复原版
docs/DEVICE-PATCH.md        设备接管细节、风险和恢复
apk/                        本机工具与 APK 备份（gitignore）
```
