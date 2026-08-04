-- 등급 분리 · 검증 근거 · 엔티티 중복 제거
--
-- 배경: 자동 수집만으로는 신생 스타트업(대부분 미검증)만 쌓인다. 아직 작동하는지 아무도 모르는
-- 회사에 대해 AI 가 "작동하는 구조적 이유"를 쓰는 건 분석이 아니라 추측이다.
-- 그래서 공개 데이터로 검증된 모델(proven)과 최신 동향(emerging)을 등급으로 나눈다.

alter table businesses
  add column if not exists tier text not null default 'emerging'
    check (tier in ('proven', 'emerging')),
  -- 왜 proven 인지의 근거. 화면에 그대로 노출해 신뢰를 확보한다.
  -- { source: 'wikidata', entity: 'Q715583', inception: '1983-01-01', age_years: 43,
  --   revenue: 275235000000, revenue_year: 2025, employees: 254000, sitelinks: 44, gates: [...] }
  add column if not exists evidence jsonb not null default '{}'::jsonb;

-- 같은 회사가 여러 소스에서 들어오면 중복 행이 생긴다(source_item_id 는 소스 내에서만 유일).
-- 회사명을 정규화한 키로 실체 단위 중복을 막는다.
create or replace function canonical_name(txt text) returns text
  language sql immutable strict parallel safe
  as $$
    select regexp_replace(
      lower(trim(txt)),
      -- 법인격 접미사와 공백·기호 제거: "Acme, Inc." 와 "acme" 를 같게 본다
      '\s*(,)?\s*(inc|inc\.|llc|ltd|ltd\.|corp|corp\.|corporation|co|co\.|gmbh|s\.a\.|plc|주식회사|㈜)\s*$|[^a-z0-9가-힣]',
      '', 'g'
    )
  $$;

alter table businesses
  add column if not exists canonical_key text
  generated always as (canonical_name(name)) stored;

-- 기존 중복 정리: 같은 canonical_key 는 가장 먼저 들어온 것만 남긴다.
delete from businesses a
  using businesses b
  where a.canonical_key = b.canonical_key
    and a.created_at > b.created_at;

create unique index if not exists businesses_canonical_key_idx on businesses (canonical_key);
create index if not exists businesses_tier_idx on businesses (tier);

-- proven 은 검증 코퍼스라 별도 파이프라인이 채운다. seen_items 는 소스 기반 수집 전용이므로
-- proven 항목은 source_item_id 를 'seed:<canonical>' 형태로 둔다.
