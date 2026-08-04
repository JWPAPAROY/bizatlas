import { Link } from 'react-router-dom'
import { Plus, Check } from 'lucide-react'
import { useStore } from '../lib/store.jsx'
import { Scale } from './Scale.jsx'

export default function BusinessCard({ biz }) {
  const { labelOf, compare, toggleCompare, MAX_COMPARE } = useStore()
  const selected = compare.some((b) => b.id === biz.id)
  const full = compare.length >= MAX_COMPARE && !selected

  return (
    <article className="group relative flex flex-col rounded-xl border border-ink-200 bg-white p-4 transition hover:border-brand-200 hover:shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={`/b/${biz.slug}`} className="block">
            <h3 className="truncate text-base font-semibold text-ink-900 group-hover:text-brand-700">
              {biz.name}
            </h3>
          </Link>
          <p className="mt-0.5 text-xs text-ink-400">
            {[labelOf('category', biz.category), biz.hq_country, biz.founded_year]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => toggleCompare(biz)}
          disabled={full}
          title={full ? `비교는 최대 ${MAX_COMPARE}개까지` : selected ? '비교에서 제외' : '비교에 추가'}
          className={`shrink-0 rounded-lg border p-1.5 transition ${
            selected
              ? 'border-brand-600 bg-brand-600 text-white'
              : 'border-ink-200 text-ink-400 hover:border-brand-500 hover:text-brand-600 disabled:opacity-40 disabled:hover:border-ink-200 disabled:hover:text-ink-400'
          }`}
        >
          {selected ? <Check size={14} /> : <Plus size={14} />}
        </button>
      </div>

      <Link to={`/b/${biz.slug}`} className="mt-2 flex-1">
        <p className="line-clamp-2 text-sm text-ink-600">{biz.one_liner}</p>
      </Link>

      <div className="mt-3 flex flex-wrap gap-1">
        {biz.revenue_models?.slice(0, 3).map((m) => (
          <span
            key={m}
            className="rounded-md bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700"
          >
            {labelOf('revenue_model', m)}
          </span>
        ))}
        {biz.customer_type && (
          <span className="rounded-md bg-ink-100 px-1.5 py-0.5 text-xs font-medium text-ink-600">
            {labelOf('customer_type', biz.customer_type)}
          </span>
        )}
      </div>

      {/* 검증된 모델은 왜 검증됐는지를 카드에서 바로 보여준다 */}
      {biz.tier === 'proven' && biz.evidence?.scale && (
        <p className="mt-2 truncate text-xs text-ink-500" title={`${biz.evidence.scale} · 업력 ${biz.evidence.age_years}년`}>
          <span className="mr-1 rounded bg-ink-100 px-1 py-0.5 font-medium text-ink-600">검증</span>
          {biz.evidence.scale}
          {biz.evidence.age_years != null && ` · 업력 ${biz.evidence.age_years}년`}
        </p>
      )}

      {biz.traction?.funding && (
        <p className="mt-2 truncate text-xs font-medium text-emerald-700" title={biz.traction.funding}>
          투자유치 {biz.traction.funding}
        </p>
      )}

      {/* 세 축을 나란히 둔다. 한국 적용성만 카드에 띄우면 그 축이 대표 지표처럼 읽히는데,
          자본·복제와 함께 봐야 판단이 되는 값이라 하나만 앞세우면 오해를 부른다. */}
      <dl className="mt-3 space-y-1 border-t border-ink-100 pt-2.5">
        {[
          ['capital_intensity', '자본', 'warn'],
          ['replicability', '복제', 'warn'],
          ['korea_fit', '한국', 'good'],
        ].map(([key, short, tone]) => (
          <div key={key} className="flex items-center justify-between">
            <dt className="text-xs text-ink-400">{short}</dt>
            <dd><Scale value={biz[key]} tone={tone} compact /></dd>
          </div>
        ))}
      </dl>
    </article>
  )
}
