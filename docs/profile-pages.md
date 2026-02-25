# Profile Pages

User profiles in GitRepublic display comprehensive user information, repositories, and payment targets.

## Viewing Profiles

Navigate to a user's profile page:
```
https://{domain}/users/{npub}
```

## Profile Information

Profiles display:

- **User name**: From Nostr profile event (kind 0)
- **About/Bio**: User description
- **Profile picture**: Avatar image
- **Banner image**: Profile banner (if available)
- **Payment targets**: Lightning addresses and payment information (NIP-A3)
- **Repositories**: List of user's repositories
- **Activity**: Recent activity and contributions

## Payment Targets (NIP-A3)

GitRepublic supports payment targets using NIP-A3 (kind 10133) and merges payment information from multiple sources.

### Supported Payment Types

- **Lightning**: Lightning Network addresses (e.g., `user@wallet.example.com`)
- **Bitcoin**: Bitcoin addresses
- **Ethereum**: Ethereum addresses
- **Nano**: Nano addresses
- **Monero**: Monero addresses
- And more (see [NIP-A3 documentation](./NIP-A3.md))

### Payment Target Sources

GitRepublic merges payment information from:

1. **NIP-01 (kind 0)**: Lightning addresses from `lud16` tags or JSON `lud16` field
2. **NIP-A3 (kind 10133)**: All payment targets from `payto` tags

The system:
- Normalizes addresses (lowercase) for deduplication
- Merges lightning addresses from both sources
- Displays all payment targets with `payto://` URIs
- Provides copy buttons for easy sharing

### Creating Payment Target Events

To add payment targets to your profile, publish a kind 10133 event:

```json
{
  "kind": 10133,
  "content": "",
  "tags": [
    ["payto", "lightning", "user@wallet.example.com"],
    ["payto", "bitcoin", "bc1qxq66e0t8d7ugdecwnmv58e90tpry23nc84pg9k"]
  ],
  "created_at": 1234567890
}
```

## Repository Listings

User profiles show:

- **All repositories**: Public and user's own repositories
- **Repository status**: Registered, local, verified
- **Repository descriptions**: Quick overview
- **Clone URLs**: Direct access to repositories

## API Access

Fetch user profiles via API:

```bash
GET /api/users/{npub}/profile
```

Response includes:
- Full profile event (kind 0)
- Payment targets array with `payto://` URIs
- Payment event (kind 10133) if available
- Merged lightning addresses

## CLI Access

The GitRepublic CLI can fetch profiles:

```bash
gitrep profile fetch <npub>
```

Automatically merges payment targets and returns `payto://` URIs.

## Profile Event Format

GitRepublic supports both profile event formats:

- **Old format**: JSON in `content` field
- **New format**: Tags-based format (recommended)

Both formats are supported for backward compatibility.

## Next Steps

- [Settings and Dashboard](./settings-and-dashboard.md) - User account management
- [NIP-A3 documentation](./NIP-A3.md) - Complete payment target details
