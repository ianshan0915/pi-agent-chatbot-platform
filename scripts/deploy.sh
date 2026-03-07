#!/bin/bash
# Deploy chatbot-platform to AWS.
#
# Usage:
#   ./scripts/deploy.sh          # Full deploy (infra + build + push + restart)
#   ./scripts/deploy.sh infra    # CDK deploy only
#   ./scripts/deploy.sh app      # Build + push + restart only (skip infra)
#
# Prerequisites:
#   - AWS CLI configured with credentials for account 017263836161
#   - Docker running
#   - CDK bootstrapped: cd infra && npx cdk bootstrap aws://017263836161/eu-central-1

set -euo pipefail

REGION="eu-central-1"
ACCOUNT="017263836161"
STACK_NAME="ChatbotPlatformStack"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
error() { echo -e "${RED}[deploy]${NC} $*" >&2; }

# Check prerequisites
check_prereqs() {
    if ! command -v aws &>/dev/null; then
        error "AWS CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
        exit 1
    fi
    if ! command -v docker &>/dev/null; then
        error "Docker not found."
        exit 1
    fi
    if ! docker info &>/dev/null 2>&1; then
        error "Docker daemon not running."
        exit 1
    fi

    # Verify AWS identity
    local identity
    identity=$(aws sts get-caller-identity --region "$REGION" 2>/dev/null) || {
        error "AWS credentials not configured. Run 'aws configure' first."
        exit 1
    }
    local actual_account
    actual_account=$(echo "$identity" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)
    if [ "$actual_account" != "$ACCOUNT" ]; then
        error "AWS account mismatch: expected $ACCOUNT, got $actual_account"
        exit 1
    fi
    info "AWS identity verified: account $ACCOUNT"
}

# Deploy CDK infrastructure
deploy_infra() {
    info "Deploying CDK infrastructure..."
    cd "$PROJECT_ROOT/infra"

    if [ ! -d "node_modules" ]; then
        info "Installing CDK dependencies..."
        npm install
    fi

    npx cdk deploy "$STACK_NAME" --require-approval broadening --outputs-file cdk-outputs.json
    info "Infrastructure deployed. Outputs saved to infra/cdk-outputs.json"
}

# Get stack output value
get_output() {
    local key="$1"
    local outputs_file="$PROJECT_ROOT/infra/cdk-outputs.json"
    if [ ! -f "$outputs_file" ]; then
        error "cdk-outputs.json not found. Run './scripts/deploy.sh infra' first."
        exit 1
    fi
    python3 -c "import json; d=json.load(open('$outputs_file')); print(d['$STACK_NAME']['$key'])" 2>/dev/null || {
        error "Could not read output '$key' from cdk-outputs.json"
        exit 1
    }
}

# Build and push Docker image
deploy_app() {
    local ecr_uri
    ecr_uri=$(get_output "EcrRepositoryUri")
    info "ECR repository: $ecr_uri"

    # Authenticate Docker to ECR
    info "Authenticating Docker to ECR..."
    aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

    # Build image
    info "Building Docker image..."
    cd "$PROJECT_ROOT"
    docker build --platform linux/amd64 -t chatbot-platform .

    # Tag and push
    local tag="latest"
    local full_tag="$ecr_uri:$tag"
    info "Pushing image to $full_tag..."
    docker tag chatbot-platform:latest "$full_tag"
    docker push "$full_tag"
    info "Image pushed successfully."

    # Force new ECS deployment
    info "Triggering ECS service update..."
    local cluster_arn
    cluster_arn=$(aws ecs list-clusters --region "$REGION" --query "clusterArns[?contains(@, 'ChatbotPlatform')]" --output text)
    if [ -z "$cluster_arn" ]; then
        error "Could not find ECS cluster. Has infra been deployed?"
        exit 1
    fi

    local service_arn
    service_arn=$(aws ecs list-services --region "$REGION" --cluster "$cluster_arn" --query "serviceArns[0]" --output text)
    if [ -z "$service_arn" ] || [ "$service_arn" = "None" ]; then
        error "Could not find ECS service."
        exit 1
    fi

    aws ecs update-service --region "$REGION" --cluster "$cluster_arn" --service "$service_arn" --force-new-deployment >/dev/null
    info "ECS deployment triggered. Waiting for stabilization..."

    aws ecs wait services-stable --region "$REGION" --cluster "$cluster_arn" --services "$service_arn" 2>/dev/null || {
        warn "Service didn't stabilize within timeout. Check ECS console for status."
    }

    info "Deployment complete!"
}

# Post-deploy: show useful info
show_status() {
    echo ""
    info "=== Deployment Summary ==="

    local alb_dns
    alb_dns=$(get_output "LoadBalancerDNS" 2>/dev/null) || true
    [ -n "$alb_dns" ] && info "ALB DNS:    $alb_dns"

    local app_url
    app_url=$(get_output "AppUrl" 2>/dev/null) || true
    [ -n "$app_url" ] && info "App URL:    $app_url"

    local secrets_arn
    secrets_arn=$(get_output "AppSecretsArn" 2>/dev/null) || true
    if [ -n "$secrets_arn" ]; then
        info "Secrets:    $secrets_arn"
        warn "Remember to set ENCRYPTION_ROOT_KEY in Secrets Manager if not done yet:"
        warn "  aws secretsmanager get-secret-value --secret-id chatbot-platform/app-secrets --region $REGION"
    fi

    echo ""
}

# Main
MODE="${1:-full}"
check_prereqs

case "$MODE" in
    infra)
        deploy_infra
        show_status
        ;;
    app)
        deploy_app
        show_status
        ;;
    full)
        deploy_infra
        deploy_app
        show_status
        ;;
    *)
        error "Unknown mode: $MODE. Use: full, infra, or app"
        exit 1
        ;;
esac
