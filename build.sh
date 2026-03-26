#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build.sh — Build GitMerge Review extension into a .vsix package
#
# Usage:
#   ./build.sh            # build with version from package.json
#   ./build.sh 1.2.3      # bump version then build
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Optional: bump version from CLI argument ──────────────────────────────────
if [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "→ Bumping version to $1"
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.version = '$1';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    console.log('  package.json version set to $1');
  "
fi

VERSION=$(node -e "process.stdout.write(require('./package.json').version)")
NAME=$(node -e "process.stdout.write(require('./package.json').name)")
OUTFILE="${NAME}-${VERSION}.vsix"

echo "═══════════════════════════════════════════════"
echo " GitMerge Review — VSIX Build"
echo " Version : $VERSION"
echo " Output  : $OUTFILE"
echo "═══════════════════════════════════════════════"

# ── 1. Install / sync dependencies ───────────────────────────────────────────
echo ""
echo "→ [1/4] Installing npm dependencies..."
npm install --prefer-offline

# ── 2. Compile TypeScript ────────────────────────────────────────────────────
echo ""
echo "→ [2/4] Compiling TypeScript..."
npm run compile

# ── 3. Ensure @vscode/vsce is available ──────────────────────────────────────
echo ""
echo "→ [3/4] Checking vsce..."
if ! npx --no-install @vscode/vsce --version &>/dev/null; then
  echo "  vsce not found — installing @vscode/vsce as dev dependency..."
  npm install --save-dev @vscode/vsce
fi

# ── 4. Package into VSIX ─────────────────────────────────────────────────────
echo ""
echo "→ [4/4] Packaging .vsix..."
npx @vscode/vsce package \
  --no-git-tag-version \
  --no-update-package-json \
  --allow-missing-repository \
  --out "$OUTFILE"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo " ✓ Build complete!"
SIZE=$(ls -lh "$OUTFILE" | awk '{print $5}')
echo "   $SIZE  →  $OUTFILE"
echo "═══════════════════════════════════════════════"
echo ""
echo " Install locally in VS Code:"
echo "   code --install-extension $OUTFILE"
echo ""

code --install-extension "$OUTFILE"