# GitRepublic

A decentralized, Nostr-based git server that enables git repository hosting and collaboration using Nostr events. Repositories are announced via NIP-34, and all operations (clone, push, pull) are authenticated using NIP-98 HTTP authentication.

## Quick Start

### Web Interface

1. Start the server: `npm run dev`
2. Open browser: `http://localhost:5173`
3. Connect NIP-07 extension (Alby, nos2x, etc.)
4. Visit `/signup` to create your first repository

### Command Line Interface

```bash
# Install
npm install -g gitrepublic-cli

# Set your Nostr private key
export NOSTRGIT_SECRET_KEY="nsec1..."

# Setup (configures credential helper and commit hook)
gitrep-setup
```

For complete CLI documentation and all available commands, run:
```bash
gitrep --help
```

## Documentation

**Complete documentation is available in the [docs](./docs/) directory:**

- **[About GitRepublic](./docs/about.md)** - Overview and table of contents for all documentation topics

### Key Topics

- [How this git server integrates Nostr](./docs/nostr-integration.md)
- [Creating, forking, transferring, or cloning a repo](./docs/repo-operations.md)
- [Editing a repo](./docs/editing-repos.md)
- [Managing a repo](./docs/managing-repos.md)
- [Search and viewing external git repos](./docs/search-and-external-repos.md)
- [REST API and CLI](./docs/api-and-cli.md)
- [Profile pages](./docs/profile-pages.md)
- [Settings and Dashboard](./docs/settings-and-dashboard.md)
- [Working with GRASP servers](./docs/grasp-servers.md)
- [Lightweight versus Enterprise modes](./docs/deployment-modes.md)
- [Tech stack used](./docs/tech-stack.md)
- [Specs used](./docs/specs.md)

## Components

GitRepublic consists of three main components:

1. **Web Interface** - Full-featured web application for browsing, editing, and managing repositories
2. **Command Line Interface (CLI)** - Git wrapper and API client for command-line operations
3. **REST API** - Complete API for programmatic access

All three interfaces use the same underlying Nostr-based authentication and repository management system.

## Installation

### Development

```bash
git clone https://github.com/silberengel/gitrepublic-web.git
cd gitrepublic-web
npm install
npm run dev
```

### Production

See deployment documentation in the [docs](./docs/) directory.

## API Access

All API endpoints are documented in OpenAPI format. Access the API documentation at:
- **Development**: `http://localhost:5173/api/openapi.json`
- **Production**: `https://your-domain.com/api/openapi.json`

Use NIP-98 authentication for all write operations.

## Server Administration

For server administrators and DevOps engineers:

### Deployment Modes

GitRepublic supports two deployment modes:

- **Lightweight Mode** (default): Single container deployment with application-level security
- **Enterprise Mode**: Kubernetes-based multi-tenant deployment with complete isolation

See [Deployment Modes Documentation](./docs/deployment-modes.md) for detailed comparison.

### Enterprise Mode (Kubernetes)

For production multi-tenant deployments with maximum security and isolation:

- **[Enterprise Mode Setup Guide](./k8s/ENTERPRISE_MODE.md)** - Complete Kubernetes deployment guide
  - Container-per-tenant architecture
  - Network isolation with Kubernetes Network Policies
  - Resource quotas and limits
  - PersistentVolume per tenant
  - Ingress configuration
  - Monitoring and troubleshooting

### Configuration

Key environment variables for server configuration:

- `ENTERPRISE_MODE`: Enable enterprise mode (`true`/`false`)
- `GIT_REPO_ROOT`: Path to store git repositories (default: `/repos`)
- `GIT_DOMAIN`: Domain for git repositories (default: `localhost:6543`)
- `NOSTR_RELAYS`: Comma-separated Nostr relays
- `MAX_REPOS_PER_USER`: Maximum repositories per user (default: `100`)
- `MAX_DISK_QUOTA_PER_USER`: Maximum disk quota per user in bytes (default: `10737418240` = 10GB)
- `RATE_LIMIT_ENABLED`: Enable rate limiting (default: `true`)
- `AUDIT_LOGGING_ENABLED`: Enable audit logging (default: `true`)

See the [deployment modes documentation](./docs/deployment-modes.md) and [enterprise mode guide](./k8s/ENTERPRISE_MODE.md) for complete configuration details.

## License

MIT

## Links

- **Website**: https://gitcitadel.com
- **GitHub**: https://github.com/silberengel/gitrepublic-web
- **CLI**: https://github.com/silberengel/gitrepublic-cli
