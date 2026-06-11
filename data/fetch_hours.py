# 네이버 모바일 플레이스 페이지에서 가게별 영업시간/휴무 수집
# 실행: python data/fetch_hours.py  (프로젝트 루트 기준)
import json, re, time, urllib.request, io, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
places = json.load(open('data/places_tagged.json', encoding='utf-8'))

try:
    hours = json.load(open('data/hours.json', encoding='utf-8'))
except FileNotFoundError:
    hours = {}

def fetch(sid):
    url = f'https://m.place.naver.com/place/{sid}/home'
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ko'})
    html = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
    m = re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*?});\s*\n', html, re.S) or \
        re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*})', html)
    if not m:
        return None
    data = json.loads(m.group(1))
    for k, v in data.items():
        if not k.startswith('ROOT_QUERY'):
            continue
        if isinstance(v, dict):
            for kk, vv in v.items():
                if kk.startswith('placeDetail'):
                    for kkk, payload in vv.items() if isinstance(vv, dict) else []:
                        if kkk.startswith('newBusinessHours') and payload:
                            return payload
    # ROOT_QUERY 가 중첩 형태가 아닐 때 대비
    rq = data.get('ROOT_QUERY', {})
    for kk, vv in rq.items():
        if kk.startswith('placeDetail') and isinstance(vv, dict):
            for kkk, payload in vv.items():
                if kkk.startswith('newBusinessHours') and payload:
                    return payload
    return None

todo = [p for p in places if str(p['sid']) not in hours]
print(f'대상 {len(todo)}곳 (이미 수집 {len(hours)}곳)')
fail = 0
for i, p in enumerate(todo):
    sid = str(p['sid'])
    try:
        raw = fetch(sid)
        # 요일별로 정규화
        norm = {'days': {}, 'desc': '', 'status_ok': raw is not None}
        if raw:
            block = raw[0] if isinstance(raw, list) and raw else raw
            for d in (block.get('businessHours') or []):
                day = d.get('day') or ''
                bh = d.get('businessHours')
                norm['days'][day] = {
                    'start': bh.get('start') if bh else None,
                    'end': bh.get('end') if bh else None,
                    'desc': d.get('description'),
                }
            sd = block.get('businessStatusDescription') or {}
            norm['desc'] = sd.get('description') or ''
        hours[sid] = norm
        if not raw:
            fail += 1
    except Exception as e:
        print(f'  ERR {p["name"]} ({sid}): {e}')
        fail += 1
        hours[sid] = {'days': {}, 'desc': '', 'status_ok': False}
    if (i + 1) % 20 == 0 or i == len(todo) - 1:
        json.dump(hours, open('data/hours.json', 'w', encoding='utf-8'), ensure_ascii=False)
        print(f'진행 {i+1}/{len(todo)} (실패 {fail})')
    time.sleep(4)

json.dump(hours, open('data/hours.json', 'w', encoding='utf-8'), ensure_ascii=False)
ok = sum(1 for v in hours.values() if v.get('days'))
print(f'완료: 총 {len(hours)}곳 중 영업시간 확보 {ok}곳, 미확보 {len(hours)-ok}곳')
