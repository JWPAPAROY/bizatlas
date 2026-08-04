// "판단 층" 생성 — 한국 내 유사 사업자 · 최소 시작 규모 · 규제 체크포인트.
//
// 축 세 개는 비교를 가능하게 하지만 거기서 행동이 안 나온다. 자본 3점이 구체적으로 얼마인지,
// 한국에 이미 하는 곳이 있는지, 인허가가 필요한지를 알아야 판단으로 넘어간다.
//
// ⚠️ 여기서 만드는 값은 전부 AI 해석이며 korea_analogs 는 실재 회사명이라 환각 위험이 크다.
//    프롬프트에서 "확실한 것만, 모르면 빈 배열"을 강하게 요구하고, 화면에도 그렇게 표시한다.
//
// 사용법:
//   GEMINI_API_KEY=xx SUPABASE_URL=xx SUPABASE_SERVICE_ROLE_KEY=xx node scripts/enrich-decision.mjs [건수]

const GEMINI_KEY = process.env.GEMINI_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!GEMINI_KEY || !SUPABASE_URL || !SERVICE_KEY) {
  console.error('GEMINI_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.')
  process.exit(1)
}

const LIMIT = Number(process.argv[2]) || 100

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const MODELS = [
  'gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite',
]
let modelIndex = 0

const SYSTEM = `당신은 한국에서 사업을 검토하는 사람을 돕는 애널리스트입니다.
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

function extractJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) { try { return JSON.parse(fenced[1]) } catch { /* fall through */ } }
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a !== -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)) } catch { /* fall through */ } }
  return null
}

async function gemini(user) {
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: 1536, temperature: 0.3, responseMimeType: 'application/json' },
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
    if (res.status === 429 || res.status >= 500) {
      await res.text()
      if (MODELS.indexOf(model) === modelIndex) modelIndex++
      if (modelIndex >= MODELS.length) throw new Error('QUOTA')
      continue
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status} (${model})`)
    const data = await res.json()
    return extractJson(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
  }
  throw new Error('QUOTA')
}

const strArr = (v, cap) =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, cap) : []
const str = (v, cap) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s.slice(0, cap) : null
}

async function main() {
  const rows = await sb(
    `businesses?decided_at=is.null&select=id,name,category,customer_type,revenue_models,one_liner,description,why_it_works,capital_intensity,korea_fit&order=tier,created_at&limit=${LIMIT}`)
  console.log(`대상 ${rows.length}건 (이미 끝난 것은 제외)\n`)

  let done = 0, failed = 0, withAnalogs = 0, withReg = 0

  for (const b of rows) {
    try {
      const user = [
        `회사명: ${b.name}`,
        `산업: ${b.category}`,
        b.customer_type && `고객 유형: ${b.customer_type}`,
        b.revenue_models?.length && `수익 모델: ${b.revenue_models.join(', ')}`,
        `한 줄 요약: ${b.one_liner}`,
        b.description && `개요: ${b.description}`,
        b.why_it_works && `작동 이유: ${b.why_it_works}`,
        b.capital_intensity && `자본 집약도 점수: ${b.capital_intensity}/5`,
      ].filter(Boolean).join('\n')

      const p = await gemini(user)
      if (!p) throw new Error('JSON 파싱 실패')

      const next = {
        korea_analogs: strArr(p.korea_analogs, 4),
        korea_analog_note: str(p.korea_analog_note, 300),
        startup_scale: str(p.startup_scale, 400),
        regulatory_notes: strArr(p.regulatory_notes, 3),
        decided_at: new Date().toISOString(),
      }

      await sb(`businesses?id=eq.${b.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(next),
      })

      done++
      if (next.korea_analogs.length) withAnalogs++
      if (next.regulatory_notes.length) withReg++
      process.stdout.write(next.korea_analogs.length ? '*' : '.')
    } catch (e) {
      if (e.message === 'QUOTA') {
        console.log('\n\n쿼터 소진 — 여기까지 저장됨. 리셋 후 다시 실행하면 이어서 진행됩니다.')
        break
      }
      failed++
      process.stdout.write('!')
    }
  }

  console.log(`\n\n생성 ${done}건 · 실패 ${failed}건`)
  console.log(`  국내 유사 사업자 찾은 것 ${withAnalogs}건 · 규제 항목 있는 것 ${withReg}건`)
}

main().catch((e) => { console.error('실패:', e.message); process.exit(1) })
