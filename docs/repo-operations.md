# Creating, Forking, Transferring, or Cloning a Repo

This page covers all operations for creating, forking, transferring ownership, and cloning repositories in GitRepublic.

## Creating a Repository

### Via Web Interface

1. Navigate to the **Sign Up** page (`/signup`)
2. Connect your NIP-07 browser extension
3. Fill in repository details:
   - **Repository Name**: Choose a unique name
   - **Description**: Describe your repository
   - **Visibility**: Select visibility level (public, unlisted, restricted, private)
   - **Project Relays**: Add project relays (required for unlisted/restricted)
   - **Clone URLs**: Add existing clone URLs if migrating
   - **Maintainers**: Add maintainer npubs (optional)
4. Click **Publish Repository Announcement**

The server will automatically:
- Create a Nostr event announcing your repository
- Provision a bare git repository
- Create a self-transfer event for ownership proof
- Publish events to relays (based on visibility)
- Save events to the repository

### Via CLI

```bash
gitrep publish repo-announcement <repo-name> \
  --description "My repository" \
  --clone-url "https://domain.com/api/git/npub1.../repo.git" \
  --visibility public
```

See `gitrep --help` for complete CLI documentation.

### Repository URL Structure

Your repository will be accessible at:
- Web: `https://{domain}/repos/{your-npub}/{repository-name}`
- Git: `https://{domain}/api/git/{your-npub}/{repository-name}.git` (recommended)

## Forking a Repository

Forking creates your own copy of a repository that you can modify independently.

### Via Web Interface

1. Navigate to the repository you want to fork
2. Click the **Fork** button
3. Enter a name for your fork
4. Click **Fork**

GitRepublic will:
- Clone the repository to your account
- Create a new repository announcement for your fork
- Set you as the owner
- Preserve visibility and project-relay settings from original
- Add a reference to the original repository

### Via CLI

```bash
gitrep repos fork <owner-npub> <repo-name>
```

### Working with Forks

After forking:
- Clone your fork: `git clone https://{domain}/api/git/{your-npub}/{fork-name}.git`
- Make changes and push to your fork
- Create a pull request back to the original repository

## Transferring Ownership

Transfer repository ownership to another user.

### Via Web Interface

1. Navigate to your repository
2. Click **Transfer Ownership** (in repository menu)
3. Enter the new owner's npub
4. Confirm the transfer

The transfer process:
1. Creates an ownership transfer event (kind 1641)
2. Publishes to Nostr relays
3. Saves to repository for verification
4. Notifies new owner when they log in
5. New owner completes transfer by publishing new announcement

### Via CLI

Ownership transfers are done via the API. Use the publish command to create an ownership transfer event:

```bash
gitrep publish ownership-transfer <repo> <new-owner-npub> [--self-transfer]
```

Or use the API directly:
```bash
# Get transfer history
curl https://{domain}/api/repos/{npub}/{repo}/transfers

# Initiate transfer (requires NIP-98 auth)
curl -X POST https://{domain}/api/repos/{npub}/{repo}/transfers \
  -H "Authorization: Nostr <base64-event>" \
  -H "Content-Type: application/json" \
  -d '{"transferEvent": {...}}'
```

**Important**: Ownership transfers are permanent and create a chain of ownership events. The new owner will have full control.

## Cloning a Repository

### Public Repositories

Anyone can clone public repositories:

```bash
git clone https://{domain}/api/git/{owner-npub}/{repo-name}.git
```

### Private/Restricted Repositories

Private and restricted repositories require authentication:

1. **Install GitRepublic CLI**:
   ```bash
   npm install -g gitrepublic-cli
   ```

2. **Set your Nostr private key**:
   ```bash
   export NOSTRGIT_SECRET_KEY="nsec1..."
   ```

3. **Run setup**:
   ```bash
   gitrep-setup
   ```

4. **Clone the repository**:
   ```bash
   git clone https://{domain}/api/git/{owner-npub}/{repo-name}.git
   ```

The credential helper will automatically generate NIP-98 authentication tokens.

### Clone URL Paths

GitRepublic supports multiple clone URL paths:
- `/api/git/{npub}/{repo}.git` - Recommended (best compatibility)
- `/repos/{npub}/{repo}.git` - Alternative path
- `/{npub}/{repo}.git` - Root path

All paths work, but `/api/git/` is recommended for best compatibility with commit signing hooks.

## Multi-Remote Synchronization

If a repository has multiple clone URLs configured, GitRepublic automatically syncs changes to all remotes when you push. You can see all clone URLs on the repository page.

## Next Steps

- [Editing a repo](./editing-repos.md) - Learn about branch management and file operations
- [Managing a repo](./managing-repos.md) - Complete repository management guide
