#!/usr/bin/env bash
set -euo pipefail

echo "Removing the InkPort (墨港) clone..."
adb uninstall com.onyx.easytransfer.mod >/dev/null 2>&1 || true

echo "Restoring and enabling the original BooxDrop..."
adb shell pm install-existing --user 0 com.onyx.easytransfer >/dev/null 2>&1 || true
adb shell pm enable com.onyx.easytransfer >/dev/null 2>&1 || true
adb shell pm enable --user 0 com.onyx.easytransfer >/dev/null 2>&1 || true
adb shell am start -n com.onyx.easytransfer/com.onyx.easytransfer.main.MainActivity >/dev/null

DEVICE_IP=$(adb shell 'ip -4 addr show wlan0' | awk '/inet /{print $2}' | cut -d/ -f1 | head -1 | tr -d '\r')
[[ -n "$DEVICE_IP" ]] || DEVICE_IP=127.0.0.1
for _ in $(seq 1 90); do
  page=$(adb shell "curl -s --max-time 3 http://$DEVICE_IP:8085/" 2>/dev/null || true)
  if [[ "$page" == *"BOOX Drop"* ]]; then
    echo "Original BooxDrop is serving at http://$DEVICE_IP:8085/."
    exit 0
  fi
  sleep 1
done

echo "Original restored, but port 8085 did not answer yet. Open the BooxDrop app or check logcat." >&2
exit 1
