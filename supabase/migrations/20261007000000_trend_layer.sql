-- 트렌드 층 — 900건 넘게 쌓인 수집분을 "투자 흐름 관측"에 쓸 수 있게 만드는 정합성 작업.
--
-- 1) 투자 라운드 구조화: traction.funding 은 "$50M 시리즈 C (…)" 같은 자유 텍스트라 집계가 안 된다.
--    금액(USD 환산)과 단계를 컬럼으로 뽑는다. 계산은 _shared/funding.js (정규식, AI 미사용).
-- 2) 승격 검사 이력: promote 모드가 created_at 오름차순 상위 N건만 매번 다시 훑어서,
--    그 뒤에 들어온 행(Alibaba·Tesla·ByteDance 등)은 한 번도 검사받지 못하고 emerging 에 남았다.
-- 3) 태그 별칭: 표기 변종(공백·영한)을 대표 표기로 합친다. _shared/tags.js 참조.

alter table businesses
  add column if not exists funding_usd_m numeric,
  add column if not exists funding_stage text,
  add column if not exists promote_checked_at timestamptz;

alter table businesses drop constraint if exists businesses_funding_stage_check;
alter table businesses add constraint businesses_funding_stage_check check (
  funding_stage is null or funding_stage in (
    'pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d_plus', 'growth',
    'accelerator', 'ipo', 'debt', 'grant', 'acquisition', 'other', 'undisclosed', 'unknown'
  )
);

create index if not exists businesses_funding_stage_idx on businesses (funding_stage);
create index if not exists businesses_promote_checked_idx on businesses (tier, promote_checked_at nulls first);

create table if not exists tag_aliases (
  key text primary key,          -- _shared/tags.js tagKey() 결과
  canonical text not null,       -- 화면·저장에 쓰는 대표 표기
  updated_at timestamptz not null default now()
);

alter table tag_aliases enable row level security;
drop policy if exists tag_aliases_read on tag_aliases;
create policy tag_aliases_read on tag_aliases for select to anon, authenticated using (true);
