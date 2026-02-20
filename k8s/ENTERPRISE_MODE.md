# Enterprise Mode Setup Guide

Enterprise mode provides complete isolation between tenants using Kubernetes. Each tenant (user/npub) gets their own container, namespace, and persistent volume.

## Quick Start

### Prerequisites

1. **Kubernetes cluster** (minikube, kind, or production cluster)
2. **kubectl** configured to access your cluster
3. **envsubst** (usually comes with `gettext` package)
4. **Ingress controller** (nginx-ingress recommended)

### Enable Enterprise Mode

Set the `ENTERPRISE_MODE` environment variable to `true`:

```bash
export ENTERPRISE_MODE=true
```

**Default**: `false` (lightweight mode - single container)

### Deploy a Tenant

```bash
cd k8s
./deploy-tenant.sh npub1abc123... \
  --domain git.example.com \
  --storage-class fast-ssd \
  --storage-size 50Gi
```

### Check Status

```bash
# List all tenant namespaces
kubectl get namespaces | grep gitrepublic-tenant

# Check tenant resources
kubectl get all -n gitrepublic-tenant-<npub>

# View logs
kubectl logs -n gitrepublic-tenant-<npub> -l app=gitrepublic -f
```

### Delete a Tenant

```bash
./delete-tenant.sh npub1abc123...
```

## Architecture

In Enterprise Mode:

```
Kubernetes Cluster
├── Namespace: gitrepublic-tenant-npub1
│   ├── Deployment (1 pod)
│   │   └── Container: gitrepublic-web
│   ├── Service (ClusterIP)
│   ├── PersistentVolumeClaim (100Gi)
│   ├── ResourceQuota
│   ├── NetworkPolicy
│   └── Ingress
│
├── Namespace: gitrepublic-tenant-npub2
│   └── (same structure)
│
└── Namespace: gitrepublic-tenant-npub3
    └── (same structure)
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENTERPRISE_MODE` | Enable enterprise mode | `false` |
| `GIT_DOMAIN` | Domain for git repositories | `localhost:6543` |
| `NOSTR_RELAYS` | Comma-separated Nostr relays | `wss://theforest.nostr1.com,...` |
| `STORAGE_CLASS` | Kubernetes storage class | `standard` |
| `STORAGE_SIZE` | Volume size per tenant | `100Gi` |

### Resource Limits (per tenant)

Default limits in `resource-quota.yaml`:
- **CPU**: 2 requests, 4 limits
- **Memory**: 2Gi requests, 4Gi limits
- **Storage**: 100Gi requests, 200Gi limits
- **Pods**: 2 max

Adjust in `k8s/base/resource-quota.yaml` as needed.

## Ingress Configuration

Each tenant can have:
- **Subdomain**: `user1.git.example.com`
- **Path-based**: `git.example.com/npub1abc123...`

Update `k8s/base/ingress.yaml` for your routing strategy.

### SSL/TLS

To enable HTTPS, uncomment the TLS section in `ingress.yaml` and configure cert-manager:

```yaml
tls:
- hosts:
  - ${TENANT_SUBDOMAIN}.${GIT_DOMAIN}
  secretName: gitrepublic-tls
```

## Network Isolation

Network policies prevent:
- Inter-tenant communication
- Unauthorized ingress
- Unnecessary egress

Only allows:
- Ingress from ingress controller
- Egress to Nostr relays (WSS on port 443)
- DNS queries

## Storage

Each tenant gets:
- **Own PersistentVolume**: Complete isolation
- **Size limits**: Configurable per tenant
- **Storage class**: Can use fast SSD for performance

### Backup

Use Kubernetes VolumeSnapshots:

```bash
kubectl create volumesnapshot gitrepublic-snapshot-$(date +%Y%m%d) \
  --namespace gitrepublic-tenant-<npub> \
  --source-pvc gitrepublic-repos
```

## Monitoring

### View Resource Usage

```bash
# CPU and memory usage
kubectl top pods -n gitrepublic-tenant-<npub>

# Storage usage
kubectl describe pvc gitrepublic-repos -n gitrepublic-tenant-<npub>
```

### Logs

```bash
# Application logs
kubectl logs -n gitrepublic-tenant-<npub> -l app=gitrepublic

# All resources in namespace
kubectl get all -n gitrepublic-tenant-<npub>
```

## Troubleshooting

### Pod Not Starting

```bash
# Check pod status
kubectl describe pod -n gitrepublic-tenant-<npub> -l app=gitrepublic

# Check events
kubectl get events -n gitrepublic-tenant-<npub> --sort-by='.lastTimestamp'
```

### Volume Issues

```bash
# Check PVC status
kubectl describe pvc gitrepublic-repos -n gitrepublic-tenant-<npub>

# Check storage class
kubectl get storageclass
```

### Network Issues

```bash
# Test connectivity from pod
kubectl exec -n gitrepublic-tenant-<npub> -l app=gitrepublic -- curl -I https://theforest.nostr1.com
```

## Migration from Lightweight Mode

1. **Backup repositories** from lightweight mode
2. **Deploy tenant** in enterprise mode
3. **Restore data** to new volume
4. **Update DNS** to point to new ingress
5. **Verify** all operations work
6. **Decommission** old lightweight container

## Cost Considerations

Enterprise mode uses more resources:
- **Per-tenant overhead**: ~500MB RAM, 0.5 CPU per tenant
- **Storage**: Separate volumes (can't share unused space)
- **Network**: More complex routing

**Recommendation**: Use enterprise mode for:
- High-value tenants
- Security-sensitive deployments
- Compliance requirements
- Large-scale deployments

Use lightweight mode for:
- Development/testing
- Small deployments
- Cost-sensitive scenarios
