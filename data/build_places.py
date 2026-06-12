# places_tagged.json + hours.json → places.js 재생성
# 실행: python data/build_places.py  (프로젝트 루트 기준)
import json, io, sys
from collections import Counter

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DAYS = ['월', '화', '수', '목', '금', '토', '일']

places = json.load(open('data/places_tagged.json', encoding='utf-8'))
hours = json.load(open('data/hours.json', encoding='utf-8'))
try:
    overrides = json.load(open('data/overrides.json', encoding='utf-8'))
except FileNotFoundError:
    overrides = {}
overrides.pop('_설명', None)

try:
    extras = json.load(open('data/extras.json', encoding='utf-8'))
except FileNotFoundError:
    extras = {}

try:
    rstats = json.load(open('data/reviews_stats.json', encoding='utf-8'))
except FileNotFoundError:
    rstats = {}

def norm_hours(raw):
    """수집 원본 → {요일: 'HH:MM-HH:MM' | None(휴무)}. 정보 없으면 None 반환."""
    days_raw = (raw or {}).get('days') or {}
    if not days_raw:
        return None
    out = {}
    # '매일' 항목이 있으면 7일 전체에 깔기
    if '매일' in days_raw:
        d = days_raw['매일']
        if d.get('start') and d.get('end'):
            for day in DAYS:
                out[day] = f"{d['start']}-{d['end']}"
    for day, d in days_raw.items():
        if day not in DAYS:
            continue
        desc = (d.get('desc') or '')
        if d.get('start') and d.get('end'):
            out[day] = f"{d['start']}-{d['end']}"
        elif '휴무' in desc or '휴업' in desc:
            out[day] = None
        # start/end 없고 휴무 표기도 없으면 미기재 → 키 자체를 생략 (앱에서 '확인 필요')
    return out or None

slim = []
stat = Counter()
for x in places:
    h = norm_hours(hours.get(str(x['sid'])))
    stat['영업시간 있음' if h else '정보 없음'] += 1
    item = {
        'n': x['name'], 't': x['type'], 'c': x['category'],
        'f': x['food'], 'v': x['vibe'], 'z': x['zone'][:2],
        'd': x['dist_km'], 'a': x['address'], 'u': x['naver'], 'img': x['thumb'],
    }
    if h:
        item['h'] = h

    # 자동 신호 (네이버 플레이스): 예약제·평점·리뷰수·한줄소개·네이버예약
    ex = extras.get(str(x['sid'])) or {}
    if ex.get('reserve_auto'):
        item['r'] = 1
        stat['예약제(자동감지)'] += 1
    if ex.get('score') and ex.get('reviews'):
        item['rv'] = [ex['score'], ex['reviews']]
    if ex.get('micro'):
        item['mr'] = ex['micro']
    if ex.get('booking'):
        item['bk'] = ex['booking']

    # 웨이팅 신호: 최근 리뷰 10개의 대기 언급 수 + 네이버 줄서기 도입 여부
    rs = rstats.get(str(x['sid'])) or {}
    if rs.get('lineup') or rs.get('wait', 0) >= 3:
        item['w'] = 2  # 웨이팅 잦음
        if rs.get('lineup'):
            item['lu'] = 1
        stat['웨이팅 잦음'] += 1
    elif rs.get('wait', 0) >= 1:
        item['w'] = 1  # 피크타임 대기 가능
        stat['대기 가능성'] += 1
    elif rs.get('sample', 0) >= 8 and ex.get('reviews', 0) >= 50:
        item['w'] = 0  # 워크인 무난 (리뷰 충분 + 최근 대기 언급 없음)
        stat['워크인 무난'] += 1

    # 수동 피드백(overrides)은 자동 신호보다 우선
    ov = overrides.get(x['name'])
    if ov:
        if ov.get('exclude'):
            stat['제외(피드백)'] += 1
            continue
        if ov.get('reserve'):
            item['r'] = 1
        if ov.get('note'):
            item['note'] = ov['note']
    slim.append(item)

# 오타 방지: 매칭 안 된 피드백 이름 경고
names = {x['name'] for x in places}
for k in overrides:
    if k not in names:
        print(f'⚠️ overrides.json의 "{k}" 가 장소 목록에 없음 (이름 확인 필요)')

with open('places.js', 'w', encoding='utf-8') as f:
    f.write('// 자동 생성: 네이버 저장 리스트 기반 (속초·고성 한정) + 영업시간.\n')
    f.write('// 재생성: python data/build_places.py\n')
    f.write('const PLACES = ' + json.dumps(slim, ensure_ascii=False) + ';\n')

print('places.js 재생성:', len(slim), '곳 |', dict(stat))
# 검증 샘플: 점심(12시)에 못 가는 저녁 전용 가게 몇 곳 출력
def open_at(h, day, t):
    if not h or day not in h: return None
    if h[day] is None: return False
    s, e = h[day].split('-')
    sm = int(s[:2])*60+int(s[3:]); em = int(e[:2])*60+int(e[3:])
    if em <= sm: em += 1440
    return sm <= t <= em - 30

evening_only = [x for x in slim if x.get('h') and x['t'] == '식사'
                and open_at(x['h'], '금', 720) is False and open_at(x['h'], '금', 1110) is True]
print('금요일 점심 불가·저녁 가능(식사):', [x['n'] for x in evening_only][:8])
