# Implementation Guide for git-http-backend Integration

## Overview

The git-http-backend integration needs to be implemented in `/src/routes/api/git/[...path]/+server.ts`. This route will handle all git HTTP operations (clone, push, pull).

## URL Structure

All git requests will follow this pattern:
- `GET /api/git/{npub}/{repo-name}.git/info/refs?service=git-upload-pack` (clone/fetch)
- `GET /api/git/{npub}/{repo-name}.git/info/refs?service=git-receive-pack` (push capability check)
- `POST /api/git/{npub}/{repo-name}.git/git-upload-pack` (fetch)
- `POST /api/git/{npub}/{repo-name}.git/git-receive-pack` (push)

## Implementation Steps

### 1. Parse Request Path

Extract `npub` and `repo-name` from the path parameter:
```typescript
const match = params.path.match(/^([^\/]+)\/([^\/]+)\.git\/(.+)$/);
if (!match) return new Response('Invalid path', { status: 400 });
const [, npub, repoName, gitPath] = match;
```

### 2. Authenticate with NIP-98

For push operations, verify NIP-98 authentication:
```typescript
import { verifyEvent } from 'nostr-tools';

const authHeader = request.headers.get('Authorization');
if (!authHeader?.startsWith('Nostr ')) {
  return new Response('Unauthorized', { status: 401 });
}

const nostrEvent = JSON.parse(authHeader.slice(7));
if (!verifyEvent(nostrEvent)) {
  return new Response('Invalid signature', { status: 401 });
}

// Verify pubkey matches repo owner
if (nostrEvent.pubkey !== expectedPubkey) {
  return new Response('Unauthorized', { status: 403 });
}
```

### 3. Map to Git Repository Path

Use `RepoManager` to get the full path:
```typescript
import { RepoManager } from '$lib/services/git/repo-manager.js';

const repoManager = new RepoManager(process.env.GIT_REPO_ROOT || '/repos');
const repoPath = join(repoManager.repoRoot, npub, `${repoName}.git`);

if (!repoManager.repoExists(repoPath)) {
  return new Response('Repository not found', { status: 404 });
}
```

### 4. Proxy to git-http-backend

Execute git-http-backend as a subprocess:
```typescript
import { spawn } from 'child_process';
import { env } from '$env/dynamic/private';

const gitHttpBackend = '/usr/lib/git-core/git-http-backend'; // or wherever it's installed

const envVars = {
  ...process.env,
  GIT_PROJECT_ROOT: repoManager.repoRoot,
  GIT_HTTP_EXPORT_ALL: '1',
  REQUEST_METHOD: request.method,
  PATH_INFO: `/${npub}/${repoName}.git/${gitPath}`,
  QUERY_STRING: url.searchParams.toString(),
  CONTENT_TYPE: request.headers.get('Content-Type') || '',
  CONTENT_LENGTH: request.headers.get('Content-Length') || '0',
};

const gitProcess = spawn(gitHttpBackend, [], {
  env: envVars,
  stdio: ['pipe', 'pipe', 'pipe']
});

// Pipe request body to git-http-backend
if (request.body) {
  request.body.pipeTo(gitProcess.stdin);
}

// Return git-http-backend response
return new Response(gitProcess.stdout, {
  headers: {
    'Content-Type': 'application/x-git-upload-pack-result',
    // or 'application/x-git-receive-pack-result' for push
  }
});
```

### 5. Post-Receive Hook

After successful push, sync to other remotes:
```typescript
// After successful git-receive-pack
if (gitPath === 'git-receive-pack' && request.method === 'POST') {
  // Fetch NIP-34 announcement for this repo
  const announcement = await fetchRepoAnnouncement(npub, repoName);
  if (announcement) {
    const cloneUrls = extractCloneUrls(announcement);
    const otherUrls = cloneUrls.filter(url => !url.includes('git.imwald.eu'));
    await repoManager.syncToRemotes(repoPath, otherUrls);
  }
}
```

## Alternative: Use a Git Server Library

Instead of calling git-http-backend directly, you could use a Node.js git server library:

- `isomorphic-git` with `@isomorphic-git/http-server`
- `node-git-server`
- Custom implementation using `dugite` or `simple-git`

## Testing

Test with:
```bash
# Clone
git clone https://git.imwald.eu/{npub}/{repo-name}.git

# Push (requires NIP-98 auth)
git push origin main
```

For NIP-98 authentication, you'll need a git credential helper that:
1. Intercepts git HTTP requests
2. Signs a Nostr event with the user's key
3. Adds `Authorization: Nostr {event}` header
