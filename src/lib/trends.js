// 트렌드 화면(/trends)의 집계 규칙. 화면 코드와 분리해 둔 이유: 숫자의 의미가 전부 여기서 정해진다.
//
// 이 데이터가 재는 것은 "시장"이 아니라 **"테크 매체가 무엇을 기사화했는가"**다. 그 전제에서
// 세 가지 왜곡을 막는다.
//
// 1) 소스 구성 변화가 트렌드로 둔갑한다.
//    2026-08-12 유럽 소스 3개를 추가하자 유럽 비중이 40% → 51% 로 뛰었다. 시장이 아니라 소스가 바뀐 것.
//    → 비중은 "소스별 비중의 고정 가중 평균"으로 보정한다(아래 mixAdjustedShare).
//      가중치는 전 기간 소스 비중으로 고정하고, 그달 표본이 적은 소스는 그달 계산에서 뺀다.
//      **지역 축은 보정하지 않는다** — 소스 자체가 지역별이라 보정하면 신호가 통째로 지워진다.
// 2) 표본이 작은 달의 변화가 크게 보인다. → MIN_MONTH_N 미만인 달은 "표본 부족"으로 흐리게.
// 3) IPO·대출·인수·기업가치가 라운드 금액에 섞인다. → funding_stage 로 VC 라운드만 집계(VC_STAGES).
//    금액은 고정 환율 USD 환산 근사치다(_shared/funding.js).

import { kstDayKey } from './today'

// 검증 시드(로컬 스크립트·위키데이터)로 들어온 행은 "보도 흐름"이 아니라 일부러 고른 대기업이다.
export const SEED_SOURCES = new Set(['DART 전자공시 검증', 'Wikidata 검증'])

export const VC_STAGES = ['pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d_plus']
export const STAGE_LABEL = {
  pre_seed: '프리시드', seed: '시드', series_a: '시리즈 A', series_b: '시리즈 B',
  series_c: '시리즈 C', series_d_plus: '시리즈 D+', growth: '성장·지분 투자',
}

// 표에 쓰는 지역 묶음. 중국·일본·인도·한국은 각자 표본이 작아 아시아로 합친다.
export const REGION_GROUPS = [
  ['north_america', '북미', ['north_america']],
  ['europe', '유럽', ['europe']],
  ['asia', '아시아', ['asia', 'china', 'japan', 'india', 'korea']],
]

export const MIN_MONTH_N = 150   // 이보다 적은 달은 비중 비교에서 "표본 부족"
const MIN_SOURCE_MONTH_N = 5     // 그달 이보다 적은 소스는 보정 계산에서 제외
export const MIN_CELL_N = 5      // 중앙값을 보여줄 최소 표본
export const THIN_CELL_N = 15    // 이 미만은 "표본 적음" 표시

export const monthKey = (ts) => kstDayKey(ts).slice(0, 7)

export function median(xs) {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

export function fmtUsdM(v) {
  if (v == null) return '—'
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}B`
  if (v >= 10) return `$${Math.round(v)}M`
  if (v >= 1) return `$${v.toFixed(1)}M`
  return `$${Math.round(v * 1000)}K`
}

// ── 단계 × 지역 라운드 중앙값
export function stageRegionMedians(rows) {
  const vc = rows.filter((r) => r.funding_usd_m != null && VC_STAGES.includes(r.funding_stage))
  return VC_STAGES.map((stage) => {
    const s = vc.filter((r) => r.funding_stage === stage)
    const cells = Object.fromEntries(REGION_GROUPS.map(([key, , members]) => {
      const xs = s.filter((r) => members.includes(r.region)).map((r) => Number(r.funding_usd_m))
      return [key, { n: xs.length, med: xs.length >= MIN_CELL_N ? median(xs) : null }]
    }))
    const all = s.map((r) => Number(r.funding_usd_m))
    cells.all = { n: all.length, med: all.length >= MIN_CELL_N ? median(all) : null }
    return { stage, cells }
  })
}

// ── 분야별 라운드 중앙값 (VC 라운드 + 단계 미상 금액). 중앙값이라 메가딜 몇 건에 끌려가지 않는다.
export function categoryMedians(rows, minN = 8) {
  const by = new Map()
  for (const r of rows) {
    if (r.funding_usd_m == null) continue
    if (!(VC_STAGES.includes(r.funding_stage) || r.funding_stage === 'unknown')) continue
    const c = r.category ?? 'other'
    if (!by.has(c)) by.set(c, [])
    by.get(c).push(Number(r.funding_usd_m))
  }
  return [...by.entries()]
    .filter(([, xs]) => xs.length >= minN)
    .map(([category, xs]) => ({ category, n: xs.length, med: median(xs) }))
    .sort((a, b) => b.med - a.med)
}

// ── 월별 비중. adjust=true 면 소스 구성 보정.
// 반환: { months: [{key, n}], series: [{value, shares: {month: pct|null}, total}] }
export function monthlyShares(rows, field, adjust) {
  const months = [...new Set(rows.map((r) => monthKey(r.created_at)))].sort()
  const valueOf = (r) => r[field] ?? 'other'

  // 전 기간 소스 가중치
  const srcCount = new Map()
  for (const r of rows) srcCount.set(r.source_name, (srcCount.get(r.source_name) ?? 0) + 1)
  const w = (s) => (srcCount.get(s) ?? 0) / rows.length

  const values = new Map()
  for (const r of rows) values.set(valueOf(r), (values.get(valueOf(r)) ?? 0) + 1)

  const shares = {} // value → month → pct
  const monthN = {}
  for (const m of months) {
    const inM = rows.filter((r) => monthKey(r.created_at) === m)
    monthN[m] = inM.length
    if (!adjust) {
      for (const v of values.keys()) {
        ;(shares[v] ??= {})[m] = (inM.filter((r) => valueOf(r) === v).length / inM.length) * 100
      }
      continue
    }
    const bySrc = new Map()
    for (const r of inM) {
      if (!bySrc.has(r.source_name)) bySrc.set(r.source_name, [])
      bySrc.get(r.source_name).push(r)
    }
    const used = [...bySrc.entries()].filter(([, xs]) => xs.length >= MIN_SOURCE_MONTH_N)
    const wSum = used.reduce((s, [src]) => s + w(src), 0)
    for (const v of values.keys()) {
      ;(shares[v] ??= {})[m] = wSum
        ? (used.reduce((s, [src, xs]) => s + w(src) * (xs.filter((r) => valueOf(r) === v).length / xs.length), 0) / wSum) * 100
        : null
    }
  }

  return {
    months: months.map((key) => ({ key, n: monthN[key], thin: monthN[key] < MIN_MONTH_N })),
    series: [...values.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, total]) => ({ value, total, shares: shares[value] })),
  }
}

// ── 떠오르는 태그: 최근 windowDays 일 비중 ÷ 그 이전 비중.
// 소스 보정은 하지 않는다(태그별 표본이 작아 보정하면 노이즈가 더 커진다) — 화면에 밝힌다.
export function risingTags(rows, windowDays = 30, minRecent = 5) {
  const cut = Date.now() - windowDays * 86400_000
  const recent = rows.filter((r) => new Date(r.created_at).getTime() >= cut)
  const before = rows.filter((r) => new Date(r.created_at).getTime() < cut)
  if (!recent.length || !before.length) return { recentN: recent.length, beforeN: before.length, items: [] }
  const count = (xs) => {
    const m = new Map()
    for (const r of xs) for (const t of new Set(r.tags ?? [])) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  }
  const rc = count(recent), bc = count(before)
  const items = [...rc.entries()]
    .filter(([, n]) => n >= minRecent)
    .map(([tag, n]) => {
      const rShare = n / recent.length
      const bShare = (bc.get(tag) ?? 0) / before.length
      // 이전에 0건이면 비율이 무한대가 된다 — 0.5건 있었던 것으로 쳐서 순위만 매긴다.
      const lift = rShare / Math.max(bShare, 0.5 / before.length)
      return { tag, recent: n, before: bc.get(tag) ?? 0, rShare, bShare, lift }
    })
    .sort((a, b) => b.lift - a.lift)
  return { recentN: recent.length, beforeN: before.length, items }
}
