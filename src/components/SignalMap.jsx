import { useLayoutEffect, useRef, useState } from 'react'

// 기회 신호 지도: 가로 = 해외 선례가 있는 나라 수, 세로 = 해외 선례 회사 수. 점 하나가 기회 하나.
// 오른쪽 위로 갈수록 "여러 나라에서 여러 회사가 같은 문제를 푼다" — 우연이 아닐 가능성이 크다.
// 같은 칸에 겹치는 점은 가로로 나란히 놓는다(정수 좌표라 겹침이 흔하다).

export const STRONG_COUNTRIES = 3
export const HEAVY_CAP = 3.5

const H = 230
const PAD = { top: 14, right: 16, bottom: 34, left: 34 }
const R = 6
const GAP = 15 // 같은 칸 점 간격(px)

export function SignalMap({ opps, onPick }) {
  const box = useRef(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    setW(Math.round(el.clientWidth))
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (!opps.length) return null

  const xMax = Math.max(5, ...opps.map((o) => o.country_count))
  const yMax = Math.max(8, ...opps.map((o) => o.member_count))
  const xMin = 2
  const yMin = 3
  const iw = w - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom
  const sx = (v) => PAD.left + ((v - xMin + 0.5) / (xMax - xMin + 1)) * iw
  const sy = (v) => PAD.top + ih - ((v - yMin + 0.5) / (yMax - yMin + 1)) * ih

  const groups = new Map()
  for (const o of opps) {
    const k = `${o.country_count},${o.member_count}`
    groups.set(k, [...(groups.get(k) ?? []), o])
  }
  // 한 칸에 많이 몰리면 칸 폭 안에 들어오게 간격을 줄인다
  const cellW = iw / (xMax - xMin + 1)
  const points = [...groups.values()].flatMap((g) => g.map((o, i) => ({
    o,
    x: sx(o.country_count) + (i - (g.length - 1) / 2) * Math.min(GAP, (cellW * 0.85) / Math.max(1, g.length - 1)),
    y: sy(o.member_count),
  })))

  const xs = Array.from({ length: xMax - xMin + 1 }, (_, i) => xMin + i)
  const ys = Array.from({ length: yMax - yMin + 1 }, (_, i) => yMin + i).filter((v) => (yMax - yMin > 8 ? v % 2 === 1 : true))
  const strongX = sx(STRONG_COUNTRIES) - iw / (xMax - xMin + 1) / 2

  return (
    <figure className="mt-4 rounded-xl border border-ink-200 bg-white p-3">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-semibold text-ink-800">신호 지도</span>
        <span className="flex flex-wrap items-center gap-3 text-xs text-ink-500">
          <Legend kind="card" /> 카드 있음
          <Legend kind="plain" /> 신호
          <Legend kind="heavy" /> 자본 부담 큼
        </span>
      </figcaption>

      <div ref={box} className="relative mt-2 w-full min-w-0 overflow-hidden" style={{ height: H }} onMouseLeave={() => setHover(null)}>
        {w > 0 && <svg width={w} height={H} className="block" role="img" aria-label="기회별 해외 선례 국가 수와 회사 수">
          <rect x={strongX} y={PAD.top} width={PAD.left + iw - strongX} height={ih} className="fill-brand-50" />
          <text x={PAD.left + iw - 4} y={PAD.top + 12} textAnchor="end" className="fill-brand-700 text-[11px]">
            {STRONG_COUNTRIES}개국 이상 — 볼 만한 신호
          </text>

          {ys.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={PAD.left + iw} y1={sy(v)} y2={sy(v)} className="stroke-ink-100" />
              <text x={PAD.left - 8} y={sy(v) + 4} textAnchor="end" className="fill-ink-400 text-[11px] tabular-nums">{v}</text>
            </g>
          ))}
          {xs.map((v) => (
            <text key={v} x={sx(v)} y={H - PAD.bottom + 16} textAnchor="middle" className="fill-ink-400 text-[11px] tabular-nums">{v}</text>
          ))}
          <text x={PAD.left + iw / 2} y={H - 4} textAnchor="middle" className="fill-ink-500 text-[11px]">해외 선례 국가 수 →</text>
          <text x={9} y={PAD.top + ih / 2} textAnchor="middle" transform={`rotate(-90 9 ${PAD.top + ih / 2})`} className="fill-ink-500 text-[11px]">선례 회사 수 →</text>

          {points.map(({ o, x, y }) => {
            const heavy = (o.cap_avg ?? 0) > HEAVY_CAP
            const active = hover?.o.slug === o.slug
            return (
              <g key={o.slug} className="cursor-pointer" onClick={() => onPick(o)}
                onMouseEnter={() => setHover({ o, x, y })} onFocus={() => setHover({ o, x, y })}
                tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onPick(o)}>
                <circle cx={x} cy={y} r={GAP / 2} className="fill-transparent" />
                <circle cx={x} cy={y} r={active ? R + 1.5 : R} strokeWidth={2}
                  className={heavy ? 'fill-white stroke-amber-500' : o.carded_at ? 'fill-brand-600 stroke-white' : 'fill-ink-400 stroke-white'} />
              </g>
            )
          })}
        </svg>}

        {hover && (
          <div className="pointer-events-none absolute z-10 w-60 rounded-lg border border-ink-200 bg-white p-2.5 text-xs shadow-lg"
            style={{ left: Math.min(Math.max(hover.x - 120, 0), w - 240), top: hover.y > H / 2 ? hover.y - 96 : hover.y + 14 }}>
            <p className="font-semibold text-ink-900">{hover.o.title}</p>
            <p className="mt-1 text-ink-600 tabular-nums">
              선례 {hover.o.member_count}곳 · {hover.o.country_count}개국 · 투자 {hover.o.funded_count}건
              {hover.o.cap_avg != null && ` · 자본 부담 ${Number(hover.o.cap_avg).toFixed(1)}`}
            </p>
            <p className="mt-0.5 text-ink-400">눌러서 카드 열기</p>
          </div>
        )}
      </div>
    </figure>
  )
}

function Legend({ kind }) {
  const cls = { card: 'bg-brand-600', plain: 'bg-ink-400', heavy: 'border-2 border-amber-500 bg-white' }[kind]
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />
}

// 선례 회사 하나 = 칸 하나. 채운 칸 = 투자 받은 회사.
export function PrecedentBlocks({ total, funded }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`선례 ${total}곳 중 투자 ${funded}곳`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`h-2.5 w-2.5 rounded-[3px] ${i < funded ? 'bg-brand-600' : 'border border-brand-600 bg-white'}`} />
      ))}
    </span>
  )
}

// 실행마다 남긴 선례 수 추이. 두 점 이상일 때만.
export function Sparkline({ values, width = 56, height = 18 }) {
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 4) + 2, height - 2 - ((v - min) / span) * (height - 4)])
  const [lx, ly] = pts.at(-1)
  return (
    <svg width={width} height={height} className="inline-block align-middle" aria-label={`선례 수 추이 ${values.join('→')}`}>
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-brand-600" />
      <circle cx={lx} cy={ly} r={2.5} className="fill-brand-600" />
    </svg>
  )
}

const COUNTRY_KO = {
  'united states': '미국', 'united kingdom': '영국', china: '중국', germany: '독일', singapore: '싱가포르', france: '프랑스',
  sweden: '스웨덴', netherlands: '네덜란드', italy: '이탈리아', switzerland: '스위스', india: '인도', belgium: '벨기에',
  spain: '스페인', denmark: '덴마크', finland: '핀란드', lithuania: '리투아니아', japan: '일본', portugal: '포르투갈',
  indonesia: '인도네시아', ukraine: '우크라이나', norway: '노르웨이', estonia: '에스토니아', romania: '루마니아',
  israel: '이스라엘', canada: '캐나다', australia: '호주', brazil: '브라질', poland: '폴란드', ireland: '아일랜드',
  austria: '오스트리아', taiwan: '대만', malaysia: '말레이시아', 'new zealand': '뉴질랜드', turkey: '튀르키예', nigeria: '나이지리아', kenya: '케냐', 'hong kong': '홍콩', vietnam: '베트남', mexico: '멕시코', 'united arab emirates': 'UAE',
}
export const countryKo = (c) => COUNTRY_KO[(c ?? '').trim().toLowerCase()] ?? c
