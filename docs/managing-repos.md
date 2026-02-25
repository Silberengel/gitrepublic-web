# Managing a Repo

Complete guide to managing repositories in GitRepublic, including all tabs and sections of the repository interface.

## Repository Header

The repository header displays:

- **Repository name and description**
- **Owner information** (with link to profile)
- **Visibility badge** (public, unlisted, restricted, private)
- **Action menu** (three dots):
  - Clone to server (if not already cloned)
  - Fork repository
  - Transfer ownership (owners only)
  - Delete repository (owners only)

## Clone Section

The clone section shows:

- **All clone URLs** for the repository
- **Reachability status** for each URL (✅ reachable, ❌ unreachable)
- **Server type** indicators (Git, GRASP)
- **Copy buttons** for easy URL copying
- **Tor .onion URL** (if configured)

Clone URLs are extracted from the repository announcement and can include:
- This server's URL
- Other GitRepublic instances
- GRASP servers
- Other git hosts (GitHub, GitLab, etc.)

## File Tab

Browse and edit files in the repository.

### Features

- **Directory navigation**: Click folders to browse
- **File viewing**: Click files to view content
- **File editing**: Click "Edit" to modify files
- **File creation**: Click "New File" to create files
- **File deletion**: Click "Delete" to remove files
- **Raw file access**: Click "Raw" for direct file content
- **Syntax highlighting**: Automatic for code files
- **Line numbers**: Easy reference
- **Search**: Find text in files

### Permissions

- **Read**: Anyone can view public repositories
- **Write**: Only owners and maintainers can edit

## Commit Tab

View commit history and details.

### Features

- **Commit list**: Chronological list of all commits
- **Commit details**: Click commits to view:
  - Commit message
  - Author information
  - Files changed
  - Diff view
- **Commit verification**: Verify commit signatures (Nostr events)
- **Branch filter**: View commits for specific branches
- **Diff view**: See what changed in each commit

### Commit Verification

Commits can be verified if they have Nostr signatures (kind 1640):
- Shows signature validity
- Displays signer information
- Links to signature event

## PRs Tab

Manage pull requests.

### Features

- **PR list**: View all pull requests
- **PR status**: Open, merged, closed, draft
- **Create PR**: Propose changes from forks
- **PR details**: View PR description, diff, comments
- **Merge PR**: Merge PRs into target branch (maintainers only)
- **Update PR status**: Close, reopen, mark as draft

### Creating Pull Requests

1. Fork the repository (if needed)
2. Make changes in your fork
3. Push changes to a branch
4. Navigate to original repository
5. Click "Create Pull Request"
6. Fill in details and submit

### PR Status Management

- **Open**: Active PR ready for review
- **Merged**: PR has been merged
- **Closed**: PR closed without merging
- **Draft**: Work in progress

## Issues Tab

Track bugs, feature requests, and tasks.

### Features

- **Issue list**: View all issues
- **Issue status**: Open, resolved, closed, draft
- **Create issue**: Report bugs or request features
- **Issue details**: View description, comments, status
- **Update status**: Resolve, close, reopen issues

### Issue Status

- **Open**: Active issue needing attention
- **Resolved**: Issue has been fixed
- **Closed**: Issue closed (duplicate, won't fix, etc.)
- **Draft**: Issue still being written

## Patches Tab

View and manage patches (kind 1617).

### Features

- **Patch list**: View all patches
- **Patch status**: Open, applied, closed, draft
- **Create patch**: Submit patch content directly
- **Apply patch**: Apply patches to repository (maintainers only)
- **Patch series**: View linked patch series

### Patches vs Pull Requests

- **Patches**: For small changes (< 60KB), email-style workflow
- **Pull Requests**: For large changes, branch-based workflow

## Discussions Tab

View discussions and comments.

### Features

- **Discussion list**: View all discussions
- **Comments**: Threaded comments on PRs, issues, highlights
- **Code highlights**: Highlighted code sections with comments
- **Reply**: Reply to comments and highlights

### Discussion Types

- **PR Comments**: Comments on pull requests
- **Issue Comments**: Comments on issues
- **Code Highlights**: Comments on specific code sections
- **General Discussions**: Standalone discussion threads

## Docs Tab

View documentation files.

### Features

- **Documentation list**: View all documentation files
- **Markdown rendering**: Automatic markdown rendering
- **Documentation addresses**: Links to external documentation (naddr format)

Documentation can be:
- **README files**: Automatically rendered
- **Documentation files**: Listed in repository announcement
- **External docs**: Referenced via naddr

## History Tab

View repository history.

### Features

- **Commit timeline**: Visual timeline of commits
- **Branch visualization**: See branch structure
- **Tag markers**: See where tags were created
- **Filter by branch**: View history for specific branches

## Tags Tab

Manage git tags.

### Features

- **Tag list**: View all tags
- **Tag details**: View tag name, commit, message
- **Create tag**: Create new tags
- **Tag releases**: Use tags for version releases

### Creating Tags

#### Via Web Interface

1. Navigate to Tags tab
2. Click "Create Tag"
3. Enter tag name
4. Select commit
5. Add message (optional)
6. Click "Create"

#### Via Git

```bash
git tag -a v1.0.0 -m "Release version 1.0.0"
git push origin v1.0.0
```

## Repository Settings

Access repository settings via the repository menu or Settings link.

### Available Settings

- **Description**: Update repository description
- **Visibility**: Change visibility level (public, unlisted, restricted, private)
- **Project Relays**: Configure project relays for event publishing
- **Maintainers**: Add/remove maintainers
- **Clone URLs**: Add/remove clone URLs
- **Ownership Transfer**: Transfer repository to another user

### Visibility Levels

- **Public**: Repository and events published to all relays
- **Unlisted**: Repository public, events only to project relay
- **Restricted**: Repository private, events only to project relay
- **Private**: Repository private, no relay publishing

## Next Steps

- [Search and viewing external git repos](./search-and-external-repos.md) - Finding repositories
- [REST API and CLI](./api-and-cli.md) - Programmatic management
