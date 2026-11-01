import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, SlidersHorizontal, Loader2, X, Sparkles } from 'lucide-react'
import { supabase, isConfigured } from '../lib/supabase'
import { useStore } from '../lib/store.jsx'
import BusinessCard from '../components/BusinessCard.jsx'
import FilterPanel from '../components/FilterPanel.jsx'
import TodayStrip from '../components/TodayStrip.jsx'
import { kstDayStart, kstDayRange } from '../lib/today'
import { EMPTY, readFilters, filtersToPatch, searchOr } from '../lib/explore'

const PAGE_SIZE = 24

// 검증된 모델을 기본으로 보여준다. 신생 스타트업만 잔뜩 보이면 아직 작동하는지도 모르는
// 회사들이 첫 화면을 채워 신뢰가 생기지 않는다.
const TIERS = {
  proven: { label: '검증된 모델', hint: '설립 5년 이상 · 공개 데이터로 실체와 규모가 확인된 회사' },
  emerging: { label: '최신 동향', hint: '자동 수집된 신생 서비스 · 아직 검증되지 않음' },
  all: { label: '전체', hint: '검증된 모델과 최신 동향을 함께 봅니다' },
}

// 등록 시점 필터. 오늘 수집분은 tier 가 섞여 들어오므로(로컬 시드=proven, 파이프라인=emerging)
// 이 필터로 진입할 때는 tier 를 all 로 두지 않으면 방금 들어온 항목이 탭 뒤에 숨는다.
const PERIODS = {
  today: { label: '오늘 신규', days: 0 },
  d3: { label: '최근 3일', days: 2 },
  d7: { label: '최근 7일', days: 6 },
}

const SORTS = {
  newest: { label: '최신순', column: 'created_at', ascending: false },
  korea: { label: '한국 적용성', column: 'korea_fit', ascending: false },
  lean: { label: '적은 자본순', column: 'capital_intensity', ascending: true },
  defensible: { label: '복제 어려운순', column: 'replicability', ascending: true },
}

// 상세에 들어갔다 뒤로 오면 같은 결과를 즉시 그려야 스크롤 위치가 복원된다.
// 주소(필터 전체) 단위로 마지막 결과를 들고 있다가 먼저 그리고, 뒤에서 다시 받아 갱신한다.
const cache = new Map()

function applyFilters(q, { filters, tier, since, day }) {
  q = q.eq('status', 'published')
  if (tier !== 'all') q = q.eq('tier', tier)
  if (day) {
    const r = kstDayRange(day)
    if (r) q = q.gte('created_at', r.start.toISOString()).lt('created_at', r.end.toISOString())
  } else if (since) {
    q = q.gte('created_at', kstDayStart(PERIODS[since].days).toISOString())
  }
  if (filters.q.trim()) q = q.or(searchOr(filters.q.trim()))
  if (filters.category) q = q.eq('category', filters.category)
  if (filters.customer_type) q = q.eq('customer_type', filters.customer_type)
  if (filters.revenue_models.length) q = q.overlaps('revenue_models', filters.revenue_models)
  if (filters.moats.length) q = q.overlaps('moats', filters.moats)
  // 척도 필터는 값이 있는 행만 대상으로 한다 (미평가 항목이 섞이면 결과가 흐려짐)
  if (filters.korea_fit_min > 1) q = q.gte('korea_fit', filters.korea_fit_min)
  if (filters.capital_max < 5) q = q.lte('capital_intensity', filters.capital_max)
  return q
}

// 지금 걸린 필터를 결과 위에 칩으로 보여주고 하나씩 풀 수 있게 한다.
function ActiveChips({ filters, since, day, onPatch, labelOf }) {
  const chips = []
  if (filters.q.trim()) chips.push([`"${filters.q.trim()}"`, { q: '' }])
  if (filters.category) chips.push([labelOf('category', filters.category), { cat: '' }])
  if (filters.customer_type) chips.push([labelOf('customer_type', filters.customer_type), { cust: '' }])
  for (const m of filters.revenue_models)
    chips.push([labelOf('revenue_model', m), { rev: filters.revenue_models.filter((v) => v !== m).join(',') }])
  for (const m of filters.moats)
    chips.push([`해자: ${labelOf('moat', m)}`, { moat: filters.moats.filter((v) => v !== m).join(',') }])
  if (filters.korea_fit_min > 1) chips.push([`한국 ${filters.korea_fit_min}점 이상`, { kfit: '' }])
  if (filters.capital_max < 5) chips.push([`자본 ${filters.capital_max}점 이하`, { cap: '' }])
  if (day) chips.push([`${day} 등록분`, { day: '' }])
  else if (since) chips.push([PERIODS[since].label, { since: '' }])
  if (!chips.length) return null

  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {chips.map(([label, patch]) => (
        <button
          key={label}
          type="button"
          onClick={() => onPatch(patch)}
          className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pr-2 pl-2.5 text-xs font-medium text-brand-700 hover:bg-brand-100"
          title="이 조건 풀기"
        >
          {label}
          <X size={12} />
        </button>
      ))}
    </div>
  )
}

export default function Home() {
  const { labelOf } = useStore()
  const [params, setParams] = useSearchParams()
  const tier = TIERS[params.get('tier')] ? params.get('tier') : 'proven'
  const since = PERIODS[params.get('since')] ? params.get('since') : ''
  // day 는 특정 하루만 본다(추이 그래프의 막대에서 진입). since 보다 우선한다.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day') : ''
  const sort = SORTS[params.get('sort')] ? params.get('sort') : 'newest'
  const page = Math.max(0, (Number.parseInt(params.get('page') ?? '', 10) || 1) - 1)
  const paramKey = params.toString()
  const filters = useMemo(() => readFilters(new URLSearchParams(paramKey)), [paramKey])

  const patchParams = useCallback(
    (patch) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(patch)) {
            if (v) next.set(k, v)
            else next.delete(k)
          }
          return next
        },
        { replace: true },
      ),
    [setParams],
  )

  // 조건이 바뀌면 항상 1페이지부터
  const patchFilters = useCallback((patch) => patchParams({ ...patch, page: '' }), [patchParams])

  // FilterPanel 은 setState 처럼 갱신 함수를 넘긴다
  const setFilters = useCallback(
    (upd) => patchFilters(filtersToPatch(typeof upd === 'function' ? upd(filters) : upd)),
    [filters, patchFilters],
  )

  // 입력 중인 값. 주소의 q 는 디바운스 후에 바뀐다.
  const [query, setQuery] = useState(filters.q)
  useEffect(() => { setQuery(filters.q) }, [filters.q])
  useEffect(() => {
    if (query === filters.q) return
    const t = setTimeout(() => patchFilters({ q: query }), 350)
    return () => clearTimeout(t)
  }, [query, filters.q, patchFilters])

  const cached = cache.get(paramKey)
  const [rows, setRows] = useState(cached?.rows ?? [])
  const [count, setCount] = useState(cached?.count ?? 0)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState(null)
  const [showFilters, setShowFilters] = useState(false)
  // 결과가 0건일 때 다른 탭에 있는 건수. 기본 탭(검증된 모델)은 전체의 일부라 여기서 헛걸음하기 쉽다.
  const [elsewhere, setElsewhere] = useState(null)

  const activeCount = useMemo(() => {
    let n = 0
    if (filters.category) n++
    if (filters.customer_type) n++
    n += filters.revenue_models.length
    n += filters.moats.length
    if (filters.korea_fit_min > 1) n++
    if (filters.capital_max < 5) n++
    if (since || day) n++
    return n
  }, [filters, since, day])

  const resetAll = useCallback(() => {
    setQuery('')
    patchFilters({ ...filtersToPatch(EMPTY), since: '', day: '' })
  }, [patchFilters])

  useEffect(() => {
    if (!isConfigured) {
      setError('Supabase 환경변수(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)가 설정되지 않았습니다.')
      setLoading(false)
      return
    }
    let stale = false
    const hit = cache.get(paramKey)
    if (hit) {
      setRows(hit.rows)
      setCount(hit.count)
      setLoading(false)
    } else {
      setLoading(true)
    }
    setError(null)
    setElsewhere(null)

    const ctx = { filters, tier, since, day }
    const s = SORTS[sort]
    applyFilters(supabase.from('businesses').select('*', { count: 'exact' }), ctx)
      .order(s.column, { ascending: s.ascending, nullsFirst: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
      .then(async ({ data, count: total, error: err }) => {
        if (stale) return
        if (err) { setError(err.message); setLoading(false); return }
        cache.set(paramKey, { rows: data ?? [], count: total ?? 0 })
        setRows(data ?? [])
        setCount(total ?? 0)
        setLoading(false)
        if (!total && tier !== 'all') {
          const { count: n } = await applyFilters(
            supabase.from('businesses').select('id', { count: 'exact', head: true }),
            { ...ctx, tier: 'all' },
          )
          if (!stale && n) setElsewhere(n)
        }
      })
    return () => { stale = true }
  }, [paramKey, filters, tier, since, day, sort, page])

  const totalPages = Math.ceil(count / PAGE_SIZE)
  const goPage = (p) => {
    patchParams({ page: p > 0 ? String(p + 1) : '' })
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <section className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          전세계 비즈니스 모델, 같은 축으로 비교하기
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-600">
          링크 모음이 아닙니다. 수익 구조 · 해자 · 자본 집약도 · 복제 용이성 · 한국 적용성으로
          태깅해 필터하고 나란히 비교합니다. 세 점수 축은 함께 봐야 의미가 있습니다 —
          어느 하나가 판단을 대신하지는 않습니다.
        </p>
      </section>

      {day || since ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-800">
            <Sparkles size={14} />
            {day ? `${day} 등록분` : PERIODS[since].label}만 보는 중
          </span>
          <span className="text-sm text-brand-900">
            {loading ? '…' : `${count.toLocaleString()}건`}
          </span>
          <div className="flex gap-1">
            {Object.entries(PERIODS).map(([key, p]) => (
              <button
                key={key}
                type="button"
                onClick={() => patchFilters({ since: key, day: '' })}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  !day && since === key
                    ? 'bg-brand-600 text-white'
                    : 'bg-white text-brand-700 hover:bg-brand-100'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => patchFilters({ since: '', day: '' })}
            className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
          >
            <X size={12} /> 기간 해제
          </button>
        </div>
      ) : (
        <TodayStrip />
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-ink-200 bg-white p-0.5">
          {Object.entries(TIERS).map(([key, t]) => (
            <button
              key={key}
              type="button"
              onClick={() => patchFilters({ tier: key === 'proven' ? '' : key })}
              title={t.hint}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                tier === key ? 'bg-brand-600 text-white' : 'text-ink-500 hover:text-ink-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="relative min-w-56 flex-1">
          <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-ink-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="회사명, 키워드로 검색"
            className="w-full rounded-lg border border-ink-200 bg-white py-2 pr-8 pl-9 text-sm outline-none focus:border-brand-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); patchFilters({ q: '' }) }}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-ink-400 hover:text-ink-700"
              aria-label="검색어 지우기"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <select
          value={sort}
          onChange={(e) => patchFilters({ sort: e.target.value === 'newest' ? '' : e.target.value })}
          className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500"
        >
          {Object.entries(SORTS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setShowFilters(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm font-medium lg:hidden"
        >
          <SlidersHorizontal size={15} />
          필터{activeCount > 0 && ` (${activeCount})`}
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        {/* 넓은 화면은 옆에 붙이고, 폰에서는 아래에서 올라오는 시트로 연다 — 목록 위에 펼치면 결과가 한참 밀려난다 */}
        <div className="hidden lg:block">
          <FilterPanel filters={filters} setFilters={setFilters} onReset={resetAll} activeCount={activeCount} />
        </div>
        {showFilters && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-ink-900/40" onClick={() => setShowFilters(false)} />
            <div className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl bg-white shadow-xl">
              <div className="overflow-y-auto p-3">
                <FilterPanel filters={filters} setFilters={setFilters} onReset={resetAll} activeCount={activeCount} />
              </div>
              <div className="border-t border-ink-200 p-3">
                <button
                  type="button"
                  onClick={() => setShowFilters(false)}
                  className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white"
                >
                  {loading ? '불러오는 중…' : `${count.toLocaleString()}건 보기`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* min-w-0: 카드 안의 한 줄 말줄임(truncate) 글자가 그리드 칸을 밀어 폰에서 가로로 넘치던 것을 막는다 */}
        <div className="min-w-0">
          <ActiveChips filters={filters} since={since} day={day} onPatch={patchFilters} labelOf={labelOf} />

          <div className="mb-3 text-sm text-ink-500">
            {loading ? '불러오는 중…' : `${count.toLocaleString()}건`}
            <span className="ml-2 text-xs text-ink-400">{TIERS[tier].hint}</span>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              {error}
            </div>
          )}

          {loading && (
            <div className="flex justify-center py-16 text-ink-400">
              <Loader2 className="animate-spin" />
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="rounded-xl border border-dashed border-ink-300 p-10 text-center">
              <p className="text-sm text-ink-500">{TIERS[tier].label}에는 조건에 맞는 항목이 없습니다.</p>
              {elsewhere ? (
                <button
                  type="button"
                  onClick={() => patchFilters({ tier: 'all' })}
                  className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white"
                >
                  전체에서 {elsewhere.toLocaleString()}건 보기
                </button>
              ) : (
                <button
                  type="button"
                  onClick={resetAll}
                  className="mt-3 text-sm font-medium text-brand-700 hover:underline"
                >
                  필터 초기화
                </button>
              )}
            </div>
          )}

          {!loading && rows.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {rows.map((biz) => <BusinessCard key={biz.id} biz={biz} />)}
            </div>
          )}

          {totalPages > 1 && (
            <div className="mt-6 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => goPage(Math.max(0, page - 1))}
                disabled={page === 0}
                className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm disabled:opacity-40"
              >
                이전
              </button>
              <span className="text-sm text-ink-500">
                {page + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => goPage(Math.min(totalPages - 1, page + 1))}
                disabled={page >= totalPages - 1}
                className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm disabled:opacity-40"
              >
                다음
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
