# stay_awake.ps1
# 必ず「管理者として PowerShell を実行」してからこのスクリプトを実行してください。
# ノートPCでもデスクトップでも、スリープしない設定を強制します。

Write-Host 'Windows のスリープ・ハイバネート無効化、フタを閉じてもスリープさせない設定を適用します...' -ForegroundColor Cyan

# AC電源接続時のスリープタイムアウトを無効化
powercfg /change standby-timeout-ac 0 | Out-Null

# ハイバネートを無効化
powercfg /hibernate off | Out-Null

# ノートPCのフタを閉じたときの動作（AC接続時）を「何もしない」に設定
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null

# 設定を適用
powercfg /S SCHEME_CURRENT | Out-Null

Write-Host ''
Write-Host '設定が完了しました。このPCはスリープしない設定になっています。' -ForegroundColor Green
Write-Host '画面をOFFにすることは問題ありませんが、PCの電源は切らないでください。'
Write-Host 'ノートPCの場合、フタを閉じてもスリープしないはずです。'
Write-Host ''
Write-Host '※ もし意図せずスリープする場合は、Windowsの電源設定を再確認してください。'

