# Git Credential Helper for GitRepublic

This guide explains how to use the GitRepublic credential helper to authenticate git operations (clone, fetch, push) using your Nostr private key.

## Overview

GitRepublic uses NIP-98 HTTP Authentication for git operations. The credential helper automatically generates NIP-98 authentication tokens using your Nostr private key (nsec).

## Setup

### 1. Make the script executable

```bash
chmod +x scripts/git-credential-nostr.js
```

### 2. Set your NOSTRGIT_SECRET_KEY_CLIENT environment variable

**Important:** 
- This is YOUR user private key (for authenticating your git operations)
- Never commit your private key to version control!

```bash
# Option 1: Export in your shell session
export NOSTRGIT_SECRET_KEY_CLIENT="nsec1..."

# Option 2: Add to your ~/.bashrc or ~/.zshrc (for persistent setup)
echo 'export NOSTRGIT_SECRET_KEY_CLIENT="nsec1..."' >> ~/.bashrc
source ~/.bashrc

# Option 3: Use a hex private key (64 characters)
export NOSTRGIT_SECRET_KEY_CLIENT="<your-64-char-hex-private-key>"

# Note: The script also supports NOSTR_PRIVATE_KEY and NSEC for backward compatibility
```

### 3. Configure git to use the credential helper

#### Global configuration (for all GitRepublic repositories):

```bash
git config --global credential.helper '!node /absolute/path/to/gitrepublic-web/scripts/git-credential-nostr.js'
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

The credential helper will automatically generate a NIP-98 auth token using your NOSTRGIT_SECRET_KEY_CLIENT.

## Localhost Setup Example

Here's a complete example for setting up the credential helper with a local GitRepublic instance:

### 1. Start your local GitRepublic server

```bash
cd /path/to/gitrepublic-web
npm run dev
# Server runs on http://localhost:5173
```

### 2. Set your NOSTRGIT_SECRET_KEY_CLIENT

```bash
export NOSTRGIT_SECRET_KEY_CLIENT="nsec1..."
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
git remote add origin http://localhost:5173/api/git/npub1abc123.../my-repo.git

# Make some changes and push
git add .
git commit -m "Initial commit"
git push -u origin main
```

**Note:** The git HTTP backend endpoint is `/api/git/`, so the full URL format is:
- `http://localhost:5173/api/git/{npub}/{repo-name}.git`

### Push changes

```bash
git push origin main
```

The credential helper will generate the appropriate NIP-98 auth token for push operations.

### Fetch/Pull

```bash
git fetch origin
git pull origin main
```

## How It Works

1. When git needs credentials, it calls the credential helper with the repository URL
2. The helper reads your `NOSTRGIT_SECRET_KEY_CLIENT` environment variable (with fallbacks for backward compatibility)
3. It creates a NIP-98 authentication event signed with your private key
4. The signed event is base64-encoded and returned as the "password"
5. Git sends this in the `Authorization: Nostr <base64-event>` header
6. The GitRepublic server verifies the NIP-98 auth event and grants access

## Troubleshooting

### Error: NOSTRGIT_SECRET_KEY_CLIENT environment variable is not set

Make sure you've exported the NOSTRGIT_SECRET_KEY_CLIENT variable:
```bash
export NOSTRGIT_SECRET_KEY_CLIENT="nsec1..."
```

**Note:** The script also supports `NOSTR_PRIVATE_KEY` and `NSEC` for backward compatibility, but `NOSTRGIT_SECRET_KEY_CLIENT` is the preferred name.

### Error: Invalid nsec format

- Ensure your nsec starts with `nsec1` (bech32 encoded)
- Or use a 64-character hex private key
- Check that the key is not corrupted or truncated

### Authentication fails

- Verify your private key matches the public key that has access to the repository
- Check that the repository URL is correct
- Ensure your key has maintainer permissions for push operations

### Push operations fail

Push operations require POST authentication. The credential helper automatically detects push operations (when the path contains `git-receive-pack`) and generates a POST auth event. If you still have issues:

1. Verify you have maintainer permissions for the repository
2. Check that branch protection rules allow your push
3. Ensure your NOSTRGIT_SECRET_KEY_CLIENT is correctly set

## Security Best Practices

1. **Never commit your NOSTRGIT_SECRET_KEY_CLIENT to version control**
   - Add `NOSTRGIT_SECRET_KEY_CLIENT` to your `.gitignore` if you store it in a file
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
