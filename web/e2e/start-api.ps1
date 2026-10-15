# Starts the sandbox API for the UI end-to-end run (owner-account provider, short step-up window, generous rate limits).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..\backend')
$rand = { [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 } | ForEach-Object { [byte]$_ })) }
$env:JWT_SECRET = (& $rand) + (& $rand)
$env:PROVIDER_WEBHOOK_SECRET = 'e2e-webhook-secret-123456'
$env:MFA_ENCRYPTION_KEY = & $rand
$env:PROVIDER_KIND = $(if ($env:E2E_PROVIDER_KIND) { $env:E2E_PROVIDER_KIND } else { 'owner-account-sandbox' })
$env:OWNER_UPI_ID = 'gateway-sandbox@sandboxbank'
$env:WEB_ORIGIN = 'http://localhost:3010'
$env:WEB_BASE_URL = 'http://localhost:3010'
$env:MFA_STEPUP_WINDOW_SECONDS = '30'
$env:RATE_LIMIT_AUTH_PER_MIN = '200'
$env:RATE_LIMIT_MFA_PER_MIN = '200'
$env:BOOTSTRAP_ADMIN_EMAIL = 'admin@example.test'
$env:BOOTSTRAP_ADMIN_PASSWORD = 'e2e-admin-password-1'
$env:PGLITE_DIR = (Join-Path $env:TEMP "gw-e2e-$(Get-Random)")
$env:PORT = '3001'
npx ts-node src/main.ts
