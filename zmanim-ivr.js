import puppeteer from 'puppeteer';

const ZMANIM_URL = 'https://www.matara.pro/nedarimplus/zmanim/';
const IL_TZ = 'Asia/Jerusalem';

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s:]/gu, ' ')
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

    let prayerContext = line.match(prayerRe)?.[1] || '';
    if (!prayerContext) {
      for (let d = 1; d <= 4 && !prayerContext; d++) {
        prayerContext =
          lines[i - d]?.match(prayerRe)?.[1]
          || lines[i + d]?.match(prayerRe)?.[1]
          || '';
      }
    }
    if (!prayerContext) continue;

    let context = cleanText(
      line.replace(timeRe, ' ').replace(prayerContext, ' ')
    );
    if (!context) {
      for (let d = 1; d <= 3 && !context; d++) {
        const candidate = cleanText(lines[i - d] || '');
        if (candidate && !candidate.match(timeRe) && !candidate.match(prayerRe)) {
          context = candidate;
        }
      }
    }
    context = context.slice(0, 100);

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

function parseDirectResultTimes(raw) {
  const text = cleanText(raw);
  const re = /(שחרית|מנחה|מעריב|ערבית|מוסף|קבלת שבת|סליחות|ותיקין)\s*([01]?\d|2[0-3]):([0-5]\d)/g;
  const out = [];
  let match;
  while ((match = re.exec(text))) {
    const type = match[1];
    const time = String(Number(match[2])).padStart(2, '0') + ':' + match[3];
    const after = text.slice(re.lastIndex, re.lastIndex + 160);
    const context = cleanText(after.split(/(?:שחרית|מנחה|מעריב|ערבית|מוסף|קבלת שבת|סליחות|ותיקין)\s*(?:[01]?\d|2[0-3]):[0-5]\d/)[0] || '').slice(0, 100);
    out.push({type, time, context});
  }
  return out;
}

async function geocodeLocation(location) {
  const aliases = {
    'ניבות': 'נתיבות',
    'נתיבו': 'נתיבות',
    'נתיות': 'נתיבות'
  };

  const normalized = aliases[cleanText(location)] || cleanText(location);
  const cityText = normalized.split(/\s+/).slice(0, 3).join(' ');

  // Built-in Israeli city fallback. This keeps the service working even when
  // public geocoding providers rate-limit Render. The search radius on Nedarim
  // is 5km, so a city-center coordinate still returns local minyanim.
  const cityCoordinates = {
    'נתיבות': [34.5947, 31.4234],
    'בני ברק': [34.8338, 32.0840],
    'ירושלים': [35.2137, 31.7683],
    'תל אביב': [34.7818, 32.0853],
    'פתח תקווה': [34.8878, 32.0870],
    'אשדוד': [34.6435, 31.8014],
    'אשקלון': [34.5715, 31.6688],
    'באר שבע': [34.7913, 31.2518],
    'רחובות': [34.8113, 31.8948],
    'ראשון לציון': [34.7925, 31.9730],
    'חולון': [34.7798, 32.0114],
    'בת ים': [34.7503, 32.0171],
    'רמת גן': [34.8106, 32.0809],
    'גבעתיים': [34.8125, 32.0714],
    'הרצליה': [34.8423, 32.1663],
    'נתניה': [34.8569, 32.3215],
    'כפר סבא': [34.9078, 32.1780],
    'רעננה': [34.8706, 32.1848],
    'מודיעין': [34.9992, 31.8996],
    'בית שמש': [34.9889, 31.7456],
    'צפת': [35.4960, 32.9656],
    'טבריה': [35.5300, 32.7922],
    'חיפה': [34.9896, 32.7940],
    'קריית אתא': [35.1020, 32.8117],
    'עפולה': [35.2897, 32.6070]
  };

  const cityKey = Object.keys(cityCoordinates).find(name =>
    normalized === name || normalized.startsWith(name + ' ')
  );

  const providers = [
    {
      name: 'photon',
      url: 'https://photon.komoot.io/api/?' + new URLSearchParams({
        q: normalized,
        limit: '1',
        lang: 'he'
      }),
      parse: data => data?.features?.[0]?.geometry?.coordinates
    },
    {
      name: 'nominatim-city',
      url: 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
        format: 'jsonv2',
        limit: '1',
        countrycodes: 'il',
        q: cityText
      }),
      parse: data => {
        const row = Array.isArray(data) ? data[0] : null;
        return row?.lon && row?.lat ? [Number(row.lon), Number(row.lat)] : null;
      }
    }
  ];

  let lastError;
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, {
        headers: {
          'User-Agent': 'yemot-voice-ai/1.0',
          'Accept': 'application/json'
        }
      });
      if (!response.ok) {
        lastError = new Error(provider.name + ' HTTP ' + response.status);
        console.warn('[ZMANIM_GEOCODE_PROVIDER]', provider.name, response.status);
        continue;
      }
      const data = await response.json();
      const coords = provider.parse(data);
      if (Array.isArray(coords) && coords.length >= 2) {
        console.log('[ZMANIM_GEOCODE_OK]', JSON.stringify({
          provider: provider.name,
          input: location,
          normalized,
          lat: Number(coords[1]),
          lng: Number(coords[0])
        }));
        return {
          lat: Number(coords[1]),
          lng: Number(coords[0]),
          displayName: normalized
        };
      }
      lastError = new Error(provider.name + ' no result');
    } catch (error) {
      lastError = error;
      console.error('[ZMANIM_GEOCODE_FAIL]', provider.name, error?.message || error);
    }
  }

  if (cityKey) {
    const [lng, lat] = cityCoordinates[cityKey];
    console.warn('[ZMANIM_GEOCODE_FALLBACK_CITY]', JSON.stringify({
      input: location,
      city: cityKey,
      lat,
      lng
    }));
    return {
      lat,
      lng,
      displayName: cityKey + ' (city fallback)'
    };
  }

  throw lastError || new Error('לא נמצאו קואורדינטות לכתובת');
}

export async function fetchNedarimZmanim(locationText) {
  const location = cleanText(locationText);
  if (!location) throw new Error('לא התקבל מקום מגורים');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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

    // Preferred path: geocode the typed address and open Nedarim's public result page directly.
    try {
      const geo = await geocodeLocation(location);
      const resultUrl = ZMANIM_URL.replace(/\/$/, '') +
        '/result.html?radius=5&lat=' + encodeURIComponent(geo.lat) +
        '&lng=' + encodeURIComponent(geo.lng);
      console.log('[ZMANIM_DIRECT_SEARCH]', JSON.stringify({location, displayName:geo.displayName, resultUrl}));

      await page.goto(resultUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 35000
      });
      await new Promise(r => setTimeout(r, 5000));

      const directText = await page.evaluate(() => document.body?.innerText || '');
      const directExtracted = parseDirectResultTimes(directText);
      const now = nowInIsrael();
      const directFuture = directExtracted.map(x => {
        const [h,m] = x.time.split(':').map(Number);
        const minutes=h*60+m;
        const delta=minutes>=now ? minutes-now : minutes+1440-now;
        return {...x,delta};
      });
      const directFiltered = dedupe(directFuture)
        .sort((a,b)=>a.delta-b.delta || scoreResult(a)-scoreResult(b))
        .slice(0,10);

      console.log('[ZMANIM_DIRECT_RESULT]', JSON.stringify({
        location,
        textLength:directText.length,
        count:directFiltered.length,
        items:directFiltered,
        preview:cleanText(directText).slice(0,1200)
      }));

      if (directFiltered.length) {
        return {
          location,
          source: resultUrl,
          fetchedAt: new Date().toISOString(),
          items: directFiltered
        };
      }
    } catch (e) {
      console.error('[ZMANIM_DIRECT_FAIL]', location, e?.message || e);
    }

    await page.goto(ZMANIM_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    });

    const focused = await page.evaluate(() => {
      const keywords = ['חיפוש כתובת', 'כתובת', 'חיפוש', 'address', 'search'];
      const candidates = [...document.querySelectorAll('input, textarea')];
      const ranked = candidates.map((el) => {
        const hay = [
          el.getAttribute('placeholder') || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.getAttribute('name') || '',
          el.id || ''
        ].join(' ').toLowerCase();
        let score = 0;
        for (const k of keywords) if (hay.includes(k.toLowerCase())) score += 10;
        if ((el.getAttribute('type') || '').toLowerCase() === 'text') score += 2;
        return {el, score};
      }).sort((a,b) => b.score - a.score);
      const el = ranked[0]?.el;
      if (!el) return false;
      el.focus();
      el.click();
      return true;
    });
    if (!focused) throw new Error('לא נמצא שדה חיפוש הכתובת');
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(location, {delay: 45});

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

export function registerZmanimRoute(router, {downloadRecording}) {
  router.all('/yemot/zmanim', async call => {
    try {
      console.log('[ZMANIM_IVR] incoming call - Yemot voice transcription');

      const welcome = 'שלום, הגעתם לקו המניין הקרוב אליך של נדרים פלוס. פותח על ידי חייא שיאומי ממתמחים טופ.';

      const readVoiceText = async (prompt, valName) => {
        const recordPath = await call.read(
          [{type:'text', data:prompt}],
          'record',
          {
            min_length: 1,
            max_length: 10,
            no_confirm_menu: true,
            save_on_hangup: false
          }
        );

        if (!recordPath) throw new Error('לא התקבלה הקלטה עבור ' + valName);

        const started = Date.now();
        const audio = await downloadRecording(String(recordPath));
        console.log('[ZMANIM_RECORDING_DOWNLOADED]', JSON.stringify({
          field: valName,
          path: String(recordPath),
          bytes: audio.length,
          download_ms: Date.now() - started
        }));

        const text = await transcribeSpeech(audio);
        const value = cleanText(text);
        if (!value) throw new Error('Gemini לא החזיר תמלול עבור ' + valName);

        console.log('[ZMANIM_GEMINI_TRANSCRIPTION]', JSON.stringify({
          field: valName,
          value
        }));

        return value;
      };

      const confirmTranscription = async (label, value, valName) => {
        const safeValue = cleanText(value);
        if (!safeValue || safeValue === 'None') {
          throw new Error('ימות לא החזיר תמלול עבור ' + label);
        }

        console.log('[ZMANIM_TRANSCRIPTION]', JSON.stringify({
          field: label,
          value: safeValue
        }));

        const answer = await call.read(
          [{type:'text', data: 'שמעתי: ' + safeValue + '. להמשיך הקישו 1. להקליט מחדש הקישו 2.'}],
          'tap',
          {
            val_name: valName + '_confirm',
            max_digits: 1,
            min_digits: 1,
            sec_wait: 15,
            empty_val: 'None',
            typing_playback_mode: 'Number',
            block_change_keyboard: true,
            block_asterisk_key: false
          }
        );

        return cleanText(answer) === '2' ? null : safeValue;
      };

      const getVoiceValue = async (label, prompt, valName) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const value = await readVoiceText(prompt, valName + '_' + attempt);
          const confirmed = await confirmTranscription(label, value, valName + '_' + attempt);
          if (confirmed) return confirmed;
        }
        throw new Error('לא התקבל אישור לתמלול עבור ' + label);
      };

      const city = await getVoiceValue(
        'יישוב',
        welcome + ' אמרו בקול ברור את שם היישוב. בסיום הדיבור המערכת תמלל ותגיד לכם מה היא שמעה.',
        'city'
      );

      console.log('[ZMANIM_CITY_TRANSCRIBED]', city);

      const street = await getVoiceValue(
        'רחוב',
        'עכשיו אמרו בקול ברור את שם הרחוב. בסיום הדיבור המערכת תמלל ותגיד לכם מה היא שמעה.',
        'street'
      );

      console.log('[ZMANIM_STREET_TRANSCRIBED]', street);

      const location = cleanText(city + ' ' + street);
      console.log('[ZMANIM_LOCATION_TRANSCRIBED]', location);

      const result = await fetchNedarimZmanim(location);
      const message = formatZmanimForPhone(result);

      console.log('[ZMANIM_RESULT]', JSON.stringify({
        city,
        street,
        location,
        count: result.items?.length || 0
      }));

      return await call.id_list_message(
        [{type:'text', data:message}]
      );
    } catch (error) {
      console.error('[ZMANIM_IVR_ERROR]', error?.stack || error);
      try {
        return await call.id_list_message([
          {type:'text', data:'מצטערים, לא הצלחתי לקבל כרגע את זמני התפילות. נסו שוב בעוד רגע.'}
        ]);
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
