# places_region_new.json 의 신규 가게(기존 places_tagged.json 에 없는 sid)를 태깅해 추가.
# 종류=리스트, 분위기=무난(기본), 식성=[](식사는 빌드 때 메뉴로 자동 분류), 구역/거리=좌표로 계산.
# 실행: python data/tag_new.py
import json, io, sys, math

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

MANGROVE = (38.2872314, 128.5479364)

def haversine(lat, lng):
    R = 6371.0
    dlat = math.radians(lat - MANGROVE[0]); dlng = math.radians(lng - MANGROVE[1])
    a = math.sin(dlat/2)**2 + math.cos(math.radians(MANGROVE[0]))*math.cos(math.radians(lat))*math.sin(dlng/2)**2
    return round(R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a)), 2)

def zone_of(dist):
    if dist < 1.3:  return '도보권'
    if dist < 9.0:  return '고성권(차 10~15분)'
    return '속초권(차 20~35분)'

CATEGORY = {'식사': '음식점', '카페': '카페', '술집': '술집'}

region = json.load(open('data/places_region_new.json', encoding='utf-8'))
tagged = json.load(open('data/places_tagged.json', encoding='utf-8'))
existing = {str(x['sid']) for x in tagged}

added = []
for x in region:
    sid = str(x['sid'])
    if sid in existing:
        continue
    lat, lng = x.get('lat'), x.get('lng')
    if lat is None or lng is None:
        print('⚠️ 좌표 없음, 건너뜀:', x['name']); continue
    dist = haversine(lat, lng)
    entry = {
        'name': x['name'], 'type': x['list'], 'list': x['list'],
        'category': CATEGORY.get(x['list'], x.get('category') or '음식점'),
        'food': [], 'vibe': ['무난'],
        'zone': zone_of(dist), 'dist_km': dist,
        'address': x.get('address', ''), 'lat': lat, 'lng': lng,
        'sid': sid,
        'thumb': '',  # 사진은 fetch_photos 가 보충
        'naver': f'https://map.naver.com/p/entry/place/{sid}',
        'guessed': False,
    }
    tagged.append(entry); added.append(entry); existing.add(sid)

json.dump(tagged, open('data/places_tagged.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'추가됨 {len(added)}곳 → places_tagged.json 총 {len(tagged)}곳')
for a in added:
    print(f"   [{a['type']}] {a['name']} · {a['zone']} · {a['dist_km']}km")
