# Logging Strategy

## Current State

The application currently uses `console.log`, `console.error`, and `console.warn` for logging, with:
- Context prefixes (e.g., `[Fork] [repo1 → repo2]`)
- Security sanitization (truncated pubkeys, redacted private keys)
- Structured audit logging via `AuditLogger` service

## Recommendation: Use Pino for Production

### Why Pino?

1. **Performance**: Extremely fast (async logging, minimal overhead)
2. **Structured Logging**: JSON output perfect for ELK/Kibana/Logstash
3. **Log Levels**: Built-in severity levels (trace, debug, info, warn, error, fatal)
4. **Child Loggers**: Context propagation (request IDs, user IDs, etc.)
5. **Ecosystem**: Excellent Kubernetes/Docker support
6. **Small Bundle**: ~4KB minified

### Implementation Plan

#### 1. Install Pino

```bash
npm install pino pino-pretty
```

#### 2. Create Logger Service

```typescript
// src/lib/services/logger.ts
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname'
      }
    }
  })
});

export default logger;
```

#### 3. Replace Console Logs

```typescript
// Before
console.log(`[Fork] ${context} Starting fork process`);

// After
import logger from '$lib/services/logger.js';
logger.info({ context, repo: `${npub}/${repo}` }, 'Starting fork process');
```

#### 4. Structured Context

```typescript
// Create child logger with context
const forkLogger = logger.child({ 
  operation: 'fork',
  originalRepo: `${npub}/${repo}`,
  forkRepo: `${userNpub}/${forkRepoName}`
});

forkLogger.info('Starting fork process');
forkLogger.info({ relayCount: combinedRelays.length }, 'Using relays');
forkLogger.error({ error: sanitizedError }, 'Fork failed');
```

#### 5. ELK/Kibana Integration

Pino outputs JSON by default, which works perfectly with:
- **Filebeat**: Collect logs from files
- **Logstash**: Parse and enrich logs
- **Elasticsearch**: Store and index logs
- **Kibana**: Visualize and search logs

Example log output:
```json
{
  "level": 30,
  "time": 1703123456789,
  "pid": 12345,
  "hostname": "gitrepublic-1",
  "operation": "fork",
  "originalRepo": "npub1.../repo1",
  "forkRepo": "npub2.../repo2",
  "msg": "Starting fork process"
}
```

### Migration Strategy

1. **Phase 1**: Install Pino, create logger service
2. **Phase 2**: Replace console logs in critical paths (fork, file operations, git operations)
3. **Phase 3**: Replace remaining console logs
4. **Phase 4**: Add request ID middleware for request tracing
5. **Phase 5**: Configure log aggregation (Filebeat → ELK)

### Benefits

- **Searchability**: Query logs by operation, user, repo, etc.
- **Alerting**: Set up alerts for error rates, failed operations
- **Performance Monitoring**: Track operation durations
- **Security Auditing**: Enhanced audit trail with structured data
- **Debugging**: Easier to trace requests across services

### Alternative: Winston

Winston is also popular but:
- Slower than Pino
- More configuration overhead
- Better for complex transports (multiple outputs)

**Recommendation**: Use Pino for this project.
