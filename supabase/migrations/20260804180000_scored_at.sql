-- 재평가 진행 상태 기록.
-- 척도 앵커를 바꾸면 기존 데이터를 다시 매겨야 하는데, 쿼터 때문에 한 번에 못 끝난다.
-- 어디까지 했는지 남겨야 이어서 돌릴 수 있다 (없으면 매번 처음부터 다시 태운다).
alter table businesses add column if not exists scored_at timestamptz;
create index if not exists businesses_scored_at_idx on businesses (scored_at nulls first);
