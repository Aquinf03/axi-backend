#!/usr/bin/env bash
# Compatibility stub — install.sh lives at the axi workspace root so GitHub
# Releases on Aquinf03/axi can attach it as an asset.
#   https://github.com/Aquinf03/axi/releases/latest/download/install.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

if [ -f "$ROOT/install.sh" ] && {
  [ -f "$ROOT/.gitmodules" ] || [ -f "$ROOT/.axi_root" ] || [ -d "$ROOT/web" ]
}; then
  exec bash "$ROOT/install.sh" "$@"
fi

echo "install.sh moved to the axi workspace root." >&2
echo "  curl -fsSL https://github.com/Aquinf03/axi/releases/latest/download/install.sh | bash" >&2
echo "  or: git clone --recurse-submodules https://github.com/Aquinf03/axi.git && ./install.sh" >&2
exit 1
