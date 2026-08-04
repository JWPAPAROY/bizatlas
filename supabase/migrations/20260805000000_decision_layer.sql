-- "비교"에서 "판단"으로 넘어가는 층.
--
-- 축 세 개로 비교까지는 되는데, 거기서 다음 행동이 안 나온다는 한계가 있었다.
-- 코스트코 모델이 한국 적용성 5점이라는 걸 알아도 "그래서 뭘 해야 하나"가 없다.
--
-- 주의: 아래는 모두 **AI 가 생성한 해석**이다. 특히 korea_analogs 는 실재 회사명을 다루므로
-- 환각 위험이 있다. 화면에서 검증된 사실과 명확히 구분해 표시해야 한다.

alter table businesses
  -- 한국에 이미 같은 모델을 하는 사업자가 있는가. 있으면 그 자체가 답이고, 없으면 이유를 봐야 한다.
  add column if not exists korea_analogs   text[] not null default '{}',
  add column if not exists korea_analog_note text,
  -- 자본 집약도 점수를 구체적인 금액·항목으로 푼 것. "3점"만으로는 행동으로 안 이어진다.
  add column if not exists startup_scale   text,
  -- 한국에서 이 사업을 하려면 걸리는 인허가·규제 체크포인트
  add column if not exists regulatory_notes text[] not null default '{}',
  -- 위 세 필드를 언제 채웠는지 (재생성 대상 판별용)
  add column if not exists decided_at timestamptz;

create index if not exists businesses_decided_at_idx on businesses (decided_at nulls first);
