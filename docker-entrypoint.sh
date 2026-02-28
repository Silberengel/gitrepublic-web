#!/bin/sh
set -e

# Get the UID and GID of the gitrepublic user
# Default to 10000 (standardized, avoids conflicts with system users)
# These can be overridden via environment variables for custom setups
GITREPUBLIC_UID=${GITREPUBLIC_UID:-10000}
GITREPUBLIC_GID=${GITREPUBLIC_GID:-10000}
REPO_ROOT=${GIT_REPO_ROOT:-/repos}

echo "=========================================="
echo "GitRepublic Container Startup"
echo "=========================================="
# Get actual user/group names (may differ if UID/GID already existed)
ACTUAL_USER=$(getent passwd $GITREPUBLIC_UID 2>/dev/null | cut -d: -f1 || echo "unknown")
ACTUAL_GROUP=$(getent group $GITREPUBLIC_GID 2>/dev/null | cut -d: -f1 || echo "unknown")
echo "User: $ACTUAL_USER (UID: $GITREPUBLIC_UID)"
echo "Group: $ACTUAL_GROUP (GID: $GITREPUBLIC_GID)"
echo "Repository root: $REPO_ROOT"
echo "=========================================="

# Only fix permissions if running as root (which we do initially)
if [ "$(id -u)" = "0" ]; then
    # Ensure the repos directory exists and has correct permissions
    if [ -d "$REPO_ROOT" ]; then
        echo "Fixing permissions on existing $REPO_ROOT directory..."
        # Fix ownership and permissions (suppress errors for read-only mounts)
        chown -R $GITREPUBLIC_UID:$GITREPUBLIC_GID "$REPO_ROOT" 2>/dev/null || {
            echo "Warning: Could not change ownership of $REPO_ROOT (may be read-only mount)"
        }
        chmod -R 755 "$REPO_ROOT" 2>/dev/null || {
            echo "Warning: Could not change permissions of $REPO_ROOT"
        }
    else
        echo "Creating $REPO_ROOT directory..."
        mkdir -p "$REPO_ROOT"
        chown -R $GITREPUBLIC_UID:$GITREPUBLIC_GID "$REPO_ROOT"
        chmod 755 "$REPO_ROOT"
        echo "✓ Created and configured $REPO_ROOT"
    fi
    
    # Verify permissions were set correctly
    if [ -d "$REPO_ROOT" ] && [ -w "$REPO_ROOT" ]; then
        echo "✓ $REPO_ROOT is writable"
    else
        echo "⚠ Warning: $REPO_ROOT may not be writable"
    fi
    
    # Get the gitrepublic user (should always exist with our standardized UID)
    ACTUAL_USER=$(getent passwd $GITREPUBLIC_UID 2>/dev/null | cut -d: -f1)
    if [ -z "$ACTUAL_USER" ]; then
        echo "Error: gitrepublic user (UID: $GITREPUBLIC_UID) not found in container"
        echo "This should not happen - the user should be created during image build"
        exit 1
    fi
    
    if [ "$ACTUAL_USER" != "gitrepublic" ]; then
        echo "Warning: User with UID $GITREPUBLIC_UID is '$ACTUAL_USER', expected 'gitrepublic'"
        echo "This may indicate a UID conflict. Consider using a different GITREPUBLIC_UID."
    fi
    
    # Configure git user.name and user.email for gitrepublic user
    # This is required for git commits to work properly
    echo "Configuring git identity for $ACTUAL_USER..."
    su-exec $ACTUAL_USER git config --global user.name "GitRepublic" || true
    su-exec $ACTUAL_USER git config --global user.email "gitrepublic@gitrepublic.web" || true
    
    echo "Switching to user: $ACTUAL_USER (UID: $GITREPUBLIC_UID)..."
    exec su-exec $ACTUAL_USER "$@"
else
    # Already running as gitrepublic user (shouldn't happen with our setup, but handle gracefully)
    echo "Already running as non-root user: $(id -u)"
    if [ ! -d "$REPO_ROOT" ]; then
        echo "Creating $REPO_ROOT directory..."
        mkdir -p "$REPO_ROOT" || {
            echo "Error: Could not create $REPO_ROOT directory"
            exit 1
        }
    fi
    exec "$@"
fi
