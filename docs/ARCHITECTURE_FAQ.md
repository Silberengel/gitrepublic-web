# Architecture FAQ

Answers to common questions about gitrepublic-web's architecture and design decisions.

## 1. Session State

### Where does session state live?

**Answer**: Session state lives entirely on the client (browser). There is **no server-side session storage**.

- **Client-side**: User's public key (`userPubkey`) is stored in Svelte component state (`$state`)
- **No server storage**: The server does not maintain session cookies, tokens, or any session database
- **Stateless authentication**: Each request is authenticated independently using:
  - **NIP-07**: Browser extension (Alby, nos2x) for web UI operations
  - **NIP-98**: HTTP authentication events for git operations

### Implementation Details

```typescript
// Client-side state (src/routes/+page.svelte)
let userPubkey = $state<string | null>(null);

// Login: Get pubkey from NIP-07 extension
async function login() {
  userPubkey = await getPublicKeyWithNIP07();
}

// Logout: Clear client state
function logout() {
  userPubkey = null;
}
```

**Why stateless?**
- Decentralized design: No central session authority
- Scalability: No session database to manage
- Privacy: Server doesn't track user sessions
- Nostr-native: Uses Nostr's cryptographic authentication

## 2. Session Scope

### When does a session begin and end?

**Answer**: Since there's no server-side session, the "session" is really just client-side authentication state:

- **Begins**: When user connects their NIP-07 extension and calls `login()`
  - The extension provides the user's public key
  - This is stored in component state for the current page load
  
- **Ends**: 
  - When user calls `logout()` (sets `userPubkey = null`)
  - When browser tab/window is closed (state is lost)
  - When page is refreshed (state is lost unless persisted)

**Note**: There's currently **no persistence** of login state across page refreshes. Users need to reconnect their NIP-07 extension on each page load.

**Potential Enhancement**: Could add localStorage to persist `userPubkey` across sessions, but this is a design decision - some prefer explicit re-authentication for security.

## 3. Repository Settings Storage

### Where are repo settings stored?

**Answer**: Repository settings are stored **entirely in Nostr events** (kind 30617, NIP-34 repo announcements). **No database is required**.

### Storage Location

- **Nostr Events**: All settings are stored as tags in the repository announcement event:
  - `name`: Repository name
  - `description`: Repository description
  - `clone`: Clone URLs (array)
  - `maintainers`: List of maintainer pubkeys
  - `private`: Privacy flag (`true`/`false`)
  - `relays`: Nostr relays to publish to

### How It Works

1. **Reading Settings**:
   ```typescript
   // Fetch from Nostr relays
   const events = await nostrClient.fetchEvents([{
     kinds: [KIND.REPO_ANNOUNCEMENT],
     authors: [ownerPubkey],
     '#d': [repoName],
     limit: 1
   }]);
   
   // Extract settings from event tags
   const name = event.tags.find(t => t[0] === 'name')?.[1];
   const maintainers = event.tags.filter(t => t[0] === 'maintainers').map(t => t[1]);
   ```

2. **Updating Settings**:
   ```typescript
   // Create new announcement event with updated tags
   const updatedEvent = {
     kind: KIND.REPO_ANNOUNCEMENT,
     pubkey: ownerPubkey,
     tags: [
       ['d', repoName],
       ['name', newName],
       ['maintainers', maintainer1],
       ['maintainers', maintainer2],
       ['private', 'true']
     ]
   };
   
   // Sign with NIP-07 and publish to relays
   const signed = await signEventWithNIP07(updatedEvent);
   await nostrClient.publishEvent(signed, relays);
   ```

### Benefits

- **Decentralized**: Settings live on Nostr relays, not a central database
- **Verifiable**: Cryptographically signed by repository owner
- **Resilient**: Multiple relays store copies
- **No database needed**: Simplifies deployment

### Limitations

- **Event replaceability**: NIP-34 announcements are replaceable (same `d` tag), so latest event wins
- **Relay dependency**: Settings are only as available as the relays
- **No complex queries**: Can't do complex database-style queries

## 4. NIP-98 Authorization Requirements

### What actions require NIP-98 authorization?

**Answer**: NIP-98 is required for **git operations** (clone, push, pull) and **optional for web UI file operations**.

### Required NIP-98 Operations

1. **Git Push Operations** (`POST /api/git/{npub}/{repo}.git/git-receive-pack`)
   - **Always required** for push operations
   - Verifies user is repository owner or maintainer
   - Validates event signature, timestamp, URL, and method

2. **Private Repository Clone/Fetch** (`GET /api/git/{npub}/{repo}.git/info/refs?service=git-upload-pack`)
   - **Required** if repository is marked as private
   - Verifies user has view access (owner or maintainer)
   - Public repos don't require authentication

3. **Private Repository Fetch** (`POST /api/git/{npub}/{repo}.git/git-upload-pack`)
   - **Required** if repository is private
   - Same authentication as clone

### Optional NIP-98 Operations

4. **File Write Operations** (`POST /api/repos/{npub}/{repo}/file`)
   - **Optional**: Can use NIP-07 (browser extension) or NIP-98
   - NIP-98 is useful for automated scripts or git operations
   - NIP-07 is more convenient for web UI

### NIP-98 Verification Process

```typescript
// Server verifies:
1. Event signature (cryptographic verification)
2. Event timestamp (within 60 seconds)
3. URL matches request URL exactly
4. HTTP method matches
5. Payload hash matches request body (for POST)
6. Pubkey is repository owner or maintainer
```

### API Endpoints Summary

| Endpoint | NIP-98 Required? | Notes |
|----------|------------------|-------|
| `GET /api/git/.../info/refs` | Only for private repos | Public repos: no auth needed |
| `POST /api/git/.../git-upload-pack` | Only for private repos | Public repos: no auth needed |
| `POST /api/git/.../git-receive-pack` | **Always required** | All push operations |
| `POST /api/repos/.../file` | Optional | Can use NIP-07 instead |
| `GET /api/repos/.../file` | No | Uses query param `userPubkey` |
| `POST /api/repos/.../settings` | No | Uses NIP-07 (browser extension) |

## 5. Repository Announcement Polling

### Why is the server polling instead of using subscriptions?

**Answer**: The server uses **polling** (every 60 seconds) instead of persistent WebSocket subscriptions for simplicity and reliability.

### Current Implementation

```typescript
// src/lib/services/nostr/repo-polling.ts
constructor(
  pollingInterval: number = 60000 // 1 minute default
) {
  // Poll immediately, then every interval
  this.intervalId = setInterval(() => {
    this.poll();
  }, this.pollingInterval);
}
```

**Polling Schedule**:
- **Frequency**: Every 60 seconds (1 minute)
- **Type**: Long-running background process
- **Location**: Started in `hooks.server.ts` when server starts
- **Not a cron job**: Runs continuously in the Node.js process

### Why Polling Instead of Subscriptions?

**Advantages of Polling**:
1. **Simplicity**: No need to maintain persistent WebSocket connections
2. **Reliability**: If a connection drops, polling automatically retries
3. **Resource efficiency**: Only connects when fetching, not maintaining long-lived connections
4. **Easier error handling**: Each poll is independent

**Disadvantages of Polling**:
1. **Latency**: Up to 60 seconds delay before new repos are discovered
2. **Relay load**: More frequent queries to relays
3. **Less real-time**: Not immediate notification of new repos

### Could We Use Subscriptions?

**Yes, but with trade-offs**:

```typescript
// Potential subscription implementation
const ws = new WebSocket(relay);
ws.send(JSON.stringify(['REQ', 'sub-id', {
  kinds: [KIND.REPO_ANNOUNCEMENT],
  '#clone': [domain]
}]));

ws.on('message', (event) => {
  // Handle new repo announcement immediately
});
```

**Challenges**:
- Need to maintain WebSocket connections to multiple relays
- Handle connection drops and reconnections
- More complex error handling
- Higher memory usage for long-lived connections

### Recommendation

For most use cases, **60-second polling is acceptable**:
- New repos don't need to be discovered instantly
- Reduces complexity
- More reliable for production

For real-time requirements, subscriptions could be added as an enhancement, but polling is a solid default.

## 6. Branch Protection

### What is the scheme for branch protection?

**Answer**: **Branch protection is not currently implemented**. This is a missing feature.

### Current State

**What Exists**:
- Maintainers can create branches (`POST /api/repos/{npub}/{repo}/branches`)
- Only maintainers can create branches (not regular users)
- No protection for `main`/`master` branch

**What's Missing**:
- ❌ No branch protection rules
- ❌ No restriction on pushing to `main`/`master`
- ❌ No required pull request reviews
- ❌ No required status checks
- ❌ No force push restrictions

### Current Authorization

```typescript
// src/routes/api/repos/[npub]/[repo]/branches/+server.ts
const isMaintainer = await maintainerService.isMaintainer(userPubkeyHex, repoOwnerPubkey, repo);
if (!isMaintainer) {
  return error(403, 'Only repository maintainers can create branches');
}
```

**Authorized Users**:
- **Repository Owner**: Can do everything
- **Maintainers**: Listed in repo announcement `maintainers` tags
  - Can create branches
  - Can push to any branch (including main)
  - Can write files

### Proposed Branch Protection Implementation

**Option 1: Nostr Events (Recommended)**
- Create new event kind (e.g., 30620) for branch protection rules
- Store rules in Nostr events:
  ```json
  {
    "kind": 30620,
    "tags": [
      ["d", "repo-name"],
      ["branch", "main", "protected"],
      ["branch", "main", "require-pr"],
      ["branch", "main", "require-reviewers", "pubkey1", "pubkey2"]
    ]
  }
  ```

**Option 2: In-Repo Configuration**
- Store `.gitrepublic/branch-protection.json` in repository
- Git-based, version-controlled
- Requires pull request to change rules

**Option 3: Server Configuration**
- Store in server database (conflicts with decentralized design)
- Not recommended for this architecture

### Recommended Approach

**Hybrid: Nostr Events + In-Repo Config**

1. **Default rules**: Stored in Nostr events (kind 30620)
2. **Override rules**: Can be stored in `.gitrepublic/branch-protection.json` in repo
3. **Enforcement**: Server checks rules before allowing push to protected branches

**Example Rules**:
```json
{
  "protectedBranches": ["main", "master"],
  "requirePullRequest": true,
  "requireReviewers": ["pubkey1", "pubkey2"],
  "allowForcePush": false,
  "requireStatusChecks": ["ci", "lint"]
}
```

### Implementation Priority

This is a **medium-priority feature** that would enhance security and workflow, but the current system works for basic use cases where:
- Owners trust their maintainers
- Repositories are small teams
- Formal review processes aren't needed

For enterprise use cases, branch protection would be highly recommended.

---

## Summary

| Question | Answer |
|----------|--------|
| **Session State** | Client-side only, no server storage |
| **Session Scope** | Begins on NIP-07 login, ends on logout or page close |
| **Repo Settings** | Stored in Nostr events (kind 30617), no database needed |
| **NIP-98 Required** | Git push (always), private repo clone/fetch (conditional) |
| **Polling Schedule** | Every 60 seconds, long-running background process |
| **Branch Protection** | ✅ **Implemented** - Stored in Nostr events (kind 30620) |

---