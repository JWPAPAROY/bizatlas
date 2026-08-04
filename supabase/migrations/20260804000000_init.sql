-- BizAtlas 초기 스키마
-- 핵심 설계: 수집(누구나 함)이 아니라 "비교 가능한 축으로의 구조화"가 차별점이다.
-- 그래서 자유 텍스트가 아니라 통제 어휘(taxonomy)로 태깅하고, 그 축으로 필터·비교한다.

-- ────────────────────────────────────────────────────────────
-- 1. 통제 어휘 — 코드 재배포 없이 축을 늘릴 수 있게 테이블로 둔다.
--    ingest 함수는 이 테이블을 읽어 AI 출력값을 화이트리스트 필터링한다.
-- ────────────────────────────────────────────────────────────
create table if not exists taxonomy (
  kind        text not null,   -- 'category' | 'revenue_model' | 'moat' | 'customer_type' | 'region'
  value       text not null,   -- 저장되는 슬러그 (영문 snake_case)
  label_ko    text not null,
  description text,
  sort_order  int not null default 100,
  primary key (kind, value)
);

-- ────────────────────────────────────────────────────────────
-- 2. 수집 소스 — 코드 수정 없이 켜고 끄고 추가한다.
-- ────────────────────────────────────────────────────────────
create table if not exists sources (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  kind         text not null check (kind in ('yc_api', 'atom', 'rss', 'hn_algolia')),
  url          text not null,
  enabled      boolean not null default true,
  max_items    int not null default 15,   -- 1회 실행당 처리 상한 (AI 비용 유계)
  last_run_at  timestamptz,
  last_status  text,
  notes        text,
  created_at   timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────
-- 3. 본체
-- ────────────────────────────────────────────────────────────
create table if not exists businesses (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,

  -- 정체
  name           text not null,
  one_liner      text not null,               -- 한 줄 요약 (한국어)
  description    text,                        -- 3~5문장 (한국어)
  website        text,
  hq_country     text,                        -- ISO 국가명 (영문)
  region         text,                        -- taxonomy:region
  founded_year   int check (founded_year between 1800 and 2100),

  -- 구조화 축 — 여기가 이 서비스의 존재 이유
  category       text,                        -- taxonomy:category
  customer_type  text,                        -- taxonomy:customer_type
  revenue_models text[] not null default '{}', -- taxonomy:revenue_model (복수)
  moats          text[] not null default '{}', -- taxonomy:moat (복수)
  pricing_note   text,                        -- 실제 과금 방식 한 줄

  -- 1~5 척도. 낮을수록 쉬움/적음.
  capital_intensity smallint check (capital_intensity between 1 and 5), -- 초기 자본 부담
  replicability     smallint check (replicability between 1 and 5),     -- 5 = 따라하기 매우 쉬움
  korea_fit         smallint check (korea_fit between 1 and 5),         -- 5 = 한국 시장 적용성 높음
  korea_note        text,                                              -- 왜 그 점수인지 한 줄

  -- 서술
  why_it_works   text,                        -- 이 모델이 작동하는 이유 (핵심 인사이트)
  risks          text[] not null default '{}',
  tags           text[] not null default '{}',
  traction       jsonb not null default '{}'::jsonb, -- {revenue, users, funding, valuation} 알려진 것만

  -- 출처 · 파이프라인 메타
  source_id      uuid references sources(id) on delete set null,
  source_name    text,
  source_url     text,
  source_item_id text not null,               -- 소스 내 고유 ID — 중복 수집 방지 키
  ai_model       text,
  ai_confidence  numeric(3,2) check (ai_confidence between 0 and 1),

  status         text not null default 'published' check (status in ('draft', 'published', 'rejected')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (source_item_id)
);

-- 검색: 한국어·영문 혼재라 형태소 분석 대신 'simple' 사전으로 토큰 매칭.
--
-- generated column 표현식은 immutable 만 허용된다. 두 군데가 걸린다:
--   1) to_tsvector 는 반드시 'simple'::regconfig 로 캐스팅 (안 하면 1인자 stable 버전으로 해석)
--   2) array_to_string 은 anyarray 라 stable(provolatile='s') 로 등록돼 있어 그대로 못 쓴다.
--      text[] 로 한정하면 실제로는 불변이므로 immutable 래퍼로 감싼다.
create or replace function text_array_to_string(text[]) returns text
  language sql immutable strict parallel safe
  as $$ select array_to_string($1, ' ') $$;

alter table businesses
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(name, '') || ' ' ||
      coalesce(one_liner, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(why_it_works, '') || ' ' ||
      coalesce(text_array_to_string(tags), '')
    )
  ) stored;

create index if not exists businesses_search_idx    on businesses using gin (search_tsv);
create index if not exists businesses_tags_idx      on businesses using gin (tags);
create index if not exists businesses_revenue_idx   on businesses using gin (revenue_models);
create index if not exists businesses_moats_idx     on businesses using gin (moats);
create index if not exists businesses_category_idx  on businesses (category);
create index if not exists businesses_created_idx   on businesses (created_at desc);
create index if not exists businesses_korea_fit_idx on businesses (korea_fit desc nulls last);

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists businesses_updated_at on businesses;
create trigger businesses_updated_at before update on businesses
  for each row execute function set_updated_at();

-- ────────────────────────────────────────────────────────────
-- 4. 수집 이력 — "마지막 업데이트 언제?"를 공개 표시하기 위해 읽기 허용.
-- ────────────────────────────────────────────────────────────
create table if not exists ingest_runs (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  fetched     int not null default 0,
  created     int not null default 0,
  skipped     int not null default 0,
  failed      int not null default 0,
  detail      jsonb not null default '{}'::jsonb
);

create index if not exists ingest_runs_started_idx on ingest_runs (started_at desc);

-- 판정 이력 — 한 번 본 항목은 다시 AI 에 태우지 않는다 (재실행마다 같은 피드가 오므로 비용이 폭증).
-- 채택 안 된 것도 남겨야 의미가 있으므로 businesses 와 별도 테이블로 둔다.
create table if not exists seen_items (
  source_item_id text primary key,
  source_id      uuid references sources(id) on delete cascade,
  url            text,
  verdict        text not null check (verdict in ('accepted', 'rejected', 'error')),
  reason         text,
  seen_at        timestamptz not null default now()
);

create index if not exists seen_items_seen_idx on seen_items (seen_at desc);

-- ────────────────────────────────────────────────────────────
-- 5. RLS — 공개 서비스지만 클라이언트는 읽기 전용.
--    쓰기는 ingest 엣지 함수(service_role)만. service_role 은 RLS 를 우회하므로 정책 불필요.
-- ────────────────────────────────────────────────────────────
alter table businesses  enable row level security;
alter table taxonomy    enable row level security;
alter table sources     enable row level security;
alter table ingest_runs enable row level security;
alter table seen_items  enable row level security;
-- seen_items 는 공개 정책을 주지 않는다 → anon 접근 전면 차단(파이프라인 내부 정보).

drop policy if exists "public reads published businesses" on businesses;
create policy "public reads published businesses" on businesses
  for select to anon, authenticated using (status = 'published');

drop policy if exists "public reads taxonomy" on taxonomy;
create policy "public reads taxonomy" on taxonomy
  for select to anon, authenticated using (true);

-- 소스는 출처 투명성 차원에서 목록만 공개 (url 포함, 비밀 없음)
drop policy if exists "public reads sources" on sources;
create policy "public reads sources" on sources
  for select to anon, authenticated using (enabled);

drop policy if exists "public reads ingest runs" on ingest_runs;
create policy "public reads ingest runs" on ingest_runs
  for select to anon, authenticated using (true);

-- ────────────────────────────────────────────────────────────
-- 6. 통제 어휘 시드
-- ────────────────────────────────────────────────────────────
insert into taxonomy (kind, value, label_ko, description, sort_order) values
  ('revenue_model', 'subscription',    '구독',          '정기 결제로 지속 접근권 판매', 10),
  ('revenue_model', 'usage_based',     '사용량 과금',    '쓴 만큼 청구 (API·크레딧)', 20),
  ('revenue_model', 'transaction_fee', '거래 수수료',    '중개 거래액의 일정 비율', 30),
  ('revenue_model', 'marketplace',     '마켓플레이스',   '양면 시장 매칭 후 수수료', 40),
  ('revenue_model', 'advertising',     '광고',          '트래픽·주목을 광고주에 판매', 50),
  ('revenue_model', 'freemium',        '프리미엄',       '무료 저변 위에 유료 전환', 60),
  ('revenue_model', 'one_time',        '단건 판매',      '제품·라이선스 1회 판매', 70),
  ('revenue_model', 'hardware',        '하드웨어',       '물리 제품 마진', 80),
  ('revenue_model', 'services',        '용역·컨설팅',    '사람 시간 기반 매출', 90),
  ('revenue_model', 'licensing',       '라이선싱',       'IP·기술 사용권 판매', 100),
  ('revenue_model', 'affiliate',       '제휴 수수료',    '외부 전환에 대한 커미션', 110),
  ('revenue_model', 'data',            '데이터 판매',    '집계 데이터·인사이트 판매', 120),
  ('revenue_model', 'take_rate',       '정산 스프레드',  '결제·정산 과정의 마진', 130)
on conflict (kind, value) do update set label_ko = excluded.label_ko, description = excluded.description;

insert into taxonomy (kind, value, label_ko, description, sort_order) values
  ('moat', 'network_effects',    '네트워크 효과',  '사용자가 늘수록 가치가 커짐', 10),
  ('moat', 'data',               '데이터 우위',    '축적 데이터가 제품을 개선', 20),
  ('moat', 'switching_costs',    '전환 비용',      '이탈 시 손실이 커 락인', 30),
  ('moat', 'brand',              '브랜드',        '인지도·신뢰가 선택을 좌우', 40),
  ('moat', 'scale',              '규모의 경제',    '규모가 단가를 낮춤', 50),
  ('moat', 'regulatory',         '규제·라이선스',  '진입에 인허가가 필요', 60),
  ('moat', 'ip',                 '특허·기술',      '독점 기술이나 IP 보유', 70),
  ('moat', 'community',          '커뮤니티',       '사용자 커뮤니티가 방어막', 80),
  ('moat', 'supply_exclusivity', '공급 독점',      '희소 공급처를 선점', 90),
  ('moat', 'none',               '뚜렷한 해자 없음', '실행력으로만 버티는 구조', 200)
on conflict (kind, value) do update set label_ko = excluded.label_ko, description = excluded.description;

insert into taxonomy (kind, value, label_ko, sort_order) values
  ('customer_type', 'b2b',   '기업 대상 (B2B)',   10),
  ('customer_type', 'b2c',   '소비자 대상 (B2C)', 20),
  ('customer_type', 'b2b2c', 'B2B2C',            30),
  ('customer_type', 'd2c',   'D2C',              40),
  ('customer_type', 'b2g',   '정부 대상 (B2G)',   50),
  ('customer_type', 'p2p',   '개인 간 (P2P)',     60)
on conflict (kind, value) do update set label_ko = excluded.label_ko;

insert into taxonomy (kind, value, label_ko, sort_order) values
  ('category', 'ai_infra',       'AI · 인프라',        10),
  ('category', 'devtools',       '개발자 도구',        20),
  ('category', 'fintech',        '핀테크',            30),
  ('category', 'commerce',       '커머스 · 리테일',    40),
  ('category', 'health',         '헬스케어',          50),
  ('category', 'education',      '교육',              60),
  ('category', 'productivity',   '생산성 · 협업',      70),
  ('category', 'marketing',      '마케팅 · 세일즈',    80),
  ('category', 'media',          '미디어 · 콘텐츠',    90),
  ('category', 'logistics',      '물류 · 모빌리티',    100),
  ('category', 'proptech',       '부동산 · 건설',      110),
  ('category', 'hr',             '채용 · HR',         120),
  ('category', 'legal',          '법률 · 규제',        130),
  ('category', 'climate',        '기후 · 에너지',      140),
  ('category', 'manufacturing',  '제조 · 산업',        150),
  ('category', 'agriculture',    '농식품',            160),
  ('category', 'gaming',         '게임',              170),
  ('category', 'social',         '소셜 · 커뮤니티',    180),
  ('category', 'security',       '보안',              190),
  ('category', 'other',          '기타',              900)
on conflict (kind, value) do update set label_ko = excluded.label_ko;

insert into taxonomy (kind, value, label_ko, sort_order) values
  ('region', 'north_america', '북미',        10),
  ('region', 'europe',        '유럽',        20),
  ('region', 'asia',          '아시아',      30),
  ('region', 'korea',         '한국',        40),
  ('region', 'japan',         '일본',        50),
  ('region', 'china',         '중국',        60),
  ('region', 'india',         '인도',        70),
  ('region', 'latam',         '중남미',      80),
  ('region', 'mena',          '중동 · 아프리카', 90),
  ('region', 'oceania',       '오세아니아',   100),
  ('region', 'global',        '글로벌',      110)
on conflict (kind, value) do update set label_ko = excluded.label_ko;

-- ────────────────────────────────────────────────────────────
-- 7. 수집 소스 시드 — 2026-08-04 기준 응답 확인(HTTP 200)한 것만.
--    Indie Hackers(indiehackers.com/feed.xml)는 HTML을 반환해 제외했다.
-- ────────────────────────────────────────────────────────────
insert into sources (name, kind, url, max_items, notes) values
  ('Y Combinator', 'yc_api', 'https://api.ycombinator.com/v0.1/companies', 15,
   '공식 공개 API. oneLiner/longDescription/industry 등 구조화 필드가 풍부해 품질이 가장 좋다.'),
  ('Product Hunt', 'atom', 'https://www.producthunt.com/feed', 15,
   'Atom 피드. 신규 출시 제품 위주 — 모델보다 제품 성격이 강하니 AI가 걸러낸다.'),
  ('Hacker News (Show HN)', 'hn_algolia',
   'https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=30', 15,
   '창업자 직접 런칭 글. points 낮은 건 ingest 단계에서 컷.'),
  ('TechCrunch', 'rss', 'https://techcrunch.com/feed/', 10,
   '자금조달·사업 뉴스. 회사 소개가 아닌 기사가 섞이므로 AI 판별 의존도가 높다.')
on conflict (name) do update set url = excluded.url, kind = excluded.kind, notes = excluded.notes;
