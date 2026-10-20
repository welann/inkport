# 把 Leaf5C 的 BooxDrop 页面换成墨港

## 当前状态

这台 Leaf5C（Android 13）已经完成替换（实际访问用设备 IP；代码默认 `boox.local:8085`）：

- `http://<设备 IP>:8085/` 返回的是 **墨港**，不再是原来的 BOOX Drop SPA。
- 原应用 `com.onyx.easytransfer`（系统应用，Onyx 签名）已被 **禁用**，但 APK 仍在 `/system/app/EasyTransfer/`。
- 实际提供 8085 服务的是克隆应用 `com.onyx.easytransfer.mod`，启动器里显示为 **墨港**。
- 克隆应用带一个 `BOOT_COMPLETED` 接收器，开机后自动启动 `TransferService`，服务内部会调用 `DataBundle.startServer()`。
- 克隆应用已加入 Doze 白名单；前台服务运行，锁屏 35 秒实测仍能访问 8085。
- 原应用的系统 APK 未删除；克隆应用使用独立数据目录。恢复原版后设备名等设置如丢失，重新配置即可。

## 为什么不是直接覆盖原 APK

原 APK 是系统应用、Onyx 私钥签名。没有 root 时：

- `/system/app` 只读，不能原地替换；
- `adb install -r` 会因签名不一致失败（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）；
- `pm uninstall --user 0` 只是对用户隐藏，系统包仍在，签名检查仍会失败。

所以采用 **同代码克隆**：把原 APK 的包名改成 `com.onyx.easytransfer.mod`，替换 `assets/index.html`，用调试证书重新签名后作为普通应用安装；再停用原应用，让克隆独占 8085。API 实现、存储权限和文件服务都来自原 BooxDrop，所以行为一致。

## 文件

```
apk/EasyTransfer.apk        原系统 APK 备份（从 /system/app 拉取）
apk/clone-boot-signed.apk   已签名的可安装克隆（当前设备上就是这个）
apk/debug.keystore          克隆更新用的签名密钥（不要丢）
apk/apktool.jar             APK 解包/回包
apk/android-14/             Android build-tools（zipalign / apksigner / aapt2）
```

`apk/` 已在 `.gitignore` 中，不会进版本库。**不要删除 `debug.keystore`**：删了之后无法覆盖安装，只能卸载克隆再装（数据会丢）。

## 更新页面

改了代码后：

```bash
pnpm update:device
```

它会：

1. `pnpm build:embedded` 生成同源单文件 `dist-embedded/InkPort-embedded.html`；
2. 用 `apk/EasyTransfer.apk` 重新解码、打补丁、回包；
3. 覆盖安装 `com.onyx.easytransfer.mod`（同一调试签名，数据保留）；
4. 重新授予存储权限（重装会重置运行时权限）；
5. 停用原应用并确认它不在 enabled 列表；
6. 启动克隆前台服务，等待 8085 返回 `墨港` 且 `/api/storage` 能列出根目录。

只构建、不安装：

```bash
pnpm patch:device
# 生成 apk/clone-boot-signed.apk
```

`patch:device` 不会自动重建前端；改过页面代码时先 `pnpm build:embedded`，或直接用 `pnpm update:device`。

也可以手动安装并接管：

```bash
adb install -r apk/clone-boot-signed.apk
adb shell pm grant com.onyx.easytransfer.mod android.permission.READ_EXTERNAL_STORAGE
adb shell pm grant com.onyx.easytransfer.mod android.permission.WRITE_EXTERNAL_STORAGE
adb shell appops set com.onyx.easytransfer.mod MANAGE_EXTERNAL_STORAGE allow
adb shell am force-stop com.onyx.easytransfer
adb shell pm disable-user --user 0 com.onyx.easytransfer
adb shell am start-foreground-service -n com.onyx.easytransfer.mod/com.onyx.easytransfer.service.TransferService
```

## 恢复原版

```bash
pnpm restore:device
```

或手动：

```bash
adb uninstall com.onyx.easytransfer.mod
adb shell pm enable com.onyx.easytransfer
adb shell pm install-existing --user 0 com.onyx.easytransfer
adb shell am start -n com.onyx.easytransfer/com.onyx.easytransfer.main.MainActivity
```

恢复后 `http://<设备 IP>:8085/` 会重新返回原版 BOOX Drop。

## 脚本做了什么

`scripts/patch-device.sh`：

1. `apktool d -f apk/EasyTransfer.apk -o apk/full`
2. 修改 `AndroidManifest.xml`：
   - `package="com.onyx.easytransfer.mod"`
   - 应用/主 Activity 标签改为 `墨港`
   - `taskAffinity` 改为 `.BooxDropMod` / `.WeChatDropMod`
   - FileProvider authority 改为 `com.onyx.easytransfer.mod.onyx.fileprovider`
   - 增加 `RECEIVE_BOOT_COMPLETED`
   - 增加 `com.onyx.easytransfer.BootReceiver` 接收 `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED`
3. 在 `smali_classes5` 增加 `BootReceiver.smali`：`startForegroundService(TransferService)`
4. 用 `dist-embedded/InkPort-embedded.html` 替换 `assets/index.html`
5. `apktool b` → `zipalign -p 4` → `apksigner`（调试证书）
6. 可选 `--install` / `--replace`，安装后授予存储权限、停用原应用、启动克隆，并检查页面与 `/api/storage`

同源模式（`embedded`）的页面不填设备地址：所有 `/api/...` 都相对于当前 8085 源，因此没有 CORS、没有代理、没有固定 IP。

## 常见问题

- **页面是墨港，但最近/文件列表为空、上传失败**：克隆重装后运行时存储权限被清空。执行：
  ```bash
  adb shell pm grant com.onyx.easytransfer.mod android.permission.READ_EXTERNAL_STORAGE
  adb shell pm grant com.onyx.easytransfer.mod android.permission.WRITE_EXTERNAL_STORAGE
  adb shell appops set com.onyx.easytransfer.mod MANAGE_EXTERNAL_STORAGE allow
  adb shell am force-stop com.onyx.easytransfer.mod
  adb shell am start-foreground-service -n com.onyx.easytransfer.mod/com.onyx.easytransfer.service.TransferService
  ```
  然后刷新页面。`pnpm update:device` 已自动执行这些授权。
- **8085 又返回原版，或原版和克隆同时运行**：执行 `am force-stop` 后重新 `pm disable-user --user 0 com.onyx.easytransfer`，确认 `pm list packages -e | grep easytransfer` 只有 `.mod`，再启动克隆服务。

## 注意事项

- 克隆使用调试签名，不是系统签名；如果某个 BooxDrop 子功能依赖系统权限/签名（例如投屏、微信互传），可能不完整。文件浏览、上传、下载、删除、重命名、书库、图片预览已实测正常。
- 系统 OTA 可能重新启用原应用或覆盖克隆；升级后按“恢复原版/更新页面”重新处理即可。
- 恢复出厂设置会清掉克隆；原系统应用还在。
- 如果需要在别的 Leaf5C 上复现：`adb pull /system/app/EasyTransfer/EasyTransfer.apk`，放到 `apk/`，然后 `pnpm update:device`。
- 没有 root；如果以后 root，可以直接替换系统 APK，省掉克隆包，但当前方案已验证可逆。

## 验证记录

- 重启后约 10–20 秒 8085 返回 `墨港`（boot receiver + 前台服务）。
- 锁屏 35 秒后 8085 仍返回 200。
- 原应用 `pm list packages -d` 可见、克隆 `-e` 可见。
- `/api/device`、`/api/media/list`、`/api/storage`、`/api/storage/file` 正常。
- 页面内图片灯箱、27 张缩略图、PDF Blob 预览、拖拽上传、删除均正常。
