#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
APK_PATH=${1:-"$PROJECT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"}

if [ ! -f "$APK_PATH" ]; then
    echo "APK not found: $APK_PATH" >&2
    exit 1
fi

if [ -n "${XIANGQI_ANDROID_SDK:-}" ]; then
    XIANGQI_SDK_ROOT=$XIANGQI_ANDROID_SDK
elif [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    XIANGQI_SDK_ROOT=$ANDROID_SDK_ROOT
elif [ -n "${ANDROID_HOME:-}" ]; then
    XIANGQI_SDK_ROOT=$ANDROID_HOME
elif [ -f "$PROJECT_DIR/android/local.properties" ]; then
    XIANGQI_SDK_ROOT=$(sed -n 's/^sdk.dir=//p' "$PROJECT_DIR/android/local.properties")
else
    echo "Android SDK not found. Set XIANGQI_ANDROID_SDK or create android/local.properties." >&2
    exit 1
fi

APKSIGNER="$XIANGQI_SDK_ROOT/build-tools/36.0.0/apksigner"
APK_ANALYZER="$XIANGQI_SDK_ROOT/cmdline-tools/latest/bin/apkanalyzer"

if [ ! -x "$APKSIGNER" ]; then
    echo "apksigner not found: $APKSIGNER" >&2
    exit 1
fi
if [ ! -x "$APK_ANALYZER" ]; then
    echo "apkanalyzer not found: $APK_ANALYZER" >&2
    exit 1
fi

unzip -tq "$APK_PATH"

APK_ENTRIES=$(unzip -Z1 "$APK_PATH")
printf '%s\n' "$APK_ENTRIES" | rg -q '^assets/index\.html$'
printf '%s\n' "$APK_ENTRIES" | rg -q '^assets/assets/index-.*\.js$'
printf '%s\n' "$APK_ENTRIES" | rg -q '^assets/assets/index-.*\.css$'
printf '%s\n' "$APK_ENTRIES" | rg -q '^assets/assets/ai\.worker-.*\.js$'
printf '%s\n' "$APK_ENTRIES" | rg -q '^res/raw/xiangqi_server_ca\.pem$'
printf '%s\n' "$APK_ENTRIES" | rg -q '^res/xml/network_security_config\.xml$'

if printf '%s\n' "$APK_ENTRIES" | rg -q '^lib/'; then
    echo "Unexpected native libraries found; armeabi-v7a compatibility must be reviewed." >&2
    exit 1
fi

APK_PERMISSIONS=$("$APK_ANALYZER" manifest permissions "$APK_PATH" 2>/dev/null)
EXPECTED_PERMISSIONS=android.permission.INTERNET
if [ "$APK_PERMISSIONS" != "$EXPECTED_PERMISSIONS" ]; then
    echo "Unexpected Android permissions:" >&2
    printf '%s\n' "${APK_PERMISSIONS:-none}" >&2
    exit 1
fi

"$APKSIGNER" verify --verbose "$APK_PATH"

APK_SHA256=$(shasum -a 256 "$APK_PATH" | awk '{print $1}')
APK_SIZE=$(stat -f '%z' "$APK_PATH")

echo "APK verification passed"
echo "File: $APK_PATH"
echo "Size: $APK_SIZE bytes"
echo "SHA-256: $APK_SHA256"
echo "Permissions: android.permission.INTERNET only"
echo "Packaged assets: HTML + JS + CSS + local AI Worker + pinned server CA"
