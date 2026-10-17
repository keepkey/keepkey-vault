#!/bin/bash
# AppImage entry point (copied to AppDir/AppRun by the Linux packaging step).
#
# An AppImage cannot declare package dependencies the way the .deb does, so a
# system without WebKitGTK 4.1 or Ayatana AppIndicator used to fail inside the
# app: the native layer did not load and the user got a JavaScript stack trace
# ("null is not an object (evaluating 'bridge.requestHost')"). Check the
# libraries the native layer links against first and name the packages.
SELF=$(readlink -f "$0")
HERE=${SELF%/*}
BIN="$HERE/usr/bin/bin"

# libasar.so ships next to libNativeWrapper.so, hence LD_LIBRARY_PATH. No ldd,
# or nothing missing, leaves $missing empty and the app starts as before.
missing=$(LD_LIBRARY_PATH="$BIN${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$BIN/libNativeWrapper.so" 2>/dev/null \
  | awk '/=> not found/ { print $1 }' | sort -u)

if [ -n "$missing" ]; then
  ID=""; ID_LIKE=""
  [ -r /etc/os-release ] && . /etc/os-release
  case "$ID $ID_LIKE" in
    *debian*|*ubuntu*) fix="sudo apt install libwebkit2gtk-4.1-0 libayatana-appindicator3-1" ;;
    *fedora*|*rhel*)   fix="sudo dnf install webkit2gtk4.1 libayatana-appindicator-gtk3" ;;
    *suse*)            fix="sudo zypper install libwebkit2gtk-4_1-0 libayatana-appindicator3-1" ;;
    *arch*)            fix="sudo pacman -S webkit2gtk-4.1 libayatana-appindicator" ;;
    *)                 fix="Install WebKitGTK 4.1 and Ayatana AppIndicator 3 with your package manager." ;;
  esac
  msg="KeepKey Desktop cannot start. These system libraries are missing:

$missing

To install them:
$fix"
  echo "$msg" >&2
  # Launched from a file manager there is no terminal to read, so show a dialog.
  if command -v zenity >/dev/null 2>&1; then zenity --error --title="KeepKey Desktop" --text="$msg" 2>/dev/null
  elif command -v kdialog >/dev/null 2>&1; then kdialog --title "KeepKey Desktop" --error "$msg" 2>/dev/null
  elif command -v xmessage >/dev/null 2>&1; then xmessage "$msg" 2>/dev/null
  fi
  exit 1
fi

exec "$BIN/launcher" "$@"
