# 썸네일 없는 가게의 대표 사진 보충 수집 (플레이스 홈의 imageUrl)
# 실행: python data/fetch_photos.py  (프로젝트 루트, 4초 간격)
import json, re, time, urllib.request, io, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'

# places_tagged 기준(항상 최신·신규 포함)으로 썸네일 없는 가게만 대상
places = json.load(open('data/places_tagged.json', encoding='utf-8'))
targets = [str(p['sid']) for p in places if not p.get('thumb')]

try:
    photos = json.load(open('data/photos.json', encoding='utf-8'))
except FileNotFoundError:
    photos = {}

def blog_og_image(blog_url):
    """자연명소·관광지 등 플레이스 자체엔 사진이 없어도 블로그 리뷰 글의 대표 이미지(og:image)는 있는 경우가 많음."""
    req = urllib.request.Request(blog_url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'})
    html = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
    m = re.search(r'<meta property="og:image" content="([^"]+)"', html)
    if not m:
        return ''
    img = m.group(1)
    # 오래된(2023년 이전) 블로그 글은 og:image가 blogfiles.naver.net·ldb.phinf.naver.net 등 http 전용 구형 도메인이라
    # https로 서비스되는 우리 페이지에서 mixed-content로 막혀 깨짐(https 미지원 확인됨) → 없는 것으로 처리해 다음 후보로 넘어감
    if img.startswith('http://'):
        return ''
    return img

def fetch(sid):
    url = f'https://m.place.naver.com/place/{sid}/home'
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ko'})
    html = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
    m = re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*?});\s*\n', html, re.S) or \
        re.search(r'window\.__APOLLO_STATE__\s*=\s*({.*})', html)
    if not m:
        return ''
    state = json.loads(m.group(1))
    # https만 채택 (http 전용 구형 CDN은 https 페이지에서 mixed-content로 깨짐 — 2026-07-22 확인)
    # 1순위: placeDetail의 대표 imageUrl (http면 스킵하고 2순위로)
    for k, v in state.items():
        if k.startswith('ROOT_QUERY') and isinstance(v, dict):
            for kk, vv in v.items():
                if kk.startswith('placeDetail') and isinstance(vv, dict) and vv.get('imageUrl') and vv['imageUrl'].startswith('https://'):
                    return vv['imageUrl']
    # 2순위: 등록 사진(PlaceDetailTopPhotoItem) — 접두사가 business 외에 cp_/clip_ 등도 있어 전체 검사,
    # 영상 클립(clip)보다 실제 사진(cp 등)을 우선하고 표시순서(no) 순으로 정렬. https 후보 중 첫 번째만 채택
    items = [v for k, v in state.items() if k.startswith('PlaceDetailTopPhotoItem:') and isinstance(v, dict) and v.get('origin')]
    if items:
        items.sort(key=lambda x: (x.get('type') == 'clip', x.get('no', 999)))
        https_items = [it for it in items if it['origin'].startswith('https://')]
        if https_items:
            return https_items[0]['origin']
    # 3순위: 자연명소 등 플레이스 자체 등록사진이 없으면 블로그 리뷰(FsasReview)의 대표 이미지로 대체
    reviews = [v for k, v in state.items() if k.startswith('FsasReview:') and v.get('type') == 'blog' and v.get('url')]
    reviews.sort(key=lambda x: int(x.get('rank', 99)))
    for r in reviews[:8]:  # http 후보 스킵으로 소진될 수 있어 4→8로 확대
        try:
            img = blog_og_image(r['url'])
            if img:
                return img
        except Exception:
            pass
        time.sleep(1.5)
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
