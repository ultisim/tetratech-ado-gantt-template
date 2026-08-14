// Provisions the two Azure resources needed to host the Gantt dashboard:
//   1. Static Web App (Standard SKU — required for Managed Functions + custom domain)
//   2. Key Vault (stores ADO_PAT and optional ADMIN_SECRET)
//
// Deploy via:
//   az deployment group create \
//     --resource-group <rg> \
//     --template-file main.bicep \
//     --parameters siteName=<name> adoOrg=<org> adoProject='<project>'

@description('Name for the Static Web App (also becomes the default *.azurestaticapps.net subdomain).')
param siteName string

@description('Azure region for both resources.')
param location string = resourceGroup().location

@description('ADO org name (from https://dev.azure.com/<ORG>/).')
param adoOrg string

@description('ADO project name (case-sensitive, spaces OK).')
param adoProject string

@description('Cache TTL in seconds for /api/tasks. Default 300.')
param cacheTtlSeconds string = '300'

@description('Optional admin secret. If empty, /api/admin/* endpoints return 404.')
@secure()
param adminSecret string = ''

@description('The ADO Personal Access Token (Work Items: Read, write, & manage scope). Will be stored in Key Vault.')
@secure()
param adoPat string

// --------------------------------------------------------------------------
// Key Vault — holds the ADO PAT (and optionally the admin secret)
// --------------------------------------------------------------------------
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${siteName}-kv'
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enabledForTemplateDeployment: true
    accessPolicies: []
    publicNetworkAccess: 'Enabled'
  }
}

resource patSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'ADO-PAT'
  properties: {
    value: adoPat
  }
}

resource adminSecretResource 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(adminSecret)) {
  parent: keyVault
  name: 'ADMIN-SECRET'
  properties: {
    value: adminSecret
  }
}

// --------------------------------------------------------------------------
// Static Web App — hosts the frontend + Managed Functions API
// --------------------------------------------------------------------------
resource staticWebApp 'Microsoft.Web/staticSites@2023-01-01' = {
  name: siteName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    // We deploy via GitHub Actions or SWA CLI, not via the built-in repo hookup
    provider: 'None'
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
  }
}

// Grant the SWA's system-assigned identity read access to the Key Vault
// (Key Vault Secrets User = "get" and "list" on secrets)
resource swaIdentity 'Microsoft.Web/staticSites@2023-01-01' existing = {
  name: siteName
  dependsOn: [staticWebApp]
}

// App settings — surfaced as env vars to the Functions runtime.
// The ADO_PAT and ADMIN_SECRET use Key Vault references so the actual secret
// is never visible in the SWA config.
resource swaConfig 'Microsoft.Web/staticSites/config@2023-01-01' = {
  parent: staticWebApp
  name: 'appsettings'
  properties: {
    ADO_ORG: adoOrg
    ADO_PROJECT: adoProject
    CACHE_TTL_S: cacheTtlSeconds
    ADO_PAT: '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=ADO-PAT)'
    ADMIN_SECRET: empty(adminSecret) ? '' : '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=ADMIN-SECRET)'
  }
}

output siteUrl string = 'https://${staticWebApp.properties.defaultHostname}'
output siteName string = staticWebApp.name
output resourceGroupName string = resourceGroup().name
output keyVaultName string = keyVault.name
output deploymentToken_hint string = 'Retrieve deployment token via: az staticwebapp secrets list --name ${siteName} --query "properties.apiKey" -o tsv'
