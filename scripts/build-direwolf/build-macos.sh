#!/usr/bin/env bash
# Rebuilds Direwolf (github.com/wb2osz/direwolf, GPL-2.0-or-later) from
# source for the current Mac's architecture and vendors it into
# direwolf/darwin/<arch>/ for bundling into NexPack releases (see
# electron/main/soundmodem/SoundModemManager.js's _resolveBinaryPath and
# package.json's "mac".extraResources).
#
# Why build from source instead of using Direwolf's own distribution: there
# is no official standalone macOS binary (only a Homebrew bottle, which is
# dynamically linked against Homebrew-installed libs and won't run on a
# machine that never had Homebrew). Building it ourselves and then using
# dylibbundler to vendor its two real dependencies (portaudio, hidapi) as
# self-contained .dylibs next to the binary, with their load paths rewritten
# to @executable_path/libs/, produces a binary that runs standalone — verified
# with `env -i ./direwolf` (a completely empty environment, no PATH/DYLD
# vars) to prove nothing about it depends on Homebrew being present.
#
# Pinned to a tagged release (not a moving HEAD) so this script reproduces
# the exact same source every time it's run; bump DIREWOLF_REF deliberately
# when picking up a new Direwolf release.
set -euo pipefail

DIREWOLF_REF="1.8.1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="${REPO_ROOT}/build-direwolf"
ARCH="$(uname -m)"
ARCH_DIR=$([ "$ARCH" = "arm64" ] && echo "arm64" || echo "x64")
OUT_DIR="${REPO_ROOT}/direwolf/darwin/${ARCH_DIR}"

for dep in cmake portaudio hidapi dylibbundler; do
  brew list "$dep" >/dev/null 2>&1 || brew install "$dep"
done

if [ ! -d "${WORK_DIR}/src" ]; then
  git clone https://github.com/wb2osz/direwolf.git "${WORK_DIR}/src"
fi
cd "${WORK_DIR}/src"
git fetch --tags origin
git checkout "${DIREWOLF_REF}"

rm -rf build
mkdir build
cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j"$(sysctl -n hw.ncpu)" direwolf

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/libs"
cp src/direwolf "${OUT_DIR}/direwolf"

dylibbundler -od -b \
  -x "${OUT_DIR}/direwolf" \
  -d "${OUT_DIR}/libs" \
  -p '@executable_path/libs/'

cp "${WORK_DIR}/src/LICENSE" "${REPO_ROOT}/direwolf/DIREWOLF-LICENSE.txt"

echo "Checking the binary has no leftover Homebrew-path dependencies..."
if otool -L "${OUT_DIR}/direwolf" "${OUT_DIR}"/libs/*.dylib | grep -q "$(brew --prefix)"; then
  echo "ERROR: a dependency still points into $(brew --prefix) — dylibbundler didn't vendor everything." >&2
  exit 1
fi

echo "Built: ${OUT_DIR}/direwolf ($(du -sh "${OUT_DIR}" | cut -f1))"
