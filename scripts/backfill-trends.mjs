// 트렌드 층 백필 — 투자 라운드 구조화(businesses + funding_rounds) + 태그 표기 정규화. **AI 호출 0회.**
//
// 신규 수집분은 ingest 가 저장 직전에 같은 규칙(_shared/funding.js · _shared/tags.js)을 적용한다.
// 이 스크립트가 필요한 경우:
//   - 최초 1회 (기존 행 채우기)
//   - 파서·동의어 규칙을 고쳤을 때 → 다시 돌리면 전체가 새 규칙으로 재계산된다 (멱등)
//
// 태그 별칭은 데이터에서 만든다: 같은 키(공백·대소문자 제거)로 묶이는 표기 중 가장 많이 쓰인 것을
// 대표로 삼고, SYNONYMS(영↔한)가 있으면 그쪽이 이긴다. 결과는 tag_aliases 에 저장돼 ingest 가 읽는다.
//
// 사용법:
//   SUPABASE_URL=xx SUPABASE_SERVICE_ROLE_KEY=xx node scripts/backfill-trends.mjs [--dry]

import { parseFunding } from '../supabase/functions/_shared/funding.js'
import { tagKey, SYNONYMS, normalizeTags } from '../supabase/functions/_shared/tags.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DRY = process.argv.includes('--dry')

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.')
  process.exit(1)
}

const H = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...init.headers } })
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

// PostgREST 기본 상한(1000)을 넘으므로 페이지로 받는다
async function loadAll() {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const page = await sb(`businesses?select=id,name,tags,traction,funding_usd_m,funding_stage&order=id`, {
      headers: { Range: `${from}-${from + 999}` },
    })
    rows.push(...page)
    if (page.length < 1000) break
  }
  return rows
}

const rows = await loadAll()
console.log(`행 ${rows.length}건`)

// ── 1) 태그 별칭 생성
const variants = new Map() // key → Map<표기, 횟수>
for (const r of rows) {
  for (const t of r.tags ?? []) {
    const s = String(t).trim()
    const k = tagKey(s)
    if (!k) continue
    if (!variants.has(k)) variants.set(k, new Map())
    const m = variants.get(k)
    m.set(s, (m.get(s) ?? 0) + 1)
  }
}
const aliases = new Map()
for (const [k, m] of variants) {
  // 동률이면 한글 표기, 그다음 공백 있는 쪽(읽기 쉬움)을 대표로
  const best = [...m.entries()].sort((a, b) =>
    b[1] - a[1] ||
    Number(/[가-힣]/.test(b[0])) - Number(/[가-힣]/.test(a[0])) ||
    Number(/\s/.test(b[0])) - Number(/\s/.test(a[0])))[0][0]
  aliases.set(k, best)
}
// 동의어가 대표 표기를 덮는다. 동의어의 대상 표기 자체도 자기 키의 대표가 되도록 맞춘다.
for (const [k, canon] of Object.entries(SYNONYMS)) {
  aliases.set(k, canon)
  aliases.set(tagKey(canon), canon)
}
// 연쇄 해소: A→B 인데 B 의 키가 또 C 로 가면 A→C
for (const [k, v] of aliases) {
  const v2 = aliases.get(tagKey(v))
  if (v2 && v2 !== v) aliases.set(k, v2)
}

// ── 2) 행별 갱신 계산
const updates = []
let fundingChanged = 0, tagsChanged = 0
for (const r of rows) {
  const patch = {}
  const f = parseFunding(r.traction?.funding)
  if (f.usd_m !== (r.funding_usd_m == null ? null : Number(r.funding_usd_m)) || f.stage !== r.funding_stage) {
    patch.funding_usd_m = f.usd_m
    patch.funding_stage = f.stage
    fundingChanged++
  }
  const nt = normalizeTags(r.tags, aliases)
  if (JSON.stringify(nt) !== JSON.stringify(r.tags ?? [])) {
    patch.tags = nt
    tagsChanged++
  }
  if (Object.keys(patch).length) updates.push([r.id, patch])
}

const before = new Set(rows.flatMap((r) => (r.tags ?? []).map(String)))
const after = new Set(rows.flatMap((r) => normalizeTags(r.tags, aliases)))
console.log(`투자 필드 변경 ${fundingChanged}건 · 태그 변경 ${tagsChanged}건 · 고유 태그 ${before.size} → ${after.size}`)

if (DRY) { console.log('--dry: 저장하지 않음'); process.exit(0) }

// ── 3) 저장: 별칭 테이블 → 행
const aliasRows = [...aliases].map(([key, canonical]) => ({ key, canonical, updated_at: new Date().toISOString() }))
for (let i = 0; i < aliasRows.length; i += 500) {
  await sb('tag_aliases?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(aliasRows.slice(i, i + 500)),
  })
}
console.log(`tag_aliases ${aliasRows.length}건 저장`)

// 행별 PATCH 를 동시 8개씩
let done = 0
for (let i = 0; i < updates.length; i += 8) {
  await Promise.all(updates.slice(i, i + 8).map(([id, patch]) =>
    sb(`businesses?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) })))
  done += Math.min(8, updates.length - i)
}
console.log(`businesses ${done}건 갱신 완료`)

// ── 4) 투자 라운드 테이블도 같은 파서로 재계산 (funding_rounds.raw → stage·usd_m)
const rounds = []
for (let from = 0; ; from += 1000) {
  const page = await sb('funding_rounds?select=id,raw,stage,usd_m&order=id', { headers: { Range: `${from}-${from + 999}` } })
  rounds.push(...page)
  if (page.length < 1000) break
}
const rUpd = rounds
  .map((r) => [r, parseFunding(r.raw)])
  .filter(([r, f]) => f.stage !== r.stage || f.usd_m !== (r.usd_m == null ? null : Number(r.usd_m)))
for (let i = 0; i < rUpd.length; i += 8) {
  await Promise.all(rUpd.slice(i, i + 8).map(([r, f]) =>
    sb(`funding_rounds?id=eq.${r.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ stage: f.stage, usd_m: f.usd_m }),
    })))
}
console.log(`funding_rounds ${rUpd.length}/${rounds.length}건 갱신 완료`)
