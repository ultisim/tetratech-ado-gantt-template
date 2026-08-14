// Provisions the Azure resources for one PM's Gantt instance:
//   1. Static Web App (Standard tier — required for Managed Functions
//      + Key Vault references + custom domain)
//   2. Storage Account (holds the 'projects' Table Storage table)
//   3. Key Vault (holds per-project PATs + optional per-project admin secrets)
//
// Deploy via:
//   az deployment group create \
//     --resource-group <rg> \
//     --template-file main.bicep \
//     --parameters siteName=<name> aadClientId=<id> aadClientSecret=<sec>
//
// Or via the local setup wizard: `npm run setup`

@description('Base name for the resources — becomes the SWA default subdomain, storage account, key vault.')
@minLength(3)
@maxLength(20)
param siteName string

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Entra ID client (app registration) id — for SWA sign-in.')
param aadClientId string

@description('Entra ID client secret. Stored in SWA app settings (opaque).')
@secure()
param aadClientSecret string

@description('Optional: restrict sign-in to a single Entra tenant id. Empty = any Microsoft account.')
param allowedTenantId string = ''

@description('Cache TTL in seconds for /api/projects/*/tasks. Default 300.')
param cacheTtlSeconds string = '300'

// --------------------------------------------------------------------------
// Storage Account (Table Storage for projects config)
// --------------------------------------------------------------------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${toLower(replace(siteName, '-', ''))}sa'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false // force Managed Identity access
  }
}

// The 'projects' table
resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource projectsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'projects'
}

// --------------------------------------------------------------------------
// Key Vault (per-project PATs and admin secrets)
// --------------------------------------------------------------------------
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${siteName}-kv'
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true // RBAC instead of access policies
    enabledForTemplateDeployment: true
    accessPolicies: []
    publicNetworkAccess: 'Enabled'
    softDeleteRetentionInDays: 7
  }
}

// --------------------------------------------------------------------------
// Static Web App (frontend + Managed Functions API)
// --------------------------------------------------------------------------
resource staticWebApp 'Microsoft.Web/staticSites@2023-01-01' = {
  name: siteName
  location: location
  sku: { name: 'Standard', tier: 'Standard' }
  identity: { type: 'SystemAssigned' } // for Key Vault + Storage access
  properties: {
    provider: 'None' // we deploy via SWA CLI / GitHub Actions, not built-in Git
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
  }
}

// --------------------------------------------------------------------------
// Role assignments — Managed Identity access
// --------------------------------------------------------------------------
// Role IDs are the well-known built-in role definition ids.
var roleIds = {
  // Key Vault Secrets Officer — get/list/set/delete secrets
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  // Storage Table Data Contributor — read/write table entities
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
}

resource swaKeyVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, staticWebApp.id, roleIds.keyVaultSecretsOfficer)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultSecretsOfficer)
    principalId: staticWebApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource swaTableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, staticWebApp.id, roleIds.storageTableDataContributor)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.storageTableDataContributor)
    principalId: staticWebApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// --------------------------------------------------------------------------
// App settings — Functions runtime env vars
// --------------------------------------------------------------------------
resource swaConfig 'Microsoft.Web/staticSites/config@2023-01-01' = {
  parent: staticWebApp
  name: 'appsettings'
  properties: {
    KEYVAULT_URI: keyVault.properties.vaultUri
    STORAGE_ACCOUNT_NAME: storage.name
    PROJECTS_TABLE_NAME: 'projects'
    CACHE_TTL_S: cacheTtlSeconds
    ALLOWED_TENANT_ID: allowedTenantId
    AAD_CLIENT_ID: aadClientId
    AAD_CLIENT_SECRET: aadClientSecret
  }
}

output siteUrl string = 'https://${staticWebApp.properties.defaultHostname}'
output siteName string = staticWebApp.name
output resourceGroupName string = resourceGroup().name
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output storageAccountName string = storage.name
output managedIdentityPrincipalId string = staticWebApp.identity.principalId
output deploymentTokenHint string = 'az staticwebapp secrets list --name ${siteName} --query "properties.apiKey" -o tsv'
