# Tech Stack Used

Technical implementation details of GitRepublic, including programming languages, frameworks, libraries, and tools.

## Frontend

### Framework
- **SvelteKit**: Full-stack framework with SSR support
- **TypeScript**: Type-safe JavaScript
- **Svelte 5**: Reactive UI framework

### Code Editor
- **CodeMirror 6**: Full-featured code editor
  - `@codemirror/autocomplete`: Code autocompletion
  - `@codemirror/basic-setup`: Basic editor setup
  - `@codemirror/commands`: Editor commands
  - `@codemirror/lang-markdown`: Markdown language support
  - `@codemirror/language`: Language support infrastructure
  - `@codemirror/search`: Search and replace functionality
  - `@codemirror/state`: Editor state management
  - `@codemirror/view`: Editor view components

### Syntax Highlighting
- **highlight.js**: Syntax highlighting for code blocks
- **CodeMirror language modes**: Language-specific highlighting in editor

### Markdown Processing
- **markdown-it**: Markdown parser and renderer
- **asciidoctor**: AsciiDoc support (via codemirror-asciidoc)

### UI Components
- Custom Svelte components for:
  - Repository browser
  - Code editor
  - Pull request detail view
  - Issue management
  - File tree navigation

## Backend

### Runtime
- **Node.js**: JavaScript runtime
- **SvelteKit**: Server-side rendering and API routes

### Git Operations
- **git-http-backend**: Git smart HTTP protocol handler
- **simple-git**: Node.js git wrapper for repository operations

### Web Server
- **SvelteKit adapter-node**: Node.js adapter for production
- **Vite**: Build tool and dev server

## Nostr Integration

### Nostr Libraries
- **nostr-tools**: Core Nostr functionality
  - Event creation and signing
  - NIP-19 encoding/decoding (npub, nsec, naddr, etc.)
  - Event verification
  - Relay communication utilities

### WebSocket Client
- **ws**: WebSocket client for Nostr relay connections
- Custom **NostrClient**: WebSocket client wrapper for relay operations

### Authentication
- **NIP-07**: Browser extension integration (client-side)
- **NIP-98**: HTTP authentication implementation (server-side)

## Logging

### Logger
- **pino**: Fast, structured JSON logger
- **pino-pretty**: Human-readable log formatting for development

### Logging Features
- Structured logging with context
- Log levels (debug, info, warn, error)
- Audit logging for security events
- Performance logging

Logging is configured via environment variables and uses structured JSON logging with pino.

## Networking

### Tor Support
- **socks**: SOCKS proxy support for Tor connections
- Tor .onion address support for repositories
- Tor routing for Nostr relay connections

### Email
- **nodemailer**: Email sending for notifications (optional)

## Development Tools

### Type Checking
- **TypeScript**: Static type checking
- **svelte-check**: Svelte-specific type checking

### Linting and Formatting
- **ESLint**: JavaScript/TypeScript linting
- **Prettier**: Code formatting
- **@typescript-eslint**: TypeScript-specific ESLint rules

### Build Tools
- **Vite**: Fast build tool and dev server
- **TypeScript Compiler**: Type checking and compilation

## Programming Languages

- **TypeScript**: Primary language for all code
- **JavaScript**: Runtime language (compiled from TypeScript)
- **Svelte**: Component framework (compiled to JavaScript)

## Database/Storage

- **File System**: Git repositories stored on filesystem
- **JSONL Files**: Event storage in `nostr/repo-events.jsonl` format
- **No SQL Database**: Uses filesystem and Nostr relays for data storage

## Security

### Authentication Libraries
- **nostr-tools**: Cryptographic signing and verification
- Custom NIP-98 implementation for HTTP authentication

### Security Features
- Path validation
- Input sanitization
- Rate limiting
- Audit logging
- Process isolation (git-http-backend)

## Deployment

### Containerization
- **Docker**: Container support
- **Docker Compose**: Multi-container orchestration
- **Kubernetes**: Enterprise mode deployment (optional)

### Adapters
- **@sveltejs/adapter-node**: Node.js production adapter

## CLI Tools

The CLI (`gitrepublic-cli`) uses:
- **nostr-tools**: Nostr event handling
- **Node.js**: Runtime environment
- Native **git**: Git operations via git commands

## Version Requirements

- **Node.js**: 18+ (for both web app and CLI)
- **Git**: Required for git operations
- **npm**: Package management

## Next Steps

- [Specs used](./specs.md) - NIPs and GRASP documentation
