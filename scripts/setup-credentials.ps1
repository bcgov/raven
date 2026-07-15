# setup-credentials.ps1
# Stores RAVEN credentials in a DPAPI-encrypted file (~/.raven/.env.dpapi).
# DPAPI binds encryption to the current Windows user account on this machine -
# the resulting file cannot be decrypted by other users or on other machines.
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-credentials.ps1
#
# To verify stored credentials:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-credentials.ps1 -Verify
#
# To delete stored credentials:
#   Remove-Item "$env:USERPROFILE\.raven\.env.dpapi"

[CmdletBinding()]
param(
    [switch]$Verify
)

$CredFile = Join-Path $env:USERPROFILE ".raven\.env.dpapi"
$CredDir  = Split-Path $CredFile

function Protect-String([string]$plain) {
    $secStr = ConvertTo-SecureString $plain -AsPlainText -Force
    return ConvertFrom-SecureString $secStr   # DPAPI-encrypts, returns base64 blob
}

function Unprotect-String([string]$encrypted) {
    $secStr = ConvertTo-SecureString $encrypted
    $bstr   = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secStr)
    try   { return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# --- Verify mode ---
if ($Verify) {
    if (-not (Test-Path $CredFile)) {
        Write-Host "No encrypted credential file found at: $CredFile" -ForegroundColor Yellow
        Write-Host "Run this script without -Verify to create one."
        exit 1
    }
    $stored = Get-Content $CredFile | ConvertFrom-Json
    Write-Host "Stored credential keys: $($stored.PSObject.Properties.Name -join ', ')" -ForegroundColor Cyan
    foreach ($prop in $stored.PSObject.Properties) {
        try {
            $val = Unprotect-String $prop.Value
            $masked = if ($val.Length -le 4) { "****" } else { $val.Substring(0,2) + ("*" * ($val.Length - 4)) + $val.Substring($val.Length - 2) }
            Write-Host "  $($prop.Name): $masked" -ForegroundColor Green
        } catch {
            Write-Host "  $($prop.Name): [decryption failed - was this encrypted by a different user/machine?]" -ForegroundColor Red
        }
    }
    exit 0
}

# --- Setup mode ---
Write-Host ""
Write-Host "RAVEN Credential Setup (Windows DPAPI Encryption)" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Credentials are encrypted with DPAPI and bound to your Windows user"
Write-Host "account on this machine. They cannot be read by other users or copied"
Write-Host "to another machine."
Write-Host ""

# Load existing values for defaults
$existing = @{}
if (Test-Path $CredFile) {
    $storedJson = Get-Content $CredFile | ConvertFrom-Json
    foreach ($prop in $storedJson.PSObject.Properties) {
        try { $existing[$prop.Name] = Unprotect-String $prop.Value }
        catch { }
    }
    Write-Host "Existing encrypted credentials found - press Enter to keep each value." -ForegroundColor Yellow
    Write-Host ""
}

function Prompt-Value([string]$name, [string]$prompt, [bool]$isSensitive = $false) {
    $current = $existing[$name]
    $hint    = if ($current) { " [keep existing]" } else { "" }
    if ($isSensitive) {
        $sec  = Read-Host "${prompt}${hint}" -AsSecureString
        $plain = if ($sec.Length -gt 0) {
            $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
            try {
                [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
            }
            finally {
                [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            }
        } else { $current }
    } else {
        $plain = Read-Host "${prompt}${hint}"
        if ([string]::IsNullOrEmpty($plain)) { $plain = $current }
    }
    return $plain
}

$baseUrl  = Prompt-Value "ATLASSIAN_BASE_URL"  "Atlassian base URL (e.g. https://apps.example.gov.bc.ca)"
$email    = Prompt-Value "ATLASSIAN_EMAIL"      "IDIR email (e.g. Jane.Smith@gov.bc.ca)"
$password = Prompt-Value "ATLASSIAN_PASSWORD"   "IDIR password" -isSensitive $true
$srvPass  = Prompt-Value "SERVER_A_PASSWORD"    "_A account password (leave blank to skip)" -isSensitive $true

Write-Host ""
Write-Host "Azure DevOps Server (leave blank to skip)" -ForegroundColor Cyan
$adoBaseUrl       = Prompt-Value "ADO_BASE_URL"            "ADO base URL (e.g. https://ado.example.gov.bc.ca)"
$adoCollection    = Prompt-Value "ADO_DEFAULT_COLLECTION"  "ADO default collection (e.g. DefaultCollection)"
$adoPat           = Prompt-Value "ADO_PAT"                 "ADO Personal Access Token" -isSensitive $true
$adoProject       = Prompt-Value "ADO_DEFAULT_PROJECT"     "ADO default project name (leave blank to skip)"

Write-Host ""
Write-Host "Jarvis API (leave blank to skip)" -ForegroundColor Cyan
$jarvisToken      = Prompt-Value "JARVIS_TOKEN"            "Jarvis Authorization Token" -isSensitive $true

Write-Host ""
Write-Host "SonarQube (leave blank to skip)" -ForegroundColor Cyan
$sonarUrl   = Prompt-Value "SONARQUBE_URL"     "SonarQube base URL (e.g. https://sonar.example.gov.bc.ca)"
$sonarToken = Prompt-Value "SONARQUBE_TOKEN"   "SonarQube user token" -isSensitive $true
$sonarBin   = Prompt-Value "SONAR_SCANNER_BIN" "SonarQube scanner binary path (e.g. C:\sonar-scanner\bin\sonar-scanner.bat)"

Write-Host ""
Write-Host "RFC Buddy (leave blank to skip)" -ForegroundColor Cyan
$rfcbuddyUrl   = Prompt-Value "RFCBUDDY_URL"   "RFC Buddy base URL (e.g. https://rfcbuddy.example.com/api/v1/)"
$rfcbuddyPat   = Prompt-Value "RFCBUDDY_PAT"   "RFC Buddy Personal Access Token (PAT)" -isSensitive $true

Write-Host ""
Write-Host "Artifactory (leave blank to skip)" -ForegroundColor Cyan
$artifactoryUrl      = Prompt-Value "ARTIFACTORY_URL"      "Internal Artifactory HTTPS base URL"
$artifactoryEmail    = Prompt-Value "ARTIFACTORY_EMAIL"    "Artifactory IDIR email"
$artifactoryPassword = Prompt-Value "ARTIFACTORY_PASSWORD" "Artifactory IDIR password" -isSensitive $true

Write-Host ""
Write-Host "Jenkins (leave blank to skip; API token is recommended for writes)" -ForegroundColor Cyan
$jenkinsUrl      = Prompt-Value "JENKINS_URL"      "Jenkins HTTPS base URL (e.g. https://jenkins.example.gov.bc.ca/jenkins)"
$jenkinsUser     = Prompt-Value "JENKINS_USER"     "Jenkins username"
$jenkinsToken    = Prompt-Value "JENKINS_TOKEN"    "Jenkins API token" -isSensitive $true
$jenkinsPassword = Prompt-Value "JENKINS_PASSWORD" "Jenkins password (leave blank when using an API token)" -isSensitive $true

Write-Host ""

if (-not $baseUrl -or -not $email -or -not $password) {
    Write-Host "Error: ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD are required." -ForegroundColor Red
    exit 1
}

# Encrypt each value
$creds = [ordered]@{
    ATLASSIAN_BASE_URL = Protect-String $baseUrl
    ATLASSIAN_EMAIL    = Protect-String $email
    ATLASSIAN_PASSWORD = Protect-String $password
}
if ($srvPass)       { $creds["SERVER_A_PASSWORD"]      = Protect-String $srvPass }
if ($adoBaseUrl)    { $creds["ADO_BASE_URL"]           = Protect-String $adoBaseUrl }
if ($adoCollection) { $creds["ADO_DEFAULT_COLLECTION"] = Protect-String $adoCollection }
if ($adoPat)        { $creds["ADO_PAT"]                = Protect-String $adoPat }
if ($adoProject)    { $creds["ADO_DEFAULT_PROJECT"]    = Protect-String $adoProject }
if ($jarvisToken)   { $creds["JARVIS_TOKEN"]           = Protect-String $jarvisToken }
if ($sonarUrl)      { $creds["SONARQUBE_URL"]          = Protect-String $sonarUrl }
if ($sonarToken)    { $creds["SONARQUBE_TOKEN"]        = Protect-String $sonarToken }
if ($sonarBin)      { $creds["SONAR_SCANNER_BIN"]      = Protect-String $sonarBin }
if ($rfcbuddyUrl)   { $creds["RFCBUDDY_URL"]           = Protect-String $rfcbuddyUrl }
if ($rfcbuddyPat)   { $creds["RFCBUDDY_PAT"]           = Protect-String $rfcbuddyPat }
if ($artifactoryUrl)      { $creds["ARTIFACTORY_URL"]      = Protect-String $artifactoryUrl }
if ($artifactoryEmail)    { $creds["ARTIFACTORY_EMAIL"]    = Protect-String $artifactoryEmail }
if ($artifactoryPassword) { $creds["ARTIFACTORY_PASSWORD"] = Protect-String $artifactoryPassword }
if ($jenkinsUrl)      { $creds["JENKINS_URL"]      = Protect-String $jenkinsUrl }
if ($jenkinsUser)     { $creds["JENKINS_USER"]     = Protect-String $jenkinsUser }
if ($jenkinsToken)    { $creds["JENKINS_TOKEN"]    = Protect-String $jenkinsToken }
if ($jenkinsPassword) { $creds["JENKINS_PASSWORD"] = Protect-String $jenkinsPassword }

# Carry forward any extra keys that were already stored (e.g. IMIS_CSV_PATH)
foreach ($prop in $existing.GetEnumerator()) {
    if (-not $creds.Contains($prop.Key)) {
        $creds[$prop.Key] = Protect-String $prop.Value
    }
}

# Write to disk
if (-not (Test-Path $CredDir)) {
    New-Item -ItemType Directory -Path $CredDir -Force | Out-Null
}
$creds | ConvertTo-Json | Set-Content $CredFile -Encoding UTF8

# Restrict permissions: remove inherited ACEs, grant only the current user full control
# icacls is used instead of Set-Acl to avoid requiring SeSecurityPrivilege
$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $CredFile /inheritance:r /grant:r "*${currentUserSid}:(F)" | Out-Null

Write-Host "Credentials saved to: $CredFile" -ForegroundColor Green
Write-Host "The file is DPAPI-encrypted and restricted to your Windows account." -ForegroundColor Green
Write-Host ""
Write-Host "Run this script again with -Verify to confirm decryption works."
