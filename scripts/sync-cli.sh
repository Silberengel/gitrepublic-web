#!/bin/bash
# Sync gitrepublic-cli to a separate repository
# Usage: ./scripts/sync-cli.sh [path-to-separate-repo]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_DIR="$REPO_ROOT/gitrepublic-cli"

# Default separate repo path (can be overridden)
# Use the same parent directory as the monorepo
MONOREPO_PARENT="$(dirname "$REPO_ROOT")"
SEPARATE_REPO="${1:-$MONOREPO_PARENT/gitrepublic-cli}"

if [ ! -d "$CLI_DIR" ]; then
    echo "Error: CLI directory not found at $CLI_DIR"
    exit 1
fi

echo "Syncing gitrepublic-cli to $SEPARATE_REPO..."

# Create separate repo if it doesn't exist
if [ ! -d "$SEPARATE_REPO" ]; then
    echo "Creating separate repo at $SEPARATE_REPO..."
    mkdir -p "$SEPARATE_REPO"
    cd "$SEPARATE_REPO"
    git init
    git remote add origin https://github.com/silberengel/gitrepublic-cli.git 2>/dev/null || true
fi

# Copy files (excluding node_modules, .git, etc.)
cd "$SEPARATE_REPO"
rsync -av --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='package-lock.json' \
    --exclude='nostr/' \
    "$CLI_DIR/" .

# Commit and push if there are changes
if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "Sync from gitrepublic-web monorepo" || echo "No changes to commit"
    
    # Check if remote exists, if not provide instructions
    if git remote get-url origin >/dev/null 2>&1; then
        # Try to push to main or master branch
        if git push origin main 2>/dev/null || git push origin master 2>/dev/null; then
            echo "✅ Synced and pushed to remote repository"
        else
            echo "⚠️  Synced locally, but push failed. Check remote configuration."
        fi
    else
        echo "✅ Synced to local repository"
        echo "ℹ️  To push to a remote, run:"
        echo "   cd $SEPARATE_REPO"
        echo "   git remote add origin <your-repo-url>"
        echo "   git branch -M main  # if needed"
        echo "   git push -u origin main"
    fi
else
    echo "✅ No changes to sync"
fi

echo "Done!"
