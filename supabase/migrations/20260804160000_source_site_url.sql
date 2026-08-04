-- 소스에 "사람이 보는 주소"를 따로 둔다.
--
-- 지금까지 소개 페이지의 소스 링크가 url(피드 주소)로 걸려 있어서, 누르면 RSS/JSON 원본이
-- 그대로 열렸다. 링크 텍스트는 회사 이름이니 그 사이트로 갈 거라 기대하는 게 자연스럽다.
-- url 은 파이프라인이 읽는 주소, site_url 은 사람이 여는 주소로 역할을 나눈다.

alter table sources add column if not exists site_url text;

update sources set site_url = 'https://www.ycombinator.com/companies'   where name = 'Y Combinator';
update sources set site_url = 'https://www.producthunt.com'             where name = 'Product Hunt';
update sources set site_url = 'https://news.ycombinator.com/show'       where name = 'Hacker News (Show HN)';
update sources set site_url = 'https://techcrunch.com'                  where name = 'TechCrunch';
update sources set site_url = 'https://techcrunch.com/category/venture/' where name = 'TechCrunch Venture';
