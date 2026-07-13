# 네이버 저장 리스트 3개(술집/식사/카페) 재수집 → 속초·고성 필터 → places_region_new.json
# 그리고 기존 places_tagged.json 과 sid 비교해 신규/제거 가게 출력.
# 실행: python data/fetch_lists.py   (프로젝트 루트 기준)
import json, io, sys, time
import requests

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# naver.me 단축링크가 resolve된 공유 폴더 해시 (2026-06-23 확인)
LISTS = {
    '술집': '0ee58cac96de6972cee1d29db96eb1cb',
    '식사': '7f6aac8912cdd71450d290dce9bce503',
    '카페': '805cd9a13b4064986884c509a89178aa',
}
API = 'https://pages.map.naver.com/save-pages/api/maps-bookmark/v3/shares/{}/bookmarks?start=0&limit=5000&sort=lastUseTime'
HEADERS = {
    'Referer': 'https://pages.map.naver.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
}

def is_sokcho_goseong(addr):
    a = addr or ''
    return ('속초시' in a) or ('고성군' in a and '강원' in a)

def fetch_list(h):
    """500 등 일시 오류에 재시도 + limit 축소 폴백."""
    last = None
    for limit in (5000, 2000, 1000):
        for attempt in range(3):
            try:
                url = API.format(h).replace('limit=5000', f'limit={limit}')
                r = requests.get(url, headers=HEADERS, timeout=30)
                if r.status_code == 500:
                    last = '500'; time.sleep(2 + attempt * 2); continue
                r.raise_for_status()
                return r.json()
            except requests.exceptions.RequestException as e:
                last = str(e); time.sleep(2 + attempt * 2)
    raise RuntimeError(f'리스트 수집 실패 (마지막 오류: {last})')

region = []
raw_counts = {}
for label, h in LISTS.items():
    data = fetch_list(h)
    bms = data.get('bookmarkList') or []
    raw_counts[label] = len(bms)
    for b in bms:
        if not b.get('available', True):
            continue
        addr = b.get('address') or ''
        if not is_sokcho_goseong(addr):
            continue
        region.append({
            'list': label,
            'name': b.get('name') or b.get('displayName'),
            'category': b.get('mcidName') or '',
            'address': addr,
            'lng': b.get('px'), 'lat': b.get('py'),
            'memo': b.get('memo') or '',
            'sid': str(b.get('sid')),
            'available': b.get('available', True),
        })
    time.sleep(1)

# sid 중복 제거 (여러 리스트에 같은 가게가 있을 수 있음 — 첫 리스트 우선)
seen, dedup = set(), []
for x in region:
    if x['sid'] in seen:
        continue
    seen.add(x['sid'])
    dedup.append(x)
region = dedup

json.dump(region, open('data/places_region_new.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# ── 기존과 비교 ──────────────────────────────────────
old = json.load(open('data/places_tagged.json', encoding='utf-8'))
old_by_sid = {str(x['sid']): x for x in old}
new_by_sid = {x['sid']: x for x in region}

new_sids = [s for s in new_by_sid if s not in old_by_sid]
removed_sids = [s for s in old_by_sid if s not in new_by_sid]

print('원본 북마크 수:', raw_counts)
print(f'속초·고성 필터(중복제거) 후: {len(region)}곳  (기존 tagged: {len(old)}곳)')
print()
print(f'🆕 신규 {len(new_sids)}곳:')
for s in new_sids:
    x = new_by_sid[s]
    print(f"   [{x['list']}] {x['name']} · {x['category']} · {x['address']}")
print()
print(f'❌ 사라짐(폐업/제거/리스트에서 빠짐) {len(removed_sids)}곳:')
for s in removed_sids:
    x = old_by_sid[s]
    print(f"   [{x.get('list','?')}] {x['name']} · {x.get('category','')} · {x.get('address','')}")
