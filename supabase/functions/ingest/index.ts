// BizAtlas 수집 파이프라인 — 외부 스케줄러(GitHub Actions)가 x-ingest-secret 헤더로 호출.
//
//   소스 fetch → 정규화 → 중복 컷 → Gemini 구조화 → 통제 어휘 검증 → insert
//
// 설계 원칙:
//   1) 비용 유계. 실행당 AI 호출 상한(MAX_AI_CALLS)을 두고, 한 번 판정한 항목은 seen_items 로 기억해 재호출하지 않는다.
//   2) 부분 실패 허용. 소스 하나가 죽어도 나머지는 진행하고, 결과를 ingest_runs 에 남긴다.
//   3) 쓰레기 차단. "회사·비즈니스 모델"이 아닌 항목(단순 뉴스·툴 소개)은 AI 가 is_business=false 로 반려한다.
//
// Deploy: supabase functions deploy ingest --no-verify-jwt
// Secrets: supabase secrets set GEMINI_API_KEY=... INGEST_SECRET=...

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

// 무료 티어 한도는 **모델별 일일 요청 수**다 (quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier,
// gemini-3.6-flash 기준 하루 20회). 429 응답의 "retry in 39s" 문구 때문에 분당 한도로 착각하기 쉬운데,
// 하루가 지나야 회복된다. 모델을 바꾸면 쿼터 버킷도 달라지므로, 주력 모델이 소진되면 다음 모델로 넘어간다.
// 앞쪽일수록 품질이 좋다.
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest']

// 엣지 함수 실행 시간 한도가 있으므로 한 번에 다 처리하지 않는다. 매일 돌면 충분히 쌓인다.
// Gemini 호출이 건당 10~13초라 순차 처리하면 예산 안에 10건도 못 넘긴다 → 병렬 처리한다.
// Supabase 엣지 함수는 응답이 없으면 150초에 끊는다(IDLE_TIMEOUT). 마지막 호출이 끝나고
// DB 정리까지 마칠 시간이 필요하므로 신규 호출 시작은 95초에서 멈춘다.
// 일일 한도(모델당 20회) × 모델 수가 실질 상한이다. 하루 1회 cron 이므로 그 한 번에 다 쓴다.
const MAX_AI_CALLS = 40
const CONCURRENCY = 4
const TIME_BUDGET_MS = 95_000

// 요청 수는 일일 한도라 분당 페이싱이 의미 없지만, 입력 토큰에는 분당 한도가 따로 있다
// (GenerateContentInputTokensPerModelPerMinute-FreeTier). 그것만 피할 정도로 느슨하게 띄운다.
const RPM_LIMIT = 30
const CALL_SPACING_MS = Math.ceil(60_000 / RPM_LIMIT)

// 원문이 이보다 짧으면 AI 를 태워도 "정보 부족"으로 반려된다. 호출 전에 잘라 비용을 아낀다.
// (Product Hunt Atom 피드가 대표적 — content 가 태그라인 한 줄뿐인 경우가 많다.)
const MIN_TEXT_CHARS = 200

type Candidate = {
  sourceItemId: string
  title: string
  url: string
  text: string
}

// ────────────────────────────────────────────────────────────
// 유틸
// ────────────────────────────────────────────────────────────
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function pick(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? decodeEntities(m[1]).trim() : ''
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return base || 'item'
}

// source_item_id 로 짧은 접미사를 만들어 슬러그 충돌을 막는다 (동명 회사 존재).
function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 6)
}

function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) {
    try { return JSON.parse(fenced[1]) } catch { /* fall through */ }
  }
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a !== -1 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)) } catch { /* fall through */ }
  }
  return null
}

// ────────────────────────────────────────────────────────────
// 소스 파서 — 각 소스를 공통 Candidate 형태로 정규화
// ────────────────────────────────────────────────────────────
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BizAtlas/0.1 (+https://github.com/JWPAPAROY/bizatlas)' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

// Y Combinator 공개 API — 구조화 필드가 가장 풍부해 품질이 좋다.
async function parseYc(url: string, limit: number): Promise<Candidate[]> {
  const data = JSON.parse(await fetchText(url))
  const companies = Array.isArray(data?.companies) ? data.companies : []
  // id 가 클수록 최신. 최신 것부터 훑는다.
  const sorted = [...companies].sort((a, b) => (b?.id ?? 0) - (a?.id ?? 0))
  // 전체 기업 덤프라 후보를 넉넉히 넘긴다. 상위 N 개만 자르면 그 N 개가 전부 처리된 뒤로는
  // 매 실행이 "이미 본 항목"만 만나 새 데이터가 영원히 안 들어온다. 실제 처리량은
  // 중복 제거 후 MAX_AI_CALLS 로 제한되므로 후보가 많아도 비용은 늘지 않는다.
  return sorted.slice(0, limit * 10).map((c) => ({
    sourceItemId: `yc:${c.id}`,
    title: String(c.name ?? '').trim(),
    url: String(c.website || c.smallLogoUrl || '').trim(),
    text: [
      c.oneLiner && `한 줄 소개: ${c.oneLiner}`,
      c.longDescription && `상세: ${c.longDescription}`,
      c.industry && `산업: ${c.industry}`,
      c.subindustry && `세부산업: ${c.subindustry}`,
      c.batch && `YC 배치: ${c.batch}`,
      c.teamSize && `팀 규모: ${c.teamSize}`,
      c.allLocations && `위치: ${c.allLocations}`,
      c.website && `웹사이트: ${c.website}`,
    ].filter(Boolean).join('\n'),
  })).filter((c) => c.title)
}

// Atom (Product Hunt)
function parseAtom(xml: string, limit: number): Candidate[] {
  const entries = xml.match(/<entry[\s\S]*?<\/entry>/g) ?? []
  return entries.slice(0, limit).map((e) => {
    const id = pick(e, 'id')
    const linkMatch = e.match(/<link[^>]*href="([^"]+)"/i)
    const content = stripTags(pick(e, 'content') || pick(e, 'summary'))
    return {
      sourceItemId: `ph:${id || linkMatch?.[1] || Math.random()}`,
      title: stripTags(pick(e, 'title')),
      url: linkMatch?.[1] ?? '',
      text: content,
    }
  }).filter((c) => c.title)
}

// 기사 페이지에서 본문만 뽑는다 (script/style 제거 후 <p> 텍스트).
function extractArticle(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  const paras = cleaned.match(/<p[^>]*>[\s\S]*?<\/p>/gi) ?? []
  return paras
    .map((p) => stripTags(p))
    .filter((t) => t.length > 40)
    .join('\n')
}

// RSS 2.0 (TechCrunch 등 뉴스)
async function parseRss(xml: string, limit: number): Promise<Candidate[]> {
  const items = xml.match(/<item[\s\S]*?<\/item>/g) ?? []
  const base = items.slice(0, limit).map((e) => {
    const link = pick(e, 'link')
    const guid = pick(e, 'guid') || link
    const body = stripTags(pick(e, 'content:encoded') || pick(e, 'description'))
    return {
      sourceItemId: `rss:${guid}`,
      title: stripTags(pick(e, 'title')),
      url: link,
      text: body,
    }
  }).filter((c) => c.title)

  // 뉴스 RSS 의 description 은 1~2문장 요약뿐이라 그대로 쓰면 "정보 부족"으로 반려된다.
  // 기사 본문을 받아오면 투자유치 금액·라운드 같은 핵심 수치가 실제로 들어온다.
  // AI 호출이 아니라 단순 HTTP 라 비용은 거의 없다.
  await Promise.all(base.map(async (c) => {
    if (!c.url || c.text.length > 1200) return
    try {
      const article = extractArticle(await fetchText(c.url))
      if (article.length > c.text.length) c.text = article
    } catch { /* 본문 실패 시 요약으로 진행 */ }
  }))

  // 기사 전문이 아주 길면 토큰 낭비 → 앞부분만. 금액·라운드는 보통 첫 문단들에 나온다.
  for (const c of base) c.text = c.text.slice(0, 4000)
  return base
}

// Hacker News (Algolia) — Show HN
async function parseHn(url: string, limit: number): Promise<Candidate[]> {
  const data = JSON.parse(await fetchText(url))
  const hits = Array.isArray(data?.hits) ? data.hits : []
  return hits
    // 반응 없는 글은 검증되지 않은 노이즈에 가깝다.
    // 단 search_by_date(최신순)로 받으면 갓 올라온 글이라 점수가 0에 수렴해 전부 걸러진다.
    // → 소스 URL 은 points 로 랭킹되는 /search 엔드포인트를 쓴다. 여기 임계값은 안전망.
    .filter((h: Record<string, unknown>) => (Number(h.points) || 0) >= 3)
    .slice(0, limit)
    .map((h: Record<string, unknown>) => ({
      sourceItemId: `hn:${h.objectID}`,
      title: String(h.title ?? '').replace(/^Show HN:\s*/i, '').trim(),
      url: String(h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`),
      text: [
        h.title && `제목: ${h.title}`,
        h.story_text && `본문: ${stripTags(String(h.story_text)).slice(0, 2000)}`,
        `HN 점수: ${h.points}`,
      ].filter(Boolean).join('\n'),
    }))
    .filter((c: Candidate) => c.title)
}

async function loadCandidates(src: Record<string, unknown>): Promise<Candidate[]> {
  const url = String(src.url)
  const limit = Number(src.max_items) || 10
  switch (src.kind) {
    case 'yc_api':     return await parseYc(url, limit)
    case 'hn_algolia': return await parseHn(url, limit)
    case 'atom':       return parseAtom(await fetchText(url), limit)
    case 'rss':        return await parseRss(await fetchText(url), limit)
    default:           throw new Error(`unknown source kind: ${src.kind}`)
  }
}

// ────────────────────────────────────────────────────────────
// AI 구조화
// ────────────────────────────────────────────────────────────
type Vocab = Record<string, { value: string; label_ko: string }[]>

function buildPrompt(vocab: Vocab): string {
  const list = (kind: string) =>
    (vocab[kind] ?? []).map((t) => `${t.value}(${t.label_ko})`).join(', ')

  return `당신은 비즈니스 모델 애널리스트입니다. 주어진 원문(회사/제품 소개 또는 기사)을 읽고 구조화된 데이터로 변환하세요.

## 판별 기준 (가장 중요)
원문이 "실재하는 회사 또는 제품의 비즈니스 모델"을 파악할 수 있는 내용이 아니면 is_business=false 로 반려하세요.
반려 대상 예시: 일반 뉴스·논평·인사 이동·시장 전망 기사, 오픈소스 취미 프로젝트, 수익 구조를 전혀 알 수 없는 단순 툴 소개.
**벤처캐피털의 펀드 결성 기사도 반려하세요** ("Index Ventures raises $2B across three funds" 류).
VC 는 우리가 수집하는 비즈니스 모델이 아닙니다. 단, VC 가 특정 스타트업에 투자한 기사라면
그 **투자받은 스타트업**을 대상으로 작성하세요.
확실하지 않으면 반려하세요. 데이터 품질이 수집량보다 중요합니다.

## 작성 규칙
- name, hq_country 를 제외한 모든 서술형 필드는 **한국어**로 작성합니다.
- 원문에 없는 사실을 지어내지 마세요. 모르는 필드는 null 또는 빈 배열로 두세요.
- traction(매출·사용자수·투자유치·기업가치)은 **원문에 명시된 수치만** 넣습니다. 추정 금지.
  단 명시돼 있으면 반드시 빠뜨리지 말고 채우세요. 기사에 자주 나오는 형태:
  "raised $20 million Series A" → funding: "$20M 시리즈 A",
  "valued at $1.5 billion" → valuation: "$1.5B",
  "300,000 customers" → users: "고객 30만".
  라운드 단계(시드/시리즈 A 등)와 투자사 이름이 있으면 funding 문자열에 함께 적으세요.
  **funding 에는 반드시 금액이 들어가야 합니다.** 금액 없이 "YC S26 배치", "액셀러레이터 참여"
  같은 값은 넣지 말고 null 로 두세요. 액셀러레이터 소속은 funding 이 아닙니다.
- 아래 열거된 값 외의 값을 쓰지 마세요. 목록에 없으면 가장 가까운 값을 고르고, 없으면 생략합니다.

## 허용 값
category: ${list('category')}
customer_type: ${list('customer_type')}
revenue_model: ${list('revenue_model')}
moat: ${list('moat')}
region: ${list('region')}

## 해자 판정 규칙 (엄격히)
해자는 "이미 확보한 방어막"만 인정합니다. 앞으로 생길 것 같다는 추정은 해자가 아닙니다.
- moats 는 **최대 2개**. 근거가 약하면 1개, 없으면 빈 배열 또는 ["none"] 으로 두세요.
- ip: 특허 보유·독점 라이선스가 **원문에 명시된 경우에만**. "AI 기술을 쓴다", "자체 모델을
  개발했다" 정도는 ip 가 아닙니다. 대부분의 초기 스타트업은 ip 해자가 없습니다.
- data: 서비스 운영으로 데이터가 쌓여 제품이 나아지는 구조가 **설명된 경우에만**.
- switching_costs: 고객 워크플로·데이터가 잠기는 구조가 구체적으로 드러난 경우에만.
- network_effects: 사용자가 늘수록 다른 사용자의 효용이 커지는 구조일 때만.
초기 단계 회사라 방어막이 실행력뿐이면 주저 말고 ["none"] 을 쓰세요. 그게 정확한 답입니다.

## 척도 (1~5 정수) — 반드시 분포를 만드세요
모든 항목에 비슷한 점수를 주면 이 데이터는 쓸모가 없어집니다. 아래 기준을 문자 그대로 적용하고,
애매하면 중간(3)이 아니라 근거가 가리키는 쪽으로 확실히 기울이세요.

- capital_intensity: 1=노트북 한 대(SaaS·앱), 2=소규모 클라우드 비용, 3=상당한 GPU·초기 재고,
  4=하드웨어 양산·물류 거점, 5=공장·인허가·중장비
- replicability: 1=복제 거의 불가(규제 승인·독점 데이터·수년치 R&D), 2=수년 필요,
  3=자금 있으면 1년 내, 4=수개월, 5=주말이면 복제 가능(단순 래퍼·CRUD)
- korea_fit: 한국 시장에 **그대로 이식**했을 때의 적합성.
  1=한국 규제상 불가능하거나 시장이 없음, 2=대기업·기존 사업자가 이미 장악해 진입 무의미,
  3=가능하지만 현지화 부담이 큼, 4=약간의 현지화로 통함, 5=번역만 해도 수요가 있음
  판단 시 반드시 고려: 한국의 규제(의료·금융·개인정보), 시장 규모, 이미 있는 국내 대체재,
  영어권 전용 워크플로 의존 여부. **미국 기업 문화·SaaS 구매 관행에 강하게 묶인 B2B 도구는
  한국 적용성이 낮습니다(2~3).** 무조건 4를 주지 마세요.
- ai_confidence: 원문 정보가 빈약하면 0.3~0.5, 충분하면 0.7~0.9 (0.0~1.0)

## 출력
반드시 아래 JSON만 출력하세요. 다른 텍스트·설명·마크다운 금지.
{
  "is_business": true,
  "reject_reason": null,
  "name": "회사/제품명 (원문 표기 그대로)",
  "one_liner": "한 줄 요약 (한국어, 40자 내외)",
  "description": "무엇을 누구에게 어떻게 파는지 3~5문장 (한국어)",
  "website": "https://... 또는 null",
  "hq_country": "본사 국가 영문명 또는 null",
  "region": "허용값 중 하나 또는 null",
  "founded_year": 2021,
  "category": "허용값 중 하나",
  "customer_type": "허용값 중 하나",
  "revenue_models": ["허용값 배열 (1~3개)"],
  "moats": ["허용값 배열 (0~3개)"],
  "pricing_note": "실제 과금 방식 한 줄 (한국어) 또는 null",
  "capital_intensity": 2,
  "replicability": 3,
  "korea_fit": 4,
  "korea_note": "한국 적용성 점수의 근거 한 줄 (한국어)",
  "why_it_works": "이 모델이 작동하는 핵심 이유 2~3문장 (한국어). 표면 설명이 아니라 구조적 이유를 쓸 것.",
  "risks": ["구조적 리스크 1~3개 (한국어)"],
  "tags": ["검색용 키워드 3~6개 (한국어 또는 영문)"],
  "traction": { "revenue": null, "users": null, "funding": null, "valuation": null },
  "ai_confidence": 0.7
}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 워커들이 공유하는 호출 슬롯. 각 워커는 자기 차례가 될 때까지 기다렸다 요청한다.
let nextSlotAt = 0
// 현재 사용 중인 모델. 429(일일 소진) 시 뒤 모델로 넘어가며, 모든 워커가 공유한다.
let modelIndex = 0
async function acquireSlot() {
  const now = Date.now()
  const slot = Math.max(now, nextSlotAt)
  nextSlotAt = slot + CALL_SPACING_MS
  if (slot > now) await sleep(slot - now)
}

// 429 의 retryDelay("38.8s" 같은 문자열)를 밀리초로. 없으면 기본값.
function retryDelayMs(body: string): number {
  const m = body.match(/"retryDelay"\s*:\s*"([\d.]+)s"/)
  return m ? Math.ceil(Number(m[1]) * 1000) : CALL_SPACING_MS * 2
}

async function structureOne(
  apiKey: string,
  systemPrompt: string,
  cand: Candidate,
): Promise<Record<string, unknown> | null> {
  const userContent = [
    `제목: ${cand.title}`,
    cand.url && `URL: ${cand.url}`,
    '',
    cand.text,
  ].filter(Boolean).join('\n')

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: { maxOutputTokens: 2048, temperature: 0.3, responseMimeType: 'application/json' },
  })

  // 429 = 그 모델의 하루치가 끝났다는 뜻이다(대기해도 안 풀린다). 다음 모델로 넘어간다.
  while (modelIndex < GEMINI_MODELS.length) {
    const model = GEMINI_MODELS[modelIndex]
    await acquireSlot()
    const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body,
    })

    if (res.status === 429) {
      await res.text()
      // 다른 워커가 이미 모델을 넘겼을 수 있으므로 현재 값과 비교해서만 올린다.
      const exhausted = GEMINI_MODELS.indexOf(model)
      if (exhausted === modelIndex) modelIndex++
      if (modelIndex >= GEMINI_MODELS.length) {
        throw new Error(`Gemini 일일 쿼터 소진 (모델 ${GEMINI_MODELS.length}개 전부) — 다음 실행으로 이월`)
      }
      continue
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status} (${model})`)

    const data = await res.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const parsed = extractJson(text)
    if (parsed) parsed.__model = model
    return parsed
  }
  throw new Error('Gemini 일일 쿼터 소진')
}

// AI 가 어휘를 벗어난 값을 뱉으면 필터에서 걸러야 필터 UI 가 깨지지 않는다.
function sanitize(
  parsed: Record<string, unknown>,
  vocab: Vocab,
  cand: Candidate,
  src: Record<string, unknown>,
) {
  const allowed = (kind: string) => new Set((vocab[kind] ?? []).map((t) => t.value))
  const one = (kind: string, v: unknown) => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
    return allowed(kind).has(s) ? s : null
  }
  const many = (kind: string, v: unknown, cap: number) => {
    if (!Array.isArray(v)) return []
    const set = allowed(kind)
    return [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter((x) => set.has(x)))].slice(0, cap)
  }
  const scale = (v: unknown) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null
  }
  const str = (v: unknown, cap = 2000) => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s ? s.slice(0, cap) : null
  }
  const strArr = (v: unknown, cap: number) =>
    Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, cap)
      : []

  const name = str(parsed.name, 120) ?? cand.title
  const oneLiner = str(parsed.one_liner, 200)
  if (!name || !oneLiner) return null // NOT NULL 제약 — 없으면 저장 불가

  const year = Number(parsed.founded_year)

  return {
    slug: `${slugify(name)}-${shortHash(cand.sourceItemId)}`,
    name,
    one_liner: oneLiner,
    description: str(parsed.description),
    website: str(parsed.website, 500) ?? (cand.url || null),
    hq_country: str(parsed.hq_country, 80),
    region: one('region', parsed.region),
    founded_year: Number.isFinite(year) && year >= 1800 && year <= 2100 ? year : null,
    category: one('category', parsed.category) ?? 'other',
    customer_type: one('customer_type', parsed.customer_type),
    revenue_models: many('revenue_model', parsed.revenue_models, 3),
    // 해자는 2개로 제한. 남발하면 필터 축으로서 변별력이 사라진다.
    moats: many('moat', parsed.moats, 2),
    pricing_note: str(parsed.pricing_note, 300),
    capital_intensity: scale(parsed.capital_intensity),
    replicability: scale(parsed.replicability),
    korea_fit: scale(parsed.korea_fit),
    korea_note: str(parsed.korea_note, 300),
    why_it_works: str(parsed.why_it_works),
    risks: strArr(parsed.risks, 3),
    tags: strArr(parsed.tags, 6),
    traction: typeof parsed.traction === 'object' && parsed.traction ? parsed.traction : {},
    source_id: src.id,
    source_name: src.name,
    source_url: cand.url || null,
    source_item_id: cand.sourceItemId,
    ai_model: typeof parsed.__model === 'string' ? parsed.__model : GEMINI_MODELS[0],
    ai_confidence: (() => {
      const n = Number(parsed.ai_confidence)
      return Number.isFinite(n) && n >= 0 && n <= 1 ? Number(n.toFixed(2)) : null
    })(),
    status: 'published',
  }
}

// ────────────────────────────────────────────────────────────
// 핸들러
// ────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  const secret = Deno.env.get('INGEST_SECRET')
  if (!secret || req.headers.get('x-ingest-secret') !== secret) {
    return json(401, { error: 'Unauthorized' })
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  if (!geminiKey) return json(500, { error: 'GEMINI_API_KEY not configured' })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const startedAt = Date.now()
  const { data: run } = await supabase.from('ingest_runs').insert({}).select('id').single()
  const runId = run?.id

  const { data: vocabRows } = await supabase.from('taxonomy').select('kind, value, label_ko')
  const vocab: Vocab = {}
  for (const r of vocabRows ?? []) (vocab[r.kind] ??= []).push({ value: r.value, label_ko: r.label_ko })
  const systemPrompt = buildPrompt(vocab)

  const { data: sources } = await supabase
    .from('sources').select('*').eq('enabled', true).order('name')

  let fetched = 0, created = 0, skipped = 0, failed = 0, aiCalls = 0
  const errorSamples: string[] = []   // 실패 원인 진단용 샘플
  const detail: Record<string, { fetched: number; created: number; skipped: number; failed: number; error: string | null }> = {}
  const logOf = (name: string) =>
    (detail[name] ??= { fetched: 0, created: 0, skipped: 0, failed: 0, error: null })

  // ── 1) 모든 소스에서 후보를 모은다 (fetch 는 서로 독립이라 병렬)
  type Job = { src: Record<string, unknown>; cand: Candidate }
  const perSource: Job[][] = []

  await Promise.all((sources ?? []).map(async (src) => {
    const name = String(src.name)
    const log = logOf(name)
    try {
      const candidates = await loadCandidates(src)
      log.fetched = candidates.length
      fetched += candidates.length
      perSource.push(candidates.map((cand) => ({ src, cand })))
      await supabase.from('sources')
        .update({ last_run_at: new Date().toISOString(), last_status: 'ok' })
        .eq('id', src.id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error = msg
      failed++
      await supabase.from('sources')
        .update({ last_run_at: new Date().toISOString(), last_status: `error: ${msg}`.slice(0, 200) })
        .eq('id', src.id)
    }
  }))

  // ── 2) 이미 판정한 항목 제외 (한 번의 쿼리로)
  const allJobs = perSource.flat()
  const { data: seen } = await supabase
    .from('seen_items').select('source_item_id')
    .in('source_item_id', allJobs.map((j) => j.cand.sourceItemId))
  const seenSet = new Set((seen ?? []).map((s) => s.source_item_id))

  // ── 3) 소스별로 라운드로빈 배치.
  //    순차로 돌리면 알파벳 순으로 앞선 소스가 예산을 다 써버려 뒤 소스는 한 건도 처리되지 않는다.
  const queues = perSource.map((jobs) => jobs.filter((j) => {
    if (seenSet.has(j.cand.sourceItemId)) {
      logOf(String(j.src.name)).skipped++; skipped++
      return false
    }
    return true
  }))
  const queue: Job[] = []
  for (let i = 0; queues.some((q) => i < q.length); i++) {
    for (const q of queues) if (i < q.length) queue.push(q[i])
  }

  // ── 4) 워커 풀로 병렬 처리
  let cursor = 0
  // 쿼터가 말라붙은 뒤 남은 큐를 계속 태우면 전부 실패로 기록될 뿐이다 → 즉시 중단.
  let quotaHalted = false
  const budgetLeft = () =>
    !quotaHalted && aiCalls < MAX_AI_CALLS && Date.now() - startedAt < TIME_BUDGET_MS

  async function worker() {
    while (budgetLeft()) {
      const job = queue[cursor++]
      if (!job) return
      const { src, cand } = job
      const log = logOf(String(src.name))

      // 원문이 얇으면 AI 를 태우지 않고 바로 반려 — 태워도 결과가 같고 비용만 든다.
      if (cand.text.length < MIN_TEXT_CHARS) {
        await supabase.from('seen_items').insert({
          source_item_id: cand.sourceItemId, source_id: src.id, url: cand.url,
          verdict: 'rejected', reason: `원문이 너무 짧음 (${cand.text.length}자) — AI 판정 생략`,
        })
        log.skipped++; skipped++
        continue
      }

      try {
        aiCalls++
        const parsed = await structureOne(geminiKey, systemPrompt, cand)

        if (!parsed || parsed.is_business !== true) {
          await supabase.from('seen_items').insert({
            source_item_id: cand.sourceItemId, source_id: src.id, url: cand.url,
            verdict: 'rejected',
            reason: String(parsed?.reject_reason ?? 'is_business=false 또는 JSON 파싱 실패').slice(0, 300),
          })
          log.skipped++; skipped++
          continue
        }

        const row = sanitize(parsed, vocab, cand, src)
        if (!row) {
          await supabase.from('seen_items').insert({
            source_item_id: cand.sourceItemId, source_id: src.id, url: cand.url,
            verdict: 'rejected', reason: '필수 필드(name/one_liner) 누락',
          })
          log.skipped++; skipped++
          continue
        }

        const { error: insErr } = await supabase.from('businesses').insert(row)
        if (insErr) throw new Error(insErr.message)

        await supabase.from('seen_items').insert({
          source_item_id: cand.sourceItemId, source_id: src.id, url: cand.url, verdict: 'accepted',
        })
        log.created++; created++
      } catch (e) {
        // 개별 항목 실패는 삼키고 계속 — seen_items 에 남기지 않아 다음 실행에서 재시도된다.
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('쿼터 소진')) quotaHalted = true
        log.failed++; failed++
        if (errorSamples.length < 5) errorSamples.push(`[${src.name}] ${msg}`)
        console.error(`[${src.name}] ${cand.sourceItemId}:`, msg)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const summary = { fetched, created, skipped, failed, ai_calls: aiCalls, elapsed_ms: Date.now() - startedAt }
  const fullDetail = { ...detail, _errors: errorSamples }
  if (runId) {
    await supabase.from('ingest_runs')
      .update({ finished_at: new Date().toISOString(), fetched, created, skipped, failed, detail: fullDetail })
      .eq('id', runId)
  }

  return json(200, { ok: true, ...summary, detail: fullDetail })
})
