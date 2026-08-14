#!/usr/bin/env bash
# Manual redeploy for the frontend + Functions. Normally pushes to main
# auto-deploy via GitHub Actions; this is for local iteration.
set -euo pipefail

if [ -f ../.env ]; then
    set -a; source ../.env; set +a
fi

: "${AZURE_STATIC_WEB_APP_NAME:?must be set in .env}"

echo "Fetching deployment token..."
TOKEN=$(az staticwebapp secrets list \
    --name "$AZURE_STATIC_WEB_APP_NAME" \
    --query "properties.apiKey" -o tsv)

echo "Installing API dependencies..."
(cd ../api && npm install --production)

echo "Deploying via SWA CLI..."
cd ..
npx @azure/static-web-apps-cli deploy public \
    --api-location api \
    --deployment-token "$TOKEN" \
    --env production

echo "Done. Site is at: https://${AZURE_STATIC_WEB_APP_NAME}.azurestaticapps.net"
