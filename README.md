# GitRepublic

A decentralized, Nostr-based git server that enables git repository hosting and collaboration using Nostr events. Repositories are announced via NIP-34, and all operations (clone, push, pull) are authenticated using NIP-98 HTTP authentication.

## Command Line Interface (CLI)

**The GitRepublic CLI is published and available via npm:**

```bash
npm install -g gitrepublic-cli
```

The CLI provides:
- **Git wrapper** with enhanced error messages for GitRepublic operations
- **Credential helper** for automatic NIP-98 authentication
- **Commit signing hook** that automatically signs commits using Nostr keys
- **Full API access** from the command line

### Quick Start with CLI

```bash
# Install
npm install -g gitrepublic-cli

# Set your Nostr private key
export NOSTRGIT_SECRET_KEY="nsec1..."

# Setup (configures credential helper and commit hook)
gitrep-setup

# Use gitrep (or gitrepublic) for git operations
gitrep clone https://your-domain.com/api/git/npub1.../repo.git
gitrep push origin main

# Use gitrep for API commands
gitrep repos list                 # List repositories
gitrep push-all main              # Push to all remotes
gitrep publish repo-announcement myrepo
```

**Note**: `gitrep` is a shorter alias for `gitrepublic` - both work the same way.

For complete CLI documentation, see [gitrepublic-cli/README.md](./gitrepublic-cli/README.md).

---

## Overview

GitRepublic consists of three main components:

1. **Web Interface** - Full-featured web application for browsing, editing, and managing repositories
2. **Command Line Interface (CLI)** - Git wrapper and API client for command-line operations
3. **REST API** - Complete API for programmatic access (see `/api/openapi.json` for full documentation)

All three interfaces use the same underlying Nostr-based authentication and repository management system.

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
- **Branch Protection**: Protect branches from direct pushes, require pull requests and reviews

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
  - ⚠️ **Security Note**: Never send private keys (nsec) in API requests. Use NIP-07 for web UI or NIP-98 for git operations.

## Getting Started

### Prerequisites
- Node.js 18+
- Git with `git-http-backend` installed
- NIP-07 browser extension (for web UI) - [Alby](https://getalby.com/) or [nos2x](https://github.com/fiatjaf/nos2x) recommended

### Installation

#### For Web Server
```bash
# Clone the repository
git clone https://github.com/silberengel/gitrepublic-web.git
cd gitrepublic-web

# Install dependencies
npm install

# Start development server
npm run dev
```

#### For CLI (Command Line)
```bash
# Install globally
npm install -g gitrepublic-cli

# Set your Nostr private key
export NOSTRGIT_SECRET_KEY="nsec1..."

# Setup credential helper and commit hook
gitrep-setup
```

### Quick Start

#### Web Interface
1. Start the server: `npm run dev`
2. Open browser: `http://localhost:5173`
3. Connect NIP-07 extension
4. Visit `/signup` to create your first repository

#### Command Line
```bash
# Clone a repository
gitrep clone https://your-domain.com/api/git/npub1.../repo.git

# Make changes and push
git add .
git commit -m "Update README"
gitrep push origin main
```

#### API Access
All API endpoints are documented in OpenAPI format at `/api/openapi.json`. Use NIP-98 authentication for all write operations.

Example:
```bash
curl -X GET https://your-domain.com/api/repos/list
```

## How It Works

### Repository Creation Flow

1. **User Creates Announcement**:
   - **Web**: Visit `/signup` and connect NIP-07 extension
   - **CLI**: Run `gitrep publish repo-announcement <repo-name>`
   - **API**: POST to `/api/repos/[npub]/[repo]` with announcement event
   - System automatically creates a self-transfer event (kind 1641) for initial ownership proof
   - Both announcement and self-transfer are published to Nostr relays

2. **Auto-Provisioning**:
   - Server polls Nostr relays for new repository announcements (kind 30617)
   - When found, server:
     - Creates a bare git repository at `/repos/{npub}/{repo-name}.git`
     - Fetches the self-transfer event for ownership verification
     - Creates initial commit with README.md and saves announcement/transfer events to `nostr/repo-events.jsonl` for offline papertrail
     - If repository has `clone` tags pointing to other remotes, syncs from those remotes

3. **Repository Access**:
   - Public repositories: Anyone can clone and view
   - Private repositories: Only owners and maintainers can access
   - Access is checked via NIP-98 authentication for git operations

### Git Operations Flow

1. **Clone/Fetch**:
   - **CLI**: `gitrep clone https://{domain}/api/git/{npub}/{repo}.git`
   - **Git**: `git clone https://{domain}/api/git/{npub}/{repo}.git`
   - Server handles GET requests to `info/refs?service=git-upload-pack`
   - For private repos, verifies NIP-98 authentication
   - Proxies request to `git-http-backend` which serves the repository

2. **Push**:
   - **CLI**: `gitrep push origin main` (automatic authentication)
   - **Git**: `git push origin main` (requires credential helper setup)
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
   - **Web**: Use transfer UI in repository settings
   - **CLI**: `gitrep transfer <npub> <repo> <new-owner-npub>`
   - **API**: POST to `/api/repos/[npub]/[repo]/transfer`
   - Owner creates a kind 1641 event with:
     - `a` tag: Repository identifier (`30617:{owner}:{repo}`)
     - `p` tag: New owner pubkey
     - `d` tag: Repository name
   - Signs and publishes event to Nostr relays
   - Transfer event is saved to repository in `nostr/repo-events.jsonl` for offline papertrail

2. **New Owner Completes Transfer**:
   - New owner is notified when logging into GitRepublic web
   - New owner publishes a new repository announcement (kind 30617) to complete the transfer
   - New announcement is saved to repository for verification

3. **Server Processes Transfer**:
   - Server fetches all ownership transfer events for repository
   - Validates chain of ownership chronologically
   - Updates current owner for all permission checks
   - Maintainers remain valid (checked against current owner)

## Nostr Event Kinds Used

This project uses the following Nostr event kinds. For complete JSON examples and tag documentation, see [docs/NIP_COMPLIANCE.md](./docs/NIP_COMPLIANCE.md#complete-event-kind-reference).

### Standard NIP Event Kinds
- **30617** (`REPO_ANNOUNCEMENT`): Repository announcements (NIP-34)
- **30618** (`REPO_STATE`): Repository state announcements (NIP-34, optional)
- **1617** (`PATCH`): Git patches (NIP-34)
- **1618** (`PULL_REQUEST`): Pull request events (NIP-34)
- **1619** (`PULL_REQUEST_UPDATE`): Pull request updates (NIP-34)
- **1621** (`ISSUE`): Issue events (NIP-34)
- **1630** (`STATUS_OPEN`): Open status (NIP-34)
- **1631** (`STATUS_APPLIED`): Applied/merged status (NIP-34)
- **1632** (`STATUS_CLOSED`): Closed status (NIP-34)
- **1633** (`STATUS_DRAFT`): Draft status (NIP-34)
- **9802** (`HIGHLIGHT`): NIP-84 highlight events for code selections
- **1111** (`COMMENT`): NIP-22 comment events for threaded discussions
- **27235** (`NIP98_AUTH`): NIP-98 HTTP authentication events
- **3**: Contact list (NIP-02, for relay discovery)
- **10002**: Relay list metadata (NIP-65, for relay discovery)
- **24**: Public message (NIP-24, for relay write proof)
- **5**: Event deletion request (NIP-09)

### Custom Event Kinds

These are not part of any NIP but are used by this application:

- **1640** (`COMMIT_SIGNATURE`): Git commit signature events
  - Used to cryptographically sign git commits using Nostr keys
  - Tags: `commit` (hash), `author` (name, email), `message` (commit message), `e` (NIP-98 auth event reference, optional)
  - See [docs/NIP_COMPLIANCE.md](./docs/NIP_COMPLIANCE.md#1640---commit_signature) for complete example

- **1641** (`OWNERSHIP_TRANSFER`): Repository ownership transfer events (non-replaceable)
  - Transfers ownership from one pubkey to another
  - Self-transfers (owner → owner) used for initial ownership proof
  - Non-replaceable to maintain immutable chain of ownership
  - Tags: `a` (repo identifier), `p` (new owner), `d` (repo name), `t` (self-transfer marker, optional)
  - See [docs/NIP_COMPLIANCE.md](./docs/NIP_COMPLIANCE.md#1641---ownership_transfer) for complete example

- **30620** (`BRANCH_PROTECTION`): Branch protection rules (replaceable)
  - Allows requiring pull requests, reviewers, status checks for protected branches
  - Tags: `d` (repo name), `a` (repo identifier), `branch` (branch name and protection settings)
  - See [docs/NIP_COMPLIANCE.md](./docs/NIP_COMPLIANCE.md#30620---branch_protection) for complete example

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

## Security Features

### Lightweight Mode (Single Container) - Default
- **Resource Limits**: Per-user repository count and disk quota limits
- **Rate Limiting**: Per-IP and per-user rate limiting for all operations
- **Audit Logging**: Comprehensive logging of all security-relevant events
- **Path Validation**: Strict path validation to prevent traversal attacks
- **git-http-backend Hardening**: Timeouts, process isolation, scoped access
- **Mode**: Set `ENTERPRISE_MODE=false` or leave unset (default)

### Enterprise Mode (Kubernetes)
- **Process Isolation**: Container-per-tenant architecture
- **Network Isolation**: Kubernetes Network Policies
- **Resource Quotas**: Per-tenant CPU, memory, and storage limits
- **Separate Volumes**: Each tenant has their own PersistentVolume
- **Mode**: Set `ENTERPRISE_MODE=true` environment variable
- **Deployment**: See `k8s/ENTERPRISE_MODE.md` for setup instructions

See `docs/SECURITY.md` and `docs/SECURITY_IMPLEMENTATION.md` for detailed information.

## Environment Variables

### Core Configuration
- `ENTERPRISE_MODE`: Enable enterprise mode with Kubernetes (default: `false`). When `true`, expects container-per-tenant architecture. See `k8s/ENTERPRISE_MODE.md` for details.
- `GIT_REPO_ROOT`: Path to store git repositories (default: `/repos`)
- `GIT_DOMAIN`: Domain for git repositories (default: `localhost:6543`)
- `NOSTR_RELAYS`: Comma-separated list of Nostr relays (default: `wss://theforest.nostr1.com`)
- `NOSTR_SEARCH_RELAYS`: Comma-separated list of Nostr relays for searching (default: includes multiple relays)

### Git Operations
- `NOSTRGIT_SECRET_KEY`: User's Nostr private key (nsec bech32 or hex) for git command-line operations via credential helper. Required for `git clone`, `git push`, and `git pull` operations from the command line. **Note**: Install via `npm install -g gitrepublic-cli` to use this.

### Tor Support
- `TOR_SOCKS_PROXY`: Tor SOCKS proxy address (format: `host:port`, default: `127.0.0.1:9050`). Set to empty string to disable Tor support. When configured, the server will automatically route `.onion` addresses through Tor for both Nostr relay connections and git operations.
- `TOR_ONION_ADDRESS`: Tor hidden service .onion address (optional). If not set, the server will attempt to read it from Tor's hostname file. When configured, every repository will automatically get a `.onion` clone URL in addition to the regular domain URL, making repositories accessible via Tor even if the server is only running on localhost.

### Security Configuration
- `MAX_REPOS_PER_USER`: Maximum repositories per user (default: `100`)
- `MAX_DISK_QUOTA_PER_USER`: Maximum disk quota per user in bytes (default: `10737418240` = 10GB)
- `RATE_LIMIT_ENABLED`: Enable rate limiting (default: `true`)
- `AUDIT_LOGGING_ENABLED`: Enable audit logging (default: `true`)

## Usage Examples

### Web Interface

#### Creating a Repository
1. Go to `/signup`
2. Connect your NIP-07 extension
3. Enter repository name and description
4. Optionally add clone URLs (your domain will be added automatically)
5. Optionally add images/banners for OpenGraph previews
6. Publish the announcement

The server will automatically provision the repository.

#### Viewing Repositories
- Go to `/` to see all public repositories
- Go to `/repos/{npub}/{repo}` to view a specific repository
- Go to `/users/{npub}` to view a user's repositories
- Go to `/search` to search for repositories

#### Managing Repositories
- **Settings**: Visit `/repos/{npub}/{repo}/settings` to manage privacy, maintainers, and description
- **Forking**: Click "Fork" button on repository page
- **Transfer Ownership**: Use the transfer UI in repository settings

### Command Line Interface

#### Cloning a Repository
```bash
# Using GitRepublic CLI (recommended)
gitrep clone https://{domain}/api/git/{npub}/{repo-name}.git

# Or using standard git (requires credential helper setup)
git clone https://{domain}/api/git/{npub}/{repo-name}.git
```

**Note**: Use `/api/git/` or `/repos/` paths to ensure proper detection by the commit signing hook. All three paths (`/api/git/`, `/repos/`, and root `/`) work for cloning, but `/api/git/` is recommended for best compatibility.

#### Pushing to a Repository
```bash
# Using GitRepublic CLI (automatic authentication)
gitrep push origin main

# Or using standard git (requires credential helper)
git push origin main
```

The credential helper will automatically generate NIP-98 authentication tokens for push operations. The commit signing hook will automatically sign commits for GitRepublic repositories.

#### API Commands
```bash
# List repositories
gitrep repos list

# Get repository details
gitrep repos get <npub> <repo>

# Push to all remotes
gitrep push-all main

# Publish repository announcement
gitrep publish repo-announcement <repo-name>
```

For complete CLI documentation, see [gitrepublic-cli/README.md](./gitrepublic-cli/README.md).

### API Access

All API endpoints are documented in OpenAPI format. Access the API documentation at:
- **Development**: `http://localhost:5173/api/openapi.json`
- **Production**: `https://your-domain.com/api/openapi.json`

#### Authentication
All write operations require NIP-98 HTTP authentication:

```bash
# Example: Create a file (requires NIP-98 auth)
curl -X POST https://your-domain.com/api/repos/{npub}/{repo}/file \
  -H "Authorization: Nostr <base64-encoded-event-json>" \
  -H "Content-Type: application/json" \
  -d '{"path": "test.txt", "content": "Hello World"}'
```

The CLI handles authentication automatically. For manual API access, see the [NIP-98 specification](https://github.com/nostr-protocol/nips/blob/master/98.md).

## Development

### Prerequisites
- Node.js 18+
- Git with `git-http-backend` installed
- NIP-07 browser extension (for web UI)

### Setup

```bash
npm install  # Installs dependencies for both web and CLI (workspace)
npm run dev
```

**Note**: This repository uses npm workspaces. The CLI (`gitrepublic-cli`) is included as a workspace package but can also be published independently. See `gitrepublic-cli/SYNC.md` for details on syncing to a separate repository.

### Project Structure

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
│   │   └── PRDetail.svelte                # Pull request detail view
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
│           ├── commits/+server.ts         # Commit history API
│           ├── tags/+server.ts           # Tag management API
│           ├── issues/+server.ts         # Issues API
│           ├── prs/+server.ts            # Pull requests API
│           ├── highlights/+server.ts     # Highlights & comments API
│           ├── fork/+server.ts           # Fork repository API
│           ├── readme/+server.ts         # README fetching API
│           ├── raw/+server.ts            # Raw file view API
│           ├── download/+server.ts      # Download repository as ZIP
│           ├── settings/+server.ts      # Repository settings API
│           ├── transfer/+server.ts      # Ownership transfer API
│           └── verify/+server.ts         # Ownership verification API
└── hooks.server.ts                       # Server initialization (starts polling)
```

## Additional Documentation

- [Architecture FAQ](./docs/ARCHITECTURE_FAQ.md) - Answers to common architecture questions
- [NIP Compliance](./docs/NIP_COMPLIANCE.md) - Complete event kind reference with JSON examples
- [Security Documentation](./docs/SECURITY.md) - Security features and considerations
- [CLI Documentation](./gitrepublic-cli/README.md) - Complete CLI usage guide
- [Enterprise Mode](./k8s/ENTERPRISE_MODE.md) - Kubernetes deployment guide
- [API Documentation](./src/routes/api/openapi.json) - OpenAPI specification