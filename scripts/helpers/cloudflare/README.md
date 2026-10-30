# axi releases (GitHub Releases)

Same path as **aq**: packaged tarballs + `install.sh` are published as GitHub Release assets on **Aquinf03/axi** (the workspace / frontend repo — not the `axi-backend` submodule alone).

> Cloudflare R2 was retired for axi. The scripts under this folder are historical; use `scripts/helpers/release.sh`.

## Public URLs

```
https://github.com/Aquinf03/axi/releases/latest/download/install.sh
https://github.com/Aquinf03/axi/releases/latest/download/axi-vlatest.tar.gz
https://github.com/Aquinf03/axi/releases/download/v<version>/axi-v<version>.tar.gz
```

`install.sh` lives at the **workspace root** (`Aquinf03/axi/install.sh`), not inside `axi-backend/`, so it can be attached as a release asset.

## Publish a release

From the axi workspace (polyrepo with submodule checked out):

```bash
# requires: gh auth login, push access to Aquinf03/axi
chmod +x install.sh axi-backend/scripts/helpers/release.sh
npm run release --prefix axi-backend -- 0.0.4
# or: bash axi-backend/scripts/helpers/release.sh 0.0.4
```

This builds the backend package, packs `axi-v*.tar.gz` (includes `web/` when present), and uploads:

- `install.sh`
- `axi-v<version>.tar.gz`
- `axi-vlatest.tar.gz`

Override the GitHub repo with `AXI_GH_REPO=owner/name` if needed.

## Team install

```bash
curl -fsSL https://github.com/Aquinf03/axi/releases/latest/download/install.sh | bash
```

Override tarball: `AXI_RELEASE_URL=https://github.com/Aquinf03/axi/releases/download/v0.0.4/axi-v0.0.4.tar.gz bash`.

## From a checkout

```bash
git clone --recurse-submodules https://github.com/Aquinf03/axi.git
cd axi
./install.sh
```
