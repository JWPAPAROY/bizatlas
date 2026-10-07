-- 투자 라운드를 회사에서 분리한다 (회사 1 : 라운드 N).
--
-- 배경: businesses 는 canonical_key 로 회사당 1행이라, 같은 회사의 두 번째 라운드 기사가 오면
-- ingest 가 23505(중복)로 반려하고 그 투자 정보도 함께 버렸다. 라운드 시계열(/trends·월간 보고)이
-- "그 회사가 처음 보도된 시점의 라운드"만 보고 있었던 것.
--
-- 기록은 record_funding_round() 하나로만 한다 — 회사 찾기·중복 판정·회사 카드 갱신 규칙이 한 곳에 있다.
-- 금액·단계 파싱은 여전히 _shared/funding.js (호출하는 쪽이 계산해서 넘긴다).

create table if not exists funding_rounds (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  stage text check (stage is null or stage in (
    'pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d_plus', 'growth',
    'accelerator', 'ipo', 'debt', 'grant', 'acquisition', 'other', 'undisclosed', 'unknown'
  )),
  usd_m numeric,
  raw text not null,                 -- 원문 투자 문구 (traction.funding)
  source_name text,
  source_url text,
  source_item_id text unique,        -- 기사 단위. 같은 기사를 두 번 넣지 않는다
  reported_at timestamptz not null,  -- 보도(수집) 시각 — 라운드 시계열의 시간축
  created_at timestamptz not null default now()
);

create index if not exists funding_rounds_business_idx on funding_rounds (business_id);
create index if not exists funding_rounds_reported_idx on funding_rounds (reported_at);

alter table funding_rounds enable row level security;
drop policy if exists funding_rounds_read on funding_rounds;
create policy funding_rounds_read on funding_rounds for select to anon, authenticated
  using (exists (select 1 from businesses b where b.id = business_id and b.status = 'published'));

-- 반환: 'inserted' | 'duplicate' | 'no_business' | 'no_funding'
create or replace function record_funding_round(
  p_raw text,
  p_stage text,
  p_usd_m numeric,
  p_source_name text,
  p_source_url text,
  p_source_item_id text,
  p_reported_at timestamptz default now(),
  p_business_id uuid default null,
  p_name text default null
) returns text
language plpgsql
as $$
declare
  v_biz uuid := p_business_id;
  v_latest timestamptz;
begin
  if p_raw is null or btrim(p_raw) = '' then return 'no_funding'; end if;

  if v_biz is null and p_name is not null then
    select id into v_biz from businesses where canonical_key = canonical_name(p_name);
  end if;
  if v_biz is null then return 'no_business'; end if;

  -- 같은 라운드를 여러 매체가 보도한다: 같은 단계 + 금액 15% 이내(한쪽이 미상이면 통과) + 120일 이내면 중복.
  -- 단계를 모르면(unknown·undisclosed·null) 금액만으로 본다.
  if exists (
    select 1 from funding_rounds r
    where r.business_id = v_biz
      and abs(extract(epoch from (r.reported_at - p_reported_at))) < 120 * 86400
      and (
        r.stage is not distinct from p_stage
        or coalesce(r.stage, 'unknown') in ('unknown', 'undisclosed')
        or coalesce(p_stage, 'unknown') in ('unknown', 'undisclosed')
      )
      and (r.usd_m is null or p_usd_m is null
           or abs(r.usd_m - p_usd_m) <= 0.15 * greatest(r.usd_m, p_usd_m))
  ) then
    return 'duplicate';
  end if;

  insert into funding_rounds (business_id, stage, usd_m, raw, source_name, source_url, source_item_id, reported_at)
  values (v_biz, p_stage, p_usd_m, p_raw, p_source_name, p_source_url, p_source_item_id, p_reported_at)
  on conflict (source_item_id) do nothing;
  if not found then return 'duplicate'; end if;

  -- 회사 카드는 "가장 최근 라운드"를 보여준다
  select max(reported_at) into v_latest from funding_rounds where business_id = v_biz;
  if p_reported_at >= v_latest then
    update businesses set
      funding_usd_m = p_usd_m,
      funding_stage = p_stage,
      traction = jsonb_set(coalesce(traction, '{}'::jsonb), '{funding}', to_jsonb(p_raw))
    where id = v_biz;
  end if;
  return 'inserted';
end;
$$;

-- 쓰기 함수다 — anon 이 rpc 로 부르지 못하게. ingest 는 service_role 로 호출한다.
revoke execute on function record_funding_round(text, text, numeric, text, text, text, timestamptz, uuid, text)
  from public, anon, authenticated;

-- 기존 데이터 이관: 회사당 1라운드(처음 보도된 기사)
insert into funding_rounds (business_id, stage, usd_m, raw, source_name, source_url, source_item_id, reported_at)
select id, funding_stage, funding_usd_m, traction->>'funding', source_name, source_url, source_item_id, created_at
from businesses
where coalesce(btrim(traction->>'funding'), '') <> ''
on conflict (source_item_id) do nothing;
