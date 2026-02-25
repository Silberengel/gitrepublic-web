# Settings and Dashboard

User account settings and dashboard features in GitRepublic.

## User Dashboard

Access your dashboard at `/user/dashboard` or via the user menu.

### Dashboard Features

- **Repository overview**: Quick view of your repositories
- **Activity summary**: Recent activity and contributions
- **Pending transfers**: Ownership transfers waiting for your approval
- **Access level**: Your current access level (unlimited, standard, etc.)
- **Quick actions**: Common operations

## User Settings

### Access Level

View your access level:
- **Unlimited**: Full access to all features
- **Standard**: Standard user access
- **Limited**: Restricted access

Access level determines:
- Repository creation limits
- API rate limits
- Feature availability

### Messaging Preferences

Configure messaging and notification preferences:

- **Enable/disable messaging**: Control message forwarding
- **Relay preferences**: Configure preferred relays for messages
- **Notification settings**: Control what you're notified about

Access via:
- **Web Interface**: User settings menu
- **API**: `GET /api/user/messaging-preferences`
- **CLI**: Via API commands

### Git Dashboard

View git-specific information:

- **Repository statistics**: Count, size, activity
- **Clone operations**: Recent clone activity
- **Push operations**: Recent push activity

Access via:
- **Web Interface**: User dashboard
- **API**: `GET /api/user/git-dashboard`

## Repository Settings

Repository-specific settings are managed on the repository page (see [Managing a Repo](./managing-repos.md)).

### Available Settings

- **Description**: Update repository description
- **Visibility**: Change visibility level
- **Project Relays**: Configure project relays
- **Maintainers**: Add/remove maintainers
- **Clone URLs**: Manage clone URLs
- **Branch Protection**: Configure branch protection rules
- **Ownership Transfer**: Transfer repository ownership

## SSH Keys

GitRepublic supports SSH key verification for git operations (optional).

### Verifying SSH Keys

- **API**: `GET /api/user/ssh-keys/verify`
- **Purpose**: Verify SSH keys for git operations

## Environment Variables

For CLI operations, configure these environment variables:

- `NOSTRGIT_SECRET_KEY`: Your Nostr private key (required for CLI)
- `GITREPUBLIC_SERVER`: Default server URL (optional)
- `NOSTR_RELAYS`: Comma-separated relay URLs (optional)

## Next Steps

- [Managing a Repo](./managing-repos.md) - Repository-specific settings
- [REST API and CLI](./api-and-cli.md) - Programmatic access to settings
