# Custom Event Kinds

This document describes the custom event kinds used by GitRepublic that are not part of any standard NIP. These may be proposed as NIPs in the future.

## Kind 1640: Commit Signature

**Status**: Custom implementation (not in any NIP)

Git commit signature events are used to cryptographically sign git commits using Nostr keys. This provides cryptographic proof that a commit was made by a specific Nostr user.

### Event Structure

```jsonc
{
  "kind": 1640,
  "pubkey": "committer_pubkey_hex...",
  "created_at": 1234567890,
  "content": "Signed commit: <commit-message>\n\n<optional-additional-info>",
  "tags": [
    ["commit", "abc123def456..."], // Final commit hash (added after commit is created)
    ["author", "John Doe"],        // Author name
    ["author", "john@example.com"], // Author email (second author tag)
    ["message", "Fix bug in feature"], // Commit message
    ["e", "nip98_auth_event_id"]   // Optional: Reference to NIP-98 auth event
  ],
  "id": "...",
  "sig": "..."
}
```

### Tag Descriptions

- **`commit`** (required): The final commit hash after the commit is created. This tag is added after the commit is created, as the hash is not known beforehand.
- **`author`** (required, appears twice): First occurrence contains the author name, second contains the author email.
- **`message`** (required): The commit message text.
- **`e`** (optional): Reference to a NIP-98 authentication event if the commit was made via HTTP git operations.

### Usage in GitRepublic

1. **Client-Side Signing**: When users make commits through the web interface, they can sign commits using NIP-07 (browser extension). The signature event is created client-side and keys never leave the browser.

2. **Server-Side Signing**: For git operations (push via git client), commits can be signed using NIP-98 authentication events. The commit signature event references the NIP-98 event.

3. **Commit Message Embedding**: The signature is embedded in the git commit message as a trailer:
   ```
   Nostr-Signature: <event_id> <signature>
   ```

4. **Verification**: Commit signatures can be verified by:
   - Checking the event signature
   - Verifying the commit hash matches
   - Confirming the author information matches the commit

### Rationale

Using a dedicated kind (1640) prevents spamming the user's feed with commit signatures. It also provides a clear, searchable way to find all commits signed by a specific user.

**Implementation**: `src/lib/services/git/commit-signer.ts`

---

## Kind 1641: Ownership Transfer

**Status**: Custom implementation (not in any NIP)

Repository ownership transfer events enable transferring repository ownership from one pubkey to another. This is a **non-replaceable event** to maintain an immutable chain of ownership.

### Event Structure

#### Regular Ownership Transfer

```jsonc
{
  "kind": 1641,
  "pubkey": "old_owner_pubkey_hex...",
  "created_at": 1234567890,
  "content": "Transferring ownership of repository my-repo to new maintainer",
  "tags": [
    ["a", "30617:old_owner_pubkey.../my-repo"], // Repository address
    ["p", "new_owner_pubkey_hex..."],           // New owner pubkey (hex or npub)
    ["d", "my-repo"]                            // Repository identifier
  ],
  "id": "...",
  "sig": "..."
}
```

#### Self-Transfer (Initial Ownership Proof)

```jsonc
{
  "kind": 1641,
  "pubkey": "owner_pubkey_hex...",
  "created_at": 1234567890,
  "content": "Initial ownership proof for repository my-repo",
  "tags": [
    ["a", "30617:owner_pubkey.../my-repo"],
    ["p", "owner_pubkey_hex..."],              // Same as pubkey (self-transfer)
    ["d", "my-repo"],
    ["t", "self-transfer"]                      // Marker for initial ownership proof
  ],
  "id": "...",
  "sig": "..."
}
```

### Tag Descriptions

- **`a`** (required): Repository address in format `30617:<owner-pubkey>:<repo-name>`
- **`p`** (required): New owner pubkey (can be hex or npub format). For self-transfers, this is the same as the event `pubkey`.
- **`d`** (required): Repository identifier (d-tag from repository announcement)
- **`t`** (optional): `"self-transfer"` marker for initial ownership proofs

### Usage in GitRepublic

1. **Initial Ownership**: When a repository is first created, a self-transfer event (owner → owner) is published to establish initial ownership proof. This creates an immutable record that the owner created the repository.

2. **Ownership Transfers**: When transferring ownership to another user:
   - The current owner creates a kind 1641 event with the new owner's pubkey
   - The new owner must accept the transfer (future enhancement)
   - The transfer creates an immutable chain of ownership

3. **Ownership Verification**: To verify current ownership:
   - Find the repository announcement (kind 30617)
   - Find all ownership transfer events for that repository
   - Follow the chain from the initial self-transfer to the most recent transfer
   - The most recent transfer's `p` tag indicates the current owner

4. **Fork Operations**: When forking a repository, a self-transfer event is created to prove the fork owner's claim to the forked repository.

### Rationale

NIP-34 doesn't define ownership transfers. This custom kind provides:
- **Immutability**: Non-replaceable events create an unchangeable chain
- **Auditability**: Full history of ownership changes
- **Security**: Cryptographic proof of ownership transfers
- **Fork Integrity**: Ensures forks can be traced back to their origin

**Implementation**: `src/lib/services/nostr/ownership-transfer-service.ts`

---

## Kind 30620: Branch Protection

**Status**: Custom implementation (not in any NIP)

Branch protection rules allow repository owners to enforce policies on specific branches, such as requiring pull requests, reviewers, or status checks before merging.

### Event Structure

```jsonc
{
  "kind": 30620,
  "pubkey": "owner_pubkey_hex...",
  "created_at": 1234567890,
  "content": "",
  "tags": [
    ["d", "my-repo"],                           // Repository name
    ["a", "30617:owner_pubkey.../my-repo"],    // Repository address
    
    // Branch: main
    ["branch", "main"],                         // Branch name
    ["branch", "main", "require-pr"],          // Require pull request (no value)
    ["branch", "main", "require-reviewers", "npub1reviewer..."], // Required reviewer
    ["branch", "main", "require-reviewers", "npub2reviewer..."], // Another reviewer
    ["branch", "main", "require-status", "ci"], // Required status check
    ["branch", "main", "require-status", "lint"], // Another required status
    
    // Branch: develop
    ["branch", "develop"],
    ["branch", "develop", "require-pr"],
    ["branch", "develop", "allow-force-push"],  // Allow force push
    ["branch", "develop", "allowed-maintainers", "npub1maintainer..."] // Can bypass protection
  ],
  "id": "...",
  "sig": "..."
}
```

### Tag Descriptions

- **`d`** (required): Repository name/identifier
- **`a`** (required): Repository address in format `30617:<owner>:<repo>`
- **`branch`** (required, appears multiple times): Branch name and protection settings
  - `["branch", "<name>"]`: Declares a protected branch
  - `["branch", "<name>", "require-pr"]`: Requires pull request before merging
  - `["branch", "<name>", "allow-force-push"]`: Allows force push to this branch
  - `["branch", "<name>", "require-reviewers", "<pubkey>"]`: Required reviewer (can appear multiple times)
  - `["branch", "<name>", "require-status", "<check-name>"]`: Required status check (can appear multiple times)
  - `["branch", "<name>", "allowed-maintainers", "<pubkey>"]`: Maintainer who can bypass protection (can appear multiple times)

### Protection Rules

1. **Require Pull Request**: Direct pushes to protected branches are blocked. All changes must come through pull requests.

2. **Require Reviewers**: Pull requests to protected branches must be approved by at least one of the specified reviewers.

3. **Require Status Checks**: All specified status checks must pass before a PR can be merged.

4. **Allow Force Push**: By default, force pushes are blocked on protected branches. This tag allows them.

5. **Allowed Maintainers**: Specified maintainers can bypass protection rules (e.g., for emergency fixes).

### Usage in GitRepublic

1. **Setting Protection**: Repository owners create/update branch protection rules by publishing a kind 30620 event.

2. **Enforcement**: When users attempt to:
   - Push directly to a protected branch → Blocked if `require-pr` is set
   - Merge a PR to a protected branch → Requires reviewers and status checks if specified
   - Force push → Blocked unless `allow-force-push` is set or user is an allowed maintainer

3. **Replaceable Events**: Branch protection events are replaceable (same `d` tag). Publishing a new event replaces all previous rules.

4. **Access Control**: Only the repository owner can create/update branch protection rules.

### Rationale

NIP-34 doesn't define branch protection. This custom kind provides:
- **Code Quality**: Enforces code review and testing before merging
- **Security**: Prevents direct pushes to critical branches
- **Flexibility**: Configurable rules per branch
- **Maintainability**: Clear, auditable protection rules

**Implementation**: `src/lib/services/nostr/branch-protection-service.ts` (if implemented), referenced in repository settings

---

## Summary

| Kind | Name | Replaceable | Purpose |
|------|------|-------------|---------|
| 1640 | Commit Signature | No | Cryptographically sign git commits |
| 1641 | Ownership Transfer | No | Transfer repository ownership (immutable chain) |
| 30620 | Branch Protection | Yes | Enforce branch protection rules |

These custom kinds extend NIP-34's git collaboration features with additional functionality needed for a production git hosting platform. They may be proposed as NIPs in the future to standardize these features across the Nostr ecosystem.
