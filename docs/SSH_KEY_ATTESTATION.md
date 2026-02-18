# SSH Key Attestation

This document describes how to link your Nostr npub to SSH public keys for git operations over SSH.

## Overview

GitRepublic supports SSH key attestation, allowing you to use standard `git` commands over SSH instead of HTTP with NIP-98 authentication. This is done by signing a Nostr event that proves ownership of an SSH key.

**Important**: SSH key attestations are stored server-side only and are **not published to Nostr relays**. They are only used for authentication on the GitRepublic server.

## Prerequisites

- You must have **unlimited access** (ability to write to at least one default Nostr relay)
- You must have a Nostr key pair (via NIP-07 browser extension)
- You must have an SSH key pair

## SSH Key Comment Field

The SSH public key comment field (the part after the key data) can contain:
- **NIP-05 identifiers** (e.g., `user@domain.com`) - recommended for Nostr users
- Email addresses (e.g., `user@example.com`)
- Any other identifier

The comment field is optional and does not affect the key fingerprint or authentication. It's purely for identification purposes.

## How It Works

1. **Generate SSH Key** (if you don't have one):
   ```bash
   ssh-keygen -t ed25519 -C "your-nip05@example.com"
   # Or use RSA: ssh-keygen -t rsa -b 4096 -C "your-nip05@example.com"
   # Note: The comment field (-C) can contain your NIP-05 identifier or email address
   ```

2. **Get Your SSH Public Key**:
   ```bash
   cat ~/.ssh/id_ed25519.pub
   # Or: cat ~/.ssh/id_rsa.pub
   ```

3. **Create Attestation Event**:
   - Sign a Nostr event (kind 30001) containing your SSH public key
   - The event must be signed with your Nostr private key
   - Submit the event to the server via API

4. **Server Verification**:
   - Server verifies the event signature
   - Server stores the attestation (SSH key fingerprint → npub mapping)
   - Server allows git operations over SSH using that key

## API Usage

### Submit SSH Key Attestation

**Endpoint**: `POST /api/user/ssh-keys`

**Headers**:
- `X-User-Pubkey`: Your Nostr public key (hex format)

**Body**:
```json
{
  "event": {
    "kind": 30001,
    "pubkey": "your-nostr-pubkey-hex",
    "created_at": 1234567890,
    "tags": [],
    "content": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... your-nip05@example.com",
    "id": "event-id-hex",
    "sig": "event-signature-hex"
  }
}
```

**Example using curl** (with NIP-07):
```javascript
// In browser console with NIP-07 extension:
const sshPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...";

const event = {
  kind: 30001,
  pubkey: await window.nostr.getPublicKey(),
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: sshPublicKey
};

const signedEvent = await window.nostr.signEvent(event);

// Submit to server
const response = await fetch('/api/user/ssh-keys', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-User-Pubkey': await window.nostr.getPublicKey()
  },
  body: JSON.stringify({ event: signedEvent })
});
```

### Get Your Attestations

**Endpoint**: `GET /api/user/ssh-keys`

**Headers**:
- `X-User-Pubkey`: Your Nostr public key (hex format)

**Response**:
```json
{
  "attestations": [
    {
      "eventId": "event-id",
      "fingerprint": "SHA256:abc123...",
      "keyType": "ssh-ed25519",
      "createdAt": 1234567890,
      "revoked": false
    }
  ]
}
```

**Note**: You can have multiple SSH keys attested. All active (non-revoked) keys will be returned, sorted by creation date (newest first).

### Verify SSH Key

**Endpoint**: `POST /api/user/ssh-keys/verify`

**Body**:
```json
{
  "fingerprint": "SHA256:abc123..."
}
```

**Response**:
```json
{
  "valid": true,
  "attestation": {
    "userPubkey": "npub-hex",
    "fingerprint": "SHA256:abc123...",
    "keyType": "ssh-ed25519",
    "createdAt": 1234567890
  }
}
```

## Revoking Attestations

To revoke an SSH key attestation, submit a new event with a `revoke` tag:

```javascript
const event = {
  kind: 30001,
  pubkey: await window.nostr.getPublicKey(),
  created_at: Math.floor(Date.now() / 1000),
  tags: [['revoke', 'true']],
  content: sshPublicKey  // Same public key to revoke
};

const signedEvent = await window.nostr.signEvent(event);
// Submit to POST /api/user/ssh-keys
```

## SSH Server Integration

**Note**: The current GitRepublic implementation provides the API for storing and verifying SSH key attestations. To use SSH for git operations, you would need to:

1. **Set up an SSH server** (e.g., using `node-ssh-server` or a traditional OpenSSH server)
2. **Configure git-shell** or a custom command handler
3. **Verify SSH keys** by:
   - Extracting the SSH key fingerprint from the SSH connection
   - Calling the verification API or using the `verifyAttestation()` function directly
   - Allowing git operations if the key is attested

### Example SSH Server Integration (Pseudocode)

```typescript
import { verifyAttestation } from '$lib/services/ssh/ssh-key-attestation.js';

// In SSH server authentication handler
async function authenticateSSH(sshKey: string, fingerprint: string) {
  const attestation = verifyAttestation(fingerprint);
  
  if (!attestation) {
    return false; // Authentication failed
  }
  
  // User is authenticated as attestation.userPubkey
  // Allow git operations
  return true;
}
```

### Git Configuration

Once SSH is set up, users can configure git to use SSH:

```bash
# Add remote using SSH
git remote add origin ssh://git@your-gitrepublic-server.com/repos/{npub}/{repo}.git

# Or use SSH URL format
git remote add origin git@your-gitrepublic-server.com:repos/{npub}/{repo}.git
```

## Security Considerations

1. **Attestations are server-side only**: They are not published to Nostr relays, reducing privacy concerns
2. **Rate limiting**: Maximum 10 attestations per hour per user
3. **Signature verification**: All attestations must be signed with the user's Nostr private key
4. **Revocation support**: Users can revoke attestations at any time
5. **Fingerprint-based lookup**: SSH key fingerprints are hashed before storage (HMAC)

## Environment Variables

- `SSH_ATTESTATION_LOOKUP_SECRET`: Secret key for HMAC-based fingerprint lookup (default: 'change-me-in-production')
  - **Important**: Set this to a secure random value in production!

## Limitations

- SSH server integration is not yet implemented in the main codebase
- Attestations are stored in-memory (will be lost on server restart)
  - In production, use Redis or a database for persistent storage
- Only users with "unlimited access" can create attestations

## Current Status

✅ **Implemented:**
- Support for multiple SSH keys per user (users can attest multiple SSH keys)
- Rate limiting (10 attestations per hour per user)
- Revocation support
- HMAC-based fingerprint lookup for security
- Audit logging for SSH key attestation operations (submit, revoke, verify)

## Future Improvements

- Persistent storage (Redis/database) for attestations (currently in-memory)
- SSH server implementation (API is ready, server integration needed)
- Key expiration/rotation policies
