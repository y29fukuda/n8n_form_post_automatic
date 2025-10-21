Param(
  [Parameter(Mandatory=$true)][string]$UrlBase,
  [string]$Phone='0677122972',
  [string]$Comment='営業電話',
  [string]$Callform='営業電話',
  [int]$Rating=1
)

$postUrl = "$UrlBase/post"

Write-Host "== GET /healthz =="
try {
  $h = Invoke-RestMethod -Uri "$UrlBase/healthz" -Method GET
  $h | ConvertTo-Json -Compress | Write-Host
} catch { Write-Host $_; }

Write-Host "`n== POST /post via QUERY (should succeed even if body parser fails) =="
$qs = "phone=$Phone&comment=$([uri]::EscapeDataString($Comment))&callform=$([uri]::EscapeDataString($Callform))&rating=$Rating"
try {
  $r1 = Invoke-RestMethod -Uri "$postUrl`?$qs" -Method POST
  $r1 | ConvertTo-Json -Compress | Write-Host
} catch { Write-Host $_; }

Write-Host "`n== POST /post via JSON body =="
$body = @{
  phone    = $Phone
  comment  = $Comment
  callform = $Callform
  rating   = $Rating
} | ConvertTo-Json -Compress
try {
  $r2 = Invoke-RestMethod -Uri $postUrl -Method POST -ContentType 'application/json' -Body $body
  $r2 | ConvertTo-Json -Compress | Write-Host
} catch { Write-Host $_; }

Write-Host "`nDone."
