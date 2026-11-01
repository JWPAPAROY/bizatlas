// 탐색 화면의 필터는 전부 URL 에 둔다. 상세에 들어갔다 뒤로 오면 그대로 남아 있어야 하고,
// 필터 조합을 링크로 공유·북마크할 수 있어야 한다. 다른 화면의 태그 링크도 여기서 주소를 만든다.

export const EMPTY = {
  q: '',
  category: '',
  customer_type: '',
  revenue_models: [],
  moats: [],
  korea_fit_min: 1,
  capital_max: 5,
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt
}
const list = (v) => (v ? v.split(',').filter(Boolean) : [])

export function readFilters(params) {
  return {
    q: params.get('q') ?? '',
    category: params.get('cat') ?? '',
    customer_type: params.get('cust') ?? '',
    revenue_models: list(params.get('rev')),
    moats: list(params.get('moat')),
    korea_fit_min: clampInt(params.get('kfit'), 1, 5, 1),
    capital_max: clampInt(params.get('cap'), 1, 5, 5),
  }
}

// 기본값은 주소에서 지워 짧게 유지한다.
export function filtersToPatch(f) {
  return {
    // 입력 중인 값이 디바운스로 들어오므로 여기서 다듬지 않는다 (끝 공백이 입력창에서 지워짐)
    q: f.q,
    cat: f.category,
    cust: f.customer_type,
    rev: f.revenue_models.join(','),
    moat: f.moats.join(','),
    kfit: f.korea_fit_min > 1 ? String(f.korea_fit_min) : '',
    cap: f.capital_max < 5 ? String(f.capital_max) : '',
  }
}

// 태그 링크. 비슷한 모델은 검증·신생을 가리지 않고 찾는 것이 목적이라 tier=all 로 연다.
export function exploreLink(patch) {
  const p = new URLSearchParams({ tier: 'all' })
  for (const [k, v] of Object.entries(patch)) if (v) p.set(k, v)
  return `/?${p}`
}

// 회사명 일부("strip")나 한국어 활용형("구독형")은 단어 단위 전문 검색에 걸리지 않는다.
// 그래서 전문 검색에 이름·요약·개요 부분 일치를 OR 로 붙인다. 값은 PostgREST 문법에 맞게 따옴표로 감싼다.
export function searchOr(term) {
  const v = term.replace(/[\\"]/g, '\\$&')
  return [
    `search_tsv.wfts(simple)."${v}"`,
    `name.ilike."*${v}*"`,
    `one_liner.ilike."*${v}*"`,
    `description.ilike."*${v}*"`,
  ].join(',')
}
