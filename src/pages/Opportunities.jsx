import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loader2, AlertTriangle, ChevronDown, ExternalLink } from 'lucide-react'
import { supabase, isConfigured } from '../lib/supabase'
import { useStore } from '../lib/store.jsx'

// 기회 깔때기 결과. 만드는 쪽은 scripts/opportunities.mjs — 숫자는 코드가 businesses 에서 세고 해석만 AI 가 쓴다.
// Detail 과 같은 원칙으로 사실(선례·숫자·DART 대조)을 해석(AI 카드)보다 앞에 둔다.

const STAGES = [
  ['desk', '데스크 통과'],
  ['signal', '신호'],
  ['field', '현장 검증'],
  ['all', '전체'],
]
const STAGE_BADGE = {
  signal: ['신호', 'bg-ink-100 text-ink-600'],
  desk: ['데스크 통과', 'bg-brand-50 text-brand-700'],
  field: ['현장 검증 중', 'bg-amber-50 text-amber-700'],
  go: ['진행', 'bg-emerald-50 text-emerald-700'],
  killed: ['폐기', 'bg-ink-100 text-ink-400 line-through'],
}
const SOLO = { high: '높음', mid: '보통', low: '낮음' }
const SEVERITY = { blocker: ['장벽', 'text-red-700'], caution: ['주의', 'text-amber-700'], none: ['해당 없음', 'text-ink-400'] }

const strength = (o) => o.country_count * 2 + o.member_count + o.funded_count
const naver = (q) => `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}`
const trends = (kws) => `https://trends.google.com/trends/explore?geo=KR&date=today%205-y&q=${(kws ?? []).slice(0, 5).map(encodeURIComponent).join(',')}`

function Block({ title, children }) {
  return (
    <div className="border-t border-ink-100 pt-3">
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-ink-400 uppercase">{title}</h3>
      {children}
    </div>
  )
}

function Card({ o, members, open, onToggle }) {
  const { labelOf } = useStore()
  const c = o.card ?? {}
  const [badge, badgeCls] = STAGE_BADGE[o.stage] ?? STAGE_BADGE.signal
  const hasCard = Boolean(o.carded_at)
  const foreign = members.filter((b) => !/korea/i.test(b.hq_country ?? ''))
  const hist = o.history ?? []

  return (
    <li id={o.slug} className="rounded-xl border border-ink-200 bg-white">
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 p-4 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${badgeCls}`}>{badge}</span>
            {o.customer_type && <span className="text-xs text-ink-400">{labelOf('customer_type', o.customer_type)}</span>}
          </div>
          <h2 className="mt-1.5 font-semibold text-ink-900">{o.title}</h2>
          <p className="mt-1 text-sm text-ink-600">{o.problem}</p>
          <p className="mt-2 text-xs text-ink-500 tabular-nums">
            해외 선례 <b className="text-ink-800">{o.member_count}곳</b> · {o.country_count}개국 · 투자 {o.funded_count}건
            {o.cap_avg != null && ` · 자본 부담 ${Number(o.cap_avg).toFixed(1)}/5`}
            {hist.length > 1 && ` · 추이 ${hist.map((h) => h.members).join('→')}`}
          </p>
        </div>
        <ChevronDown size={18} className={`mt-1 shrink-0 text-ink-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-4 px-4 pb-5">
          <Block title="해외 선례">
            <ul className="space-y-1 text-sm">
              {foreign.map((b) => (
                <li key={b.id}>
                  <Link to={`/b/${b.slug}`} className="font-medium text-brand-700 hover:underline">{b.name}</Link>
                  <span className="text-ink-400"> · {b.hq_country}</span>
                  <span className="text-ink-600"> — {b.one_liner}</span>
                </li>
              ))}
            </ul>
          </Block>

          {o.desk?.verdict && (
            <Block title={`데스크 판정 · ${o.desk.verdict === 'pass' ? '통과' : '보류'}`}>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-700">
                {o.desk.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </Block>
          )}

          {hasCard ? (
            <>
              <Block title="국내 경쟁">
                {o.competitors?.length ? (
                  <ul className="space-y-1 text-sm">
                    {o.competitors.map((x) => (
                      <li key={x.name} className="flex flex-wrap items-baseline gap-x-2">
                        {x.slug
                          ? <Link to={`/b/${x.slug}`} className="font-medium text-brand-700 hover:underline">{x.name}</Link>
                          : <a href={naver(x.name)} target="_blank" rel="noopener noreferrer" className="font-medium text-ink-800 hover:underline">{x.name}</a>}
                        {x.dart ? (
                          <a href={`https://dart.fss.or.kr/dsae001/selectPopup.ax?selectKey=${x.dart.corp_code}`} target="_blank" rel="noopener noreferrer"
                            className="rounded bg-emerald-50 px-1 text-[11px] font-semibold text-emerald-700" title={x.dart.corp_name}>
                            DART{x.dart.listed ? ' · 상장' : ''}
                          </a>
                        ) : x.source === 'bizatlas' ? (
                          <span className="rounded bg-emerald-50 px-1 text-[11px] font-semibold text-emerald-700">수집됨</span>
                        ) : (
                          <span className="rounded bg-ink-100 px-1 text-[11px] text-ink-500" title="AI 가 떠올린 이름. DART 미등록 초기 회사일 수도, 없는 회사일 수도 있다">미확인</span>
                        )}
                        {x.why && <span className="text-ink-500">{x.why}</span>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-ink-500">찾지 못함 — 빈 시장이거나 수요가 없거나. 아래 검색어로 직접 확인하세요.</p>}
              </Block>

              {c.search_keywords?.length > 0 && (
                <Block title="수요 확인 (직접)">
                  <p className="text-sm text-ink-600">
                    {c.search_keywords.map((k, i) => (
                      <span key={k}>{i > 0 && ' · '}<a href={naver(k)} target="_blank" rel="noopener noreferrer" className="hover:underline">{k}</a></span>
                    ))}
                  </p>
                  <p className="mt-1.5 flex flex-wrap gap-3 text-xs">
                    <a href={trends(c.search_keywords)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
                      구글 트렌드(한국·5년) <ExternalLink size={11} />
                    </a>
                    <a href="https://datalab.naver.com/keyword/trendSearch.naver" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
                      네이버 데이터랩(검색어 직접 입력) <ExternalLink size={11} />
                    </a>
                  </p>
                </Block>
              )}

              <div className="rounded-lg bg-ink-50 p-3 text-xs text-ink-500">아래는 AI 해석입니다. 검증할 가설로 읽으세요.</div>

              <Block title="한국판 가설">
                <dl className="space-y-1.5 text-sm">
                  {[['누구의 문제', c.korea_problem], ['첫 고객', c.korea_customer], ['왜 지금', c.why_now_korea], ['돈 버는 방식', c.model_from_precedents]]
                    .filter(([, v]) => v).map(([k, v]) => (
                      <div key={k} className="grid gap-1 sm:grid-cols-[6rem_1fr]">
                        <dt className="text-ink-400">{k}</dt><dd className="text-ink-800">{v}</dd>
                      </div>
                    ))}
                </dl>
              </Block>

              {c.lenses?.length > 0 && (
                <Block title="고전 렌즈">
                  <ul className="space-y-1 text-sm">
                    {c.lenses.map((l) => <li key={l.name}><b className="text-ink-800">{l.name}</b> <span className="text-ink-600">— {l.reason}</span></li>)}
                  </ul>
                </Block>
              )}

              <Block title="실행 조건">
                <p className="text-sm text-ink-800">혼자 가능성: <b>{SOLO[c.solo_fit?.level] ?? '—'}</b> <span className="text-ink-600">{c.solo_fit?.reason}</span></p>
                {c.regulatory?.filter((r) => r.severity !== 'none').map((r) => (
                  <p key={r.item} className="mt-1 text-sm"><span className={`font-semibold ${SEVERITY[r.severity]?.[1]}`}>규제 {SEVERITY[r.severity]?.[0]}</span> <span className="text-ink-700">{r.item}</span></p>
                ))}
                {c.risks?.length > 0 && <ul className="mt-1.5 list-disc pl-5 text-sm text-ink-600">{c.risks.map((r) => <li key={r}>{r}</li>)}</ul>}
              </Block>

              {c.interview_questions?.length > 0 && (
                <Block title="인터뷰 질문 (해결책은 말하지 말 것)">
                  <ol className="list-decimal space-y-0.5 pl-5 text-sm text-ink-800">{c.interview_questions.map((q) => <li key={q}>{q}</li>)}</ol>
                </Block>
              )}

              {c.kill_criteria?.length > 0 && (
                <Block title="폐기 기준 초안 (검증 시작 전에 확정할 것)">
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-800">{c.kill_criteria.map((k) => <li key={k}>{k}</li>)}</ul>
                </Block>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-500">
              {o.cap_avg != null && o.cap_avg > 3.5
                ? '선례의 자본 부담이 커서 카드를 만들지 않았습니다. 신호로만 추적합니다.'
                : '아직 카드가 없습니다. 매주 신호가 센 순서로 카드를 만듭니다.'}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

export default function Opportunities() {
  const [params, setParams] = useSearchParams()
  const focus = params.get('o')
  const [stage, setStage] = useState(params.get('stage') ?? (focus ? 'all' : 'desk'))
  const [opps, setOpps] = useState(null)
  const [members, setMembers] = useState(new Map())
  const [openSet, setOpenSet] = useState(() => new Set(focus ? [focus] : []))
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isConfigured) return
    ;(async () => {
      const { data, error } = await supabase.from('opportunities').select('*')
      if (error) { setError(error.message); return }
      setOpps(data ?? [])
      const ids = [...new Set((data ?? []).flatMap((o) => o.members))]
      if (!ids.length) return
      const map = new Map()
      for (let i = 0; i < ids.length; i += 150) {
        const { data: bs } = await supabase.from('businesses').select('id, slug, name, hq_country, one_liner').in('id', ids.slice(i, i + 150))
        for (const b of bs ?? []) map.set(b.id, b)
      }
      setMembers(map)
    })()
  }, [])

  useEffect(() => {
    if (focus && opps) document.getElementById(focus)?.scrollIntoView({ block: 'start' })
  }, [focus, opps])

  const counts = useMemo(() => {
    const m = { all: opps?.length ?? 0 }
    for (const o of opps ?? []) m[o.stage] = (m[o.stage] ?? 0) + 1
    return m
  }, [opps])

  const list = useMemo(() => (opps ?? [])
    .filter((o) => stage === 'all' || o.stage === stage)
    .sort((a, b) => strength(b) - strength(a)), [opps, stage])

  const pick = (s) => {
    setStage(s)
    const next = new URLSearchParams(params)
    next.set('stage', s)
    next.delete('o')
    setParams(next, { replace: true })
  }
  const toggle = (slug) => setOpenSet((prev) => {
    const n = new Set(prev)
    n.has(slug) ? n.delete(slug) : n.add(slug)
    return n
  })

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">기회</h1>
      <p className="mt-1 text-sm leading-relaxed text-ink-500">
        해외 여러 나라에서 같은 문제를 푸는 회사 묶음을 찾아 한국판 가설로 바꾼 것입니다.
        숫자는 수집 데이터에서 세고, 해석은 AI가 씁니다. 매주 월요일 갱신.
      </p>

      <div className="mt-4 flex flex-wrap gap-1">
        {STAGES.map(([v, label]) => (
          <button key={v} type="button" onClick={() => pick(v)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${stage === v ? 'bg-brand-50 text-brand-700' : 'text-ink-600 hover:bg-ink-100'}`}>
            {label} <span className="text-xs text-ink-400 tabular-nums">{counts[v] ?? 0}</span>
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-6 flex items-center gap-2 text-sm text-red-700"><AlertTriangle size={16} /> {error}</p>
      )}
      {!opps && !error && <div className="flex justify-center py-20 text-ink-400"><Loader2 className="animate-spin" /></div>}
      {opps && !list.length && (
        <p className="mt-10 text-center text-sm text-ink-500">
          {opps.length ? '이 단계에 해당하는 기회가 없습니다.' : '아직 감지된 기회가 없습니다. 첫 실행 후 채워집니다.'}
        </p>
      )}

      <ul className="mt-4 space-y-3">
        {list.map((o) => (
          <Card key={o.slug} o={o} members={o.members.map((id) => members.get(id)).filter(Boolean)}
            open={openSet.has(o.slug)} onToggle={() => toggle(o.slug)} />
        ))}
      </ul>
    </div>
  )
}
