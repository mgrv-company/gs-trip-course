# 주간 자동 갱신 오케스트레이터 — 로컬 PC 전용 (네이버 수집은 가정용 IP 필요)
# 실행: python data/refresh_all.py [--full]
#   기본 : 리스트 동기화(신규 추가 + 폐업 제거) + 신규 가게만 수집 + TourAPI + 빌드 + 푸시 + 슬랙
#   --full: 영업시간·평점·메뉴·리뷰까지 기존 가게 전부 재수집 (오래 걸림, 월 1회쯤 권장)
# 비밀값(TourAPI 키·슬랙 webhook)은 data/.refresh_config.json (gitignore) 에서 읽음.
import sys, io, json, subprocess, os, time
import requests

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
FULL = '--full' in sys.argv
PY = [sys.executable, '-X', 'utf8']

try:
    cfg = json.load(open('data/.refresh_config.json', encoding='utf-8'))
except FileNotFoundError:
    cfg = {}

def run(script_args):
    print('▶', ' '.join(script_args))
    r = subprocess.run(PY + script_args, capture_output=True, text=True, encoding='utf-8')
    if r.stdout: print(r.stdout.strip())
    if r.returncode != 0: print('⚠️', (r.stderr or '').strip()[:600])
    return r

def conflicted_files():
    r = subprocess.run(['git', 'diff', '--name-only', '--diff-filter=U'], capture_output=True, text=True, encoding='utf-8')
    return [f for f in r.stdout.strip().split('\n') if f]

def notify_slack(text):
    # (2026-07-21) 통합 다이제스트 폐지 — 실행 완료 시 즉시 개별 알림으로 되돌림.
    hook = cfg.get('slack_webhook')
    if not hook:
        print('⚠️ slack_webhook 미설정 → 알림 생략')
        return
    try:
        r = requests.post(hook, json={'text': text}, timeout=15)
        print('슬랙 전송됨' if r.status_code == 200 else f'슬랙 전송 실패: {r.status_code}')
    except Exception as e:
        print('슬랙 전송 실패:', e)

# 중복 실행 방지 락 — 이미 실행 중인데 수동으로 또 돌리면(또는 스케줄 겹침) data/*.json을
# 동시에 건드려 중간상태가 섞이고 git이 꼬임(2026-07-22 실제 발생: 370→410 오염, push 실패)
LOCKFILE = 'data/.refresh.lock'
if os.path.exists(LOCKFILE):
    age = time.time() - os.path.getmtime(LOCKFILE)
    if age < 1800:   # 30분 — 정상 실행 시간보다 넉넉히 여유
        print(f'⚠️ 다른 refresh_all.py가 실행 중인 것으로 보입니다(락 {int(age)}초 전 생성) — 중복 실행 방지로 종료')
        sys.exit(1)
    print(f'⚠️ 오래된 락 파일 발견({int(age)}초 전, 비정상 종료 추정) — 무시하고 진행')
open(LOCKFILE, 'w').write(str(os.getpid()))

try:
    # 1) 네이버 리스트 재수집 → places_region_new.json
    run(['data/fetch_lists.py'])
    region = json.load(open('data/places_region_new.json', encoding='utf-8'))
    region_sids = {str(x['sid']) for x in region}
    tagged = json.load(open('data/places_tagged.json', encoding='utf-8'))
    before = len(tagged)

    # 2) 폐업/제거: 현재 리스트에 없는 가게 제거 (안전장치: 리스트가 충분히 클 때만)
    removed = []
    if len(region) >= 150:
        keep = [x for x in tagged if str(x['sid']) in region_sids]
        removed = [x['name'] for x in tagged if str(x['sid']) not in region_sids]
        tagged = keep
        json.dump(tagged, open('data/places_tagged.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    else:
        print('⚠️ 리스트 수가 적어(', len(region), ') 제거 단계 건너뜀 (네이버 일시 오류 가능)')

    pre_sids = {str(x['sid']) for x in tagged}   # 신규 가게 이름 추출용 기준

    # 3) 신규 태깅 추가
    run(['data/tag_new.py'])

    # 수집 저하 감지용: 재수집 전 영업시간 건수 기록 (--full 리셋 여부와 무관하게 항상 기록)
    old_hours_count = None
    if os.path.exists('data/hours.json'):
        try:
            old_hours_count = len(json.load(open('data/hours.json', encoding='utf-8')))
        except Exception:
            old_hours_count = None

    # 4) --full 이면 기존 수집물을 백업 후 비워 전체 재수집
    if FULL:
        for f in ['hours.json', 'extras.json', 'menus.json', 'reviews_stats.json']:
            p = 'data/' + f
            if os.path.exists(p):
                os.replace(p, p + '.bak')
                json.dump({}, open(p, 'w', encoding='utf-8'))

    # 5) 상세 수집 (증분: 새 sid만 / --full: 전체)
    for s in ['fetch_hours.py', 'fetch_extras.py', 'fetch_menus.py', 'fetch_reviews.py', 'fetch_photos.py']:
        run(['data/' + s])

    # 5.5) 수집 저하 게이트: 재수집 후 영업시간 건수가 크게 줄었으면 배포 중단 + (--full 이면) 백업 복원
    if old_hours_count is not None and old_hours_count >= 50:
        new_hours_count = 0
        if os.path.exists('data/hours.json'):
            try:
                new_hours_count = len(json.load(open('data/hours.json', encoding='utf-8')))
            except Exception:
                new_hours_count = 0
        if new_hours_count < old_hours_count * 0.6:
            if FULL:
                for f in ['hours.json', 'extras.json', 'menus.json', 'reviews_stats.json']:
                    p = 'data/' + f
                    if os.path.exists(p + '.bak'):
                        os.replace(p + '.bak', p)
            print(f'⚠️ 수집 저하 감지: 영업시간 {old_hours_count}→{new_hours_count}곳 — 배포 중단, 백업 복원')
            notify_slack(f'<@U0AG0G63PTR> ⚠️ [트립코스] 수집 저하 감지(영업시간 {old_hours_count}→{new_hours_count}곳) — 배포 중단, 백업 복원함 (네이버 429 가능성 — 다음 주 갱신에서 재시도)')
            sys.exit(1)

    # 6) TourAPI (액티비티·해수욕장)
    if cfg.get('tourapi_key'):
        run(['data/fetch_tour.py', cfg['tourapi_key']])
    else:
        print('⚠️ tourapi_key 미설정 → TourAPI 갱신 생략')

    # 6.5) 어드민 편집(D1) → 로컬 스냅샷 동기화
    # ⚠️ 이 단계가 없으면 주간 빌드가 어드민의 최신 편집(강추·메모·제외·직접추가)을 옛 파일로 되돌린다!
    ADMIN_API = cfg.get('admin_api', 'https://gs-trip-admin.mangrove-goseong.workers.dev')
    try:
        r = requests.get(ADMIN_API + '/public/export', timeout=20)
        r.raise_for_status()
        exp = r.json()
        json.dump(exp['overrides'], open('data/overrides.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        json.dump(exp['manual_places'], open('data/manual_places.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f"어드민 편집 동기화: overrides {len(exp['overrides'])}건 · 직접추가 {len(exp['manual_places'])}건")
    except Exception as e:
        print('⚠️ 어드민 편집 동기화 실패 — 기존 로컬 파일로 진행 (편집 반영은 다음 주간 갱신으로 밀림):', e)

    # 7) 빌드
    run(['data/build_places.py'])

    tagged2 = json.load(open('data/places_tagged.json', encoding='utf-8'))
    total = len(tagged2)
    added_names = [x['name'] for x in tagged2 if str(x['sid']) not in pre_sids]
    added = len(added_names)

    # 8) 커밋 & 푸시
    subprocess.run(['git', 'add', 'data/places_tagged.json', 'data/hours.json', 'data/extras.json',
                    'data/menus.json', 'data/reviews_stats.json', 'data/photos.json',
                    'data/overrides.json', 'data/manual_places.json', 'places.js', 'tour.js'])
    ts = time.strftime('%Y-%m-%d')
    msg = f'data: 주간 자동 갱신 {ts} (신규 {added}·제거 {len(removed)}·총 {total})'
    cm = subprocess.run(['git', 'commit', '-m', msg], capture_output=True, text=True, encoding='utf-8')
    print(cm.stdout.strip(), cm.stderr.strip())
    if cm.returncode != 0 and 'nothing to commit' not in cm.stdout:
        raise RuntimeError(f'git commit 실패: {cm.stdout.strip()} {cm.stderr.strip()}')

    pl = subprocess.run(['git', 'pull', '--rebase', 'origin', 'main'], capture_output=True, text=True, encoding='utf-8')
    print(pl.stdout.strip(), pl.stderr.strip())
    if pl.returncode != 0:
        conflicts = conflicted_files()
        # places.js는 data/*.json으로부터 100% 재생성 가능한 파일 — GitHub Actions(build.yml)가
        # 같은 파일을 독립적으로 재생성·커밋하기 때문에 rebase 충돌이 여기서만 나면 병합 대신 재생성으로 해결한다.
        if conflicts == ['places.js']:
            print('⚠️ places.js 충돌 감지 — 병합된 데이터 기준으로 재생성 후 rebase 계속')
            run(['data/build_places.py'])
            subprocess.run(['git', 'add', 'places.js'])
            cont = subprocess.run(['git', 'rebase', '--continue'], capture_output=True, text=True,
                                   env=dict(os.environ, GIT_EDITOR='true'))
            print(cont.stdout.strip(), cont.stderr.strip())
            if cont.returncode != 0:
                subprocess.run(['git', 'rebase', '--abort'])
                raise RuntimeError(f'places.js 충돌 자동 해결 실패, rebase 중단: {cont.stdout.strip()} {cont.stderr.strip()}')
        else:
            if conflicts:
                subprocess.run(['git', 'rebase', '--abort'])
            extra = f' (충돌 파일: {conflicts})' if conflicts else ''
            raise RuntimeError(f'git pull --rebase 실패: {pl.stdout.strip()} {pl.stderr.strip()}{extra}')

    pu = subprocess.run(['git', 'push', 'origin', 'main'], capture_output=True, text=True, encoding='utf-8')
    print(pu.stdout.strip(), pu.stderr.strip())
    if pu.returncode != 0:
        raise RuntimeError(f'git push 실패: {pu.stdout.strip()} {pu.stderr.strip()}')

    # 9) 슬랙 알림
    # 사내 표준 양식: 멘션 [맹그로브 고성] 작업명 (MM/DD) → 🔔요약 → 섹션(코드블록) → 푸터
    parts = [f'<@U0AG0G63PTR> [맹그로브 고성] 트립코스 주간 갱신 ({time.strftime("%m/%d")})', '',
             f'🔔 신규 {added}건 · 제거 {len(removed)}건 · 총 {total}곳']
    if added_names:
        more = '\n…' if len(added_names) > 15 else ''
        parts += ['', '🆕 신규', '```' + '\n'.join(added_names[:15]) + more + '```']
    if removed:
        parts += ['', '❌ 제거', '```' + '\n'.join(removed[:15]) + '```']
    parts += ['', '🔗 https://mgrv-company.github.io/gs-trip-course/',
              f'갱신 {time.strftime("%Y-%m-%d %H:%M")} · {"전체 재수집" if FULL else "증분"}']
    notify_slack('\n'.join(parts))

    print(f'\n=== 완료: 신규 {added} · 제거 {len(removed)} · 총 {total} ===')

except Exception as e:
    try:
        notify_slack(f'<@U0AG0G63PTR> ⚠️ [트립코스] 주간 갱신 실패: {e} — 라이브는 직전본 유지')
    except Exception:
        pass
    print('⚠️ 주간 갱신 실패:', e)
    try: os.remove(LOCKFILE)
    except FileNotFoundError: pass
    sys.exit(1)

try: os.remove(LOCKFILE)
except FileNotFoundError: pass
