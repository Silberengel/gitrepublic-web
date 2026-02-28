# Editing a Repo

This page covers all aspects of editing repositories: branch management, file management, auto-provisioning, file-editing permissions, and event-creation permissions.

## Auto-Provisioning

When you create a repository announcement, GitRepublic automatically:

1. **Polls Nostr relays** for new announcements
2. **Creates a bare git repository** at `/repos/{npub}/{repo-name}.git`
3. **Fetches self-transfer event** for ownership verification
4. **Creates initial commit** with README.md (if provided)
5. **Saves announcement and transfer events** to `nostr/repo-events.jsonl`
6. **Syncs from other remotes** if clone URLs are configured

The repository is ready to use immediately after announcement.

## Branch Management

### Creating Branches

#### Via Web Interface

1. Navigate to your repository
2. Click **Create Branch** button
3. Enter branch name
4. Select source branch
5. Click **Create**

#### Via Git

```bash
git checkout -b feature/new-feature
git push origin feature/new-feature
```

### Viewing Branches

- **Web Interface**: View all branches on the repository page
- **API**: `GET /api/repos/{npub}/{repo}/branches`
- **CLI**: `gitrep repos branches <npub> <repo>`

### Default Branch

The default branch (usually `main`) can be viewed via:
- **Web Interface**: Repository settings
- **API**: `GET /api/repos/{npub}/{repo}/branches/default`

## File Management

### Reading Files

#### Via Web Interface

1. Navigate to repository
2. Click **File** tab
3. Browse directory structure
4. Click files to view content

#### Via API

```bash
GET /api/repos/{npub}/{repo}/files?path={file-path}&ref={branch}
```

#### Via CLI

```bash
gitrep file get <npub> <repo> <path> [branch]
```

### Creating/Updating Files

#### Via Web Interface

1. Navigate to repository
2. Click **File** tab
3. Click **Edit** button on a file (or create new)
4. Use the code editor to make changes
5. Enter commit message
6. Select branch
7. Click **Save**

#### Via API

```bash
POST /api/repos/{npub}/{repo}/files?path=file.txt
{
  "content": "File content",
  "commitMessage": "Add file",
  "branch": "main"
}
```

#### Via CLI

```bash
gitrep file put <npub> <repo> <path> [file] [message] [branch]
```

### Deleting Files

#### Via Web Interface

1. Navigate to file
2. Click **Delete** button
3. Enter commit message
4. Click **Delete**

#### Via API

```bash
DELETE /api/repos/{npub}/{repo}/files?path=file.txt
{
  "commitMessage": "Remove file",
  "branch": "main"
}
```

#### Via CLI

```bash
gitrep file delete <npub> <repo> <path> [message] [branch]
```

## Permissions

### File Editing Permissions

- **Repository Owner**: Can edit all files
- **Maintainers**: Can edit all files
- **Other Users**: Cannot edit files (read-only)

### Event Creation Permissions

Different events have different permission requirements:

- **Pull Requests**: Anyone can create
- **Issues**: Anyone can create
- **Patches**: Anyone can create
- **Comments**: Anyone can comment
- **Status Updates**: Only owners/maintainers can update PR/issue status
- **Repository Settings**: Only owners/maintainers can update

### Branch Protection

Repository owners can protect branches:

- **Require Pull Requests**: Direct pushes blocked, must use PRs
- **Require Reviews**: PRs need approval before merging
- **Require Status Checks**: Custom checks must pass

Configure via:
- **Web Interface**: Repository settings → Branch Protection
- **API**: `POST /api/repos/{npub}/{repo}/branch-protection`

## Code Editor

The web interface includes a full-featured code editor with:

- **Syntax Highlighting**: Supports many languages
- **Line Numbers**: Easy navigation
- **Word Wrap**: Toggle for long lines
- **Search/Replace**: Find and replace functionality
- **File Browser**: Navigate directory structure

## Commit Signing

Commits can be automatically signed using Nostr keys:

- **CLI**: Automatic signing via commit hook (if configured)
- **Web Interface**: Commits are signed by the server using your NIP-07 key

Commit signatures are stored as Nostr events (kind 1640) and can be verified.

## File Size Limits

- **Maximum file size**: 500 MB per file
- **Maximum repository size**: 2 GB total

These limits prevent abuse and ensure reasonable resource usage.

## Next Steps

- [Managing a repo](./managing-repos.md) - Complete repository management guide
- [REST API and CLI](./api-and-cli.md) - Programmatic access
