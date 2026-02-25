# About GitRepublic

GitRepublic is a decentralized git hosting platform built on Nostr. Unlike traditional git hosting services, GitRepublic provides truly decentralized repository hosting where repositories are announced on Nostr relays, giving you full control and ownership.

## Key Features

- **Decentralized**: Repositories are announced on Nostr relays, no central authority
- **Nostr-based Authentication**: Uses NIP-07 (browser extensions) and NIP-98 (HTTP authentication)
- **Full Control**: Own your repositories, transfer ownership, manage maintainers, control access
- **Open Collaboration**: Create pull requests, issues, and collaborate using Nostr events
- **Multi-remote Sync**: Automatically syncs to multiple remotes when you push
- **GRASP Compatible**: Works seamlessly with GRASP servers

## Documentation Topics

### Core Concepts

- [How this git server integrates Nostr](./nostr-integration.md) - Understanding the Nostr-based architecture

### Repository Operations

- [Creating, forking, transferring, or cloning a repo](./repo-operations.md) - Getting started with repositories

- [Editing a repo](./editing-repos.md) - Branch management, file management, auto-provisioning, file-editing and event-creation permissions

- [Managing a repo](./managing-repos.md) - Complete guide to repository management
  - [Repo Header](./managing-repos.md#repo-header)
  - [Clone Section](./managing-repos.md#clone-section)
  - [File Tab](./managing-repos.md#file-tab)
  - [Commit Tab](./managing-repos.md#commit-tab)
  - [PRs Tab](./managing-repos.md#prs-tab)
  - [Issues Tab](./managing-repos.md#issues-tab)
  - [Patches Tab](./managing-repos.md#patches-tab)
  - [Discussions Tab](./managing-repos.md#discussions-tab)
  - [Docs Tab](./managing-repos.md#docs-tab)
  - [History Tab](./managing-repos.md#history-tab)
  - [Tags Tab](./managing-repos.md#tags-tab)

### Discovery and Access

- [Search and viewing external git repos](./search-and-external-repos.md) - Finding and viewing repositories

### API and CLI

- [REST API and CLI](./api-and-cli.md) - Programmatic access and command-line tools

### User Features

- [Profile pages](./profile-pages.md) - User profiles and payment targets

- [Settings and Dashboard](./settings-and-dashboard.md) - User account management

### Infrastructure

- [Working with GRASP servers](./grasp-servers.md) - GRASP protocol compatibility

- [Lightweight versus Enterprise modes](./deployment-modes.md) - Deployment options and security

### Technical Details

- [Tech stack used](./tech-stack.md) - Code editor, syntax highlighter, programming languages, logger, etc.

- [Specs used](./specs.md) - Links to NIPs and GRASP docs, and list of custom events

## Getting Started

1. **Install a NIP-07 browser extension** (Alby, nos2x, etc.)
2. **Visit a GitRepublic instance** and connect with your extension
3. **Create your first repository** via the signup page
4. **Start collaborating** using pull requests, issues, and patches

For detailed instructions, see the topic pages above.

## Additional Resources

- [API Documentation](../src/routes/api/openapi.json/openapi.json) - OpenAPI specification
