#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
APK_DIR="$ROOT/apk"
ORIGINAL="$APK_DIR/EasyTransfer.apk"
TOOLS="$APK_DIR/android-14"
APKTOOL="$APK_DIR/apktool.jar"
KEYSTORE="$APK_DIR/debug.keystore"
EMBEDDED="$ROOT/dist-embedded/InkPort-embedded.html"
WORK="$APK_DIR/full"
UNSIGNED="$APK_DIR/clone-boot-unsigned.apk"
ALIGNED="$APK_DIR/clone-boot-aligned.apk"
SIGNED="$APK_DIR/clone-boot-signed.apk"

INSTALL=0
REPLACE=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --replace) REPLACE=1; INSTALL=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$ORIGINAL" ]]; then
  echo "Pulling the original EasyTransfer.apk from the device..."
  mkdir -p "$APK_DIR"
  adb exec-out cat /system/app/EasyTransfer/EasyTransfer.apk > "$ORIGINAL"
fi

if [[ ! -f "$EMBEDDED" ]]; then
  echo "Building the embedded page first..."
  pnpm build:embedded
fi

for tool in "$APKTOOL" "$TOOLS/zipalign" "$TOOLS/apksigner"; do
  [[ -e "$tool" ]] || { echo "missing $tool" >&2; exit 1; }
done

if [[ ! -f "$KEYSTORE" ]]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi

rm -rf "$WORK"
echo "Decoding original APK..."
java -jar "$APKTOOL" d -f "$ORIGINAL" -o "$WORK" >/dev/null

echo "Applying package rename, boot receiver and page..."
python3 - "$WORK" <<'PY'
import glob
import os
import sys

work = sys.argv[1]

# 1. Manifest
path = os.path.join(work, 'AndroidManifest.xml')
manifest = open(path).read()

def replace(old, new, count=-1):
    global manifest
    if old not in manifest:
        raise SystemExit(f'manifest patch target not found: {old[:60]}')
    manifest = manifest.replace(old, new, count)

replace('package="com.onyx.easytransfer"', 'package="com.onyx.easytransfer.mod"')
replace('android:label="@string/boox_drop"', 'android:label="墨港"', 2)
replace('android:taskAffinity=".BooxDrop"', 'android:taskAffinity=".BooxDropMod"')
replace('android:taskAffinity=".WeChatDrop"', 'android:taskAffinity=".WeChatDropMod"')
replace('android:authorities="com.onyx.easytransfer.onyx.fileprovider"',
        'android:authorities="com.onyx.easytransfer.mod.onyx.fileprovider"')
replace('<uses-permission android:name="android.permission.INTERNET"/>',
        '<uses-permission android:name="android.permission.INTERNET"/>\n'
        '    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>')

receiver = '''        <receiver android:enabled="true" android:exported="true" android:name="com.onyx.easytransfer.BootReceiver">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED"/>
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED"/>
            </intent-filter>
        </receiver>
'''
if 'com.onyx.easytransfer.BootReceiver' not in manifest:
    replace('        <receiver android:name="com.onyx.easytransfer.im.IMMessageReceiver">',
            receiver + '        <receiver android:name="com.onyx.easytransfer.im.IMMessageReceiver">')

open(path, 'w').write(manifest)

# 2. Boot receiver class, placed next to the app class so the dex split is preserved.
app_class = glob.glob(os.path.join(work, 'smali*/com/onyx/easytransfer/EasyTransferApp.smali'))
if not app_class:
    raise SystemExit('could not find EasyTransferApp.smali')
target_dir = os.path.dirname(app_class[0])
smali = '''.class public Lcom/onyx/easytransfer/BootReceiver;
.super Landroid/content/BroadcastReceiver;
.source "BootReceiver.java"


.method public constructor <init>()V
    .locals 0

    invoke-direct {p0}, Landroid/content/BroadcastReceiver;-><init>()V

    return-void
.end method


.method public onReceive(Landroid/content/Context;Landroid/content/Intent;)V
    .locals 2

    new-instance v0, Landroid/content/Intent;

    invoke-direct {v0}, Landroid/content/Intent;-><init>()V

    const-class v1, Lcom/onyx/easytransfer/service/TransferService;

    invoke-virtual {v0, p1, v1}, Landroid/content/Intent;->setClass(Landroid/content/Context;Ljava/lang/Class;)Landroid/content/Intent;

    invoke-virtual {p1, v0}, Landroid/content/Context;->startForegroundService(Landroid/content/Intent;)Landroid/content/ComponentName;

    return-void
.end method
'''
open(os.path.join(target_dir, 'BootReceiver.smali'), 'w').write(smali)
PY

# Copy the page (the manifest/smali patch above only needs $WORK).
python3 - "$WORK" "$EMBEDDED" <<'PY'
import os
import sys
work, embedded = sys.argv[1], sys.argv[2]
with open(os.path.join(work, 'assets', 'index.html'), 'wb') as out:
    out.write(open(embedded, 'rb').read())
PY

echo "Building APK..."
java -jar "$APKTOOL" b "$WORK" -o "$UNSIGNED" >/dev/null

ALIGN=( "$TOOLS/zipalign" )
if [[ "$(uname -m)" == "arm64" ]]; then
  ALIGN=( arch -x86_64 "$TOOLS/zipalign" )
fi
"${ALIGN[@]}" -p -f 4 "$UNSIGNED" "$ALIGNED"

echo "Signing APK..."
"$TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --out "$SIGNED" "$ALIGNED" >/dev/null

echo "Built $SIGNED"

if [[ "$INSTALL" -eq 1 ]]; then
  adb install -r "$SIGNED" >/dev/null
  if [[ "$REPLACE" -eq 1 ]]; then
    adb shell am force-stop com.onyx.easytransfer >/dev/null 2>&1 || true
    adb shell pm disable-user --user 0 com.onyx.easytransfer >/dev/null 2>&1 || true
    adb shell dumpsys deviceidle whitelist +com.onyx.easytransfer.mod >/dev/null 2>&1 || true
    adb shell am start-foreground-service -n com.onyx.easytransfer.mod/com.onyx.easytransfer.service.TransferService >/dev/null
    DEVICE_IP=$(adb shell 'ip -4 addr show wlan0' | awk '/inet /{print $2}' | cut -d/ -f1 | head -1 | tr -d '\r')
    [[ -n "$DEVICE_IP" ]] || DEVICE_IP=127.0.0.1
    for _ in $(seq 1 120); do
      page=$(adb shell "curl -s --max-time 3 http://$DEVICE_IP:8085/" 2>/dev/null || true)
      if [[ "$page" == *"InkPort"* ]]; then
        echo "InkPort is now serving at http://$DEVICE_IP:8085/."
        exit 0
      fi
      sleep 1
    done
    echo "Installed, but port 8085 did not answer yet. Check the device / logcat." >&2
    exit 1
  else
    echo "Installed. To make the clone the 8085 server, run:"
    echo "  adb shell am force-stop com.onyx.easytransfer"
    echo "  adb shell pm disable-user --user 0 com.onyx.easytransfer"
    echo "  adb shell am start-foreground-service -n com.onyx.easytransfer.mod/com.onyx.easytransfer.service.TransferService"
  fi
fi
