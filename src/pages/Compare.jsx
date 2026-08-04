import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, X } from 'lucide-react'
import { supabase, isConfigured } from '../lib/supabase'
import { useStore } from '../lib/store.jsx'
import { Scale, AXES } from '../components/Scale.jsx'

// 비교표의 행 정의. 값 렌더링 방식이 제각각이라 선언적으로 모아둔다.
const ROWS = [
  { key: 'one_liner', label: '한 줄 요약', render: (b) => b.one_liner },
  { key: 'category', label: '산업', render: (b, l) => l('category', b.category) },
  { key: 'customer_type', label: '고객 유형', render: (b, l) => l('customer_type', b.customer_type) },
  {
    key: 'revenue_models',
    label: '수익 모델',
    render: (b, l) => (
      <div className="flex flex-wrap gap-1">
        {b.revenue_models?.length
          ? b.revenue_models.map((m) => (
              <span key={m} className="rounded bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700">
                {l('revenue_model', m)}
              </span>
            ))
          : '—'}
      </div>
    ),
  },
  {
    key: 'moats',
    label: '해자',
    render: (b, l) => (
      <div className="flex flex-wrap gap-1">
        {b.moats?.length
          ? b.moats.map((m) => (
              <span key={m} className="rounded bg-ink-100 px-1.5 py-0.5 text-xs font-medium text-ink-700">
                {l('moat', m)}
              </span>
            ))
          : '—'}
      </div>
    ),
  },
  { key: 'pricing_note', label: '과금 방식', render: (b) => b.pricing_note ?? '—' },
  {
    key: 'capital_intensity',
    label: AXES.capital_intensity.label,
    render: (b) => <Scale value={b.capital_intensity} tone="warn" compact />,
  },
  {
    key: 'replicability',
    label: AXES.replicability.label,
    render: (b) => <Scale value={b.replicability} tone="warn" compact />,
  },
  {
    key: 'korea_fit',
    label: AXES.korea_fit.label,
    render: (b) => <Scale value={b.korea_fit} tone="good" compact />,
  },
  { key: 'korea_note', label: '한국 적용성 근거', render: (b) => b.korea_note ?? '—' },
  { key: 'why_it_works', label: '왜 작동하는가', render: (b) => b.why_it_works ?? '—' },
  {
    key: 'risks',
    label: '리스크',
    render: (b) =>
      b.risks?.length ? (
        <ul className="list-disc space-y-1 pl-4">
          {b.risks.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      ) : '—',
  },
]

export default function Compare() {
  const { compare, toggleCompare, clearCompare, labelOf, MAX_COMPARE } = useStore()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isConfigured || compare.length === 0) { setRows([]); setLoading(false); return }
    setLoading(true)
    supabase
      .from('businesses').select('*').in('id', compare.map((b) => b.id))
      .then(({ data }) => {
        // 사용자가 담은 순서를 유지한다 (DB 반환 순서는 보장되지 않음)
        const byId = new Map((data ?? []).map((d) => [d.id, d]))
        setRows(compare.map((c) => byId.get(c.id)).filter(Boolean))
        setLoading(false)
      })
  }, [compare])

  if (loading) {
    return (
      <div className="flex justify-center py-24 text-ink-400">
        <Loader2 className="animate-spin" />
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20 text-center">
        <h1 className="text-xl font-bold">비교할 항목이 없습니다</h1>
        <p className="mt-2 text-sm text-ink-500">
          목록에서 <span className="font-medium">+</span> 버튼을 눌러 최대 {MAX_COMPARE}개까지 담아보세요.
        </p>
        <Link
          to="/"
          className="mt-4 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white"
        >
          탐색하러 가기
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">비교 ({rows.length})</h1>
        <button
          type="button"
          onClick={clearCompare}
          className="text-sm text-ink-500 hover:text-ink-800"
        >
          전체 비우기
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-ink-200">
              <th className="w-32 bg-ink-50 p-3 text-left text-xs font-semibold text-ink-400">항목</th>
              {rows.map((b) => (
                <th key={b.id} className="p-3 text-left align-top">
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/b/${b.slug}`} className="font-semibold text-ink-900 hover:text-brand-700">
                      {b.name}
                    </Link>
                    <button
                      type="button"
                      onClick={() => toggleCompare(b)}
                      className="shrink-0 text-ink-300 hover:text-rose-500"
                      title="비교에서 제외"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.key} className="border-b border-ink-100 last:border-0">
                <th className="bg-ink-50 p-3 text-left align-top text-xs font-medium text-ink-500">
                  {row.label}
                </th>
                {rows.map((b) => (
                  <td key={b.id} className="p-3 align-top text-ink-700">
                    {row.render(b, labelOf)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
