# NIP Compliance and Documentation Index

This document serves as an index to all Nostr Improvement Proposals (NIPs) used by GitRepublic and their implementation details.

## Standard NIPs

GitRepublic implements the following standard NIPs:

### Core Protocol

- **[NIP-01: Basic Protocol Flow](01.md)** - Event structure, signatures, and client-relay communication
  - Foundation for all Nostr events
  - Used for relay write proof fallback (kind 1)

### Authentication & Identity

- **[NIP-02: Contact List](02.md)** - Contact list (kind 3)
  - Used for repository filtering ("Show only my repos and those of my contacts")
  - Fallback for relay discovery

- **[NIP-07: Browser Extension Authentication](07.md)** - `window.nostr` capability
  - Primary authentication method for GitRepublic
  - Used for signing all repository-related events

- **[NIP-19: bech32-encoded Entities](19.md)** - bech32 encoding (npub, nsec, note, nevent, naddr)
  - User-friendly display of pubkeys and event references
  - Used throughout the UI for repository URLs and search

- **[NIP-98: HTTP Authentication](98.md)** - HTTP auth events (kind 27235)
  - Authenticates git operations (push, pull, clone)
  - Authenticates API requests

### Event Management

- **[NIP-09: Event Deletion](09.md)** - Deletion requests (kind 5)
  - Used for cleaning up failed fork attempts

- **[NIP-10: Event References](10.md)** - Event references (e, p tags)
  - Used in patch series for threading patches

- **[NIP-22: Comments](22.md)** - Comment events (kind 1111)
  - Threaded discussions on PRs, issues, and patches

### Git Collaboration

- **[NIP-34: Git Repository Announcements](34.md)** - Git collaboration on Nostr
  - **30617**: Repository announcements
  - **30618**: Repository state
  - **1617**: Patches
  - **1618**: Pull requests
  - **1619**: Pull request updates
  - **1621**: Issues
  - **1630-1633**: Status events (Open, Applied/Merged, Closed, Draft)

### Relay & Discovery

- **[NIP-65: Relay List Metadata](65.md)** - Relay list (kind 10002)
  - Discovers user's preferred relays for publishing events

### Content Features

- **[NIP-84: Highlights](84.md)** - Highlight events (kind 9802)
  - Code selection and review features
  - Extended with file/line tags for code context

## Custom Event Kinds

GitRepublic uses custom event kinds not defined in any standard NIP:

- **[Custom Event Kinds](CustomKinds.md)**
  - **1640**: Commit Signature - Cryptographically sign git commits
  - **1641**: Ownership Transfer - Transfer repository ownership (immutable chain)
  - **30620**: Branch Protection - Enforce branch protection rules

## Quick Reference

### Event Kinds Used

| Kind | Name | NIP | Replaceable | Documentation |
|------|------|-----|-------------|---------------|
| 1 | Text Note | NIP-01 | No | [01.md](01.md) |
| 3 | Contact List | NIP-02 | Yes | [02.md](02.md) |
| 5 | Deletion Request | NIP-09 | No | [09.md](09.md) |
| 1111 | Comment | NIP-22 | No | [22.md](22.md) |
| 1617 | Patch | NIP-34 | No | [34.md](34.md) |
| 1618 | Pull Request | NIP-34 | No | [34.md](34.md) |
| 1619 | Pull Request Update | NIP-34 | No | [34.md](34.md) |
| 1621 | Issue | NIP-34 | No | [34.md](34.md) |
| 1630 | Status Open | NIP-34 | No | [34.md](34.md) |
| 1631 | Status Applied | NIP-34 | No | [34.md](34.md) |
| 1632 | Status Closed | NIP-34 | No | [34.md](34.md) |
| 1633 | Status Draft | NIP-34 | No | [34.md](34.md) |
| **1640** | **Commit Signature** | **Custom** | **No** | **[CustomKinds.md](CustomKinds.md)** |
| **1641** | **Ownership Transfer** | **Custom** | **No** | **[CustomKinds.md](CustomKinds.md)** |
| 30617 | Repo Announcement | NIP-34 | Yes | [34.md](34.md) |
| 30618 | Repo State | NIP-34 | Yes | [34.md](34.md) |
| **30620** | **Branch Protection** | **Custom** | **Yes** | **[CustomKinds.md](CustomKinds.md)** |
| 9802 | Highlight | NIP-84 | No | [84.md](84.md) |
| 10002 | Relay List | NIP-65 | Yes | [65.md](65.md) |
| 27235 | HTTP Auth | NIP-98 | No | [98.md](98.md) |

## Implementation Status

All listed NIPs are **fully implemented** and compliant with their specifications. Each NIP document includes a "GitRepublic Usage" section describing how the NIP is used in this application.

## Compliance Verification

For detailed compliance verification and implementation notes, see the individual NIP documents linked above. Each document includes:
- The original NIP specification
- GitRepublic-specific usage documentation
- Implementation details and code references

## See Also

- [NIP-34 Documentation](34.md) - Core git collaboration features
- [Custom Event Kinds](CustomKinds.md) - GitRepublic-specific event kinds
- [Architecture FAQ](ARCHITECTURE_FAQ.md) - System architecture overview
- [Implementation Details](IMPLEMENTATION.md) - Technical implementation notes
