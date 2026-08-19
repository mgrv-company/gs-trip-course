# 매일 카톡용 "오늘의 추천" 1곳 자동 선정 + 본인 Slack DM 발송.
# home.js의 scoreNow()/weightedSample()/moveText()/hoursNowText() 로직을 그대로 이식했다.
# 실행 위치: gs-trip-course 저장소 루트 (상대경로 'places.js', 'data/.refresh_config.json' 기준)
# 사용법: python data/daily_pick.py            (실제 선정+발송+기록)
#         python data/daily_pick.py --preview  (발송·기록 없이 오늘 선정 결과만 출력)

import sys, io, os, re, json, math, random
from datetime import datetime, timedelta

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토']  # Python %w: 0=일요일 ~ 6=토요일 (JS getDay()와 동일)
TARGET_TYPES = {'식사', '카페', '술집'}
DEDUP_DAYS = 45
MIN_POOL_AFTER_DEDUP = 5

SUMMER_KEYWORDS = ['냉면', '물회', '빙수', '콩국수', '아이스']
WINTER_KEYWORDS = ['국밥', '찌개', '전골', '어묵', '라면', '만두', '닭곰탕', '뼈해장국', '감자탕']

WORKER_BASE = 'https://gs-trip-admin.mangrove-goseong.workers.dev'
# 어드민 '문구·디자인' 탭 dailypick.template 기본값과 반드시 일치시킬 것 (admin.js COPY_GROUPS)
DEFAULT_TEMPLATE = ('🍜 오늘의 고성 근처 추천\n\n{name} ({category})\n📍 {zone} · 맹그로브에서 {move}\n'
                     '🕐 {hours}\n💬 {blurb}\n🍽 대표메뉴: {menu}\n⭐ {rating}\n🔗 {url}')
# 이 안에 있는 자리표시자만 있는 줄인데 값이 비어 있으면, 그 줄 자체를 메시지에서 뺀다
OPTIONAL_TEMPLATE_KEYS = {'blurb', 'rating'}

try:
    cfg = json.load(open('data/.refresh_config.json', encoding='utf-8'))
except FileNotFoundError:
    cfg = {}

HISTORY_PATH = 'data/.daily_pick_history.json'


def load_places():
    text = open('places.js', encoding='utf-8').read()
    m = re.search(r'const PLACES = (\[.*\]);', text, re.S)
    if not m:
        raise RuntimeError('places.js에서 PLACES 배열을 찾지 못함')
    return json.loads(m.group(1))


def load_history():
    try:
        return json.load(open(HISTORY_PATH, encoding='utf-8'))
    except FileNotFoundError:
        return {}


def save_history(history):
    json.dump(history, open(HISTORY_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


def zone_rank(z):
    return 1.5 if z == '도보' else 0


def base_score(p, rng):
    s = rng.uniform(0, 2.5)
    s += zone_rank(p.get('z')) * 0.7
    if p.get('ca'):
        s += 1.8
    rv = p.get('rv')
    if rv:
        r, c = rv[0], rv[1]
        s += max(-1, min(1.4, (r - 4.2) * 2))
        s += min(1.2, math.log10(c + 1) * 0.5)
    return s


def season_bonus(p, month):
    combined = (p.get('c') or '') + ' ' + ' '.join(p.get('m') or [])
    if month in (6, 7, 8) and any(k in combined for k in SUMMER_KEYWORDS):
        return 2.5
    if month in (12, 1, 2) and any(k in combined for k in WINTER_KEYWORDS):
        return 2.5
    return 0


def weekday_bonus(p, day_idx):
    is_weekend = day_idx in (0, 6)
    t = p.get('t')
    if is_weekend and t == '술집':
        return 1.0
    if not is_weekend and t == '식사':
        return 1.0
    return 0


def today_hours_status(p, day_name):
    h = p.get('h')
    if not h or day_name not in h:
        return 'unknown'
    return 'closed' if h[day_name] is None else 'open'


def weighted_pick(ranked, rng):
    n = len(ranked)
    weights = [n - i for i in range(n)]
    total = sum(weights)
    roll = rng.uniform(0, total)
    idx = 0
    for i, w in enumerate(weights):
        roll -= w
        if roll <= 0:
            idx = i
            break
    return ranked[idx]


def move_text(p):
    d = p.get('d') or 0
    walk = max(3, round(d * 15))
    if d <= 1.2:
        return f'🚶 {walk}분'
    car = round(d / 50 * 60) + 3
    if walk <= 30:
        return f'🚗 {car}분 · 🚶 {walk}분'
    return f'🚗 {car}분'


def hours_text(p, day_name):
    h = p.get('h')
    if not h:
        return '영업시간 미상 · 방문 전 확인'
    if day_name not in h:
        return '오늘 영업시간 미정 · 방문 전 확인'
    val = h[day_name]
    if val is None:
        return '오늘 휴무 ⚠️'
    return '오늘 ' + val.replace('-', '~')


def fetch_template():
    # 어드민 '문구·디자인' 탭에서 편집한 틀(dailypick.template)을 가져온다. 실패하면 기본 틀로 폴백.
    try:
        import requests
        r = requests.get(f'{WORKER_BASE}/public/settings', timeout=8)
        if r.status_code == 200:
            tpl = (r.json().get('copy') or {}).get('dailypick.template')
            if tpl:
                return tpl
    except Exception:
        pass
    return DEFAULT_TEMPLATE


def render_message(p, day_name, template):
    rv = p.get('rv')
    menu = p.get('m') or []
    fields = {
        'name': p.get('n') or '',
        'category': p.get('c') or p.get('t') or '',
        'zone': p.get('z') or '',
        'move': move_text(p),
        'hours': hours_text(p, day_name),
        'blurb': p.get('note') or p.get('mr') or '',
        'menu': ', '.join(menu[:2]) if menu else '메뉴 정보 없음',
        'rating': f"{rv[0]}점 ({rv[1]}명)" if rv else '',
        'url': p.get('u') or '',
    }
    out_lines = []
    for line in template.split('\n'):
        keys_in_line = set(re.findall(r'\{(\w+)\}', line))
        # 이 줄이 온전히 '값이 비어있는 선택 필드'로만 이뤄져 있으면 줄 자체를 생략
        if keys_in_line and keys_in_line <= OPTIONAL_TEMPLATE_KEYS and all(not fields.get(k) for k in keys_in_line):
            continue
        try:
            out_lines.append(line.format(**fields))
        except (KeyError, IndexError):
            out_lines.append(line)  # 잘못된 자리표시자가 있어도 메시지가 깨지지 않게 그대로 둠
    return '\n'.join(out_lines)


def pick_today(rng=None):
    rng = rng or random.Random()
    now = datetime.now()
    day_idx = int(now.strftime('%w'))
    day_name = DAY_NAMES[day_idx]
    month = now.month

    places = load_places()
    filtered = [p for p in places if not p.get('x') and p.get('t') in TARGET_TYPES]

    scored = []
    for p in filtered:
        status = today_hours_status(p, day_name)
        if status == 'closed':
            continue
        s = base_score(p, rng) + season_bonus(p, month) + weekday_bonus(p, day_idx)
        if status == 'unknown':
            s -= 1.0
        scored.append((s, p))

    history = load_history()
    cutoff = now - timedelta(days=DEDUP_DAYS)
    recent_sids = {sid for sid, d in history.items() if datetime.strptime(d, '%Y-%m-%d') >= cutoff}
    deduped = [(s, p) for s, p in scored if p.get('s') not in recent_sids]

    pool = deduped if len(deduped) >= MIN_POOL_AFTER_DEDUP else scored
    if not pool:
        raise RuntimeError('추천 가능한 후보가 없음 (필터 결과 0곳)')

    ranked = sorted(pool, key=lambda x: -x[0])[:10]
    _, chosen = weighted_pick(ranked, rng)

    template = fetch_template()
    msg = render_message(chosen, day_name, template)
    return chosen, msg, history


def notify_fallback(text):
    hook = cfg.get('slack_webhook')
    if not hook:
        return
    try:
        import requests
        requests.post(hook, json={'text': text}, timeout=15)
    except Exception as e:
        print('실패 알림 전송도 실패:', e)


def send(msg):
    hook = cfg.get('daily_pick_webhook')
    if not hook:
        print('⚠️ daily_pick_webhook 미설정 → 발송 생략 (data/.refresh_config.json에 키 추가 필요)')
        return False
    try:
        import requests
        r = requests.post(hook, json={'text': msg}, timeout=15)
        if r.status_code == 200:
            print('DM 발송됨')
            return True
        print(f'DM 발송 실패: {r.status_code}')
        notify_fallback(f'⚠️ 고성 트립코스 매일추천 발송 실패 (status={r.status_code})\n\n{msg}')
        return False
    except Exception as e:
        print('DM 발송 실패:', e)
        notify_fallback(f'⚠️ 고성 트립코스 매일추천 발송 실패: {e}\n\n{msg}')
        return False


if __name__ == '__main__':
    preview = '--preview' in sys.argv
    chosen, msg, history = pick_today()
    print(msg)
    if preview:
        sys.exit(0)
    if send(msg):
        history[chosen['s']] = datetime.now().strftime('%Y-%m-%d')
        save_history(history)
    else:
        sys.exit(1)  # 재시도(.sh)가 done-marker 없이 11:10에 다시 시도하도록
