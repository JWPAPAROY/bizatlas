-- 기회 깔때기 ③ 현장 검증 — 사람이 인터뷰·가짜 문 테스트로 확인하고 진행/폐기를 판정한다.
--
-- 원칙 (investar 사전등록과 같다):
--   · 현장 검증은 폐기 기준과 판정일을 확정해야만 시작된다. 확정한 기준은 고칠 수 없다 — 결과를 보고 기준을 옮기지 않기 위해.
--   · 기록과 판정 사유는 비공개다. 인터뷰 내용이 공개 사이트에 새지 않게 anon 조회를 막고, 'field' 시크릿 함수로만 읽고 쓴다.
--   · stage 는 공개 테이블(opportunities)에 남는다 — 무엇을 검증 중인지는 공개, 무슨 말을 들었는지는 비공개.
--
-- 'field' 시크릿은 브라우저에 넣는 것이라 GitHub 의 'opportunities' 시크릿과 분리한다.
-- 등록: insert into private.writer_secrets values ('field', encode(extensions.digest('<원본>', 'sha256'), 'hex'));

create table if not exists opportunity_validations (
  opportunity_id uuid primary key references opportunities(id) on delete cascade,
  kill_criteria text[] not null check (cardinality(kill_criteria) between 1 and 6),
  decide_by date not null,                   -- 이 날까지 판정. 기준을 못 채우면 연장 없이 폐기가 기본
  started_at timestamptz not null default now(),
  decision text check (decision in ('go', 'killed')),
  decision_reason text,
  decided_at timestamptz
);

create table if not exists opportunity_logs (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  kind text not null check (kind in ('interview', 'fake_door', 'other')),
  happened_on date not null,
  who text,                                  -- 역할만 (예: "자영업 카페 사장 40대"). 실명·연락처 금지
  summary text not null,
  signal text not null check (signal in ('for', 'against', 'mixed')),
  criteria_hit int[] not null default '{}',  -- 이 근거가 해당하는 폐기 기준 번호 (kill_criteria 의 0-기반 인덱스)
  metrics jsonb not null default '{}'::jsonb, -- 가짜 문: {shown, clicked, signed_up}
  created_at timestamptz not null default now()
);

create index if not exists opportunity_logs_opp_idx on opportunity_logs (opportunity_id, happened_on);

-- RLS 켜고 정책 없음 = anon/authenticated 전부 차단. 아래 SECURITY DEFINER 함수로만 접근.
alter table opportunity_validations enable row level security;
alter table opportunity_logs enable row level security;
revoke all on opportunity_validations, opportunity_logs from anon, authenticated;

-- ── 현장 검증 시작: 폐기 기준·판정일 확정 + stage → field
create or replace function field_start(p_secret text, p_opportunity uuid, p_criteria text[], p_decide_by date) returns void
language plpgsql security definer set search_path = public as $$
declare v_stage text; v_criteria text[];
begin
  perform private.check_writer('field', p_secret);
  select array_agg(btrim(c)) into v_criteria from unnest(p_criteria) c where btrim(c) <> '';
  if coalesce(cardinality(v_criteria), 0) = 0 then raise exception '폐기 기준이 비어 있다' using errcode = '22023'; end if;
  if p_decide_by is null or p_decide_by <= current_date then raise exception '판정일은 오늘 이후여야 한다' using errcode = '22023'; end if;

  select stage into v_stage from opportunities where id = p_opportunity for update;
  if v_stage is null then raise exception '없는 기회' using errcode = 'P0002'; end if;
  if v_stage not in ('signal', 'desk') then raise exception '이미 % 단계', v_stage using errcode = '22023'; end if;

  insert into opportunity_validations (opportunity_id, kill_criteria, decide_by) values (p_opportunity, v_criteria, p_decide_by);
  update opportunities set stage = 'field', updated_at = now() where id = p_opportunity;
end;
$$;

-- ── 검증 기록 추가 (현장 검증 중일 때만)
create or replace function field_log(p_secret text, p_opportunity uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_n int;
begin
  perform private.check_writer('field', p_secret);
  select cardinality(v.kill_criteria) into v_n
    from opportunity_validations v join opportunities o on o.id = v.opportunity_id
    where v.opportunity_id = p_opportunity and o.stage = 'field';
  if v_n is null then raise exception '현장 검증 중인 기회가 아니다' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements_text(coalesce(p->'criteria_hit', '[]')) i(v) where i.v::int < 0 or i.v::int >= v_n) then
    raise exception '없는 폐기 기준 번호' using errcode = '22023';
  end if;

  insert into opportunity_logs (opportunity_id, kind, happened_on, who, summary, signal, criteria_hit, metrics)
  values (
    p_opportunity, p->>'kind', coalesce((p->>'happened_on')::date, current_date), nullif(btrim(p->>'who'), ''),
    p->>'summary', p->>'signal',
    coalesce(array(select jsonb_array_elements_text(p->'criteria_hit')::int), '{}'),
    coalesce(p->'metrics', '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- ── 기록 삭제 (오타·잘못 넣은 기록용). 판정 후에는 지울 수 없다.
create or replace function field_log_delete(p_secret text, p_log uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform private.check_writer('field', p_secret);
  delete from opportunity_logs l using opportunities o
    where l.id = p_log and o.id = l.opportunity_id and o.stage = 'field';
  if not found then raise exception '지울 수 없는 기록' using errcode = '22023'; end if;
end;
$$;

-- ── 판정: go / killed + 사유
create or replace function field_decide(p_secret text, p_opportunity uuid, p_decision text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform private.check_writer('field', p_secret);
  if p_decision not in ('go', 'killed') then raise exception '판정은 go 또는 killed' using errcode = '22023'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception '판정 사유가 비어 있다' using errcode = '22023'; end if;

  update opportunity_validations set decision = p_decision, decision_reason = btrim(p_reason), decided_at = now()
    where opportunity_id = p_opportunity and decision is null;
  if not found then raise exception '현장 검증 중인 기회가 아니다' using errcode = '22023'; end if;
  update opportunities set stage = p_decision, updated_at = now() where id = p_opportunity;
end;
$$;

-- ── 전체 조회: {opportunity_id: {kill_criteria, decide_by, started_at, decision, decision_reason, decided_at, logs: [...]}}
-- 시크릿 확인용으로도 쓴다 (틀리면 42501).
create or replace function field_read(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform private.check_writer('field', p_secret);
  return coalesce((
    select jsonb_object_agg(v.opportunity_id, to_jsonb(v) - 'opportunity_id' || jsonb_build_object('logs', coalesce((
      select jsonb_agg(to_jsonb(l) - 'opportunity_id' order by l.happened_on, l.created_at)
      from opportunity_logs l where l.opportunity_id = v.opportunity_id), '[]'::jsonb)))
    from opportunity_validations v
  ), '{}'::jsonb);
end;
$$;

revoke execute on function field_start(text, uuid, text[], date) from public, authenticated;
revoke execute on function field_log(text, uuid, jsonb) from public, authenticated;
revoke execute on function field_log_delete(text, uuid) from public, authenticated;
revoke execute on function field_decide(text, uuid, text, text) from public, authenticated;
revoke execute on function field_read(text) from public, authenticated;
grant execute on function field_start(text, uuid, text[], date) to anon;
grant execute on function field_log(text, uuid, jsonb) to anon;
grant execute on function field_log_delete(text, uuid) to anon;
grant execute on function field_decide(text, uuid, text, text) to anon;
grant execute on function field_read(text) to anon;
