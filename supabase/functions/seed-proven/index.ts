// 검증된 비즈니스 모델(proven) 코퍼스를 채운다.
//
//   후보 생성(AI) → Wikidata 실체·사실 조회 → 3관문 판정 → 축 태깅(AI) → 저장
//
// 자동 수집(ingest)과 분리한 이유: 뉴스·런칭 피드에는 검증된 모델이 안 들어온다.
// 신생 스타트업의 자기소개문을 근거로 "이 모델이 작동하는 이유"를 쓰는 건 추측이므로,
// 공개 데이터로 실체와 업력이 확인된 회사만 proven 으로 따로 쌓는다.
//
// 숫자는 Wikidata 가, 구조 해석(수익모델·해자·한국 적용성)은 AI 가 담당한다. 역할을 섞지 않는다.
//
// Deploy: supabase functions deploy seed-proven --no-verify-jwt
// 호출:   POST  { "category": "fintech", "count": 8 }   (category 생략 시 가장 빈약한 카테고리 자동 선택)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODELS = [
  'gemini-flash-latest',
  'gemini-3-flash-preview',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
]

const WD_API = 'https://www.wikidata.org/w/api.php'
const WD_ENTITY = 'https://www.wikidata.org/wiki/Special:EntityData'
const UA = 'BizAtlas/0.1 (+https://github.com/JWPAPAROY/bizatlas)'

const MAX_AI_CALLS = 24
const TIME_BUDGET_MS = 95_000
const CONCURRENCY = 3
const CALL_SPACING_MS = 2_000

// 3관문
const MIN_AGE_YEARS = 5      // 업력
const MIN_SITELINKS = 3      // 저명성(위키백과 언어판 수) — 매출·직원수가 없을 때의 대체 지표

// Wikidata 에서 "기업"으로 인정할 P31(instance of) 값
const BUSINESS_TYPES = new Set([
  'Q4830453',   // business
  'Q783794',    // company
  'Q6881511',   // enterprise
  'Q891723',    // public company
  'Q1589009',   // privately held company
  'Q167037',    // corporation
  'Q219577',    // holding company
  'Q270791',    // state-owned enterprise
  'Q1058914',   // software company
  'Q18388277',  // technology company
  'Q210167',    // video game developer
  'Q43229',     // organization
])

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let nextSlotAt = 0
async function acquireSlot() {
  const now = Date.now()
  const slot = Math.max(now, nextSlotAt)
  nextSlotAt = slot + CALL_SPACING_MS
  if (slot > now) await sleep(slot - now)
}

let modelIndex = 0

function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) { try { return JSON.parse(fenced[1]) } catch { /* fall through */ } }
  const a = text.search(/[[{]/)
  if (a === -1) return null
  const b = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (b > a) { try { return JSON.parse(text.slice(a, b + 1)) } catch { /* fall through */ } }
  return null
}

async function gemini(apiKey: string, system: string, user: string, maxTokens = 2048) {
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4, responseMimeType: 'application/json' },
  })

  let attempts = 0
  while (modelIndex < GEMINI_MODELS.length && attempts < GEMINI_MODELS.length + 2) {
    attempts++
    const model = GEMINI_MODELS[modelIndex]
    await acquireSlot()
    const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body,
    })
    // 429 = 그 모델의 하루치 소진, 5xx = 일시적 과부하. 둘 다 기다려도 소용없으니 다음 모델로.
    if (res.status === 429 || res.status >= 500) {
      await res.text()
      if (GEMINI_MODELS.indexOf(model) === modelIndex) modelIndex++
      if (modelIndex >= GEMINI_MODELS.length) {
        throw new Error(`Gemini 전 모델 사용 불가 (마지막 상태 ${res.status})`)
      }
      continue
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status} (${model})`)
    const data = await res.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const parsed = extractJson(text)
    if (parsed) (parsed as Record<string, unknown>).__model = model
    return parsed
  }
  throw new Error('Gemini 일일 쿼터 소진')
}

// ────────────────────────────────────────────────────────────
// Wikidata
// ────────────────────────────────────────────────────────────
async function wdJson(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (!res.ok) return null
  return await res.json()
}

function claimIds(claims: Record<string, unknown[]>, prop: string): string[] {
  // deno-lint-ignore no-explicit-any
  return ((claims?.[prop] ?? []) as any[]).map((c) => c?.mainsnak?.datavalue?.value?.id).filter(Boolean)
}

// deno-lint-ignore no-explicit-any
function claimValue(claims: any, prop: string) {
  const c = claims?.[prop]?.[0]?.mainsnak?.datavalue?.value
  if (c == null) return null
  if (typeof c === 'object') {
    if (c.time) return String(c.time).slice(1, 11)
    if (c.amount) return Number(c.amount)
    if (c.id) return c.id
  }
  return c
}

// Wikidata 매출값에는 통화 단위가 엔티티 ID 로 붙는다. 무시하면 엔화 11.8조가 "11811B"로
// 달러처럼 보인다. 자주 쓰이는 통화만 매핑하고, 모르는 건 통화 미상으로 표기한다.
const CURRENCY: Record<string, string> = {
  Q4917: 'USD', Q8146: 'JPY', Q4916: 'EUR', Q25224: 'GBP', Q39099: 'CNY',
  Q41333: 'KRW', Q1104069: 'INR', Q4726: 'CAD', Q259502: 'AUD', Q41407: 'BRL',
  Q4915: 'CHF', Q131309: 'SEK', Q131645: 'RUB', Q200737: 'TWD', Q194339: 'HKD',
}

// 매출은 연도별로 여러 값이 달린다 → 가장 최신 것
// deno-lint-ignore no-explicit-any
function latestRevenue(claims: any) {
  let best: { amount: number; year: number; currency: string } | null = null
  for (const c of claims?.P2139 ?? []) {
    const v = c?.mainsnak?.datavalue?.value
    const amount = Number(v?.amount)
    const t = c?.qualifiers?.P585?.[0]?.datavalue?.value?.time
    if (!Number.isFinite(amount)) continue
    const unitId = String(v?.unit ?? '').split('/').pop() ?? ''
    const year = t ? Number(String(t).slice(1, 5)) : 0
    if (!best || year > best.year) {
      best = { amount, year, currency: CURRENCY[unitId] ?? '' }
    }
  }
  return best
}

// 통화 단위를 붙여 사람이 읽을 수 있게. 통화를 모르면 숫자만 쓰되 단위 미상임을 밝힌다.
function formatMoney(amount: number, currency: string): string {
  const scaled = amount >= 1e9 ? `${(amount / 1e9).toFixed(1)}B` : `${(amount / 1e6).toFixed(0)}M`
  return currency ? `${currency} ${scaled}` : `${scaled} (통화 미상)`
}

type WdEntity = {
  id: string
  labelKo?: string
  labelEn?: string
  inception: string | null
  employees: number | null
  website: string | null
  revenue: number | null
  revenueYear: number | null
  revenueCurrency: string
  sitelinks: number
  country: string | null
}

async function wdEntity(id: string): Promise<WdEntity | null> {
  const j = await wdJson(`${WD_ENTITY}/${id}.json`)
  const e = j?.entities?.[id]
  if (!e) return null
  const claims = e.claims
  const rev = latestRevenue(claims)
  const isBusiness =
    claimIds(claims, 'P31').some((t) => BUSINESS_TYPES.has(t)) || claimIds(claims, 'P452').length > 0
  if (!isBusiness) return null
  return {
    id,
    labelKo: e.labels?.ko?.value,
    labelEn: e.labels?.en?.value,
    inception: claimValue(claims, 'P571') as string | null,
    employees: claimValue(claims, 'P1128') as number | null,
    website: claimValue(claims, 'P856') as string | null,
    revenue: rev?.amount ?? null,
    revenueYear: rev?.year ?? null,
    revenueCurrency: rev?.currency ?? '',
    sitelinks: Object.keys(e.sitelinks ?? {}).length,
    country: claimIds(claims, 'P17')[0] ?? null,
  }
}

// 이름으로 검색하되 "기업 엔티티"인 첫 후보만 채택한다.
// 이 타입 검증이 없으면 쿠팡 → 인도네시아 도시 Kupang, 토스 → 스페인 주얼리 브랜드 같은 오탐이 난다.
//
// 한국어 음차 표기("코스트코 홀세일", "라쿠텐 그룹")로는 검색이 자주 실패하므로
// 영문 표제어를 우선 시도하고, 법인격 접미사를 뗀 형태까지 순서대로 훑는다.
async function resolveCompany(names: string[]): Promise<WdEntity | null> {
  const variants: string[] = []
  for (const n of names) {
    const name = (n ?? '').trim()
    if (!name) continue
    variants.push(name)
    const stripped = name
      .replace(/\s+(그룹|홀세일|코퍼레이션|주식회사|Group|Holdings|Wholesale|Corporation|Inc\.?|Ltd\.?|Co\.?)$/i, '')
      .trim()
    if (stripped && stripped !== name) variants.push(stripped)
  }

  for (const v of [...new Set(variants)]) {
    // 영문 표제어는 en, 한글명은 ko 로 찾는 게 적중률이 높다
    const lang = /[가-힣]/.test(v) ? 'ko' : 'en'
    const url = `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(v)}` +
      `&language=${lang}&uselang=${lang}&type=item&limit=6&format=json&origin=*`
    const j = await wdJson(url)
    for (const hit of j?.search ?? []) {
      const e = await wdEntity(hit.id)
      if (e) return e
    }
  }
  return null
}

type Gate = { pass: boolean; ageYears: number | null; scale: string | null; reasons: string[] }

function judge(e: WdEntity): Gate {
  const year = e.inception ? Number(e.inception.slice(0, 4)) : null
  const ageYears = year && year > 1000 ? new Date().getFullYear() - year : null
  const reasons: string[] = []

  if (ageYears === null) reasons.push('설립연도 불명')
  else if (ageYears < MIN_AGE_YEARS) reasons.push(`업력 ${ageYears}년 (${MIN_AGE_YEARS}년 미만)`)

  let scale: string | null = null
  if (e.revenue) scale = `매출 ${formatMoney(e.revenue, e.revenueCurrency)} (${e.revenueYear ?? '연도미상'})`
  else if (e.employees) scale = `직원 ${e.employees.toLocaleString()}명`
  else if (e.sitelinks >= MIN_SITELINKS) scale = `위키백과 ${e.sitelinks}개 언어판`
  if (!scale) reasons.push('규모·저명성 확인 불가')

  return { pass: reasons.length === 0, ageYears, scale, reasons }
}

// ────────────────────────────────────────────────────────────
// 프롬프트
// ────────────────────────────────────────────────────────────
const CANDIDATE_SYSTEM = `당신은 비즈니스 모델 연구자입니다. 요청받은 분야에서 **수익 모델이 실제로 검증된 회사**를 추천하세요.

기준:
- 설립 5년 이상이고 현재도 해당 사업으로 운영 중일 것
- 수익 구조가 명확히 알려져 있을 것 (어떻게 돈을 버는지 설명 가능)
- 위키백과에 문서가 있을 정도로 알려진 회사일 것
- 이제 막 시작한 스타트업, 이미 폐업한 회사, 사업을 접거나 완전히 피벗한 회사는 제외

다양성 규칙:
- 미국 회사만 나열하지 마세요. 유럽·아시아·한국·중남미 회사를 의도적으로 섞으세요.
- 수익 모델도 섞으세요 (구독만 나열하지 말고 마켓플레이스·광고·거래수수료·하드웨어 등).
- 거대 기업만 고르지 마세요. 중견 규모라도 모델이 독특하면 더 가치 있습니다.

반드시 아래 JSON 만 출력하세요. **model_hint 는 30자 이내로 짧게** 쓰세요(길면 응답이 잘립니다).

이름은 두 가지를 모두 주세요. 검증 시스템이 위키데이터를 조회하는 데 쓰므로 정확해야 합니다.
- name_en: **영어 위키백과 표제어와 똑같은** 원어/영문 정식명 (예: "Costco", "Rakuten", "Mercado Libre")
  "Wholesale", "Group", "Inc." 같은 군더더기는 표제어에 없으면 빼세요.
- name: 한국에서 통용되는 표기 (예: "코스트코", "라쿠텐"). 한국 회사면 한글명.

{ "companies": [ { "name": "한국 통용 표기", "name_en": "영어 위키백과 표제어", "country": "국가", "model_hint": "핵심 수익 구조 (30자 이내)" } ] }`

function buildStructurePrompt(vocab: Record<string, { value: string; label_ko: string }[]>): string {
  const list = (kind: string) => (vocab[kind] ?? []).map((t) => `${t.value}(${t.label_ko})`).join(', ')
  return `당신은 비즈니스 모델 애널리스트입니다. 주어진 회사의 비즈니스 모델을 구조화하세요.
이 회사는 이미 "검증된 사업"으로 확인된 곳입니다. 당신이 알고 있는 사실에 근거해 작성하세요.

## 절대 규칙
- **매출·투자유치·기업가치·직원수 같은 수치는 지어내지 마세요.** 검증된 수치는 시스템이 이미 갖고 있으므로
  traction 은 비워두세요(빈 객체). 당신은 구조 해석만 담당합니다.
- name, hq_country 를 제외한 서술형 필드는 **한국어**로 작성합니다.
- 아래 열거된 값 외의 값을 쓰지 마세요.

## 허용 값
category: ${list('category')}
customer_type: ${list('customer_type')}
revenue_model: ${list('revenue_model')}
moat: ${list('moat')}
region: ${list('region')}

## 해자 판정 (엄격히)
이미 확보한 방어막만 인정합니다. moats 는 **최대 2개**, 근거가 약하면 1개, 없으면 ["none"].
검증된 대기업이라도 해자를 남발하지 마세요. 그 회사를 실제로 지켜주는 것 1~2개만 고르세요.

## 척도 (1~5 정수) — 반드시 분포를 만드세요
- capital_intensity: 1=노트북 한 대, 3=상당한 초기 재고·설비, 5=공장·인허가·중장비
- replicability: 1=복제 거의 불가(규제·독점 데이터·수년 R&D), 3=자금 있으면 1년 내, 5=주말이면 복제
- korea_fit: **이 모델을 한국에 이식했을 때**의 적합성.
  1=규제상 불가능하거나 시장 없음, 2=국내 사업자가 이미 장악, 3=현지화 부담 큼, 4=약간의 현지화로 통함, 5=그대로 통함
  이미 한국에서 성업 중인 모델이면 5 에 가깝고, 미국 특유의 문화·제도에 묶였으면 1~2 입니다.

## 출력 (JSON 만)
{
  "one_liner": "한 줄 요약 (한국어, 40자 내외)",
  "description": "무엇을 누구에게 어떻게 파는지 3~5문장 (한국어)",
  "hq_country": "본사 국가 영문명",
  "region": "허용값",
  "category": "허용값",
  "customer_type": "허용값",
  "revenue_models": ["허용값 1~3개"],
  "moats": ["허용값 0~2개"],
  "pricing_note": "실제 과금 방식 한 줄 (한국어)",
  "capital_intensity": 3,
  "replicability": 2,
  "korea_fit": 4,
  "korea_note": "한국 적용성 점수의 근거 한 줄 (한국어)",
  "why_it_works": "이 모델이 작동하는 구조적 이유 2~3문장 (한국어). 표면 설명 말고 구조를 쓸 것.",
  "risks": ["구조적 리스크 1~3개 (한국어)"],
  "tags": ["검색용 키워드 3~6개"],
  "ai_confidence": 0.8
}`
}

// ────────────────────────────────────────────────────────────
function slugify(name: string): string {
  return (name.toLowerCase().replace(/[^a-z0-9가-힣\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60)) || 'item'
}
function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 6)
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const secret = Deno.env.get('INGEST_SECRET')
  if (!secret || req.headers.get('x-ingest-secret') !== secret) return json(401, { error: 'Unauthorized' })

  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  if (!geminiKey) return json(500, { error: 'GEMINI_API_KEY not configured' })

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const startedAt = Date.now()

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* 기본값 사용 */ }

  const { data: vocabRows } = await supabase.from('taxonomy').select('kind, value, label_ko')
  const vocab: Record<string, { value: string; label_ko: string }[]> = {}
  for (const r of vocabRows ?? []) (vocab[r.kind] ??= []).push({ value: r.value, label_ko: r.label_ko })

  // 카테고리 미지정이면 proven 이 가장 적은 카테고리를 고른다 → 반복 호출만으로 균형이 맞는다.
  let category = typeof body.category === 'string' ? body.category : ''
  if (!category) {
    const { data: counts } = await supabase
      .from('businesses').select('category').eq('tier', 'proven')
    const tally = new Map<string, number>()
    for (const c of vocab.category ?? []) tally.set(c.value, 0)
    for (const r of counts ?? []) tally.set(r.category, (tally.get(r.category) ?? 0) + 1)
    category = [...tally.entries()].sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'other'
  }
  const count = Math.min(Number(body.count) || 10, 15)
  const categoryLabel = vocab.category?.find((c) => c.value === category)?.label_ko ?? category

  const log = { category, requested: count, candidates: 0, resolved: 0, gated: 0, created: 0, failed: 0 }
  const rejected: string[] = []
  const errors: string[] = []

  try {
    // ── 1) 후보 명단
    const koreaBias = body.region === 'korea'
      ? '\n\n**이번에는 반드시 한국 회사만 추천하세요.**'
      : ''
    // 응답이 토큰 상한에서 잘리면 JSON 이 깨져 후보가 0건이 된다. 넉넉히 준다.
    const candidateRes = await gemini(
      geminiKey,
      CANDIDATE_SYSTEM,
      `분야: ${categoryLabel}\n개수: ${count}개${koreaBias}`,
      4096,
    )
    if (!candidateRes) throw new Error('후보 명단 JSON 파싱 실패 (응답 잘림 가능성)')
    const companies = Array.isArray(candidateRes.companies) ? candidateRes.companies : []
    if (!companies.length) throw new Error(`후보 명단이 비어 있음 (응답 키: ${Object.keys(candidateRes).join(',')})`)
    log.candidates = companies.length

    // ── 2) Wikidata 검증 (AI 아님 → 병렬로 빠르게)
    const verified: { name: string; hint: string; e: WdEntity; gate: Gate }[] = []
    await Promise.all(companies.slice(0, count).map(async (c: Record<string, unknown>) => {
      const name = String(c?.name ?? '').trim()
      const nameEn = String(c?.name_en ?? '').trim()
      if (!name && !nameEn) return
      try {
        // 영문 표제어를 먼저 시도한다 (한국어 음차보다 위키데이터 적중률이 훨씬 높다)
        const e = await resolveCompany([nameEn, name])
        if (!e) { rejected.push(`${name}: 위키데이터에 기업 엔티티 없음`); return }
        log.resolved++
        const gate = judge(e)
        if (!gate.pass) { rejected.push(`${name}: ${gate.reasons.join(', ')}`); return }
        log.gated++
        verified.push({ name, hint: String(c?.model_hint ?? ''), e, gate })
      } catch (err) {
        rejected.push(`${name}: 조회 실패 (${err instanceof Error ? err.message : err})`)
      }
    }))

    // ── 3) 축 태깅 후 저장
    const structureSystem = buildStructurePrompt(vocab)
    let aiCalls = 1 // 후보 생성 1회
    let cursor = 0

    async function worker() {
      while (aiCalls < MAX_AI_CALLS && Date.now() - startedAt < TIME_BUDGET_MS) {
        const item = verified[cursor++]
        if (!item) return
        const { name, hint, e, gate } = item
        try {
          aiCalls++
          const userMsg = [
            `회사명: ${name}`,
            e.labelKo && e.labelKo !== name ? `한국어 표기: ${e.labelKo}` : '',
            hint && `알려진 수익 구조: ${hint}`,
            e.inception && `설립: ${e.inception}`,
            e.website && `웹사이트: ${e.website}`,
          ].filter(Boolean).join('\n')

          const p = await gemini(geminiKey, structureSystem, userMsg)
          if (!p) throw new Error('JSON 파싱 실패')

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

          const oneLiner = str(p.one_liner, 200)
          if (!oneLiner) throw new Error('one_liner 누락')

          // 검증된 수치는 Wikidata 값만 넣는다 (AI 가 만든 숫자는 쓰지 않는다)
          const traction: Record<string, string> = {}
          if (e.revenue) {
            traction.revenue = `${formatMoney(e.revenue, e.revenueCurrency)} (${e.revenueYear ?? '연도미상'}, Wikidata)`
          }
          // 직원수는 traction 스키마(revenue/users/funding/valuation)에 없으므로 evidence 에만 남긴다.

          const { error: insErr } = await supabase.from('businesses').insert({
            slug: `${slugify(name)}-${shortHash(e.id)}`,
            name,
            one_liner: oneLiner,
            description: str(p.description),
            website: e.website ?? str(p.website, 500),
            hq_country: str(p.hq_country, 80),
            region: one('region', p.region),
            founded_year: e.inception ? Number(e.inception.slice(0, 4)) || null : null,
            category,
            customer_type: one('customer_type', p.customer_type),
            revenue_models: many('revenue_model', p.revenue_models, 3),
            moats: many('moat', p.moats, 2),
            pricing_note: str(p.pricing_note, 300),
            capital_intensity: scale(p.capital_intensity),
            replicability: scale(p.replicability),
            korea_fit: scale(p.korea_fit),
            korea_note: str(p.korea_note, 300),
            why_it_works: str(p.why_it_works),
            risks: Array.isArray(p.risks) ? p.risks.map(String).slice(0, 3) : [],
            tags: Array.isArray(p.tags) ? p.tags.map(String).slice(0, 6) : [],
            traction,
            tier: 'proven',
            evidence: {
              source: 'wikidata',
              entity: e.id,
              url: `https://www.wikidata.org/wiki/${e.id}`,
              inception: e.inception,
              age_years: gate.ageYears,
              scale: gate.scale,
              revenue: e.revenue,
              revenue_year: e.revenueYear,
              revenue_currency: e.revenueCurrency,
              employees: e.employees,
              sitelinks: e.sitelinks,
            },
            source_name: 'Wikidata 검증',
            source_url: `https://www.wikidata.org/wiki/${e.id}`,
            source_item_id: `seed:${e.id}`,
            ai_model: typeof p.__model === 'string' ? p.__model : GEMINI_MODELS[0],
            ai_confidence: (() => {
              const n = Number(p.ai_confidence)
              return Number.isFinite(n) && n >= 0 && n <= 1 ? Number(n.toFixed(2)) : null
            })(),
            status: 'published',
          })

          if (insErr) {
            // 중복(canonical_key / source_item_id)은 정상 동작이다 — 이미 있는 회사
            if (insErr.code === '23505') { rejected.push(`${name}: 이미 등록됨`); continue }
            throw new Error(insErr.message)
          }
          log.created++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.failed++
          if (errors.length < 5) errors.push(`${name}: ${msg}`)
          if (msg.includes('쿼터 소진')) return
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }

  return json(200, {
    ok: true,
    ...log,
    elapsed_ms: Date.now() - startedAt,
    rejected: rejected.slice(0, 15),
    errors,
  })
})
