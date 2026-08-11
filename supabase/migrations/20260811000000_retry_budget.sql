-- 재시도 예산 — AI 쿼터가 새는 구멍을 막는다.
--
-- 배경: JSON 파싱 실패는 "모델이 잘못 뱉은 것이지 항목의 문제가 아니다"라는 판단으로
-- seen_items 에 기록하지 않고 다음 실행에 넘겼다. 그런데 재시도 횟수 상한이 없어서,
-- 구조적으로 파싱이 안 되는 항목(본문이 길어 응답이 잘리는 TechCrunch 기사 등)이
-- 매 실행마다 영구히 재시도됐다. 실측: 하루 6회 실행 × 2~3건 = 12~18회.
-- 하루 총 AI 예산이 120건 남짓이므로 10~15% 가 여기서 증발하고,
-- 라운드로빈 큐 앞자리를 차지해 새 글이 처리될 자리까지 밀어냈다.
--
-- 해법: 실패도 seen_items 에 남기되 verdict='retry' 로 두어 다음 실행 대상에는 남기고,
-- attempts 가 상한에 닿으면 'rejected' 로 확정해 큐에서 영구히 뺀다.

alter table seen_items
  add column if not exists attempts int not null default 0;

-- 'retry' = 다시 시도할 여지가 있는 실패. 상한에 닿으면 함수가 'rejected' 로 바꾼다.
alter table seen_items drop constraint if exists seen_items_verdict_check;
alter table seen_items add constraint seen_items_verdict_check
  check (verdict in ('accepted', 'rejected', 'error', 'retry'));

-- 재시도 대기열 조회용 (verdict 로 거르는 쿼리가 매 실행 돈다)
create index if not exists seen_items_verdict_idx on seen_items (verdict);
