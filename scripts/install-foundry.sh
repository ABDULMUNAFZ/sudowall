#!/usr/bin/env bash
# Installs a pinned Foundry release (anvil, cast) into ${FOUNDRY_DIR:-$HOME/.foundry}/bin after
# checking its SHA-256 against the value pinned here. Used by `pnpm demo:setup` and CI.
# No `curl | bash`: the tarball is verified before anything is unpacked.
set -euo pipefail

VERSION="v1.8.6"
case "$(uname -s)_$(uname -m)" in
  Linux_x86_64) PLATFORM=linux_amd64; SHA=58850106984038f3a7200f38a4182c8cb423d3a4f4c7848eacbc2453e6bc35fc ;;
  Linux_aarch64) PLATFORM=linux_arm64; SHA=ca61f3f6e7d635f34e3e174409964d29126fa135794cd84cead8919dd50e0930 ;;
  Darwin_arm64) PLATFORM=darwin_arm64; SHA=d6bc05ee937b4308bded496068728c8ba140abe49dd7527f37e025bc335b91ec ;;
  Darwin_x86_64) PLATFORM=darwin_amd64; SHA=c0b032cdfda5fdce75ab6b782785f3f28aaf431bd55daecfb6437d01369f235e ;;
  *) echo "install-foundry: unsupported platform $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

DEST="${FOUNDRY_DIR:-$HOME/.foundry}/bin"
if [ -x "$DEST/anvil" ] && "$DEST/anvil" --version 2>/dev/null | grep -q "${VERSION#v}"; then
  echo "anvil ${VERSION} already installed in $DEST"
  exit 0
fi

TARBALL="foundry_${VERSION}_${PLATFORM}.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$TARBALL" "https://github.com/foundry-rs/foundry/releases/download/${VERSION}/${TARBALL}"
if command -v sha256sum >/dev/null; then
  echo "$SHA  $TMP/$TARBALL" | sha256sum -c - >/dev/null
else
  echo "$SHA  $TMP/$TARBALL" | shasum -a 256 -c - >/dev/null
fi
mkdir -p "$DEST"
tar -xzf "$TMP/$TARBALL" -C "$TMP" anvil cast
install -m 0755 "$TMP/anvil" "$TMP/cast" "$DEST/"
echo "installed anvil and cast ${VERSION} (sha256 verified) into $DEST"
