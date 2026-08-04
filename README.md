# BizAtlas

전세계 비즈니스 모델을 **같은 축으로 분해해 비교**하는 아카이브.

링크 모음이 아니라는 게 요점이다. 수집은 누구나 한다 — 차별점은 수집한 것을 자유 텍스트가 아니라
**통제 어휘(taxonomy)로 태깅**해서, "구독 모델이면서 자본이 거의 안 들고 한국에서도 통할 만한 것"
같은 질문을 필터 한 번으로 던질 수 있게 만드는 데 있다.

> ### ⚠️ 한국 검증은 로컬 스크립트로만 돌아간다
>
> `opendart.fss.or.kr` 은 **TLS 1.2 + AES128-GCM-SHA256**(RSA 키 교환, 순방향 비밀성 없음)을 쓴다.
> Supabase 엣지 함수의 Deno 런타임은 rustls 기반이라 이 암호군을 의도적으로 지원하지 않아
> 핸드셰이크 단계에서 실패한다(`received fatal alert: HandshakeFailure`).
> Node 는 OpenSSL 이라 문제없으므로 **한국 시드는 `scripts/seed-korea.mjs` 로 로컬 실행**한다.
> 엣지 함수 `seed-proven` 의 `region: "korea"` 경로는 같은 이유로 쓸 수 없다(글로벌 경로는 정상).
>
> ```bash
> # 법인 고유번호 적재 (최초 1회, 이후 분기 1회면 충분 — 현재 118,583건 적재됨)
> DART_API_KEY=xx SUPABASE_URL=xx SUPABASE_SERVICE_ROLE_KEY=xx node scripts/sync-dart-corps.mjs
>
> # 한국 검증 코퍼스 시드 (카테고리 생략 시 proven 이 가장 빈약한 곳을 자동 선택)
> DART_API_KEY=xx GEMINI_API_KEY=xx SUPABASE_URL=xx SUPABASE_SERVICE_ROLE_KEY=xx \
>   node scripts/seed-korea.mjs fintech 8
> ```

## 구조화 축

| 축 | 값 |
|---|---|
| 수익 모델 | 구독 / 사용량 과금 / 거래 수수료 / 마켓플레이스 / 광고 / 프리미엄 … (13종) |
| 해자 | 네트워크 효과 / 데이터 우위 / 전환 비용 / 브랜드 / 규제 … (10종) |
| 고객 유형 | B2B / B2C / B2B2C / D2C / B2G / P2P |
| 산업 | 20종 |
| 자본 집약도 | 1(노트북 한 대) ~ 5(공장·인허가) |
| 복제 용이성 | 1(따라하기 어려움) ~ 5(주말이면 복제) |
| 한국 적용성 | 1(규제·문화상 부적합) ~ 5(거의 그대로 통함) |

어휘는 코드가 아니라 `taxonomy` 테이블에 있다(60개 전부 `description` 보유). 축을 늘려도 재배포가 필요 없다.

**1~5 척도는 세 곳(`Scale.jsx`의 `AXES`, 세 파이프라인 프롬프트, `rescore.mjs`)에서 문구가 일치해야 한다.**
한때 `ingest` 는 1~5 를 다 정의했는데 `seed-proven`·`seed-korea` 는 1·3·5 만 있어, 같은 축인데 등급별로
다른 잣대가 적용되고 있었다. 앵커를 고치면 반드시 `rescore.mjs` 로 기존 데이터를 다시 매길 것.

**한국 적용성은 여러 렌즈 중 하나다.** 카드에 이 축만 표시했더니 사실상 대표 지표로 읽혔다 —
세 축을 나란히 보여준다.

### 판단 층

축만으로는 비교까지만 되고 "그래서 뭘 해야 하나"가 안 나온다. 그래서 세 필드를 더 둔다.

| 필드 | 내용 |
|---|---|
| `startup_scale` | 한국에서 최소 규모로 시작할 때 드는 금액과 그 돈의 용처 |
| `korea_analogs` / `korea_analog_note` | 국내에 같은 모델을 하는 사업자. 없으면 "왜 없는가"가 핵심 |
| `regulatory_notes` | 한국에서 걸리는 인허가·규제 |

**`korea_analogs` 는 실재 회사명이라 환각 위험이 가장 크다.** 프롬프트에서 "확실한 것만, 애매하면
빈 배열"을 강하게 요구하고 화면에도 AI 생성물임을 명시한다. 그래도 검증 없이 신뢰해선 안 된다.

## 스택

- **프론트엔드** — Vite + React 19 + Tailwind v4, GitHub Pages 배포 (HashRouter)
- **DB** — Supabase Postgres (프로젝트 `skalhldjvspoaacdxgjg`, 서울 리전)
- **수집** — Supabase Edge Function `ingest`(최신 동향) / `seed-proven`(검증 코퍼스) + Gemini
- **검증** — Wikidata(글로벌) / DART 전자공시(한국)
- **스케줄** — Supabase 내부 `pg_cron` + `pg_net` 이 **4시간마다**(KST 01/05/09/13/17/21시) 수집 함수를 호출한다.
  외부 스케줄러(GitHub Actions)를 쓰지 않아 의존성이 하나 적고, 시크릿 사본도 GitHub 에 둘 필요가 없다.

라이브: https://jwpaparoy.github.io/bizatlas/

## 두 가지 등급 (tier)

자동 수집만 두면 미국 초기 스타트업만 쌓인다(초기 데이터 기준 YC 96%, ai_infra 40%).
아직 작동하는지 아무도 모르는 회사에 대해 AI 가 "작동하는 구조적 이유"를 쓰는 건 분석이 아니라 추측이다.
그래서 등급을 나누고 **검증된 쪽을 화면 기본값**으로 삼는다.

| tier | 채우는 방법 | 화면 |
|---|---|---|
| `proven` | `seed-proven`: 후보 생성(AI) → 실체·사실 조회 → 3관문 → 축 태깅(AI) | 기본 |
| `emerging` | `ingest`: 소스 자동 수집 | "최신 동향" 토글 |

**3관문** — 업력 5년 이상 / 기업 실체 확인 / 규모·저명성 확인. 통과 근거는 `evidence` 컬럼에 남기고 화면에 그대로 노출한다.

핵심 원칙은 **역할 분리**다. 설립일·매출·직원수 같은 **숫자는 검증 소스가**, 수익모델·해자·한국 적용성 같은
**구조 해석만 AI 가** 담당한다. 섞으면 AI 가 그럴듯한 수치를 지어낸다.

### 검증 소스

| 지역 | 소스 | 관문 매핑 |
|---|---|---|
| 글로벌 | Wikidata | 업력 = `P571` 설립일 / 실체 = `P31` 기업 타입 / 규모 = 매출·직원수·위키백과 언어판 수 |
| 한국 | DART 전자공시 | 업력 = `company.json` 의 `est_dt` / 실체 = `corp_code` 존재 / 규모 = 상장사 매출 또는 외부감사 대상 사실 |

DART 조회에서 실제로 밟은 함정 세 가지:

1. **서비스명 ≠ 법인명** — 배달의민족→우아한형제들, 오늘의집→버킷플레이스, 지그재그→카카오스타일,
   아이디어스→백패커, 올웨이즈→레브잇. 후보 생성 시 `corp_name_kr` 을 함께 받는다.
2. **동명 법인 오탐** — "에이블리"로 조회하면 2002년 설립의 무관한 법인이 잡히고 진짜
   (에이블리코퍼레이션)를 놓친다. AI 에게 **예상 설립연도**를 함께 받아 DART 값과 5년 넘게
   어긋나면 반려한다. 실제로 "브랜디 → 브랜디드인더스트리(2020 vs 예상 2014)"를 이 검사로 걸러냈다.
   자회사를 집는 것도 막아야 한다(와디즈 → 와디즈파이낸스) → 이름이 정확히 일치하는 법인을 우선한다.
3. **법인격 접두사** — AI 는 "주식회사 버킷플레이스"처럼 앞에 붙이는데 DART 등록명에는 없다.
   앞뒤 모두 제거해야 조회된다. 자산유동화 SPC(제일차·유동화전문 등)도 이름만 같으므로 제외한다.

**한국에 DART 를 쓰는 이유**: Wikidata 는 한국 기업 커버리지가 사실상 없다. 배달의민족·무신사는 기업
엔티티 자체가 없고 카카오페이·아프리카TV·리디도 데이터 공백으로 탈락한다. DART 는 고유번호 기반이라
EDGAR 같은 이름 전문검색 오탐도 없다.

호출:

```bash
# 글로벌 — 엣지 함수 (category 생략 시 proven 이 가장 빈약한 카테고리를 자동 선택)
curl -X POST .../functions/v1/seed-proven -H "x-ingest-secret: ..." \
  -d '{"category":"fintech","count":10}'

# 한국 — 로컬 스크립트 (위 TLS 제약 참고)
node scripts/seed-korea.mjs fintech 8
```

## 스크립트

전부 로컬 실행이며 `GEMINI_API_KEY` · `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` 를 환경변수로 받는다.

| 스크립트 | 하는 일 | 언제 |
|---|---|---|
| `sync-dart-corps.mjs` | DART 법인 고유번호 적재 (현재 118,583건) | 분기 1회 (`DART_API_KEY` 필요) |
| `seed-korea.mjs [분야] [개수]` | 한국 검증 코퍼스 시드 | 코퍼스를 늘릴 때 (`DART_API_KEY` 필요) |
| `rescore.mjs [건수]` | 1~5 척도 재평가 | **척도 앵커를 바꾼 뒤 반드시** |
| `enrich-decision.mjs [건수]` | 판단 층 3필드 생성 | 신규 데이터가 쌓인 뒤 |

`rescore` 와 `enrich-decision` 은 `scored_at` · `decided_at` 으로 진행 상태를 남겨 **이어서 실행된다.**
Gemini 무료 쿼터가 하루 한정이라 한 번에 못 끝나므로 이게 없으면 매번 처음부터 다시 태우게 된다.
전체를 다시 돌리려면 해당 컬럼을 `null` 로 비우면 된다.

```bash
node scripts/rescore.mjs           # 아직 재평가 안 된 것만
node scripts/enrich-decision.mjs   # 아직 판단 층이 없는 것만
```

## 수집 파이프라인

```
소스 fetch → 정규화 → 중복 컷 → 얇은 원문 사전 컷 → Gemini 구조화 → 어휘 검증 → insert
```

소스는 `sources` 테이블에서 켜고 끈다 (코드 수정 불필요).

| 소스 | 형식 | 비고 |
|---|---|---|
| Y Combinator | 공개 JSON API | 구조화 필드가 풍부해 품질이 가장 좋다 |
| Product Hunt | Atom | 피드 본문이 태그라인 한 줄뿐인 경우가 많아 수율이 낮다 |
| Hacker News (Show HN) | Algolia API | `/search`(points 랭킹) 사용 — `search_by_date` 는 신규 글이라 점수가 0이라 전부 걸러진다 |
| TechCrunch | RSS | 회사 소개가 아닌 기사가 섞여 AI 판별 의존도가 높다 |
| TechCrunch Venture | RSS | **투자유치 금액의 주력 소스** — 18건 중 13건에 금액이 명시된다 |

투자유치·매출 지표는 **소스에 금액이 적혀 있어야** 들어온다. YC API 에는 투자 필드가 아예 없고
(`teamSize`, `batch`, `status`, `tags` 뿐), 뉴스 RSS 는 `description` 이 요약 1~2문장뿐이라
**기사 본문을 별도로 fetch** 한다(AI 비용 없음).

검토했으나 채택하지 않은 것 — **SEC EDGAR Form D**: `efts.sec.gov` 는 기업명 검색이 아니라 공시
전문검색이라 `Caution`·`Conifer` 같은 일반 단어 이름에서 오탐이 심하다(YC 10곳 테스트: 본체 매칭 0건,
오탐 3건). 신생 스타트업은 아직 공시 전이고 미국 한정이라는 문제도 있다.

설계상 지켜야 하는 제약:

- **Gemini 무료 티어 한도는 "모델별 하루 20회"다** (quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier`).
  429 의 `Please retry in 39s` 문구 때문에 분당 한도로 착각하기 쉬운데 하루가 지나야 회복된다.
  모델마다 쿼터 버킷이 다르므로 `GEMINI_MODELS` 폴백 체인으로 용량을 늘린다 (6개 × 20 ≈ 하루 120건).
  **별칭은 실제 모델과 버킷을 공유한다** — `gemini-flash-latest` = `gemini-3.6-flash`. 둘 다 넣어도 소용없다.
  체인에서 뺀 것: `gemini-3.5-flash`(깨진 JSON 생성), `gemma-4-*`(system_instruction·JSON 모드 무시).
- **Supabase 엣지 함수는 150초 idle timeout.** 새 호출 시작은 `TIME_BUDGET_MS`(95초)에서 멈춘다.
- **한 번 판정한 항목은 `seen_items` 에 남겨 다시 AI 에 태우지 않는다.** 반려된 것도 남긴다.
  실패(에러)한 것만 남기지 않아 다음 실행에서 재시도된다.
  **JSON 파싱 실패는 반려가 아니라 에러로 처리한다** — 모델이 잘못 뱉은 것이지 항목의 문제가 아니라서,
  반려로 기록하면 멀쩡한 항목이 영구히 버려진다.

## 로컬 실행

```bash
npm install
cp .env.example .env   # VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 채우기
npm run dev
```

## 배포

**`main` 에 푸시하면 자동 배포된다** (`.github/workflows/deploy.yml` → GitHub Pages).
필요한 repo secret 은 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (등록 완료).

수동 배포가 필요하면 `.\deploy.ps1` 로 `gh-pages` 브랜치에 직접 올릴 수도 있다.
단 Pages 소스는 Actions 이므로 평소에는 쓸 일이 없다.

### 자격증명

이 PC 에는 GitHub 계정이 둘이라 (`gh` = JWPAPAROY, 시스템 credential manager = knwwhr)
**이 repo 에서만** 토큰을 갈아끼워 쓴다. 전역 설정을 바꾸면 knwwhr 프로젝트 푸시가 깨진다.

```bash
git config --local credential.helper ""      # 시스템 manager 무력화 (빈 값이 목록을 리셋)
git config --local --add credential.helper \
  '!f() { echo username=JWPAPAROY; echo "password=$(cat /c/Users/knoww/.secrets/bizatlas-gh-token.txt)"; }; f'
```

토큰에는 `repo` + **`workflow`** 스코프가 필요하다. `workflow` 가 없으면
`.github/workflows/*.yml` 푸시만 거부된다. gh CLI 의 OAuth 토큰에는 이 스코프가 없어
별도 PAT 을 `.secrets/bizatlas-gh-token.txt` 에 두고 쓴다.

## 시크릿 현황

Supabase 엣지 함수 secret:

| 이름 | 용도 | 상태 |
|---|---|---|
| `GEMINI_API_KEY` | 구조화 (bizatlas 전용 키 — investar 와 쿼터를 나누지 않는다) | 설정됨 |
| `INGEST_SECRET` | 수집·시드 함수 호출 인증 | 설정됨 |
| `DART_API_KEY` | 등록은 돼 있으나 **엣지 함수에서는 쓸 수 없다**(위 TLS 제약). 실제 사용은 로컬 스크립트. | 설정됨 |

로컬 `.secrets/` (repo 에 커밋 금지):

| 파일 | 용도 |
|---|---|
| `supabase-pat.txt` | Supabase PAT · `INGEST_SECRET` · Gemini 키 · DART 키 |
| `bizatlas-gh-token.txt` | GitHub PAT (`repo` + `workflow`) |

GitHub repo secret: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (빌드용), `INGEST_SECRET`
— `INGEST_SECRET` 은 수집을 pg_cron 으로 옮긴 뒤로 쓰이지 않지만, GitHub Actions 로 되돌릴 때를 위해 남겨둔다.

## 보안

- 클라이언트는 **읽기 전용**이다. RLS 로 `businesses`(published 만) · `taxonomy` · `sources` ·
  `ingest_runs` 만 열려 있고, 쓰기는 service_role 을 쓰는 엣지 함수만 가능하다.
- `seen_items` · `dart_corps` 는 정책을 주지 않아 anon 에게 완전히 차단된다 (파이프라인 내부 정보).

## 데이터 신뢰도

**숫자와 해석의 출처가 다르다.** 신뢰도 순으로:

| | 내용 | 출처 |
|---|---|---|
| 검증됨 | 설립일 · 매출 · 직원수 · 법인 실체 | Wikidata / DART. `evidence` 에 출처 링크와 함께 남는다 |
| AI 해석 | 수익모델 · 해자 · 1~5 점수 세 축 | 회사 설명을 읽고 매긴 값. 재무 계산이 아니다 |
| AI 생성 (위험) | 국내 유사 사업자 · 시작 규모 · 규제 | **실재 회사명·법령을 다루므로 환각 위험이 가장 크다** |

`emerging` 등급은 공개된 소개 문구만 읽고 만든 것이라 전반적으로 신뢰도가 더 낮다.
탐색·발상용이며, 판단 전에는 원문과 1차 자료를 확인해야 한다.
