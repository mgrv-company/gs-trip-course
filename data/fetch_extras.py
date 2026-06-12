# 네이버 플레이스에서 자동 판단용 신호 수집: 예약제 여부·평점·리뷰수·한줄소개·네이버예약 링크
# 실행: python data/fetch_extras.py  (프로젝트 루트 기준, 4초 간격 — 429 방지)
import json, re, time, urllib.request, io, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
places = json.load(open('data/places_tagged.json', encoding='utf-8'))

try:
    extras = json.load(open('data/extras.json', encoding='utf-8'))
except FileNotFoundError:
    extras = {}

RESERVE_PAT = re.compile(r'예약제|예약\s*필수|예약\s*후\s*방문|100%\s*예약|예약만|예약\s*우선')

def deep_find(obj, want_key_part, path_filter=None):
    """APOLLO 트리에서 키 이름에 want_key_part가 포함된 첫 값을 찾음"""
    stack = [(obj, '')]
    while stack:
        cur, path = stack.pop()
        if isinstance(cur, dict):
            for k, v in cur.items():
                if want_key_part in k and v not in (None, '', [], {}):
                    if path_filter is None or path_filter in path + '/' + k:
                        return v
                stack.append((v, path + '/' + k))
        elif isinstance(cur, list):
            for v in cur:
                stack.append((v, path))
    return None

def fetch(sid):
    url = f'https://m.place.naver.com/place/{sid}/home'
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ko'})
    html = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
    m = re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*?});\s*\n', html, re.S) or \
        re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*})', html)
    if not m:
        return None
    data = json.loads(m.group(1))

    base = None  # PlaceDetailBase:{sid}
    for k, v in data.items():
        if k.startswith('PlaceDetailBase'):
            base = v
            break

    out = {}
    if base:
        if base.get('visitorReviewsScore'):
            out['score'] = base['visitorReviewsScore']
        if base.get('visitorReviewsTotal'):
            out['reviews'] = base['visitorReviewsTotal']
        mr = base.get('microReviews')
        if mr and isinstance(mr, list) and mr[0]:
            out['micro'] = mr[0][:60]

    desc = deep_find(data, 'description({') or ''
    if isinstance(desc, str) and RESERVE_PAT.search(desc):
        out['reserve_auto'] = True

    booking = deep_find(data, 'naverBookingUrl')
    if booking:
        out['booking'] = booking
    return out

todo = [p for p in places if str(p['sid']) not in extras]
print(f'대상 {len(todo)}곳 (이미 수집 {len(extras)}곳)')
fail = 0
for i, p in enumerate(todo):
    sid = str(p['sid'])
    try:
        r = fetch(sid)
        extras[sid] = r if r is not None else {'_fail': True}
        if r is None:
            fail += 1
    except Exception as e:
        print(f'  ERR {p["name"]} ({sid}): {e}')
        fail += 1
        extras[sid] = {'_fail': True}
    if (i + 1) % 20 == 0 or i == len(todo) - 1:
        json.dump(extras, open('data/extras.json', 'w', encoding='utf-8'), ensure_ascii=False)
        print(f'진행 {i+1}/{len(todo)} (실패 {fail})', flush=True)
    time.sleep(4)

json.dump(extras, open('data/extras.json', 'w', encoding='utf-8'), ensure_ascii=False)
rsv = sum(1 for v in extras.values() if v.get('reserve_auto'))
sc = sum(1 for v in extras.values() if v.get('score'))
print(f'완료: {len(extras)}곳 | 예약제 감지 {rsv}곳 | 평점 확보 {sc}곳')
