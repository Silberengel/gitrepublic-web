#!/bin/bash
# Sync gitrepublic-cli to a separate repository
# Usage: ./scripts/sync-cli.sh [path-to-separate-repo]

set -uo pipefail  # Don't exit on error (-e removed) so we can handle push failures gracefully

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_DIR="$REPO_ROOT/gitrepublic-cli"

# Default separate repo path
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
    # Don't add remote automatically - let user configure it
    echo "ℹ️  Repository created. Configure remotes with:"
    echo "   git remote add origin <your-repo-url>"
fi

# Change to separate repo directory
cd "$SEPARATE_REPO" || exit 1

# Copy files using rsync
rsync -av --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='package-lock.json' \
    --exclude='nostr/' \
    --exclude='*.log' \
    --exclude='.DS_Store' \
    "$CLI_DIR/" .

# Stage all changes
git add -A

# Check if there are any changes to commit
if [ -n "$(git status --porcelain)" ]; then
    echo "Changes detected, committing..."
    COMMIT_MSG="Sync from gitrepublic-web monorepo - $(date '+%Y-%m-%d %H:%M:%S')"
    
    # Check if GitRepublic commit-msg hook is installed
    HOOK_INSTALLED=false
    HOOK_PATH=""
    
    # Check for local hook
    if [ -f ".git/hooks/commit-msg" ]; then
        # Check if it's the GitRepublic hook
        if grep -q "git-commit-msg-hook\|gitrepublic" .git/hooks/commit-msg 2>/dev/null; then
            HOOK_INSTALLED=true
            HOOK_PATH=".git/hooks/commit-msg"
        fi
    fi
    
    # Check for global hook
    if [ "$HOOK_INSTALLED" = false ]; then
        GLOBAL_HOOKS_PATH="$(git config --global --get core.hooksPath 2>/dev/null || echo "$HOME/.git-hooks")"
        if [ -f "$GLOBAL_HOOKS_PATH/commit-msg" ]; then
            if grep -q "git-commit-msg-hook\|gitrepublic" "$GLOBAL_HOOKS_PATH/commit-msg" 2>/dev/null; then
                HOOK_INSTALLED=true
                HOOK_PATH="$GLOBAL_HOOKS_PATH/commit-msg"
            fi
        fi
    fi
    
    # Try to find and install the hook if not installed
    if [ "$HOOK_INSTALLED" = false ]; then
        # Look for gitrepublic-cli hook script
        POSSIBLE_HOOK_PATHS=(
            "$CLI_DIR/scripts/git-commit-msg-hook.js"
            "$REPO_ROOT/gitrepublic-cli/scripts/git-commit-msg-hook.js"
            "$(dirname "$(command -v gitrep 2>/dev/null || command -v gitrepublic 2>/dev/null || echo '')")/../scripts/git-commit-msg-hook.js"
        )
        
        for hook_script in "${POSSIBLE_HOOK_PATHS[@]}"; do
            if [ -f "$hook_script" ]; then
                echo "Installing GitRepublic commit signing hook..."
                mkdir -p .git/hooks
                # Create symlink to the hook script
                if ln -sf "$hook_script" .git/hooks/commit-msg 2>/dev/null; then
                    HOOK_INSTALLED=true
                    HOOK_PATH=".git/hooks/commit-msg"
                    echo "✅ Commit signing hook installed"
                    break
                fi
            fi
        done
    fi
    
    # Make commit (hook will be called automatically by git if installed)
    if [ "$HOOK_INSTALLED" = true ]; then
        echo "Committing with GitRepublic Nostr signing..."
        git commit -m "$COMMIT_MSG"
    else
        echo "⚠️  Warning: GitRepublic commit signing hook not found"
        echo "   Commits will not be signed with Nostr keys"
        echo "   Install gitrepublic-cli and run 'gitrep setup' to enable commit signing"
        git commit -m "$COMMIT_MSG"
    fi
    echo "✅ Committed changes"
else
    echo "✅ No changes to commit (files are up to date)"
fi

# Get current branch
CURRENT_BRANCH="$(git branch --show-current || echo 'master')"

# Check if gitrep is available
if ! command -v gitrep >/dev/null 2>&1 && ! command -v gitrepublic >/dev/null 2>&1; then
    echo "⚠️  Warning: gitrep command not found. Falling back to git push."
    echo "   Install gitrepublic-cli to use 'gitrep push-all' for better multi-remote support."
    echo ""
    
    # Fallback to old behavior
    REMOTES="$(git remote)"
    if [ -z "$REMOTES" ]; then
        echo "ℹ️  No remotes configured"
        exit 0
    fi
    
    echo "Pushing to remotes using git push..."
    for remote in $REMOTES; do
        echo "Pushing to $remote ($CURRENT_BRANCH)..."
        if git push "$remote" "$CURRENT_BRANCH" 2>&1; then
            echo "✅ Successfully pushed to $remote"
        else
            echo "⚠️  Failed to push to $remote"
        fi
    done
else
    # Use gitrep push-all
    GITREP_CMD=""
    if command -v gitrep >/dev/null 2>&1; then
        GITREP_CMD="gitrep"
    elif command -v gitrepublic >/dev/null 2>&1; then
        GITREP_CMD="gitrepublic"
    fi
    
    echo ""
    echo "Pushing to all remotes using $GITREP_CMD push-all..."
    
    # Use gitrep push-all to push to all remotes
    # This handles reachability checks, error handling, and provides better output
    if $GITREP_CMD push-all "$CURRENT_BRANCH" 2>&1; then
        echo "✅ Successfully pushed to all remotes"
    else
        PUSH_EXIT=$?
        echo "⚠️  Push to some remotes may have failed (exit code: $PUSH_EXIT)"
        # Don't exit with error - gitrep push-all may have succeeded for some remotes
    fi
fi

echo ""
echo "✅ Sync complete!"
