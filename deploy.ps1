# BizAtlas 배포 — 빌드 후 gh-pages 브랜치로 푸시한다.
#
# GitHub Actions 를 쓰지 않는 이유: gh 토큰에 workflow 스코프가 없어 워크플로 파일을
# 푸시할 수 없다. `gh auth refresh -h github.com -s workflow` 를 한 번 실행하면
# .gitignore 에서 .github/workflows/ 를 지우고 push-to-deploy 로 전환할 수 있다.
#
# 이 repo 는 자격증명이 로컬 설정으로 JWPAPAROY 에 고정돼 있다(다른 프로젝트는 knwwhr).
# 사용법:  .\deploy.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host '== 빌드 ==' -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw '빌드 실패' }

$wt = Join-Path $env:TEMP 'bizatlas-ghpages'

Write-Host '== gh-pages 워크트리 준비 ==' -ForegroundColor Cyan
if (Test-Path $wt) {
  git worktree remove $wt --force
}
# 원격 gh-pages 를 그대로 받아 그 위에 덮어쓴다 (히스토리 유지)
git fetch origin gh-pages --quiet
git worktree add $wt gh-pages --quiet

Write-Host '== 산출물 복사 ==' -ForegroundColor Cyan
Get-ChildItem $wt -Force |
  Where-Object { $_.Name -ne '.git' } |
  Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'dist\*') -Destination $wt -Recurse
# Jekyll 이 _ 로 시작하는 경로를 무시하지 않도록
New-Item -ItemType File -Path (Join-Path $wt '.nojekyll') -Force | Out-Null

Write-Host '== 푸시 ==' -ForegroundColor Cyan
Push-Location $wt
git add -A
if ((git status --porcelain).Length -eq 0) {
  Write-Host '변경 없음 — 배포 생략' -ForegroundColor Yellow
} else {
  git commit -q -m "Deploy: $(Get-Date -Format 'yyyy-MM-dd HH:mm') KST"
  git push origin gh-pages
  Write-Host 'https://jwpaparoy.github.io/bizatlas/ 배포 완료' -ForegroundColor Green
}
Pop-Location
git worktree remove $wt --force
