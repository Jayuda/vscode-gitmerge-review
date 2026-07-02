#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# publish.sh — Build & publish GitMerge Review to the VS Code Marketplace
#
# Usage:
#   ./publish.sh                # publish current version in package.json
#   ./publish.sh 1.2.3          # set exact version, then publish
#   ./publish.sh patch          # bump patch (0.1.26 → 0.1.27), then publish
#   ./publish.sh minor          # bump minor, then publish
#   ./publish.sh major          # bump major, then publish
#   ./publish.sh patch --ovsx   # also publish to Open VSX (needs OVSX_PAT)
#
# Auth:
#   VSCE_PAT   Personal Access Token for the Marketplace (publisher: vneu).
#              Create at https://dev.azure.com → User settings → Personal
#              access tokens → scope "Marketplace (Manage)".
#              export VSCE_PAT=xxxx   (or vsce will prompt interactively)
#   OVSX_PAT   Token for https://open-vsx.org (only needed with --ovsx)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUMP="${1:-}"
PUBLISH_OVSX=false
for arg in "$@"; do
  [[ "$arg" == "--ovsx" ]] && PUBLISH_OVSX=true
done

# ── 1. Optional version bump ─────────────────────────────────────────────────
if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "→ Setting version to $BUMP"
  npm version "$BUMP" --no-git-tag-version >/dev/null
elif [[ "$BUMP" == "patch" || "$BUMP" == "minor" || "$BUMP" == "major" ]]; then
  echo "→ Bumping $BUMP version"
  npm version "$BUMP" --no-git-tag-version >/dev/null
fi

VERSION=$(node -e "process.stdout.write(require('./package.json').version)")
NAME=$(node -e "process.stdout.write(require('./package.json').name)")
PUBLISHER=$(node -e "process.stdout.write(require('./package.json').publisher)")
OUTFILE="${NAME}-${VERSION}.vsix"

echo "═══════════════════════════════════════════════"
echo " GitMerge Review — Build & Publish"
echo " Publisher : $PUBLISHER"
echo " Version   : $VERSION"
echo " Package   : $OUTFILE"
echo "═══════════════════════════════════════════════"

# ── 2. Install deps & compile ────────────────────────────────────────────────
echo ""
echo "→ [1/3] Installing npm dependencies..."
npm install --prefer-offline

echo ""
echo "→ [2/3] Compiling TypeScript..."
npm run compile

# ── 3. Package the VSIX ──────────────────────────────────────────────────────
echo ""
echo "→ [3/3] Packaging $OUTFILE..."
npx @vscode/vsce package \
  --no-git-tag-version \
  --no-update-package-json \
  --allow-missing-repository \
  --out "$OUTFILE"

# ── 4. Publish to VS Code Marketplace ────────────────────────────────────────
echo ""
if [[ -z "${VSCE_PAT:-}" ]]; then
  echo "⚠ VSCE_PAT is not set."
  echo "  Either:  export VSCE_PAT=<your-token>  and re-run,"
  echo "  or vsce will prompt you to log in interactively now."
  echo ""
fi

echo "→ Publishing $OUTFILE to the VS Code Marketplace..."
npx @vscode/vsce publish \
  --packagePath "$OUTFILE" \
  --allow-missing-repository

echo "  ✓ Published: https://marketplace.visualstudio.com/items?itemName=${PUBLISHER}.${NAME}"

# ── 5. Optional: publish to Open VSX ─────────────────────────────────────────
if $PUBLISH_OVSX; then
  echo ""
  if [[ -z "${OVSX_PAT:-}" ]]; then
    echo "✗ --ovsx requested but OVSX_PAT is not set. Skipping Open VSX."
    echo "  Get a token at https://open-vsx.org → your profile → Access Tokens."
    exit 1
  fi
  echo "→ Publishing $OUTFILE to Open VSX..."
  npx --yes ovsx publish "$OUTFILE" --pat "$OVSX_PAT"
  echo "  ✓ Published: https://open-vsx.org/extension/${PUBLISHER}/${NAME}"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo " ✓ Done — v$VERSION published."
echo "═══════════════════════════════════════════════"
