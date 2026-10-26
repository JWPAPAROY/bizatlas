-- 기회 깔때기 — 해외 패턴에서 국내에서 해볼 만한 사업 기회를 발굴하고 계속 검증한다.
--
--   ① signal  해외 패턴 감지: 서로 다른 나라에서 3곳+ 이 같은 고객의 같은 문제를 풀고 있다
--   ② desk    기회 카드 + 데스크 검증(코드가 계산한 숫자 + DART 대조)을 통과
--   ③ field   사람이 직접 검증 중 (인터뷰·가짜 문 테스트) — 수동 승격
--   ④ go / killed  판정
--
-- 원칙: 숫자(회사 수·국가 수·투자 건수·자본 부담)는 businesses 에서 코드가 계산한다. AI 는 묶기와 해석만.
-- 쓰기는 scripts/opportunities.mjs 가 시크릿으로 잠긴 함수로만 한다 — service_role 을 GitHub 에 올리지 않는다.

create table if not exists opportunities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,                       -- 기회 한 줄 (한국어)
  problem text not null,                     -- 해외 선례들이 공통으로 푸는 문제
  customer_type text,                        -- taxonomy:customer_type
  stage text not null default 'signal' check (stage in ('signal', 'desk', 'field', 'go', 'killed')),

  -- 해외 선례 (코드가 검증·계산)
  members uuid[] not null default '{}',
  member_count int not null default 0,
  country_count int not null default 0,
  funded_count int not null default 0,
  cap_avg numeric(3, 2),                     -- 선례의 capital_intensity 평균 (1~5)

  -- 기회 카드 (AI) — 한국 가설·렌즈·혼자 가능성·규제 플래그·인터뷰 질문·폐기 기준 초안·검색어
  card jsonb not null default '{}'::jsonb,
  -- 국내 경쟁 후보 [{name, why, dart: {corp_code, corp_name, listed} | null}]
  competitors jsonb not null default '[]'::jsonb,
  -- 데스크 판정 (코드) {verdict: 'pass'|'hold', reasons: [...]}
  desk jsonb not null default '{}'::jsonb,
  -- 실행마다 선례 규모를 남긴다 — "신호가 강해지는가" 를 보는 시계열 [{at, members, countries, funded}]
  history jsonb not null default '[]'::jsonb,

  ai_model text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  carded_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists opportunities_stage_idx on opportunities (stage);

alter table opportunities enable row level security;
drop policy if exists opportunities_read on opportunities;
create policy opportunities_read on opportunities for select to anon, authenticated using (true);

-- ── 쓰기 시크릿. 해시만 저장한다. private 스키마는 PostgREST 에 노출되지 않는다.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.writer_secrets (
  name text primary key,
  sha256 text not null
);

create or replace function private.check_writer(p_name text, p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_secret is null or not exists (
    select 1 from private.writer_secrets s
    where s.name = p_name and s.sha256 = encode(extensions.digest(p_secret, 'sha256'), 'hex')
  ) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
end;
$$;

-- ── 기회 기록: slug 기준 upsert. 넘긴 키만 덮어쓴다(카드 없이 선례만 갱신하는 실행이 카드를 지우지 않게).
create or replace function upsert_opportunity(p_secret text, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform private.check_writer('opportunities', p_secret);

  insert into opportunities as o (slug, title, problem, customer_type, members, member_count, country_count,
    funded_count, cap_avg, card, competitors, desk, history, ai_model, stage, carded_at)
  values (
    p->>'slug', p->>'title', p->>'problem', p->>'customer_type',
    coalesce(array(select jsonb_array_elements_text(p->'members'))::uuid[], '{}'),
    coalesce((p->>'member_count')::int, 0), coalesce((p->>'country_count')::int, 0),
    coalesce((p->>'funded_count')::int, 0), (p->>'cap_avg')::numeric,
    coalesce(p->'card', '{}'::jsonb), coalesce(p->'competitors', '[]'::jsonb), coalesce(p->'desk', '{}'::jsonb),
    coalesce(p->'history', '[]'::jsonb), p->>'ai_model', coalesce(p->>'stage', 'signal'),
    case when p ? 'card' then now() end
  )
  on conflict (slug) do update set
    title         = coalesce(p->>'title', o.title),
    problem       = coalesce(p->>'problem', o.problem),
    customer_type = coalesce(p->>'customer_type', o.customer_type),
    members       = case when p ? 'members' then array(select jsonb_array_elements_text(p->'members'))::uuid[] else o.members end,
    member_count  = coalesce((p->>'member_count')::int, o.member_count),
    country_count = coalesce((p->>'country_count')::int, o.country_count),
    funded_count  = coalesce((p->>'funded_count')::int, o.funded_count),
    cap_avg       = coalesce((p->>'cap_avg')::numeric, o.cap_avg),
    card          = coalesce(p->'card', o.card),
    competitors   = coalesce(p->'competitors', o.competitors),
    desk          = coalesce(p->'desk', o.desk),
    history       = coalesce(p->'history', o.history),
    ai_model      = coalesce(p->>'ai_model', o.ai_model),
    -- 사람이 field·go·killed 로 옮긴 건 스크립트가 되돌리지 않는다
    stage         = case when o.stage in ('field', 'go', 'killed') then o.stage else coalesce(p->>'stage', o.stage) end,
    carded_at     = case when p ? 'card' then now() else o.carded_at end,
    last_seen_at  = now(),
    updated_at    = now()
  returning id into v_id;
  return v_id;
end;
$$;

-- ── 국내 경쟁 후보 이름을 DART 법인과 대조. dart_corps 는 비공개 테이블이라 이 함수로만 조회한다.
-- 정확 일치(canonical)만 본다 — 부분 일치는 "와디즈→와디즈파이낸스" 같은 오탐이 난다(seed-korea 에서 실측).
create or replace function opportunity_dart_lookup(p_secret text, p_names text[])
returns table (name text, corp_code text, corp_name text, listed boolean)
language plpgsql security definer set search_path = public as $$
begin
  perform private.check_writer('opportunities', p_secret);
  return query
    select distinct on (n.name) n.name, d.corp_code, d.corp_name, d.stock_code is not null
    from unnest(p_names) as n(name)
    join dart_corps d on d.canonical = canonical_name(n.name)
    order by n.name, (d.stock_code is not null) desc, d.modify_date desc;
end;
$$;

revoke execute on function upsert_opportunity(text, jsonb) from public, authenticated;
revoke execute on function opportunity_dart_lookup(text, text[]) from public, authenticated;
-- anon 은 호출은 가능해야 한다(스크립트가 anon 키 + 시크릿으로 부른다). 시크릿이 틀리면 42501.
grant execute on function upsert_opportunity(text, jsonb) to anon;
grant execute on function opportunity_dart_lookup(text, text[]) to anon;
revoke execute on function private.check_writer(text, text) from public, anon, authenticated;
