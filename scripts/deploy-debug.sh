#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
APK_PATH="$PROJECT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
START_TIMEOUT_SECONDS=15

"$SCRIPT_DIR/build-android.sh"

adb get-state >/dev/null
adb install -r "$APK_PATH"
sleep 2

START_ATTEMPT=1
while [ "$START_ATTEMPT" -le 3 ]; do
    adb shell input keyevent 3 >/dev/null
    adb shell am force-stop com.xiangqitv.app
    START_OUTPUT=$(
        /usr/bin/perl -e 'alarm shift; exec @ARGV' \
            "$START_TIMEOUT_SECONDS" adb shell am start -W \
            -n com.xiangqitv.app/.MainActivity 2>/dev/null \
            || true
    )
    STARTED_ACTIVITY=$(printf '%s\n' "$START_OUTPUT" | sed -n 's/^Activity: //p' | tr -d '\r')
    if [ "$STARTED_ACTIVITY" = "com.xiangqitv.app/.MainActivity" ]; then
        break
    fi

    printf 'Start attempt %s was intercepted by: %s\n' \
        "$START_ATTEMPT" "${STARTED_ACTIVITY:-unknown}" >&2
    START_ATTEMPT=$((START_ATTEMPT + 1))
    sleep 1
done
printf '%s\n' "$START_OUTPUT"

if [ "$STARTED_ACTIVITY" != "com.xiangqitv.app/.MainActivity" ]; then
    echo "Deployment failed: unable to foreground Xiangqi TV after 3 attempts." >&2
    exit 1
fi

APP_PID=$(adb shell pidof com.xiangqitv.app | tr -d '\r')
if [ -z "$APP_PID" ]; then
    echo "Deployment failed: app process is not running." >&2
    exit 1
fi

FOREGROUND_ATTEMPT=1
RESUMED_ACTIVITY=""
while [ "$FOREGROUND_ATTEMPT" -le 3 ]; do
    RESUMED_ACTIVITY=$(adb shell dumpsys activity activities \
        | rg -m 1 '(mResumedActivity|ResumedActivity).*com\.xiangqitv\.app/.MainActivity' \
        || true)
    if [ -n "$RESUMED_ACTIVITY" ]; then
        break
    fi
    FOREGROUND_ATTEMPT=$((FOREGROUND_ATTEMPT + 1))
    sleep 1
done

if [ -z "$RESUMED_ACTIVITY" ]; then
    echo "Deployment failed: Xiangqi TV is not the foreground activity." >&2
    printf 'Foreground: %s\n' "$RESUMED_ACTIVITY" >&2
    exit 1
fi

echo "Deployment passed"
echo "Device: ${ANDROID_SERIAL:-default adb device}"
echo "PID: $APP_PID"
