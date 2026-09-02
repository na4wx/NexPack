#!/usr/bin/env bash
# Builds Direwolf for Linux (x64 and arm64) inside Debian containers via
# Docker, and vendors the resulting binaries into direwolf/linux/<arch>/.
# Same reasoning as build-macos.sh: no official portable Linux binary
# exists, only distro packages, so we build our own.
#
# Unlike macOS (which needed dylibbundler because Direwolf pulls in
# Homebrew-installed portaudio/hidapi), Direwolf's Linux backend uses ALSA
# (libasound2) and udev directly — both are effectively universal on any
# Debian/Ubuntu desktop or server (libasound2 is a base multimedia
# dependency, libudev ships with systemd) — so the binary is left
# dynamically linked against the *system* copies of those rather than
# vendored; NexPack's own .deb packaging can declare them as dependencies
# the same way any other Linux desktop app does, instead of bundling them.
# Verified with `ldd` below that nothing resolves back into the build
# container's toolchain paths.
set -euo pipefail

DIREWOLF_REF="1.8.1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

build_arch() {
  local docker_platform="$1" out_arch="$2"
  local out_dir="${REPO_ROOT}/direwolf/linux/${out_arch}"
  echo "=== Building direwolf for linux/${out_arch} ==="
  docker run --rm --platform "${docker_platform}" \
    -v "${REPO_ROOT}:/repo" \
    debian:bookworm-slim \
    bash -c "
      set -euo pipefail
      apt-get update -qq
      apt-get install -y -qq --no-install-recommends \
        build-essential cmake git ca-certificates libasound2-dev libudev-dev >/dev/null
      rm -rf /tmp/direwolf-src
      git clone --quiet https://github.com/wb2osz/direwolf.git /tmp/direwolf-src
      cd /tmp/direwolf-src
      git checkout --quiet '${DIREWOLF_REF}'
      mkdir build && cd build
      cmake .. -DCMAKE_BUILD_TYPE=Release >/dev/null
      make -j\"\$(nproc)\" direwolf
      strip src/direwolf
      mkdir -p /repo/direwolf/linux/${out_arch}
      cp src/direwolf /repo/direwolf/linux/${out_arch}/direwolf
      echo 'Runtime deps:'
      ldd /repo/direwolf/linux/${out_arch}/direwolf
      cp /tmp/direwolf-src/LICENSE /repo/direwolf/DIREWOLF-LICENSE.txt
    "
  echo "Built: ${out_dir}/direwolf ($(du -sh "${out_dir}" | cut -f1))"
}

build_arch "linux/amd64" "x64"
build_arch "linux/arm64" "arm64"
