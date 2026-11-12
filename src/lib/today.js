// 오늘 수집 현황 화면(홈 요약 스트립 · /today 페이지)이 공유하는 시간·집계 규칙.
//
// 전제 두 가지 — 숫자가 안 맞아 보일 때 여기부터 읽을 것.
//
// 1) 하루 경계는 항상 KST 로 자른다. created_at 은 timestamptz(UTC 저장)라
//    브라우저 로컬 자정으로 자르면 접속 지역에 따라 "오늘"이 달라진다.
// 2) 신규 등록(businesses)과 파이프라인 처리량(ingest_runs)은 다른 수를 센다.
//    proven 시드는 로컬 스크립트(seed-korea) · seed-proven 함수로 들어와
//    ingest_runs 에 기록이 남지 않는다. 두 값을 한 칸에 합치면 안 된다.

export const KST_OFFSET = 9 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

/** daysAgo 일 전 KST 자정에 해당하는 실제 시각 */
export function kstDayStart(daysAgo = 0) {
  const shifted = new Date(Date.now() + KST_OFFSET)
  shifted.setUTCHours(0, 0, 0, 0)
  return new Date(shifted.getTime() - KST_OFFSET - daysAgo * DAY)
}

/** KST 기준 YYYY-MM-DD 키 — 일별 집계용 */
export function kstDayKey(ts) {
  return new Date(new Date(ts).getTime() + KST_OFFSET).toISOString().slice(0, 10)
}

/** 'YYYY-MM-DD'(KST) → 그 하루의 [시작, 끝) 실제 시각. 일자별 목록 필터용 */
export function kstDayRange(key) {
  const start = new Date(`${key}T00:00:00+09:00`)
  if (Number.isNaN(start.getTime())) return null
  return { start, end: new Date(start.getTime() + DAY) }
}

export const fmtKstTime = (ts) =>
  new Date(ts).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
  })

// pg_cron `7 */4 * * *` = UTC 0/4/8/12/16/20시 7분 → KST 01/05/09/13/17/21시 7분.
// 정각(:00)을 피한 이유: 00:00 UTC 정각 실행이 플랫폼 혼잡으로 503 에 잘렸다(2026-11-10·12).
// cron 정의는 supabase/migrations/20261112000000_ingest_cron_offset.sql — 바꾸면 여기도 같이.
const RUN_HOURS_KST = [1, 5, 9, 13, 17, 21]
const RUN_MINUTE = 7

export function nextRunLabel() {
  const now = new Date(Date.now() + KST_OFFSET)
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes()
  const next = RUN_HOURS_KST.find((h) => h * 60 + RUN_MINUTE > nowMin)
  const hh = String(next ?? RUN_HOURS_KST[0]).padStart(2, '0')
  return `${hh}:${String(RUN_MINUTE).padStart(2, '0')}${next != null ? '' : ' (내일)'}`
}

/** 실행 여러 건의 fetched/created/skipped/failed 합계 */
export function sumRuns(runs) {
  return runs.reduce(
    (acc, r) => ({
      fetched: acc.fetched + (r.fetched ?? 0),
      created: acc.created + (r.created ?? 0),
      skipped: acc.skipped + (r.skipped ?? 0),
      failed: acc.failed + (r.failed ?? 0),
    }),
    { fetched: 0, created: 0, skipped: 0, failed: 0 },
  )
}
