import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Loader2 } from 'lucide-react'
import { supabase, isConfigured } from '../lib/supabase'
import { kstDayKey, kstDayStart, fmtKstTime, nextRunLabel, sumRuns } from '../lib/today'

// 홈 상단 한 줄 요약. 상세는 /today 로 넘긴다.
// 자세한 지표를 여기서 다 보여주면 첫 화면의 주인공(탐색)을 밀어내므로 숫자 세 개만 둔다.

export default function TodayStrip() {
  const [state, setState] = useState(null)

  useEffect(() => {
    if (!isConfigured) return
    let alive = true

    const todayStart = kstDayStart(0).toISOString()
    Promise.all([
      supabase
        .from('businesses')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'published')
        .gte('created_at', todayStart),
      supabase
        .from('ingest_runs')
        .select('fetched, created, skipped, failed, started_at, finished_at')
        .gte('started_at', todayStart)
        .order('started_at', { ascending: false }),
    ]).then(([newRes, runsRes]) => {
      if (!alive || newRes.error || runsRes.error) return
      const runs = runsRes.data ?? []
      setState({
        added: newRes.count ?? 0,
        runs,
        totals: sumRuns(runs),
        running: runs.some((r) => !r.finished_at),
        lastAt: runs[0]?.started_at ?? null,
      })
    })

    return () => { alive = false }
  }, [])

  if (!state) return null

  const { added, runs, totals, running, lastAt } = state

  return (
    <div className="group mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-ink-200 bg-white px-4 py-2.5 transition hover:border-brand-200 hover:shadow-sm">
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-500">
        {running ? (
          <Loader2 size={12} className="animate-spin text-brand-600" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
        )}
        오늘 {kstDayKey(Date.now()).slice(5)}
      </span>

      {/* 숫자 자체가 "그 항목들만 모아보기" 진입점이다. 오늘 들어온 것은 tier 가 섞이므로 all 로 연다. */}
      {added > 0 ? (
        <Link
          to="/?since=today&tier=all"
          className="rounded text-sm text-ink-700 underline decoration-brand-300 underline-offset-4 hover:decoration-brand-600 hover:text-brand-800"
          title="오늘 새로 등록된 항목만 모아 보기"
        >
          새로 등록 <strong className="tabular-nums text-brand-700">{added}</strong>건
        </Link>
      ) : (
        <span className="text-sm text-ink-500">
          새로 등록 <strong className="tabular-nums">0</strong>건
        </span>
      )}
      <span className="text-sm text-ink-600">
        검토 <span className="tabular-nums">{totals.fetched}</span>건
      </span>
      {totals.failed > 0 && (
        <span className="text-sm text-rose-600">
          실패 <span className="tabular-nums">{totals.failed}</span>건
        </span>
      )}

      <span className="text-xs text-ink-400">
        {running
          ? '수집 진행 중'
          : lastAt
            ? `최근 ${fmtKstTime(lastAt)} · 다음 ${nextRunLabel()}`
            : `오늘 실행 전 · 다음 ${nextRunLabel()}`}
        {runs.length > 0 && ` · ${runs.length}회`}
      </span>

      <Link
        to="/today"
        className="ml-auto inline-flex items-center gap-0.5 text-xs font-medium text-brand-700 hover:underline"
      >
        수집 현황
        <ChevronRight size={13} className="transition group-hover:translate-x-0.5" />
      </Link>
    </div>
  )
}
