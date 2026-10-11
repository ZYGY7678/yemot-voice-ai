import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { YemotRouter, ExitError } from 'yemot-router2';

if (process.loadEnvFile) { try { process.loadEnvFile(); } catch {} }

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ───────────────────────── הגדרות ─────────────────────────
const apiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',').map(x => x.trim()).filter(Boolean);
const AUDIO_MODELS = (process.env.GEMINI_MODELS || 'gemini-flash-lite-latest')
  .split(',').map(x => x.trim()).filter(Boolean);
const PER_MODEL_TIMEOUT_MS = Number(process.env.PER_MODEL_TIMEOUT_MS || 20000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 55000);
const MIN_REPLY_WORDS = process.env.MIN_REPLY_WORDS ? Number(process.env.MIN_REPLY_WORDS) : 50; // 0 = ללא מינימום
const THINKING_LEVEL = String(process.env.THINKING_LEVEL || '').trim().toUpperCase(); // אופציונלי: MINIMAL/LOW/MEDIUM/HIGH
const DASHBOARD_PASSWORD = String(process.env.DASHBOARD_PASSWORD || '1234');
const GREETING = String(process.env.WELCOME_MESSAGE || '').trim() || 'שלום אני זיגי במה אפשר לעזור';
const MAX_TURNS = 40;      // כמה סבבי שיחה מקסימום בשיחה אחת
const MAX_HISTORY = 10;    // כמה סבבים אחרונים נשלחים ל-Gemini כהקשר
const MAX_FAILURES = 3;    // כמה תקלות רצופות לפני ניתוק

const SYSTEM = [
  process.env.AI_SYSTEM_INSTRUCTION || '',
  'קוראים לך זיגי. אתה עוזר קולי בקו טלפון ומדבר בעברית מדוברת וברורה.',
  'ענה ישירות למה שהמתקשר אמר. אל תמציא מידע. אם לא ברור מה נאמר בקש הבהרה קצרה.',
  'התשובה תוקרא בקול ולכן בלי Markdown בלי רשימות ובלי סימנים מיוחדים. אל תשתמש בנקודות מקפים גרשיים או מרכאות.',
  MIN_REPLY_WORDS > 0
    ? `ענה בעברית טבעית ומועילה באורך של לפחות ${MIN_REPLY_WORDS} מילים, בלי לחזור על עצמך ובלי להמציא עובדות. אם חסר מידע הסבר מה חסר ובקש הבהרה.`
    : ''
].filter(Boolean).join('\n\n');

// ───────────────────────── כלי עזר ─────────────────────────
const conversations = [];
const activeCalls = new Map();

function timeout(p, ms, label) {
  let t;
  const q = new Promise((_, rej) => {
    t = setTimeout(() => {
      const e = new Error('Timeout: ' + label);
      e.status = 408;
      rej(e);
    }, ms);
  });
  return Promise.race([p, q]).finally(() => clearTimeout(t));
}

// ימות לא יכולים להקריא: נקודה, מקף, גרש, גרשיים, & ו-| (לפי התיעוד). גם = ו-# מפרקים את מחרוזת ה-read.
function clean(t) {
  return String(t || '')
    .replace(/[*#_~`]/g, ' ')
    .replace(/[\[\]{}()<>=&|\\\/]/g, ' ')
    .replace(/[“”„"‘’']/g, '')
    .replace(/[-–—]/g, ' ')
    .replace(/[.:;]/g, ',')
    .replace(/(\s*,\s*)+/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/^[,\s]+/, '')
    .trim();
}

function wordCount(value) {
  return (String(value || '').trim().match(/\S+/g) || []).length;
}

// הודעות קצרות כדי שימות לא ייכשלו בהקראת טקסט ארוך אחד
function textMessages(text, maxChars = 120) {
  const words = clean(text).split(' ').filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  if (!chunks.length) chunks.push('סליחה לא הבנתי');
  return chunks.map(data => ({ type: 'text', data, removeInvalidChars: true }));
}

function parseGeminiJson(raw) {
  const text = String(raw || '').trim();
  try { return JSON.parse(text); }
  catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Gemini returned invalid JSON: ' + text.slice(0, 300));
  }
}

function callerPhone(c) {
  return String(c?.values?.ApiPhone ?? c?.req?.query?.ApiPhone ?? c?.req?.body?.ApiPhone ?? '').trim() || 'לא מזוהה';
}

function isBusyError(e) {
  const status = Number(e?.status || e?.code);
  const msg = String(e?.message || e);
  return [408, 429, 500, 503].includes(status) || /overload|unavailable|exhausted|quota|timeout/i.test(msg);
}

// ───────────────────────── ימות המשיח: הורדת הקלטה ─────────────────────────
// טוקן: מפתח API (YEMOT_API_KEY) או "מספר מערכת:סיסמה" (לפי תיעוד ה-API של ימות)
function yemotToken() {
  const key = String(process.env.YEMOT_API_KEY || '').trim();
  if (key) return key;
  const user = String(process.env.YEMOT_API_USERNAME || '').trim();
  const pass = String(process.env.YEMOT_API_PASSWORD || '').trim();
  return user && pass ? `${user}:${pass}` : '';
}

async function downloadRecording(recPath) {
  const token = yemotToken();
  if (!token) throw new Error('חסר YEMOT_API_KEY (או YEMOT_API_USERNAME + YEMOT_API_PASSWORD)');
  let p = String(recPath);
  if (!p.startsWith('ivr2:')) p = 'ivr2:' + (p.startsWith('/') ? p : '/' + p);
  const url = 'https://www.call2all.co.il/ym/api/DownloadFile?' + new URLSearchParams({ token, path: p });
  const r = await timeout(fetch(url), REQUEST_TIMEOUT_MS, 'download recording');
  if (!r.ok) throw new Error(`DownloadFile HTTP ${r.status} path=${p}`); // ימות מחזירים 404 כשהקובץ לא קיים
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('DownloadFile לא החזיר WAV: ' + buf.toString('utf8', 0, 200));
  }
  return buf;
}

// ───────────────────────── Gemini ─────────────────────────
async function askGemini(ai, model, parts) {
  const config = { responseMimeType: 'application/json' };
  if (THINKING_LEVEL) config.thinkingConfig = { thinkingLevel: THINKING_LEVEL };
  const response = await timeout(ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config
  }), PER_MODEL_TIMEOUT_MS, 'Gemini ' + model);
  return parseGeminiJson(response?.text || '');
}

async function answerAudio(buf, history) {
  const context = history.length
    ? 'המשך השיחה עד כה:\n' + history.map(x => `מתקשר: ${x.transcript}\nזיגי: ${x.reply}`).join('\n')
    : '';
  const task = [
    SYSTEM,
    context,
    'המצורפת היא הקלטת האודיו של המתקשר. כתוב transcript כתמלול מדויק בעברית של דברי המתקשר בלבד.',
    'כתוב reply כתשובה טבעית, ישירה ורלוונטית לדברי המתקשר, בעברית מדוברת.',
    'אם המתקשר רק בירך, השב בנימוס והזמן אותו לומר במה הוא צריך עזרה. אם הדיבור לא ברור בקש ממנו לחזור על הדברים.',
    'החזר אך ורק JSON תקין עם שני מפתחות: transcript ו-reply.'
  ].filter(Boolean).join('\n\n');
  const audioPart = { inlineData: { mimeType: 'audio/wav', data: buf.toString('base64') } };

  let last;
  for (const apiKey of apiKeys) {
    const ai = new GoogleGenAI({ apiKey });
    for (const model of AUDIO_MODELS) {
      try {
        const parsed = await askGemini(ai, model, [{ text: task }, audioPart]);
        const transcript = String(parsed.transcript || '').replace(/\s+/g, ' ').trim() || 'לא זוהה תמלול ברור';
        let reply = clean(parsed.reply);
        if (!reply) throw new Error('Gemini returned empty reply');

        // ניסיון הרחבה אחד בלבד אם התשובה קצרה מהמינימום (כדי לא להאריך את זמן ההמתנה בטלפון)
        if (MIN_REPLY_WORDS > 0 && wordCount(reply) < MIN_REPLY_WORDS) {
          try {
            const more = await askGemini(ai, model, [{
              text: [
                SYSTEM,
                'דברי המתקשר: ' + transcript,
                'התשובה הנוכחית: ' + reply,
                `כתוב מחדש תשובה אחת טבעית ורלוונטית באורך של לפחות ${MIN_REPLY_WORDS + 10} מילים. אל תמציא עובדות. החזר JSON בלבד במבנה {"reply":"..."}`
              ].join('\n\n')
            }]);
            const candidate = clean(more.reply);
            if (wordCount(candidate) > wordCount(reply)) reply = candidate;
          } catch (e) {
            console.error('[EXPAND_FAIL]', model, String(e?.message || e));
          }
        }

        console.log('[GEMINI_OK]', model, 'words=' + wordCount(reply));
        return { transcript, reply };
      } catch (e) {
        last = e;
        console.error('[GEMINI_FAIL]', model, String(e?.message || e));
      }
    }
  }
  throw last || new Error('לא הוגדר מפתח Gemini (GEMINI_API_KEYS)');
}

// ───────────────────────── שיחה ─────────────────────────
const router = YemotRouter({
  printLog: true,
  timeout: 450000,
  defaults: { removeInvalidChars: true },
  uncaughtErrorHandler: e => console.error('YEMOT:', e)
});

function sayAndHangup(call, text) {
  // מקשר הודעה + ניתוק בתשובה אחת (prependToNextAction לפי התיעוד של yemot-router2)
  try {
    call.id_list_message(textMessages(text), { prependToNextAction: true, removeInvalidChars: true });
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
  }
  call.hangup(); // זורק ExitError - זה תקין
}

async function callHandler(call) {
  const phone = callerPhone(call);
  const id = String(call?.callId || call?.values?.ApiCallId || Date.now() + '-' + phone);
  activeCalls.set(id, { phone, callId: id, lastActivity: Date.now() });
  console.log(`[CALL ${id}] started phone=${phone}`);

  const history = [];
  let prompt = textMessages(GREETING); // ההודעה הראשונה: "שלום אני זיגי במה אפשר לעזור"
  let failures = 0;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const state = activeCalls.get(id);
      if (state) state.lastActivity = Date.now();

      // משמיע את ה-prompt (ברכה / התשובה הקודמת) ואז מקליט. הקשת סולמית מסיימת את ההקלטה מיד (no_confirm_menu)
      const recPath = await call.read(prompt, 'record', {
        min_length: 1,
        no_confirm_menu: true,
        save_on_hangup: false,
        removeInvalidChars: true
      });
      if (!recPath) { console.log(`[CALL ${id}] no recording, ending`); break; }

      try {
        const t0 = Date.now();
        const audio = await downloadRecording(recPath);
        const t1 = Date.now();
        const result = await answerAudio(audio, history);
        console.log(`[CALL ${id}] rec=${recPath} download_ms=${t1 - t0} gemini_ms=${Date.now() - t1}`);
        console.log(`[CALL ${id}] transcript=${JSON.stringify(result.transcript)}`);
        console.log(`[CALL ${id}] reply=${JSON.stringify(result.reply)}`);

        failures = 0;
        history.push(result);
        if (history.length > MAX_HISTORY) history.shift();
        conversations.push({ phone, callId: id, transcript: result.transcript, reply: result.reply, at: new Date().toISOString() });
        if (conversations.length > 200) conversations.shift();

        prompt = textMessages(result.reply); // התשובה מושמעת, ומיד אחריה ההקלטה הבאה
      } catch (e) {
        failures++;
        console.error(`[CALL ${id}] turn_failed (${failures}/${MAX_FAILURES}):`, e?.stack || e);
        if (failures >= MAX_FAILURES) sayAndHangup(call, 'מצטער יש תקלה כרגע נסה שוב מאוחר יותר');
        prompt = textMessages(isBusyError(e)
          ? 'מצטערים אני עמוס כרגע נסה שוב עוד מעט'
          : 'מצטער הייתה תקלה נסה לדבר שוב');
      }
    }
    sayAndHangup(call, 'תודה ולהתראות');
  } catch (e) {
    if (e instanceof ExitError) throw e;
    if (e?.name === 'HangupError') {
      console.log(`[CALL ${id}] caller_hangup`);
    } else if (e?.name === 'TimeoutError') {
      console.log(`[CALL ${id}] caller_timeout`);
    } else {
      console.error(`[CALL ${id}] ERROR`, e?.stack || e);
      try {
        call.id_list_message(textMessages('מצטער הייתה תקלה זמנית נסה שוב'), { removeInvalidChars: true });
      } catch (e2) {
        if (e2 instanceof ExitError) throw e2;
      }
    }
  } finally {
    activeCalls.delete(id);
    console.log(`[CALL ${id}] ended`);
  }
}

router.all('/yemot', callHandler);
app.use('/', router);

// ───────────────────────── לוח בקרה ובדיקות ─────────────────────────
function auth(req, res, next) {
  if ((req.headers['x-dashboard-key'] || req.query.key) !== DASHBOARD_PASSWORD)
    return res.status(401).json({ ok: false });
  next();
}

app.post('/api/verify-auth', (req, res) => res.json({ ok: String(req.body?.password || '') === DASHBOARD_PASSWORD }));
app.get('/api/conversations', auth, (req, res) => {
  const callers = [...new Set(conversations.map(x => x.phone))];
  res.json({ totalMessages: conversations.length, totalCallers: callers.length, activeCalls: [...activeCalls.values()], conversations });
});
app.get('/api/logs', auth, (req, res) => res.json({ logs: [] }));
app.post('/api/test-ai', auth, async (req, res) => {
  try {
    if (!apiKeys.length) throw new Error('GEMINI_API_KEYS לא מוגדר');
    const ai = new GoogleGenAI({ apiKey: apiKeys[0] });
    const r = await timeout(ai.models.generateContent({
      model: AUDIO_MODELS[0],
      contents: String(req.body?.prompt || 'אמור שלום בעברית במשפט אחד')
    }), PER_MODEL_TIMEOUT_MS, 'test-ai');
    res.json({ ok: true, model: AUDIO_MODELS[0], response: r?.text || '' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/dashboard',(req,res)=>res.type('html').send(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>לוח שיחות</title><style>body{font-family:Arial;background:#0b1220;color:#fff;max-width:1000px;margin:25px auto;padding:15px}.card{background:#111c30;padding:18px;border-radius:14px;margin:12px 0}input,button{padding:12px;margin:5px;border-radius:8px;border:0}button{cursor:pointer}.msg{border-top:1px solid #334;padding:12px 0}.muted{color:#9fb0c8}</style><div class="card"><h1>לוח השיחות</h1><div id="login"><p>הזן סיסמת לוח הבקרה:</p><input id="pw" type="password"><button onclick="load()">כניסה</button></div><div id="app" hidden><p id="stats"></p><div id="messages"></div></div></div><script>async function load(){const key=document.getElementById('pw').value;const r=await fetch('/api/conversations',{headers:{'x-dashboard-key':key}});if(!r.ok){alert('סיסמה שגויה');return}const d=await r.json();document.getElementById('login').hidden=true;document.getElementById('app').hidden=false;document.getElementById('stats').textContent='הודעות: '+d.totalMessages+' | מתקשרים: '+d.totalCallers+' | שיחות פעילות: '+d.activeCalls.length;document.getElementById('messages').innerHTML=d.conversations.slice().reverse().map(x=>'<div class="msg"><b>מתקשר: '+esc(x.phone)+'</b><div>'+esc(x.transcript||'(לא זוהה תמלול)')+'</div><div><b>AI:</b> '+esc(x.reply)+'</div><div class="muted">'+esc(x.at)+'</div></div>').join('')||'<p>עדיין אין שיחות.</p>'}function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}</script></html>`));
app.get('/health', (req, res) => res.json({
  status: 'online',
  service: 'ai-phone-line',
  models: AUDIO_MODELS,
  geminiConfigured: apiKeys.length > 0,
  yemotConfigured: Boolean(yemotToken())
}));
app.get('/',(req,res)=>res.type('html').send('<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>AI Phone Line</title><style>body{font-family:Arial;background:#0b1220;color:#fff;max-width:900px;margin:40px auto;padding:20px}.card{background:#111c30;padding:20px;border-radius:14px;margin:12px 0}input,button{padding:10px;margin:5px}</style><div class="card"><h1>קו טלפון אישי עם בינה מלאכותית</h1><p>Gemini + ימות המשיח</p><p><a href="/health" style="color:#6cf">בדיקת שרת</a></p></div></html>'));

process.on('unhandledRejection', e => { if (!(e instanceof ExitError)) console.error(e); });
process.on('uncaughtException', e => { if (!(e instanceof ExitError)) console.error(e); });

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('Server running on port ' + port);
  console.log('Gemini keys=' + apiKeys.length + ' models=' + AUDIO_MODELS.join(',') + ' yemot_token=' + Boolean(yemotToken()));
});