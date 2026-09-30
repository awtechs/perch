#!/bin/bash
# Called by the updater as an unprivileged build user, inside a systemd sandbox.
set -euo pipefail
[[ "${RELEASE_VERSION:?}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${RELEASE_COMMIT:?}" =~ ^[a-f0-9]{40}$ ]]
npm ci --no-audit --no-fund
npm version "$RELEASE_VERSION" --no-git-tag-version --allow-same-version
npm run typecheck
npm run build
npm test
npm run test:deploy
npm prune --omit=dev --no-audit --no-fund
printf '%s\n' "$RELEASE_COMMIT" > COMMIT
tar --exclude='node_modules/.bin' -czf perch.tar.gz dist node_modules package.json package-lock.json COMMIT
