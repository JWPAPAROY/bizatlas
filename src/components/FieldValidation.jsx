import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

// 기회 깔때기 ③ 현장 검증. 쓰기·읽기는 전부 'field' 시크릿 함수(supabase/migrations/20261026010000_opportunity_field.sql).
// 폐기 기준·판정일은 시작할 때 확정하고 이후 고치지 않는다 — 결과를 보고 기준을 옮기지 않기 위해.

const KEY = 'bizatlas.fieldSecret'
const KIND = { interview: '인터뷰', fake_door: '가짜 문', other: '기타' }
const SIGNAL = { for: ['지지', 'text-emerald-700'], against: ['반대', 'text-red-700'], mixed: ['애매', 'text-amber-700'] }
const DEFAULT_WEEKS = 6

const kstDate = (t) => new Date(new Date(t).getTime() + 9 * 3600e3).toISOString().slice(0, 10)
const kstToday = () => kstDate(Date.now())
const addDays = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10)
const daysUntil = (d) => Math.round((Date.parse(d) - Date.parse(kstToday())) / 86400e3)

const store = {
  get() { try { return localStorage.getItem(KEY) } catch { return null } },
  set(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY) } catch { /* 저장 못 해도 이번 세션은 쓴다 */ } },
}

async function call(fn, args) {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.code === '42501' ? '시크릿이 맞지 않습니다' : error.message)
  return data
}

export function useFieldSecret() {
  const [secret, setSecret] = useState(store.get)
  const [field, setField] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async (s) => {
    try {
      setField(await call('field_read', { p_secret: s }))
      setError(null)
      return true
    } catch (e) {
      setError(e.message)
      return false
    }
  }, [])

  useEffect(() => {
    if (!secret || !supabase) return
    load(secret).then((ok) => { if (!ok) { store.set(null); setSecret(null) } })
  }, [secret, load])

  return {
    secret, field, error,
    unlock: async (s) => {
      if (!s || !(await load(s))) return false
      store.set(s)
      setSecret(s)
      return true
    },
    lock: () => { store.set(null); setSecret(null); setField(null) },
    refresh: () => (secret ? load(secret) : Promise.resolve(false)),
  }
}

function useAction(onChange) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try { await fn(); await onChange() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return { busy, error, run }
}

const input = 'w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm'
const primary = 'rounded-lg bg-ink-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40'

// 신호·데스크 단계 → 현장 검증. AI 초안 폐기 기준을 사람이 고쳐서 확정한다.
export function FieldStart({ o, secret, onChange }) {
  const [open, setOpen] = useState(false)
  const [criteria, setCriteria] = useState(() => (o.card?.kill_criteria ?? []).join('\n'))
  const [decideBy, setDecideBy] = useState(() => addDays(kstToday(), DEFAULT_WEEKS * 7))
  const { busy, error, run } = useAction(onChange)
  const lines = criteria.split('\n').map((l) => l.trim()).filter(Boolean)

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50">
        현장 검증 시작
      </button>
    )
  }
  return (
    <form className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3" onSubmit={(e) => {
      e.preventDefault()
      run(() => call('field_start', { p_secret: secret, p_opportunity: o.id, p_criteria: lines, p_decide_by: decideBy }))
    }}>
      <p className="text-sm font-semibold text-ink-800">폐기 기준 확정</p>
      <p className="text-xs text-ink-600">
        한 줄에 하나. 숫자로 판정할 수 있게 쓰세요(예: "인터뷰 10명 중 같은 고통 5명 미만"). <b>확정하면 고칠 수 없습니다.</b>
        판정일까지 기준을 통과하지 못하면 연장 없이 폐기가 기본입니다.
      </p>
      <textarea rows={Math.max(3, lines.length + 1)} value={criteria} onChange={(e) => setCriteria(e.target.value)} className={input} />
      <label className="flex items-center gap-2 text-sm text-ink-700">
        판정일 <input type="date" value={decideBy} min={addDays(kstToday(), 1)} onChange={(e) => setDecideBy(e.target.value)} className="rounded-lg border border-ink-200 px-2 py-1 text-sm" />
      </label>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !lines.length || lines.length > 6} className={primary}>확정하고 시작</button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-ink-500">취소</button>
        {lines.length > 6 && <span className="text-xs text-red-700">기준은 6개까지</span>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </form>
  )
}

function LogForm({ o, v, secret, onChange }) {
  const blank = { kind: 'interview', happened_on: kstToday(), who: '', summary: '', signal: 'mixed', criteria_hit: [], shown: '', clicked: '', signed_up: '' }
  const [f, setF] = useState(blank)
  const { busy, error, run } = useAction(onChange)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const toggleHit = (i) => setF({ ...f, criteria_hit: f.criteria_hit.includes(i) ? f.criteria_hit.filter((x) => x !== i) : [...f.criteria_hit, i] })

  return (
    <form className="space-y-2 rounded-lg bg-ink-50 p-3" onSubmit={(e) => {
      e.preventDefault()
      const metrics = f.kind === 'fake_door'
        ? Object.fromEntries(['shown', 'clicked', 'signed_up'].filter((k) => f[k] !== '').map((k) => [k, Number(f[k])]))
        : {}
      run(async () => {
        await call('field_log', { p_secret: secret, p_opportunity: o.id, p: { ...f, metrics } })
        setF(blank)
      })
    }}>
      <div className="flex flex-wrap gap-2">
        <select value={f.kind} onChange={set('kind')} className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm">
          {Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input type="date" value={f.happened_on} max={kstToday()} onChange={set('happened_on')} className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm" />
        <input value={f.who} onChange={set('who')} placeholder="누구 (역할만, 실명 금지)" className="min-w-40 flex-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm" />
      </div>
      {f.kind === 'fake_door' && (
        <div className="flex flex-wrap gap-2 text-sm">
          {[['shown', '노출'], ['clicked', '클릭'], ['signed_up', '신청']].map(([k, l]) => (
            <label key={k} className="flex items-center gap-1 text-ink-600">{l}
              <input type="number" min="0" value={f[k]} onChange={set(k)} className="w-20 rounded-lg border border-ink-200 px-2 py-1 text-sm tabular-nums" />
            </label>
          ))}
        </div>
      )}
      <textarea rows={3} value={f.summary} onChange={set('summary')} placeholder="들은 것·본 것 (해석 말고 사실 위주)" className={input} />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-ink-500">근거 방향</span>
        {Object.entries(SIGNAL).map(([k, [l]]) => (
          <label key={k} className="flex items-center gap-1"><input type="radio" checked={f.signal === k} onChange={() => setF({ ...f, signal: k })} /> {l}</label>
        ))}
      </div>
      <div className="space-y-0.5 text-sm">
        <span className="text-ink-500">해당하는 폐기 기준</span>
        {v.kill_criteria.map((c, i) => (
          <label key={i} className="flex items-start gap-1.5 text-ink-700">
            <input type="checkbox" className="mt-1" checked={f.criteria_hit.includes(i)} onChange={() => toggleHit(i)} /> {i + 1}. {c}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !f.summary.trim()} className={primary}>기록 추가</button>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </form>
  )
}

function DecideForm({ o, secret, onChange }) {
  const [reason, setReason] = useState('')
  const { busy, error, run } = useAction(onChange)
  const decide = (d) => {
    if (!window.confirm(`${d === 'go' ? '진행' : '폐기'}으로 판정합니다. 되돌릴 수 없습니다.`)) return
    run(() => call('field_decide', { p_secret: secret, p_opportunity: o.id, p_decision: d, p_reason: reason }))
  }
  return (
    <div className="space-y-2">
      <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="판정 사유 — 어느 기준을 통과/위반했는지" className={input} />
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy || !reason.trim()} onClick={() => decide('go')} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">진행</button>
        <button type="button" disabled={busy || !reason.trim()} onClick={() => decide('killed')} className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40">폐기</button>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  )
}

// 현장 검증 중·판정 끝난 기회의 기록. 잠금 해제한 사람에게만 보인다.
export function FieldPanel({ o, v, secret, onChange }) {
  const { error, run } = useAction(onChange)
  const logs = v.logs ?? []
  const decided = Boolean(v.decision)
  const left = daysUntil(v.decide_by)
  const hits = v.kill_criteria.map((_, i) => logs.filter((l) => l.criteria_hit.includes(i)).length)
  const tally = Object.fromEntries(Object.keys(SIGNAL).map((k) => [k, logs.filter((l) => l.signal === k).length]))
  const interviews = logs.filter((l) => l.kind === 'interview').length

  return (
    <div className="space-y-3 rounded-lg border border-amber-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-800">현장 검증</h3>
        <span className={`text-xs tabular-nums ${!decided && left < 0 ? 'font-semibold text-red-700' : 'text-ink-500'}`}>
          {kstDate(v.started_at)} 시작 · 판정일 {v.decide_by}
          {!decided && (left >= 0 ? ` (D-${left})` : ` (${-left}일 지남 — 판정하세요)`)}
        </span>
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold text-ink-400">폐기 기준 (확정됨)</p>
        <ol className="space-y-0.5 text-sm">
          {v.kill_criteria.map((c, i) => (
            <li key={i} className="text-ink-800">{i + 1}. {c} {hits[i] > 0 && <span className="text-xs font-semibold text-red-700">· 해당 기록 {hits[i]}건</span>}</li>
          ))}
        </ol>
      </div>

      <p className="text-xs text-ink-500 tabular-nums">
        기록 {logs.length}건 (인터뷰 {interviews}) · {Object.entries(SIGNAL).map(([k, [l]]) => `${l} ${tally[k]}`).join(' · ')}
      </p>

      {logs.length > 0 && (
        <ul className="space-y-2 text-sm">
          {logs.map((l) => (
            <li key={l.id} className="border-l-2 border-ink-200 pl-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-500">
                <span className="tabular-nums">{l.happened_on}</span>
                <span>{KIND[l.kind]}</span>
                {l.who && <span>{l.who}</span>}
                <span className={`font-semibold ${SIGNAL[l.signal][1]}`}>{SIGNAL[l.signal][0]}</span>
                {l.criteria_hit.length > 0 && <span className="text-red-700">기준 {l.criteria_hit.map((i) => i + 1).join(',')}</span>}
                {l.kind === 'fake_door' && l.metrics?.shown > 0 && (
                  <span className="tabular-nums">
                    노출 {l.metrics.shown} · 클릭 {l.metrics.clicked ?? '—'} · 신청 {l.metrics.signed_up ?? '—'}
                    {l.metrics.signed_up != null && ` (${((l.metrics.signed_up / l.metrics.shown) * 100).toFixed(1)}%)`}
                  </span>
                )}
                {!decided && (
                  <button type="button" title="기록 삭제" className="ml-auto text-ink-300 hover:text-red-700"
                    onClick={() => window.confirm('이 기록을 지웁니다.') && run(() => call('field_log_delete', { p_secret: secret, p_log: l.id }))}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-ink-800">{l.summary}</p>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-red-700">{error}</p>}

      {decided ? (
        <p className="text-sm">
          <b className={v.decision === 'go' ? 'text-emerald-700' : 'text-red-700'}>{v.decision === 'go' ? '진행' : '폐기'}</b>
          <span className="text-ink-500"> · {kstDate(v.decided_at)}</span>
          <span className="block whitespace-pre-wrap text-ink-700">{v.decision_reason}</span>
        </p>
      ) : (
        <>
          <LogForm o={o} v={v} secret={secret} onChange={onChange} />
          <DecideForm o={o} secret={secret} onChange={onChange} />
        </>
      )}
    </div>
  )
}
