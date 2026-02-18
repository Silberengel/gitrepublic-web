# Messaging Forwarding Feature

This feature allows users with **unlimited access** to forward Nostr events to messaging platforms (Telegram, SimpleX, Email) and Git hosting platforms (GitHub, GitLab, Gitea, Codeberg, Forgejo) when they publish events.

## Security Architecture

### Multi-Layer Security

1. **Encrypted Salt Storage**: Each user's salt is encrypted with a separate key (`MESSAGING_SALT_ENCRYPTION_KEY`)
2. **HMAC Lookup Keys**: User pubkeys are hashed with HMAC before being used as database keys
3. **Rate Limiting**: Decryption attempts are rate-limited (10 attempts per 15 minutes)
4. **Per-User Key Derivation**: Encryption keys derived from master key + pubkey + salt
5. **AES-256-GCM**: Authenticated encryption with random IV per encryption

### Threat Mitigation

- **Database Compromise**: All data encrypted at rest with per-user keys
- **Key Leakage**: Per-user key derivation means master key leak doesn't expose all users
- **Brute Force**: Rate limiting prevents rapid decryption attempts
- **Lookup Attacks**: HMAC hashing prevents pubkey enumeration

## Environment Variables

### Required for Encryption

```bash
# Master encryption key (256-bit hex, generate with: openssl rand -hex 32)
MESSAGING_PREFS_ENCRYPTION_KEY=<256-bit-hex>

# Salt encryption key (256-bit hex, generate with: openssl rand -hex 32)
MESSAGING_SALT_ENCRYPTION_KEY=<256-bit-hex>

# HMAC secret for lookup key hashing (256-bit hex, generate with: openssl rand -hex 32)
MESSAGING_LOOKUP_SECRET=<256-bit-hex>
```

### Optional for Messaging Platforms

```bash
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_ENABLED=true

# Email SMTP Configuration
SMTP_HOST=<smtp-host>
SMTP_PORT=587
SMTP_USER=<smtp-username>
SMTP_PASSWORD=<smtp-password>
SMTP_FROM_ADDRESS=<from-email>
SMTP_FROM_NAME=GitRepublic
EMAIL_ENABLED=true

# OR use SMTP API (alternative to direct SMTP)
SMTP_API_URL=<smtp-api-url>
SMTP_API_KEY=<api-key>

# SimpleX API Configuration
SIMPLEX_API_URL=<simplex-api-url>
SIMPLEX_API_KEY=<api-key>
SIMPLEX_ENABLED=true

# Git Platforms Forwarding Configuration
GIT_PLATFORMS_ENABLED=true
```

## Setup

### 1. Generate Encryption Keys

```bash
# Generate all three required keys
openssl rand -hex 32  # For MESSAGING_PREFS_ENCRYPTION_KEY
openssl rand -hex 32  # For MESSAGING_SALT_ENCRYPTION_KEY
openssl rand -hex 32  # For MESSAGING_LOOKUP_SECRET
```

### 2. Store Keys Securely

**Development:**
- Store in `.env` file (never commit to git)

**Production:**
- Use secret management service (AWS Secrets Manager, HashiCorp Vault, etc.)
- Or environment variables in deployment platform
- Consider using Hardware Security Modules (HSM) for maximum security

### 3. Configure Messaging Platforms

#### Telegram
1. Create a bot with [@BotFather](https://t.me/botfather)
2. Get bot token
3. Users will provide their chat ID when configuring preferences

#### Email
1. Configure SMTP settings (host, port, credentials)
2. Or use an SMTP API service
3. Users will provide their email addresses (to/cc)

#### SimpleX
1. Set up SimpleX Chat API
2. Configure API URL and key
3. Users will provide their contact ID

#### Git Platforms (GitHub, GitLab, Gitea, Codeberg, Forgejo)
1. Users create Personal Access Tokens with appropriate scopes
2. Users provide platform, username/org, repository name, and token
3. Events will be forwarded as issues or PRs on the selected platform
4. Supports self-hosted instances via custom API URL

## User Flow

### 1. User Saves Preferences (Client-Side)

```typescript
// User encrypts preferences to self on Nostr (kind 30078)
const encryptedContent = await window.nostr.nip44.encrypt(
  userPubkey,
  JSON.stringify(preferences)
);

// Publish to Nostr (backup/sync)
const event = {
  kind: 30078,
  pubkey: userPubkey,
  tags: [['d', 'gitrepublic-messaging'], ['enabled', 'true']],
  content: encryptedContent
};

// Sign and publish
const signedEvent = await signEventWithNIP07(event);
await nostrClient.publishEvent(signedEvent);

// Send decrypted copy to server (over HTTPS)
await fetch('/api/user/messaging-preferences', {
  method: 'POST',
  body: JSON.stringify({
    preferences,
    proofEvent: signedEvent
  })
});
```

### 2. Server Stores Securely

- Verifies proof event signature
- Checks user has unlimited access
- Generates random salt
- Encrypts salt with `MESSAGING_SALT_ENCRYPTION_KEY`
- Derives per-user encryption key
- Encrypts preferences with AES-256-GCM
- Stores using HMAC lookup key

### 3. Event Forwarding

When user publishes an event (issue, PR, highlight):
1. Server checks user has unlimited access
2. Retrieves encrypted preferences
3. Decrypts (with rate limiting)
4. Checks if forwarding enabled and event kind matches
5. Forwards to configured platforms

## API Endpoints

### POST `/api/user/messaging-preferences`

Save messaging preferences.

**Request:**
```json
{
  "preferences": {
    "telegram": "@username",
    "simplex": "contact-id",
    "email": {
      "to": ["user@example.com"],
      "cc": ["cc@example.com"]
    },
    "gitPlatforms": [
      {
        "platform": "github",
        "owner": "username",
        "repo": "repository-name",
        "token": "ghp_xxxxxxxxxxxx"
      },
      {
        "platform": "gitlab",
        "owner": "username",
        "repo": "repository-name",
        "token": "glpat-xxxxxxxxxxxx"
      },
      {
        "platform": "codeberg",
        "owner": "username",
        "repo": "repository-name",
        "token": "xxxxxxxxxxxx"
      },
      {
        "platform": "onedev",
        "owner": "project-path",
        "repo": "repository-name",
        "token": "xxxxxxxxxxxx",
        "apiUrl": "https://your-onedev-instance.com"
      },
      {
        "platform": "custom",
        "owner": "username",
        "repo": "repository-name",
        "token": "xxxxxxxxxxxx",
        "apiUrl": "https://your-git-instance.com/api/v1"
      }
    ],
    "enabled": true,
    "notifyOn": ["1621", "1618"]
  },
  "proofEvent": { /* Signed Nostr event (kind 30078) */ }
}
```

**Response:**
```json
{
  "success": true
}
```

### GET `/api/user/messaging-preferences`

Get preferences status (without decrypting).

**Response:**
```json
{
  "configured": true,
  "rateLimit": {
    "remaining": 10,
    "resetAt": null
  }
}
```

### DELETE `/api/user/messaging-preferences`

Delete messaging preferences.

**Response:**
```json
{
  "success": true
}
```

## Security Best Practices

1. **Key Management**
   - Never commit keys to git
   - Rotate keys periodically
   - Use secret management services in production
   - Consider HSM for maximum security

2. **Monitoring**
   - Monitor rate limit violations
   - Alert on decryption failures
   - Audit log all preference changes

3. **Access Control**
   - Only users with unlimited access can use this feature
   - Requires valid signed Nostr event proof
   - Server verifies all inputs

4. **Data Protection**
   - All data encrypted at rest
   - Per-user key derivation
   - HMAC lookup keys
   - Rate limiting on decryption

## Troubleshooting

### "Decryption rate limit exceeded"

User has exceeded 10 decryption attempts in 15 minutes. Wait for the window to reset.

### "Messaging forwarding requires unlimited access"

User must have relay write access (unlimited level) to use this feature.

### "Failed to forward event"

Check:
- Messaging platform API credentials
- Network connectivity
- Platform-specific error logs

## Email Setup

### Option 1: Direct SMTP

Install nodemailer:
```bash
npm install nodemailer
```

Configure environment variables:
```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
SMTP_FROM_ADDRESS=noreply@yourdomain.com
SMTP_FROM_NAME=GitRepublic
EMAIL_ENABLED=true
```

### Option 2: SMTP API

Use an SMTP API service (e.g., SendGrid, Mailgun, AWS SES):
```bash
SMTP_API_URL=https://api.sendgrid.com/v3/mail/send
SMTP_API_KEY=your-api-key
EMAIL_ENABLED=true
```

## Git Platforms Setup

### Supported Platforms

- **GitHub** (`github`) - github.com
- **GitLab** (`gitlab`) - gitlab.com (also supports self-hosted with apiUrl)
- **Gitea** (`gitea`) - Self-hosted instances (defaults to codeberg.org if apiUrl not provided)
- **Codeberg** (`codeberg`) - codeberg.org (uses Gitea API)
- **Forgejo** (`forgejo`) - Self-hosted instances (defaults to forgejo.org if apiUrl not provided)
- **OneDev** (`onedev`) - Self-hosted instances (requires apiUrl)
- **Custom** (`custom`) - Any Gitea-compatible API with custom URL (requires apiUrl)

### Creating Personal Access Tokens

#### GitHub
1. Go to Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Select `repo` scope
4. Generate and copy token

#### GitLab
1. Go to Settings → Access Tokens
2. Create token with `api` scope
3. Generate and copy token

#### Gitea/Codeberg/Forgejo
1. Go to Settings → Applications → Generate New Token
2. Select `repo` scope
3. Generate and copy token

#### OneDev
1. Go to User Settings → Access Tokens
2. Create a new access token
3. Select appropriate scopes (typically `write:issue` and `write:pull-request`)
4. Generate and copy token
5. **Note**: OneDev is self-hosted, so you must provide the `apiUrl` (e.g., `https://your-onedev-instance.com`)

### User Configuration

Users provide:
- **Platform**: One of `github`, `gitlab`, `gitea`, `codeberg`, `forgejo`, `onedev`, or `custom`
- **Owner**: Username or organization name (project path for OneDev)
- **Repo**: Repository name (project name for OneDev)
- **Token**: Personal access token (stored encrypted)
- **API URL**:
  - **Required** for: `onedev`, `custom`
  - **Optional** for: `gitea`, `forgejo`, `gitlab` (use for self-hosted instances)
  - **Not used** for: `github`, `codeberg` (always use hosted instances)
  - Format: Base URL of the instance (e.g., `https://your-gitea-instance.com/api/v1` or `https://your-onedev-instance.com`)

### Event Mapping

- **Nostr Issues (kind 1621)** → Platform Issues
- **Nostr PRs (kind 1618)** → Platform Pull Requests/Merge Requests (if branch info available) or Issues with PR label
- **Other events** → Platform Issues with event kind label

### Platform-Specific Notes

- **GitHub**: Uses `body` field and `head`/`base` for PRs. Always uses `https://api.github.com`
- **GitLab**: Uses `description` field instead of `body`, and `source_branch`/`target_branch` for PRs. Defaults to `https://gitlab.com/api/v4`, but supports self-hosted with `apiUrl`
- **Gitea**: Compatible with GitHub API format. Defaults to `https://codeberg.org/api/v1` (Codeberg), but supports self-hosted instances with `apiUrl` (e.g., `https://your-gitea-instance.com/api/v1`)
- **Codeberg**: Uses Gitea API format. Always uses `https://codeberg.org/api/v1`
- **Forgejo**: Compatible with GitHub API format. Defaults to `https://forgejo.org/api/v1`, but supports self-hosted instances with `apiUrl` (e.g., `https://your-forgejo-instance.com/api/v1`)
- **OneDev**: Uses `description` field and `source_branch`/`target_branch` for PRs. **Requires** `apiUrl` (self-hosted only). API endpoints: `/api/projects/{owner}/{repo}/issues` and `/api/projects/{owner}/{repo}/pull-requests`
- **Custom**: Must provide `apiUrl` pointing to Gitea-compatible API (assumes GitHub/Gitea API format)

### Security Note

All tokens are stored encrypted in the database. Users should:
- Use tokens with minimal required scopes
- Rotate tokens periodically
- Revoke tokens if compromised

## Future Enhancements

- [ ] Support for more messaging platforms
- [ ] User-configurable message templates
- [ ] Webhook support
- [ ] Encrypted preferences sync across devices
- [ ] Per-repository forwarding rules
- [ ] HTML email templates