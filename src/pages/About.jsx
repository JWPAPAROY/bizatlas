import { useEffect, useState } from 'react'
import { supabase, isConfigured } from '../lib/supabase'
import { AXES } from '../components/Scale.jsx'

export default function About() {
  const [sources, setSources] = useState([])
  const [lastRun, setLastRun] = useState(null)

  useEffect(() => {
    if (!isConfigured) return
    supabase.from('sources').select('name, url, notes').eq('enabled', true).order('name')
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
        BizAtlas는 전세계에서 수집한 서비스를 매번 같은 축으로 분해해 저장합니다.
        그래서 “구독 모델이면서 자본이 거의 안 들고 한국에서도 통할 만한 것”처럼
        평소엔 검색으로 못 던지는 질문을 필터 한 번으로 물을 수 있습니다.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">분해하는 축</h2>
        <dl className="mt-3 space-y-3">
          {Object.values(AXES).map((a) => (
            <div key={a.label} className="rounded-lg border border-ink-200 bg-white p-3">
              <dt className="text-sm font-semibold">{a.label}</dt>
              <dd className="mt-0.5 text-sm text-ink-600">{a.hint}</dd>
            </div>
          ))}
          <div className="rounded-lg border border-ink-200 bg-white p-3">
            <dt className="text-sm font-semibold">수익 모델 · 해자 · 고객 유형 · 산업</dt>
            <dd className="mt-0.5 text-sm text-ink-600">
              자유 서술이 아니라 고정된 어휘로 태깅합니다. 그래야 필터와 비교가 성립합니다.
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">두 가지 등급</h2>
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border border-ink-200 bg-white p-3">
            <h3 className="text-sm font-semibold">검증된 모델 (기본 화면)</h3>
            <p className="mt-1 text-sm text-ink-600">
              설립 5년 이상이고, 공개 데이터로 실체와 규모가 확인된 회사입니다. 회사 후보를 뽑은 뒤
              Wikidata 에서 설립일·매출·직원수를 조회해 세 관문(업력·실체·규모)을 통과한 것만 넣습니다.
              <strong>숫자는 Wikidata 가, 구조 해석만 AI 가</strong> 담당합니다.
            </p>
          </div>
          <div className="rounded-lg border border-ink-200 bg-white p-3">
            <h3 className="text-sm font-semibold">최신 동향</h3>
            <p className="mt-1 text-sm text-ink-600">
              아래 소스에서 자동 수집한 신생 서비스입니다. 아직 모델이 검증되지 않았으므로
              참고용으로만 보세요.
            </p>
          </div>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">수집 방식</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-700">
          4시간마다 아래 소스를 읽어, 새로 올라온 항목만 AI가 구조화합니다.
          회사·비즈니스 모델로 볼 수 없는 항목(일반 뉴스, 수익 구조를 알 수 없는 툴 소개 등)은
          자동 반려되며, 한 번 판정한 항목은 다시 처리하지 않습니다.
        </p>
        <ul className="mt-3 space-y-2">
          {sources.map((s) => (
            <li key={s.name} className="rounded-lg border border-ink-200 bg-white p-3">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-semibold text-brand-700 hover:underline"
              >
                {s.name}
              </a>
              {s.notes && <p className="mt-0.5 text-xs text-ink-500">{s.notes}</p>}
            </li>
          ))}
        </ul>

        {lastRun && (
          <p className="mt-3 text-xs text-ink-400">
            마지막 수집: {new Date(lastRun.started_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (KST)
            {' · '}신규 {lastRun.created}건 / 검토 {lastRun.fetched}건
          </p>
        )}
      </section>

      <section className="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4">
        <h2 className="text-sm font-semibold text-amber-900">한계</h2>
        <p className="mt-1 text-sm leading-relaxed text-amber-900">
          분류와 1~5점 척도는 AI가 <strong>공개된 소개 문구만 읽고</strong> 매긴 값입니다.
          실제 재무·경쟁 상황을 반영하지 않으며 틀릴 수 있습니다. 특히 매출·사용자 수는
          원문에 명시된 것만 옮기므로 비어 있는 경우가 많습니다. 탐색과 아이디어 발상용으로
          쓰시고, 실제 판단 전에는 반드시 원문과 1차 자료를 확인하세요.
        </p>
      </section>
    </div>
  )
}
