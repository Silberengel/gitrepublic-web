# NIP-A3: Payment Targets (payto://)

GitRepublic supports NIP-A3 (Payment Targets) for displaying payment information in user profiles. This allows users to specify payment targets using the [RFC-8905 (payto:) URI scheme](https://www.rfc-editor.org/rfc/rfc8905.html).

## Overview

NIP-A3 defines `kind:10133` for payment target events. This kind is **replaceable**, meaning users can update their payment targets by publishing a new event with the same kind.

## Event Structure

### Kind 10133: Payment Targets

```json
{
  "pubkey": "afc93622eb4d79c0fb75e56e0c14553f7214b0a466abeba14cb38968c6755e6a",
  "kind": 10133,
  "content": "",
  "tags": [
    ["payto", "bitcoin", "bc1qxq66e0t8d7ugdecwnmv58e90tpry23nc84pg9k"],
    ["payto", "lightning", "user@wallet.example.com"],
    ["payto", "nano", "nano_1dctqbmqxfppo9pswbm6kg9d4s4mbraqn8i4m7ob9gnzz91aurmuho48jx3c"]
  ],
  "created_at": 1234567890,
  "id": "...",
  "sig": "..."
}
```

### Tag Format

Payment targets are specified using `payto` tags with the following structure:

```text
["payto", "<type>", "<authority>", "<optional_extra_1>", "<optional_extra_2>", ...]
```

Where:
- The first element is always the literal string `"payto"`
- The second element is the payment `type` (e.g., `"bitcoin"`, `"lightning"`)
- The third element is the `authority` (e.g., address, username)
- Additional elements are optional and reserved for future RFC-8905 features

## Supported Payment Types

GitRepublic recognizes and displays the following payment target types:

| Payment Target Type | Long Stylization  | Short Stylization | Symbol | References |
| :------------------ | :---------------- | :---------------- | :----- | :--------- |
| bitcoin             | Bitcoin           | BTC               | ₿      | https://bitcoin.design/ |
| cashme              | Cash App          | Cash App          | $,£    | https://cash.app/press |
| ethereum            | Ethereum          | ETH               | Ξ      | https://ethereum.org/assets/#brand |
| lightning           | Lightning Network | LBTC              | 丰     | https://github.com/shocknet/bitcoin-lightning-logo |
| monero              | Monero            | XMR               | ɱ      | https://www.getmonero.org/press-kit/ |
| nano                | Nano              | XNO               | Ӿ      | https://nano.org/en/currency |
| revolut             | Revolut           | Revolut           | N/A    | https://revolut.me |
| venmo               | Venmo             | Venmo           | $      | https://venmo.com/pay |

Unrecognized types are still displayed but without special styling.

## Integration with NIP-01 Profiles

GitRepublic merges payment targets from multiple sources:

1. **NIP-01 (kind 0)**: Lightning addresses from `lud16` tags or JSON `lud16` field
2. **NIP-A3 (kind 10133)**: All payment targets from `payto` tags

The system:
- Normalizes all addresses to lowercase for deduplication
- Merges lightning addresses from both sources
- Displays all payment targets together in the profile
- Formats each target as a `payto://<type>/<authority>` URI

## Display Format

Payment targets are displayed on user profile pages with:
- Payment type (e.g., "lightning", "bitcoin")
- Full `payto://` URI
- Copy button for easy sharing

Example display:
```
Payments
├─ lightning    payto://lightning/user@wallet.example.com    [Copy]
├─ bitcoin      payto://bitcoin/bc1q...                      [Copy]
└─ nano        payto://nano/nano_1...                       [Copy]
```

## API Access

### GET `/api/users/{npub}/profile`

Returns the full user profile including payment targets:

```json
{
  "npub": "npub1...",
  "pubkey": "afc93622...",
  "profile": {
    "name": "Alice",
    "about": "Developer",
    "picture": "https://...",
    "websites": [],
    "nip05": []
  },
  "profileEvent": { ... },
  "paymentTargets": [
    {
      "type": "lightning",
      "authority": "user@wallet.example.com",
      "payto": "payto://lightning/user@wallet.example.com"
    },
    {
      "type": "bitcoin",
      "authority": "bc1qxq66e0t8d7ugdecwnmv58e90tpry23nc84pg9k",
      "payto": "payto://bitcoin/bc1qxq66e0t8d7ugdecwnmv58e90tpry23nc84pg9k"
    }
  ],
  "paymentEvent": { ... }
}
```

## CLI Access

The GitRepublic CLI also supports fetching payment targets:

```bash
# Profile fetcher automatically includes payment targets
gitrep profile fetch npub1...
```

The CLI's `profile-fetcher.js` module fetches both kind 0 and kind 10133 events and merges the payment information.

## Creating Payment Target Events

To create a payment target event, publish a kind 10133 event with `payto` tags:

```javascript
const event = {
  kind: 10133,
  content: "",
  tags: [
    ["payto", "lightning", "user@wallet.example.com"],
    ["payto", "bitcoin", "bc1qxq66e0t8d7ugdecwnmv58e90tpry23nc84pg9k"]
  ],
  created_at: Math.floor(Date.now() / 1000),
  pubkey: yourPubkey
};

// Sign and publish to relays
```

## References

- [NIP-A3 Specification](https://github.com/nostr-protocol/nips/pull/XXX) (when published)
- [RFC-8905: The "payto" URI Scheme](https://www.rfc-editor.org/rfc/rfc8905.html)
- [NIP-57: Lightning Zaps](https://github.com/nostr-protocol/nips/blob/master/57.md) - Related specification for lightning payments

## Notes

- Payment targets are **replaceable** - publish a new kind 10133 event to update
- GitRepublic checks cache first, then relays for profile and payment events
- Lightning addresses from NIP-01 (lud16) are automatically merged with kind 10133
- All addresses are normalized (lowercase) and deduplicated before display
