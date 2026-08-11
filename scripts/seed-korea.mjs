// 한국 검증 코퍼스(proven) 시드 — 로컬 실행 전용.
//
// ⚠️ 왜 엣지 함수가 아니라 로컬 스크립트인가
//   opendart.fss.or.kr 은 TLS 1.2 + AES128-GCM-SHA256 (RSA 키 교환, 순방향 비밀성 없음)을 쓴다.
//   Supabase 엣지 함수의 Deno 런타임은 rustls 기반이라 이 암호군을 의도적으로 지원하지 않아
//   핸드셰이크 자체가 실패한다(received fatal alert: HandshakeFailure).
//   Node 는 OpenSSL 이라 문제없이 붙으므로 한국 검증은 여기서 돌린다.
//   글로벌(Wikidata) 경로는 엣지 함수 seed-proven 이 그대로 담당한다.
//
// 흐름: 후보 생성(Gemini) → dart_corps 조회 → DART 사실 확인 → 3관문 → 축 태깅(Gemini) → insert
//
// 사용법:
//   DART_API_KEY=xx GEMINI_API_KEY=xx SUPABASE_URL=xx SUPABASE_SERVICE_ROLE_KEY=xx \
//     node scripts/seed-korea.mjs [카테고리] [개수]

const DART_KEY = process.env.DART_API_KEY
const GEMINI_KEY = process.env.GEMINI_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!DART_KEY || !GEMINI_KEY || !SUPABASE_URL || !SERVICE_KEY) {
  console.error('DART_API_KEY / GEMINI_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.')
  process.exit(1)
}

const CATEGORY = process.argv[2] || ''
const COUNT = Number(process.argv[3]) || 10

const DART_API = 'https://opendart.fss.or.kr/api'
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
// 엣지 함수와 같은 체인. 무료 티어는 모델별 하루 20회이므로 소진되면 다음 모델로 넘어간다.
const MODELS = [
  'gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite', 'gemini-3.5-flash',
]
const MIN_AGE_YEARS = 5

let modelIndex = 0

// ── Supabase REST
async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

// ── Gemini
function extractJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) { try { return JSON.parse(fenced[1]) } catch { /* fall through */ } }
  const a = text.search(/[[{]/)
  if (a === -1) return null
  const b = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (b > a) { try { return JSON.parse(text.slice(a, b + 1)) } catch { /* fall through */ } }
  return null
}

async function gemini(system, user, maxTokens = 2048) {
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4, responseMimeType: 'application/json' },
  })
  let attempts = 0
  while (modelIndex < MODELS.length && attempts < MODELS.length + 2) {
    attempts++
    const model = MODELS[modelIndex]
    const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': GEMINI_KEY },
      body,
    })
    // 404 = 그 모델이 퇴역함(2026-08 gemini-2.0-* 가 이렇게 사라졌다). 429·5xx 와 마찬가지로
    // 기다려도 회복되지 않으므로 다음 모델로 넘긴다. 여기서 안 걸러주면 체인이 죽은 모델에
    // 갇혀 남은 항목을 전부 즉시 실패시킨다.
    if (res.status === 429 || res.status === 404 || res.status >= 500) {
      await res.text()
      if (MODELS.indexOf(model) === modelIndex) modelIndex++
      if (modelIndex >= MODELS.length) throw new Error(`Gemini 전 모델 사용 불가 (${res.status})`)
      continue
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status} (${model})`)
    const data = await res.json()
    const parsed = extractJson(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
    if (parsed) parsed.__model = model
    return parsed
  }
  throw new Error('Gemini 쿼터 소진')
}

// ── DART
// SQL 의 canonical_name() 과 같은 규칙 (dart_corps.canonical 과 맞아야 조회된다)
// AI 는 "주식회사 버킷플레이스" 처럼 법인격을 **앞에** 붙이기도 한다. DART 등록명에는 없으므로
// 앞뒤 모두 떼어낸다. (SQL canonical_name() 은 접미사만 떼지만, DART 원본 이름에는 접두사가 없어 문제되지 않는다.)
function stripLegalForm(txt) {
  return String(txt ?? '')
    .replace(/^\s*((주)|㈜|주식회사|유한회사|유한책임회사)\s*/g, '')
    .replace(/\s*((주)|㈜|주식회사|유한회사|유한책임회사)\s*$/g, '')
    .trim()
}

function normalizeName(txt) {
  return stripLegalForm(txt)
    .toLowerCase().trim()
    .replace(/\s*(,)?\s*(inc\.?|llc|ltd\.?|corp\.?|corporation|co\.?|gmbh|s\.a\.|plc)\s*$/g, '')
    .replace(/[^a-z0-9가-힣]/g, '')
}

// 기업개황 팝업. 회사명·대표자·업종·**설립일**이 그대로 나와 검증 근거 링크로 적합하다.
// dsab001/main.do?corpCode= 는 corpCode 파라미터를 무시하고 빈 검색 폼만 띄운다 — 쓰면 안 된다.
const dartCorpUrl = (code) => `https://dart.fss.or.kr/dsae001/selectPopup.ax?selectKey=${code}`

// 자산유동화 특수목적법인(제일차·제이차·유동화전문 등)은 이름만 같을 뿐 사업 실체가 아니다.
const SPC_PATTERN = /(제[일이삼사오육칠팔구십]+차|유동화|전문유한|기업구조조정|리츠|사모|투자조합)/

async function fetchCompany(corpCode) {
  const res = await fetch(`${DART_API}/company.json?crtfc_key=${DART_KEY}&corp_code=${corpCode}`)
  if (!res.ok) return null
  const c = await res.json()
  if (c?.status !== '000') return null
  const est = String(c.est_dt ?? '')
  return {
    inception: est.length === 8 ? `${est.slice(0, 4)}-${est.slice(4, 6)}-${est.slice(6, 8)}` : null,
    website: c.hm_url || null,
  }
}

// 동명 법인 오탐이 실제로 났다: AI 가 "에이블리"를 주면 2002년 설립의 무관한 법인에 걸리고
// 진짜(에이블리코퍼레이션)를 놓친다. 그래서 (1) 접두 일치까지 후보로 넓히고
// (2) AI 가 준 예상 설립연도와 DART 설립연도를 대조해 고른다.
async function resolveKorean(names, foundedHint) {
  const keys = [...new Set(names.map(normalizeName).filter(Boolean))]
  if (!keys.length) return null

  const exact = await sb(`dart_corps?canonical=in.(${keys.map((k) => `"${k}"`).join(',')})&select=corp_code,corp_name,stock_code`)
  // 접두 일치로 "…코퍼레이션", "…주식회사" 같은 정식 법인명을 놓치지 않는다
  const prefix = []
  for (const n of names.filter(Boolean)) {
    const base = stripLegalForm(n)
    if (!base) continue
    const rows = await sb(`dart_corps?corp_name=like.${encodeURIComponent(base + '%')}&select=corp_code,corp_name,stock_code&limit=20`)
    prefix.push(...(rows ?? []))
  }

  const exactCodes = new Set((exact ?? []).map((r) => r.corp_code))
  const seen = new Set()
  const candidates = [...(exact ?? []), ...prefix]
    .filter((r) => !SPC_PATTERN.test(r.corp_name))
    .filter((r) => (seen.has(r.corp_code) ? false : (seen.add(r.corp_code), true)))
  if (!candidates.length) return null

  // 각 후보의 설립연도를 확인해 힌트와 가장 가까운 것을 고른다
  let best = null
  for (const cand of candidates.slice(0, 6)) {
    const info = await fetchCompany(cand.corp_code)
    if (!info?.inception) continue
    const year = Number(info.inception.slice(0, 4))
    const gap = foundedHint ? Math.abs(year - foundedHint) : 0
    // 이름이 정확히 일치하는 법인을 우선한다. 접두 일치만 되는 것은 자회사일 때가 많다
    // (와디즈 → 와디즈파이낸스처럼 본체 대신 계열사를 집는 일이 실제로 났다).
    const isExact = exactCodes.has(cand.corp_code)
    const score = gap - (isExact ? 2 : 0) - (cand.stock_code ? 1 : 0)
    if (!best || score < best.score) best = { corp: cand, info, year, gap, score }
  }
  if (!best) return null

  // 힌트와 5년 넘게 어긋나면 동명 다른 법인일 가능성이 높다 → 채택하지 않는다
  if (foundedHint && best.gap > 5) {
    return { mismatch: true, corpName: best.corp.corp_name, dartYear: best.year, hint: foundedHint }
  }

  const corp = best.corp
  const inception = best.info.inception
  const c = { hm_url: best.info.website }

  // 매출은 상장사만 조회 가능하다. 비상장은 감사보고서 원문이라 여기서 다루지 않는다.
  let revenue = null, revenueYear = null
  if (corp.stock_code) {
    const y0 = new Date().getFullYear()
    for (const y of [y0 - 1, y0 - 2]) {
      const fRes = await fetch(
        `${DART_API}/fnlttSinglAcnt.json?crtfc_key=${DART_KEY}&corp_code=${corp.corp_code}&bsns_year=${y}&reprt_code=11011`)
      if (!fRes.ok) continue
      const f = await fRes.json()
      if (f?.status !== '000') continue
      const norm = (s) => String(s ?? '').replace(/\s/g, '')
      const sales = (f.list ?? []).find((r) => norm(r.account_nm) === '매출액' && r.fs_div === 'CFS')
        ?? (f.list ?? []).find((r) => norm(r.account_nm) === '매출액')
      const amount = Number(String(sales?.thstrm_amount ?? '').replace(/,/g, ''))
      if (Number.isFinite(amount) && amount > 0) { revenue = amount; revenueYear = y; break }
    }
  }

  return {
    corpCode: corp.corp_code,
    corpName: corp.corp_name,
    listed: !!corp.stock_code,
    inception,
    website: c.hm_url || null,
    revenue,
    revenueYear,
  }
}

function judge(e) {
  const year = e.inception ? Number(e.inception.slice(0, 4)) : null
  const ageYears = year ? new Date().getFullYear() - year : null
  const reasons = []
  if (ageYears === null) reasons.push('설립연도 불명')
  else if (ageYears < MIN_AGE_YEARS) reasons.push(`업력 ${ageYears}년 (${MIN_AGE_YEARS}년 미만)`)

  // DART 등록 자체가 규모 근거다 — 비상장이라도 외부감사 대상이라야 공시 의무가 생긴다.
  const scale = e.revenue
    ? `매출 KRW ${(e.revenue / 1e8).toFixed(0)}억 (${e.revenueYear})`
    : (e.listed ? '상장법인 (DART 공시)' : '외부감사 대상 법인 (DART 공시)')

  return { pass: reasons.length === 0, ageYears, scale, reasons }
}

// ── 프롬프트 (엣지 함수 seed-proven 과 동일한 기준을 유지할 것)
const CANDIDATE_SYSTEM = `당신은 비즈니스 모델 연구자입니다. 요청받은 분야에서 **한국 회사** 중
수익 모델이 실제로 검증된 곳을 추천하세요.

기준:
- 설립 5년 이상이고 현재도 해당 사업으로 운영 중일 것
- 수익 구조가 명확히 알려져 있을 것
- 이제 막 시작한 스타트업, 폐업·피벗한 회사는 제외
- 대기업만 고르지 마세요. 중견이라도 모델이 독특하면 더 가치 있습니다.

**corp_name_kr 이 가장 중요합니다.** 전자공시(DART)에 등록된 **법인 정식명칭**을 쓰세요.
서비스명과 법인명이 다르면 반드시 법인명을 쓰세요 (배달의민족 → 우아한형제들, 토스 → 비바리퍼블리카,
당근 → 당근마켓, 오늘의집 → 버킷플레이스, 지그재그 → 카카오스타일).

JSON 만 출력. model_hint 는 30자 이내.
또한 **founded_year 에 설립연도를 추정해 적으세요** (예: 2015). 동명 법인 오탐을 걸러내는 데 씁니다.

{ "companies": [ { "name": "서비스/브랜드명", "corp_name_kr": "DART 법인명", "founded_year": 2015, "model_hint": "수익 구조" } ] }`

function buildStructurePrompt(vocab) {
  const list = (kind) => (vocab[kind] ?? []).map((t) => `${t.value}(${t.label_ko})`).join(', ')
  return `당신은 비즈니스 모델 애널리스트입니다. 주어진 한국 회사의 비즈니스 모델을 구조화하세요.
이 회사는 이미 "검증된 사업"으로 확인된 곳입니다. 당신이 아는 사실에 근거해 작성하세요.

## 절대 규칙
- **매출·투자유치·기업가치 수치는 지어내지 마세요.** 검증된 수치는 시스템이 갖고 있으므로 traction 은 비웁니다.
- 서술형 필드는 한국어로 작성합니다.
- 아래 열거된 값 외의 값을 쓰지 마세요.

## 허용 값
category: ${list('category')}
customer_type: ${list('customer_type')}
revenue_model: ${list('revenue_model')}
moat: ${list('moat')}

## 해자 판정 (엄격히)
이미 확보한 방어막만 인정합니다. moats 는 **최대 2개**, 근거가 약하면 1개, 없으면 ["none"].

## 척도 (1~5 정수)
- capital_intensity: 이 모델을 **처음 시작하는 데** 드는 자본. 그 회사의 현재 자산 규모가 아니라,
  같은 사업을 지금 새로 시작한다면 얼마가 필요한가로 판단하세요.
  1=노트북 한 대(SaaS·앱), 2=소규모 클라우드 비용, 3=상당한 GPU·초기 재고,
  4=하드웨어 양산·물류 거점, 5=공장·인허가·중장비
- replicability: 자금과 인력을 갖춘 팀이 **동등한 기능의 제품·서비스를 만드는 데** 걸리는 시간.
  **브랜드·기존 사용자 기반·규모의 경제는 여기서 세지 마세요.** 그건 해자(moats) 축이 따로 다룹니다.
  "이 회사를 이기기 어렵다"가 아니라 "이 물건을 만들기 어렵다"만 보세요.
  회사가 내세우는 기술 난이도도 그대로 믿지 마세요. 물어야 할 것은 "지금 이 시장에 비슷한 제품이
  몇 개나 있는가, 오픈소스나 기성 API 로 얼마나 대체되는가" 입니다.
  1=규제 인허가·독점 데이터·수년치 R&D 를 **이미 확보해야만** 가능 (은행 라이선스, 반도체 파운드리, 신약)
  2=수년 필요 — 양산 라인·물류 거점·대규모 실사용 데이터를 실제로 쌓아야 함 (완성차, 배터리 소재)
  3=자금이 있으면 1년 내 — 기술은 이미 알려져 있고 실행·계약·콘텐츠 확보가 관건
    (스트리밍 서비스, 이커머스 플랫폼, 가구 소매)
  4=수개월 — 기성 모델·API 조합에 도메인 지식을 얹은 수준 (대부분의 B2B SaaS)
  5=주말이면 복제 가능 — LLM API 래퍼, 표준 CRUD, 오픈소스 조립
  소개 문구만 있고 실사용 규모가 확인되지 않은 신생 서비스가 실제로 어려운 기술을 가진 경우는
  드뭅니다 — 대부분 4~5 입니다. **반대로 업력이 길거나 회사가 크다는 이유로 1~2 를 주지 마세요.**
  오래된 대기업도 제품 자체는 1년 안에 복제되는 경우가 많습니다.
- korea_fit: **이미 한국에서 검증된 모델이므로 대부분 4~5입니다.** 다만 특정 지역·규제에
  강하게 묶여 확장이 어려우면 3 이하를 주세요.

## 출력 (JSON 만)
{ "one_liner": "한 줄 요약 (40자 내외)", "description": "3~5문장", "category": "허용값",
  "customer_type": "허용값", "revenue_models": ["허용값 1~3개"], "moats": ["허용값 0~2개"],
  "pricing_note": "과금 방식 한 줄", "capital_intensity": 3, "replicability": 2, "korea_fit": 5,
  "korea_note": "한국 시장에서의 위치 한 줄", "why_it_works": "작동하는 구조적 이유 2~3문장",
  "risks": ["리스크 1~3개"], "tags": ["키워드 3~6개"], "ai_confidence": 0.8 }`
}

const slugify = (n) => (n.toLowerCase().replace(/[^a-z0-9가-힣\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60)) || 'item'
const shortHash = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 6)
}

async function main() {
  const vocabRows = await sb('taxonomy?select=kind,value,label_ko')
  const vocab = {}
  for (const r of vocabRows) (vocab[r.kind] ??= []).push(r)

  let category = CATEGORY
  if (!category) {
    const proven = await sb('businesses?tier=eq.proven&select=category')
    const tally = new Map((vocab.category ?? []).map((c) => [c.value, 0]))
    for (const r of proven) tally.set(r.category, (tally.get(r.category) ?? 0) + 1)
    category = [...tally.entries()].sort((a, b) => a[1] - b[1])[0][0]
  }
  const label = vocab.category.find((c) => c.value === category)?.label_ko ?? category
  console.log(`분야: ${label} (${category}) · ${COUNT}건 요청\n`)

  const cand = await gemini(CANDIDATE_SYSTEM, `분야: ${label}\n개수: ${COUNT}개`, 4096)
  const companies = Array.isArray(cand?.companies) ? cand.companies : []
  console.log(`후보 ${companies.length}건\n`)

  const structureSystem = buildStructurePrompt(vocab)
  let created = 0, rejected = 0, failed = 0

  for (const c of companies) {
    const name = String(c.name ?? '').trim()
    const corpKr = String(c.corp_name_kr ?? '').trim()
    try {
      const hint = Number(c.founded_year) || null
      const e = await resolveKorean([corpKr, name], hint)
      if (!e) { console.log(`  ✗ ${name}: DART 에 법인 없음 (추정 법인명: ${corpKr || name})`); rejected++; continue }
      if (e.mismatch) {
        console.log(`  ✗ ${name}: 동명 법인 의심 — DART "${e.corpName}" 설립 ${e.dartYear} vs 예상 ${e.hint}`)
        rejected++; continue
      }

      const gate = judge(e)
      if (!gate.pass) { console.log(`  ✗ ${name}: ${gate.reasons.join(', ')}`); rejected++; continue }

      const p = await gemini(structureSystem, [
        `회사명: ${name}`,
        `법인명: ${e.corpName}`,
        c.model_hint && `알려진 수익 구조: ${c.model_hint}`,
        e.inception && `설립: ${e.inception}`,
      ].filter(Boolean).join('\n'))
      if (!p) throw new Error('JSON 파싱 실패')

      const allowed = (k) => new Set((vocab[k] ?? []).map((t) => t.value))
      const one = (k, v) => (allowed(k).has(String(v ?? '').toLowerCase()) ? String(v).toLowerCase() : null)
      const many = (k, v, cap) => Array.isArray(v)
        ? [...new Set(v.map((x) => String(x).toLowerCase()).filter((x) => allowed(k).has(x)))].slice(0, cap) : []
      const scale5 = (v) => (Number.isFinite(Math.round(Number(v))) && Number(v) >= 1 && Number(v) <= 5 ? Math.round(Number(v)) : null)

      const traction = {}
      if (e.revenue) traction.revenue = `KRW ${(e.revenue / 1e8).toLocaleString()}억 (${e.revenueYear}, DART)`

      await sb('businesses', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          slug: `${slugify(name)}-${shortHash(e.corpCode)}`,
          name,
          one_liner: String(p.one_liner ?? '').slice(0, 200),
          description: p.description ?? null,
          website: e.website,
          hq_country: 'South Korea',
          region: 'korea',
          founded_year: e.inception ? Number(e.inception.slice(0, 4)) : null,
          category,
          customer_type: one('customer_type', p.customer_type),
          revenue_models: many('revenue_model', p.revenue_models, 3),
          moats: many('moat', p.moats, 2),
          pricing_note: p.pricing_note ?? null,
          capital_intensity: scale5(p.capital_intensity),
          replicability: scale5(p.replicability),
          korea_fit: scale5(p.korea_fit),
          korea_note: p.korea_note ?? null,
          why_it_works: p.why_it_works ?? null,
          risks: Array.isArray(p.risks) ? p.risks.slice(0, 3) : [],
          tags: Array.isArray(p.tags) ? p.tags.slice(0, 6) : [],
          traction,
          tier: 'proven',
          evidence: {
            source: 'dart',
            entity: e.corpCode,
            url: dartCorpUrl(e.corpCode),
            corp_name: e.corpName,
            listed: e.listed,
            inception: e.inception,
            age_years: gate.ageYears,
            scale: gate.scale,
            revenue: e.revenue,
            revenue_year: e.revenueYear,
          },
          source_name: 'DART 전자공시 검증',
          source_url: dartCorpUrl(e.corpCode),
          source_item_id: `seed:dart:${e.corpCode}`,
          ai_model: p.__model ?? MODELS[0],
          ai_confidence: Number.isFinite(Number(p.ai_confidence)) ? Number(Number(p.ai_confidence).toFixed(2)) : null,
          status: 'published',
        }),
      })
      console.log(`  ✓ ${name} (${e.corpName}) — 업력 ${gate.ageYears}년, ${gate.scale}`)
      created++
    } catch (err) {
      const msg = err.message ?? String(err)
      if (msg.includes('23505')) { console.log(`  · ${name}: 이미 등록됨`); rejected++; continue }
      console.log(`  ! ${name}: ${msg.slice(0, 120)}`)
      failed++
      if (msg.includes('쿼터') || msg.includes('사용 불가')) break
    }
  }

  console.log(`\n생성 ${created} · 반려 ${rejected} · 실패 ${failed}`)
}

main().catch((e) => { console.error('실패:', e.message); process.exit(1) })
