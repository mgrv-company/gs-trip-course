# places_tagged.json + hours.json → places.js 재생성
# 실행: python data/build_places.py  (프로젝트 루트 기준)
import json, io, re, sys
from collections import Counter

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DAYS = ['월', '화', '수', '목', '금', '토', '일']

places = json.load(open('data/places_tagged.json', encoding='utf-8'))

# 어드민에서 직접 추가한 가게 — 네이버 자동수집 목록 뒤에 병합.
# 별도 파일이라 주기 갱신(places_tagged.json 재생성)에도 지워지지 않음.
try:
    manual = json.load(open('data/manual_places.json', encoding='utf-8'))
except FileNotFoundError:
    manual = []
if isinstance(manual, list):
    existing_sids = {x.get('sid') for x in places}
    for m in manual:
        if m.get('sid') and m['sid'] not in existing_sids:
            # build 로직이 참조하는 키들이 없으면 안전한 기본값으로 채움
            m.setdefault('food', []); m.setdefault('vibe', [])
            m.setdefault('thumb', ''); m.setdefault('address', '')
            m.setdefault('naver', ''); m.setdefault('zone', '')
            m.setdefault('dist_km', 0); m.setdefault('category', m.get('type', ''))
            places.append(m)
            existing_sids.add(m['sid'])

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

try:
    menus = json.load(open('data/menus.json', encoding='utf-8'))
except FileNotFoundError:
    menus = {}

try:
    photos = json.load(open('data/photos.json', encoding='utf-8'))
except FileNotFoundError:
    photos = {}

# 메뉴 이름으로 음식 종류 추론 ("음식점"으로만 분류된 가게용)
CUISINE_RULES = [
    ('분식', r'떡볶이|떡볶기|라볶이|김밥|순대|어묵|오뎅|쫄면|튀김만두|분식'),
    ('일식', r'초밥|스시|사시미|오마카세|우동|돈가스|돈까스|라멘|텐동|소바|규동|가츠|카츠'),
    ('베트남 음식', r'쌀국수|분짜|반미|월남쌈'),
    ('태국 음식', r'팟타이|똠얌|푸팟퐁'),
    ('중식', r'짜장|짬뽕|탕수육|마라|양장피|군만두'),
    ('양식', r'파스타|피자|스테이크|버거|리조또|브런치|오믈렛'),
    ('해산물', r'물회|모둠회|회덮밥|대게|킹크랩|조개|가리비|생선구이|생선조림|곰치|도치|섭국|성게|멍게|해물|아구|장어|문어|오징어|새우|전복|회\b'),
    ('고기 요리', r'갈비|삼겹|한우|불고기|닭갈비|목살|껍데기|곱창|대창|수육'),
    ('한식', r'국밥|순대|백반|정식|찌개|전골|감자탕|옹심이|막국수|냉면|칼국수|만두|비빔밥|두부|보쌈|족발|닭볶음탕|제육|동태'),
]
CUISINE_TO_FOOD = {'분식': ['분식'], '일식': ['일식'], '베트남 음식': ['아시안'], '태국 음식': ['아시안'], '중식': ['아시안'],
                   '양식': ['양식'], '해산물': ['해산물'], '고기 요리': ['고기'], '한식': ['한식']}

# 즐길 곳(명소) 자연명소 여부 — 2026-07-16 최초 수집 57곳은 사람이 직접 분류(정확), 이후 신규 추가되는
# 곳은 이름 키워드로 자동 추정(대략치, 어드민에서 sid별로 덮어쓸 수 있음 → overrides의 natural 필드가 최우선)
NATURAL_SIDS = {
    '15150899', '32323711', '15152149', '1079776622', '1145784497', '15149516', '13491847',
    '15150294', '15152219', '1191674307', '13491910', '32637628', '1752191241', '21576070',
    '15087440', '32323680', '20758200', '528686921', '13490953', '13490979', '1178398796',
    '1968566480', '1607084028', '12283047', '13491004', '4345129037', '15147369', '36039905',
    '1090525328', '31482287', '13491281', '1714349376',
}
NATURAL_KEYWORDS = re.compile(r'산림욕장|휴양림|둘레길|국립공원|자연|계곡|호수|폭포|해변|약수|자생식물원')
NONNATURAL_KEYWORDS = re.compile(r'서점|책방|미술관|박물관|영화관|사찰|별장|출렁다리|등대|유적|휴게소|마을|전망대|전망타워|사$|정$')

def classify_natural(sid, name):
    if sid in NATURAL_SIDS:
        return True
    if NONNATURAL_KEYWORDS.search(name):
        return False
    if NATURAL_KEYWORDS.search(name):
        return True
    return False  # 애매하면 '그 외'로 — 어드민에서 확인 후 자연명소로 올리는 게 반대보다 안전

def infer_cuisine(menu_items):
    text = ' '.join(mi['name'] for mi in menu_items)
    best, best_n = None, 0
    for label, pat in CUISINE_RULES:
        n = len(re.findall(pat, text))
        if n > best_n:
            best, best_n = label, n
    return best

def fmt_price(p):
    s = str(p or '')
    m = re.search(r'\d[\d,]*', s)          # 첫 숫자 묶음만 (범위·시가 등 방어)
    if not m:
        return ''
    digits = re.sub(r'[^0-9]', '', m.group())
    if not digits:
        return ''
    n = int(digits)
    if n >= 1000000:                       # 메뉴 1개가 100만원↑ → 깨진 데이터로 보고 가격 생략
        return ''
    out = f'{n:,}원'
    if '~' in s or '-' in s:               # 원본이 범위면 ~ 표시
        out += '~'
    return out

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
        else:
            # 네이버가 그 요일 항목 자체는 내려줬는데 시작/끝 시간이 없다면, "정기휴무" 문구가
            # 안 붙어있어도 사실상 그 요일엔 안 여는 것으로 처리 (미상 취급하면 휴무인 가게가
            # "영업시간 미정"으로 그대로 추천되는 문제가 있었음 — 2026-07-22)
            out[day] = None
    return out or None

# 어드민 백엔드(D1) export 형식은 각 항목에 sid가 실려 있음 → sid 우선 대조 (가게 이름이 바뀌어도 편집 유지)
ov_by_sid = {str(v['sid']): v for v in overrides.values() if isinstance(v, dict) and v.get('sid')}

slim = []
stat = Counter()
for x in places:
    h = norm_hours(hours.get(str(x['sid'])))
    stat['영업시간 있음' if h else '정보 없음'] += 1
    item = {
        'n': x['name'], 't': x['type'], 'c': x['category'],
        'f': x['food'], 'v': x['vibe'], 'z': x['zone'][:2],
        'd': x['dist_km'], 'a': x['address'], 'u': x['naver'], 'img': x['thumb'],
        's': str(x['sid']),   # 홈이 백엔드 최신 편집을 얹을 때 대조용
        'lat': x.get('lat'), 'lng': x.get('lng'),   # 지도 표시용(해수욕장 등)
    }
    if h:
        item['h'] = h

    # 즐길 곳(명소) 자연명소 여부 — 어드민 overrides의 natural 필드가 최우선(아래에서 덮어씀)
    if x['type'] == '명소':
        item['nat'] = 1 if classify_natural(str(x['sid']), x['name']) else 0

    # 리스트 API에 썸네일이 없던 가게는 플레이스 홈 대표 사진으로 보충
    if not item['img'] and photos.get(str(x['sid'])):
        item['img'] = photos[str(x['sid'])]
        stat['사진 보충'] += 1

    # 자동 신호 (네이버 플레이스): 예약제·평점·리뷰수·한줄소개·네이버예약
    ex = extras.get(str(x['sid'])) or {}
    if ex.get('reserve_auto'):
        item['r'] = 1
        item['ra'] = 1   # 자동감지 표시 — 홈 오버레이가 수동 예약 해제와 구분하기 위함
        stat['예약제(자동감지)'] += 1
    if ex.get('score') and ex.get('reviews'):
        item['rv'] = [ex['score'], ex['reviews']]
    if ex.get('micro'):
        item['mr'] = ex['micro']
    if ex.get('booking'):
        item['bk'] = ex['booking']

    # 대표 메뉴 (추천 우선 최대 2개) + 음식 종류 보정
    mlist = menus.get(str(x['sid'])) or []
    if mlist:
        item['m'] = [f"{mi['name']}{(' ' + fmt_price(mi['price'])) if fmt_price(mi['price']) else ''}" for mi in mlist[:2]]
    if item['c'] == '음식점':
        cuisine = infer_cuisine(mlist) if mlist else None
        if cuisine:
            item['c'] = cuisine
            item['f'] = CUISINE_TO_FOOD[cuisine]
            stat['종류 보정(메뉴 기반)'] += 1
        elif item['f']:
            item['c'] = item['f'][0]  # 메뉴 정보 없으면 식성 태그로라도 표기
            stat['종류 보정(태그 기반)'] += 1

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

    # 수동 피드백(overrides)은 자동 신호보다 우선 — sid 우선, 없으면 이름(구형식 호환)
    ov = ov_by_sid.get(str(x['sid'])) or overrides.get(x['name'])
    if ov:
        if ov.get('exclude'):
            # 버리지 않고 x=1로 표시만 차단 — 어드민에서 복구하면 (재빌드 없이) 즉시 다시 보이게
            item['x'] = 1
            stat['제외(피드백)'] += 1
        if ov.get('reserve'):
            item['r'] = 1
        if ov.get('note'):
            item['note'] = ov['note']
        if ov.get('pick'):
            item['ca'] = 1  # CA 강력 추천
            stat['CA 강추'] += 1
        if ov.get('takeout'):
            item['to'] = 1  # 포장·배달 전용 → "지금 갈만한 곳"에서 빼고 포장·배달 섹션으로
            stat['포장·배달'] += 1
        if ov.get('notion'):
            item['nt'] = 1  # 노션 가이드 수록 → 강추 코스 조합 풀
            stat['노션 수록'] += 1
        if ov.get('natural') is not None:
            item['nat'] = 1 if ov['natural'] else 0  # 어드민이 자연명소 분류를 직접 수정한 경우 최우선
            stat['자연명소 수동수정'] += 1
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
