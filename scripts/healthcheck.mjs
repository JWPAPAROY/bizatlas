// 파이프라인 건강 검사. 이상이면 exit 1 → GitHub Actions 가 실패로 끝나고 메일이 온다.
//
// 왜 필요한가: 관측 데이터는 이미 다 있는데(ingest_runs · sources.last_status · scored_at)
// 아무도 안 본다. 특히 **pg_cron 의 succeeded 는 신뢰할 수 없다** — pg_net 이 HTTP 요청을
// 던진 시점에 성공으로 기록되므로, ingest 함수가 500 으로 죽어도 cron 이력은 계속 succeeded 다.
// 그래서 cron 이 아니라 결과물(ingest_runs 행, 신규 등록 수)을 봐야 한다.
//
// service_role 이 필요 없다. 판정에 쓰는 테이블이 전부 anon 정책으로 열려 있어서,
// GitHub Secrets 에 강한 키를 올리지 않아도 된다.
//
// 사용법: SUPABASE_URL=xx SUPABASE_ANON_KEY=xx node scripts/healthcheck.mjs

const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_ANON_KEY

if (!URL_ || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_ANON_KEY 가 필요합니다.')
  process.exit(2)
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const hours = (n) => new Date(Date.now() - n * 3600_000).toISOString()

async function sb(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: H })
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

const problems = []
const notes = []

try {
  // ── 1) 수집이 실제로 돌고 있는가
  // cron 이 아니라 ingest_runs 행의 존재로 판단한다 (위 주석 참조).
  const recent = await sb(
    `ingest_runs?select=id,started_at,finished_at,fetched,created,failed&started_at=gte.${hours(24)}&order=started_at.desc`)
  notes.push(`최근 24시간 수집 실행 ${recent.length}회`)
  if (recent.length === 0) {
    problems.push('24시간 동안 수집 실행 기록이 없습니다 — pg_cron 이 멈췄거나 ingest 함수가 부팅 단계에서 죽었습니다.')
  }

  // 끝나지 않은 채 오래 남은 실행 = 함수가 중간에 죽었다는 신호
  const stuck = recent.filter((r) => !r.finished_at && new Date(r.started_at) < new Date(hours(1)))
  if (stuck.length) {
    problems.push(`시작만 하고 끝나지 않은 실행 ${stuck.length}건 (함수가 중간에 죽었을 가능성)`)
  }

  // ── 2) AI 단계가 통째로 고장났는가
  // 새 글이 없어서 created=0 인 것은 정상이다. 문제는 "실패가 있으면서 하나도 못 만든" 상태가 이어질 때다.
  const done = recent.filter((r) => r.finished_at).slice(0, 3)
  if (done.length === 3 && done.every((r) => r.created === 0 && r.failed > 0)) {
    problems.push('최근 3회 실행이 모두 신규 0건 + 실패 발생 — Gemini 키·쿼터·모델 체인을 확인하세요.')
  }

  // ── 3) 소스가 죽었는가
  const sources = await sb('sources?select=name,last_status,last_run_at&enabled=eq.true')
  const broken = sources.filter((s) => s.last_status && s.last_status.startsWith('error'))
  notes.push(`활성 소스 ${sources.length}개`)
  for (const s of broken) problems.push(`소스 오류: ${s.name} — ${String(s.last_status).slice(0, 120)}`)

  // ── 3-b) 소스가 "조용히" 죽었는가
  // last_status 로는 못 잡는 유형이 있다. 2026-08-12 의 Hacker News 가 그랬다 —
  // 소스 URL 이 점수순 엔드포인트라 매번 **같은 30건**이 돌아왔고, 그걸 다 판정한 뒤로
  // 8일간 신규가 0건이었는데 fetch 자체는 성공하니 last_status 는 계속 'ok' 였다.
  // 판별 신호: 후보는 꾸준히 들어오는데(fetched>0) 7일간 채택도 실패도 0 = 큐가 고정됐다.
  //
  // 경보(exit 1)로 걸지 않고 참고 지표로만 출력한다. YC 처럼 원래 신규가 뜸한 소스가
  // 정상인데도 걸리기 때문이다 — 사람이 보고 판단할 문제다.
  // seen_items 는 anon 으로 안 열리므로 ingest_runs.detail(소스별 집계)로 대신 본다.
  const week = await sb(
    `ingest_runs?select=detail,started_at&started_at=gte.${hours(24 * 7)}`)
  const agg = {}
  for (const r of week) {
    for (const [name, d] of Object.entries(r.detail ?? {})) {
      if (name.startsWith('_') || typeof d !== 'object' || !d) continue
      const a = (agg[name] ??= { fetched: 0, created: 0, failed: 0 })
      a.fetched += d.fetched ?? 0
      a.created += d.created ?? 0
      a.failed += d.failed ?? 0
    }
  }
  const enabled = new Set(sources.map((s) => s.name))
  const frozen = Object.entries(agg)
    .filter(([name, a]) => enabled.has(name) && a.fetched > 0 && a.created === 0 && a.failed === 0)
  if (frozen.length) {
    notes.push(
      `7일간 채택·실패가 모두 0인 소스: ${frozen.map(([n, a]) => `${n}(후보 ${a.fetched}건)`).join(', ')}` +
      ' — 같은 항목만 반복 수집되고 있는지(소스 URL 이 고정 목록을 주는지) 확인하세요.')
  }

  // ── 4) 유지보수(재평가·판단 층)가 멈췄는가
  // 방금 들어온 항목이 아직 비어 있는 건 정상이다. 3일이 지나도 비어 있으면 파이프라인이 멈춘 것이다.
  const stale = await sb(
    `businesses?select=id&status=eq.published&created_at=lt.${hours(72)}` +
    `&or=(scored_at.is.null,decided_at.is.null)`)
  notes.push(`3일 이상 지났는데 점수·판단 층이 빈 항목 ${stale.length}건`)
  if (stale.length > 30) {
    problems.push(`3일 넘게 미처리된 항목이 ${stale.length}건 — 유지보수 작업(maintain)이 멈췄습니다.`)
  }

  // ── 참고 지표 (경보 아님)
  const total = await sb('businesses?select=id&status=eq.published')
  notes.push(`공개 항목 ${total.length}건`)
} catch (e) {
  problems.push(`검사 자체가 실패했습니다: ${e.message}`)
}

console.log('── BizAtlas 상태 ──')
notes.forEach((n) => console.log('  ·', n))

if (problems.length) {
  console.log('\n── 문제 ──')
  problems.forEach((p) => console.log('  ✕', p))
  console.log('\n대시보드: https://jwpaparoy.github.io/bizatlas/#/today')
  process.exit(1)
}

console.log('\n이상 없음')
