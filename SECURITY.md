# Security Analysis

## Current Security Model

This is a **multi-tenant system** where multiple users (identified by Nostr pubkeys/npubs) share the same server instance with **application-level isolation** but **no process or filesystem isolation**.

### Security Measures in Place

1. **Path Validation**
   - ✅ File paths are validated and sanitized
   - ✅ Path traversal attempts (`..`) are blocked
   - ✅ Absolute paths are rejected
   - ✅ Null bytes and control characters are blocked
   - ✅ Path length limits enforced (4096 chars)

2. **Input Validation**
   - ✅ npub format validation (must be valid bech32)
   - ✅ Repository name validation (alphanumeric, hyphens, underscores, dots only)
   - ✅ No path separators allowed in repo names

3. **Access Control**
   - ✅ Repository ownership verified via Nostr events
   - ✅ Private repos require NIP-98 authentication
   - ✅ Maintainer checks before allowing write operations
   - ✅ Ownership transfer chain validation

4. **Path Construction**
   - ✅ Uses `path.join()` which prevents path traversal
   - ✅ Repository path: `join(repoRoot, npub, `${repoName}.git`)`
   - ✅ File paths within repos are validated separately

## Security Concerns

### ⚠️ **Critical: No Process Isolation**

**Issue**: All repositories run in the same Node.js process. If an attacker compromises one repository or finds a code execution vulnerability, they could potentially:
- Access other users' repositories
- Read/write files outside the repo directory
- Access server configuration or secrets

**Mitigation**: 
- Path validation prevents most traversal attacks
- Access control checks prevent unauthorized access
- But a process-level compromise would bypass these

### ✅ **High: git-http-backend Security** - IMPROVED

**Previous Issue**: `git-http-backend` was spawned with `GIT_PROJECT_ROOT` set to the entire `repoRoot`, allowing potential access to all repositories.

**Current Protection** (✅ IMPLEMENTED):
- ✅ `GIT_PROJECT_ROOT` now set to **specific repository path** (not entire repoRoot)
- ✅ `PATH_INFO` adjusted to be relative to the repository
- ✅ Path validation ensures repository path is within `repoRoot`
- ✅ Limits git-http-backend's view to only the intended repository

**Remaining Concerns**:
- No chroot/jail isolation (git-http-backend still runs in same process context)
- If git-http-backend has vulnerabilities, it could still access files within the repo
- ✅ Runs as dedicated `gitrepublic` user (non-root) - IMPLEMENTED

### ⚠️ **Medium: No Resource Limits Per Tenant**

**Issue**: No per-user resource limits:
- One user could exhaust disk space (2GB per repo limit, but unlimited repos)
- One user could exhaust memory/CPU
- No rate limiting per user

**Current Protection**:
- 2GB repository size limit
- 500MB per-file limit
- But no per-user quotas

### ✅ **Medium: Filesystem Access** - IMPROVED

**Previous Issue**: Repository paths were not validated to ensure they stayed within `repoRoot`.

**Current Protection** (✅ IMPLEMENTED):
- ✅ Repository path validation using `resolve()` to check absolute paths
- ✅ Ensures resolved repository path starts with resolved `repoRoot`
- ✅ Prevents path traversal attacks at the repository level
- ✅ File path validation within repositories (already existed)
- ✅ Access control checks for private repos

**Remaining Concerns**:
- No chroot/jail isolation
- All repos readable by the same process user
- Relies on application logic, not OS-level isolation

### ⚠️ **Low: Network Isolation**

**Issue**: All repos accessible from same endpoints:
- No network-level isolation between tenants
- All repos share same IP/domain

**Impact**: Low - this is expected for a multi-tenant service

## Security Improvements Made

### ✅ Implemented (2024)

1. **✅ Repository Path Validation**
   - Added `resolve()` checks to ensure repository paths stay within `repoRoot`
   - Prevents path traversal attacks at the repository level
   - Applied to all git operations (GET and POST handlers)

2. **✅ git-http-backend Isolation**
   - Changed `GIT_PROJECT_ROOT` from entire `repoRoot` to specific repository path
   - Adjusted `PATH_INFO` to be relative to the repository
   - Limits git-http-backend's view to only the intended repository

3. **✅ File Path Validation** (Already existed)
   - Validates file paths within repositories
   - Prevents path traversal within repos
   - Blocks absolute paths, null bytes, control characters

## Recommendations

### ✅ Implemented (2024)

1. **✅ Resource Limits** - IMPLEMENTED
   - ✅ Per-user repository count limits (configurable via `MAX_REPOS_PER_USER`)
   - ✅ Per-user disk quota (configurable via `MAX_DISK_QUOTA_PER_USER`)
   - ✅ Rate limiting per user/IP (configurable via `RATE_LIMIT_*` env vars)
   - ✅ Applied to fork operations and repository creation

2. **✅ Audit Logging** - IMPLEMENTED
   - ✅ Logs all repository access attempts
   - ✅ Logs all file operations (read/write/delete)
   - ✅ Logs authentication attempts
   - ✅ Logs ownership transfers
   - ✅ Structured JSON logging format

3. **✅ Enhanced git-http-backend Security** - IMPLEMENTED
   - ✅ Operation timeouts (5 minutes max)
   - ✅ Process isolation (no shell, minimal environment)
   - ✅ Audit logging for all git operations
   - ✅ Path validation and scoping
   - ⚠️ Chroot/jail still not implemented (complex, requires root or capabilities)

### Remaining (Medium Priority)

### Medium Priority

4. **Process Isolation** (Complex)
   - Run each tenant in separate container/process
   - Use Docker with per-tenant containers
   - Significant architectural change

5. **Filesystem Isolation**
   - Use bind mounts with restricted permissions
   - Implement per-tenant filesystem quotas
   - Use separate volumes per tenant

6. **✅ Audit Logging** - IMPLEMENTED
   - ✅ Log all repository access attempts
   - ✅ Log all file operations
   - ⏳ Monitor for suspicious patterns (requires log analysis tools)

### Long-term

7. **Container-per-Tenant Architecture**
   - Each user gets their own container
   - Complete isolation
   - Higher resource overhead

8. **Kubernetes Namespaces**
   - Use K8s namespaces for tenant isolation
   - Network policies for isolation
   - Resource quotas per namespace

## Current Security Posture

**For a decentralized, open-source git hosting service**, the current security model is **reasonable but not enterprise-grade**:

✅ **Adequate for**:
- Public repositories
- Open-source projects
- Personal/community hosting
- Low-to-medium security requirements

⚠️ **Not adequate for**:
- Enterprise multi-tenant SaaS
- Highly sensitive/regulated data
- Environments requiring strict compliance (HIPAA, PCI-DSS, etc.)
- High-security government/military use

## Conclusion

The system uses **application-level security** with good input validation and access control, but lacks **OS-level isolation**. This is a common trade-off for multi-tenant services - it's simpler and more resource-efficient, but less secure than process/container isolation.

**Recommendation**: For most use cases (public repos, open-source hosting), the current model is acceptable. For enterprise or high-security use cases, consider implementing process/container isolation.
