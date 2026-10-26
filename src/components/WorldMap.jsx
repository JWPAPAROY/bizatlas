import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { geoNaturalEarth1, geoPath } from 'd3-geo'
import { feature } from 'topojson-client'
import { countryKo } from '../lib/countries.js'

// 해외 선례가 어느 나라에 몰려 있는가. 색 = 그 나라의 선례 회사 수(활성 기회 전체, 한국 회사 제외).
// 나라를 누르면 목록을 그 나라에 선례가 있는 기회로 거른다. 한국은 목표 시장이라 테두리로만 표시한다.
// 소스가 영미·유럽 테크 매체 중심이라 지도도 그쪽으로 기운다 — 나라 간 비교는 수집 편향을 함께 읽을 것.

const ALIAS = { 'United States': 'United States of America', 'Czech Republic': 'Czechia' }
// 110m 지도에 없는 작은 나라는 점으로 찍는다 [경도, 위도]
const DOTS = { Singapore: [103.82, 1.35], 'Hong Kong': [114.17, 22.32] }
const KOREA = 'South Korea'
const STEPS = [[11, 'fill-brand-700'], [6, 'fill-brand-500'], [3, 'fill-brand-200'], [1, 'fill-brand-100']]
const LEGEND = [['1–2', 'bg-brand-100'], ['3–5', 'bg-brand-200'], ['6–10', 'bg-brand-500'], ['11+', 'bg-brand-700']]
const fillOf = (n) => STEPS.find(([min]) => n >= min)?.[1] ?? 'fill-ink-100'

let topoPromise
const loadWorld = () => (topoPromise ??= import('world-atlas/countries-110m.json').then((m) => {
  const t = m.default ?? m
  return feature(t, t.objects.countries).features.filter((f) => f.properties.name !== 'Antarctica')
}))

// 기회 목록 + 회사 맵 → 나라별 {companies, opps}
export function countryStats(opps, members) {
  const m = new Map()
  for (const o of opps) {
    for (const id of o.members) {
      const c = members.get(id)?.hq_country
      if (!c || c === KOREA) continue
      const e = m.get(c) ?? { companies: new Set(), opps: new Set() }
      e.companies.add(id)
      e.opps.add(o.slug)
      m.set(c, e)
    }
  }
  return m
}

export function WorldMap({ opps, members, country, onCountry }) {
  const box = useRef(null)
  const [w, setW] = useState(0)
  const [world, setWorld] = useState(null)
  const [hover, setHover] = useState(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    setW(Math.round(el.clientWidth))
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => { loadWorld().then(setWorld) }, [])

  const stats = useMemo(() => countryStats(opps, members), [opps, members])
  const byMapName = useMemo(() => new Map([...stats].map(([c, e]) => [ALIAS[c] ?? c, { name: c, ...e }])), [stats])
  const ranked = [...stats].map(([c, e]) => [c, e.companies.size, e.opps.size]).sort((a, b) => b[1] - a[1])
  const top = ranked.slice(0, 8)
  const maxN = top[0]?.[1] ?? 1

  const h = Math.round(w * 0.48)
  const { path, projection } = useMemo(() => {
    if (!world || !w) return {}
    const p = geoNaturalEarth1().fitSize([w, h], { type: 'FeatureCollection', features: world })
    return { path: geoPath(p), projection: p }
  }, [world, w, h])

  const titleOf = (slug) => opps.find((o) => o.slug === slug)?.title
  const tip = hover && stats.get(hover.name)

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_12rem]">
      <div ref={box} className="relative min-w-0 overflow-hidden" style={{ height: h || 160 }} onMouseLeave={() => setHover(null)}>
        {path && (
          <svg width={w} height={h} className="block" role="img" aria-label="나라별 해외 선례 회사 수 지도">
            {world.map((f) => {
              const name = f.properties.name
              const e = byMapName.get(name)
              const n = e?.companies.size ?? 0
              const isKorea = name === KOREA
              const sel = e && e.name === country
              return (
                <path key={name} d={path(f)}
                  className={`${isKorea ? 'fill-amber-50 stroke-amber-500' : `${fillOf(n)} stroke-white`} ${sel ? '!stroke-ink-900' : ''} ${n ? 'cursor-pointer' : ''}`}
                  strokeWidth={isKorea || sel ? 1.5 : 0.5}
                  onMouseMove={(ev) => {
                    const r = box.current.getBoundingClientRect()
                    setHover({ name: e?.name ?? name, ko: isKorea, x: ev.clientX - r.left, y: ev.clientY - r.top })
                  }}
                  onClick={() => n && onCountry(e.name === country ? null : e.name)} />
              )
            })}
            {Object.entries(DOTS).map(([name, ll]) => {
              const n = stats.get(name)?.companies.size ?? 0
              if (!n) return null
              const [x, y] = projection(ll)
              return (
                <circle key={name} cx={x} cy={y} r={4.5} strokeWidth={name === country ? 2 : 1.5}
                  className={`${fillOf(n)} cursor-pointer ${name === country ? 'stroke-ink-900' : 'stroke-white'}`}
                  onMouseMove={(ev) => {
                    const r = box.current.getBoundingClientRect()
                    setHover({ name, x: ev.clientX - r.left, y: ev.clientY - r.top })
                  }}
                  onClick={() => onCountry(name === country ? null : name)} />
              )
            })}
          </svg>
        )}
        {!path && <div className="flex h-full items-center justify-center text-xs text-ink-400">지도 불러오는 중…</div>}

        {hover && (tip || hover.ko) && (
          <div className="pointer-events-none absolute z-10 w-56 rounded-lg border border-ink-200 bg-white p-2.5 text-xs shadow-lg"
            style={{ left: Math.min(Math.max(hover.x - 112, 0), w - 224), top: hover.y > h / 2 ? Math.max(hover.y - 110, 0) : hover.y + 14 }}>
            {hover.ko ? (
              <p className="text-ink-700"><b>한국</b> — 목표 시장. 국내 회사는 선례 수에서 뺍니다.</p>
            ) : (
              <>
                <p className="font-semibold text-ink-900">{countryKo(hover.name)} <span className="font-normal text-ink-500 tabular-nums">선례 {tip.companies.size}곳 · 기회 {tip.opps.size}건</span></p>
                <ul className="mt-1 space-y-0.5 text-ink-600">
                  {[...tip.opps].slice(0, 4).map((s) => <li key={s} className="truncate">· {titleOf(s)}</li>)}
                  {tip.opps.size > 4 && <li className="text-ink-400">외 {tip.opps.size - 4}건</li>}
                </ul>
                <p className="mt-1 text-ink-400">눌러서 목록 거르기</p>
              </>
            )}
          </div>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold text-ink-500">선례 많은 나라</p>
        <ul className="space-y-1">
          {top.map(([c, n, k]) => (
            <li key={c}>
              <button type="button" onClick={() => onCountry(c === country ? null : c)}
                className={`grid w-full grid-cols-[4.5rem_1fr_1.5rem] items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-ink-50 ${c === country ? 'bg-brand-50' : ''}`}
                title={`선례 ${n}곳 · 기회 ${k}건`}>
                <span className="truncate text-ink-700">{countryKo(c)}</span>
                <span className="h-2 rounded-r-[4px] bg-brand-500" style={{ width: `${(n / maxN) * 100}%` }} />
                <span className="text-right text-ink-500 tabular-nums">{n}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-500">
          선례 수
          {LEGEND.map(([l, cls]) => <span key={l} className="inline-flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-sm ${cls}`} />{l}</span>)}
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-amber-500 bg-amber-50" />한국</span>
        </div>
      </div>
    </div>
  )
}
