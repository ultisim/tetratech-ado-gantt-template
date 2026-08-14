#!/usr/bin/env bash
# Manual redeploy script. Normally you don't need this — pushes to main
# auto-deploy via the GitHub Actions workflow. This is for local deploys
# when you're iterating on infra without wanting to push.
set -euo pipefail

if [ -f ../.env ]; then
    set -a; source ../.env; set +a
fi

: "${AZURE_RESOURCE_GROUP:?must be set in .env}"
: "${AZURE_STATIC_WEB_APP_NAME:?must be set in .env}"

echo "Fetching deployment token…"
TOKEN=$(az staticwebapp secrets list \
    --name "$AZURE_STATIC_WEB_APP_NAME" \
    --query "properties.apiKey" -o tsv)

echo "Deploying via SWA CLI…"
cd ..
npx @azure/static-web-apps-cli deploy public \
    --api-location api \
    --deployment-token "$TOKEN" \
    --env production

echo "Done."
