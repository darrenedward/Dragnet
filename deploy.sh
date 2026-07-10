#!/bin/bash

# Dragnet Deployment Script
# Local:   ./deploy.sh            — build and start container locally
# Remote:  ./deploy.sh remote     — build, push to GHCR (manual pull on server)
#
# No Dokploy server — after remote push, pull + run on your server manually:
#   docker pull ghcr.io/darrenedward/dragnet/app:latest
#   docker compose up -d

set -e

# Secrets are sourced from .env.deploy (gitignored). See .env.deploy.example.
if [ -f .env.deploy ]; then
    set -a
    source .env.deploy
    set +a
fi

# Configuration
REGISTRY="ghcr.io/darrenedward"
PROJECT_NAME="dragnet"
IMAGE_NAME="app"
IMAGE_TAG="${REGISTRY}/${PROJECT_NAME}/${IMAGE_NAME}:latest"
LOCAL_TAG="${PROJECT_NAME}:latest"

GITHUB_USERNAME="darrenedward"

NO_CACHE=false
COMMAND="local"

# Parse arguments
for arg in "$@"; do
    case "$arg" in
        remote)  COMMAND="remote" ;;
        --no-cache) NO_CACHE=true ;;
        help|--help|-h) COMMAND="help" ;;
        *) echo "Unknown argument: $arg"; COMMAND="help" ;;
    esac
done

usage() {
    echo "Dragnet — Deployment Script"
    echo ""
    echo "Usage: ./deploy.sh [remote] [--no-cache]"
    echo ""
    echo "Commands:"
    echo "  (none)       Build and start container locally"
    echo "  remote       Build, push to GHCR (pull + run manually on server)"
    echo "  --no-cache   Build without Docker cache"
    echo "  help         Show this help"
    echo ""
    echo "Examples:"
    echo "  ./deploy.sh                   # Build and start locally"
    echo "  ./deploy.sh remote            # Build, push to GHCR"
    echo "  ./deploy.sh remote --no-cache # Rebuild from scratch and push"
}

if [ "$COMMAND" = "help" ]; then
    usage
    exit 0
fi

# ── Build Docker image ──────────────────────────────────────────
echo ""
echo "Building Docker image..."
if [ "$NO_CACHE" = true ]; then
    docker build --no-cache -t "$IMAGE_TAG" .
else
    docker build -t "$IMAGE_TAG" .
fi
echo "Image built: $IMAGE_TAG"

# ── Local ───────────────────────────────────────────────────────
if [ "$COMMAND" = "local" ]; then
    echo ""
    echo "Starting container locally..."
    docker tag "$IMAGE_TAG" "$LOCAL_TAG"
    docker compose up -d
    echo ""
    echo "Local deployment complete!"
    echo "  App: http://localhost:3300"
    echo ""
    echo "Logs: docker compose logs -f"
    echo "Stop: docker compose down"
    exit 0
fi

# ── Remote ──────────────────────────────────────────────────────
echo ""
echo "Pushing image to GHCR..."
if [ -n "$GITHUB_TOKEN" ]; then
    echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_USERNAME" --password-stdin
fi
docker push "$IMAGE_TAG"
echo "Image pushed: $IMAGE_TAG"

echo ""
echo "Image info:"
docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_TAG" 2>/dev/null || echo "Digest not yet available"

echo ""
echo "Remote push complete!"
echo ""
echo "On your server, pull and run:"
echo "  docker pull $IMAGE_TAG"
echo "  docker compose up -d"
echo ""
echo "  Or if you don't have docker-compose:"
echo "  docker run -d --name dragnet --restart unless-stopped \\"
echo "    --network host \\"
echo "    --env-file .env.local \\"
echo "    -v /var/run/docker.sock:/var/run/docker.sock:ro \\"
echo "    -v ./.dragnet:/app/.dragnet \\"
echo "    -v dragnet-scan-state:/var/lib/dragnet/scans \\"
echo "    $IMAGE_TAG"
