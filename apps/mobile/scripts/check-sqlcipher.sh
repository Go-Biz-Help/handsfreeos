#!/usr/bin/env bash
# Checks that a build of the phone app really encrypts its database with SQLCipher. op-sqlite reads its SQLCipher
# switch from the monorepo's root package.json on iOS and from apps/mobile/package.json on Android; with it in the wrong
# place the build quietly uses plain SQLite and ignores the key (spike 1a). The app refuses to keep a copy then, but a
# build should never get that far.
#
#   pnpm --filter @hfos/mobile check:sqlcipher ios                    runs `pod install` in apps/mobile/ios (after
#                                                                     `npx expo prebuild --platform ios`) and checks it
#   pnpm --filter @hfos/mobile check:sqlcipher android <gradle log>   checks a Gradle build's log (CI's Android job
#                                                                     checks its own log the same way)
#
# iOS passes when the pod log says "[OP-SQLITE] using SQLCipher" and Podfile.lock has op-sqlite depending on
# OpenSSL-Universal; Android when the Gradle log says "[OP-SQLITE] using sqlcipher.".
set -euo pipefail

app="$(cd "$(dirname "$0")/.." && pwd)"
platform="${1:-}"

case "$platform" in
  ios)
    if [[ ! -f "$app/ios/Podfile" ]]; then
      echo "There's no apps/mobile/ios yet. Make it first: npx expo prebuild --platform ios" >&2
      exit 1
    fi
    log="$(mktemp)"
    trap 'rm -f "$log"' EXIT
    # CocoaPods stops without a UTF-8 locale.
    (cd "$app/ios" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install) 2>&1 | tee "$log"
    if ! grep -q '\[OP-SQLITE\] using SQLCipher' "$log"; then
      echo "op-sqlite didn't say it's using SQLCipher: the iPhone build would store plain SQLite." >&2
      echo "Check \"op-sqlite\": { \"sqlcipher\": true } in the root package.json." >&2
      exit 1
    fi
    # op-sqlite's own entry in the lock, down to the next pod, must list OpenSSL-Universal (SQLCipher's crypto).
    if ! awk '/^  - op-sqlite \(/{inside=1; next} inside && /^  - /{inside=0} inside && /OpenSSL-Universal/{found=1} END{exit !found}' "$app/ios/Podfile.lock"; then
      echo "Podfile.lock has op-sqlite without OpenSSL-Universal: SQLCipher isn't in the iPhone build." >&2
      exit 1
    fi
    echo "The iPhone build uses SQLCipher: op-sqlite says so, and it depends on OpenSSL-Universal."
    ;;
  android)
    gradle_log="${2:-}"
    if [[ -z "$gradle_log" || ! -f "$gradle_log" ]]; then
      echo "Give the log of a Gradle build: check-sqlcipher.sh android <gradle log>" >&2
      exit 1
    fi
    if ! grep -q '\[OP-SQLITE\] using sqlcipher' "$gradle_log"; then
      echo "op-sqlite didn't say it's using SQLCipher: the Android build would store plain SQLite." >&2
      echo "Check \"op-sqlite\": { \"sqlcipher\": true } in apps/mobile/package.json." >&2
      exit 1
    fi
    echo "The Android build uses SQLCipher: op-sqlite says so in the Gradle log."
    ;;
  *)
    echo "Usage: check-sqlcipher.sh ios | android <gradle log>" >&2
    exit 1
    ;;
esac
