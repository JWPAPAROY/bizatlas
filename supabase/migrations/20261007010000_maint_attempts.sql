-- maintain 재시도 순환.
-- 재평가·판단 층 대상은 "scored_at/decided_at 이 빈 행을 created_at 오름차순"으로 뽑는데, 실패해도
-- 아무 표시가 남지 않아 **같은 맨 앞 행들이 매일 다시 뽑혀 다시 실패**했다 (2026-09-18 ~ 10-07, 270건 적체).
-- 실패할 때마다 올리고, 적게 실패한 행부터 뽑는다 → 문제 있는 행이 줄을 막지 않는다.
alter table businesses add column if not exists maint_attempts int not null default 0;
