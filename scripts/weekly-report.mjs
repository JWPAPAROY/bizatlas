// 주간 보고서 → 텔레그램. GitHub Actions 가 매주 월요일 09:30 KST 에 실행한다.
//
// 헬스체크는 "고장 났나"만 본다. 이건 "지난주에 무엇이 쌓였나"를 본다 — 데이터가 주 100건씩
// 쌓이는데 직접 들어가 보지 않으면 아무것도 안 보이기 때문이다.
//
// 해석 원칙은 /trends 와 같다(src/lib/trends.js 주석): 이 숫자는 시장이 아니라 테크 매체 보도량이고,
// 한 주 표본(~100건)은 작다. 그래서 변화는 "지난 4주 평균 대비"로만 말하고, 표본이 작으면 그렇다고 쓴다.
//
// 보도량 통계만으로는 "그래서 뭘 보면 되나"가 안 나온다. 이 서비스의 목적은 한국에 옮길 만한 모델을
// 찾는 것이라, 맨 위에 그 주의 이식 후보(세 점수 축 기준)를 둔다. 점수는 AI 해석이라는 점을 함께 밝힌다.
//
// anon 키만 쓴다(헬스체크와 동일). 토큰이 없으면 콘솔에만 출력한다 — 로컬 미리보기용.
//
// 사용법:
//   SUPABASE_URL=xx SUPABASE_ANON_KEY=xx [TELEGRAM_BOT_TOKEN=xx TELEGRAM_CHAT_ID=xx] node scripts/weekly-report.mjs

const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_ANON_KEY
if (!URL_ || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_ANON_KEY 가 필요합니다.')
  process.exit(2)
}

import { themeCounts, zDiff } from './lib/report-tags.mjs'

const SITE = 'https://jwpaparoy.github.io/bizatlas/#'
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const DAY = 86400_000
const KST = 9 * 3600_000
const SEED_SOURCES = new Set(['DART 전자공시 검증', 'Wikidata 검증'])
const VC_STAGES = ['pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d_plus']
const STAGE_LABEL = {
  pre_seed: '프리시드', seed: '시드', series_a: 'A', series_b: 'B', series_c: 'C', series_d_plus: 'D+',
}
const REGION_LABEL = {
  north_america: '북미', europe: '유럽', asia: '아시아', china: '중국', japan: '일본', india: '인도',
  korea: '한국', global: '글로벌', latam: '중남미', oceania: '오세아니아', mena: '중동', africa: '아프리카',
}

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

// 지난주 = 직전 KST 월요일 00:00 ~ 일요일 24:00
const nowKst = new Date(Date.now() + KST)
const dow = (nowKst.getUTCDay() + 6) % 7 // 월=0
const thisMonKst = Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate()) - dow * DAY
const weekEnd = thisMonKst - KST            // 실제 시각
const weekStart = weekEnd - 7 * DAY
const baseStart = weekStart - 28 * DAY      // 비교 기준: 그 전 4주
const kstLabel = (t) => {
  const d = new Date(t + KST)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const pct = (n, d) => (d ? (n / d) * 100 : 0)
const median = (xs) => {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
const usd = (v) => v == null ? '—' : v >= 1000 ? `$${(v / 1000).toFixed(1)}B` : v >= 10 ? `$${Math.round(v)}M` : `$${v.toFixed(1)}M`

const [taxonomy, rows, runs, roundRows] = await Promise.all([
  sb('taxonomy?select=kind,value,label_ko'),
  sb(`businesses?select=name,slug,one_liner,category,region,tier,source_name,funding_usd_m,funding_stage,tags,created_at,scored_at,decided_at,` +
     `korea_fit,capital_intensity,replicability,korea_analogs` +
     `&status=eq.published&created_at=gte.${new Date(baseStart).toISOString()}`),
  sb(`ingest_runs?select=started_at,finished_at,created,failed,detail` +
     `&started_at=gte.${new Date(weekStart).toISOString()}&started_at=lt.${new Date(weekEnd).toISOString()}`),
  sb(`funding_rounds?select=stage,usd_m,source_name,reported_at,businesses(name,slug,category,region,capital_intensity)` +
     `&reported_at=gte.${new Date(weekStart).toISOString()}&reported_at=lt.${new Date(weekEnd).toISOString()}`),
])

// 투자는 funding_rounds(회사 1 : 라운드 N) 기준 — 같은 회사의 후속 라운드도 잡힌다.
// 위 집계용 행 모양(funding_usd_m·funding_stage·created_at…)으로 맞춰 둔다.
const toRound = (r) => ({
  funding_stage: r.stage, funding_usd_m: r.usd_m, source_name: r.source_name, created_at: r.reported_at,
  name: r.businesses?.name, slug: r.businesses?.slug, category: r.businesses?.category ?? 'other', region: r.businesses?.region ?? null,
  capital_intensity: r.businesses?.capital_intensity ?? null,
})
const weekRounds = roundRows.map(toRound).filter((r) => !SEED_SOURCES.has(r.source_name))
const label = (kind, v) => taxonomy.find((t) => t.kind === kind && t.value === v)?.label_ko ?? v

const feed = rows.filter((r) => !SEED_SOURCES.has(r.source_name))
const inRange = (r, a, b) => { const t = new Date(r.created_at).getTime(); return t >= a && t < b }
const week = feed.filter((r) => inRange(r, weekStart, weekEnd))
const base = feed.filter((r) => inRange(r, baseStart, weekStart))
const baseAvg = base.length / 4

const lines = []
lines.push(`🗓 <b>BizAtlas 주간 보고</b> · ${kstLabel(weekStart)}–${kstLabel(weekEnd - DAY)}`)
lines.push('')

// ── 수집량
const delta = baseAvg ? Math.round(pct(week.length - baseAvg, baseAvg)) : 0
lines.push(`📥 <b>신규 ${week.length}건</b> (지난 4주 평균 ${Math.round(baseAvg)}건, ${delta >= 0 ? '+' : ''}${delta}%)`)

// ── 이식 후보: 한국 적용성 4+ · 자본 2 이하. 검증 시드도 포함한다(새로 들어온 검증 회사는 오히려 좋은 후보).
// 순서: 국내 유사 사업자 없음 → 적용성 → 복제 어려움. 복제가 쉬우면 남도 쉽게 따라온다는 뜻이라 따로 표시한다.
const fresh = rows.filter((r) => inRange(r, weekStart, weekEnd))
const candidates = fresh
  .filter((r) => r.korea_fit >= 4 && r.capital_intensity != null && r.capital_intensity <= 2)
  .sort((a, b) => (a.korea_analogs?.length ? 1 : 0) - (b.korea_analogs?.length ? 1 : 0)
    || b.korea_fit - a.korea_fit || (a.replicability ?? 9) - (b.replicability ?? 9))
lines.push('')
lines.push(`🇰🇷 <b>이식 후보 ${candidates.length}건</b> <i>(한국 적용성 4+ · 자본 2 이하)</i>`)
if (!candidates.length) lines.push('· 이번 주는 없음')
for (const r of candidates.slice(0, 5)) {
  const one = (r.one_liner ?? '').length > 38 ? `${r.one_liner.slice(0, 37)}…` : (r.one_liner ?? '')
  const analog = r.korea_analogs?.length ? `국내 유사 ${r.korea_analogs.slice(0, 2).map(esc).join('·')}` : '국내 유사 없음'
  const copy = r.replicability >= 4 ? ' · ⚠ 복제 쉬움' : ''
  lines.push(`· <a href="${SITE}/b/${encodeURIComponent(r.slug)}">${esc(r.name)}</a> ${esc(one)}`)
  lines.push(`   한국${r.korea_fit} 자본${r.capital_intensity} 복제${r.replicability ?? '—'} · ${analog}${copy}`)
}
if (candidates.length) lines.push(`<i>점수·국내 유사는 AI 해석 — 판단 전 원문 확인</i>`)

// ── 분야: 이번 주 비중 vs 지난 4주 비중
const share = (xs, key, v) => pct(xs.filter((r) => r[key] === v).length, xs.length)
const cats = [...new Set(week.map((r) => r.category))]
  .map((c) => ({ c, n: week.filter((r) => r.category === c).length, w: share(week, 'category', c), b: share(base, 'category', c) }))
  .sort((a, b) => b.n - a.n).slice(0, 5)
lines.push('')
// 화살표는 월간과 같은 기준(차이 2%p 이상 + z≥2)일 때만 붙인다. 한 주 표본(~100건)에서 2%p 만 보면 대부분 노이즈다.
lines.push('🏷 <b>분야</b> (괄호: 지난 4주 대비 %p · ▲▼ 는 통계적으로 유의할 때만)')
for (const x of cats) {
  const d = x.w - x.b
  const sig = Math.abs(d) >= 2 && Math.abs(zDiff(x.w / 100, week.length, x.b / 100, base.length)) >= 2
  const arrow = !sig ? '' : d > 0 ? ' ▲' : ' ▼'
  lines.push(`· ${esc(label('category', x.c))} ${x.n}건 ${x.w.toFixed(0)}%${arrow} (${d >= 0 ? '+' : ''}${d.toFixed(1)})`)
}

// ── 지역
const regions = [...new Set(week.map((r) => r.region ?? 'unknown'))]
  .map((g) => [g, week.filter((r) => (r.region ?? 'unknown') === g).length])
  .sort((a, b) => b[1] - a[1]).slice(0, 4)
lines.push(`🌍 ${regions.map(([g, n]) => `${esc(REGION_LABEL[g] ?? (g === 'unknown' ? '미상' : g))} ${n}`).join(' · ')}`)

// ── 투자
const vc = weekRounds.filter((r) => r.funding_usd_m != null && VC_STAGES.includes(r.funding_stage))
lines.push('')
lines.push(`💰 <b>VC 라운드 ${vc.length}건</b> (금액 확인분)`)
const stMed = ['seed', 'series_a', 'series_b']
  .map((s) => { const xs = vc.filter((r) => r.funding_stage === s).map((r) => Number(r.funding_usd_m)); return xs.length ? `${STAGE_LABEL[s]} ${usd(median(xs))}(n${xs.length})` : null })
  .filter(Boolean)
if (stMed.length) lines.push(`· 중앙값 ${stMed.join(' · ')}`)
const roundLine = (r) => `· <a href="${SITE}/b/${encodeURIComponent(r.slug)}">${esc(r.name)}</a> ${usd(Number(r.funding_usd_m))} ${STAGE_LABEL[r.funding_stage]} — ${esc(label('category', r.category))}`
const top = [...vc].sort((a, b) => b.funding_usd_m - a.funding_usd_m).slice(0, 3)
lines.push('<i>최대 라운드</i>')
for (const r of top) lines.push(roundLine(r))
// 대형 라운드는 대부분 자본 집약도 3~5(실측)라 혼자 시작할 모델과 거리가 멀다.
// 적은 자본으로 시작하는 모델이 투자를 받았다는 것이 이식 판단에는 더 쓸모 있는 신호다.
const lean = vc.filter((r) => r.capital_intensity != null && r.capital_intensity <= 2)
  .sort((a, b) => b.funding_usd_m - a.funding_usd_m).slice(0, 3)
if (lean.length) {
  lines.push('<i>자본 부담 낮은데 투자 유치 (자본 2 이하)</i>')
  for (const r of lean) lines.push(roundLine(r))
}

// ── 떠오르는 주제: 이번 주 비율 ÷ 지난 4주 비율. 태그 표기 흔들림·지역명·분야 수준 태그는 report-tags 가 정리한다.
const { counts: wt, labelOf: tagLabel } = themeCounts(week)
const { counts: bt } = themeCounts(base)
const rising = [...wt.entries()].filter(([, n]) => n >= 4)
  .map(([t, n]) => ({ t, n, was: (bt.get(t) ?? 0) / 4, lift: (n / week.length) / Math.max((bt.get(t) ?? 0) / Math.max(base.length, 1), 0.5 / Math.max(base.length, 1)) }))
  .filter((x) => x.lift >= 1.5).sort((a, b) => b.lift - a.lift).slice(0, 5)
if (rising.length) {
  lines.push('')
  lines.push(`📈 <b>떠오르는 주제</b> <i>(주평균 → 이번 주)</i>`)
  lines.push(`· ${rising.map((x) => `${esc(tagLabel(x.t))} ${x.was.toFixed(1)}→${x.n}`).join(' · ')}`)
}

// ── 파이프라인
const done = runs.filter((r) => r.finished_at)
const unfinished = runs.length - done.length
const failed = runs.reduce((s, r) => s + (r.failed ?? 0), 0)
const src = {}
for (const r of runs) for (const [n, d] of Object.entries(r.detail ?? {})) {
  if (n.startsWith('_') || typeof d !== 'object' || !d) continue
  ;(src[n] ??= { c: 0 }).c += d.created ?? 0
}
const srcTop = Object.entries(src).sort((a, b) => b[1].c - a[1].c)
const zero = srcTop.filter(([, s]) => s.c === 0).map(([n]) => n)
const backlog = feed.filter((r) => new Date(r.created_at).getTime() < Date.now() - 3 * DAY && (!r.scored_at || !r.decided_at)).length
// 운영 상태는 헬스체크 봇이 따로 본다. 여기서는 이상할 때만 자세히 쓰고, 평소엔 한 줄로 줄인다.
// AI 처리 실패율은 평소 15% 안팎이다(2026-10 실측: 주 14%, 월 15%). 숫자만 주면 많은지 적은지 알 수 없어 비율로 쓴다.
const created = runs.reduce((s, r) => s + (r.created ?? 0), 0)
const failRate = created + failed ? Math.round((failed / (created + failed)) * 100) : 0
const issues = [
  unfinished && `미완료 수집 ${unfinished}회`,
  failRate > 25 && `AI 처리 실패율 ${failRate}% (평소 ~15%)`,
  backlog && `미처리 적체 ${backlog}건`,
  zero.length && `채택 0건 소스: ${zero.map(esc).join(', ')}`,
].filter(Boolean)
lines.push('')
if (issues.length) {
  lines.push(`🔧 <b>파이프라인 확인 필요</b>`)
  for (const x of issues) lines.push(`· ⚠ ${x}`)
  lines.push(`· 소스별 채택 ${srcTop.slice(0, 4).map(([n, s]) => `${esc(n)} ${s.c}`).join(' · ')}`)
} else {
  lines.push(`🔧 파이프라인 정상 · 수집 ${runs.length}회 · AI 처리 실패율 ${failRate}%`)
}

lines.push('')
lines.push(`<i>테크 매체 보도 기준 · 한 주 표본이 작아 방향만 참고</i>`)
lines.push(`<a href="${SITE}/?since=d7&amp;tier=all&amp;kfit=4&amp;cap=2">이식 후보 전체</a> · <a href="${SITE}/trends">투자 흐름</a> · <a href="${SITE}/opportunities">기회 카드</a>`)

const text = lines.join('\n')
console.log(text.replace(/<[^>]+>/g, ''))

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
