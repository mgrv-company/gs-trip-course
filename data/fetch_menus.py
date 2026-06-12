# 네이버 플레이스에서 대표 메뉴(이름·가격·추천) 수집
# 실행: python data/fetch_menus.py  (프로젝트 루트, 4초 간격 — 429 방지)
import json, re, time, urllib.request, io, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
places = json.load(open('data/places_tagged.json', encoding='utf-8'))

try:
    menus = json.load(open('data/menus.json', encoding='utf-8'))
except FileNotFoundError:
    menus = {}

def fetch(sid):
    url = f'https://m.place.naver.com/place/{sid}/home'
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ko'})
    html = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
    m = re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*?});\s*\n', html, re.S) or \
        re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*})', html)
    if not m:
        return None
    data = json.loads(m.group(1))
    items = []
    for k, v in data.items():
        if k.startswith('Menu:') and isinstance(v, dict) and v.get('name'):
            items.append({
                'name': v['name'][:30],
                'price': v.get('price') or '',
                'rec': bool(v.get('recommend') or v.get('isRepresentative')),
            })
    # 추천 메뉴 먼저, 최대 5개
    items.sort(key=lambda x: not x['rec'])
    return items[:5]

todo = [p for p in places if str(p['sid']) not in menus]
print(f'대상 {len(todo)}곳 (이미 수집 {len(menus)}곳)')
fail = 0
for i, p in enumerate(todo):
    sid = str(p['sid'])
    try:
        r = fetch(sid)
        menus[sid] = r if r is not None else []
        if r is None:
            fail += 1
    except Exception as e:
        print(f'  ERR {p["name"]} ({sid}): {e}')
        fail += 1
        menus[sid] = []
    if (i + 1) % 20 == 0 or i == len(todo) - 1:
        json.dump(menus, open('data/menus.json', 'w', encoding='utf-8'), ensure_ascii=False)
        print(f'진행 {i+1}/{len(todo)} (실패 {fail})', flush=True)
    time.sleep(4)

json.dump(menus, open('data/menus.json', 'w', encoding='utf-8'), ensure_ascii=False)
ok = sum(1 for v in menus.values() if v)
print(f'완료: {len(menus)}곳 중 메뉴 확보 {ok}곳')
