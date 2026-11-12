-- 수집 cron 을 정각(:00)에서 7분 뒤로 옮긴다.
--
-- 왜: 00:00 UTC(09:00 KST) 정각 실행이 2026-11-10·11-12 두 번 부팅 후 ~12초에 503 으로 잘렸다.
-- shutdown 이벤트 없이 끊겼고(코드 오류·메모리 초과 아님) 그 시각엔 부팅·REST 응답이 전반적으로
-- 느렸다 → 전 세계 일일 cron 이 몰리는 정각의 플랫폼 혼잡으로 판단. 30일간 다른 시각은 0건.
--
-- cron 명령(URL·시크릿 헤더)은 건드리지 않고 일정만 바꾼다 — 시크릿을 repo 에 남기지 않기 위해.
-- 같이 바꿀 곳: src/lib/today.js(RUN_MINUTE), .github/workflows/health.yml, README.md.
select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'bizatlas-ingest'),
  schedule := '7 */4 * * *'
);
