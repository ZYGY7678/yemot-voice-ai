import puppeteer from 'puppeteer';

const ZMANIM_URL = 'https://www.matara.pro/nedarimplus/zmanim/';
const IL_TZ = 'Asia/Jerusalem';

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hebrewTimeSpeech(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return hhmm;
  if (m === 0) return `${h} בדיוק`;
  return `${h} ו${m} דקות`;
}

function nowInIsrael() {
  const parts = new Intl.DateTimeFormat('en-IL', {
    timeZone: IL_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  return Number(parts.find(p => p.type === 'hour')?.value || 0) * 60
    + Number(parts.find(p => p.type === 'minute')?.value || 0);
}

function parseTimesFromText(raw) {
  const lines = raw.split('\n').map(cleanText).filter(Boolean);
  const prayerRe = /(שחרית|מנחה|מעריב|ערבית|מוסף|קבלת שבת|סליחות|ותיקין)/;
  const timeRe = /(?<!\\d)([01]?\\d|2[0-3]):([0-5]\\d)(?!\\d)/g;
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = [...line.matchAll(timeRe)];
    if (!matches.length) continue;

    const prayerContext = line.match(prayerRe)?.[1]
      || lines[i - 1]?.match(prayerRe)?.[1]
      || lines[i + 1]?.match(prayerRe)?.[1];
    if (!prayerContext) continue;

    const context = cleanText(
      line.replace(timeRe, ' ').replace(prayerContext, ' ')
    ).slice(0, 100);

    for (const match of matches) {
      const hh = String(match[1]).padStart(2, '0');
      const mm = match[2];
      out.push({
        type: prayerContext,
        time: `${hh}:${mm}`,
        context,
        sourceLine: line
      });
    }
  }

  return out;
}

function scoreResult(item) {
  const typeWeight = {
    'שחרית': 10,
    'מנחה': 20,
    'מעריב': 30,
    'ערבית': 30,
    'מוסף': 40,
    'ותיקין': 5
  }[item.type] || 50;
  return typeWeight;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.type}|${item.time}|${item.context}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function findAddressInput(page) {
  const candidates = await page.evaluate(() => {
    return [...document.querySelectorAll('input, textarea')].map((el, index) => ({
      index,
      tag: el.tagName,
      type: el.getAttribute('type') || '',
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      value: el.value || ''
    }));
  });

  const keywords = ['חיפוש כתובת', 'כתובת', 'חיפוש', 'address', 'search'];
  const ranked = candidates
    .map(c => {
      const hay = [c.placeholder, c.aria, c.title, c.name, c.id].join(' ').toLowerCase();
      let score = 0;
      for (const k of keywords) if (hay.includes(k.toLowerCase())) score += 10;
      if ((c.type || '').toLowerCase() === 'text') score += 2;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0] || null;
}

async function acceptAutocomplete(page) {
  const clicked = await page.evaluate(() => {
    const selectors = [
      '.pac-item',
      '[role="option"]',
      '.ui-menu-item',
      '.autocomplete-item',
      '.address-result',
      '.suggestion'
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent?.trim()) {
        el.click();
        return true;
      }
    }
    return false;
  });

  if (!clicked) {
    try { await page.keyboard.press('ArrowDown'); } catch {}
    try { await page.keyboard.press('Enter'); } catch {}
  }
}

async function trySearchButtons(page) {
  const clicked = await page.evaluate(() => {
    const wanted = ['הצג מניינים', 'חפש', 'חיפוש', 'הצג'];
    const els = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a')];
    for (const el of els) {
      const txt = String(el.innerText || el.value || '').trim();
      if (wanted.some(w => txt.includes(w))) {
        el.click();
        return txt;
      }
    }
    return '';
  });
  return clicked;
}

export async function fetchNedarimZmanim(locationText) {
  const location = cleanText(locationText);
  if (!location) throw new Error('לא התקבל מקום מגורים');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36'
    );

    await page.goto(ZMANIM_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    });

    const input = await findAddressInput(page);
    if (!input) throw new Error('לא נמצא שדה חיפוש כתובת בנדרים פלוס');

    const locator = page.locator(`${input.tag.toLowerCase()}#${CSS.escape(input.id)}`);
    if (input.id) {
      await locator.fill(location);
    } else {
      const all = page.locator('input, textarea');
      await all.nth(input.index).fill(location);
    }

    await new Promise(r => setTimeout(r, 1200));
    await acceptAutocomplete(page);
    await new Promise(r => setTimeout(r, 600));
    await trySearchButtons(page);
    await page.keyboard.press('Enter').catch(() => {});

    await new Promise(r => setTimeout(r, 3000));

    const text = await page.evaluate(() => document.body?.innerText || '');
    const extracted = parseTimesFromText(text);

    const currentMinutes = nowInIsrael();
    const future = extracted.map(x => {
      const [h, m] = x.time.split(':').map(Number);
      const minutes = h * 60 + m;
      const delta = minutes >= currentMinutes
        ? minutes - currentMinutes
        : minutes + 1440 - currentMinutes;
      return { ...x, delta };
    });

    const filtered = dedupe(future)
      .sort((a, b) => a.delta - b.delta || scoreResult(a) - scoreResult(b))
      .slice(0, 10);

    if (!filtered.length) {
      const preview = cleanText(text).slice(0, 900);
      throw new Error('לא נמצאו זמני תפילה בתוצאות החיפוש. תצוגת האתר: ' + preview);
    }

    return {
      location,
      source: ZMANIM_URL,
      fetchedAt: new Date().toISOString(),
      items: filtered
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

export function formatZmanimForPhone(data) {
  const items = data.items || [];
  if (!items.length) return 'לא נמצאו זמני תפילה קרובים.';

  const parts = [
    `מצאתי זמני תפילה קרובים עבור ${data.location}.`
  ];

  for (const item of items.slice(0, 8)) {
    const context = item.context ? ` ${item.context}` : '';
    parts.push(`${item.type}, בשעה ${hebrewTimeSpeech(item.time)}.${context}`);
  }

  return cleanText(parts.join(' '));
}

export function registerZmanimRoute(router, {downloadRecording, transcribeSpeech}) {
  router.all('/yemot/zmanim', async call => {
    try {
      const recordPath = await call.read(
        [{type:'text', data:'ברוכים הבאים למערכת זמני התפילות. אנא אמרו עכשיו בקול את שם היישוב או הכתובת שבה אתם גרים, ולאחר מכן המתינו.'}],
        'record',
        {
          min_length: 1,
          max_length: 15,
          no_confirm_menu: true,
          save_on_hangup: false
        }
      );

      if (!recordPath) return;

      const audio = await downloadRecording(String(recordPath));
      const location = cleanText(await transcribeSpeech(audio));

      if (!location) {
        await call.id_list_message([
          {type:'text', data:'לא הצלחתי להבין את שם היישוב. אנא נסו שוב.'}
        ], {prependToNextAction:true});
        return;
      }

      console.log('[ZMANIM_LOCATION]', location);

      const result = await fetchNedarimZmanim(location);
      const message = formatZmanimForPhone(result);

      console.log('[ZMANIM_RESULT]', JSON.stringify({
        location,
        count: result.items?.length || 0
      }));

      await call.id_list_message(
        [{type:'text', data:message}],
        {prependToNextAction:true}
      );
    } catch (error) {
      console.error('[ZMANIM_IVR_ERROR]', error?.stack || error);
      try {
        await call.id_list_message([
          {type:'text', data:'מצטערים, לא הצלחתי לקבל כרגע את זמני התפילות. נסו שוב בעוד רגע.'}
        ], {prependToNextAction:true});
      } catch {}
    }
  });
}

export async function configureZmanimExtension({token, publicUrl, extension = '1'} = {}) {
  const resolvedToken = String(token || process.env.ZMANIM_YEMOT_TOKEN || '').trim();
  const base = String(publicUrl || process.env.ZMANIM_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!resolvedToken || !base) {
    console.warn('[ZMANIM_CONFIG] missing token or public URL');
    return { ok: false, error: 'missing token or public URL' };
  }

  const params = new URLSearchParams({
    token: resolvedToken,
    path: 'ivr2:/' + String(extension),
    type: 'api',
    api_link: base + '/yemot/zmanim',
    api_wait: 'yes',
    api_wait_play: 'no',
    api_wait_answer_music_on_hold: 'no',
    api_timeout: '90',
    tts_rate: '2',
    rate: '2'
  });

  const response = await fetch('https://www.call2all.co.il/ym/api/UpdateExtension?' + params);
  const body = await response.text();
  let parsed = body;
  try { parsed = JSON.parse(body); } catch {}
  const ok = response.ok && !(typeof parsed === 'string' && /error|שגיאה/i.test(parsed));
  console.log('[ZMANIM_CONFIG]', JSON.stringify({
    ok,
    status: response.status,
    extension,
    api: base + '/yemot/zmanim',
    response: typeof parsed === 'string' ? parsed.slice(0, 500) : parsed
  }));
  return { ok, status: response.status, response: parsed };
}
