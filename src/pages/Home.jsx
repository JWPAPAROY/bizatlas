import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, SlidersHorizontal, Loader2 } from 'lucide-react'
import { supabase, isConfigured } from '../lib/supabase'
import BusinessCard from '../components/BusinessCard.jsx'
import FilterPanel from '../components/FilterPanel.jsx'

const PAGE_SIZE = 24

const EMPTY = {
  q: '',
  category: '',
  customer_type: '',
  revenue_models: [],
  moats: [],
  korea_fit_min: 1,
  capital_max: 5,
}

// 검증된 모델을 기본으로 보여준다. 신생 스타트업만 잔뜩 보이면 아직 작동하는지도 모르는
// 회사들이 첫 화면을 채워 신뢰가 생기지 않는다.
const TIERS = {
  proven: { label: '검증된 모델', hint: '설립 5년 이상 · 공개 데이터로 실체와 규모가 확인된 회사' },
  emerging: { label: '최신 동향', hint: '자동 수집된 신생 서비스 · 아직 검증되지 않음' },
}

const SORTS = {
  newest: { label: '최신순', column: 'created_at', ascending: false },
  korea: { label: '한국 적용성', column: 'korea_fit', ascending: false },
  lean: { label: '적은 자본순', column: 'capital_intensity', ascending: true },
  defensible: { label: '복제 어려운순', column: 'replicability', ascending: true },
}

export default function Home() {
  const [filters, setFilters] = useState(EMPTY)
  const [tier, setTier] = useState('proven')
  const [query, setQuery] = useState('')       // 입력 중인 값
  const [sort, setSort] = useState('newest')
  const [rows, setRows] = useState([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showFilters, setShowFilters] = useState(false)

  // 타이핑마다 쿼리를 날리지 않도록 디바운스
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, q: query })), 350)
    return () => clearTimeout(t)
  }, [query])

  // 필터가 바뀌면 항상 1페이지부터
  useEffect(() => { setPage(0) }, [filters, sort, tier])

  const activeCount = useMemo(() => {
    let n = 0
    if (filters.category) n++
    if (filters.customer_type) n++
    n += filters.revenue_models.length
    n += filters.moats.length
    if (filters.korea_fit_min > 1) n++
    if (filters.capital_max < 5) n++
    return n
  }, [filters])

  const load = useCallback(async () => {
    if (!isConfigured) {
      setError('Supabase 환경변수(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)가 설정되지 않았습니다.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)

    let q = supabase.from('businesses').select('*', { count: 'exact' })
      .eq('status', 'published')
      .eq('tier', tier)

    if (filters.q.trim()) {
      q = q.textSearch('search_tsv', filters.q.trim(), { config: 'simple', type: 'websearch' })
    }
    if (filters.category) q = q.eq('category', filters.category)
    if (filters.customer_type) q = q.eq('customer_type', filters.customer_type)
    if (filters.revenue_models.length) q = q.overlaps('revenue_models', filters.revenue_models)
    if (filters.moats.length) q = q.overlaps('moats', filters.moats)
    // 척도 필터는 값이 있는 행만 대상으로 한다 (미평가 항목이 섞이면 결과가 흐려짐)
    if (filters.korea_fit_min > 1) q = q.gte('korea_fit', filters.korea_fit_min)
    if (filters.capital_max < 5) q = q.lte('capital_intensity', filters.capital_max)

    const s = SORTS[sort]
    q = q
      .order(s.column, { ascending: s.ascending, nullsFirst: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

    const { data, count: total, error: err } = await q
    if (err) setError(err.message)
    else {
      setRows(data ?? [])
      setCount(total ?? 0)
    }
    setLoading(false)
  }, [filters, sort, page, tier])

  useEffect(() => { load() }, [load])

  const totalPages = Math.ceil(count / PAGE_SIZE)

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <section className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          전세계 비즈니스 모델, 같은 축으로 비교하기
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-600">
          링크 모음이 아닙니다. 수익 구조 · 해자 · 자본 집약도 · 한국 적용성으로 태깅해
          필터하고 나란히 비교합니다. 검증된 모델은 공개 데이터로 실체를 확인하고,
          최신 동향은 4시간마다 자동 수집됩니다.
        </p>
      </section>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-ink-200 bg-white p-0.5">
          {Object.entries(TIERS).map(([key, t]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTier(key)}
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
            className="w-full rounded-lg border border-ink-200 bg-white py-2 pr-3 pl-9 text-sm outline-none focus:border-brand-500"
          />
        </div>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500"
        >
          {Object.entries(SORTS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm font-medium lg:hidden"
        >
          <SlidersHorizontal size={15} />
          필터{activeCount > 0 && ` (${activeCount})`}
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <div className={showFilters ? 'block' : 'hidden lg:block'}>
          <FilterPanel
            filters={filters}
            setFilters={setFilters}
            onReset={() => { setFilters(EMPTY); setQuery('') }}
            activeCount={activeCount}
          />
        </div>

        <div>
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
              <p className="text-sm text-ink-500">조건에 맞는 항목이 없습니다.</p>
              <button
                type="button"
                onClick={() => { setFilters(EMPTY); setQuery('') }}
                className="mt-3 text-sm font-medium text-brand-700 hover:underline"
              >
                필터 초기화
              </button>
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
                onClick={() => setPage((p) => Math.max(0, p - 1))}
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
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
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
