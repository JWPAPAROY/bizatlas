// 주간 보고서 → 텔레그램. GitHub Actions 가 매주 월요일 09:30 KST 에 실행한다.
//
// 헬스체크는 "고장 났나"만 본다. 이건 "지난주에 무엇이 쌓였나"를 본다 — 데이터가 주 100건씩
// 쌓이는데 직접 들어가 보지 않으면 아무것도 안 보이기 때문이다.
//
// 해석 원칙은 /trends 와 같다(src/lib/trends.js 주석): 이 숫자는 시장이 아니라 테크 매체 보도량이고,
// 한 주 표본(~100건)은 작다. 그래서 변화는 "지난 4주 평균 대비"로만 말하고, 표본이 작으면 그렇다고 쓴다.
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

const [taxonomy, rows, runs] = await Promise.all([
  sb('taxonomy?select=kind,value,label_ko'),
  sb(`businesses?select=name,slug,category,region,tier,source_name,funding_usd_m,funding_stage,tags,created_at,scored_at,decided_at` +
     `&status=eq.published&created_at=gte.${new Date(baseStart).toISOString()}`),
  sb(`ingest_runs?select=started_at,finished_at,created,failed,detail` +
     `&started_at=gte.${new Date(weekStart).toISOString()}&started_at=lt.${new Date(weekEnd).toISOString()}`),
])
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

// ── 분야: 이번 주 비중 vs 지난 4주 비중
const share = (xs, key, v) => pct(xs.filter((r) => r[key] === v).length, xs.length)
const cats = [...new Set(week.map((r) => r.category))]
  .map((c) => ({ c, n: week.filter((r) => r.category === c).length, w: share(week, 'category', c), b: share(base, 'category', c) }))
  .sort((a, b) => b.n - a.n).slice(0, 5)
lines.push('')
lines.push('🏷 <b>분야</b> (괄호: 지난 4주 대비 %p)')
for (const x of cats) {
  const d = x.w - x.b
  const arrow = Math.abs(d) < 2 ? '' : d > 0 ? ' ▲' : ' ▼'
  lines.push(`· ${esc(label('category', x.c))} ${x.n}건 ${x.w.toFixed(0)}%${arrow} (${d >= 0 ? '+' : ''}${d.toFixed(1)})`)
}

// ── 지역
const regions = [...new Set(week.map((r) => r.region ?? 'unknown'))]
  .map((g) => [g, week.filter((r) => (r.region ?? 'unknown') === g).length])
  .sort((a, b) => b[1] - a[1]).slice(0, 4)
lines.push(`🌍 ${regions.map(([g, n]) => `${esc(REGION_LABEL[g] ?? (g === 'unknown' ? '미상' : g))} ${n}`).join(' · ')}`)

// ── 투자
const vc = week.filter((r) => r.funding_usd_m != null && VC_STAGES.includes(r.funding_stage))
lines.push('')
lines.push(`💰 <b>VC 라운드 ${vc.length}건</b> (금액 확인분)`)
const stMed = ['seed', 'series_a', 'series_b']
  .map((s) => { const xs = vc.filter((r) => r.funding_stage === s).map((r) => Number(r.funding_usd_m)); return xs.length ? `${STAGE_LABEL[s]} ${usd(median(xs))}(n${xs.length})` : null })
  .filter(Boolean)
if (stMed.length) lines.push(`· 중앙값 ${stMed.join(' · ')}`)
const top = [...vc].sort((a, b) => b.funding_usd_m - a.funding_usd_m).slice(0, 5)
for (const r of top) {
  lines.push(`· <a href="${SITE}/b/${encodeURIComponent(r.slug)}">${esc(r.name)}</a> ${usd(Number(r.funding_usd_m))} ${STAGE_LABEL[r.funding_stage]} — ${esc(label('category', r.category))}`)
}

// ── 떠오르는 태그: 이번 주 비율 ÷ 지난 4주 비율, 이번 주 3건 이상
const tagCount = (xs) => { const m = new Map(); for (const r of xs) for (const t of new Set(r.tags ?? [])) m.set(t, (m.get(t) ?? 0) + 1); return m }
const wt = tagCount(week), bt = tagCount(base)
// 지역명 태그("유럽"·"동남아시아")는 지역 축과 중복이라 뺀다
const REGION_WORDS = /^(유럽|미국|북미|동남아시아|동남아|아시아|중국|인도|일본|한국|영국|독일|프랑스|europe|usa|asia)$/i
const rising = [...wt.entries()].filter(([t, n]) => n >= 3 && !REGION_WORDS.test(t))
  .map(([t, n]) => ({ t, n, lift: (n / week.length) / Math.max((bt.get(t) ?? 0) / Math.max(base.length, 1), 0.5 / Math.max(base.length, 1)) }))
  .filter((x) => x.lift >= 1.5).sort((a, b) => b.lift - a.lift).slice(0, 6)
if (rising.length) {
  lines.push('')
  lines.push(`📈 <b>떠오르는 태그</b>  ${rising.map((x) => `${esc(x.t)}(${x.n})`).join(' · ')}`)
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
lines.push('')
lines.push(`🔧 <b>파이프라인</b> 수집 ${runs.length}회${unfinished ? ` (⚠ 미완료 ${unfinished})` : ''} · AI 처리 실패 ${failed}건 · 미처리 적체 ${backlog}건`)
lines.push(`· 소스별 채택 ${srcTop.slice(0, 4).map(([n, s]) => `${esc(n)} ${s.c}`).join(' · ')}`)
if (zero.length) lines.push(`· 채택 0건: ${zero.map(esc).join(', ')}`)

lines.push('')
lines.push(`<i>테크 매체 보도 기준 · 한 주 표본이 작아 방향만 참고</i>`)
lines.push(`<a href="${SITE}/trends">투자 흐름 보기</a> · <a href="${SITE}/?since=d7&amp;tier=all">최근 7일 항목</a>`)

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
