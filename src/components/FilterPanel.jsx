import { X } from 'lucide-react'
import { useStore } from '../lib/store.jsx'
import { AXES } from './Scale.jsx'

function Chip({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
        active
          ? 'border-brand-600 bg-brand-600 text-white'
          : 'border-ink-200 bg-white text-ink-600 hover:border-brand-300 hover:text-brand-700'
      }`}
    >
      {children}
    </button>
  )
}

function Group({ title, children }) {
  return (
    <div className="border-t border-ink-100 py-3 first:border-t-0 first:pt-0">
      <h4 className="mb-2 text-xs font-semibold tracking-wide text-ink-400 uppercase">{title}</h4>
      {children}
    </div>
  )
}

export default function FilterPanel({ filters, setFilters, onReset, activeCount }) {
  const { taxonomy } = useStore()

  const toggleMulti = (key, value) =>
    setFilters((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
    }))

  const setOne = (key, value) =>
    setFilters((f) => ({ ...f, [key]: f[key] === value ? '' : value }))

  return (
    <aside className="rounded-xl border border-ink-200 bg-white p-4">
      <div className="flex items-center justify-between pb-3">
        <h3 className="text-sm font-bold">필터</h3>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-800"
          >
            <X size={12} /> 초기화 ({activeCount})
          </button>
        )}
      </div>

      <Group title="수익 모델">
        <div className="flex flex-wrap gap-1.5">
          {(taxonomy.revenue_model ?? []).map((t) => (
            <Chip
              key={t.value}
              active={filters.revenue_models.includes(t.value)}
              onClick={() => toggleMulti('revenue_models', t.value)}
              title={t.description}
            >
              {t.label_ko}
            </Chip>
          ))}
        </div>
      </Group>

      <Group title="고객 유형">
        <div className="flex flex-wrap gap-1.5">
          {(taxonomy.customer_type ?? []).map((t) => (
            <Chip
              key={t.value}
              active={filters.customer_type === t.value}
              onClick={() => setOne('customer_type', t.value)}
              title={t.description}
            >
              {t.label_ko}
            </Chip>
          ))}
        </div>
      </Group>

      <Group title="산업">
        <div className="flex flex-wrap gap-1.5">
          {(taxonomy.category ?? []).map((t) => (
            <Chip
              key={t.value}
              active={filters.category === t.value}
              onClick={() => setOne('category', t.value)}
              title={t.description}
            >
              {t.label_ko}
            </Chip>
          ))}
        </div>
      </Group>

      <Group title="해자">
        <div className="flex flex-wrap gap-1.5">
          {(taxonomy.moat ?? []).map((t) => (
            <Chip
              key={t.value}
              active={filters.moats.includes(t.value)}
              onClick={() => toggleMulti('moats', t.value)}
              title={t.description}
            >
              {t.label_ko}
            </Chip>
          ))}
        </div>
      </Group>

      <Group title="한국 적용성 최소">
        <p className="mb-1 text-xs text-ink-400">{AXES.korea_fit.hint}</p>
        <input
          type="range"
          min="1"
          max="5"
          value={filters.korea_fit_min}
          onChange={(e) => setFilters((f) => ({ ...f, korea_fit_min: Number(e.target.value) }))}
          className="w-full accent-teal-600"
        />
        <div className="mt-1 text-xs text-ink-500">
          {filters.korea_fit_min === 1 ? '제한 없음' : `${filters.korea_fit_min}점 이상`}
        </div>
      </Group>

      <Group title="자본 집약도 최대">
        <p className="mb-1 text-xs text-ink-400">{AXES.capital_intensity.hint}</p>
        <input
          type="range"
          min="1"
          max="5"
          value={filters.capital_max}
          onChange={(e) => setFilters((f) => ({ ...f, capital_max: Number(e.target.value) }))}
          className="w-full accent-amber-500"
        />
        <div className="mt-1 text-xs text-ink-500">
          {filters.capital_max === 5 ? '제한 없음' : `${filters.capital_max}점 이하 (적은 자본으로 시작)`}
        </div>
      </Group>
    </aside>
  )
}
