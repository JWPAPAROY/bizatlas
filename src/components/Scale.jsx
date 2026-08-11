// 1~5 척도 표시. 축마다 "높을수록 좋다"가 아니므로 색을 의미에 맞춰 다르게 준다.
const TONE = {
  good: 'bg-brand-600',   // 높을수록 유리 (korea_fit)
  warn: 'bg-amber-500',   // 높을수록 부담/위험 (capital_intensity, replicability)
  neutral: 'bg-ink-400',
}

// 축 정의는 여기 한 곳에만 둔다. 화면·소개·비교표가 모두 이걸 읽으므로 설명이 어긋나지 않는다.
// levels 는 1~5 전부 적는다 — 양 끝만 주면 가운데 값이 무슨 뜻인지 알 수 없다.
export const AXES = {
  capital_intensity: {
    label: '자본 집약도',
    tone: 'warn',
    hint: '1=노트북 한 대 / 5=공장·인허가 필요',
    what: '이 모델을 **처음 시작하는 데** 드는 자본의 크기입니다. 지금 그 회사의 자산 규모가 아니라, 같은 사업을 새로 시작한다면 얼마가 필요한가로 봅니다.',
    levels: {
      1: '노트북 한 대 (SaaS·앱)',
      2: '소규모 클라우드 비용',
      3: '상당한 GPU·초기 재고',
      4: '하드웨어 양산·물류 거점',
      5: '공장·인허가·중장비',
    },
  },
  replicability: {
    label: '복제 용이성',
    tone: 'warn',
    hint: '1=만들기 어려움 / 5=주말이면 복제 가능',
    what: '자금과 인력을 갖춘 팀이 **동등한 기능의 제품·서비스를 만드는 데** 걸리는 시간입니다. 브랜드나 기존 사용자 기반은 여기 넣지 않습니다 — 그건 해자 축이 따로 다룹니다. 높을수록 진입장벽이 낮다는 뜻이라, 이 축은 낮은 쪽이 사업으로서 유리합니다.',
    levels: {
      1: '규제 인허가·독점 데이터·수년치 R&D 를 이미 확보해야만 가능',
      2: '수년 필요 (양산 라인·물류 거점·대규모 실사용 데이터)',
      3: '자금이 있으면 1년 내 (기술은 알려져 있고 실행·계약이 관건)',
      4: '수개월 (기성 모델·API 에 도메인 지식을 얹은 수준)',
      5: '주말이면 복제 가능 (단순 래퍼·CRUD)',
    },
  },
  korea_fit: {
    label: '한국 적용성',
    tone: 'good',
    hint: '1=규제·문화상 부적합 / 5=바로 통함',
    what: '이 모델을 **한국에 그대로 옮겼을 때** 통할 가능성입니다. 규제(의료·금융·개인정보), 시장 규모, 이미 있는 국내 대체재, 영어권 워크플로 의존도를 함께 봅니다.',
    levels: {
      1: '한국 규제상 불가능하거나 시장이 없음',
      2: '국내 사업자가 이미 장악해 진입 무의미',
      3: '가능하지만 현지화 부담이 큼',
      4: '약간의 현지화로 통함',
      5: '거의 그대로 통함',
    },
  },
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

// 상세 페이지용. 점수만 보여주면 3점이 무슨 뜻인지 알 수 없으므로 해당 단계의 설명을 함께 쓴다.
export function AxisRow({ axis, value }) {
  const meta = AXES[axis]
  const meaning = value != null ? meta.levels[value] : null
  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-700">{meta.label}</div>
          {meaning ? (
            <div className="mt-0.5 text-sm text-ink-900">
              <span className="font-semibold tabular-nums">{value}점</span>
              <span className="text-ink-400"> — </span>
              {meaning}
            </div>
          ) : (
            <div className="mt-0.5 text-sm text-ink-400">평가되지 않음</div>
          )}
        </div>
        <Scale value={value} tone={meta.tone} />
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-500">{stripEmphasis(meta.what)}</p>
    </div>
  )
}

// what 문구의 **강조** 표기를 화면용으로 풀어준다 (마크다운을 렌더링하지 않으므로)
export function stripEmphasis(text) {
  return text.replace(/\*\*/g, '')
}

// 축 하나의 5단계를 표로 보여준다 (소개 페이지용)
export function AxisLegend({ axis }) {
  const meta = AXES[axis]
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-3">
      <h3 className="text-sm font-semibold">{meta.label}</h3>
      <p className="mt-1 text-sm leading-relaxed text-ink-600">{stripEmphasis(meta.what)}</p>
      <dl className="mt-2 space-y-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} className="flex gap-2 text-xs">
            <dt className="w-8 shrink-0 font-semibold tabular-nums text-ink-500">{n}점</dt>
            <dd className="text-ink-600">{meta.levels[n]}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
