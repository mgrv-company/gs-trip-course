# 썸네일 없는 가게의 대표 사진 보충 수집 (플레이스 홈의 imageUrl)
# 실행: python data/fetch_photos.py  (프로젝트 루트, 4초 간격)
import json, re, time, urllib.request, io, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'

# 현재 places.js 기준으로 사진 없는 가게만 대상
js = open('places.js', encoding='utf-8').read()
data = json.loads(js[js.index('['):js.rindex(']')+1])
targets = [p['u'].split('/')[-1] for p in data if not p.get('img')]

try:
    photos = json.load(open('data/photos.json', encoding='utf-8'))
except FileNotFoundError:
    photos = {}

def fetch(sid):
    url = f'https://m.place.naver.com/place/{sid}/home'
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ko'})
    html = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
    m = re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*?});\s*\n', html, re.S) or \
        re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*})', html)
    if not m:
        return ''
    state = json.loads(m.group(1))
    # 1순위: placeDetail의 대표 imageUrl / 2순위: 업체 등록 사진 첫 장
    for k, v in state.items():
        if k.startswith('ROOT_QUERY') and isinstance(v, dict):
            for kk, vv in v.items():
                if kk.startswith('placeDetail') and isinstance(vv, dict) and vv.get('imageUrl'):
                    return vv['imageUrl']
    for k, v in state.items():
        if k.startswith('PlaceDetailTopPhotoItem:business') and isinstance(v, dict) and v.get('origin'):
            return v['origin']
    return ''

todo = [s for s in targets if s not in photos]
print(f'대상 {len(todo)}곳 (이미 수집 {len(photos)}곳)')
fail = 0
for i, sid in enumerate(todo):
    try:
        photos[sid] = fetch(sid)
        if not photos[sid]:
            fail += 1
    except Exception as e:
        print(f'  ERR {sid}: {e}')
        fail += 1
        photos[sid] = ''
    if (i + 1) % 20 == 0 or i == len(todo) - 1:
        json.dump(photos, open('data/photos.json', 'w', encoding='utf-8'), ensure_ascii=False)
        print(f'진행 {i+1}/{len(todo)} (사진 못 찾음 {fail})', flush=True)
    time.sleep(4)

json.dump(photos, open('data/photos.json', 'w', encoding='utf-8'), ensure_ascii=False)
ok = sum(1 for v in photos.values() if v)
print(f'완료: {len(photos)}곳 중 사진 확보 {ok}곳')
