# Builds the signed release APK. Prompts for the signing passwords; nothing is saved.
$ErrorActionPreference = 'Stop'
function Read-Secret($prompt) {
  $s = Read-Host $prompt -AsSecureString
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
$env:AFKDESK_ANDROID_KEYSTORE = "$env:USERPROFILE\.afk-desk-signing\afk-desk-release.keystore"
$env:AFKDESK_ANDROID_STORE_PASSWORD = Read-Secret 'Keystore password'
$alias = Read-Host 'Key alias (press Enter to list the aliases in the keystore)'
if (-not $alias) {
  keytool -list -keystore $env:AFKDESK_ANDROID_KEYSTORE -storepass $env:AFKDESK_ANDROID_STORE_PASSWORD | Select-String 'PrivateKeyEntry'
  $alias = Read-Host 'Key alias'
}
$env:AFKDESK_ANDROID_KEY_ALIAS = $alias
$keyPass = Read-Secret 'Key password (press Enter if same as keystore password)'
$env:AFKDESK_ANDROID_KEY_PASSWORD = if ($keyPass) { $keyPass } else { $env:AFKDESK_ANDROID_STORE_PASSWORD }
try {
  Push-Location "$PSScriptRoot\android"
  .\gradlew.bat assembleRelease
  $apk = "$PSScriptRoot\android\app\build\outputs\apk\release\app-release.apk"
  Copy-Item $apk "$PSScriptRoot\AFK-Desk-Android-0.11.0-beta.1.apk" -Force
  Write-Host "`nDone: $PSScriptRoot\AFK-Desk-Android-0.11.0-beta.1.apk" -ForegroundColor Green
} finally {
  Pop-Location
  'AFKDESK_ANDROID_STORE_PASSWORD','AFKDESK_ANDROID_KEY_PASSWORD' | % { Remove-Item "env:$_" -ErrorAction SilentlyContinue }
}
