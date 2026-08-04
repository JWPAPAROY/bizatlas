// 1~5 척도 표시. 축마다 "높을수록 좋다"가 아니므로 색을 의미에 맞춰 다르게 준다.
const TONE = {
  good: 'bg-brand-600',   // 높을수록 유리 (korea_fit)
  warn: 'bg-amber-500',   // 높을수록 부담/위험 (capital_intensity, replicability)
  neutral: 'bg-ink-400',
}

export const AXES = {
  capital_intensity: { label: '자본 집약도', tone: 'warn', hint: '1=노트북 한 대 / 5=공장·인허가 필요' },
  replicability: { label: '복제 용이성', tone: 'warn', hint: '1=따라하기 어려움 / 5=주말이면 복제 가능' },
  korea_fit: { label: '한국 적용성', tone: 'good', hint: '1=규제·문화상 부적합 / 5=바로 통함' },
}

export function Scale({ value, tone = 'neutral', compact = false }) {
  if (value == null) return <span className="text-sm text-ink-400">—</span>
  return (
    <div className="flex items-center gap-1" title={`${value} / 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`rounded-full ${compact ? 'h-1.5 w-4' : 'h-2 w-5'} ${
            n <= value ? TONE[tone] : 'bg-ink-200'
          }`}
        />
      ))}
      <span className="ml-1 text-xs font-medium tabular-nums text-ink-500">{value}</span>
    </div>
  )
}

export function AxisRow({ axis, value }) {
  const meta = AXES[axis]
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <div className="text-sm font-medium text-ink-700">{meta.label}</div>
        <div className="text-xs text-ink-400">{meta.hint}</div>
      </div>
      <Scale value={value} tone={meta.tone} />
    </div>
  )
}
