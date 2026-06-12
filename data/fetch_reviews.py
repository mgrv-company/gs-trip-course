# 방문자 리뷰에서 웨이팅 신호 수집: 최근 리뷰 10개의 대기 언급 + 네이버 줄서기 도입 여부
# 실행: python data/fetch_reviews.py  (프로젝트 루트, 4초 간격 — 429 방지)
import json, re, time, urllib.request, io, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
WAIT_PAT = re.compile(r'웨이팅|대기[가-힣]*\s|줄\s*서|줄이\s|오픈런|번호표')
places = json.load(open('data/places_tagged.json', encoding='utf-8'))

try:
    stats = json.load(open('data/reviews_stats.json', encoding='utf-8'))
except FileNotFoundError:
    stats = {}

def fetch(sid):
    url = f'https://m.place.naver.com/place/{sid}/review/visitor'
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ko'})
    html = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
    m = re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*?});\s*\n', html, re.S) or \
        re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*})', html)
    if not m:
        return None
    data = json.loads(m.group(1))
    bodies = [v['body'] for v in data.values()
              if isinstance(v, dict) and v.get('__typename') == 'VisitorReview' and v.get('body')]
    wait = sum(1 for b in bodies if WAIT_PAT.search(b))
    # 네이버 줄서기(원격 웨이팅) 도입 여부 — booking 표기명에서 확인
    lineup = bool(re.search(r'"booking(?:Display|Button|HubButton)Name":\s*"[^"]*줄서기', html))
    return {'sample': len(bodies), 'wait': wait, 'lineup': lineup}

todo = [p for p in places if str(p['sid']) not in stats]
print(f'대상 {len(todo)}곳 (이미 수집 {len(stats)}곳)')
fail = 0
for i, p in enumerate(todo):
    sid = str(p['sid'])
    try:
        r = fetch(sid)
        stats[sid] = r if r is not None else {'_fail': True}
        if r is None:
            fail += 1
    except Exception as e:
        print(f'  ERR {p["name"]} ({sid}): {e}')
        fail += 1
        stats[sid] = {'_fail': True}
    if (i + 1) % 20 == 0 or i == len(todo) - 1:
        json.dump(stats, open('data/reviews_stats.json', 'w', encoding='utf-8'), ensure_ascii=False)
        print(f'진행 {i+1}/{len(todo)} (실패 {fail})', flush=True)
    time.sleep(4)

json.dump(stats, open('data/reviews_stats.json', 'w', encoding='utf-8'), ensure_ascii=False)
busy = sum(1 for v in stats.values() if v.get('wait', 0) >= 3 or v.get('lineup'))
print(f'완료: {len(stats)}곳 | 웨이팅 잦음 신호 {busy}곳')
