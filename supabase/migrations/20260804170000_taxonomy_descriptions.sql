-- 통제 어휘 설명 채우기.
-- revenue_model·moat 는 처음부터 description 이 있었지만 category·customer_type·region 은 비어 있었다.
-- 화면에서 "이 태그가 무슨 뜻인지"를 모두 설명하려면 전 종류에 설명이 있어야 한다.

update taxonomy set description = v.d from (values
  ('b2b',   '다른 기업에 판매합니다. 계약 단가가 크고 도입 결정이 느린 대신 이탈도 적습니다.'),
  ('b2c',   '개인 소비자에게 직접 판매합니다. 결정은 빠르지만 이탈도 빠릅니다.'),
  ('b2b2c', '기업을 통해 그 기업의 소비자에게 닿습니다. 유통 파트너가 성패를 좌우합니다.'),
  ('d2c',   '유통을 거치지 않고 제조사가 소비자에게 직접 팝니다. 마진이 크지만 수요 창출을 직접 해야 합니다.'),
  ('b2g',   '정부·공공기관에 판매합니다. 조달 절차가 길고 요건이 까다롭지만 계약이 안정적입니다.'),
  ('p2p',   '개인과 개인을 연결합니다. 양쪽 모두를 동시에 모아야 해 초기가 가장 어렵습니다.')
) as v(val, d) where taxonomy.kind = 'customer_type' and taxonomy.value = v.val;

update taxonomy set description = v.d from (values
  ('ai_infra',      'AI 모델·학습·추론을 다루거나 그 위에 올리는 인프라'),
  ('devtools',      '개발자가 쓰는 도구 — 코딩·배포·모니터링·테스트'),
  ('fintech',       '결제·송금·대출·투자·보험 등 금융'),
  ('commerce',      '물건을 파는 모든 형태 — 마켓플레이스·리테일·D2C'),
  ('health',        '의료·건강관리·바이오'),
  ('education',     '학습·교육·자격'),
  ('productivity',  '업무 생산성과 협업 — 문서·일정·커뮤니케이션'),
  ('marketing',     '마케팅·세일즈·고객 확보'),
  ('media',         '콘텐츠 제작·유통·소비'),
  ('logistics',     '물류·배송·이동수단'),
  ('proptech',      '부동산·건설·공간'),
  ('hr',            '채용·인사·조직 관리'),
  ('legal',         '법률·계약·규제 대응'),
  ('climate',       '기후·에너지·친환경'),
  ('manufacturing', '제조·산업 설비·로보틱스'),
  ('agriculture',   '농업·수산·식품 생산'),
  ('gaming',        '게임 개발·퍼블리싱·플랫폼'),
  ('social',        '소셜 네트워크·커뮤니티'),
  ('security',      '보안·인증·프라이버시'),
  ('other',         '위 분류에 들어맞지 않는 것')
) as v(val, d) where taxonomy.kind = 'category' and taxonomy.value = v.val;

update taxonomy set description = v.d from (values
  ('north_america', '미국·캐나다'),
  ('europe',        '유럽'),
  ('asia',          '아시아 (한국·일본·중국·인도 제외한 나머지)'),
  ('korea',         '한국'),
  ('japan',         '일본'),
  ('china',         '중국'),
  ('india',         '인도'),
  ('latam',         '중남미'),
  ('mena',          '중동·아프리카'),
  ('oceania',       '오세아니아'),
  ('global',        '특정 지역에 묶이지 않는 글로벌 서비스')
) as v(val, d) where taxonomy.kind = 'region' and taxonomy.value = v.val;
