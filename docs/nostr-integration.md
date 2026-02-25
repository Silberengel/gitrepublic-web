# How GitRepublic Integrates Nostr

GitRepublic is built entirely on Nostr, using Nostr events and relays for repository announcements, authentication, and collaboration. This page explains how the git server integrates with Nostr.

## Core Integration Points

### Repository Announcements (NIP-34)

Repositories are announced via Nostr events (kind 30617) that are published to Nostr relays. These announcements contain:

- Repository metadata (name, description, clone URLs)
- Visibility settings (public, unlisted, restricted, private)
- Project relays for event publishing
- Maintainer information
- Clone URLs pointing to git servers

The server automatically polls Nostr relays for new repository announcements and provisions git repositories when found.

### Authentication

GitRepublic uses two Nostr authentication methods:

1. **NIP-07** - Browser extension authentication for web interface
   - Users connect via browser extensions (Alby, nos2x, etc.)
   - No private keys stored on server
   - Secure, user-controlled authentication

2. **NIP-98** - HTTP authentication for git operations
   - Ephemeral events (kind 27235) for each git operation
   - Includes request URL, method, and payload hash
   - Verified by server before allowing operations
   - Used for clone, push, pull operations

### Event Publishing

All repository-related events are published to Nostr relays based on repository visibility:

- **Public**: Published to all default relays + project relays
- **Unlisted**: Published only to project relays
- **Restricted**: Published only to project relays
- **Private**: Not published to relays (git-only, stored locally)

Events are always saved to the repository's `nostr/repo-events.jsonl` file for offline papertrail, regardless of visibility.

### Ownership and Permissions

Repository ownership is tracked via Nostr events:

- **Self-transfer events** (kind 1641) prove initial ownership
- **Ownership transfer events** (kind 1641) create a chain of ownership
- **Maintainer information** stored in repository announcements
- All ownership events saved to repository for verification

### Collaboration Events

All collaboration features use Nostr events:

- **Pull Requests** (kind 1618)
- **Pull Request Updates** (kind 1619)
- **Issues** (kind 1621)
- **Status Events** (kinds 1630-1633)
- **Patches** (kind 1617)
- **Highlights** (kind 9802, NIP-84)
- **Comments** (kind 1111, NIP-22)

These events are published to relays (based on visibility) and stored in the repository.

## Event Flow

1. **User creates repository announcement** → Published to Nostr relays
2. **Server polls relays** → Finds announcement → Provisions git repository
3. **User pushes changes** → Server verifies NIP-98 auth → Processes push
4. **Collaboration events created** → Published to relays → Stored in repo
5. **Other users discover events** → Via relays or repository storage

## Benefits of Nostr Integration

- **Decentralized**: No single point of failure
- **Censorship Resistant**: Events stored on multiple relays
- **User Controlled**: Users own their keys and data
- **Interoperable**: Works with any Nostr client
- **Offline Papertrail**: All events saved to repository

## Technical Details

For complete technical details on event kinds, tags, and structure, see [Specs Used](./specs.md).
