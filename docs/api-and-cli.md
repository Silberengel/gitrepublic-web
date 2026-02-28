# REST API and CLI

Complete guide to programmatic access via REST API and command-line interface.

## REST API

GitRepublic provides a comprehensive REST API for all operations.

### Authentication

All write operations require **NIP-98 HTTP Authentication**:

```
Authorization: Nostr <base64-encoded-event-json>
```

The event must be:
- Kind 27235 (NIP-98 authentication event)
- Include `u` tag with request URL
- Include `method` tag with HTTP method
- Include `payload` tag with SHA256 hash of request body (for POST/PUT)
- Signed with your Nostr private key

### API Documentation

Full API documentation is available in OpenAPI format:

- **Development**: `http://localhost:5173/api/openapi.json`
- **Production**: `https://your-domain.com/api/openapi.json`

View interactive documentation at `/api/openapi.json` or use any OpenAPI viewer.

### Endpoints Overview

#### Repository Management

- `GET /api/repos/list?domain={domain}` - List all registered repositories (optionally filter by domain)
- `GET /api/repos/local` - List local repositories (cloned on this server)
- `GET /api/repos/{npub}/{repo}` - Get repository information (with optional `?include=settings,maintainers,access,verification`)
- `PUT /api/repos/{npub}/{repo}` - Replace repository (full update)
- `PATCH /api/repos/{npub}/{repo}` - Partial update repository
- `DELETE /api/repos/{npub}/{repo}` - Delete repository
- `GET /api/repos/{npub}/{repo}/settings` - Get repository settings
- `POST /api/repos/{npub}/{repo}/settings` - Update repository settings
- `GET /api/repos/{npub}/{repo}/maintainers` - List maintainers
- `POST /api/repos/{npub}/{repo}/maintainers` - Add maintainer (body: `{ maintainer: "npub..." }`)
- `DELETE /api/repos/{npub}/{repo}/maintainers/{npub}` - Remove maintainer
- `GET /api/repos/{npub}/{repo}/forks` - Get fork information
- `POST /api/repos/{npub}/{repo}/forks` - Fork repository
- `DELETE /api/repos/{npub}/{repo}/delete` - Delete repository
- `GET /api/repos/{npub}/{repo}/transfers` - Get ownership transfer history
- `POST /api/repos/{npub}/{repo}/transfers` - Transfer ownership
- `POST /api/repos/{npub}/{repo}/clone` - Clone repository to server
- `GET /api/repos/{npub}/{repo}/verification` - Verify repository ownership
- `POST /api/repos/{npub}/{repo}/verification` - Save announcement to repository for verification
- `GET /api/repos/{npub}/{repo}/validate` - Validate repository announcement
- `GET /api/repos/{npub}/{repo}/access` - Get repository access information
- `GET /api/repos/{npub}/{repo}/releases` - List releases
- `POST /api/repos/{npub}/{repo}/releases` - Create release

#### File Operations

- `GET /api/repos/{npub}/{repo}/files?path={path}&ref={ref}` - Get file content (JSON format)
- `GET /api/repos/{npub}/{repo}/files?action=tree&path={path}&ref={ref}` - List files and directories
- `GET /api/repos/{npub}/{repo}/files?path={path}&format=raw&ref={ref}` - Get raw file content
- `POST /api/repos/{npub}/{repo}/files?path={path}` - Create file
- `PUT /api/repos/{npub}/{repo}/files?path={path}` - Update file (replace)
- `PATCH /api/repos/{npub}/{repo}/files?path={path}` - Partial update
- `DELETE /api/repos/{npub}/{repo}/files?path={path}` - Delete file
- `GET /api/repos/{npub}/{repo}/readme?ref={ref}` - Get README content

#### Git Operations

- `GET /api/repos/{npub}/{repo}/branches` - List branches
- `POST /api/repos/{npub}/{repo}/branches` - Create branch (requires maintainer auth)
- `GET /api/repos/{npub}/{repo}/branches/default` - Get default branch
- `GET /api/repos/{npub}/{repo}/tags` - List tags
- `POST /api/repos/{npub}/{repo}/tags` - Create tag (requires maintainer auth)
- `GET /api/repos/{npub}/{repo}/commits` - List commits
- `GET /api/repos/{npub}/{repo}/commits/{hash}/verification` - Verify commit signature
- `GET /api/repos/{npub}/{repo}/diffs?from={from}&to={to}&path={path}` - Get diff between commits
- `GET /api/repos/{npub}/{repo}/archive?format=zip|tar.gz&ref={ref}` - Download repository archive

#### Collaboration

- `GET /api/repos/{npub}/{repo}/pull-requests` - List pull requests
- `POST /api/repos/{npub}/{repo}/pull-requests` - Create pull request
- `GET /api/repos/{npub}/{repo}/pull-requests/{id}` - Get pull request
- `PATCH /api/repos/{npub}/{repo}/pull-requests/{id}` - Update PR status
- `POST /api/repos/{npub}/{repo}/pull-requests/{id}/merge` - Merge PR
- `GET /api/repos/{npub}/{repo}/issues` - List issues
- `POST /api/repos/{npub}/{repo}/issues` - Create issue
- `GET /api/repos/{npub}/{repo}/patches` - List patches
- `POST /api/repos/{npub}/{repo}/patches` - Create patch
- `POST /api/repos/{npub}/{repo}/patches/{id}/application` - Apply patch
- `GET /api/repos/{npub}/{repo}/highlights` - List highlights/comments
- `POST /api/repos/{npub}/{repo}/highlights` - Create highlight/comment

#### Search and Discovery

- `GET /api/search?type=repos&q={query}` - Search repositories (default)
- `GET /api/search?type=code&q={query}&repo={npub}/{repo}` - Search code (optionally filter by repository)
- `GET /api/repos/{npub}/{repo}/clone-urls` - List clone URLs
- `POST /api/repos/{npub}/{repo}/clone-urls/reachability` - Check clone URL reachability

#### User Operations

- `GET /api/users/{npub}/profile` - Get user profile
- `GET /api/users/{npub}/repos` - Get user's repositories
- `POST /api/user/level` - Verify user access level (relay write access)
- `GET /api/user/git-dashboard` - Get git dashboard
- `GET /api/user/messaging-preferences` - Get messaging preferences
- `POST /api/user/messaging-preferences` - Update messaging preferences

#### Infrastructure

- `GET /api/config` - Get server configuration
- `GET /api/tor/onion` - Get Tor .onion address
- `GET /api/transfers/pending` - Get pending ownership transfers

#### Git HTTP Backend

- `GET /api/git/{npub}/{repo}.git/{path}` - Git smart HTTP operations
  - Supports: `info/refs`, `git-upload-pack`, `git-receive-pack`
  - Handles: clone, fetch, push operations

### Example API Usage

```bash
# List repositories
curl https://your-domain.com/api/repos/list

# Get repository settings
curl https://your-domain.com/api/repos/{npub}/{repo}/settings

# Create file (requires NIP-98 auth)
curl -X POST "https://your-domain.com/api/repos/{npub}/{repo}/files?path=test.txt" \
  -H "Authorization: Nostr <base64-event>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello", "commitMessage": "Add file", "branch": "main"}'

# Get file content
curl "https://your-domain.com/api/repos/{npub}/{repo}/files?path=test.txt&ref=main"

# List files (tree view)
curl "https://your-domain.com/api/repos/{npub}/{repo}/files?action=tree&ref=main"

# Get raw file content
curl "https://your-domain.com/api/repos/{npub}/{repo}/files?path=test.txt&format=raw&ref=main"
```

## Command Line Interface (CLI)

The GitRepublic CLI provides full access to all features from the command line.

### Installation

```bash
npm install -g gitrepublic-cli
```

### Setup

```bash
# Set your Nostr private key
export NOSTRGIT_SECRET_KEY="nsec1..."

# Configure credential helper and commit hook
gitrep-setup
```

### Getting Help

For complete CLI documentation, run:

```bash
gitrep --help
```

This shows:
- Initial setup instructions
- All git commands
- All API commands
- Repository management
- Publishing Nostr events
- Environment variables
- And much more

### Common CLI Operations

#### Git Operations

```bash
# Clone repository
gitrep clone https://domain.com/api/git/npub1.../repo.git

# Push changes
gitrep push origin main

# Pull changes
gitrep pull origin main
```

#### Repository Management

```bash
# List repositories
gitrep repos list

# Get repository info
gitrep repos get <npub> <repo>

# Update settings
gitrep repos settings <npub> <repo> --visibility public

# Manage maintainers
gitrep repos maintainers <npub> <repo> add <maintainer-npub>
```

#### Publishing Events

```bash
# Publish repository announcement
gitrep publish repo-announcement myrepo --description "My repo"

# Create pull request
gitrep publish pr <owner> <repo> "PR Title" --content "Description"

# Create issue
gitrep publish issue <owner> <repo> "Issue Title" --content "Description"
```

#### Multi-Remote Operations

```bash
# Push to all remotes
gitrep push-all main

# Pull from all remotes and merge
gitrep pull-all --merge
```

### CLI Features

- **Git Wrapper**: Enhanced error messages for GitRepublic operations
- **Credential Helper**: Automatic NIP-98 authentication
- **Commit Signing**: Automatic commit signatures via hook
- **API Access**: Full command-line access to all APIs
- **Multi-Remote Sync**: Push/pull to/from all remotes

## Authentication

### NIP-98 for API

For API access, create NIP-98 authentication events:

1. Create ephemeral event (kind 27235)
2. Add tags: `u` (URL), `method` (HTTP method), `payload` (body hash)
3. Sign with your Nostr private key
4. Base64 encode the event JSON
5. Include in `Authorization: Nostr <base64-event>` header

### CLI Authentication

The CLI handles authentication automatically:
- **Credential Helper**: Generates NIP-98 events for git operations
- **API Commands**: Uses NIP-98 for all API calls
- **No manual setup**: Just set `NOSTRGIT_SECRET_KEY` and run `gitrep-setup`

## Next Steps

- [Tech stack used](./tech-stack.md) - Technical implementation details
- [Specs used](./specs.md) - NIPs and GRASP documentation
