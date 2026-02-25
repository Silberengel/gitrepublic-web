# Specs Used

Complete list of Nostr Improvement Proposals (NIPs), GRASP specifications, and custom event kinds used by GitRepublic.

## Standard NIPs

### Core Protocol

- **[NIP-01: Basic Protocol Flow](https://github.com/nostr-protocol/nips/blob/master/01.md)**
  - Event structure, signatures, and client-relay communication
  - Foundation for all Nostr events

### Authentication & Identity

- **[NIP-07: Browser Extension Authentication](https://github.com/nostr-protocol/nips/blob/master/07.md)**
  - `window.nostr` capability for browser extensions
  - Primary authentication method for GitRepublic web interface
  - Used for signing all repository-related events

- **[NIP-19: bech32-encoded Entities](https://github.com/nostr-protocol/nips/blob/master/19.md)**
  - bech32 encoding (npub, nsec, note, nevent, naddr)
  - User-friendly display of pubkeys and event references
  - Used throughout the UI for repository URLs and search

- **[NIP-98: HTTP Authentication](https://github.com/nostr-protocol/nips/blob/master/98.md)**
  - HTTP auth events (kind 27235)
  - Authenticates git operations (push, pull, clone)
  - Authenticates API requests
  - Ephemeral events for each request

### Event Management

- **[NIP-09: Event Deletion](https://github.com/nostr-protocol/nips/blob/master/09.md)**
  - Deletion requests (kind 5)
  - Used for cleaning up failed operations

- **[NIP-10: Event References](https://github.com/nostr-protocol/nips/blob/master/10.md)**
  - Event references (e, p tags)
  - Used in patch series for threading patches
  - Used in PR updates and comments

- **[NIP-22: Comments](https://github.com/nostr-protocol/nips/blob/master/22.md)**
  - Comment events (kind 1111)
  - Threaded discussions on PRs, issues, and patches
  - NIP-10 reply threading support

### Git Collaboration

- **[NIP-34: Git Repository Announcements](https://github.com/nostr-protocol/nips/blob/master/34.md)**
  - Complete git collaboration specification
  - **30617**: Repository announcements (replaceable)
  - **30618**: Repository state (replaceable, optional)
  - **1617**: Patches
  - **1618**: Pull requests
  - **1619**: Pull request updates
  - **1621**: Issues
  - **1630**: Status Open
  - **1631**: Status Applied/Merged
  - **1632**: Status Closed
  - **1633**: Status Draft

### Relay & Discovery

- **[NIP-02: Contact List](https://github.com/nostr-protocol/nips/blob/master/02.md)**
  - Contact list (kind 3)
  - Used for repository filtering
  - Fallback for relay discovery

- **[NIP-65: Relay List Metadata](https://github.com/nostr-protocol/nips/blob/master/65.md)**
  - Relay list (kind 10002)
  - Discovers user's preferred relays for publishing events
  - Used to determine which relays to publish to

### Content Features

- **[NIP-84: Highlights](https://github.com/nostr-protocol/nips/blob/master/84.md)**
  - Highlight events (kind 9802)
  - Code selection and review features
  - Extended with file/line tags for code context

### Payment Targets

- **[NIP-A3: Payment Targets](https://github.com/nostr-protocol/nips/blob/master/A3.md)**
  - Payment target events (kind 10133)
  - `payto://` URI scheme (RFC-8905)
  - Supports multiple payment types (Lightning, Bitcoin, Ethereum, etc.)

See [NIP-A3 documentation](./NIP-A3.md) for complete details.

## GRASP Specifications

GitRepublic provides minimal GRASP interoperability:

- **GRASP-01**: Server identification and clone URL patterns
  - Detects GRASP servers from repository announcements
  - Identifies GRASP servers by URL pattern and relay tags

- **GRASP-02**: Proactive synchronization (not implemented)
  - We don't do server-side hourly pulls
  - User-controlled via CLI `pull-all` command

- **GRASP-05**: Archive mode (not implemented)

For GRASP documentation, see the GRASP specification repository.

## Custom Event Kinds

GitRepublic uses custom event kinds not defined in any standard NIP:

### Kind 1640: Commit Signature

Cryptographically sign git commits using Nostr keys.

**Tags**:
- `author`: Author name (first occurrence)
- `author`: Author email (second occurrence)
- `message`: Commit message
- `e`: Optional reference to NIP-98 auth event

**Note:** Commit signature events do not include the commit hash because the commit-msg hook runs before the commit is created. Verification matches events to commits by comparing the commit message.

**Status**: Custom implementation (may be proposed as NIP in future)

See [Custom Event Kinds](./CustomKinds.md#kind-1640-commit-signature) for complete documentation.

### Kind 1641: Ownership Transfer

Transfer repository ownership from one pubkey to another.

**Tags**:
- `a`: Repository address (30617:pubkey:repo)
- `p`: New owner pubkey
- `d`: Repository name
- `t`: "self-transfer" marker (for initial ownership proof)

**Status**: Custom implementation (non-replaceable to maintain ownership chain)

See [Custom Event Kinds](./CustomKinds.md#kind-1641-ownership-transfer) for complete documentation.

### Kind 30620: Branch Protection

Enforce branch protection rules (require PRs, reviews, status checks).

**Tags**:
- `d`: Repository name
- `a`: Repository identifier
- `branch`: Branch name and protection settings

**Status**: Custom implementation (replaceable)

See [Custom Event Kinds](./CustomKinds.md#30620---branch_protection) for complete documentation.

## Event Kind Reference

| Kind | Name | NIP | Replaceable | Documentation |
|------|------|-----|-------------|---------------|
| 1 | Text Note | NIP-01 | No | [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) |
| 3 | Contact List | NIP-02 | Yes | [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) |
| 5 | Deletion Request | NIP-09 | No | [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) |
| 1111 | Comment | NIP-22 | No | [NIP-22](https://github.com/nostr-protocol/nips/blob/master/22.md) |
| 1617 | Patch | NIP-34 | No | [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) |
| 1618 | Pull Request | NIP-34 | No | [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) |
| 1619 | Pull Request Update | NIP-34 | No | [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) |
| 1621 | Issue | NIP-34 | No | [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) |
| 1630 | Status Open | NIP-34 | No | [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) |
| 1631 | Status Applied | NIP-34 | No | [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) |
| 1632 | Status Closed | NIP-34 | No | [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) |
| 1633 | Status Draft | NIP-34 | No | [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) |
| **1640** | **Commit Signature** | **Custom** | **No** | **[CustomKinds.md](./CustomKinds.md)** |
| **1641** | **Ownership Transfer** | **Custom** | **No** | **[CustomKinds.md](./CustomKinds.md)** |
| 30617 | Repo Announcement | NIP-34 | Yes | [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) |
| 30618 | Repo State | NIP-34 | Yes | [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md) |
| **30620** | **Branch Protection** | **Custom** | **Yes** | **[CustomKinds.md](./CustomKinds.md)** |
| 9802 | Highlight | NIP-84 | No | [NIP-84](https://github.com/nostr-protocol/nips/blob/master/84.md) |
| 10002 | Relay List | NIP-65 | Yes | [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) |
| 10133 | Payment Targets | NIP-A3 | Yes | [NIP-A3](https://github.com/nostr-protocol/nips/blob/master/A3.md) |
| 27235 | HTTP Auth | NIP-98 | No | [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) |

## Complete Event Documentation

For complete event structure documentation with JSON examples, see:
- [Custom Event Kinds](./CustomKinds.md) - Custom event documentation

## Next Steps

- [How this git server integrates Nostr](./nostr-integration.md) - Understanding the integration
- [Tech stack used](./tech-stack.md) - Technical implementation
