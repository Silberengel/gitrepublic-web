#!/bin/bash
# Delete a tenant from Kubernetes
# Usage: ./delete-tenant.sh <tenant-npub>

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if tenant ID is provided
if [ -z "$1" ]; then
  echo -e "${RED}Error: Tenant ID (npub) is required${NC}"
  echo "Usage: $0 <tenant-npub>"
  exit 1
fi

TENANT_ID="$1"

# Validate tenant ID format (basic check)
if [[ ! "$TENANT_ID" =~ ^npub1[a-z0-9]+$ ]]; then
  echo -e "${YELLOW}Warning: Tenant ID doesn't look like a valid npub format${NC}"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

NAMESPACE="gitrepublic-tenant-${TENANT_ID}"

# Check if namespace exists
if ! kubectl get namespace "$NAMESPACE" &> /dev/null; then
  echo -e "${RED}Error: Namespace ${NAMESPACE} does not exist${NC}"
  exit 1
fi

echo -e "${YELLOW}WARNING: This will delete the entire tenant namespace and all resources!${NC}"
echo "  Namespace: ${NAMESPACE}"
echo "  This includes:"
echo "    - All pods and containers"
echo "    - Persistent volumes (data will be lost unless backed up)"
echo "    - All configuration"
echo ""
read -p "Are you sure you want to delete this tenant? (yes/NO) " -r
echo

if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
  echo "Cancelled."
  exit 0
fi

echo -e "${GREEN}Deleting tenant namespace: ${NAMESPACE}${NC}"
kubectl delete namespace "$NAMESPACE" --wait=true

echo ""
echo -e "${GREEN}✓ Tenant deleted successfully!${NC}"
