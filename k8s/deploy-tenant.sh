#!/bin/bash
# Deploy a tenant to Kubernetes in enterprise mode
# Usage: ./deploy-tenant.sh <tenant-npub> [options]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if tenant ID is provided
if [ -z "$1" ]; then
  echo -e "${RED}Error: Tenant ID (npub) is required${NC}"
  echo "Usage: $0 <tenant-npub> [--domain <domain>] [--storage-class <class>] [--storage-size <size>] [--subdomain <subdomain>]"
  echo ""
  echo "Example:"
  echo "  $0 npub1abc123... --domain git.example.com --storage-class fast-ssd --storage-size 50Gi"
  exit 1
fi

TENANT_ID="$1"
shift

# Default values
GIT_DOMAIN="${GIT_DOMAIN:-git.example.com}"
STORAGE_CLASS="${STORAGE_CLASS:-standard}"
STORAGE_SIZE="${STORAGE_SIZE:-100Gi}"
TENANT_SUBDOMAIN="${TENANT_SUBDOMAIN:-${TENANT_ID:0:16}}"
NOSTR_RELAYS="${NOSTR_RELAYS:-wss://theforest.nostr1.com,wss://nostr.land}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)
      GIT_DOMAIN="$2"
      shift 2
      ;;
    --storage-class)
      STORAGE_CLASS="$2"
      shift 2
      ;;
    --storage-size)
      STORAGE_SIZE="$2"
      shift 2
      ;;
    --subdomain)
      TENANT_SUBDOMAIN="$2"
      shift 2
      ;;
    --relays)
      NOSTR_RELAYS="$2"
      shift 2
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

# Validate tenant ID format (basic check)
if [[ ! "$TENANT_ID" =~ ^npub1[a-z0-9]+$ ]]; then
  echo -e "${YELLOW}Warning: Tenant ID doesn't look like a valid npub format${NC}"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

echo -e "${GREEN}Deploying tenant: ${TENANT_ID}${NC}"
echo "  Domain: ${GIT_DOMAIN}"
echo "  Subdomain: ${TENANT_SUBDOMAIN}"
echo "  Storage Class: ${STORAGE_CLASS}"
echo "  Storage Size: ${STORAGE_SIZE}"
echo ""

# Export variables for envsubst
export TENANT_ID
export GIT_DOMAIN
export STORAGE_CLASS
export STORAGE_SIZE
export TENANT_SUBDOMAIN
export NOSTR_RELAYS

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
  echo -e "${RED}Error: kubectl is not installed or not in PATH${NC}"
  exit 1
fi

# Check if we can connect to cluster
if ! kubectl cluster-info &> /dev/null; then
  echo -e "${RED}Error: Cannot connect to Kubernetes cluster${NC}"
  exit 1
fi

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${SCRIPT_DIR}/base"

echo -e "${GREEN}Creating namespace...${NC}"
envsubst < "${BASE_DIR}/namespace.yaml" | kubectl apply -f -

echo -e "${GREEN}Creating resource quota...${NC}"
envsubst < "${BASE_DIR}/resource-quota.yaml" | kubectl apply -f -

echo -e "${GREEN}Creating limit range...${NC}"
envsubst < "${BASE_DIR}/limit-range.yaml" | kubectl apply -f -

echo -e "${GREEN}Creating persistent volume claim...${NC}"
envsubst < "${BASE_DIR}/pvc.yaml" | kubectl apply -f -

echo -e "${GREEN}Creating deployment...${NC}"
envsubst < "${BASE_DIR}/deployment.yaml" | kubectl apply -f -

echo -e "${GREEN}Creating service...${NC}"
envsubst < "${BASE_DIR}/service.yaml" | kubectl apply -f -

echo -e "${GREEN}Creating network policy...${NC}"
envsubst < "${BASE_DIR}/network-policy.yaml" | kubectl apply -f -

echo -e "${GREEN}Creating ingress...${NC}"
envsubst < "${BASE_DIR}/ingress.yaml" | kubectl apply -f -

echo ""
echo -e "${GREEN}✓ Tenant deployed successfully!${NC}"
echo ""
echo "To check status:"
echo "  kubectl get all -n gitrepublic-tenant-${TENANT_ID}"
echo ""
echo "To view logs:"
echo "  kubectl logs -n gitrepublic-tenant-${TENANT_ID} -l app=gitrepublic"
echo ""
echo "To delete tenant:"
echo "  kubectl delete namespace gitrepublic-tenant-${TENANT_ID}"
