#!/usr/bin/env bash
# Build an axi tarball and publish to GitHub Releases (Aquinf03/axi).
# Requires: gh authenticated (`gh auth login`), push access to the repo.
#
# Run from the axi workspace (polyrepo) so web/ + root install.sh are available:
#   npm run release --prefix axi-backend -- 0.0.4
#   # or:  bash axi-backend/scripts/helpers/release.sh 0.0.4
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Prefer the workspace root (parent of axi-backend) when this is a submodule checkout.
if [ -f "$PKG/../install.sh" ] || [ -f "$PKG/../.axi_root" ] || [ -f "$PKG/../.gitmodules" ]; then
  ROOT="$(cd "$PKG/.." && pwd)"
else
  ROOT="$PKG"
fi

VERSION="${1:?usage: release.sh <version>  e.g. 0.0.4}"
REPO="${AXI_GH_REPO:-Aquinf03/axi}"
TAG="v${VERSION}"
INSTALL_SH="${AXI_INSTALL_SH:-$ROOT/install.sh}"

# axi-v0.0.4.tar.gz · axi-vlatest.tar.gz  (v prefix, not suffix)
release_object_name() {
  echo "axi-v${1}.tar.gz"
}

command -v gh >/dev/null || {
  echo "gh CLI required: https://cli.github.com/ — then gh auth login" >&2
  exit 1
}

if [ ! -f "$INSTALL_SH" ]; then
  echo "install.sh not found at $INSTALL_SH" >&2
  echo "Expected at the axi workspace root (not inside axi-backend)." >&2
  exit 1
fi

TMP="$(mktemp -d)"
STAGE="$TMP/stage"
VERSIONED="$TMP/$(release_object_name "$VERSION")"
LATEST="$TMP/$(release_object_name latest)"
INSTALL_COPY="$TMP/install.sh"
trap 'rm -rf "$TMP"' EXIT

echo "Building axi ..."
(cd "$PKG" && npm run build)

echo "Staging package under axi/ ..."
mkdir -p "$STAGE/axi"
# Runtime package surface (matches package.json "files" + lock for reproducible npm install)
cp "$PKG/package.json" "$STAGE/axi/"
cp "$PKG/package-lock.json" "$STAGE/axi/"
mkdir -p "$STAGE/axi/bin"
# Portable launcher only — never ship a local absolute node / dist path.
printf '%s\n' '#!/usr/bin/env node' 'import "../dist/cli.js"' >"$STAGE/axi/bin/axi"
chmod +x "$STAGE/axi/bin/axi"
cp -R "$PKG/dist" "$PKG/assets" "$STAGE/axi/"
# scripts/ is listed in package files (job-wait helpers etc.)
cp -R "$PKG/scripts" "$STAGE/axi/"
# browser UI (axi web / /web) — source only; first run npm installs deps
if [ -d "$ROOT/web" ]; then
  mkdir -p "$STAGE/axi/web"
  tar -C "$ROOT/web" \
    --exclude=node_modules \
    --exclude=.next \
    --exclude='web/.next' \
    -cf - . | tar -C "$STAGE/axi/web" -xf -
fi
# Drop local eval workdirs / huge fixtures from the published tree
rm -rf "$STAGE/axi/scripts/tests/.work" 2>/dev/null || true

# Hard fail if anything personal / host-absolute slipped into the package bin.
if grep -E '/home/|cursor-agent|\\\\Users\\\\' "$STAGE/axi/bin/axi" >/dev/null 2>&1; then
  echo "refusing to release: axi/bin/axi contains a host-specific path" >&2
  cat "$STAGE/axi/bin/axi" >&2
  exit 1
fi

cp "$INSTALL_SH" "$ROOT/README.md" "$ROOT/LICENSE" "$STAGE/" 2>/dev/null || {
  cp "$INSTALL_SH" "$STAGE/"
  cp "$PKG/README.md" "$STAGE/README.md" 2>/dev/null || true
  cp "$ROOT/LICENSE" "$STAGE/LICENSE" 2>/dev/null || cp "$PKG/LICENSE" "$STAGE/LICENSE" 2>/dev/null || true
}
cp "$ROOT/README.md" "$ROOT/LICENSE" "$STAGE/axi/" 2>/dev/null || true

echo "Packing tarball ..."
tar czf "$VERSIONED" -C "$STAGE" axi install.sh README.md LICENSE
cp "$VERSIONED" "$LATEST"
cp "$INSTALL_SH" "$INSTALL_COPY"

NOTES="axi ${VERSION}"
if [ -f "$ROOT/CHANGELOG.md" ]; then
  NOTES="axi ${VERSION}

See CHANGELOG.md in the repository for details."
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Updating existing release ${TAG} ..."
  gh release upload "$TAG" "$VERSIONED" "$LATEST" "$INSTALL_COPY" \
    --repo "$REPO" --clobber
else
  echo "Creating release ${TAG} ..."
  gh release create "$TAG" "$VERSIONED" "$LATEST" "$INSTALL_COPY" \
    --repo "$REPO" \
    --title "axi ${VERSION}" \
    --notes "$NOTES" \
    --latest
fi

echo ""
echo "Published:"
echo "  https://github.com/${REPO}/releases/tag/${TAG}"
echo "  https://github.com/${REPO}/releases/latest/download/install.sh"
echo "  https://github.com/${REPO}/releases/latest/download/$(release_object_name latest)"
echo "  https://github.com/${REPO}/releases/download/${TAG}/$(release_object_name "$VERSION")"
