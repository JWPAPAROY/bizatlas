# BizAtlas

전세계 비즈니스 모델을 **같은 축으로 분해해 비교**하는 아카이브. 매일 자동 수집·구조화된다.

링크 모음이 아니라는 게 요점이다. 수집은 누구나 한다 — 차별점은 수집한 것을 자유 텍스트가 아니라
**통제 어휘(taxonomy)로 태깅**해서, "구독 모델이면서 자본이 거의 안 들고 한국에서도 통할 만한 것"
같은 질문을 필터 한 번으로 던질 수 있게 만드는 데 있다.

## 구조화 축

| 축 | 값 |
|---|---|
| 수익 모델 | 구독 / 사용량 과금 / 거래 수수료 / 마켓플레이스 / 광고 / 프리미엄 … (13종) |
| 해자 | 네트워크 효과 / 데이터 우위 / 전환 비용 / 브랜드 / 규제 … (10종) |
| 고객 유형 | B2B / B2C / B2B2C / D2C / B2G / P2P |
| 산업 | 20종 |
| 자본 집약도 | 1(노트북 한 대) ~ 5(공장·인허가) |
| 복제 용이성 | 1(따라하기 어려움) ~ 5(주말이면 복제) |
| 한국 적용성 | 1(규제·문화상 부적합) ~ 5(바로 통함) |

어휘는 코드가 아니라 `taxonomy` 테이블에 있다. 축을 늘려도 재배포가 필요 없다.

## 스택

- **프론트엔드** — Vite + React 19 + Tailwind v4, GitHub Pages 배포 (HashRouter)
- **DB** — Supabase Postgres (프로젝트 `skalhldjvspoaacdxgjg`, 서울 리전)
- **수집** — Supabase Edge Function (`ingest`) + Gemini
- **스케줄** — Supabase 내부 `pg_cron` + `pg_net` 이 **4시간마다**(KST 01/05/09/13/17/21시) 수집 함수를 호출한다.
  외부 스케줄러(GitHub Actions)를 쓰지 않아 의존성이 하나 적고, 시크릿 사본도 GitHub 에 둘 필요가 없다.

라이브: https://jwpaparoy.github.io/bizatlas/

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

Supabase 엣지 함수 secret:

| 이름 | 용도 |
|---|---|
| `GEMINI_API_KEY` | 구조화 |
| `INGEST_SECRET` | 호출 인증 (repo secret 과 동일 값) |

## 보안

- 클라이언트는 **읽기 전용**이다. RLS 로 `businesses`(published 만) · `taxonomy` · `sources` ·
  `ingest_runs` 만 열려 있고, 쓰기는 service_role 을 쓰는 엣지 함수만 가능하다.
- `seen_items` 는 정책을 주지 않아 anon 에게 완전히 차단된다 (파이프라인 내부 정보).

## 데이터 신뢰도

분류와 1~5 척도는 AI 가 **공개된 소개 문구만 읽고** 매긴 값이다. 실제 재무·경쟁 상황을 반영하지
않으며 틀릴 수 있다. 탐색·발상용이며, 판단 전에는 원문과 1차 자료를 확인해야 한다.
