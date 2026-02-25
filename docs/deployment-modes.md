# Lightweight versus Enterprise Modes

GitRepublic supports two deployment modes with different security and isolation characteristics.

## Lightweight Mode (Single Container) - Default

Lightweight mode is the default deployment option, suitable for most use cases.

### Characteristics

- **Single container**: All users share the same container
- **Shared filesystem**: Repositories stored in shared directory structure
- **Process isolation**: Uses git-http-backend with process isolation
- **Resource limits**: Per-user repository count and disk quota limits
- **Rate limiting**: Per-IP and per-user rate limiting

### Security Features

- **Resource Limits**: 
  - Maximum repositories per user (default: 100)
  - Maximum disk quota per user (default: 10 GB)
  - Maximum file size (500 MB)
  - Maximum repository size (2 GB)

- **Rate Limiting**: 
  - Per-IP rate limiting for all operations
  - Per-user rate limiting for authenticated operations
  - Configurable rate limit windows

- **Path Validation**: 
  - Strict path validation to prevent traversal attacks
  - All file operations validated against repository root
  - Git operations scoped to repository directories

- **Audit Logging**: 
  - Comprehensive logging of all security-relevant events
  - User actions, access attempts, permission checks
  - Repository operations and ownership transfers

- **git-http-backend Hardening**: 
  - Timeouts for git operations
  - Process isolation
  - Scoped access to repository directories
  - Input validation and sanitization

### Configuration

Set `ENTERPRISE_MODE=false` or leave unset (default).

### Use Cases

- Personal git hosting
- Small to medium teams
- Development environments
- Single-tenant deployments

## Enterprise Mode (Kubernetes)

Enterprise mode provides maximum isolation and security for multi-tenant deployments.

### Characteristics

- **Container-per-tenant**: Each tenant has their own container
- **Network isolation**: Kubernetes Network Policies
- **Resource quotas**: Per-tenant CPU, memory, and storage limits
- **Separate volumes**: Each tenant has their own PersistentVolume
- **Complete isolation**: Tenants cannot access each other's resources

### Security Features

All lightweight mode features, plus:

- **Process Isolation**: 
  - Each tenant runs in separate container
  - No shared processes or memory
  - Complete process isolation

- **Network Isolation**: 
  - Kubernetes Network Policies
  - Tenant-to-tenant communication blocked
  - Only necessary network access allowed

- **Resource Quotas**: 
  - Per-tenant CPU limits
  - Per-tenant memory limits
  - Per-tenant storage limits
  - Enforced by Kubernetes

- **Volume Isolation**: 
  - Each tenant has dedicated PersistentVolume
  - No shared storage access
  - Complete filesystem isolation

### Configuration

Set `ENTERPRISE_MODE=true` environment variable.

### Deployment

See `k8s/ENTERPRISE_MODE.md` for complete setup instructions.

### Use Cases

- Multi-tenant SaaS deployments
- Enterprise customers
- High-security requirements
- Regulatory compliance needs

## Security Comparison

| Feature | Lightweight Mode | Enterprise Mode |
|---------|-----------------|-----------------|
| Process Isolation | git-http-backend only | Container-per-tenant |
| Filesystem Isolation | Directory-based | Volume-per-tenant |
| Network Isolation | None | Kubernetes Policies |
| Resource Limits | Per-user quotas | Per-tenant Kubernetes quotas |
| Audit Logging | ✅ | ✅ |
| Path Validation | ✅ | ✅ |
| Rate Limiting | ✅ | ✅ |

## Security Documentation

Security features are implemented in both lightweight and enterprise modes. See the codebase for detailed implementation.

## Next Steps

- [Tech stack used](./tech-stack.md) - Technical implementation
- [Specs used](./specs.md) - Security-related specifications
