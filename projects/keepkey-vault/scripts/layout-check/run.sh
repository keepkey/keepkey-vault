#!/bin/zsh
# Layout check in the vault's own engine (WebKit, offscreen): every swap screen
# at 1200x772 (the default 1200x800 window) and 1440x972. Prints one JSON per
# screen (probe.js) and writes a PNG beside it. Needs Xcode Command Line Tools.
#   zsh scripts/layout-check/run.sh            (from projects/keepkey-vault)
set -e
D=${0:A:h}
cd $D/../..
bun $D/build.ts
mkdir -p $D/out/assets && cp -R src/mainview/public/assets/token-icons $D/out/assets/
[[ -x $D/out/wkmeasure ]] || swiftc -O -o $D/out/wkmeasure $D/wkmeasure.swift
for vp in "1200 772" "1440 972"; do
  set -- ${=vp}
  for m in form review signing route-details health picker-from picker-from-confirm picker-from-empty picker-to picker-to-asset picker-to-confirm magi; do
    r=$($D/out/wkmeasure "file://$D/out/index.html?mode=$m" $1 $2 $D/probe.js $D/out/$m-$1.png 7 | sed -n 's/^PROBE_RESULT //p')
    echo "$m@$1x$2 $r"
  done
done
