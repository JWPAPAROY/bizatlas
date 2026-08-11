// 1~5 척도 재평가.
//
// 앵커(각 점수의 정의)를 바꾸거나 파이프라인 간 기준을 통일했을 때, 기존 데이터는 옛 기준으로
// 매겨진 값이라 새 데이터와 섞이면 축이 의미를 잃는다. 이 스크립트로 전체를 같은 기준에 맞춘다.
//
// **점수 세 축과 korea_note 만 갱신한다.** 검증된 사실(evidence·traction·설립연도)과
// 분류 태그는 건드리지 않는다 — 재평가 대상이 아니고, 건드리면 검증의 의미가 사라진다.
//
// 사용법:
//   GEMINI_API_KEY=xx SUPABASE_URL=xx SUPABASE_SERVICE_ROLE_KEY=xx node scripts/rescore.mjs [건수]

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
  'gemini-3.1-flash-lite', 'gemini-3.5-flash',
]
let modelIndex = 0

// 세 파이프라인(ingest / seed-proven / seed-korea)과 문구가 같아야 한다.
// 여기만 바꾸면 재평가 결과가 신규 수집분과 또 어긋난다.
const SYSTEM = `당신은 비즈니스 모델 애널리스트입니다. 주어진 회사의 구조 지표 세 개를 1~5 정수로 매기세요.

## 척도 — 반드시 분포를 만드세요
모든 항목에 비슷한 점수를 주면 이 데이터는 쓸모가 없어집니다. 아래 기준을 문자 그대로 적용하고,
애매하면 중간(3)이 아니라 근거가 가리키는 쪽으로 확실히 기울이세요.

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
    generationConfig: { maxOutputTokens: 1024, temperature: 0.3, responseMimeType: 'application/json' },
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
      if (modelIndex >= MODELS.length) throw new Error('QUOTA')
      continue
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status} (${model})`)
    const data = await res.json()
    const parsed = extractJson(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
    if (parsed) parsed.__model = model
    return parsed
  }
  throw new Error('QUOTA')
}

const scale = (v) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null
}

async function main() {
  // 아직 재평가되지 않은 것(scored_at is null)만 고른다. 쿼터 때문에 한 번에 못 끝나므로
  // 이어서 돌릴 수 있어야 한다. 앵커를 또 바꾸면 `update businesses set scored_at = null` 로
  // 전체를 다시 대상에 넣으면 된다.
  const rows = await sb(
    `businesses?scored_at=is.null&select=id,name,slug,tier,category,customer_type,revenue_models,one_liner,description,why_it_works,capital_intensity,replicability,korea_fit&order=created_at&limit=${LIMIT}`)
  console.log(`재평가 대상 ${rows.length}건 (이미 끝난 것은 제외)\n`)

  let done = 0, changed = 0, failed = 0
  const shifts = []

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
      ].filter(Boolean).join('\n')

      const p = await gemini(user)
      if (!p) throw new Error('JSON 파싱 실패')

      const next = {
        capital_intensity: scale(p.capital_intensity),
        replicability: scale(p.replicability),
        korea_fit: scale(p.korea_fit),
      }
      if (next.capital_intensity == null || next.replicability == null || next.korea_fit == null) {
        throw new Error('점수 누락')
      }
      if (typeof p.korea_note === 'string' && p.korea_note.trim()) {
        next.korea_note = p.korea_note.trim().slice(0, 300)
      }

      const moved =
        b.capital_intensity !== next.capital_intensity ||
        b.replicability !== next.replicability ||
        b.korea_fit !== next.korea_fit

      next.scored_at = new Date().toISOString()
      await sb(`businesses?id=eq.${b.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(next),
      })

      done++
      if (moved) {
        changed++
        shifts.push(`${b.name}: 자본 ${b.capital_intensity}→${next.capital_intensity} · 복제 ${b.replicability}→${next.replicability} · 한국 ${b.korea_fit}→${next.korea_fit}`)
      }
      process.stdout.write(moved ? '*' : '.')
    } catch (e) {
      if (e.message === 'QUOTA') {
        console.log('\n\n쿼터 소진 — 여기까지 저장됨. 리셋 후 다시 실행하면 이어서 진행됩니다.')
        break
      }
      failed++
      process.stdout.write('!')
    }
  }

  console.log(`\n\n재평가 ${done}건 · 점수 변경 ${changed}건 · 실패 ${failed}건`)
  if (shifts.length) {
    console.log('\n변경 내역:')
    shifts.forEach((s) => console.log('  ' + s))
  }
}

main().catch((e) => { console.error('실패:', e.message); process.exit(1) })
