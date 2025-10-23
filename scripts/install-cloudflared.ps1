# cloudflared をインストールし、PATH を通して、動作確認するスクリプト（Windows）
# PowerShell を「管理者として実行」で実行してください。

Write-Host "Installing cloudflared via winget..."
winget install -e --id Cloudflare.cloudflared -h

$paths = @(
  "C:\Program Files\cloudflared\cloudflared.exe",
  "C:\Program Files\Cloudflare\cloudflared\cloudflared.exe",
  "$env:LOCALAPPDATA\Cloudflare\cloudflared\cloudflared.exe"
)
$cloud = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cloud) { Write-Error "cloudflared.exe not found after install."; exit 1 }

$dir = Split-Path $cloud -Parent
if (-not ($env:Path -split ";" | Where-Object { $_ -eq $dir })) {
  [Environment]::SetEnvironmentVariable("Path", $env:Path + ";" + $dir, "User")
  $env:Path += ";" + $dir
}
Write-Host "cloudflared: $cloud"
cloudflared --version
