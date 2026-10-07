// 태그 표기 정규화.
//
// 태그는 통제 어휘가 아니라 AI 가 자유롭게 쓰는 검색 키워드라 표기가 샌다:
// "AI 에이전트"/"AI에이전트", "핀테크"/"Fintech", "생성형 AI"/"생성형AI".
// 2026-10 기준 2,460종 중 표기만 다른 묶음이 182개 — 태그로 트렌드를 세면 숫자가 쪼개진다.
//
// 두 단계로 막는다.
//  1) tagKey(): 공백·하이픈·대소문자를 지운 키. 이것만으로 띄어쓰기 변종은 자동으로 합쳐진다.
//  2) tag_aliases 테이블(key → canonical): 키가 달라도 같은 말인 것(영↔한 등)과 각 키의 대표 표기.
//     scripts/normalize-tags.mjs 가 데이터에서 생성하고, ingest 는 저장 직전에 적용한다.
//
// 엣지 함수(Deno)와 로컬 스크립트(Node)가 같은 파일을 import 한다.

export function tagKey(tag) {
  return String(tag ?? '').toLowerCase().replace(/[\s\-_·./]+/g, '')
}

// 영↔한·약어처럼 키만으로는 안 합쳐지는 동의어. 왼쪽 키 → 오른쪽 대표 표기.
// 확실한 것만 넣는다 — "보안"과 "사이버보안"처럼 범위가 다른 말은 합치지 않는다.
export const SYNONYMS = {
  fintech: '핀테크',
  인공지능: 'AI',
  ai: 'AI',
  artificialintelligence: 'AI',
  genai: '생성형 AI',
  generativeai: '생성형 AI',
  생성ai: '생성형 AI',
  aiagent: 'AI 에이전트',
  aiagents: 'AI 에이전트',
  agenticai: 'AI 에이전트',
  에이전틱ai: 'AI 에이전트',
  edtech: '에듀테크',
  agtech: '애그테크',
  agritech: '애그테크',
  hrtech: 'HR테크',
  healthtech: '헬스테크',
  healthcare: '헬스케어',
  cybersecurity: '사이버보안',
  climatetech: '기후테크',
  cleantech: '클린테크',
  proptech: '프롭테크',
  insurtech: '인슈어테크',
  legaltech: '리걸테크',
  regtech: '레그테크',
  foodtech: '푸드테크',
  biotech: '바이오테크',
  robotics: '로보틱스',
  로봇공학: '로보틱스',
  robot: '로봇',
  humanoid: '휴머노이드',
  humanoidrobot: '휴머노이드',
  휴머노이드로봇: '휴머노이드',
  physicalai: '피지컬 AI',
  semiconductor: '반도체',
  semiconductors: '반도체',
  datacenter: '데이터센터',
  datacenters: '데이터센터',
  defense: '방산',
  defence: '방산',
  defensetech: '방산',
  방위산업: '방산',
  국방: '방산',
  space: '우주항공',
  spacetech: '우주항공',
  우주: '우주항공',
  ecommerce: '이커머스',
  전자상거래: '이커머스',
  marketplace: '마켓플레이스',
  saas: 'SaaS',
  b2bsaas: 'B2B SaaS',
  llm: 'LLM',
  거대언어모델: 'LLM',
  대규모언어모델: 'LLM',
  developertools: '개발자 도구',
  devtools: '개발자 도구',
  개발자툴: '개발자 도구',
  stablecoin: '스테이블코인',
  stablecoins: '스테이블코인',
  blockchain: '블록체인',
  crypto: '크립토',
  암호화폐: '크립토',
  ev: '전기차',
  electricvehicles: '전기차',
  autonomousdriving: '자율주행',
  selfdriving: '자율주행',
  logistics: '물류',
  supplychain: '공급망',
  wearable: '웨어러블',
  wearables: '웨어러블',
  medtech: '의료기기',
  medicaldevices: '의료기기',
  drugdiscovery: '신약개발',
  신약발견: '신약개발',
  compliance: '컴플라이언스',
  automation: '자동화',
  productivity: '생산성',
  opensource: '오픈소스',
  cloud: '클라우드',
  infrastructure: '인프라',
  aiinfrastructure: 'AI 인프라',
  ai인프라: 'AI 인프라',
}

// 검색 키워드로서 아무것도 구별해 주지 않는 태그. 900건 중 수십 건에 붙어 필터를 오염시킨다.
export const STOP_TAGS = new Set(['스타트업', 'startup', 'startups', '기술', 'tech', '테크', '혁신', 'innovation'].map(tagKey))

// aliases: Map<key, canonical>. 없으면 SYNONYMS 만 적용.
export function normalizeTags(tags, aliases) {
  const out = []
  const seen = new Set()
  for (const raw of tags ?? []) {
    const t = String(raw ?? '').trim()
    if (!t) continue
    const k = tagKey(t)
    if (!k || STOP_TAGS.has(k)) continue
    const canon = aliases?.get(k) ?? SYNONYMS[k] ?? t
    const ck = tagKey(canon)
    if (seen.has(ck)) continue
    seen.add(ck)
    out.push(canon)
  }
  return out
}
