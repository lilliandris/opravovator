# Spoločné pre run.sh / stop.sh / build.sh / backup.sh: Docker Compose alebo Podman Compose.
# shellcheck shell=bash
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); ENGINE=docker
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then COMPOSE=(podman compose); ENGINE=podman
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); ENGINE=docker
else echo "Chýba Docker (docker compose) alebo Podman (podman compose)." >&2; exit 1
fi
PROJECT=opravovator
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true); PORT=${PORT:-3000}
VERSION=$(sed -n "s/.*version: '\([^']*\)'.*/\1/p" shared/src/changelog.ts | head -1)
