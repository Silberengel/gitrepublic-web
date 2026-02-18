# Git Credential Helper for GitRepublic

This guide explains how to use the GitRepublic credential helper to authenticate git operations (clone, fetch, push) using your Nostr private key.

## Overview

GitRepublic uses NIP-98 HTTP Authentication for git operations. The credential helper automatically generates NIP-98 authentication tokens using your Nostr private key (nsec).

## Setup

### 1. Make the script executable

```bash
chmod +x scripts/git-credential-nostr.js
```

### 2. Set your NOSTRGIT_SECRET_KEY environment variable

**Important:** 
- This is YOUR user private key (for authenticating your git operations)
- Never commit your private key to version control!

```bash
# Option 1: Export in your shell session
export NOSTRGIT_SECRET_KEY="nsec1..."

# Option 2: Add to your ~/.bashrc or ~/.zshrc (for persistent setup)
echo 'export NOSTRGIT_SECRET_KEY="nsec1..."' >> ~/.bashrc
source ~/.bashrc

# Option 3: Use a hex private key (64 characters)
export NOSTRGIT_SECRET_KEY="<your-64-char-hex-private-key>"

# Note: The script also supports NOSTR_PRIVATE_KEY and NSEC for backward compatibility
```

### 3. Configure git to use the credential helper

**Important:** The credential helper must be called for EACH request (not just the first one), because NIP-98 requires per-request authentication tokens. Make sure it's configured BEFORE any caching credential helpers.

#### Global configuration (for all GitRepublic repositories):

```bash
# Add our helper FIRST (before any cache/store helpers)
git config --global credential.helper '!node /absolute/path/to/gitrepublic-web/scripts/git-credential-nostr.js'

# Optional: Disable credential caching to ensure our helper is always called
git config --global credential.helper cache
# Or remove cache helper if you want to ensure fresh credentials each time:
# git config --global --unset credential.helper cache
```

#### Per-domain configuration (recommended):

```bash
# Replace your-domain.com with your GitRepublic server domain
git config --global credential.https://your-domain.com.helper '!node /absolute/path/to/gitrepublic-web/scripts/git-credential-nostr.js'
```

#### Localhost configuration (for local development):

If you're running GitRepublic on localhost, configure it like this:

```bash
# For HTTP (http://localhost:5173)
git config --global credential.http://localhost.helper '!node /absolute/path/to/gitrepublic-web/scripts/git-credential-nostr.js'

# For HTTPS (https://localhost:5173) - if using SSL locally
git config --global credential.https://localhost.helper '!node /absolute/path/to/gitrepublic-web/scripts/git-credential-nostr.js'

# For a specific port (e.g., http://localhost:5173)
git config --global credential.http://localhost:5173.helper '!node /absolute/path/to/gitrepublic-web/scripts/git-credential-nostr.js'
```

**Note:** Git's credential helper matching is based on the hostname, so `localhost` will match `localhost:5173` automatically. If you need to match a specific port, include it in the configuration.

#### Per-repository configuration:

```bash
cd /path/to/your/repo
git config credential.helper '!node /absolute/path/to/gitrepublic-web/scripts/git-credential-nostr.js'
```

## Usage

Once configured, git will automatically use the credential helper for authentication:

### Clone a private repository

```bash
# Remote server
git clone https://your-domain.com/npub1abc123.../my-repo.git

# Localhost (local development)
# The git HTTP backend is at /api/git/
git clone http://localhost:5173/api/git/npub1abc123.../my-repo.git
```

The credential helper will automatically generate a NIP-98 auth token using your NOSTRGIT_SECRET_KEY.

## Localhost Setup Example

Here's a complete example for setting up the credential helper with a local GitRepublic instance:

### 1. Start your local GitRepublic server

```bash
cd /path/to/gitrepublic-web
npm run dev
# Server runs on http://localhost:5173
```

### 2. Set your NOSTRGIT_SECRET_KEY

```bash
export NOSTRGIT_SECRET_KEY="nsec1..."
```

### 3. Configure git for localhost

```bash
# Configure for localhost (any port)
git config --global credential.http://localhost.helper '!node /absolute/path/to/gitrepublic-web/scripts/git-credential-nostr.js'

# Or for a specific port (e.g., 5173)
git config --global credential.http://localhost:5173.helper '!node /absolute/path/to/gitrepublic-web/scripts/git-credential-nostr.js'
```

### 4. Clone a repository

```bash
# Replace npub1abc123... with the actual npub and my-repo with your repo name
git clone http://localhost:5173/api/git/npub1abc123.../my-repo.git
```

### 5. Add remote and push

```bash
cd my-repo

# If you need to add the remote manually
git remote add gitrepublic-web http://localhost:5173/api/git/npub1abc123.../my-repo.git

# Make some changes and push
git add .
git commit -m "Initial commit"
git push -u gitrepublic-web main
```

**Note:** The git HTTP backend endpoint is `/api/git/`, so the full URL format is:
- `http://localhost:5173/api/git/{npub}/{repo-name}.git`

### Push changes

```bash
git push gitrepublic-web main
```

The credential helper will generate the appropriate NIP-98 auth token for push operations.

### Fetch/Pull

```bash
git fetch gitrepublic-web
git pull gitrepublic-web main
```

## How It Works

1. When git needs credentials, it calls the credential helper with the repository URL
2. The helper reads your `NOSTRGIT_SECRET_KEY` environment variable
3. It creates a NIP-98 authentication event signed with your private key for the specific URL and HTTP method
4. The signed event is base64-encoded and returned as `username=nostr` and `password=<base64-event>`
5. Git converts this to `Authorization: Basic <base64(username:password)>` header
6. The GitRepublic server detects Basic auth with username "nostr" and converts it to `Authorization: Nostr <base64-event>` format
7. The server verifies the NIP-98 auth event (signature, URL, method, timestamp) and grants access if valid

**Important:** The credential helper generates fresh credentials for each request because NIP-98 requires per-request authentication tokens. The URL and HTTP method are part of the signed event, so credentials cannot be reused.

## Troubleshooting

### Error: NOSTRGIT_SECRET_KEY environment variable is not set

Make sure you've exported the NOSTRGIT_SECRET_KEY variable:
```bash
export NOSTRGIT_SECRET_KEY="nsec1..."
```

**Note:** The script also supports `NOSTR_PRIVATE_KEY` and `NSEC` for backward compatibility, but `NOSTRGIT_SECRET_KEY` is the preferred name.

### Error: Invalid nsec format

- Ensure your nsec starts with `nsec1` (bech32 encoded)
- Or use a 64-character hex private key
- Check that the key is not corrupted or truncated

### Authentication fails

- Verify your private key matches the public key that has access to the repository
- Check that the repository URL is correct
- Ensure your key has maintainer permissions for push operations

### Push operations fail or show login dialog

If you see a login dialog when pushing, git isn't calling the credential helper for the POST request. This usually happens because:

1. **Credential helper not configured correctly**: 
   ```bash
   # Check your credential helper configuration
   git config --global --get-regexp credential.helper
   
   # Make sure the GitRepublic helper is configured for your domain
   git config --global credential.http://localhost:5173.helper '!node /path/to/gitrepublic-web/scripts/git-credential-nostr.js'
   ```

2. **Other credential helpers interfering**: Git might be using cached credentials from another helper. Make sure the GitRepublic helper is listed FIRST:
   ```bash
   # Remove all credential helpers
   git config --global --unset-all credential.helper
   
   # Add only the GitRepublic helper
   git config --global credential.http://localhost:5173.helper '!node /path/to/gitrepublic-web/scripts/git-credential-nostr.js'
   ```

3. **NOSTRGIT_SECRET_KEY not set**: Make sure the environment variable is set in the shell where git runs:
   ```bash
   export NOSTRGIT_SECRET_KEY="nsec1..."
   ```

4. **Wrong private key**: Ensure your `NOSTRGIT_SECRET_KEY` matches the repository owner or you have maintainer permissions for the repository you're pushing to.

5. **Authorization failure (403)**: If authentication succeeds but push fails with 403, check:
   - Your pubkey matches the repository owner, OR
   - You have maintainer permissions for the repository
   - Branch protection rules allow your push

## Security Best Practices

1. **Never commit your NOSTRGIT_SECRET_KEY to version control**
   - Add `NOSTRGIT_SECRET_KEY` to your `.gitignore` if you store it in a file
   - Use environment variables instead of hardcoding
   - **Important:** This is YOUR user key for client-side operations

2. **Use per-domain configuration**
   - This limits the credential helper to only GitRepublic domains
   - Prevents accidental credential leaks to other services

3. **Protect your private key**
   - Use file permissions: `chmod 600 ~/.nostr-key` (if storing in a file)
   - Consider using a key management service for production

4. **Rotate keys if compromised**
   - If your NOSTR_PRIVATE_KEY is ever exposed, generate a new key pair
   - Update repository maintainer lists with your new public key

## Alternative: Manual Authentication

If you prefer not to use the credential helper, you can manually generate NIP-98 auth tokens, but this is not recommended for regular use as it's cumbersome.

## See Also

- [NIP-98 Specification](https://github.com/nostr-protocol/nips/blob/master/98.md)
- [Git Credential Helper Documentation](https://git-scm.com/docs/gitcredentials)
