#!/usr/bin/env bash
# Cross-compiles Direwolf for Windows x64 using mingw-w64 from macOS, and
# vendors the result into direwolf/win32/direwolf.exe.
#
# Unlike macOS/Linux, Direwolf's Windows backend needs no external
# libraries at all (audio is WINMM, PTT device enumeration is SETUPAPI, its
# HID/CM108 support uses a copy of hidapi vendored IN Direwolf's own source
# tree rather than an external hidapi like the macOS build needs) — so
# there's nothing to vendor. `-static-libgcc -static -lpthread` in
# mingw-toolchain.cmake statically links the two runtime DLLs
# (libgcc_s_seh-1.dll, libwinpthread-1.dll) MinGW would otherwise require
# alongside the .exe, so this ships as one file. Confirmed via
# `objdump -p direwolf.exe` that the only remaining imports are stock
# Windows system DLLs (KERNEL32, WINMM, WS2_32, SETUPAPI, the Universal CRT
# api-ms-win-crt-* set that ships with Windows 10+) — nothing MinGW-specific
# left. Not runtime-tested here (no Wine available in this environment);
# verify once on a real Windows machine (or under Wine) before shipping.
set -euo pipefail

DIREWOLF_REF="1.8.1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="${REPO_ROOT}/build-direwolf"
OUT_DIR="${REPO_ROOT}/direwolf/win32"

brew list mingw-w64 >/dev/null 2>&1 || brew install mingw-w64

if [ ! -d "${WORK_DIR}/src" ]; then
  git clone https://github.com/wb2osz/direwolf.git "${WORK_DIR}/src"
fi
cd "${WORK_DIR}/src"
git fetch --tags origin
git checkout "${DIREWOLF_REF}"

rm -rf build-win
mkdir build-win
cd build-win
cmake .. \
  -DCMAKE_TOOLCHAIN_FILE="${REPO_ROOT}/scripts/build-direwolf/mingw-toolchain.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DOPTIONAL_DNSSD=OFF
make -j"$(sysctl -n hw.ncpu)" direwolf

x86_64-w64-mingw32-strip src/direwolf.exe

mkdir -p "${OUT_DIR}"
cp src/direwolf.exe "${OUT_DIR}/direwolf.exe"
cp "${WORK_DIR}/src/LICENSE" "${REPO_ROOT}/direwolf/DIREWOLF-LICENSE.txt"

echo "Checking for non-stock DLL dependencies..."
if x86_64-w64-mingw32-objdump -p "${OUT_DIR}/direwolf.exe" | grep "DLL Name" | grep -viq "KERNEL32\|WINMM\|WS2_32\|SETUPAPI\|api-ms-win-crt\|USER32\|ADVAPI32\|SHELL32\|ole32"; then
  echo "WARNING: found a DLL dependency outside the expected stock-Windows set — check objdump output above." >&2
fi

echo "Built: ${OUT_DIR}/direwolf.exe ($(du -sh "${OUT_DIR}" | cut -f1))"
