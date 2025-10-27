# start_all.ps1
# このスクリプトはダブルクリックで実行すると、server.js と cloudflared の2つの PowerShell ウィンドウを立ち上げます。
# 実行前に PowerShell の実行ポリシーを変更していない場合は、管理者で PowerShell を開き、
#   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
# を一度実行してください。

# 必要なフォルダを作成（既に存在していてもエラーになりません）
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

# server.js 用の PowerShell ウィンドウを起動
$serverCommand = @"
Set-Location 'C:\opt\telnavi-n8n'
Write-Host '=== server.js 起動 ==='
Write-Host (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
node server.js | Tee-Object -FilePath 'C:\opt\telnavi-n8n\logs\server.log'
"@
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit', '-Command', $serverCommand

# cloudflared 用の PowerShell ウィンドウを起動
$cloudflaredCommand = @"
Set-Location 'C:\opt\telnavi-n8n'
Write-Host '=== cloudflared Quick Tunnel 起動 ==='
Write-Host (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
& 'C:\opt\cloudflared\cloudflared.exe' tunnel --url http://localhost:3000 --protocol http2 --no-autoupdate | Tee-Object -FilePath 'C:\opt\cloudflared\logs\cloudflared.log'
"@
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit', '-Command', $cloudflaredCommand

# 実行方法の案内を表示
Write-Host ''
Write-Host '=============================================='
Write-Host '  TelNavi 自動投稿 サービス起動シナリオ'
Write-Host '=============================================='
Write-Host '1. 新しく開いた cloudflared のウィンドウに「https://xxxxx.trycloudflare.com」のようなURLが表示されます。'
Write-Host '2. そのURLの末尾に「/post」を付けて（例: https://xxxxx.trycloudflared.com/post）、n8n の HTTP Request ノードの URL 欄に貼り付けてください。'
Write-Host '3. server.js のウィンドウでは "listening on 3000" などのログが確認できます。'
Write-Host '4. Windows をスリープさせないでください。stay_awake.ps1 を一度実行済みであればスリープしません。'
Write-Host ''
Write-Host '※ もしスクリプトが実行ポリシーで停止する場合は、PowerShell を管理者で開いて'
Write-Host '   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser'
Write-Host '  を一度だけ実行してください。'
Write-Host ''
Write-Host 'このウィンドウは閉じても構いませんが、server.js と cloudflared のウィンドウは閉じないでください。'

