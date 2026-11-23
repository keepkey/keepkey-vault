# Sourced by both platform builders. The independent alpha checkout is frozen
# once by alpha-emulator-source.mjs; neither builder resolves a moving branch.
: "${EMU_FIRMWARE_SOURCE_DIR:?Resolve the fork alpha source before building emulator libraries}"
: "${EMU_FIRMWARE_SHA:?The alpha emulator source must have an exact commit}"
FW_DIR="$EMU_FIRMWARE_SOURCE_DIR"
SOURCE_SHA="$(git -C "$FW_DIR" rev-parse HEAD)"
[ "$SOURCE_SHA" = "$EMU_FIRMWARE_SHA" ] || {
  echo "ERROR: emulator source $SOURCE_SHA differs from frozen alpha $EMU_FIRMWARE_SHA" >&2
  exit 1
}
[ -z "$(git -C "$FW_DIR" status --porcelain --untracked-files=no)" ] || {
  echo 'ERROR: emulator source or dependency checkout is modified' >&2
  exit 1
}
