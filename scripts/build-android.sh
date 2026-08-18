#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")

pnpm --dir "$PROJECT_DIR/web" build

cd "$PROJECT_DIR/android"
./gradlew assembleDebug

APK_PATH="$PROJECT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
"$SCRIPT_DIR/verify-apk.sh" "$APK_PATH"

echo "APK: $APK_PATH"
