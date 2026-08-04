-- DART(금융감독원 전자공시) 법인 고유번호 캐시
--
-- 한국 기업은 Wikidata 데이터가 비어 있다(배달의민족·무신사는 기업 엔티티 자체가 없음).
-- DART 는 고유번호(corp_code) 기반이라 EDGAR 같은 이름 전문검색 오탐이 없고,
-- 비상장이라도 외부감사 대상이면 등록돼 있어 한국 검증에 적합하다.
--
-- corpCode.xml 은 10만 건짜리 ZIP 이라 엣지 함수에서 매번 풀면 무겁다.
-- scripts/sync-dart-corps.mjs 로 주기적으로(분기 1회면 충분) 적재하고, 조회는 이 테이블에서 한다.

create table if not exists dart_corps (
  corp_code   text primary key,          -- DART 고유번호 8자리
  corp_name   text not null,
  stock_code  text,                      -- 있으면 상장사 (재무제표 API 사용 가능)
  modify_date text,
  -- 회사명 정규화 키. "(주)우아한형제들" 과 "우아한형제들" 을 같게 본다.
  canonical   text generated always as (canonical_name(corp_name)) stored
);

create index if not exists dart_corps_canonical_idx on dart_corps (canonical);
create index if not exists dart_corps_name_idx on dart_corps (corp_name);
-- 상장사 우선 매칭용 (동명 법인이 있을 때 상장사를 먼저 고른다)
create index if not exists dart_corps_stock_idx on dart_corps (stock_code) where stock_code is not null;

-- 내부 데이터라 공개하지 않는다 (RLS 활성화 + 정책 없음 = anon 전면 차단)
alter table dart_corps enable row level security;
