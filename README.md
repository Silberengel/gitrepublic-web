# gitrepublic-web

A decentralized, Nostr-based git server that enables git repository hosting and collaboration using Nostr events. Repositories are announced via NIP-34, and all operations (clone, push, pull) are authenticated using NIP-98 HTTP authentication.ne

## Features

### Core Functionality
- **NIP-34 Repo Announcements**: Create and manage repository announcements on Nostr
- **NIP-07 Authentication**: Web UI authentication via browser extensions (e.g., Alby, nos2x)
- **NIP-98 HTTP Authentication**: Git operations (clone, push, pull) authenticated using ephemeral Nostr events
- **Auto-provisioning**: Automatically creates git repositories from NIP-34 announcements
- **Multi-remote Sync**: Automatically syncs repositories to multiple remotes listed in announcements
- **Repository Size Limits**: Enforces 2 GB maximum repository size
- **Relay Write Proof**: Verifies users can write to at least one default Nostr relay before allowing operations

### Repository Management
- **Repository Ownership Transfer**: Transfer ownership using kind 1641 events with a chain of ownership
- **Private Repositories**: Mark repositories as private, limiting access to owners and maintainers
- **Maintainer Management**: Add/remove maintainers who can push to repositories
- **Forking**: Fork repositories with automatic announcement creation and ownership setup
- **Repository Settings**: Manage privacy, maintainers, and description via web UI

### Collaboration Features
- **Issues**: Create and manage issues (kind 1621) with status tracking
- **Pull Requests**: Create pull requests (kind 1618) with status management
- **Highlights & Comments**: 
  - NIP-84 highlights (kind 9802) for code selections
  - NIP-22 comments (kind 1111) for threaded discussions
  - Comment on PRs, issues, and code highlights
- **Status Events**: Track issue/PR status (open, applied/merged, closed, draft)

### Web Interface
- **Repository Browser**: Browse files, directories, and commit history
- **Code Editor**: Edit files directly in the browser with syntax highlighting
- **Branch Management**: Create, switch, and manage branches
- **Tag Management**: Create and view git tags
- **README Rendering**: Automatic markdown rendering for README files
- **Search**: Search repositories by name, description, or author
- **User Profiles**: View user repositories and activity
- **Raw File View**: Direct access to raw file content
- **Download Repository**: Download repositories as ZIP archives
- **OpenGraph Metadata**: Rich social media previews with repository images and banners

### Security & Validation
- **Path Traversal Protection**: Validates and sanitizes file paths
- **Input Validation**: Validates commit messages, author names, emails, and file paths
- **File Size Limits**: 500 MB maximum per file (allows for images and demo videos)
- **Ownership Verification**: Verifies repository ownership via self-transfer events or verification files
- **Commit Signing**: Sign commits using Nostr private keys
  - Signatures embedded in commit messages as trailers
  - **Web UI**: Uses NIP-07 browser extension (secure, keys never leave browser)
  - **Git Operations**: Uses NIP-98 HTTP authentication (ephemeral signed events)
  - **Server-side**: Optional `NOSTRGIT_SECRET_KEY` environment variable for automated signing
  - ⚠️ **Security Note**: Never send private keys (nsec) in API requests. Use NIP-07 for web UI or NIP-98 for git operations.

## Nostr Event Kinds Used

This project uses the following Nostr event kinds:

### Repository Management
- **30617** (`REPO_ANNOUNCEMENT`): Repository announcements (NIP-34)
  - Tags: `d` (repo name), `name`, `description`, `clone`, `web`, `relays`, `maintainers`, `image`, `banner`, `private`
- **30618** (`REPO_STATE`): Repository state announcements (optional)
- **1641** (`OWNERSHIP_TRANSFER`): Repository ownership transfer events (non-replaceable)
  - Transfers ownership from one pubkey to another
  - Self-transfers (owner → owner) used for initial ownership proof
  - Non-replaceable to maintain immutable chain of ownership

### Collaboration
- **1617** (`PATCH`): Git patches
- **1618** (`PULL_REQUEST`): Pull request events
- **1619** (`PULL_REQUEST_UPDATE`): Pull request updates
- **1621** (`ISSUE`): Issue events
- **1630** (`STATUS_OPEN`): Open status
- **1631** (`STATUS_APPLIED`): Applied/merged status
- **1632** (`STATUS_CLOSED`): Closed status
- **1633** (`STATUS_DRAFT`): Draft status
- **1640** (`COMMIT_SIGNATURE`): Git commit signature events
  - Tags: `author` (name, email), `message` (commit message), `commit` (commit hash), `e` (NIP-98 auth event reference, optional)

### Highlights & Comments
- **9802** (`HIGHLIGHT`): NIP-84 highlight events for code selections
  - Tags: `a` (anchor), `r` (range), `p` (position), `context`, `file`, `start_line`, `end_line`, `start_pos`, `end_pos`
- **1111** (`COMMENT`): NIP-22 comment events for threaded discussions
  - Tags: `A` (root event), `K` (root kind), `P` (parent event), `a`, `k`, `p` (for replies)

### Authentication
- **27235** (`NIP98_AUTH`): NIP-98 HTTP authentication events
  - Tags: `u` (URL), `method` (HTTP method), `payload` (SHA256 hash of request body)

### Relay Discovery
- **3**: Contact list (for relay discovery)
- **10002**: Relay list metadata (for relay discovery)
- **1**: Text note (for relay write proof, fallback)

## How It Works

### Repository Creation Flow

1. **User Creates Announcement**:
   - User visits `/signup` and connects NIP-07 extension
   - Enters repository name, description, and optional clone URLs
   - System automatically creates a self-transfer event (kind 1641) for initial ownership proof
   - Both announcement and self-transfer are published to Nostr relays

2. **Auto-Provisioning**:
   - Server polls Nostr relays for new repository announcements (kind 30617)
   - When found, server:
     - Creates a bare git repository at `/repos/{npub}/{repo-name}.git`
     - Fetches the self-transfer event for ownership verification
     - Creates initial commit with `.nostr-ownership-transfer` file containing the self-transfer event
     - Creates `.nostr-verification` file with the announcement event (for backward compatibility)
     - If repository has `clone` tags pointing to other remotes, syncs from those remotes

3. **Repository Access**:
   - Public repositories: Anyone can clone and view
   - Private repositories: Only owners and maintainers can access
   - Access is checked via NIP-98 authentication for git operations

### Git Operations Flow

1. **Clone/Fetch**:
   - User runs `git clone https://{domain}/{npub}/{repo}.git`
   - Server handles GET requests to `info/refs?service=git-upload-pack`
   - For private repos, verifies NIP-98 authentication
   - Proxies request to `git-http-backend` which serves the repository

2. **Push**:
   - User configures git with NIP-98 authentication
   - Before push, client creates a NIP-98 event (kind 27235) with:
     - `u` tag: Request URL
     - `method` tag: HTTP method (POST)
     - `payload` tag: SHA256 hash of request body
   - Client signs event and includes in `Authorization: Nostr {event}` header
   - Server verifies:
     - Event signature
     - Event timestamp (within 60 seconds)
     - URL and method match
     - Payload hash matches request body
     - Pubkey is current owner or maintainer
   - Server checks repository size limit (2 GB)
   - Server proxies to `git-http-backend`
   - After successful push, server:
     - Extracts other `clone` URLs from announcement
     - Syncs to all other remotes using `git push --all`

### Ownership Transfer Flow

1. **Current Owner Initiates Transfer**:
   - Owner creates a kind 1641 event with:
     - `from` tag: Current owner pubkey
     - `to` tag: New owner pubkey
     - `a` tag: Repository identifier (`30617:{owner}:{repo}`)
   - Signs and publishes event

2. **Server Processes Transfer**:
   - Server fetches all ownership transfer events for repository
   - Validates chain of ownership chronologically
   - Updates current owner for all permission checks
   - Maintainers remain valid (checked against current owner)

### Pull Requests & Issues Flow

1. **Creating a PR/Issue**:
   - User creates a kind 1618 (PR) or 1621 (Issue) event
   - Includes repository identifier in tags
   - Publishes to Nostr relays

2. **Status Management**:
   - Owner/maintainer creates status events (kind 1630-1633)
   - Links to PR/Issue via event references
   - Status changes: open → applied/closed/draft

3. **Highlights & Comments**:
   - User selects code in PR diff view
   - Creates kind 9802 highlight event with code selection metadata
   - Users can comment on highlights using kind 1111 events
   - Comments are threaded using `A`, `K`, `P` tags (root) and `a`, `k`, `p` tags (parent)

### Forking Flow

1. **User Forks Repository**:
   - User clicks "Fork" button on repository page
   - Server:
     - Clones original repository
     - Creates new repository at `/repos/{user-npub}/{fork-name}.git`
     - Creates new NIP-34 announcement for fork
     - Creates self-transfer event for fork ownership
     - Publishes both to Nostr relays

2. **Fork Identification**:
   - Fork announcement includes reference to original repository
   - UI displays "Forked from" badge

### Private Repository Access

1. **Privacy Setting**:
   - Repository announcement includes `private` tag (or `t` tag with value `private`)
   - Server marks repository as private

2. **Access Control**:
   - All API endpoints check privacy status
   - For private repos, requires NIP-98 authentication
   - Verifies user is current owner or listed maintainer
   - Returns 403 if unauthorized

### Relay Write Proof

Instead of traditional rate limiting, users must prove they can write to at least one default Nostr relay:

1. **Proof Mechanism**:
   - User publishes a NIP-98 event (kind 27235) to a default relay
   - Event must be within 60 seconds (per NIP-98 spec)
   - Server verifies event exists on relay
   - Alternative: User publishes kind 1 text note (5-minute window)

2. **Verification**:
   - Server queries relay for the proof event
   - Validates timestamp and signature
   - Grants access if proof is valid

## Architecture

### Frontend
- **Framework**: SvelteKit + TypeScript
- **Authentication**: NIP-07 browser extension integration
- **Components**: Code editor, PR detail view, repository browser

### Backend
- **Git Server**: `git-http-backend` wrapper for git operations
- **Authentication**: NIP-98 HTTP authentication for git operations
- **Repository Management**: Automatic provisioning and syncing
- **Nostr Integration**: WebSocket client for relay communication

### Services

- **NostrClient**: WebSocket client for fetching and publishing Nostr events
- **RepoManager**: Server-side repository provisioning, syncing, and size management
- **FileManager**: File operations within git repositories with validation
- **CommitSigner**: Git commit signing using Nostr keys (supports nsec and hex formats)
- **OwnershipTransferService**: Manages repository ownership transfers
- **MaintainerService**: Checks maintainer permissions and privacy settings
- **HighlightsService**: Manages NIP-84 highlights and NIP-22 comments
- **RelayWriteProof**: Verifies user can write to Nostr relays

## Project Structure

```
src/
├── lib/
│   ├── services/
│   │   ├── nostr/
│   │   │   ├── nostr-client.ts           # WebSocket client for Nostr relays
│   │   │   ├── nip07-signer.ts           # NIP-07 browser extension integration
│   │   │   ├── nip98-auth.ts             # NIP-98 HTTP authentication
│   │   │   ├── repo-polling.ts           # Auto-provision repos from announcements
│   │   │   ├── user-relays.ts            # Fetch user's preferred relays
│   │   │   ├── ownership-transfer-service.ts  # Repository ownership transfers
│   │   │   ├── maintainer-service.ts     # Maintainer permission checks
│   │   │   ├── highlights-service.ts     # NIP-84 highlights & NIP-22 comments
│   │   │   ├── relay-write-proof.ts      # Relay write proof verification
│   │   │   ├── prs-service.ts            # Pull request management
│   │   │   └── issues-service.ts         # Issue management
│   │   └── git/
│   │       ├── repo-manager.ts           # Repository provisioning & syncing
│   │       └── file-manager.ts           # File operations with validation
│   ├── components/
│   │   ├── CodeEditor.svelte             # Code editor with syntax highlighting
│   │   └── PRDetail.svelte               # Pull request detail view
│   └── types/
│       └── nostr.ts                      # TypeScript types for Nostr events
├── routes/
│   ├── +page.svelte                      # Main page: list repositories
│   ├── signup/
│   │   └── +page.svelte                  # Create/update repo announcements
│   ├── repos/[npub]/[repo]/
│   │   ├── +page.svelte                  # Repository detail page
│   │   ├── +page.ts                      # OpenGraph metadata loader
│   │   └── settings/
│   │       └── +page.svelte              # Repository settings UI
│   ├── users/[npub]/
│   │   └── +page.svelte                  # User profile page
│   ├── search/
│   │   └── +page.svelte                  # Search interface
│   └── api/
│       ├── git/[...path]/
│       │   └── +server.ts                # Git HTTP backend API
│       └── repos/[npub]/[repo]/
│           ├── file/+server.ts           # File read/write API
│           ├── tree/+server.ts           # Directory listing API
│           ├── branches/+server.ts        # Branch management API
│           ├── commits/+server.ts        # Commit history API
│           ├── tags/+server.ts           # Tag management API
│           ├── issues/+server.ts         # Issues API
│           ├── prs/+server.ts            # Pull requests API
│           ├── highlights/+server.ts     # Highlights & comments API
│           ├── fork/+server.ts           # Fork repository API
│           ├── readme/+server.ts         # README fetching API
│           ├── raw/+server.ts             # Raw file view API
│           ├── download/+server.ts       # Download repository as ZIP
│           ├── settings/+server.ts       # Repository settings API
│           ├── transfer/+server.ts       # Ownership transfer API
│           └── verify/+server.ts         # Ownership verification API
└── hooks.server.ts                       # Server initialization (starts polling)
```

## Development

### Prerequisites
- Node.js 18+
- Git with `git-http-backend` installed
- NIP-07 browser extension (for web UI)

### Setup

```bash
npm install
npm run dev
```

### Environment Variables

- `NOSTRGIT_SECRET_KEY`: Server's nsec (bech32 or hex) for signing repo announcements and initial commits (optional)
- `GIT_REPO_ROOT`: Path to store git repositories (default: `/repos`)
- `GIT_DOMAIN`: Domain for git repositories (default: `localhost:6543`)
- `NOSTR_RELAYS`: Comma-separated list of Nostr relays (default: `wss://theforest.nostr1.com,wss://nostr.land,wss://relay.damus.io`)

### Git HTTP Backend Setup

The server uses `git-http-backend` for git operations. Ensure it's installed:

```bash
# On Debian/Ubuntu
sudo apt-get install git

# Verify installation
which git-http-backend
```

The server will automatically locate `git-http-backend` in common locations.

## Usage

### Creating a Repository

1. Go to `/signup`
2. Connect your NIP-07 extension
3. Enter repository name and description
4. Optionally add clone URLs (your domain will be added automatically)
5. Optionally add images/banners for OpenGraph previews
6. Publish the announcement

The server will automatically provision the repository.

### Cloning a Repository

```bash
git clone https://{domain}/{npub}/{repo-name}.git
```

For private repositories, configure git with NIP-98 authentication.

### Pushing to a Repository

```bash
git remote add origin https://{domain}/{npub}/{repo-name}.git
git push origin main
```

Requires NIP-98 authentication. Your git client needs to support NIP-98 or you can use a custom credential helper.

### Viewing Repositories

- Go to `/` to see all public repositories
- Go to `/repos/{npub}/{repo}` to view a specific repository
- Go to `/users/{npub}` to view a user's repositories
- Go to `/search` to search for repositories

### Managing Repositories

- **Settings**: Visit `/repos/{npub}/{repo}/settings` to manage privacy, maintainers, and description
- **Forking**: Click "Fork" button on repository page
- **Transfer Ownership**: Use the transfer API endpoint or create a kind 1641 event manually

## Security Considerations

- **Path Traversal**: All file paths are validated and sanitized
- **Input Validation**: Commit messages, author info, and file paths are validated
- **Size Limits**: 2 GB per repository, 100 MB per file
- **Authentication**: All write operations require NIP-98 authentication
- **Authorization**: Ownership and maintainer checks for all operations
- **Private Repositories**: Access restricted to owners and maintainers

## License

[Add your license here]

## Contributing

[Add contribution guidelines here]
