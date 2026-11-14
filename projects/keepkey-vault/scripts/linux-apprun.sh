#!/bin/bash
# AppImage entry point (copied to AppDir/AppRun by the Linux packaging step).
#
# An AppImage cannot declare package dependencies the way the .deb does, so a
# system without WebKitGTK 4.1 used to fail inside the app: the native layer did
# not load and the user got a JavaScript stack trace ("null is not an object
# (evaluating 'bridge.requestHost')"). Check the libraries the native layer
# links against first and name the packages.
#
# The AppImage bundles the tray stack (Ayatana AppIndicator + dbusmenu) next to
# libNativeWrapper.so in usr/bin/bin. The Electrobun 2.x launcher puts that
# directory first on LD_LIBRARY_PATH, and the native wrapper dlopens
# AppIndicator when the tray is created (without it the app runs trayless).
# Normally only WebKitGTK can be missing — it is too big and too coupled to the
# host (helper subprocesses, GStreamer, Mesa) to bundle.
SELF=$(readlink -f "$0")
HERE=${SELF%/*}
BIN="$HERE/usr/bin/bin"

# $BIN holds libasar.so and the bundled tray stack. Exported for the ldd check
# below and as a belt-and-braces for the launcher, which sets it anyway.
export LD_LIBRARY_PATH="$BIN${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# No ldd, or nothing missing, leaves $missing empty and the app starts as before.
missing=$(ldd "$BIN/libNativeWrapper.so" 2>/dev/null \
  | awk '/=> not found/ { print $1 }' | sort -u)

if [ -n "$missing" ]; then
  ID=""; ID_LIKE=""
  # KK_APPRUN_OS_RELEASE: test override only.
  OS_RELEASE="${KK_APPRUN_OS_RELEASE:-/etc/os-release}"
  [ -r "$OS_RELEASE" ] && . "$OS_RELEASE"
  case "$ID $ID_LIKE" in
    *debian*|*ubuntu*) pm="sudo apt install";    webkit_pkg="libwebkit2gtk-4.1-0"; tray_pkg="libayatana-appindicator3-1" ;;
    *fedora*|*rhel*)   pm="sudo dnf install";    webkit_pkg="webkit2gtk4.1";       tray_pkg="libayatana-appindicator-gtk3" ;;
    *suse*)            pm="sudo zypper install"; webkit_pkg="libwebkit2gtk-4_1-0"; tray_pkg="libayatana-appindicator3-1" ;;
    *arch*)            pm="sudo pacman -S";      webkit_pkg="webkit2gtk-4.1";      tray_pkg="libayatana-appindicator" ;;
    *)                 pm="";                    webkit_pkg="WebKitGTK 4.1";       tray_pkg="Ayatana AppIndicator 3" ;;
  esac

  # Name only the packages that cover what is actually missing.
  pkgs=""
  case "$missing" in *webkit2gtk*|*javascriptcoregtk*|*soup*) pkgs="$webkit_pkg" ;; esac
  case "$missing" in *ayatana*|*appindicator*|*dbusmenu*) pkgs="${pkgs:+$pkgs }$tray_pkg" ;; esac

  if [ -n "$pm" ] && [ -n "$pkgs" ]; then
    fix="$pm $pkgs"
  elif [ -n "$pkgs" ]; then
    fix="Install $pkgs with your package manager."
  else
    fix="Use your system package manager."
  fi

  msg="KeepKey Vault cannot start. These system libraries are missing:

$missing

To install them:
$fix"
  echo "$msg" >&2
  # Launched from a file manager there is no terminal to read, so show a dialog.
  if command -v zenity >/dev/null 2>&1; then zenity --error --title="KeepKey Vault" --text="$msg" 2>/dev/null
  elif command -v kdialog >/dev/null 2>&1; then kdialog --title "KeepKey Vault" --error "$msg" 2>/dev/null
  elif command -v xmessage >/dev/null 2>&1; then xmessage "$msg" 2>/dev/null
  fi
  exit 1
fi

exec "$BIN/launcher" "$@"
