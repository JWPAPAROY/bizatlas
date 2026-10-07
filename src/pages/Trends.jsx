import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, AlertTriangle, Info } from 'lucide-react'
import { supabase, isConfigured } from '../lib/supabase'
import { useStore } from '../lib/store.jsx'
import {
  SEED_SOURCES, STAGE_LABEL, ROUND_COLS, roundsToRows, REGION_GROUPS, MIN_MONTH_N, THIN_CELL_N,
  fmtUsdM, stageRegionMedians, categoryMedians, monthlyShares, risingTags,
} from '../lib/trends'

// 집계 규칙과 그 전제(보도 흐름 ≠ 시장, 소스 구성 보정, VC 라운드만)는 lib/trends.js 주석 참조.

const COLS = 'created_at, category, region, customer_type, source_name, funding_usd_m, funding_stage, tags'

function Section({ title, desc, children }) {
  return (
    <section className="mb-6 rounded-xl border border-ink-200 bg-white p-5">
      <h2 className="text-base font-semibold text-ink-900">{title}</h2>
      {desc && <p className="mt-1 text-xs leading-relaxed text-ink-500">{desc}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Seg({ value, onChange, options }) {
  return (
    <div className="inline-flex rounded-lg border border-ink-200 bg-ink-50 p-0.5 text-xs">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 font-medium transition ${
            value === v ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-700'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

// ── 단계 × 지역 표. 표본이 적은 칸은 흐리게, 기준 미달은 대시.
function StageTable({ rows }) {
  const data = useMemo(() => stageRegionMedians(rows), [rows])
  const cols = [...REGION_GROUPS.map(([k, label]) => [k, label]), ['all', '전체']]
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-ink-200 text-left text-xs text-ink-500">
            <th className="py-2 pr-3 font-medium">단계</th>
            {cols.map(([k, label]) => (
              <th key={k} className="px-3 py-2 text-right font-medium">{label}</th>
            ))}
            <th className="py-2 pl-3 text-right font-medium" title="북미 중앙값 ÷ 유럽 중앙값">북미/유럽</th>
          </tr>
        </thead>
        <tbody>
          {data.map(({ stage, cells }) => {
            const na = cells.north_america.med, eu = cells.europe.med
            return (
              <tr key={stage} className="border-b border-ink-100 last:border-0">
                <td className="py-2 pr-3 font-medium text-ink-700">{STAGE_LABEL[stage]}</td>
                {cols.map(([k]) => {
                  const c = cells[k]
                  const thin = c.med != null && c.n < THIN_CELL_N
                  return (
                    <td
                      key={k}
                      className="px-3 py-2 text-right tabular-nums"
                      title={c.med == null ? `표본 ${c.n}건 — 5건 미만이라 표시하지 않음` : `${c.n}건의 중앙값${thin ? ' (표본 적음)' : ''}`}
                    >
                      <span className={c.med == null ? 'text-ink-300' : thin ? 'text-ink-400' : 'font-semibold text-ink-900'}>
                        {fmtUsdM(c.med)}
                      </span>
                      <span className="ml-1 text-[11px] text-ink-400">n{c.n}</span>
                    </td>
                  )
                })}
                <td className="py-2 pl-3 text-right tabular-nums text-ink-600">
                  {na != null && eu != null ? `${(na / eu).toFixed(1)}×` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── 분야별 중앙값 가로 막대 (단일 색조 — 크기 비교만 한다)
function CategoryBars({ rows }) {
  const { labelOf } = useStore()
  const data = useMemo(() => categoryMedians(rows), [rows])
  const max = Math.max(1, ...data.map((d) => d.med))
  return (
    <ul className="space-y-1.5">
      {data.map((d) => (
        <li
          key={d.category}
          className="group grid grid-cols-[7.5rem_1fr_4.5rem] items-center gap-3 text-sm"
          title={`${labelOf('category', d.category)} — ${d.n}건의 중앙값 ${fmtUsdM(d.med)}`}
        >
          <span className="truncate text-ink-700">{labelOf('category', d.category)}</span>
          <span className="h-3.5 rounded-r bg-ink-100">
            <span
              className="block h-full rounded-r bg-brand-500 transition group-hover:bg-brand-700"
              style={{ width: `${Math.max(2, (d.med / max) * 100)}%` }}
            />
          </span>
          <span className="text-right tabular-nums">
            <span className="font-semibold text-ink-900">{fmtUsdM(d.med)}</span>
            <span className="ml-1 text-[11px] text-ink-400">n{d.n}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

// ── 월별 비중 히트맵 표. 진하기 = 비중(단일 색조), 마지막 열 = 첫 달 대비 변화(%p).
function ShareMatrix({ rows }) {
  const { labelOf } = useStore()
  const [field, setField] = useState('category')
  const [adjust, setAdjust] = useState(true)
  const { months, series } = useMemo(() => monthlyShares(rows, field, adjust), [rows, field, adjust])
  const shown = series.slice(0, 14)
  const max = Math.max(1, ...shown.flatMap((s) => months.map((m) => s.shares[m.key] ?? 0)))
  // 변화는 표본이 충분한 달끼리만 비교한다
  const solid = months.filter((m) => !m.thin)
  const first = solid[0], last = solid[solid.length - 1]

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Seg value={field} onChange={setField} options={[['category', '분야'], ['customer_type', '고객 유형']]} />
        <Seg value={adjust ? 'adj' : 'raw'} onChange={(v) => setAdjust(v === 'adj')} options={[['adj', '소스 구성 보정'], ['raw', '원자료']]} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-xs text-ink-500">
              <th className="py-2 pr-3 text-left font-medium">{field === 'category' ? '분야' : '고객 유형'}</th>
              {months.map((m) => (
                <th key={m.key} className={`px-2 py-2 text-right font-medium ${m.thin ? 'text-ink-300' : ''}`}>
                  {m.key.slice(2).replace('-', '.')}
                  <span className="block text-[10px] font-normal">{m.thin ? `n${m.n} · 표본 부족` : `n${m.n}`}</span>
                </th>
              ))}
              <th className="py-2 pl-2 text-right font-medium">
                변화
                <span className="block text-[10px] font-normal">
                  {first && last && first !== last ? `${first.key.slice(5)}→${last.key.slice(5)}월` : '비교 불가'}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const delta = first && last && first !== last ? (s.shares[last.key] ?? 0) - (s.shares[first.key] ?? 0) : null
              return (
                <tr key={s.value} className="border-b border-ink-100 last:border-0">
                  <td className="py-1.5 pr-3 text-ink-700">{labelOf(field, s.value)}</td>
                  {months.map((m) => {
                    const v = s.shares[m.key]
                    return (
                      <td key={m.key} className="px-1 py-1">
                        <div
                          className={`rounded px-1.5 py-1 text-right tabular-nums ${m.thin ? 'opacity-40' : ''}`}
                          style={{ background: v ? `rgb(13 148 136 / ${0.06 + (v / max) * 0.5})` : undefined }}
                          title={`${labelOf(field, s.value)} · ${m.key} · ${v == null ? '—' : v.toFixed(1) + '%'}${m.thin ? ' (표본 부족)' : ''}`}
                        >
                          {v == null ? '—' : v.toFixed(1)}
                        </div>
                      </td>
                    )
                  })}
                  <td className="py-1.5 pl-2 text-right tabular-nums text-ink-600">
                    {delta == null ? '—' : `${delta > 0 ? '▲' : delta < 0 ? '▼' : ''} ${Math.abs(delta).toFixed(1)}`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
        단위 %. 보정은 소스마다의 비중을 전 기간 소스 비중으로 가중 평균한 값입니다. 소스가 추가되거나 빠져도
        비중이 따라 출렁이지 않습니다. 지역은 소스 자체가 지역별이라 보정할 수 없어 이 표에서 뺐습니다.
        월은 KST 기준이며, {MIN_MONTH_N}건 미만인 달은 변화 계산에서 제외합니다.
      </p>
    </>
  )
}

function RisingTags({ rows }) {
  const { recentN, beforeN, items } = useMemo(() => risingTags(rows), [rows])
  if (!items.length) return <p className="text-sm text-ink-500">비교할 기간이 아직 부족합니다.</p>
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {items.slice(0, 16).map((t) => (
          <Link
            key={t.tag}
            to={`/?q=${encodeURIComponent(t.tag)}&tier=all`}
            className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm hover:border-brand-500"
            title={`최근 30일 ${t.recent}건 (${(t.rShare * 100).toFixed(1)}%) · 이전 ${t.before}건 (${(t.bShare * 100).toFixed(1)}%)`}
          >
            <span className="font-medium text-ink-800">{t.tag}</span>
            <span className="ml-1.5 text-xs tabular-nums text-ink-500">
              {t.before === 0 ? '신규' : `${t.lift.toFixed(1)}×`} · {t.recent}건
            </span>
          </Link>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-400">
        최근 30일 {recentN}건과 이전 {beforeN}건에서 태그가 붙은 비율을 비교했습니다. 최근 5건 이상인 태그만 넣었습니다.
        태그별 표본이 작아 소스 구성은 보정하지 않았으니 방향만 참고하세요.
      </p>
    </>
  )
}

export default function Trends() {
  const [rows, setRows] = useState([])
  const [rounds, setRounds] = useState([])   // 투자 라운드 (회사 1 : 라운드 N) — 금액 집계는 이쪽
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isConfigured) {
      setError('Supabase 환경변수가 설정되지 않았습니다.')
      setLoading(false)
      return
    }
    ;(async () => {
      // PostgREST 1회 상한(1000) 때문에 페이지로 받는다. 필요한 열만 — 전체 행은 4MB 가 넘는다.
      const fetchAll = async (build) => {
        const all = []
        for (let from = 0; ; from += 1000) {
          const { data, error: e } = await build().range(from, from + 999)
          if (e) throw e
          all.push(...data)
          if (data.length < 1000) return all
        }
      }
      try {
        const [biz, rnd] = await Promise.all([
          fetchAll(() => supabase.from('businesses').select(COLS).eq('status', 'published').order('created_at')),
          fetchAll(() => supabase.from('funding_rounds').select(ROUND_COLS).order('reported_at')),
        ])
        setRows(biz.filter((r) => !SEED_SOURCES.has(r.source_name)))
        setRounds(roundsToRows(rnd))
      } catch (e) {
        setError(e.message)
      }
      setLoading(false)
    })()
  }, [])

  const funded = rounds.filter((r) => r.funding_usd_m != null).length

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-5">
        <h1 className="text-xl font-bold tracking-tight">투자 흐름</h1>
        <p className="mt-1 text-sm text-ink-600">
          자동 수집한 {rows.length.toLocaleString()}건과 투자 라운드 {rounds.length.toLocaleString()}건(금액 확인 {funded.toLocaleString()}건)을 같은 축으로 집계했습니다.
        </p>
      </header>

      <div className="mb-6 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
        <Info size={18} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">이 숫자는 시장 전체가 아니라 <em className="not-italic underline">테크 매체가 보도한 것</em>입니다.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px]">
            <li>소스는 TechCrunch·Tech.eu·EU-Startups·e27·TechNode·YC 등 10곳이고, 유럽 매체 비중이 큽니다.</li>
            <li>금액은 기사에 적힌 숫자를 고정 환율로 달러 환산한 근사치입니다. IPO·대출·인수·보조금은 라운드 집계에서 뺍니다.</li>
            <li>투자 금액은 라운드 단위로 셉니다. 같은 회사의 후속 라운드도 따로 잡히고, 같은 라운드를 여러 매체가 보도하면 하나로 합칩니다(2026-10-07부터).</li>
            <li>위키데이터·DART로 검증해 일부러 넣은 대기업 시드는 제외했습니다.</li>
          </ul>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-16 text-ink-500"><Loader2 className="animate-spin" size={18} /> 불러오는 중…</div>
      ) : error ? (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <AlertTriangle size={16} /> {error}
        </div>
      ) : (
        <>
          <Section
            title="단계별 라운드 크기 — 지역 비교"
            desc="각 칸은 그 단계·지역 라운드 금액의 중앙값입니다. 5건 미만이면 표시하지 않고, 15건 미만이면 흐리게 표시합니다."
          >
            <StageTable rows={rounds} />
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section
              title="분야별 라운드 중앙값"
              desc="VC 라운드와 단계가 적히지 않은 투자 금액을 합쳐 계산했습니다. 8건 이상인 분야만 표시합니다. 중앙값이라 메가딜 몇 건에 끌려가지 않습니다."
            >
              <CategoryBars rows={rounds} />
            </Section>

            <Section title="떠오르는 태그" desc="최근 30일에 이전보다 자주 붙은 키워드입니다.">
              <RisingTags rows={rows} />
            </Section>
          </div>

          <Section title="월별 비중" desc="그달 수집분 중 해당 분야(또는 고객 유형)가 차지한 비율입니다.">
            <ShareMatrix rows={rows} />
          </Section>
        </>
      )}
    </div>
  )
}
