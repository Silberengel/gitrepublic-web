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

# Change to separate repo directory and verify we're in a git repo
cd "$SEPARATE_REPO" || exit 1

# Verify we're in the correct git repository
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "Error: $SEPARATE_REPO is not a git repository"
    exit 1
fi

# Store the absolute path to ensure we stay in this directory
SEPARATE_REPO_ABS="$(cd "$SEPARATE_REPO" && pwd)"

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

# Get current branch - try multiple methods to detect the actual branch
CURRENT_BRANCH=""
if CURRENT_BRANCH=$(git branch --show-current 2>/dev/null); then
    # Successfully got branch name
    :
elif CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); then
    # Alternative method
    :
elif CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null); then
    # Another alternative
    :
else
    # Try to detect from existing branches
    if MAIN_BRANCH=$(git branch -l | grep -E '^\*?\s+(main|master|develop)' | head -1 | sed 's/^\*\?\s*//' | sed 's/^.*\s//'); then
        CURRENT_BRANCH="$MAIN_BRANCH"
    else
        # Last resort: try main, then master
        if git show-ref --verify --quiet refs/heads/main 2>/dev/null; then
            CURRENT_BRANCH="main"
        elif git show-ref --verify --quiet refs/heads/master 2>/dev/null; then
            CURRENT_BRANCH="master"
        else
            echo "⚠️  Warning: Could not detect current branch, defaulting to 'main'"
            CURRENT_BRANCH="main"
        fi
    fi
fi

if [ -z "$CURRENT_BRANCH" ]; then
    echo "⚠️  Warning: Could not detect current branch, defaulting to 'main'"
    CURRENT_BRANCH="main"
fi

echo "Detected branch: $CURRENT_BRANCH"

# Verify the branch actually exists
if ! git show-ref --verify --quiet "refs/heads/$CURRENT_BRANCH" 2>/dev/null; then
    echo "⚠️  Error: Branch '$CURRENT_BRANCH' does not exist locally"
    echo "   Available branches:"
    git branch -l | sed 's/^/     /'
    exit 1
fi

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
    echo "Working directory: $SEPARATE_REPO_ABS"
    echo "Git directory: $(git rev-parse --git-dir)"
    echo "Git remotes:"
    git remote -v | sed 's/^/  /'
    
    # Ensure we're in the separate repo directory when calling gitrep push-all
    # Use a subshell with explicit directory change to ensure all git commands run correctly
    # Clear any GIT_DIR or GIT_WORK_TREE that might interfere
    (
        # Change to the separate repo directory
        cd "$SEPARATE_REPO_ABS" || { echo "Error: Failed to change to $SEPARATE_REPO_ABS"; exit 1; }
        
        # Clear environment variables that might interfere
        unset GIT_DIR
        unset GIT_WORK_TREE
        
        # Verify we're in the correct directory and using the correct git config
        ACTUAL_GIT_DIR="$(git rev-parse --show-toplevel 2>/dev/null)"
        if [ "$ACTUAL_GIT_DIR" != "$SEPARATE_REPO_ABS" ]; then
            echo "⚠️  Warning: Git directory mismatch!"
            echo "   Expected: $SEPARATE_REPO_ABS"
            echo "   Actual: $ACTUAL_GIT_DIR"
        fi
        
        echo "Using git config from: $ACTUAL_GIT_DIR"
        echo "Verifying remotes before push:"
        git remote -v | sed 's/^/  /'
        
        # Verify remotes point to gitrepublic-cli, not gitrepublic-web
        WRONG_REMOTE=false
        for remote in $(git remote); do
            REMOTE_URL="$(git remote get-url "$remote" 2>/dev/null)"
            if echo "$REMOTE_URL" | grep -q "gitrepublic-web\.git"; then
                echo "⚠️  Error: Remote '$remote' points to gitrepublic-web instead of gitrepublic-cli!"
                echo "   URL: $REMOTE_URL"
                WRONG_REMOTE=true
            fi
        done
        
        if [ "$WRONG_REMOTE" = true ]; then
            echo "❌ Cannot push: Remotes are pointing to the wrong repository"
            exit 1
        fi
        
        # Double-check we're in the right directory
        if [ "$(pwd)" != "$SEPARATE_REPO_ABS" ]; then
            echo "❌ Error: Not in the correct directory!"
            echo "   Expected: $SEPARATE_REPO_ABS"
            echo "   Actual: $(pwd)"
            exit 1
        fi
        
        # Get list of remotes to push to
        REMOTES="$(git remote)"
        if [ -z "$REMOTES" ]; then
            echo "ℹ️  No remotes configured"
            exit 0
        fi
        
        # Push to each remote using regular git push
        # This ensures we use the correct git config from this directory
        SUCCESS_COUNT=0
        FAIL_COUNT=0
        
        for remote in $REMOTES; do
            echo ""
            echo "Pushing to $remote ($CURRENT_BRANCH)..."
            REMOTE_URL="$(git remote get-url "$remote" 2>/dev/null)"
            echo "  Remote URL: $REMOTE_URL"
            
            if git push "$remote" "$CURRENT_BRANCH" 2>&1; then
                echo "✅ Successfully pushed to $remote"
                SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
            else
                echo "⚠️  Failed to push to $remote"
                FAIL_COUNT=$((FAIL_COUNT + 1))
            fi
        done
        
        echo ""
        echo "======================================================================"
        echo "Push Summary: $SUCCESS_COUNT succeeded, $FAIL_COUNT failed out of $(echo "$REMOTES" | wc -l) remotes"
        echo "======================================================================"
        
        if [ $FAIL_COUNT -gt 0 ]; then
            exit 1
        else
            exit 0
        fi
    )
    PUSH_EXIT=$?
fi

echo ""
echo "✅ Sync complete!"
