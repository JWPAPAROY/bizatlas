// 유지보수 — 재평가 · 판단 층 · 승격을 Supabase 안에서 돈다.
//
// 왜 옮겼나: 이 셋은 원래 로컬 Node 스크립트(scripts/rescore.mjs · enrich-decision.mjs)로만
// 돌아서 노트북이 켜져 있어야 진행됐다. 밀려도 유실되진 않지만(scored_at·decided_at 으로
// 이어서 실행됨) 신규 항목이 며칠씩 점수 없이 화면에 남는다.
// 두 스크립트는 fetch 만 쓰므로 Deno 에서 그대로 돈다 — 로컬이어야 할 이유가 없었다.
// (seed-korea 만은 계속 로컬이어야 한다. DART 가 Deno rustls 와 TLS 암호군이 안 맞는다.)
//
// 순서가 곧 우선순위다. 점수 세 축은 필터·비교의 근거라 판단 층보다 먼저 채운다.
// 승격은 AI 를 안 쓰므로 쿼터와 무관하게 마지막에 항상 돈다.
//
// Deploy: supabase functions deploy maintain --no-verify-jwt
// 호출:   POST { "rescore": 12, "enrich": 12, "promote": true }  (전부 선택)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

// ingest · seed-proven · 로컬 스크립트와 같은 체인이어야 한다.
// 404(모델 퇴역)를 폴백 조건에 넣는 이유는 README 참조.
const GEMINI_MODELS = [
  'gemini-flash-latest',
  'gemini-3-flash-preview',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
]

// 엣지 함수 150초 idle timeout. 새 호출 시작은 95초에서 멈춘다.
const TIME_BUDGET_MS = 95_000
const MAX_AI_CALLS = 24
const CONCURRENCY = 3
const CALL_SPACING_MS = 2_000

let modelIndex = 0
let nextSlotAt = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function acquireSlot() {
  const now = Date.now()
  const slot = Math.max(now, nextSlotAt)
  nextSlotAt = slot + CALL_SPACING_MS
  if (slot > now) await sleep(slot - now)
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) { try { return JSON.parse(fenced[1]) } catch { /* fall through */ } }
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a !== -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)) } catch { /* fall through */ } }
  return null
}

async function gemini(apiKey: string, system: string, user: string, maxTokens: number) {
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3, responseMimeType: 'application/json' },
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
    if (res.status === 429 || res.status === 404 || res.status >= 500) {
      await res.text()
      if (GEMINI_MODELS.indexOf(model) === modelIndex) modelIndex++
      if (modelIndex >= GEMINI_MODELS.length) throw new Error('QUOTA')
      continue
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status} (${model})`)
    const data = await res.json()
    return extractJson(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
  }
  throw new Error('QUOTA')
}

// ────────────────────────────────────────────────────────────
// 프롬프트 — scripts/rescore.mjs · scripts/enrich-decision.mjs 와 **문구가 같아야 한다**.
// 여기만 바꾸면 같은 축인데 실행 경로에 따라 다른 잣대가 적용된다.
// ────────────────────────────────────────────────────────────
const SCORE_SYSTEM =
  `당신은 비즈니스 모델 애널리스트입니다. 주어진 회사의 구조 지표 세 개를 1~5 정수로 매기세요.

## 척도 — 반드시 분포를 만드세요
모든 항목에 비슷한 점수를 주면 이 데이터는 쓸모가 없어집니다. 아래 기준을 문자 그대로 적용하고,
애매하면 중간(3)이 아니라 근거가 가리키는 쪽으로 확실히 기울이세요.

- capital_intensity: 이 모델을 **처음 시작하는 데** 드는 자본. 그 회사의 현재 자산 규모가 아니라,
  같은 사업을 지금 새로 시작한다면 얼마가 필요한가로 판단하세요.
  **설비·재고 같은 물건값만 세지 마세요.** 인허가에 걸린 **최소 자본금 요건·보증금·지급준비금**,
  콘텐츠·라이선스 선투자도 똑같이 초기 자본입니다.
  규제 산업(은행·증권·보험·대부·의료·통신)은 결과물이 앱 하나여도 인가 자본금 때문에 4~5 입니다 —
  화면만 보고 1~2 를 주지 마세요.
  1=노트북 한 대 (SaaS·앱)
  2=소규모 클라우드 비용
  3=상당한 GPU·초기 재고·콘텐츠 선투자
  4=하드웨어 양산·물류 거점, 또는 인허가 자본금이 필요한 사업 (결제·대부·보험 대리)
  5=공장·중장비, 또는 대규모 인가 자본금 (은행·증권·보험 본체, 반도체, 통신)
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
- korea_fit: 이 모델을 **한국에 그대로 이식**했을 때의 적합성.
  1=한국 규제상 불가능하거나 시장이 없음, 2=국내 사업자가 이미 장악해 진입 무의미,
  3=가능하지만 현지화 부담이 큼, 4=약간의 현지화로 통함,
  5=**한국에서 같은 수요가 이미 실증됐고(비슷한 서비스가 실제로 돈을 벌고 있음) 아직 지배적
    사업자가 없는 경우에만.** "잘 통할 것 같다"는 기대는 5가 아니라 4 입니다.
  판단 시 반드시 고려: 한국의 규제(의료·금융·개인정보), 시장 규모, 이미 있는 국내 대체재,
  영어권 전용 워크플로 의존 여부. 미국 기업 문화·SaaS 구매 관행에 강하게 묶인 B2B 도구는 2~3 입니다.
  이미 한국에서 성업 중인 모델이면 5 에 가깝습니다.

## 출력 (JSON 만)
{ "capital_intensity": 3, "replicability": 2, "korea_fit": 4,
  "korea_note": "한국 적용성 점수의 근거 한 줄 (한국어)" }`

const DECIDE_SYSTEM = `당신은 한국에서 사업을 검토하는 사람을 돕는 애널리스트입니다.
주어진 비즈니스 모델을 **한국에서 시작한다면** 무엇을 알아야 하는지 정리하세요.

## 절대 규칙 — 지어내지 마세요
- korea_analogs 는 **실재하는 한국 회사명**입니다. 확실히 아는 곳만 적으세요.
  애매하면 빈 배열로 두세요. **틀린 회사명을 적는 것이 비어 있는 것보다 훨씬 나쁩니다.**
- 없으면 없는 대로가 정보입니다. 억지로 채우지 마세요.

## 각 항목
- korea_analogs: 한국에서 **같은 모델**로 사업하는 회사 0~4개. 비슷한 업종이 아니라
  수익 구조가 같은 곳이어야 합니다. 확실한 것만.
- korea_analog_note: 국내 경쟁 지형 한 줄. 이미 장악됐는지, 빈틈이 있는지, 왜 아직 없는지.
  유사 사업자가 없다면 "왜 없는가"가 핵심입니다 (규제·시장 크기·문화 등).
- startup_scale: 이 모델을 한국에서 **최소 규모로 시작할 때** 드는 것을 구체적으로.
  금액 범위와 그 돈이 어디에 쓰이는지를 함께. 예: "초기 3~5천만원 — 개발 외주와 6개월 운영비.
  재고나 인허가 비용은 없음". 모르면 null.
- regulatory_notes: 한국에서 이 사업을 할 때 걸리는 **인허가·규제** 0~3개.
  해당 없으면 빈 배열. 근거 없는 추측 금지. 예: "전자금융업 등록 필요(금융위)",
  "의료법상 원격진료 제한", "개인정보보호법상 민감정보 처리 동의 절차".

## 출력 (JSON 만)
{ "korea_analogs": ["회사명"], "korea_analog_note": "한 줄", "startup_scale": "한 줄", "regulatory_notes": ["항목"] }`

const scale5 = (v: unknown) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null
}
const str = (v: unknown, cap: number) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s.slice(0, cap) : null
}
const strArr = (v: unknown, cap: number) =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, cap) : []

// deno-lint-ignore no-explicit-any
function subject(b: any, withCapital = false): string {
  return [
    `회사명: ${b.name}`,
    `산업: ${b.category}`,
    b.customer_type && `고객 유형: ${b.customer_type}`,
    b.revenue_models?.length && `수익 모델: ${b.revenue_models.join(', ')}`,
    `한 줄 요약: ${b.one_liner}`,
    b.description && `개요: ${b.description}`,
    b.why_it_works && `작동 이유: ${b.why_it_works}`,
    withCapital && b.capital_intensity && `자본 집약도 점수: ${b.capital_intensity}/5`,
  ].filter(Boolean).join('\n')
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
  try { body = await req.json() } catch { /* 기본값 */ }

  const wantRescore = Math.min(Number(body.rescore ?? 12), 40)
  const wantEnrich = Math.min(Number(body.enrich ?? 12), 40)
  const wantPromote = body.promote !== false

  let aiCalls = 0
  let quotaHalted = false
  const budgetLeft = () =>
    !quotaHalted && aiCalls < MAX_AI_CALLS && Date.now() - startedAt < TIME_BUDGET_MS

  const log = { rescored: 0, enriched: 0, promoted: 0, failed: 0, ai_calls: 0, quota_halted: false }
  const errors: string[] = []

  // deno-lint-ignore no-explicit-any
  async function runPool(rows: any[], handle: (b: any) => Promise<void>) {
    let cursor = 0
    const worker = async () => {
      while (budgetLeft()) {
        const b = rows[cursor++]
        if (!b) return
        try {
          aiCalls++
          await handle(b)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg === 'QUOTA') { quotaHalted = true; return }
          log.failed++
          if (errors.length < 5) errors.push(`${b.name}: ${msg}`)
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  }

  // ── 1) 재평가 (점수 세 축은 필터·비교의 근거라 먼저 채운다)
  if (wantRescore > 0) {
    const { data: rows } = await supabase
      .from('businesses')
      .select('id, name, category, customer_type, revenue_models, one_liner, description, why_it_works')
      .is('scored_at', null).eq('status', 'published')
      .order('created_at', { ascending: true }).limit(wantRescore)

    await runPool(rows ?? [], async (b) => {
      const p = await gemini(geminiKey, SCORE_SYSTEM, subject(b), 1024)
      if (!p) throw new Error('JSON 파싱 실패')
      const next: Record<string, unknown> = {
        capital_intensity: scale5(p.capital_intensity),
        replicability: scale5(p.replicability),
        korea_fit: scale5(p.korea_fit),
        scored_at: new Date().toISOString(),
      }
      if (next.capital_intensity == null || next.replicability == null || next.korea_fit == null) {
        throw new Error('점수 누락')
      }
      const note = str(p.korea_note, 300)
      if (note) next.korea_note = note
      const { error } = await supabase.from('businesses').update(next).eq('id', b.id)
      if (error) throw new Error(error.message)
      log.rescored++
    })
  }

  // ── 2) 판단 층
  if (wantEnrich > 0 && budgetLeft()) {
    const { data: rows } = await supabase
      .from('businesses')
      .select('id, name, category, customer_type, revenue_models, one_liner, description, why_it_works, capital_intensity')
      .is('decided_at', null).eq('status', 'published')
      .order('tier', { ascending: true }).order('created_at', { ascending: true }).limit(wantEnrich)

    await runPool(rows ?? [], async (b) => {
      const p = await gemini(geminiKey, DECIDE_SYSTEM, subject(b, true), 1536)
      if (!p) throw new Error('JSON 파싱 실패')
      const { error } = await supabase.from('businesses').update({
        korea_analogs: strArr(p.korea_analogs, 4),
        korea_analog_note: str(p.korea_analog_note, 300),
        startup_scale: str(p.startup_scale, 400),
        regulatory_notes: strArr(p.regulatory_notes, 3),
        decided_at: new Date().toISOString(),
      }).eq('id', b.id)
      if (error) throw new Error(error.message)
      log.enriched++
    })
  }

  // ── 3) 승격 — AI 를 안 쓰므로 쿼터가 말라도 항상 돈다.
  //    seed-proven 의 promote 모드를 그대로 호출한다 (검증 로직을 두 벌로 만들지 않는다).
  if (wantPromote) {
    try {
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/seed-proven`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret },
        body: JSON.stringify({ mode: 'promote', limit: 60 }),
      })
      const j = await res.json()
      log.promoted = Array.isArray(j?.promoted) ? j.promoted.length : 0
    } catch (e) {
      errors.push(`승격 실패: ${e instanceof Error ? e.message : e}`)
    }
  }

  log.ai_calls = aiCalls
  log.quota_halted = quotaHalted

  // 남은 일감을 함께 돌려준다 — 한 번에 다 못 끝내는 게 정상이라 진행 상황이 보여야 한다.
  const { count: leftScore } = await supabase.from('businesses')
    .select('id', { count: 'exact', head: true }).is('scored_at', null).eq('status', 'published')
  const { count: leftDecide } = await supabase.from('businesses')
    .select('id', { count: 'exact', head: true }).is('decided_at', null).eq('status', 'published')

  return json(200, {
    ok: true, ...log,
    remaining: { rescore: leftScore ?? 0, enrich: leftDecide ?? 0 },
    elapsed_ms: Date.now() - startedAt,
    errors,
  })
})
