# Security Implementation Plan

This document outlines the implementation of security improvements in two tiers:
1. **Lightweight** - Single container, application-level improvements
2. **Enterprise** - Multi-container/Kubernetes with process isolation

## Architecture Overview

### Lightweight (Single Container)
- Application-level security controls
- Resource limits enforced in code
- Rate limiting in application
- Audit logging
- Works with current Docker setup

### Enterprise (Kubernetes)
- Process isolation per tenant
- Network policies
- Resource quotas per namespace
- Separate volumes per tenant
- Scales horizontally

## Implementation Plan

### Phase 1: Lightweight Improvements (Single Container)

These improvements work in the current single-container setup and provide immediate security benefits.

#### 1.1 Resource Limits Per User

**Implementation**: Application-level tracking and enforcement

**Files to create/modify**:
- `src/lib/services/security/resource-limits.ts` - Track and enforce limits
- `src/routes/api/repos/[npub]/[repo]/+server.ts` - Check limits before operations

**Features**:
- Per-user repository count limit (configurable, default: 100)
- Per-user disk quota (configurable, default: 10GB)
- Per-repository size limit (already exists: 2GB)
- Per-file size limit (already exists: 500MB)

**Configuration**:
```typescript
// Environment variables
MAX_REPOS_PER_USER=100
MAX_DISK_QUOTA_PER_USER=10737418240  // 10GB in bytes
```

#### 1.2 Rate Limiting

**Implementation**: In-memory or Redis-based rate limiting

**Files to create/modify**:
- `src/lib/services/security/rate-limiter.ts` - Rate limiting logic
- `src/hooks.server.ts` - Apply rate limits to requests

**Features**:
- Per-IP rate limiting (requests per minute)
- Per-user rate limiting (operations per minute)
- Different limits for different operations:
  - Git operations (clone/push): 60/min
  - File operations: 30/min
  - API requests: 120/min

**Configuration**:
```typescript
// Environment variables
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000  // 1 minute
RATE_LIMIT_MAX_REQUESTS=120
```

#### 1.3 Audit Logging

**Implementation**: Structured logging to files/console

**Files to create/modify**:
- `src/lib/services/security/audit-logger.ts` - Audit logging service
- All API endpoints - Add audit log entries

**Features**:
- Log all repository access attempts
- Log all file operations (read/write/delete)
- Log authentication attempts (success/failure)
- Log ownership transfers
- Include: timestamp, user pubkey, IP, action, result

**Log Format**:
```json
{
  "timestamp": "2024-01-01T12:00:00Z",
  "user": "abc123...",
  "ip": "192.168.1.1",
  "action": "repo.clone",
  "repo": "npub1.../myrepo",
  "result": "success",
  "metadata": {}
}
```

**Storage**:
- **Console**: Always logs to stdout (JSON format, prefixed with `[AUDIT]`)
- **File**: Optional file logging (if `AUDIT_LOG_FILE` is set)
  - Daily rotation: Creates new file each day (e.g., `audit-2024-01-01.log`)
  - Location: Configurable via `AUDIT_LOG_FILE` environment variable
  - Default location: Console only (no file logging by default)

**Retention**:
- **Default**: 90 days (configurable via `AUDIT_LOG_RETENTION_DAYS`)
- **Automatic cleanup**: Old log files are automatically deleted
- **Rotation**: Logs rotate daily at midnight (based on date change)
- **Set to 0**: Disables automatic cleanup (manual cleanup required)

**Example Configuration**:
```bash
# Log to /var/log/gitrepublic/audit.log (with daily rotation)
AUDIT_LOG_FILE=/var/log/gitrepublic/audit.log
AUDIT_LOG_RETENTION_DAYS=90

# Or use Docker volume
AUDIT_LOG_FILE=/app/logs/audit.log
AUDIT_LOG_RETENTION_DAYS=30
```

#### 1.4 Enhanced git-http-backend Hardening

**Implementation**: Additional security measures for git-http-backend

**Files to modify**:
- `src/routes/api/git/[...path]/+server.ts` - Add security measures

**Features**:
- Validate PATH_INFO to prevent manipulation
- Set restrictive environment variables
- Timeout for git operations
- Resource limits for spawned processes

### Phase 2: Enterprise Improvements (Kubernetes)

These require multi-container architecture and Kubernetes.

#### 2.1 Container-per-Tenant Architecture

**Architecture**:
- Each user (npub) gets their own namespace
- Each namespace has:
  - Application pod (gitrepublic instance)
  - Persistent volume for repositories
  - Service for networking
  - Resource quotas

**Kubernetes Resources**:
- `k8s/namespace-template.yaml` - Namespace per tenant
- `k8s/deployment-template.yaml` - Application deployment
- `k8s/service-template.yaml` - Service definition
- `k8s/pvc-template.yaml` - Persistent volume claim
- `k8s/resource-quota.yaml` - Resource limits

#### 2.2 Network Isolation

**Implementation**: Kubernetes Network Policies

**Files to create**:
- `k8s/network-policy.yaml` - Network isolation rules

**Features**:
- Namespace-level network isolation
- Only allow traffic from ingress controller
- Block inter-namespace communication
- Allow egress to Nostr relays only

#### 2.3 Resource Quotas

**Implementation**: Kubernetes ResourceQuota

**Features**:
- CPU limits per tenant
- Memory limits per tenant
- Storage limits per tenant
- Pod count limits

#### 2.4 Separate Volumes Per Tenant

**Implementation**: Kubernetes PersistentVolumeClaims

**Features**:
- Each tenant gets their own volume
- Volume size limits
- Backup/restore per tenant
- Snapshot support

## Hybrid Approach (Recommended)

The hybrid approach implements lightweight improvements first, then provides a migration path to enterprise architecture.

### Benefits:
1. **Immediate security improvements** - Lightweight features work now
2. **Scalable architecture** - Can migrate to Kubernetes when needed
3. **Cost-effective** - Start simple, scale as needed
4. **Flexible deployment** - Works in both scenarios

### Implementation Strategy:

1. **Start with lightweight** - Implement Phase 1 features
2. **Design for scale** - Code structure supports multi-container
3. **Add Kubernetes support** - Phase 2 when needed
4. **Gradual migration** - Move tenants to K8s as needed

## File Structure

```
src/lib/services/security/
├── resource-limits.ts      # Resource limit tracking
├── rate-limiter.ts         # Rate limiting
├── audit-logger.ts         # Audit logging
└── quota-manager.ts        # Disk quota management

k8s/
├── base/
│   ├── namespace.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   └── pvc.yaml
├── overlays/
│   ├── single-container/   # Single container setup
│   └── multi-tenant/        # Kubernetes setup
└── helm-chart/              # Optional Helm chart
```

## Configuration

### Lightweight Mode (Single Container)
```yaml
# docker-compose.yml or .env
SECURITY_MODE=lightweight
MAX_REPOS_PER_USER=100
MAX_DISK_QUOTA_PER_USER=10737418240
RATE_LIMIT_ENABLED=true
AUDIT_LOGGING_ENABLED=true
```

### Enterprise Mode (Kubernetes)
```yaml
# Kubernetes ConfigMap
security:
  mode: enterprise
  isolation: container-per-tenant
  networkPolicy: enabled
  resourceQuotas: enabled
```

## Migration Path

### From Lightweight to Enterprise:

1. **Phase 1**: Deploy lightweight improvements (no architecture change)
2. **Phase 2**: Add Kubernetes support alongside single container
3. **Phase 3**: Migrate high-value tenants to Kubernetes
4. **Phase 4**: Full Kubernetes deployment (optional)

## Priority Implementation Order

1. ✅ **Audit Logging** - Easy, high value, works everywhere
2. ✅ **Rate Limiting** - Prevents abuse, works in single container
3. ✅ **Resource Limits** - Prevents resource exhaustion
4. ⏳ **Enhanced git-http-backend** - Additional hardening
5. ⏳ **Kubernetes Support** - When scaling needed
