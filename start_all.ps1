# start_all.ps1
# Launch server.js and cloudflared in separate PowerShell windows.
# If the script is blocked by execution policy, run once in an elevated PowerShell:
#   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

$directories = @(
    'C:\opt\telnavi-n8n',
    'C:\opt\telnavi-n8n\logs',
    'C:\opt\cloudflared',
    'C:\opt\cloudflared\logs'
)
foreach ($dir in $directories) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}

$serverCommand = @"
Set-Location 'C:\opt\telnavi-n8n'
Write-Host '=== server.js start ==='
Write-Host (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
node server.js | Tee-Object -FilePath 'C:\opt\telnavi-n8n\logs\server.log'
"@
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit', '-Command', $serverCommand

$cloudflaredCommand = @"
Set-Location 'C:\opt\telnavi-n8n'
Write-Host '=== cloudflared Quick Tunnel start ==='
Write-Host (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
& 'C:\opt\cloudflared\cloudflared.exe' tunnel --url http://localhost:3000 --protocol http2 --no-autoupdate | Tee-Object -FilePath 'C:\opt\cloudflared\logs\cloudflared.log'
"@
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit', '-Command', $cloudflaredCommand

Write-Host ''
Write-Host '=============================================='
Write-Host ' TelNavi automation startup checklist'
Write-Host '=============================================='
Write-Host '1. Copy the https://xxxxx.trycloudflare.com URL shown in the cloudflared window.'
Write-Host '2. Append /post to the URL (example: https://xxxxx.trycloudflare.com/post) and paste it into the n8n HTTP Request node.'
Write-Host '3. Confirm the server.js window prints "listening on 3000".'
Write-Host '4. Please keep this PC awake (run stay_awake.ps1 once, disable sleep).'
Write-Host ''
Write-Host 'If execution policy blocks the script: open PowerShell as Administrator and run'
Write-Host '  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser'
Write-Host ''
Write-Host 'You may close this window, but keep the server.js and cloudflared windows running.'

