# BizAtlas 일일 유지보수 — 쿼터가 리셋될 때마다 백로그를 조금씩 갉아먹는다.
#
# 왜 필요한가: Gemini 무료 티어는 모델당 하루 20회(체인 5개 ≈ 100회)라, 재평가·판단 층
# 생성을 한 번에 끝낼 수 없다. 두 스크립트 모두 scored_at·decided_at 으로 진행 상태를
# 남겨 이어서 실행되므로, 매일 한 번 돌리면 백로그가 자동으로 소진된다.
#
# 실행 시각은 17:30 KST — Gemini 일일 쿼터는 태평양 자정(= KST 16~17시)에 리셋된다.
#
# 등록:  .\scripts\maintain.ps1 -Register
# 수동:  .\scripts\maintain.ps1
#
# 시크릿은 파일에 안 둔다. Supabase PAT 으로 service_role 키를 그때그때 받아 쓴다.

param([switch]$Register)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$taskName = 'BizAtlas-Maintain'

if ($Register) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\maintain.ps1`"" `
    -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -Daily -At '17:30'
  # 노트북이 꺼져 있어 놓친 실행은 다음 부팅 때 따라잡는다.
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'BizAtlas 재평가·판단 층 백로그 처리 (Gemini 쿼터 리셋 직후)' -Force | Out-Null
  Write-Host "예약 작업 '$taskName' 등록됨 — 매일 17:30" -ForegroundColor Green
  Write-Host "해제: Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
  exit 0
}

Set-Location $root

$secretsFile = 'C:\Users\knoww\.secrets\supabase-pat.txt'
$secrets = @{}
Get-Content $secretsFile | Where-Object { $_ -match '=' } | ForEach-Object {
  $i = $_.IndexOf('=')
  $secrets[$_.Substring(0, $i).Trim()] = $_.Substring($i + 1).Trim()
}

$pat = $secrets['SUPABASE_PAT']
$projectRef = 'skalhldjvspoaacdxgjg'

# service_role 키는 디스크에 두지 않고 매 실행 Management API 로 받는다.
$keys = Invoke-RestMethod -Method Get -Headers @{ Authorization = "Bearer $pat" } `
  -Uri "https://api.supabase.com/v1/projects/$projectRef/api-keys?reveal=true"
$serviceKey = ($keys | Where-Object { $_.name -eq 'service_role' }).api_key
if (-not $serviceKey) { throw 'service_role 키를 가져오지 못했습니다.' }

$env:GEMINI_API_KEY = $secrets['BIZATLAS_GEMINI_KEY']
$env:SUPABASE_URL = "https://$projectRef.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = $serviceKey

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'

# 순서가 중요하다. 점수 세 축은 이 서비스의 존재 이유(필터·비교)라 판단 층보다 먼저 채운다.
Write-Host "== [$stamp] 재평가 ==" -ForegroundColor Cyan
node scripts/rescore.mjs 120

Write-Host "== [$stamp] 판단 층 ==" -ForegroundColor Cyan
node scripts/enrich-decision.mjs 120

# 승격은 AI 를 쓰지 않으므로 쿼터와 무관하게 항상 돈다.
# 새로 들어온 emerging 중 실체가 확인되는 회사를 proven 으로 올린다.
Write-Host "== [$stamp] 승격 검사 ==" -ForegroundColor Cyan
$promote = Invoke-RestMethod -Method Post -Uri "$env:SUPABASE_URL/functions/v1/seed-proven" `
  -Headers @{ 'x-ingest-secret' = $secrets['BIZATLAS_INGEST_SECRET']; 'Content-Type' = 'application/json' } `
  -Body '{"mode":"promote","limit":80}'
Write-Host "  검사 $($promote.scanned)건 · 승격 $($promote.promoted.Count)건"
$promote.promoted | ForEach-Object { Write-Host "    $_" }

Write-Host "완료" -ForegroundColor Green
