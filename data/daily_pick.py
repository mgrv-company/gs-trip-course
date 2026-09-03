# 매일 카톡용 "오늘의 추천" 1곳 자동 선정 + 카드 이미지 렌더 + 본인 Slack DM 발송(텍스트+이미지).
# home.js의 scoreNow()/weightedSample()/moveText()/hoursNowText() 로직을 그대로 이식했다.
# 실행 위치: gs-trip-course 저장소 루트 (상대경로 'places.js', 'data/.refresh_config.json' 기준)
# 사용법: python data/daily_pick.py            (실제 선정+카드렌더+git커밋·푸시+발송+기록)
#         python data/daily_pick.py --preview  (카드는 로컬에 렌더하되 커밋·푸시·발송·기록은 생략)
#
# 카드 렌더는 automation/daily-card/render.mjs(Playwright, Node) 호출 — 최초 1회
# `cd automation/daily-card && npm install` 필요 (README 참고).

import sys, io, os, re, json, math, random, subprocess, tempfile, shutil
from datetime import datetime, timedelta

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토']  # Python %w: 0=일요일 ~ 6=토요일 (JS getDay()와 동일)
TARGET_TYPES = {'식사', '카페', '술집'}
DEDUP_DAYS = 45
MIN_POOL_AFTER_DEDUP = 5

SUMMER_KEYWORDS = ['냉면', '물회', '빙수', '콩국수', '아이스']
WINTER_KEYWORDS = ['국밥', '찌개', '전골', '어묵', '라면', '만두', '닭곰탕', '뼈해장국', '감자탕']

WORKER_BASE = 'https://gs-trip-admin.mangrove-goseong.workers.dev'
PAGES_BASE = 'https://mgrv-company.github.io/gs-trip-course'
CARD_RENDERER = os.path.join('automation', 'daily-card', 'render.mjs')
CARD_DIR = os.path.join('output', 'daily-card')
CARD_PREVIEW_PATH = os.path.join(CARD_DIR, 'preview.png')
# 공개 저장소엔 최근 것만 두고, 지난 카드는 로컬(이 컴퓨터)에만 보관 — 저장소가 무한히 커지지 않게
CARD_ARCHIVE_DIR = os.path.join(CARD_DIR, 'archive')
CARD_KEEP_DAYS = 7
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
PLAN_PATH = 'data/.daily_pick_plan.json'
REVIEWS_PATH = 'data/reviews_stats.json'
REVIEW_SENTENCE_SPLIT = re.compile(r'[\n.!?~]+')
REVIEW_SHORT_LEN = (8, 22)   # 키워드형 — 짧고 강점 위주
REVIEW_LONG_LEN = (28, 60)   # 서술형 — 방문 경험을 풀어쓴 문장
# 부정적인 문장이 홍보 문구처럼 인용되는 걸 막는다(2026-09-03: "별루임" 리뷰가 그대로 뽑힌 사고 계기).
# 부정어 차단만으로는 "소통이 잘 안되는 느낌입니다"처럼 특정 단어 없이도 비판적인 문장을 못 걸러서
# (같은 날 재발), 부정어 블록리스트 + 긍정 신호 허용리스트(둘 다 통과해야 채택)로 강화했다.
REVIEW_NEGATIVE_PAT = re.compile(
    r'별루|별로|아쉽|실망|비추|최악|후회|맛없|불친절|재방문\s*안|다신\s*안|두\s*번\s*다시|'
    r'돈\s*아깝|시간\s*아깝|그닥|글쎄|보통이|평범하|그냥\s*그런|기대\s*이하|'
    r'안\s*되는|안\s*돼|불편|부족한|소통이\s*안|않(?:았|아요|네요)'
)
REVIEW_POSITIVE_PAT = re.compile(
    r'맛있|맛나|최고|추천|만족|친절|신선|푸짐|재방문|또\s*올|또\s*가|또\s*방문|좋았|좋아요|좋은|'
    r'훌륭|정성|가성비|깔끔|분위기\s*좋|맛집|대박|엄지척|감동|든든|짱|굿'
)


def load_places():
    text = open('places.js', encoding='utf-8').read()
    m = re.search(r'const PLACES = (\[.*\]);', text, re.S)
    if not m:
        raise RuntimeError('places.js에서 PLACES 배열을 찾지 못함')
    return json.loads(m.group(1))


def load_reviews_stats():
    try:
        return json.load(open(REVIEWS_PATH, encoding='utf-8'))
    except FileNotFoundError:
        return {}


def pick_review_quotes(p, reviews_stats):
    # fetch_reviews.py가 모아둔 리뷰 본문(최대 8개)에서 문장 단위로 쪼갠 뒤, 짧은
    # 키워드형 하나 + 긴 서술형 하나를 뽑는다(2026-09-02: "2가지 스타일 다 보여줘" 요청).
    stats = reviews_stats.get(str(p.get('s')), {})
    bodies = stats.get('bodies') or []
    frags = []
    for b in bodies:
        for part in REVIEW_SENTENCE_SPLIT.split(b):
            part = part.strip()
            if part and REVIEW_POSITIVE_PAT.search(part) and not REVIEW_NEGATIVE_PAT.search(part):
                frags.append(part)
    short = [f for f in frags if REVIEW_SHORT_LEN[0] <= len(f) <= REVIEW_SHORT_LEN[1]]
    long_ = [f for f in frags if REVIEW_LONG_LEN[0] <= len(f) <= REVIEW_LONG_LEN[1]]
    q_short = random.choice(short) if short else None
    q_long = random.choice(long_) if long_ else None
    return q_short, q_long


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


def open_at_time(p, day_name, target_hhmm):
    # 점심/저녁 슬롯 발송용 — "오늘 언젠가 영업"이 아니라 target_hhmm 그 시각에 실제로 열려있는지
    # 확인한다. 마감 30분 전은 방문客 입장에서 사실상 닫힌 것과 같아 제외한다(홈페이지 openNow()의
    # 마감 임박 배제 로직과 같은 취지). 반환값: True=열림 / False=닫힘·마감임박 / None=시간 정보 없음
    h = p.get('h')
    if not h or day_name not in h:
        return None
    val = h[day_name]
    if val is None:
        return False
    def to_min(t):
        hh, mm = t.split(':')
        return int(hh) * 60 + int(mm)
    start_s, end_s = val.split('-')
    target, start, end = to_min(target_hhmm), to_min(start_s), to_min(end_s)
    if end <= start:
        end += 1440  # 자정 넘어가는 영업시간(예: 18:00-02:00)
    if start <= target <= end - 30:
        return True
    if target + 1440 >= start and target + 1440 <= end - 30:
        return True
    return False


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


def move_parts(p):
    # 카드 문장("맹그로브 고성에서 {모드}로 {분}분 걸려요")용 — 대표 이동수단 하나만 뽑는다.
    # 도보 범위를 넘지만 차 타기엔 애매한 거리는 자전거로(시속 15km 가정, ~14분 이내).
    d = p.get('d') or 0
    if d <= 1.2:
        return '도보', max(3, round(d * 15))
    if d <= 3.5:
        return '자전거', max(5, round(d / 15 * 60))
    return '차로', round(d / 50 * 60) + 3


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


def build_card_data(p, day_name, now):
    # automation/daily-card/template.html의 renderCard()가 받는 필드 형태.
    # 카드가 태그·배지 나열 대신 문장체로 바뀌어서(2026-09-02), 각 정보를 문장으로
    # 조립하기 좋은 원자 단위(모드/분, 시작~종료 시각 등)로 넘긴다.
    rv = p.get('rv')
    menu = p.get('m') or []
    h = p.get('h') or {}
    today_hours = h.get(day_name) if day_name in h else None  # None=휴무, 미포함 키=미상
    move_mode, move_min = move_parts(p)
    hours_start = hours_end = None
    if today_hours:
        parts = today_hours.split('-')
        if len(parts) == 2:
            hours_start, hours_end = parts[0], parts[1]
    review_short, review_long = pick_review_quotes(p, load_reviews_stats())
    return {
        'name': p.get('n') or '',
        'category': p.get('c') or p.get('t') or '',
        'moveMode': move_mode,
        'moveMin': move_min,
        'hoursStart': hours_start,
        'hoursEnd': hours_end,
        'hoursClosed': day_name in h and h[day_name] is None,
        'ratingScore': rv[0] if rv else None,
        'ratingCount': rv[1] if rv else None,
        'menu': ', '.join(menu[:2]) if menu else '',
        'blurb': p.get('note') or p.get('mr') or '',
        'reviewShort': review_short,
        'reviewLong': review_long,
        'img': p.get('img') or '',
        'date': f"{now.year % 100:02d}/{now.month:02d}/{now.day:02d} ({day_name})",
    }


def render_card(data, out_path):
    # Node/Playwright 렌더러 호출. 실패해도 daily_pick 자체는 텍스트만으로 계속 진행할 수 있게 예외를 밖으로 던지지 않는다.
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
        data_path = f.name
    try:
        r = subprocess.run(['node', CARD_RENDERER, data_path, out_path],
                            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
        if r.returncode != 0:
            print('⚠️ 카드 렌더 실패:', r.stderr.strip()[-800:])
            return False
        print(r.stdout.strip())
        return True
    except Exception as e:
        print('⚠️ 카드 렌더 실패:', e)
        return False
    finally:
        try: os.remove(data_path)
        except OSError: pass


def git_commit_push(path, message):
    run = lambda args, **kw: subprocess.run(args, capture_output=True, text=True, encoding='utf-8', errors='replace', **kw)
    try:
        run(['git', 'add', path], check=True)
        diff = run(['git', 'diff', '--cached', '--quiet'])  # path 한정 아님 — prune_old_cards()가 미리 스테이징한 삭제도 함께 잡아야 함
        if diff.returncode == 0:
            print('커밋할 변경 없음 — 커밋 생략')
            return True
        run(['git', 'commit', '-m', message], check=True)
        run(['git', 'push'], check=True)
        return True
    except subprocess.CalledProcessError as e:
        print('⚠️ git 커밋/푸시 실패:', (e.stderr or str(e))[-800:])
        return False


def archive_card_locally(card_path, date_str):
    # 깃에서 지우기 전에(또는 그냥 매번) 이 컴퓨터에 원본을 남겨둔다 — 공개 저장소 크기와 무관하게 전부 보관
    os.makedirs(CARD_ARCHIVE_DIR, exist_ok=True)
    dest = os.path.join(CARD_ARCHIVE_DIR, f'{date_str}.png')
    if os.path.exists(card_path) and not os.path.exists(dest):
        shutil.copy2(card_path, dest)


def prune_old_cards(keep_days=CARD_KEEP_DAYS):
    # git이 추적 중인 output/daily-card/YYYY-MM-DD[-slot].png 중 오래된 것을 로컬 아카이브로 옮긴 뒤
    # git rm으로 스테이징. -슬롯 접미사(점심/저녁 등)가 붙어도 날짜만 뽑아 나이를 판단한다.
    # 실제 커밋은 이 함수를 호출한 쪽(git_commit_push)이 오늘 카드 추가와 한 커밋으로 묶어서 한다.
    pattern = re.compile(r'^(\d{4}-\d{2}-\d{2})(?:-\w+)?\.png$')
    card_dir_git = CARD_DIR.replace(os.sep, '/')
    try:
        out = subprocess.run(['git', 'ls-files', card_dir_git],
                              capture_output=True, text=True, encoding='utf-8', errors='replace', check=True).stdout
    except subprocess.CalledProcessError as e:
        print('⚠️ 지난 카드 목록 조회 실패:', (e.stderr or str(e))[-400:])
        return []

    dated = []
    for line in out.splitlines():
        base = os.path.basename(line)
        m = pattern.match(base)
        if m:
            dated.append((m.group(1), base[:-4], line))  # (날짜, 슬롯 포함 슬러그, git 경로)
    dated.sort()  # 날짜 오름차순 → 앞쪽이 오래된 것

    if len(dated) <= keep_days:
        return []

    removed = []
    for date_str, slug, git_path in dated[:-keep_days]:
        archive_card_locally(git_path.replace('/', os.sep), slug)
        r = subprocess.run(['git', 'rm', '--quiet', git_path],
                            capture_output=True, text=True, encoding='utf-8', errors='replace')
        if r.returncode == 0:
            removed.append(git_path)
        else:
            print(f'⚠️ {git_path} 정리 실패:', (r.stderr or '')[-300:])
    return removed


def pick_today(rng=None, target_hhmm=None, target_types=None):
    # target_hhmm(예: '18:30')을 주면 "오늘 언젠가 영업"이 아니라 그 시각에 실제로 열려있는
    # 곳만 후보로 삼는다(점심/저녁처럼 하루 여러 번 보낼 때 시간대에 안 맞는 추천을 막기 위함).
    # target_types를 주면 TARGET_TYPES 대신 그 집합만 후보로 삼는다(저녁엔 카페 제외 등).
    rng = rng or random.Random()
    now = datetime.now()
    day_idx = int(now.strftime('%w'))
    day_name = DAY_NAMES[day_idx]
    month = now.month
    history = load_history()

    # 하루 1회(슬롯 없는) 발송은 사용자가 미리 검수해둔 주간 큐가 있으면 그걸 그대로 쓴다 —
    # 랜덤 자동선정은 큐에 오늘 날짜가 없을 때만 폴백으로 동작한다(2026-09-03 도입).
    if target_hhmm is None:
        plan = load_plan()
        entry = plan.get(now.strftime('%Y-%m-%d'))
        if entry:
            places_by_sid = {p.get('s'): p for p in load_places()}
            chosen = places_by_sid.get(entry.get('sid'))
            if chosen:
                template = fetch_template()
                msg = render_message(chosen, day_name, template)
                return chosen, msg, history
            print(f'⚠️ 큐에 있는 장소(sid={entry.get("sid")})를 places.js에서 못 찾음 — 랜덤 선정으로 대체')

    places = load_places()
    filtered = [p for p in places if not p.get('x') and p.get('t') in (target_types or TARGET_TYPES)]

    scored = []
    for p in filtered:
        if target_hhmm is not None:
            open_then = open_at_time(p, day_name, target_hhmm)
            if open_then is False:
                continue
            status = 'open' if open_then else 'unknown'
        else:
            status = today_hours_status(p, day_name)
            if status == 'closed':
                continue
        s = base_score(p, rng) + season_bonus(p, month) + weekday_bonus(p, day_idx)
        if status == 'unknown':
            s -= 1.0
        scored.append((s, p))

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


def pick_for_date(day, exclude_sids, rng, history):
    # plan_week()용 — pick_today()와 같은 스코어링/중복회피 로직이지만 특정 미래 날짜(day) 기준으로
    # 돌리고, 같은 계획 안에서 이미 고른 곳(exclude_sids)도 추가로 피한다.
    day_idx = int(day.strftime('%w'))
    day_name = DAY_NAMES[day_idx]
    month = day.month

    places = load_places()
    filtered = [p for p in places if not p.get('x') and p.get('t') in TARGET_TYPES and p.get('s') not in exclude_sids]

    scored = []
    for p in filtered:
        status = today_hours_status(p, day_name)
        if status == 'closed':
            continue
        s = base_score(p, rng) + season_bonus(p, month) + weekday_bonus(p, day_idx)
        if status == 'unknown':
            s -= 1.0
        scored.append((s, p))

    cutoff = day - timedelta(days=DEDUP_DAYS)
    recent_sids = {sid for sid, d in history.items() if datetime.strptime(d, '%Y-%m-%d') >= cutoff}
    deduped = [(s, p) for s, p in scored if p.get('s') not in recent_sids]

    pool = deduped if len(deduped) >= MIN_POOL_AFTER_DEDUP else scored
    if not pool:
        raise RuntimeError(f'{day.strftime("%Y-%m-%d")} 추천 가능한 후보가 없음 (필터 결과 0곳)')

    ranked = sorted(pool, key=lambda x: -x[0])[:10]
    _, chosen = weighted_pick(ranked, rng)
    return chosen, day_name


def plan_week(n=7, start_date=None):
    # 하루씩 자동 발송하는 대신, N일치를 미리 뽑아서 사용자가 검수한 뒤에 큐로 소비하게 한다
    # (2026-09-03: "1주일치를 내가 미리 검수하고 올리고 싶어" 요청).
    rng = random.Random()
    history = load_history()
    start = start_date or datetime.now()
    used_sids = set()
    plan = []
    for i in range(n):
        day = start + timedelta(days=i)
        chosen, day_name = pick_for_date(day, used_sids, rng, history)
        used_sids.add(chosen.get('s'))
        plan.append({'date': day.strftime('%Y-%m-%d'), 'day_name': day_name, 'place': chosen})
    return plan


def save_plan(plan):
    data = {item['date']: {'sid': item['place'].get('s'), 'name': item['place'].get('n'), 'day_name': item['day_name']}
            for item in plan}
    json.dump(data, open(PLAN_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


def load_plan():
    try:
        return json.load(open(PLAN_PATH, encoding='utf-8'))
    except FileNotFoundError:
        return {}


def notify_fallback(text):
    # 실패 알림 전용 — 추천 원문(msg)을 다시 통째로 넣지 않는다.
    # (전에는 실패 메시지에 msg 전문을 그대로 붙여 보내서, 발송 성공 시 DM에 뜨는 진짜 추천과
    #  내용이 겹쳐 "추천이 두 채널에 따로 온다"는 오해를 샀다 — 2026-08-19 확인된 버그)
    hook = cfg.get('slack_webhook')
    if not hook:
        return
    try:
        import requests
        requests.post(hook, json={'text': text}, timeout=15)
    except Exception as e:
        print('실패 알림 전송도 실패:', e)


def wait_for_url(url, timeout=90, interval=5):
    # GitHub Pages는 push 직후 바로 서빙되지 않을 수 있다(수십 초 전파 지연).
    # 아직 안 뜬 image_url을 Slack blocks에 넣으면 Slack이 검증에 실패해 전체 메시지가 400으로 거부된다
    # (2026-08-17~19 실제로 발생 — 카드는 커밋됐는데 DM 발송만 실패하던 원인).
    import requests
    deadline = datetime.now().timestamp() + timeout
    while datetime.now().timestamp() < deadline:
        try:
            r = requests.head(url, timeout=8, allow_redirects=True)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        import time; time.sleep(interval)
    return False


def send(msg, image_url=None, image_alt=''):
    hook = cfg.get('daily_pick_webhook')
    if not hook:
        print('⚠️ daily_pick_webhook 미설정 → 발송 생략 (data/.refresh_config.json에 키 추가 필요)')
        return False
    payload = {'text': msg}
    if image_url:
        # incoming webhook은 파일 업로드는 못 하지만, blocks의 image 타입으로 외부 URL은 바로 보여줄 수 있다
        # (봇 토큰·files:write 스코프 불필요 — GitHub Pages에 이미 커밋·푸시된 카드 URL을 그대로 참조)
        payload['blocks'] = [
            {'type': 'section', 'text': {'type': 'mrkdwn', 'text': msg}},
            {'type': 'image', 'image_url': image_url, 'alt_text': image_alt or '오늘의 추천 카드'},
        ]
    try:
        import requests
        r = requests.post(hook, json=payload, timeout=15)
        if r.status_code == 200:
            print('DM 발송됨')
            return True
        print(f'DM 발송 실패: {r.status_code} — {r.text[:300]}')
        notify_fallback(f'⚠️ 고성 트립코스 매일추천 발송 실패 (status={r.status_code}) — 재시도(11:10)가 다시 시도해요.')
        return False
    except Exception as e:
        print('DM 발송 실패:', e)
        notify_fallback(f'⚠️ 고성 트립코스 매일추천 발송 실패: {e} — 재시도(11:10)가 다시 시도해요.')
        return False


# 점심/저녁처럼 하루 여러 번 보낼 때 슬롯별 대표 시각 — 그 시각에 실제로 열려있는 곳만 후보로 삼는다.
SLOT_TIMES = {'lunch': '12:30', 'dinner': '18:30'}
# 저녁엔 카페보다 식사/술집이 자연스러워서 슬롯별로 후보 타입을 다르게 둔다(점심은 기존과 동일하게 전체).
SLOT_TARGET_TYPES = {'dinner': {'식사', '술집'}}

PLAN_PREVIEW_DIR = os.path.join(CARD_DIR, 'plan')

if __name__ == '__main__':
    if '--plan' in sys.argv:
        idx = sys.argv.index('--plan')
        n = int(sys.argv[idx + 1]) if idx + 1 < len(sys.argv) and sys.argv[idx + 1].isdigit() else 7
        plan = plan_week(n)
        now = datetime.now()
        os.makedirs(PLAN_PREVIEW_DIR, exist_ok=True)
        for item in plan:
            day = datetime.strptime(item['date'], '%Y-%m-%d')
            card_data = build_card_data(item['place'], item['day_name'], day)
            out_path = os.path.join(PLAN_PREVIEW_DIR, f"{item['date']}.png")
            render_card(card_data, out_path)
            print(f"{item['date']} ({item['day_name']}) — {item['place'].get('n')} → {out_path}")
        save_plan(plan)
        print(f'{PLAN_PATH}에 큐 저장됨 (커밋·발송 없음) — 검수 후 승인되면 매일 발송이 이 큐를 먼저 씀')
        sys.exit(0)

    preview = '--preview' in sys.argv
    slot = None
    if '--slot' in sys.argv:
        idx = sys.argv.index('--slot')
        slot = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else None
        if slot not in SLOT_TIMES:
            print(f'⚠️ 알 수 없는 --slot 값: {slot!r} (사용 가능: {list(SLOT_TIMES)})')
            sys.exit(1)
    target_hhmm = SLOT_TIMES.get(slot)
    target_types = SLOT_TARGET_TYPES.get(slot)

    now = datetime.now()
    day_name = DAY_NAMES[int(now.strftime('%w'))]
    chosen, msg, history = pick_today(target_hhmm=target_hhmm, target_types=target_types)
    print(msg)

    card_data = build_card_data(chosen, day_name, now)
    if preview:
        render_card(card_data, CARD_PREVIEW_PATH)
        print(f'카드 미리보기: {CARD_PREVIEW_PATH} (커밋·발송 없음)')
        sys.exit(0)

    date_str = now.strftime('%Y-%m-%d')
    slug = f'{date_str}-{slot}' if slot else date_str
    card_rel_path = os.path.join(CARD_DIR, f'{slug}.png')
    image_url = None
    if render_card(card_data, card_rel_path):
        archive_card_locally(card_rel_path, slug)  # 공개 저장소 정리와 무관하게 이 컴퓨터엔 항상 남긴다
        card_git_path = card_rel_path.replace(os.sep, '/')
        pruned = prune_old_cards()
        commit_msg = f'data: 오늘의 추천 카드 {slug} ({chosen.get("n", "")})'
        if pruned:
            commit_msg += f' + 지난 카드 {len(pruned)}개 정리(로컬 보관)'
        if git_commit_push(card_git_path, commit_msg):
            candidate_url = f'{PAGES_BASE}/{card_git_path}'
            print('GitHub Pages 반영 대기 중...')
            if wait_for_url(candidate_url):
                image_url = candidate_url
            else:
                print('⚠️ Pages에 아직 안 떠서(최대 90초 대기) 이번엔 텍스트만 발송 — 카드 자체는 커밋됐음')
        else:
            print('⚠️ 카드 이미지 커밋·푸시 실패 — 텍스트만 발송')

    if send(msg, image_url=image_url, image_alt=chosen.get('n', '')):
        history[chosen['s']] = date_str
        save_history(history)
    else:
        sys.exit(1)  # 재시도(.sh)가 done-marker 없이 11:10에 다시 시도하도록
