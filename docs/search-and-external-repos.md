# Search and Viewing External Git Repos

This page covers searching for repositories and viewing external git repositories as read-only.

## Searching Repositories

### Via Web Interface

1. Navigate to the **Search** page (`/search`)
2. Enter search query
3. View results with:
   - Repository name and description
   - Owner information
   - Clone URLs
   - Visibility status

### Via API

```bash
GET /api/search?q={query}
```

### Via CLI

```bash
gitrep search <query>
```

### Search Features

- **Name search**: Find repositories by name
- **Description search**: Find by description content
- **Owner search**: Find repositories by owner
- **Tag search**: Find by repository tags

Search queries repositories from Nostr relays and returns matching results.

## Viewing External Git Repos

GitRepublic can display external git repositories as read-only, even if they're not announced on Nostr.

### How It Works

1. **Repository Detection**: If a repository has clone URLs pointing to external git hosts (GitHub, GitLab, etc.)
2. **API Fallback**: GitRepublic attempts to fetch repository data via the external host's API
3. **Read-Only Display**: Repository is displayed with limited functionality:
   - View files and directories
   - View commit history
   - View branches and tags
   - **Cannot**: Edit files, create PRs, or push changes

### Supported External Hosts

GitRepublic supports API fallback for:
- **GitHub**: Via GitHub API
- **GitLab**: Via GitLab API
- **Other git hosts**: If they provide compatible APIs

### Limitations

When viewing external repos:
- **Read-only**: No editing or pushing
- **Limited features**: Some features may not be available
- **API dependent**: Requires external host's API to be accessible
- **No local clone**: Repository is not cloned to server

### Clone URLs

External repositories are identified by their clone URLs. If a repository announcement includes clone URLs pointing to external hosts, GitRepublic will attempt to display them.

## Repository Discovery

### Public Repositories

Public repositories are discoverable via:
- **Search**: Search across Nostr relays
- **User profiles**: Browse user's repositories
- **Repository listings**: View all public repositories

### Unlisted Repositories

Unlisted repositories:
- **Not in search results**: Won't appear in general search
- **Accessible if you know the URL**: Can be accessed directly
- **Events only to project relay**: Collaboration events only published to project relay

### Restricted/Private Repositories

Restricted and private repositories:
- **Not discoverable**: Won't appear in search
- **Require authentication**: Must be owner or maintainer to access
- **Limited event publishing**: Events only to project relay (restricted) or not at all (private)

## Clone URL Reachability

GitRepublic tests clone URL reachability and displays status:

- **✅ Reachable**: Server responds and is accessible
- **❌ Unreachable**: Server not accessible or returns error
- **Server type**: Indicates if it's a Git server or GRASP server

View reachability via:
- **Web Interface**: Repository page shows reachability for all clone URLs
- **API**: `GET /api/repos/{npub}/{repo}/clone-urls/reachability`
- **CLI**: `gitrep repos get <npub> <repo>` shows reachability

## Next Steps

- [REST API and CLI](./api-and-cli.md) - Programmatic search and access
- [Profile pages](./profile-pages.md) - Browse user repositories
