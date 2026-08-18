#!/bin/sh

set -eu

PACKAGE_NAME=com.xiangqitv.app
ACTIVITY_NAME="$PACKAGE_NAME/.MainActivity"
START_TIMEOUT_SECONDS=15

section() {
    printf '\n[%s]\n' "$1"
}

adb get-state >/dev/null

launch_app() {
    LAUNCH_ATTEMPT=1
    while [ "$LAUNCH_ATTEMPT" -le 3 ]; do
        adb shell input keyevent 3 >/dev/null
        adb shell am force-stop "$PACKAGE_NAME"
        START_OUTPUT=$(
            /usr/bin/perl -e 'alarm shift; exec @ARGV' \
                "$START_TIMEOUT_SECONDS" adb shell am start -W -n "$ACTIVITY_NAME" \
                2>/dev/null \
            || true
        )
        TOTAL_TIME=$(printf '%s\n' "$START_OUTPUT" | sed -n 's/^TotalTime: //p' | tr -d '\r')
        STARTED_ACTIVITY=$(printf '%s\n' "$START_OUTPUT" | sed -n 's/^Activity: //p' | tr -d '\r')
        if [ -n "$TOTAL_TIME" ] && [ "$STARTED_ACTIVITY" = "$ACTIVITY_NAME" ]; then
            return 0
        fi

        printf 'Launch attempt %s was intercepted by: %s\n' \
            "$LAUNCH_ATTEMPT" "${STARTED_ACTIVITY:-unknown}" >&2
        LAUNCH_ATTEMPT=$((LAUNCH_ATTEMPT + 1))
        sleep 1
    done

    printf '%s\n' "$START_OUTPUT" >&2
    return 1
}

section "Device"
printf 'Manufacturer: %s\n' "$(adb shell getprop ro.product.manufacturer | tr -d '\r')"
printf 'Model: %s\n' "$(adb shell getprop ro.product.model | tr -d '\r')"
printf 'API: %s\n' "$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
printf 'ABI list: %s\n' "$(adb shell getprop ro.product.cpu.abilist | tr -d '\r')"
adb shell wm size
adb shell wm density
adb shell dumpsys webviewupdate | rg -m 1 'Current WebView package'

section "Cold launch (3 runs)"
START_TIMES=""
for RUN_INDEX in 1 2 3; do
    if ! launch_app; then
        echo "Unable to collect a valid foreground launch for run $RUN_INDEX." >&2
        exit 1
    fi
    START_TIMES="$START_TIMES $TOTAL_TIME"
    printf 'Run %s: %sms\n' "$RUN_INDEX" "$TOTAL_TIME"
done
printf '%s\n' "$START_TIMES" | awk '{ total = 0; for (i = 1; i <= NF; i += 1) total += $i; printf "Average: %.0fms\n", total / NF }'

sleep 3
APP_PID=$(adb shell pidof "$PACKAGE_NAME" | tr -d '\r')
if [ -z "$APP_PID" ]; then
    echo "App process is not running after launch test." >&2
    exit 1
fi
printf 'PID: %s\n' "$APP_PID"

section "Idle CPU"
adb shell top -b -n 1 -p "$APP_PID" | head -n 8

section "Idle memory"
adb shell dumpsys meminfo "$PACKAGE_NAME" | awk '/App Summary/{show=1} show{print} /TOTAL SWAP PSS/{exit}'

section "Hard AI remote-control round"
adb shell dumpsys gfxinfo "$PACKAGE_NAME" reset >/dev/null

# Initial cursor is row 9, col 4. Enter the action area, switch to AI mode,
# select hard difficulty, return to the board, then move the red right rook.
for UNUSED in 1 2 3 4 5; do
    adb shell input keyevent 22
done
adb shell input keyevent 20
adb shell input keyevent 23
adb shell input keyevent 22
adb shell input keyevent 23
adb shell input keyevent 21
adb shell input keyevent 21
adb shell input keyevent 23
adb shell input keyevent 19
adb shell input keyevent 23

# Four one-second samples cover the hard difficulty's 3.2-second budget.
adb shell top -b -d 1 -n 4 -p "$APP_PID"

section "Post-AI memory"
adb shell dumpsys meminfo "$PACKAGE_NAME" | awk '/App Summary/{show=1} show{print} /TOTAL SWAP PSS/{exit}'

section "Post-AI rendering"
adb shell dumpsys gfxinfo "$PACKAGE_NAME" | sed -n '/Total frames rendered:/,/HISTOGRAM:/p'

section "Foreground"
adb shell dumpsys activity activities | rg -m 1 'mResumedActivity'

printf '\nDevice profile completed.\n'
