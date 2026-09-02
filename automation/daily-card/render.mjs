// 오늘의 추천 카드 이미지 렌더러 — template.html에 데이터를 심고 스크린샷으로 저장한다.
// 사용법: node automation/daily-card/render.mjs <data.json> <output.png>
// data.json 형태는 template.html의 renderCard() 주석 참고 (daily_pick.py가 만들어 넘김).

import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const [, , dataPath, outputPath] = process.argv;
  if (!dataPath || !outputPath) {
    console.error('사용법: node render.mjs <data.json> <output.png>');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
  const templateUrl = pathToFileURL(resolve(__dirname, 'template.html')).href;
  const outAbs = resolve(process.cwd(), outputPath);
  mkdirSync(dirname(outAbs), { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1700 }, deviceScaleFactor: 2 });
    // template.html 하단의 자동 샘플 렌더(브라우저 직접 열람용 미리보기)를 막는다
    await page.addInitScript(() => { window.__NO_AUTO__ = true; });
    await page.goto(templateUrl);
    await page.evaluate((d) => window.renderCard(d), data);

    if (data.img) {
      // 사진 로드까지 대기 (실패해도 카드 자체는 렌더 — noimg 그라디언트로 폴백되진 않지만 빈 이미지로 남지 않게 최소 대기)
      await page.waitForFunction(() => {
        const img = document.getElementById('photoImg');
        return !img || img.complete;
      }, { timeout: 8000 }).catch(() => console.warn('⚠️ 사진 로드 대기 타임아웃 — 이미지 없이 진행'));
    }
    await page.waitForTimeout(150); // 폰트/레이아웃 안정화

    await page.locator('#card').screenshot({ path: outAbs });
    console.log('카드 저장됨:', outAbs);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('렌더 실패:', e); process.exit(1); });
