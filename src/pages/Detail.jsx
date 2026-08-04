import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Loader2, Plus, Check, AlertTriangle } from 'lucide-react'
import { supabase, isConfigured } from '../lib/supabase'
import { useStore } from '../lib/store.jsx'
import { AxisRow } from '../components/Scale.jsx'

function Section({ title, children }) {
  return (
    <section className="border-t border-ink-100 py-5">
      <h2 className="mb-2 text-sm font-semibold tracking-wide text-ink-400 uppercase">{title}</h2>
      {children}
    </section>
  )
}

export default function Detail() {
  const { slug } = useParams()
  const { labelOf, descOf, compare, toggleCompare, MAX_COMPARE } = useStore()
  const [biz, setBiz] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isConfigured) { setLoading(false); return }
    setLoading(true)
    supabase
      .from('businesses').select('*').eq('slug', slug).maybeSingle()
      .then(({ data }) => { setBiz(data); setLoading(false) })
  }, [slug])

  if (loading) {
    return (
      <div className="flex justify-center py-24 text-ink-400">
        <Loader2 className="animate-spin" />
      </div>
    )
  }

  if (!biz) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center">
        <p className="text-ink-600">항목을 찾을 수 없습니다.</p>
        <Link to="/" className="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline">
          목록으로
        </Link>
      </div>
    )
  }

  const selected = compare.some((b) => b.id === biz.id)
  const full = compare.length >= MAX_COMPARE && !selected
  const traction = Object.entries(biz.traction ?? {}).filter(([, v]) => v != null && v !== '')

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-800">
        <ArrowLeft size={15} /> 목록으로
      </Link>

      <header className="mt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{biz.name}</h1>
            <p className="mt-1 text-sm text-ink-500">
              {[
                labelOf('category', biz.category),
                labelOf('customer_type', biz.customer_type),
                biz.hq_country,
                biz.founded_year && `${biz.founded_year}년 설립`,
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => toggleCompare(biz)}
            disabled={full}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              selected
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-ink-200 bg-white text-ink-600 hover:border-brand-500 disabled:opacity-40'
            }`}
          >
            {selected ? <Check size={15} /> : <Plus size={15} />}
            {selected ? '비교에 추가됨' : '비교에 추가'}
          </button>
        </div>

        <p className="mt-3 text-lg text-ink-800">{biz.one_liner}</p>

        {biz.website && (
          <a
            href={biz.website}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"
          >
            {biz.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            <ExternalLink size={13} />
          </a>
        )}
      </header>

      {/* 검증 근거는 해석보다 앞에 둔다. 사실을 먼저 보이고 AI 가 매긴 값을 뒤에 두는 것이
          이 서비스의 전제라, 순서 자체가 그 구분을 말해준다. */}
      {biz.tier === 'proven' && biz.evidence?.source && (
        <Section title="검증 근거">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              ['업력', biz.evidence.age_years != null ? `${biz.evidence.age_years}년` : null],
              ['설립', biz.evidence.inception],
              ['규모', biz.evidence.scale],
              ['직원', biz.evidence.employees ? `${Number(biz.evidence.employees).toLocaleString()}명` : null],
              ['법인명', biz.evidence.corp_name],
            ].filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="rounded-lg border border-ink-200 p-2.5">
                <dt className="text-xs text-ink-400">{k}</dt>
                <dd className="mt-0.5 text-sm font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-ink-400">
            여기까지는 AI 가 아니라{' '}
            <a
              href={biz.evidence.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-700 hover:underline"
            >
              {biz.evidence.source === 'dart' ? 'DART 전자공시' : 'Wikidata'} {biz.evidence.entity}
            </a>
            에서 가져온 값입니다. 아래 분류와 1~5 점수는 AI 가 매긴 해석입니다.
          </p>
        </Section>
      )}

      {biz.description && (
        <Section title="개요">
          <p className="text-sm leading-relaxed whitespace-pre-line text-ink-700">{biz.description}</p>
        </Section>
      )}

      <Section title="수익 구조">
        <p className="mb-2 text-xs text-ink-400">이 회사가 돈을 버는 방식입니다.</p>
        {biz.revenue_models?.length ? (
          <ul className="space-y-1.5">
            {biz.revenue_models.map((m) => (
              <li key={m} className="flex flex-wrap items-baseline gap-x-2">
                <span className="rounded-md bg-brand-50 px-2 py-0.5 text-sm font-medium text-brand-700">
                  {labelOf('revenue_model', m)}
                </span>
                <span className="text-xs text-ink-500">{descOf('revenue_model', m)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-ink-400">분류되지 않음</span>
        )}
        {biz.pricing_note && <p className="mt-2 text-sm text-ink-600">{biz.pricing_note}</p>}
      </Section>

      <Section title="해자">
        <p className="mb-2 text-xs text-ink-400">
          경쟁자가 쉽게 따라오지 못하게 막아주는 요소입니다. 없으면 실행력으로만 버티는 구조입니다.
        </p>
        {biz.moats?.length ? (
          <ul className="space-y-1.5">
            {biz.moats.map((m) => (
              <li key={m} className="flex flex-wrap items-baseline gap-x-2">
                <span className="rounded-md bg-ink-100 px-2 py-0.5 text-sm font-medium text-ink-700">
                  {labelOf('moat', m)}
                </span>
                <span className="text-xs text-ink-500">{descOf('moat', m)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-ink-400">분류되지 않음</span>
        )}
      </Section>

      <Section title="구조 지표">
        <p className="mb-1 text-xs text-ink-400">
          세 축 모두 1~5 정수이며 <strong>AI 가 매긴 해석</strong>입니다. 재무 데이터를 계산한 값이 아닙니다.
        </p>
        <div className="divide-y divide-ink-100">
          <AxisRow axis="capital_intensity" value={biz.capital_intensity} />
          <AxisRow axis="replicability" value={biz.replicability} />
          <AxisRow axis="korea_fit" value={biz.korea_fit} />
        </div>
        {biz.korea_note && (
          <p className="mt-3 rounded-lg bg-brand-50 p-3 text-sm text-brand-900">
            <span className="font-semibold">한국 적용성 </span>
            {biz.korea_note}
          </p>
        )}
      </Section>

      {(biz.startup_scale || biz.korea_analog_note || biz.korea_analogs?.length > 0
        || biz.regulatory_notes?.length > 0) && (
        <Section title="한국에서 시작한다면">
          <p className="mb-3 text-xs text-ink-400">
            점수만으로는 다음 행동이 나오지 않아 덧붙인 항목입니다.
            <strong> 아래는 전부 AI 가 생성한 것</strong>이며, 특히 회사명은 사실과 다를 수 있으니
            반드시 직접 확인하세요.
          </p>

          <dl className="space-y-3">
            {biz.startup_scale && (
              <div>
                <dt className="text-sm font-medium text-ink-700">최소 시작 규모</dt>
                <dd className="mt-0.5 text-sm leading-relaxed text-ink-600">{biz.startup_scale}</dd>
              </div>
            )}

            {(biz.korea_analogs?.length > 0 || biz.korea_analog_note) && (
              <div>
                <dt className="text-sm font-medium text-ink-700">국내 유사 사업자</dt>
                <dd className="mt-0.5">
                  {biz.korea_analogs?.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {biz.korea_analogs.map((a) => (
                        <span key={a} className="rounded-md bg-ink-100 px-2 py-0.5 text-sm text-ink-700">
                          {a}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-sm text-ink-500">AI 가 아는 범위에서는 없음</span>
                  )}
                  {biz.korea_analog_note && (
                    <p className="mt-1 text-sm leading-relaxed text-ink-600">{biz.korea_analog_note}</p>
                  )}
                </dd>
              </div>
            )}

            {biz.regulatory_notes?.length > 0 && (
              <div>
                <dt className="text-sm font-medium text-ink-700">규제 체크포인트</dt>
                <dd className="mt-1">
                  <ul className="space-y-1">
                    {biz.regulatory_notes.map((r, i) => (
                      <li key={i} className="flex gap-2 text-sm text-ink-600">
                        <span className="mt-0.5 shrink-0 text-ink-300">·</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        </Section>
      )}

      {biz.why_it_works && (
        <Section title="왜 작동하는가">
          <p className="text-sm leading-relaxed whitespace-pre-line text-ink-700">{biz.why_it_works}</p>
        </Section>
      )}

      {biz.risks?.length > 0 && (
        <Section title="리스크">
          <ul className="space-y-1.5">
            {biz.risks.map((r, i) => (
              <li key={i} className="flex gap-2 text-sm text-ink-700">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
                {r}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {traction.length > 0 && (
        <Section title="공개된 지표">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {traction.map(([k, v]) => (
              <div key={k} className="rounded-lg border border-ink-200 p-2.5">
                <dt className="text-xs text-ink-400">
                  {{ revenue: '매출', users: '사용자', funding: '투자유치', valuation: '기업가치' }[k] ?? k}
                </dt>
                <dd className="mt-0.5 text-sm font-semibold">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {biz.tags?.length > 0 && (
        <Section title="태그">
          <div className="flex flex-wrap gap-1.5">
            {biz.tags.map((t) => (
              <span key={t} className="rounded-md bg-ink-100 px-2 py-0.5 text-xs text-ink-600">
                #{t}
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section title="출처">
        <p className="text-sm text-ink-600">
          {biz.source_name}
          {biz.source_url && (
            <>
              {' · '}
              <a
                href={biz.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-700 hover:underline"
              >
                {biz.tier === 'proven' ? '공시 원문 보기' : '원문 보기'}
              </a>
            </>
          )}
        </p>
        <p className="mt-2 text-xs text-ink-400">
          {/* proven 은 검증된 사실 위에 AI 해석을 얹은 것이고, emerging 은 소개 문구만 읽고 만든 것이라
              신뢰도가 다르다. 같은 문구로 뭉뚱그리면 안 된다. */}
          {biz.tier === 'proven'
            ? `위 분류와 1~5 점수는 ${biz.ai_model ?? 'AI'}가 매긴 해석입니다`
            : `이 페이지의 분류·점수는 ${biz.ai_model ?? 'AI'}가 소개 문구만 읽고 자동 생성했습니다`}
          {biz.ai_confidence != null && ` (확신도 ${biz.ai_confidence})`}. 투자·창업 판단의 근거로 쓰기 전에
          반드시 원문과 1차 자료를 확인하세요.
        </p>
      </Section>
    </div>
  )
}
