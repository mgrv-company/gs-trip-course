# TourAPI(한국관광공사)로 강원 고성 액티비티(레포츠)·해수욕장 수집 → tour.js 생성
# 실행: python data/fetch_tour.py <SERVICE_KEY(Decoding)>
# 키는 커밋하지 않음(인자로 전달). 산출물 tour.js는 공개 관광정보라 커밋 OK.
import sys, io, json, math, requests

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = sys.argv[1]
BASE = 'https://apis.data.go.kr/B551011/KorService2/'
HDR = {'User-Agent': 'Mozilla/5.0'}
AREA, SIGUNGU = 32, 2          # 강원특별자치도 / 고성군
MANGROVE = (38.2872314, 128.5479364)

def dist_km(lat, lng):
    R = 6371.0
    dlat = math.radians(lat - MANGROVE[0]); dlng = math.radians(lng - MANGROVE[1])
    a = math.sin(dlat/2)**2 + math.cos(math.radians(MANGROVE[0]))*math.cos(math.radians(lat))*math.sin(dlng/2)**2
    return round(R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a)), 1)

def call(extra):
    p = {'serviceKey': KEY, 'numOfRows': 100, 'pageNo': 1, 'MobileOS': 'ETC',
         'MobileApp': 'gstrip', '_type': 'json', 'arrange': 'O',
         'areaCode': AREA, 'sigunguCode': SIGUNGU}
    p.update(extra)
    r = requests.get(BASE + 'areaBasedList2', params=p, headers=HDR, timeout=30)
    items = r.json()['response']['body'].get('items')
    return items.get('item', []) if items and items != '' else []

def shape(items):
    out = []
    for it in items:
        try:
            lat, lng = float(it.get('mapy')), float(it.get('mapx'))
        except (TypeError, ValueError):
            lat = lng = None
        img = it.get('firstimage') or it.get('firstimage2') or ''
        if img.startswith('http://'):
            img = 'https://' + img[7:]   # 혼합콘텐츠 방지
        name = it.get('title', '').strip()
        out.append({
            'n': name,
            'addr': (it.get('addr1') or '').strip(),
            'd': dist_km(lat, lng) if lat else None,
            'img': img,
            'tel': (it.get('tel') or '').strip(),
            'u': 'https://map.naver.com/p/search/' + requests.utils.quote(name),
        })
    # 거리순 (가까운 곳 먼저), 좌표 없으면 뒤로
    out.sort(key=lambda x: (x['d'] is None, x['d'] if x['d'] is not None else 9e9))
    return out

activities = shape(call({'contentTypeId': 28}))                                   # 레포츠
beaches = shape(call({'contentTypeId': 12, 'cat1': 'A01', 'cat2': 'A0101', 'cat3': 'A01011200'}))  # 해수욕장

tour = {'activities': activities, 'beaches': beaches}
json.dump(tour, open('data/tour.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
with open('tour.js', 'w', encoding='utf-8') as f:
    f.write('// 자동 생성: 한국관광공사 TourAPI (강원 고성) — 레포츠/해수욕장\n')
    f.write('// 재생성: python data/fetch_tour.py <KEY>\n')
    f.write('const TOUR = ' + json.dumps(tour, ensure_ascii=False) + ';\n')

print(f'액티비티 {len(activities)}곳, 해수욕장 {len(beaches)}곳 → tour.js')
print('샘플 액티비티:', [a['n'] for a in activities[:5]])
print('샘플 해수욕장:', [b['n'] for b in beaches[:5]])
