#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
XIANGQI_BUILD_API_TOKEN=${VITE_XIANGQI_API_TOKEN:-}

if [ "${#XIANGQI_BUILD_API_TOKEN}" -lt 32 ]; then
    echo "Error: VITE_XIANGQI_API_TOKEN must contain the cloud test token." >&2
    exit 1
fi

pnpm --dir "$PROJECT_DIR/web" build

cd "$PROJECT_DIR/android"
./gradlew assembleDebug

APK_PATH="$PROJECT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
"$SCRIPT_DIR/verify-apk.sh" "$APK_PATH"

echo "APK: $APK_PATH"
