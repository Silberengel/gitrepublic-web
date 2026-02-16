# gitrepublic-web

A Nostr-based git server with NIP-34 repo announcements. Uses git-http-backend for git operations and provides a web interface for managing repositories.

## Features

- **NIP-34 Repo Announcements**: Display and manage repository announcements
- **NIP-07 Authentication**: Sign up and authenticate using browser extensions
- **Auto-provisioning**: Automatically create git repos from NIP-34 announcements
- **Multi-remote Sync**: Sync repos to multiple remotes listed in announcements
- **URL Structure**: `git.imwald.eu/{npub}/{repo-name}.git`
- **User Relay Discovery**: Automatically fetches user's inbox/outbox relays from kind 10002 or 3

## Development

```bash
npm install
npm run dev
```

## Environment Variables

- `NOSTRGIT_SECRET_KEY`: Server's nsec for signing repo announcements (optional, for server-side signing)
- `GIT_REPO_ROOT`: Path to store git repositories (default: `/repos`)
- `GIT_DOMAIN`: Domain for git repositories (default: `git.imwald.eu`)
- `NOSTR_RELAYS`: Comma-separated list of Nostr relays (default: `wss://theforest.nostr1.com,wss://nostr.land,wss://relay.damus.io`)

## Architecture

- **Frontend**: SvelteKit + TypeScript
- **Git Server**: git-http-backend wrapper (TODO: implement in `/src/routes/api/git/[...path]/+server.ts`)
- **Authentication**: NIP-07 (browser extension) for web UI, NIP-98 (HTTP auth) for git operations
- **Discovery**: NIP-34 repo announcements with automatic polling and provisioning

## Project Structure

```
src/
├── lib/
│   ├── services/
│   │   ├── nostr/
│   │   │   ├── nostr-client.ts      # WebSocket client for Nostr relays
│   │   │   ├── nip07-signer.ts      # NIP-07 browser extension integration
│   │   │   ├── nip19-utils.ts       # Decode hex/nevent/naddr addresses
│   │   │   ├── repo-polling.ts      # Auto-provision repos from announcements
│   │   │   └── user-relays.ts       # Fetch user's preferred relays
│   │   └── git/
│   │       └── repo-manager.ts      # Server-side repo provisioning & syncing
│   └── types/
│       └── nostr.ts                 # TypeScript types for Nostr
├── routes/
│   ├── +page.svelte                 # Main page: list repos on server
│   ├── signup/
│   │   └── +page.svelte             # Sign-up: create/update repo announcements
│   └── api/
│       └── git/
│           └── [...path]/
│               └── +server.ts        # Git HTTP backend API (TODO)
└── hooks.server.ts                   # Server initialization (starts polling)
```

## Implementation Status

✅ **Completed:**
- NIP-07 authentication for sign-up page
- Repo announcement display page
- Repo announcement creation/update with hex/nevent/naddr support
- User relay discovery (kind 10002 and 3)
- NIP-34 polling and auto-provisioning service
- Server-side repo manager for provisioning and syncing

🚧 **In Progress:**
- Git HTTP backend wrapper with Nostr authentication (NIP-98)

## Next Steps

1. **Implement git-http-backend integration** in `/src/routes/api/git/[...path]/+server.ts`:
   - Parse URL path to extract `{npub}/{repo-name}`
   - Authenticate using NIP-98 (HTTP Authorization header with Nostr event)
   - Proxy requests to `git-http-backend` CGI script
   - Handle git smart HTTP protocol (info/refs, git-upload-pack, git-receive-pack)
   - Trigger post-receive hooks to sync to other remotes

2. **Set up git-http-backend**:
   - Install `git-http-backend` (usually comes with git)
   - Configure as CGI script or FastCGI
   - Set up proper permissions for repo directory

3. **Implement NIP-98 authentication**:
   - Verify Nostr event signature in Authorization header
   - Check that pubkey matches repo owner (from URL)
   - Validate event timestamp (not too old)

4. **Add post-receive hook**:
   - After successful push, extract other clone URLs from NIP-34 announcement
   - Sync to all other remotes using `git push --all`

## Usage

1. **Create a repository announcement:**
   - Go to `/signup`
   - Connect your NIP-07 extension
   - Enter repository name and description
   - Optionally load an existing announcement by providing hex ID, nevent, or naddr
   - Add clone URLs (git.imwald.eu will be added automatically)
   - Publish the announcement

2. **View repositories:**
   - Go to `/` to see all repositories on git.imwald.eu
   - Repositories are automatically provisioned when announcements are published

3. **Clone a repository:**
   ```bash
   git clone https://git.imwald.eu/{npub}/{repo-name}.git
   ```

4. **Push to repository:**
   ```bash
   git remote add origin https://git.imwald.eu/{npub}/{repo-name}.git
   git push origin main
   ```
   (Requires NIP-98 authentication - TODO)
