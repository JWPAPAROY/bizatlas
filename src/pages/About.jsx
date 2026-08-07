import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, isConfigured } from '../lib/supabase'
import { AXES, AxisLegend } from '../components/Scale.jsx'
import { useStore } from '../lib/store.jsx'

export default function About() {
  const { taxonomy } = useStore()
  const [sources, setSources] = useState([])
  const [lastRun, setLastRun] = useState(null)

  useEffect(() => {
    if (!isConfigured) return
    supabase.from('sources').select('name, url, site_url, notes').eq('enabled', true).order('name')
      .then(({ data }) => setSources(data ?? []))
    supabase.from('ingest_runs').select('*').order('started_at', { ascending: false }).limit(1)
      .maybeSingle()
      .then(({ data }) => setLastRun(data))
  }, [])

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight">BizAtlas 소개</h1>

      <p className="mt-3 text-sm leading-relaxed text-ink-700">
        비즈니스 모델 정보는 이미 넘칩니다. 부족한 건 <strong>비교 가능한 형태</strong>입니다.
        BizAtlas는 전세계에서 모은 서비스를 매번 같은 축으로 분해해 저장합니다.
        그래서 <em className="not-italic font-medium text-ink-900">
          구독 모델이면서 자본이 거의 안 들고 한국에서도 통할 만한 것
        </em>처럼 평소엔 검색으로 못 던지는 질문을 필터 한 번으로 물을 수 있습니다.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">1~5 점수 축</h2>
        <p className="mt-1 text-sm text-ink-600">
          세 축 모두 <strong>AI 가 매긴 해석</strong>입니다. 재무 데이터를 계산한 값이 아니며,
          각 점수가 정확히 무엇을 뜻하는지는 아래 표 그대로입니다.
        </p>
        <div className="mt-3 space-y-3">
          {Object.keys(AXES).map((key) => <AxisLegend key={key} axis={key} />)}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">태그 용어집</h2>
        <p className="mt-1 text-sm text-ink-600">
          자유 서술이 아니라 고정된 어휘로 태깅합니다. 그래야 필터와 비교가 성립합니다.
          아래가 쓰이는 값 전부입니다.
        </p>
        {[
          ['revenue_model', '수익 모델', '이 회사가 돈을 버는 방식. 한 회사에 여러 개가 붙을 수 있습니다.'],
          ['moat', '해자', '경쟁자가 쉽게 따라오지 못하게 막아주는 요소. 최대 2개까지만 인정합니다.'],
          ['customer_type', '고객 유형', '누구에게 파는가.'],
          ['category', '산업', '어느 분야인가.'],
        ].map(([kind, title, note]) => (
          <div key={kind} className="mt-4">
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="mt-0.5 text-xs text-ink-500">{note}</p>
            <dl className="mt-2 divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white">
              {(taxonomy[kind] ?? []).map((t) => (
                <div key={t.value} className="flex flex-wrap items-baseline gap-x-2 px-3 py-2">
                  <dt className="text-sm font-medium text-ink-800">{t.label_ko}</dt>
                  <dd className="text-xs text-ink-500">{t.description}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">두 가지 등급</h2>
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border border-ink-200 bg-white p-3">
            <h3 className="text-sm font-semibold">검증된 모델 (기본 화면)</h3>
            <p className="mt-1 text-sm text-ink-600">
              설립 5년 이상이고, 공개 데이터로 실체와 규모가 확인된 회사입니다.
              회사 후보를 뽑은 뒤 세 관문(업력 · 기업 실체 · 규모)을 통과한 것만 넣습니다.
              해외 기업은 <strong>Wikidata</strong>, 한국 기업은 <strong>DART 전자공시</strong>에서
              설립일과 매출을 조회합니다.
            </p>
            <p className="mt-1.5 text-sm text-ink-600">
              <strong>숫자는 이 공개 데이터가, 구조 해석만 AI 가</strong> 담당합니다.
              통과 근거는 각 항목 상세 페이지 맨 위에 출처 링크와 함께 그대로 보여줍니다.
            </p>
          </div>
          <div className="rounded-lg border border-ink-200 bg-white p-3">
            <h3 className="text-sm font-semibold">최신 동향</h3>
            <p className="mt-1 text-sm text-ink-600">
              아래 소스에서 자동 수집한 신생 서비스입니다. 아직 모델이 검증되지 않았고
              공개된 소개 문구만 근거로 분류했으므로 참고용으로만 보세요.
            </p>
          </div>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">최신 동향은 어디서 오나</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-700">
          4시간마다 아래 소스를 읽어, 새로 올라온 항목만 AI가 구조화합니다.
          회사·비즈니스 모델로 볼 수 없는 항목(일반 뉴스, 벤처캐피털의 펀드 결성 기사,
          수익 구조를 알 수 없는 툴 소개 등)은 자동 반려되며, 한 번 판정한 항목은 다시 처리하지 않습니다.
        </p>
        <ul className="mt-3 space-y-2">
          {sources.map((s) => (
            <li key={s.name} className="rounded-lg border border-ink-200 bg-white p-3">
              {/* 링크는 사람이 보는 사이트로 건다. 피드 주소(s.url)를 걸면 RSS·JSON 원본이 그대로 열린다. */}
              <a
                href={s.site_url ?? s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-semibold text-brand-700 hover:underline"
              >
                {s.name}
              </a>
              {s.notes && <p className="mt-0.5 text-xs text-ink-500">{s.notes}</p>}
              {/* 어떤 엔드포인트를 읽는지는 출처 투명성 차원에서 밝히되, 링크로 걸지는 않는다 */}
              <p className="mt-1 truncate font-mono text-[11px] text-ink-400" title={s.url}>
                {s.url}
              </p>
            </li>
          ))}
        </ul>

        {lastRun && (
          <p className="mt-3 text-xs text-ink-400">
            마지막 수집: {new Date(lastRun.started_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (KST)
            {' · '}신규 {lastRun.created}건 / 검토 {lastRun.fetched}건
            {' · '}
            <Link to="/today" className="text-brand-700 hover:underline">
              오늘 수집 현황
            </Link>
          </p>
        )}
      </section>

      <section className="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4">
        <h2 className="text-sm font-semibold text-amber-900">한계</h2>
        <p className="mt-1 text-sm leading-relaxed text-amber-900">
          <strong>수익 모델 · 해자 · 자본 집약도 · 복제 용이성 · 한국 적용성은 모두 AI 가 매긴 해석</strong>입니다.
          검증된 모델이라도 이 점수까지 검증된 것은 아니며, 실제 재무·경쟁 상황을 반영하지 않아 틀릴 수 있습니다.
          검증된 것은 설립일 · 매출 · 규모 같은 사실 정보뿐입니다.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-amber-900">
          매출은 공시 의무가 있는 상장사만 채워지는 경우가 많습니다. 비상장 기업은 실체와 업력까지만
          확인됩니다. 탐색과 아이디어 발상용으로 쓰시고, 실제 판단 전에는 반드시 원문과 1차 자료를 확인하세요.
        </p>
      </section>
    </div>
  )
}
