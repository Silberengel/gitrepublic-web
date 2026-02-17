# Kubernetes Deployment Guide

This directory contains Kubernetes manifests for enterprise-grade multi-tenant deployment of gitrepublic-web.

## Architecture

### Enterprise Mode (Kubernetes)
- **Container-per-tenant**: Each user (npub) gets their own namespace
- **Process isolation**: Complete isolation between tenants
- **Network isolation**: Network policies prevent inter-tenant communication
- **Resource quotas**: Per-tenant CPU, memory, and storage limits
- **Separate volumes**: Each tenant has their own PersistentVolume

### Lightweight Mode (Single Container)
- Application-level security controls
- Works with current Docker setup
- See `../docs/SECURITY_IMPLEMENTATION.md` for details

## Directory Structure

```
k8s/
├── base/                    # Base Kubernetes manifests (templates)
│   ├── namespace.yaml      # Namespace per tenant
│   ├── resource-quota.yaml # Resource limits per tenant
│   ├── limit-range.yaml    # Default container limits
│   ├── deployment.yaml     # Application deployment
│   ├── service.yaml        # Service definition
│   ├── pvc.yaml            # Persistent volume claim
│   └── network-policy.yaml # Network isolation
├── overlays/
│   ├── single-container/   # Single container setup (lightweight)
│   └── multi-tenant/       # Kubernetes setup (enterprise)
└── README.md               # This file
```

## Usage

### Single Container (Lightweight)

Use the existing `docker-compose.yml` or `Dockerfile`. Security improvements are application-level and work automatically.

### Kubernetes (Enterprise)

#### Option 1: Manual Deployment

1. **Create namespace for tenant**:
```bash
export TENANT_ID="npub1abc123..."
export GIT_DOMAIN="git.example.com"
export NOSTR_RELAYS="wss://relay1.com,wss://relay2.com"
export STORAGE_CLASS="fast-ssd"

# Replace variables in templatesa
envsubst < k8s/base/namespace.yaml | kubectl apply -f -
envsubst < k8s/base/resource-quota.yaml | kubectl apply -f -
envsubst < k8s/base/limit-range.yaml | kubectl apply -f -
envsubst < k8s/base/pvc.yaml | kubectl apply -f -
envsubst < k8s/base/deployment.yaml | kubectl apply -f -
envsubst < k8s/base/service.yaml | kubectl apply -f -
envsubst < k8s/base/network-policy.yaml | kubectl apply -f -
```

#### Option 2: Operator Pattern (Recommended)

Create a Kubernetes operator that:
- Watches for new repository announcements
- Automatically creates namespaces for new tenants
- Manages tenant lifecycle
- Handles scaling and resource allocation

#### Option 3: Helm Chart

Package as Helm chart for easier deployment:
```bash
helm install gitrepublic ./helm-chart \
  --set tenant.id=npub1abc123... \
  --set git.domain=git.example.com
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SECURITY_MODE` | `lightweight` or `enterprise` | `lightweight` |
| `MAX_REPOS_PER_USER` | Max repos per user | `100` |
| `MAX_DISK_QUOTA_PER_USER` | Max disk per user (bytes) | `10737418240` (10GB) |
| `RATE_LIMIT_ENABLED` | Enable rate limiting | `true` |
| `AUDIT_LOGGING_ENABLED` | Enable audit logging | `true` |

### Resource Quotas

Adjust in `resource-quota.yaml`:
- CPU: requests/limits per tenant
- Memory: requests/limits per tenant
- Storage: per-tenant volume size
- Pods: max pods per tenant

## Ingress Configuration

Use an Ingress controller (e.g., nginx-ingress) to route traffic:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: gitrepublic-ingress
  namespace: gitrepublic-tenant-${TENANT_ID}
spec:
  ingressClassName: nginx
  rules:
  - host: ${TENANT_SUBDOMAIN}.git.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: gitrepublic
            port:
              number: 80
```

## Monitoring

### Recommended Tools
- **Prometheus**: Metrics collection
- **Grafana**: Dashboards
- **Loki**: Log aggregation
- **Jaeger**: Distributed tracing

### Metrics to Monitor
- Request rate per tenant
- Resource usage per tenant
- Error rates
- Git operation durations
- Disk usage per tenant

## Backup Strategy

### Per-Tenant Backups
1. **Volume Snapshots**: Use Kubernetes VolumeSnapshots
2. **Git Repo Backups**: Regular `git bundle` exports
3. **Metadata Backups**: Export Nostr events

### Example Backup Job
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: gitrepublic-backup
  namespace: gitrepublic-tenant-${TENANT_ID}
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: gitrepublic-backup:latest
            command: ["/backup.sh"]
            volumeMounts:
            - name: repos
              mountPath: /repos
          volumes:
          - name: repos
            persistentVolumeClaim:
              claimName: gitrepublic-repos
```

## Migration from Lightweight to Enterprise

1. **Export tenant data**: Backup repositories
2. **Create namespace**: Set up K8s resources
3. **Import data**: Restore to new volume
4. **Update DNS**: Point to new service
5. **Verify**: Test all operations
6. **Decommission**: Remove old container

## Security Considerations

### Network Policies
- Prevents inter-tenant communication
- Restricts egress to necessary services only
- Allows ingress from ingress controller only

### Resource Quotas
- Prevents resource exhaustion
- Ensures fair resource allocation
- Limits blast radius of issues

### Process Isolation
- Complete isolation between tenants
- No shared memory or filesystem
- Separate security contexts

## Cost Considerations

### Lightweight Mode
- **Lower cost**: Single container, shared resources
- **Lower isolation**: Application-level only
- **Good for**: Small to medium deployments

### Enterprise Mode
- **Higher cost**: Multiple containers, separate volumes
- **Higher isolation**: Process and network isolation
- **Good for**: Large deployments, enterprise customers

## Hybrid Approach

Run both modes:
- **Lightweight**: For most users (cost-effective)
- **Enterprise**: For high-value tenants (isolation)

Use a tenant classification system to route tenants to appropriate mode.
