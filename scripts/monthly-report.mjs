// 월간 보고서 → 텔레그램. GitHub Actions 가 매월 1일 09:40 KST 에 지난달을 보고한다.
//
// 주간 보고와의 차이: **변화 동향을 짚는다.** 한 주(~100건)는 노이즈와 신호를 못 가르지만
// 한 달(~450건)은 어느 정도 가른다. 그래도 그냥 비교하면 착시가 나므로 세 겹으로 거른다.
//
//   1) 소스 구성 보정 — 분야 비중은 /trends 와 같은 규칙(src/lib/trends.js monthlyShares)으로 보정한다.
//      화면과 보고서가 다른 숫자를 말하지 않도록 같은 코드를 import 한다.
//   2) 유의성 필터 — 차이 2%p 이상 + 두 비율 z ≥ 2 인 것만 "변화"로 부른다. 나머지는 말하지 않는다.
//   3) 소스 변화 명시 — 새로 생긴 소스·비중이 크게 바뀐 소스를 따로 적는다. 지역 비중은 소스 탓이 크다.
//
// 해설 문단은 Gemini 가 쓴다. 단 **걸러진 숫자만** 넘기고 원인 추측을 금지한다. 실패하면 해설 없이 숫자만 보낸다.
// 비교 기준은 직전 최대 3개월(합산). 데이터가 그보다 짧으면 있는 만큼만 쓰고 그렇다고 밝힌다.
//
// 사용법:
//   SUPABASE_URL=xx SUPABASE_ANON_KEY=xx [GEMINI_API_KEY=xx] [TELEGRAM_BOT_TOKEN=xx TELEGRAM_CHAT_ID=xx] \
//     node scripts/monthly-report.mjs [--month=2026-09]      # 생략 시 지난달
//   토큰이 없으면 콘솔 미리보기만 한다.

import { monthlyShares, monthKey, median, SEED_SOURCES, VC_STAGES } from '../src/lib/trends.js'

const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_ANON_KEY
if (!URL_ || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_ANON_KEY 가 필요합니다.')
  process.exit(2)
}

const SITE = 'https://jwpaparoy.github.io/bizatlas/#'
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const KST = 9 * 3600_000
const BASE_MONTHS = 3
const MIN_DIFF_PP = 2
const MIN_Z = 2
const STAGE_LABEL = { seed: '시드', series_a: '시리즈 A', series_b: '시리즈 B' }
const REGION_LABEL = {
  north_america: '북미', europe: '유럽', asia: '아시아', china: '중국', japan: '일본', india: '인도',
  korea: '한국', global: '글로벌', latam: '중남미', oceania: '오세아니아',
}

// ── 대상 월
const arg = process.argv.find((a) => a.startsWith('--month='))?.slice(8)
const nowKst = new Date(Date.now() + KST)
const target = arg ?? (() => {
  const d = new Date(Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth() - 1, 1))
  return d.toISOString().slice(0, 7)
})()
if (!/^\d{4}-\d{2}$/.test(target)) { console.error('--month=YYYY-MM'); process.exit(2) }
const [ty, tm] = target.split('-').map(Number)
const monthStart = (y, m) => Date.UTC(y, m - 1, 1) - KST // KST 1일 00:00 의 실제 시각
const tStart = monthStart(ty, tm)
const tEnd = monthStart(ty, tm + 1)
const bStart = monthStart(ty, tm - BASE_MONTHS)

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

const iso = (t) => new Date(t).toISOString()
const [taxonomy, all, runs] = await Promise.all([
  sb('taxonomy?select=kind,value,label_ko'),
  sb(`businesses?select=name,slug,category,region,customer_type,source_name,funding_usd_m,funding_stage,tags,created_at` +
     `&status=eq.published&created_at=gte.${iso(bStart)}&created_at=lt.${iso(tEnd)}`),
  sb(`ingest_runs?select=started_at,finished_at,created,failed&started_at=gte.${iso(tStart)}&started_at=lt.${iso(tEnd)}`),
])
const label = (kind, v) => taxonomy.find((t) => t.kind === kind && t.value === v)?.label_ko ?? v

const rows = all.filter((r) => !SEED_SOURCES.has(r.source_name))
const cur = rows.filter((r) => monthKey(r.created_at) === target)
const base = rows.filter((r) => monthKey(r.created_at) < target)
const baseMonths = [...new Set(base.map((r) => monthKey(r.created_at)))].sort()
if (!cur.length) { console.error(`${target} 데이터 없음`); process.exit(0) }

const usd = (v) => v == null ? '—' : v >= 1000 ? `$${(v / 1000).toFixed(1)}B` : v >= 10 ? `$${Math.round(v)}M` : `$${v.toFixed(1)}M`

const z = (p1, n1, p2, n2) => {
  const p = (p1 * n1 + p2 * n2) / (n1 + n2)
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
  return se ? (p1 - p2) / se : 0
}

// ── 1) 분야 비중 변화 (소스 보정). 기준 = 기준 월들의 보정 비중을 표본 수로 가중 평균
function shareShifts(field) {
  const { months, series } = monthlyShares(rows, field, true)
  const nOf = Object.fromEntries(months.map((m) => [m.key, m.n]))
  const baseN = baseMonths.reduce((s, m) => s + (nOf[m] ?? 0), 0)
  return series.map((s) => {
    const now = s.shares[target] ?? 0
    const was = baseN ? baseMonths.reduce((acc, m) => acc + (s.shares[m] ?? 0) * (nOf[m] ?? 0), 0) / baseN : 0
    return { value: s.value, now, was, diff: now - was, z: z(now / 100, cur.length, was / 100, baseN) }
  }).filter((x) => Math.abs(x.diff) >= MIN_DIFF_PP && Math.abs(x.z) >= MIN_Z)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
}
const catShifts = baseMonths.length ? shareShifts('category') : []
const custShifts = baseMonths.length ? shareShifts('customer_type') : []

// ── 2) 소스 구성 변화 — 지역·분야 착시의 주범
const srcShare = (xs) => {
  const m = new Map()
  for (const r of xs) m.set(r.source_name, (m.get(r.source_name) ?? 0) + 1)
  return new Map([...m].map(([k, v]) => [k, (v / xs.length) * 100]))
}
const sc = srcShare(cur), sbase = srcShare(base)
const srcChanges = [...new Set([...sc.keys(), ...sbase.keys()])]
  .map((s) => ({ s, now: sc.get(s) ?? 0, was: sbase.get(s) ?? 0, isNew: !sbase.has(s) && base.length > 0 }))
  .filter((x) => x.isNew || Math.abs(x.now - x.was) >= 5)
  .sort((a, b) => Math.abs(b.now - b.was) - Math.abs(a.now - a.was))

// ── 3) 지역 (보정 불가 — 원자료 + 소스 변화와 함께 읽으라고 명시)
const regShare = (xs) => {
  const m = new Map()
  for (const r of xs) m.set(r.region ?? 'unknown', (m.get(r.region ?? 'unknown') ?? 0) + 1)
  return m
}
const rc = regShare(cur), rb = regShare(base)
const regions = [...rc].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, n]) => ({
  g, now: (n / cur.length) * 100, was: base.length ? ((rb.get(g) ?? 0) / base.length) * 100 : null,
}))

// ── 4) 라운드 크기 — 단계별 중앙값. 표본 15건 미만은 "참고"로만
const vcCur = cur.filter((r) => r.funding_usd_m != null && VC_STAGES.includes(r.funding_stage))
const vcBase = base.filter((r) => r.funding_usd_m != null && VC_STAGES.includes(r.funding_stage))
const rounds = Object.keys(STAGE_LABEL).map((s) => {
  const a = vcCur.filter((r) => r.funding_stage === s).map((r) => Number(r.funding_usd_m))
  const b = vcBase.filter((r) => r.funding_stage === s).map((r) => Number(r.funding_usd_m))
  const mA = median(a), mB = median(b)
  return { s, n: a.length, nb: b.length, now: mA, was: mB, chg: mA && mB ? ((mA - mB) / mB) * 100 : null,
    reliable: a.length >= 15 && b.length >= 15 }
})
const topRounds = [...vcCur].sort((a, b) => b.funding_usd_m - a.funding_usd_m).slice(0, 5)

// ── 5) 태그 상승·하락 (월 단위라 최소 건수를 높인다)
const REGION_WORDS = /^(유럽|미국|북미|동남아시아|동남아|아시아|중국|인도|일본|한국|영국|독일|프랑스|europe|usa|asia)$/i
const tagCount = (xs) => { const m = new Map(); for (const r of xs) for (const t of new Set(r.tags ?? [])) if (!REGION_WORDS.test(t)) m.set(t, (m.get(t) ?? 0) + 1); return m }
const tc = tagCount(cur), tb = tagCount(base)
const floor = 0.5 / Math.max(base.length, 1)
const lift = (t) => ((tc.get(t) ?? 0) / cur.length) / Math.max((tb.get(t) ?? 0) / Math.max(base.length, 1), floor)
const tagsUp = base.length ? [...tc].filter(([t, n]) => n >= 6 && lift(t) >= 2).map(([t, n]) => ({ t, n, was: tb.get(t) ?? 0, lift: lift(t) }))
  .sort((a, b) => b.lift - a.lift).slice(0, 6) : []
const tagsDown = base.length ? [...tb].filter(([t, n]) => n >= 8 && lift(t) <= 0.5).map(([t, n]) => ({ t, n: tc.get(t) ?? 0, was: n, lift: lift(t) }))
  .sort((a, b) => a.lift - b.lift).slice(0, 4) : []

// ── 6) 파이프라인
const unfinished = runs.filter((r) => !r.finished_at).length
const aiFail = runs.reduce((s, r) => s + (r.failed ?? 0), 0)

// ── 해설 (Gemini). 걸러진 숫자만 준다.
const facts = {
  month: target,
  baseline_months: baseMonths,
  new_items: { now: cur.length, baseline_monthly_avg: baseMonths.length ? Math.round(base.length / baseMonths.length) : null },
  category_shifts_mix_adjusted: catShifts.map((x) => ({ category: label('category', x.value), now_pct: +x.now.toFixed(1), was_pct: +x.was.toFixed(1), z: +x.z.toFixed(1) })),
  customer_type_shifts: custShifts.map((x) => ({ type: label('customer_type', x.value), now_pct: +x.now.toFixed(1), was_pct: +x.was.toFixed(1) })),
  source_mix_changes: srcChanges.map((x) => ({ source: x.s, now_pct: +x.now.toFixed(1), was_pct: +x.was.toFixed(1), new_source: x.isNew })),
  region_raw_not_adjustable: regions.map((x) => ({ region: REGION_LABEL[x.g] ?? x.g, now_pct: +x.now.toFixed(1), was_pct: x.was == null ? null : +x.was.toFixed(1) })),
  round_size_medians_usd_m: rounds.map((x) => ({ stage: STAGE_LABEL[x.s], now: x.now == null ? null : +x.now.toFixed(1), was: x.was == null ? null : +x.was.toFixed(1), n_now: x.n, n_was: x.nb, reliable: x.reliable })),
  rising_tags: tagsUp.map((x) => ({ tag: x.t, now: x.n, was: x.was })),
  falling_tags: tagsDown.map((x) => ({ tag: x.t, now: x.n, was: x.was })),
}

// 모델에 넘기는 사실은 한국어 키로. 영문 필드명(reliable·n_now…)을 주면 해설에 그대로 새어 나온다(실측).
const factsKo = {
  보고월: target,
  비교기준월: baseMonths,
  신규건수: facts.new_items,
  분야비중변화_소스보정_유의한것만: facts.category_shifts_mix_adjusted.map((x) => ({ 분야: x.category, 이번달: `${x.now_pct}%`, 기준: `${x.was_pct}%` })),
  고객유형변화: facts.customer_type_shifts.map((x) => ({ 유형: x.type, 이번달: `${x.now_pct}%`, 기준: `${x.was_pct}%` })),
  소스구성변화: facts.source_mix_changes.map((x) => ({ 소스: x.source, 이번달: `${x.now_pct}%`, 기준: `${x.was_pct}%`, 신규소스: x.new_source ? '예' : '아니오' })),
  지역비중_보정불가: facts.region_raw_not_adjustable.map((x) => ({ 지역: x.region, 이번달: `${x.now_pct}%`, 기준: x.was_pct == null ? '없음' : `${x.was_pct}%` })),
  라운드중앙값: rounds.filter((x) => x.n).map((x) => ({
    단계: STAGE_LABEL[x.s], 이번달: usd(x.now), 기준: usd(x.was), 표본: x.reliable ? '충분' : '부족',
  })),
  상승태그: facts.rising_tags.map((x) => `${x.tag} ${x.was}→${x.now}건`),
  하락태그: facts.falling_tags.map((x) => `${x.tag} ${x.was}→${x.now}건`),
}

// 필드명·내부 용어·표본 수·LaTeX 가 새어 나온 불릿은 버린다 (실측으로 본 유형들)
const LEAK = /[a-z]+_[a-z_]+|reliable|\btrue\b|\bfalse\b|JSON|n\s?=\s?\d|%\$|\$\d[\d.]*%|보정불가|유의한것만/i

async function commentary() {
  const key = process.env.GEMINI_API_KEY
  if (!key) return null
  const system = `당신은 스타트업 투자 동향 애널리스트입니다. 아래 JSON 은 테크 매체 보도를 수집·태깅한 데이터의 월간 집계입니다.
이 집계에서 의미 있는 변화 동향을 한국어 불릿 3~5개로 짚으세요.

좋은 해설은 숫자를 옮겨 적는 게 아니라 **무엇이 움직였고 무엇이 그대로인지**를 말합니다.
- 서로 관련된 태그(예: 사이버보안·보안·컴플라이언스)는 하나의 테마로 묶어 말하세요.
- 분야 비중(category_shifts_mix_adjusted)이 비어 있으면 "소스 보정 후 분야 비중은 유의하게 변하지 않았다"는 점과
  태그 테마 변화를 대조하세요 — 분야 안의 세부 주제가 움직인 것일 수 있습니다.
- 라운드 크기는 "그대로/커짐/작아짐"으로 요약하세요.
- 신규 건수 증감이나 지역 비중을 단순히 다시 적는 불릿은 쓰지 마세요(본문에 이미 있습니다).

규칙:
- JSON 에 있는 숫자만 쓰세요. 새 숫자·회사·사건을 만들지 마세요.
- 원인을 추측하지 마세요("~때문에" 금지). 단, source_mix_changes 가 있으면 지역·분야 변화가 소스 구성 탓일 수 있다고 반드시 짚으세요.
- region_raw_not_adjustable 은 소스 보정이 안 된 값입니다. 지역 변화를 시장 변화로 단정하지 마세요.
- round_size_medians 에서 reliable=false 인 항목은 "표본이 작다"고 밝히거나 언급하지 마세요.
- 이것은 시장 전체가 아니라 보도량입니다. "시장이 ~했다" 대신 "보도된 ~가" 같은 표현을 쓰세요.
- 변화가 거의 없으면 그렇다고 짧게 쓰세요. 억지로 동향을 만들지 마세요.
- 금액은 주어진 표기("$5.0M", "$16M")를 그대로 쓰세요. 퍼센트는 "50%"처럼 평문으로.
- 입력의 키 이름이나 표본 수를 문장에 옮기지 마세요. 표본이 "부족"이면 "표본이 작다"고만 쓰세요.
- 각 불릿은 한 문장, "• "로 시작. 다른 텍스트 없이 불릿만 출력.`
  // 사고하지 않는 가벼운 모델 우선. 사고형 모델은 출력 한도를 넉넉히(사고 토큰도 한도에서 깎인다).
  for (const model of ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-flash-latest']) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(factsKo, null, 1) }] }],
          generationConfig: { maxOutputTokens: 8192, temperature: 0.2 },
        }),
      })
      if (!res.ok) { await res.text(); continue }
      const data = await res.json()
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
      const bullets = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('•') && !LEAK.test(l))
      if (bullets.length >= 2) return bullets.slice(0, 5)
    } catch { /* 다음 모델 */ }
  }
  return null
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const pp = (d) => `${d >= 0 ? '+' : ''}${d.toFixed(1)}%p`
const mLabel = (k) => `${Number(k.slice(5))}월`

const bullets = await commentary()
const L = []
L.push(`📊 <b>BizAtlas 월간 보고</b> · ${ty}년 ${tm}월`)
L.push(`<i>비교 기준: ${baseMonths.length ? baseMonths.map(mLabel).join('·') : '없음(첫 달)'}${baseMonths.length && baseMonths.length < BASE_MONTHS ? ` — 데이터가 ${baseMonths.length}개월뿐` : ''}</i>`)
L.push('')
const avg = facts.new_items.baseline_monthly_avg
L.push(`📥 신규 <b>${cur.length}건</b>${avg ? ` (기준 월평균 ${avg}건, ${cur.length >= avg ? '+' : ''}${Math.round(((cur.length - avg) / avg) * 100)}%)` : ''}`)

if (bullets) {
  L.push('')
  L.push('🧭 <b>변화 동향</b>')
  for (const b of bullets) L.push(esc(b))
}

L.push('')
L.push(`📈 <b>분야 비중 변화</b> <i>(소스 보정 · 차이 ${MIN_DIFF_PP}%p↑ & z≥${MIN_Z})</i>`)
if (catShifts.length) for (const x of catShifts.slice(0, 6)) {
  L.push(`· ${esc(label('category', x.value))} ${x.was.toFixed(1)}% → <b>${x.now.toFixed(1)}%</b> (${pp(x.diff)})`)
} else L.push('· 유의미한 변화 없음')
for (const x of custShifts.slice(0, 2)) L.push(`· 고객 ${esc(label('customer_type', x.value))} ${x.was.toFixed(1)}% → ${x.now.toFixed(1)}% (${pp(x.diff)})`)

L.push('')
L.push('💰 <b>라운드 크기</b> (중앙값, 기준 → 이번 달)')
for (const x of rounds) {
  if (!x.n) continue
  const tag = x.reliable ? '' : ' <i>표본 적음</i>'
  L.push(`· ${x.s === 'seed' ? '시드' : STAGE_LABEL[x.s]} ${usd(x.was)} → <b>${usd(x.now)}</b>${x.chg != null ? ` (${x.chg >= 0 ? '+' : ''}${Math.round(x.chg)}%)` : ''} n${x.n}${tag}`)
}
if (topRounds.length) {
  L.push(`· 최대: ${topRounds.slice(0, 3).map((r) => `<a href="${SITE}/b/${encodeURIComponent(r.slug)}">${esc(r.name)}</a> ${usd(Number(r.funding_usd_m))}`).join(', ')}`)
}

if (tagsUp.length || tagsDown.length) {
  L.push('')
  if (tagsUp.length) L.push(`🔥 <b>상승</b> ${tagsUp.map((x) => `${esc(x.t)} ${x.was}→${x.n}`).join(' · ')}`)
  if (tagsDown.length) L.push(`❄️ <b>하락</b> ${tagsDown.map((x) => `${esc(x.t)} ${x.was}→${x.n}`).join(' · ')}`)
  L.push(`<i>(기준 ${baseMonths.length}개월 합계 → 이번 달 건수)</i>`)
}

L.push('')
L.push(`🌍 지역 ${regions.map((x) => `${esc(REGION_LABEL[x.g] ?? (x.g === 'unknown' ? '미상' : x.g))} ${x.now.toFixed(0)}%${x.was != null ? `(${pp(x.now - x.was)})` : ''}`).join(' · ')}`)
if (srcChanges.length) {
  L.push(`⚠️ <b>소스 구성 변화</b> — 지역·분야 변화의 착시 원인일 수 있음`)
  for (const x of srcChanges.slice(0, 4)) L.push(`· ${esc(x.s)} ${x.isNew ? '신규 ' : ''}${x.was.toFixed(0)}% → ${x.now.toFixed(0)}%`)
}

L.push('')
L.push(`🔧 수집 ${runs.length}회${unfinished ? ` (⚠ 미완료 ${unfinished})` : ''} · AI 처리 실패 ${aiFail}건`)
L.push('')
L.push(`<i>테크 매체 보도 기준 · 해설은 AI가 집계 숫자만으로 작성</i>`)
L.push(`<a href="${SITE}/trends">투자 흐름 보기</a>`)

const text = L.join('\n')
console.log(text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
if (!bullets) console.log('\n(해설 없음 — GEMINI_API_KEY 미설정 또는 모든 모델 실패)')

const token = process.env.TELEGRAM_BOT_TOKEN
const chat = process.env.TELEGRAM_CHAT_ID
if (token && chat) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
  })
  if (!res.ok) {
    console.error(`텔레그램 전송 실패 ${res.status}: ${(await res.text()).slice(0, 300)}`)
    process.exit(1)
  }
  console.log('\n→ 텔레그램 전송 완료')
}
