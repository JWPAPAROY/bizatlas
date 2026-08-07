import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, RefreshCw, AlertTriangle, Clock } from 'lucide-react'
import { supabase, isConfigured } from '../lib/supabase'
import BusinessCard from '../components/BusinessCard.jsx'
import { useStore } from '../lib/store.jsx'
import { kstDayKey, kstDayStart, fmtKstTime, nextRunLabel, sumRuns } from '../lib/today'

// 시간·집계 규칙과 그 전제(신규 등록 ≠ 파이프라인 처리량)는 lib/today.js 주석 참조.

const TREND_DAYS = 7

function Tile({ label, value, hint, tone = 'ink' }) {
  const tones = {
    brand: 'text-brand-700',
    ink: 'text-ink-900',
    muted: 'text-ink-500',
    danger: 'text-rose-600',
  }
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4">
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tones[tone]}`}>{value.toLocaleString()}</p>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-ink-400">{hint}</p>}
    </div>
  )
}

// 단일 측정값(일별 신규 등록)의 크기 비교 — 한 가지 색조만 쓰고, 오늘만 진하게 강조한다.
function TrendBars({ days }) {
  const max = Math.max(1, ...days.map((d) => d.count))
  return (
    <div className="flex items-end gap-2">
      {days.map((d) => (
        <div key={d.key} className="flex flex-1 flex-col items-center gap-1">
          <span className="text-[11px] font-medium tabular-nums text-ink-500">
            {d.count > 0 ? d.count : ''}
          </span>
          <div
            title={`${d.key} · ${d.count}건`}
            className={`w-full rounded-t ${d.today ? 'bg-brand-600' : 'bg-brand-200'}`}
            style={{ height: `${d.count > 0 ? Math.max(4, (d.count / max) * 64) : 2}px` }}
          />
          <span
            className={`text-[11px] tabular-nums ${d.today ? 'font-semibold text-ink-700' : 'text-ink-400'}`}
          >
            {d.key.slice(5)}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function Today() {
  const { labelOf } = useStore()
  const [runs, setRuns] = useState([])
  const [weekRows, setWeekRows] = useState([])
  const [todayRows, setTodayRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loadedAt, setLoadedAt] = useState(null)

  const load = useCallback(async () => {
    if (!isConfigured) {
      setError('Supabase 환경변수(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)가 설정되지 않았습니다.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)

    const weekStart = kstDayStart(TREND_DAYS - 1).toISOString()
    const todayStart = kstDayStart(0).toISOString()

    const [runsRes, weekRes, todayRes] = await Promise.all([
      supabase
        .from('ingest_runs')
        .select('*')
        .gte('started_at', weekStart)
        .order('started_at', { ascending: false }),
      // 추이에는 날짜만 있으면 된다 — 7일치 전체 행을 받을 필요가 없다.
      supabase
        .from('businesses')
        .select('created_at')
        .eq('status', 'published')
        .gte('created_at', weekStart),
      supabase
        .from('businesses')
        .select('*')
        .eq('status', 'published')
        .gte('created_at', todayStart)
        .order('created_at', { ascending: false }),
    ])

    const firstErr = runsRes.error ?? weekRes.error ?? todayRes.error
    if (firstErr) setError(firstErr.message)
    else {
      setRuns(runsRes.data ?? [])
      setWeekRows(weekRes.data ?? [])
      setTodayRows(todayRes.data ?? [])
      setLoadedAt(new Date())
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const todayKey = kstDayKey(Date.now())

  const todayRuns = useMemo(
    () => runs.filter((r) => kstDayKey(r.started_at) === todayKey),
    [runs, todayKey],
  )

  const totals = useMemo(() => sumRuns(todayRuns), [todayRuns])

  // 소스별 집계 — detail 은 { 소스명: {fetched,created,skipped,failed,error}, _errors: [...] } 구조.
  // 밑줄로 시작하는 키는 메타라 소스가 아니다.
  const bySource = useMemo(() => {
    const map = new Map()
    for (const r of todayRuns) {
      for (const [name, d] of Object.entries(r.detail ?? {})) {
        if (name.startsWith('_') || typeof d !== 'object' || d === null) continue
        const cur = map.get(name) ?? { name, fetched: 0, created: 0, skipped: 0, failed: 0, error: null }
        cur.fetched += d.fetched ?? 0
        cur.created += d.created ?? 0
        cur.skipped += d.skipped ?? 0
        cur.failed += d.failed ?? 0
        if (d.error) cur.error = d.error
        map.set(name, cur)
      }
    }
    return [...map.values()].sort((a, b) => b.created - a.created || b.fetched - a.fetched)
  }, [todayRuns])

  const trend = useMemo(() => {
    const counts = new Map()
    for (const b of weekRows) {
      const k = kstDayKey(b.created_at)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return Array.from({ length: TREND_DAYS }, (_, i) => {
      const key = kstDayKey(kstDayStart(TREND_DAYS - 1 - i))
      return { key, count: counts.get(key) ?? 0, today: key === todayKey }
    })
  }, [weekRows, todayKey])

  const tierCount = useMemo(
    () => ({
      proven: todayRows.filter((b) => b.tier === 'proven').length,
      emerging: todayRows.filter((b) => b.tier === 'emerging').length,
    }),
    [todayRows],
  )

  const byCategory = useMemo(() => {
    const map = new Map()
    for (const b of todayRows) map.set(b.category ?? 'other', (map.get(b.category ?? 'other') ?? 0) + 1)
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [todayRows])

  const running = todayRuns.some((r) => !r.finished_at)

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <section className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">오늘의 수집</h1>
          <p className="mt-1 text-sm text-ink-600">
            {todayKey} (KST) 기준. 4시간마다 소스를 읽어 새로 올라온 항목만 AI 가 구조화합니다.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-400">
          {loadedAt && <span>{fmtKstTime(loadedAt)} 기준</span>}
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:border-brand-200"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            새로고침
          </button>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
      )}

      {loading && !loadedAt && !error && (
        <div className="flex justify-center py-16 text-ink-400">
          <Loader2 className="animate-spin" />
        </div>
      )}

      {!error && loadedAt && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile
              label="오늘 새로 등록"
              value={todayRows.length}
              tone="brand"
              hint={`검증된 모델 ${tierCount.proven} · 최신 동향 ${tierCount.emerging}`}
            />
            <Tile
              label="파이프라인 검토"
              value={totals.fetched}
              hint={`${todayRuns.length}회 실행 · 다음 ${nextRunLabel()}`}
            />
            <Tile
              label="반려 · 중복"
              value={totals.skipped}
              tone="muted"
              hint="이미 판정했거나 회사·모델로 볼 수 없는 항목"
            />
            <Tile
              label="실패"
              value={totals.failed}
              tone={totals.failed > 0 ? 'danger' : 'muted'}
              hint={totals.failed > 0 ? 'AI 쿼터 소진이나 소스 오류일 수 있음' : '오류 없음'}
            />
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
            ‘새로 등록’은 실제로 저장된 항목 수입니다. ‘검토’는 매 실행마다 피드 전체를 다시 훑은 수라
            같은 항목이 반복해서 세어지고, 이미 판정한 것은 그대로 ‘반려·중복’으로 빠집니다.
            검증된 모델(proven)은 별도 시드 스크립트로 들어와 파이프라인 통계에는 잡히지 않습니다.
          </p>

          {running && (
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700">
              <Loader2 size={13} className="animate-spin" />
              수집이 진행 중입니다 — 숫자가 더 늘 수 있습니다.
            </p>
          )}

          <section className="mt-6 rounded-xl border border-ink-200 bg-white p-4">
            <h2 className="text-sm font-semibold">최근 7일 신규 등록</h2>
            <p className="mt-0.5 mb-3 text-xs text-ink-500">일자별 저장된 항목 수 (KST)</p>
            <TrendBars days={trend} />
          </section>

          <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_320px]">
            <section className="rounded-xl border border-ink-200 bg-white">
              <div className="border-b border-ink-100 px-4 py-3">
                <h2 className="text-sm font-semibold">소스별 오늘 결과</h2>
                <p className="mt-0.5 text-xs text-ink-500">
                  한 번 판정한 항목은 다시 처리하지 않으므로, 새 글이 없으면 검토 수도 0 입니다.
                </p>
              </div>
              {bySource.length === 0 ? (
                <p className="px-4 py-6 text-sm text-ink-500">오늘 실행된 수집이 아직 없습니다.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-ink-100 text-xs text-ink-500">
                        <th className="px-4 py-2 text-left font-medium">소스</th>
                        <th className="px-3 py-2 text-right font-medium">검토</th>
                        <th className="px-3 py-2 text-right font-medium">신규</th>
                        <th className="px-3 py-2 text-right font-medium">반려</th>
                        <th className="px-4 py-2 text-right font-medium">실패</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {bySource.map((s) => (
                        <tr key={s.name}>
                          <td className="px-4 py-2">
                            <span className="font-medium text-ink-800">{s.name}</span>
                            {s.error && (
                              <span
                                className="ml-1.5 inline-flex items-center gap-1 align-middle text-[11px] text-amber-700"
                                title="이 소스에서 오류가 있었습니다"
                              >
                                <AlertTriangle size={11} />
                                오류
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink-600">{s.fetched}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold text-brand-700">
                            {s.created || <span className="font-normal text-ink-300">0</span>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink-400">{s.skipped}</td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${s.failed ? 'text-rose-600' : 'text-ink-300'}`}
                          >
                            {s.failed}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div className="space-y-5">
              <section className="rounded-xl border border-ink-200 bg-white p-4">
                <h2 className="text-sm font-semibold">오늘 실행 이력</h2>
                {todayRuns.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-500">아직 실행 전입니다. 다음 예정 {nextRunLabel()}.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {todayRuns.map((r) => (
                      <li key={r.id} className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="inline-flex items-center gap-1.5 tabular-nums text-ink-700">
                          <Clock size={12} className="text-ink-400" />
                          {fmtKstTime(r.started_at)}
                        </span>
                        <span className="text-xs text-ink-500">
                          {r.finished_at ? (
                            <>
                              신규 <strong className="text-ink-800">{r.created}</strong> / 검토 {r.fetched}
                              {r.failed > 0 && <span className="text-rose-600"> · 실패 {r.failed}</span>}
                            </>
                          ) : (
                            <span className="text-brand-700">진행 중</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {byCategory.length > 0 && (
                <section className="rounded-xl border border-ink-200 bg-white p-4">
                  <h2 className="text-sm font-semibold">오늘 등록된 분야</h2>
                  <ul className="mt-3 space-y-1.5">
                    {byCategory.map(([cat, n]) => (
                      <li key={cat} className="flex items-center gap-2 text-sm">
                        <span className="w-24 shrink-0 truncate text-ink-700" title={labelOf('category', cat)}>
                          {labelOf('category', cat)}
                        </span>
                        <span
                          className="h-2 rounded-full bg-brand-200"
                          style={{ width: `${(n / byCategory[0][1]) * 100}%`, minWidth: 6 }}
                        />
                        <span className="tabular-nums text-xs text-ink-500">{n}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>

          <section className="mt-8">
            <h2 className="text-lg font-semibold">오늘 추가된 항목</h2>
            {todayRows.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-ink-300 p-10 text-center">
                <p className="text-sm text-ink-500">
                  오늘은 아직 새로 등록된 항목이 없습니다.
                  {totals.fetched > 0 && ' 검토는 있었지만 기준을 통과한 항목이 없었습니다.'}
                </p>
                <Link to="/" className="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline">
                  전체 목록 보기
                </Link>
              </div>
            ) : (
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {todayRows.map((biz) => (
                  <BusinessCard key={biz.id} biz={biz} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
