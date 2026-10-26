// 기회 깔때기 — 해외 패턴 → 한국판 기회 카드 → 데스크 검증. GitHub Actions 가 매주 월요일에 돌린다.
//
// ① 패턴 감지: 분야별로 회사 목록을 AI 에게 주고 "같은 고객의 같은 문제를 푸는 회사 묶음"을 받는다.
//    업종 태그(AI·핀테크)로 묶으면 문제가 아니라 업종이 나온다 — 태그의 77% 가 1회성이고 상위는 업종 수준(실측).
//    **AI 는 묶기만 한다.** 회사 수·국가 수·투자 건수·자본 부담은 코드가 businesses 에서 다시 센다.
//    해외 2개국 이상 + 해외 3곳 이상이 아니면 버린다. 한국 회사가 묶이면 그건 선례가 아니라 국내 경쟁 증거다.
// ② 기회 카드: 아직 카드가 없는 패턴 중 신호가 센 순서로 MAX_CARDS 개만 AI 가 한국 가설로 바꾼다.
// ③ 데스크 검증: 국내 경쟁 후보 이름을 DART 법인과 **정확 일치**로 대조하고(코드), 판정 규칙도 코드에 있다.
//    수요(검색량)는 AI 에게 묻지 않는다 — 숫자를 지어낸다. 카드에 검색어를 남기고 사람이 트렌드 링크로 확인한다.
//    Gemini 검색 연동은 무료 키에서 429(2026-10-26 실측: 같은 모델의 일반 호출은 200)라 쓰지 않는다.
//
// 사람이 stage 를 field·go·killed 로 옮긴 기회는 이 스크립트가 되돌리지 않는다(upsert_opportunity 참조).
//
// 사용법:
//   SUPABASE_URL=xx SUPABASE_ANON_KEY=xx GEMINI_API_KEY=xx [OPPORTUNITY_SECRET=xx] \
//     [TELEGRAM_BOT_TOKEN=xx TELEGRAM_CHAT_ID=xx] node scripts/opportunities.mjs [--max-cards=3] [--only=health]
//   OPPORTUNITY_SECRET 이 없으면 DB 에 쓰지 않고 미리보기만 한다(DART 대조도 건너뜀).

const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_ANON_KEY
const GEMINI = process.env.GEMINI_API_KEY
const SECRET = process.env.OPPORTUNITY_SECRET
if (!URL_ || !KEY || !GEMINI) {
  console.error('SUPABASE_URL / SUPABASE_ANON_KEY / GEMINI_API_KEY 가 필요합니다.')
  process.exit(2)
}
const DRY = !SECRET

const SITE = 'https://jwpaparoy.github.io/bizatlas/#'
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const argOf = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const MAX_CARDS = Number(argOf('max-cards') ?? 3)
const ONLY = argOf('only')
const MIN_FOREIGN = 3          // 해외 선례 최소 회사 수
const MIN_COUNTRIES = 2        // 해외 선례 최소 국가 수
const SOLO_CAP = 3.5           // 선례 자본 부담 평균이 이보다 크면 혼자 시작하기 어렵다고 본다
const RECENT_DAYS = 60
const KOREA = new Set(['south korea', 'korea', 'republic of korea'])

// 사고하지 않는 가벼운 모델 우선. 사고형은 사고 토큰도 출력 한도에서 깎이므로 한도를 넉넉히(maintain 정지 사건).
const MODELS = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-flash-latest']

async function sb(path) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { ...H, Range: `${from}-${from + 999}` } })
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const page = await res.json()
    rows.push(...page)
    if (page.length < 1000) return rows
  }
}

async function rpc(fn, body) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${fn} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

let modelUsed = null
async function gemini(system, user, { timeout = 90_000 } = {}) {
  for (const model of MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeout),
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': GEMINI },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: 16384, temperature: 0.2, responseMimeType: 'application/json' },
        }),
      })
      // 429(쿼터)·404(퇴역)·5xx 는 다음 모델로 — 404 를 빠뜨려 체인이 죽은 모델에 갇혔던 적이 있다
      if (!res.ok) { await res.text(); continue }
      const data = await res.json()
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
      if (!text) continue
      modelUsed = data.modelVersion ?? model
      return JSON.parse(text)
    } catch { /* 파싱 실패·타임아웃도 다음 모델 */ }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const norm = (c) => String(c ?? '').trim().toLowerCase()
const isKorea = (b) => KOREA.has(norm(b.hq_country))
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)

// ── 데이터
const [all, taxonomy, existing] = await Promise.all([
  sb('businesses?select=id,slug,name,one_liner,hq_country,category,customer_type,revenue_models,pricing_note,' +
     'why_it_works,capital_intensity,funding_usd_m,funding_stage,tier,created_at&status=eq.published'),
  sb('taxonomy?select=kind,value,label_ko'),
  sb('opportunities?select=*'),
])
const byId = new Map(all.map((b) => [b.id, b]))
const label = (kind, v) => taxonomy.find((t) => t.kind === kind && t.value === v)?.label_ko ?? v
const recentCut = Date.now() - RECENT_DAYS * 864e5
console.log(`회사 ${all.length}건 · 기존 기회 ${existing.length}건${DRY ? ' · 미리보기(쓰기 없음)' : ''}`)

// 선례 묶음의 숫자는 전부 여기서 센다
function measure(ids) {
  const ms = [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean)
  const foreign = ms.filter((b) => !isKorea(b))
  const caps = foreign.map((b) => b.capital_intensity).filter((v) => v != null)
  return {
    members: ms, foreign, korean: ms.filter(isKorea),
    member_count: foreign.length,
    country_count: new Set(foreign.map((b) => norm(b.hq_country)).filter(Boolean)).size,
    funded_count: foreign.filter((b) => b.funding_usd_m != null).length,
    recent_count: foreign.filter((b) => +new Date(b.created_at) >= recentCut).length,
    cap_avg: caps.length ? +(caps.reduce((s, v) => s + v, 0) / caps.length).toFixed(2) : null,
  }
}

// ── ① 패턴 감지 (분야별)
const CLUSTER_SYSTEM = `당신은 신사업 리서처입니다. 회사 목록에서 **같은 고객의 같은 문제를 푸는 회사 묶음(패턴)**을 찾습니다.

좋은 패턴: "중소 병원의 보험 청구 반려를 줄여주는 소프트웨어"처럼 고객과 문제가 구체적이다.
나쁜 패턴: "AI 에이전트", "핀테크", "B2B SaaS"처럼 업종·기술 이름이다. 이런 묶음은 만들지 마세요.

규칙:
- 묶음마다 회사 번호(i)를 3개 이상 넣으세요. 확실히 같은 문제를 푸는 회사만 넣으세요. 억지로 채우지 마세요.
- 한 회사는 한 묶음에만 넣으세요. 어디에도 안 맞는 회사는 빼세요.
- existing 목록에 같은 패턴이 있으면 새로 만들지 말고 existing_slug 에 그 slug 를 쓰세요.
- 패턴이 없으면 빈 배열을 내세요.
- title·problem 은 한국어. key 는 영문 소문자 kebab-case 3~6단어(새 패턴일 때만 의미 있음).

출력(JSON): {"patterns":[{"key":"...","existing_slug":null,"title":"고객+문제 한 줄","problem":"누구의 어떤 문제를 어떻게 푸는가 1~2문장","customer_type":"b2b|b2c|b2b2c|b2g|d2c","members":[1,5,9]}]}`

const groups = new Map()
for (const b of all) {
  if (b.capital_intensity === 5) continue // 공장·발사체급 — 혼자 해볼 아이템을 찾는 깔때기에서는 노이즈
  if (ONLY && b.category !== ONLY) continue
  if (!groups.has(b.category)) groups.set(b.category, [])
  groups.get(b.category).push(b)
}

const existingBrief = existing.map((o) => ({ slug: o.slug, title: o.title }))
const found = [] // {key, existing_slug, title, problem, customer_type, ids}
for (const [cat, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  if (list.length < MIN_FOREIGN) continue
  const lines = list.map((b, i) => `${i + 1}\t${b.hq_country ?? '?'}\t${b.customer_type ?? '?'}\t${b.name}: ${b.one_liner}`)
  const out = await gemini(CLUSTER_SYSTEM,
    `분야: ${label('category', cat)}\n\nexisting: ${JSON.stringify(existingBrief)}\n\n회사 목록 (i\t본사국가\t고객\t이름: 한줄요약)\n${lines.join('\n')}`)
  const pats = Array.isArray(out?.patterns) ? out.patterns : []
  let kept = 0
  for (const p of pats) {
    const ids = (p.members ?? []).map((i) => list[Number(i) - 1]?.id).filter(Boolean)
    if (!p.title || !p.problem || ids.length < MIN_FOREIGN) continue
    found.push({ ...p, ids, category: cat })
    kept++
  }
  console.log(`  ${label('category', cat)} ${list.length}건 → 묶음 ${pats.length} (형식 통과 ${kept})${out ? '' : ' ⚠ AI 실패'}`)
  await sleep(3000) // 무료 티어 분당 한도
}

// ── 검증·병합: 숫자는 코드가 센다. existing 과 매칭되면 선례를 합친다.
const bySlug = new Map(existing.map((o) => [o.slug, o]))
const slugify = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'pattern'
const results = [] // {slug, isNew, before, m, p}
for (const p of found) {
  const prev = p.existing_slug ? bySlug.get(p.existing_slug) : null
  const ids = prev ? [...new Set([...prev.members, ...p.ids])] : p.ids
  const m = measure(ids)
  if (m.member_count < MIN_FOREIGN || m.country_count < MIN_COUNTRIES) continue
  let slug = prev?.slug
  if (!slug) {
    slug = slugify(p.key)
    for (let n = 2; bySlug.has(slug) || results.some((r) => r.slug === slug); n++) slug = `${slugify(p.key)}-${n}`
  }
  // 같은 실행에서 같은 existing 에 두 묶음이 매칭되면 합친다
  const dup = results.find((r) => r.slug === slug)
  if (dup) { dup.m = measure([...dup.m.members.map((b) => b.id), ...ids]); continue }
  results.push({ slug, isNew: !prev, prev, m, p })
}
const strength = (m) => m.country_count * 2 + m.member_count + m.funded_count + m.recent_count
console.log(`\n검증 통과 패턴 ${results.length}건 (신규 ${results.filter((r) => r.isNew).length})`)
for (const r of [...results].sort((a, b) => strength(b.m) - strength(a.m))) {
  console.log(`  [${strength(r.m)}] ${r.p.title} — 해외 ${r.m.member_count}곳·${r.m.country_count}개국·투자 ${r.m.funded_count}·자본 ${r.m.cap_avg ?? '?'}${r.m.korean.length ? ` · 국내 ${r.m.korean.length}` : ''}`)
}

// ── ② 기회 카드: 카드 없는 패턴 중 신호 센 순. 자본 부담이 큰 건 카드를 만들지 않는다(신호로만 남김).
const LENSES = `- 드러커-인구 변화 / 드러커-인식 변화 / 드러커-산업·시장 구조 변화 / 드러커-불일치 / 드러커-프로세스 필요 / 드러커-새 지식
- 토플러-탈동시화 (빠른 기술과 느린 제도·법·행정 사이의 마찰)
- 토플러-프로슈머 (돌봄·자가 관리처럼 무급으로 하던 일)
- 크리스텐슨-로우엔드 파괴 (전문가 서비스가 버린 작은 고객)
- 틸-작은 시장 독점 (한 업종·한 상황을 완전히 장악)`

const CARD_SYSTEM = `당신은 한국 시장을 아는 신사업 검토자입니다. 해외 선례 묶음을 보고 **한국에서 1~2인이 시작할 수 있는 기회 가설**로 바꿉니다.
과장하지 마세요. 안 되는 이유가 보이면 그대로 쓰세요. 이 카드는 투자 권유가 아니라 검증할 가설입니다.

규칙:
- 숫자(시장 규모·검색량·매출·사용자 수)를 만들지 마세요. 입력에 있는 숫자만 쓸 수 있습니다.
- 한국의 제도·정책·시장 상황에 대한 사실 주장은 널리 알려진 것만 쓰세요. 확실하지 않으면 문장 끝에 "(확인 필요)"를 붙이세요.
- competitor_candidates 에는 **실제로 존재한다고 확신하는 한국 서비스·회사만** 넣으세요. 모르면 빈 배열. 그럴듯한 이름을 지어내지 마세요.
  name 은 법인명을 알면 법인명(예: 배달의민족 → 우아한형제들), 모르면 서비스명.
- lenses 는 아래 목록에서 **실제로 들어맞는 것만** 0~3개 고르고 왜 그런지 한 문장으로.
${LENSES}
- regulatory 의 severity: blocker(인허가·자격 없이는 불가) / caution(조건부 가능) / none.
- search_keywords: 한국 사람이 이 문제를 겪을 때 네이버에 칠 법한 검색어 3~5개(서비스명이 아니라 문제 표현).
- interview_questions: 해결책을 말하지 않고 과거 행동을 묻는 질문 5개("지난번 ~했을 때 어떻게 하셨어요?").
- kill_criteria: 인터뷰·테스트로 확인할 수 있는 폐기 기준 2~3개(예: "인터뷰 10명 중 같은 고통 5명 미만").

출력(JSON):
{"title":"한국판 기회 한 줄","korea_problem":"한국에서 누가 어떤 문제를 겪는가","korea_customer":"첫 고객 한 줄",
 "why_now_korea":"왜 지금 한국인가 1~2문장","lenses":[{"name":"...","reason":"..."}],
 "model_from_precedents":"선례들이 어떻게 돈을 버는가, 한국에 옮길 때 바꿔야 할 점",
 "solo_fit":{"level":"high|mid|low","reason":"..."},"regulatory":[{"item":"...","severity":"blocker|caution|none"}],
 "competitor_candidates":[{"name":"...","why":"..."}],"search_keywords":["..."],"interview_questions":["..."],"kill_criteria":["..."],
 "risks":["..."]}`

const toCard = results
  .filter((r) => !(r.prev?.carded_at))
  .filter((r) => r.m.cap_avg == null || r.m.cap_avg <= SOLO_CAP)
  .sort((a, b) => strength(b.m) - strength(a.m))
  .slice(0, MAX_CARDS)

for (const r of toCard) {
  const brief = r.m.foreign.map((b) => ({
    이름: b.name, 국가: b.hq_country, 요약: b.one_liner, 수익모델: (b.revenue_models ?? []).join('+'),
    과금: b.pricing_note ?? null, 작동이유: b.why_it_works ?? null,
    투자: b.funding_usd_m != null ? `$${b.funding_usd_m}M ${b.funding_stage ?? ''}`.trim() : null,
  }))
  const card = await gemini(CARD_SYSTEM, JSON.stringify({
    패턴: r.p.title, 문제: r.p.problem, 해외선례: brief,
    이미_수집된_한국_회사: r.m.korean.map((b) => `${b.name}: ${b.one_liner}`),
  }, null, 1))
  await sleep(3000)
  if (!card?.title) { console.log(`  카드 실패: ${r.p.title}`); continue }
  r.card = card
  r.ai_model = modelUsed

  // ③ DART 대조 — 정확 일치만. 미등록이 "없음"은 아니다(외감 대상이 아닌 초기 스타트업은 DART 에 없다).
  const names = (card.competitor_candidates ?? []).map((c) => c.name).filter(Boolean).slice(0, 10)
  let dart = []
  if (!DRY && names.length) {
    try { dart = await rpc('opportunity_dart_lookup', { p_secret: SECRET, p_names: names }) } catch (e) { console.error(`  DART 대조 실패: ${e.message}`) }
  }
  const dmap = new Map(dart.map((d) => [d.name, d]))
  r.competitors = [
    ...r.m.korean.map((b) => ({ name: b.name, why: b.one_liner, source: 'bizatlas', slug: b.slug })),
    ...(card.competitor_candidates ?? []).filter((c) => c?.name).map((c) => {
      const d = dmap.get(c.name)
      return { name: c.name, why: c.why ?? '', source: 'ai', dart: d ? { corp_code: d.corp_code, corp_name: d.corp_name, listed: d.listed } : null }
    }),
  ]

  // 데스크 판정 — 규칙은 코드에. AI 의견(solo_fit·regulatory)은 입력일 뿐 숫자 판정과 섞지 않는다.
  const reasons = []
  let pass = true
  if (r.m.cap_avg != null && r.m.cap_avg > SOLO_CAP) { pass = false; reasons.push(`선례 자본 부담 평균 ${r.m.cap_avg}`) }
  if (card.solo_fit?.level === 'low') { pass = false; reasons.push(`혼자 시작하기 어려움: ${card.solo_fit.reason ?? ''}`) }
  const blockers = (card.regulatory ?? []).filter((x) => x.severity === 'blocker')
  if (blockers.length) { pass = false; reasons.push(`규제 장벽: ${blockers.map((x) => x.item).join(', ')}`) }
  if (r.m.country_count >= 3) reasons.push(`해외 ${r.m.country_count}개국에서 반복 — 우연이 아닐 가능성`)
  const confirmed = r.competitors.filter((c) => c.source === 'bizatlas' || c.dart)
  if (confirmed.length) reasons.push(`국내 경쟁 확인 ${confirmed.length}곳 — 시장은 실재, 차별화가 관건`)
  else reasons.push('국내 경쟁 미확인 — 빈 시장이거나 수요가 없거나. 검색으로 직접 확인')
  r.desk = { verdict: pass ? 'pass' : 'hold', reasons, at: today }
  console.log(`  카드: ${card.title} → ${pass ? '통과' : '보류'}`)
}

// ── 기록
const historyOf = (r) => {
  const h = (r.prev?.history ?? []).filter((x) => x.at !== today)
  return [...h, { at: today, members: r.m.member_count, countries: r.m.country_count, funded: r.m.funded_count }].slice(-52)
}
for (const r of results) {
  const row = {
    slug: r.slug,
    title: r.card?.title ?? r.prev?.title ?? r.p.title,
    problem: r.prev?.problem ?? r.p.problem,
    customer_type: r.p.customer_type ?? r.prev?.customer_type ?? null,
    members: r.m.members.map((b) => b.id),
    member_count: r.m.member_count, country_count: r.m.country_count, funded_count: r.m.funded_count, cap_avg: r.m.cap_avg,
    history: historyOf(r),
  }
  if (r.card) Object.assign(row, { card: r.card, competitors: r.competitors, desk: r.desk, ai_model: r.ai_model, stage: r.desk.verdict === 'pass' ? 'desk' : 'signal' })
  else if (r.isNew) row.stage = 'signal'
  if (DRY) continue
  try { await rpc('upsert_opportunity', { p_secret: SECRET, p: row }) } catch (e) { console.error(`  기록 실패 ${r.slug}: ${e.message}`); process.exitCode = 1 }
}

// ── 텔레그램 브리핑
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const trendsUrl = (kws) => `https://trends.google.com/trends/explore?geo=KR&date=today%205-y&q=${(kws ?? []).slice(0, 5).map(encodeURIComponent).join(',')}`
const carded = results.filter((r) => r.card)
const grown = results.filter((r) => !r.isNew && r.m.member_count > (r.prev?.member_count ?? 0))
const L = []
L.push(`🧭 <b>BizAtlas 기회 브리핑</b> · ${today}`)
L.push(`패턴 ${results.length}건 감지 (신규 ${results.filter((r) => r.isNew).length} · 강화 ${grown.length}) · 새 카드 ${carded.length}`)
for (const r of carded) {
  const c = r.card
  L.push('')
  L.push(`${r.desk.verdict === 'pass' ? '✅' : '⏸'} <b>${esc(c.title)}</b>`)
  L.push(`해외 ${r.m.member_count}곳 · ${r.m.country_count}개국 · 투자 ${r.m.funded_count}건${r.m.cap_avg != null ? ` · 자본부담 ${r.m.cap_avg}` : ''}`)
  if (c.why_now_korea) L.push(`왜 지금: ${esc(c.why_now_korea)}`)
  if (c.solo_fit?.level) L.push(`혼자 가능성: ${{ high: '높음', mid: '보통', low: '낮음' }[c.solo_fit.level] ?? c.solo_fit.level}`)
  const comp = r.competitors.slice(0, 4).map((x) => `${esc(x.name)}${x.dart ? ' (DART✓)' : x.source === 'bizatlas' ? ' (수집✓)' : ' (미확인)'}`)
  L.push(`국내 경쟁: ${comp.length ? comp.join(', ') : '확인 안 됨'}`)
  if (c.interview_questions?.[0]) L.push(`먼저 물어볼 것: ${esc(c.interview_questions[0])}`)
  L.push(`<a href="${SITE}/opportunities?o=${encodeURIComponent(r.slug)}">카드 보기</a> · <a href="${trendsUrl(c.search_keywords)}">검색 추이</a>`)
}
if (grown.length) {
  L.push('')
  L.push(`📈 <b>신호 강화</b>`)
  for (const r of grown.slice(0, 5)) L.push(`· ${esc(r.prev.title)} ${r.prev.member_count}→${r.m.member_count}곳`)
}
L.push('')
L.push(`<i>숫자는 수집 데이터 기준, 해석은 AI · 검색 추이는 직접 확인</i>`)
L.push(`<a href="${SITE}/opportunities">기회 목록</a>`)

const text = L.join('\n')
console.log('\n' + text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))

const token = process.env.TELEGRAM_BOT_TOKEN
const chat = process.env.TELEGRAM_CHAT_ID
if (token && chat && !DRY && (carded.length || grown.length)) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
  })
  if (!res.ok) { console.error(`텔레그램 전송 실패 ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exitCode = 1 }
  else console.log('\n→ 텔레그램 전송 완료')
}
