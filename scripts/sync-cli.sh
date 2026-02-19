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
    git commit -m "$COMMIT_MSG"
    echo "✅ Committed changes"
else
    echo "✅ No changes to commit (files are up to date)"
fi

# Get all remotes and push to each one
REMOTES="$(git remote)"
CURRENT_BRANCH="$(git branch --show-current || echo 'master')"

if [ -z "$REMOTES" ]; then
    echo "ℹ️  No remotes configured"
    exit 0
fi

echo ""
echo "Pushing to remotes..."

# Fetch from all remotes first
for remote in $REMOTES; do
    echo "Fetching from $remote..."
    git fetch "$remote" 2>/dev/null || true
done

# Check if remotes have commits local doesn't have (diverged history)
echo ""
echo "Checking for diverged history..."
for remote in $REMOTES; do
    REMOTE_BRANCH="${remote}/${CURRENT_BRANCH}"
    if git rev-parse --verify "$REMOTE_BRANCH" >/dev/null 2>&1; then
        BEHIND=$(git rev-list --count HEAD.."$REMOTE_BRANCH" 2>/dev/null || echo "0")
        AHEAD=$(git rev-list --count "$REMOTE_BRANCH"..HEAD 2>/dev/null || echo "0")
        if [ "$BEHIND" -gt 0 ]; then
            echo "⚠️  $remote has $BEHIND commit(s) that local doesn't have"
            echo "   Local has $AHEAD commit(s) that $remote doesn't have"
            echo "   Histories have diverged - need to merge or rebase"
        fi
    fi
done

# Push to all remotes
for remote in $REMOTES; do
    echo ""
    echo "Pushing to $remote ($CURRENT_BRANCH)..."
    
    # Check if local is ahead of remote
    REMOTE_BRANCH="${remote}/${CURRENT_BRANCH}"
    if git rev-parse --verify "$REMOTE_BRANCH" >/dev/null 2>&1; then
        AHEAD=$(git rev-list --count "$REMOTE_BRANCH"..HEAD 2>/dev/null || echo "0")
        if [ "$AHEAD" -gt 0 ]; then
            echo "   Local is $AHEAD commit(s) ahead of $remote"
        fi
    fi
    
    # Try to push current branch (master) - don't use timeout as it might interfere with SSH
    PUSH_OUTPUT=$(git push "$remote" "$CURRENT_BRANCH" 2>&1)
    PUSH_EXIT=$?
    
    if [ $PUSH_EXIT -eq 0 ]; then
        # Check if output says "already up to date"
        if echo "$PUSH_OUTPUT" | grep -qi "already up to date\|Everything up-to-date"; then
            echo "ℹ️  $remote is already up to date"
        else
            echo "✅ Successfully pushed to $remote"
            echo "$PUSH_OUTPUT" | grep -v "^$" | head -3
        fi
    else
        # Push failed - show the full error
        echo "⚠️  Push to $remote failed:"
        echo "$PUSH_OUTPUT" | sed 's/^/   /'
        
        # Check if it's a non-fast-forward (diverged history)
        if echo "$PUSH_OUTPUT" | grep -qi "non-fast-forward\|behind.*remote\|diverged"; then
            REMOTE_BRANCH="${remote}/${CURRENT_BRANCH}"
            BEHIND=$(git rev-list --count HEAD.."$REMOTE_BRANCH" 2>/dev/null || echo "0")
            AHEAD=$(git rev-list --count "$REMOTE_BRANCH"..HEAD 2>/dev/null || echo "0")
            
            if [ "$BEHIND" -gt 0 ]; then
                echo ""
                echo "   Histories have diverged:"
                echo "   - Remote has $BEHIND commit(s) you don't have"
                echo "   - You have $AHEAD commit(s) remote doesn't have"
                echo ""
                echo "   For sync script, attempting force push to overwrite remote with local..."
                echo "   (This makes remote match the monorepo - monorepo is source of truth)"
                
                # Force push to make remote match local (monorepo is source of truth)
                if FORCE_PUSH_OUTPUT=$(git push -f "$remote" "$CURRENT_BRANCH" 2>&1); then
                    echo "✅ Successfully force-pushed to $remote"
                    echo "$FORCE_PUSH_OUTPUT" | grep -v "^$" | head -2 | sed 's/^/   /'
                else
                    echo "⚠️  Force push also failed:"
                    echo "$FORCE_PUSH_OUTPUT" | sed 's/^/   /'
                fi
            fi
        elif echo "$PUSH_OUTPUT" | grep -qi "refspec\|branch.*not found\|no such branch"; then
            # Branch doesn't exist on remote - set upstream
            echo "   Attempting to set upstream and push..."
            if git push -u "$remote" "$CURRENT_BRANCH" 2>&1; then
                echo "✅ Successfully pushed to $remote (with upstream set)"
            else
                echo "   Still failed after setting upstream"
            fi
        fi
    fi
done

echo ""
echo "✅ Sync complete!"
