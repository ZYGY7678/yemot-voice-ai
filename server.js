import express from 'express';
import { GoogleGenAI, Modality } from '@google/genai';
import { YemotRouter, ExitError } from 'yemot-router2';
import YemotApi from 'yemot-api';
import { registerZmanimRoute, configureZmanimExtension } from './zmanim-ivr.js';

if (process.loadEnvFile) { try { process.loadEnvFile(); } catch {} }

const app = express();
app.use(express.urlencoded({extended:true}));
app.use(express.json());

const serverLogs = [];
const MAX_SERVER_LOGS = 250;
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function formatLogArg(value) {
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function redactLog(text) {
  return String(text || '')
    .replace(/(?:token|api[_-]?key|password|secret)[=:][^\\s,}]+/gi, '$1=••••••')
    .replace(/05\\d{8}/g, m => m.slice(0,3) + '•••••' + m.slice(-2));
}

function pushServerLog(level, args) {
  const message = redactLog(args.map(formatLogArg).join(' ')).slice(0, 1200);
  serverLogs.unshift({
    id: Date.now() + Math.random().toString(16).slice(2),
    time: new Date().toISOString(),
    level,
    message
  });
  if (serverLogs.length > MAX_SERVER_LOGS) serverLogs.length = MAX_SERVER_LOGS;
}

console.log = (...args) => {
  pushServerLog('info', args);
  originalConsoleLog(...args);
};
console.error = (...args) => {
  pushServerLog('error', args);
  originalConsoleError(...args);
};
console.warn = (...args) => {
  pushServerLog('warn', args);
  originalConsoleLog(...args);
};

const apiKeys = [
  process.env.GEMINI_API_KEYS || '',
  process.env.GEMINI_API_KEY || '',
  process.env.GOOGLE_API_KEY || '',
  ...Object.keys(process.env)
    .filter(k => /^(?:GEMINI_(?:API_)?KEY|GOOGLE_API_KEY)_\d+$/i.test(k))
    .sort((a,b) => a.localeCompare(b, undefined, {numeric:true}))
    .map(k => process.env[k] || '')
]
  .flatMap(value => String(value).split(/[,;\\n]+/))
  .map(x => x.trim())
  .filter(Boolean)
  .filter((x,i,arr) => arr.indexOf(x) === i);

const LIVE_MODEL = 'gemini-3.8-live';
const AUDIO_MODELS = ['gemini-2.5-flash-lite','gemini-2.5-flash'];
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 55000);
const DASHBOARD_PASSWORD = String(process.env.DASHBOARD_PASSWORD || '1234');
const SYSTEM = [
  process.env.AI_SYSTEM_INSTRUCTION || '',
  'אתה עוזר קולי בקו טלפון בעברית. ענה בעברית מדוברת, ברורה וקצרה.',
  'ענה ישירות לבקשה האחרונה. אל תמציא מידע. אם לא ברור מה המתקשר אמר, בקש הבהרה קצרה.',
  'אל תשתמש ב-Markdown. שמור על תשובות קצרות ומתאימות להקראה בטלפון.'
].filter(Boolean).join('\n\n');

async function disableYemotWaitMusic() {
  const token=String(process.env.YEMOT_API_KEY||'').trim();
  if(!token) return;
  try {
    const qs=new URLSearchParams({
      token,
      path:'ivr2:/3',
      api_wait_answer_music_on_hold:'no',
      api_wait_play:'no'
    });
    const r=await fetch('https://www.call2all.co.il/ym/api/UpdateExtension?'+qs);
    console.log('[YEMOT_WAIT_MUSIC_DISABLED]',r.status,await r.text());

    // שלוחה 2: קול TTS שונה לגמרי מהקול הקודם.
    // ימות המשיח מתעדת את Jacob כקול גברי נפרד.
    const voiceQs=new URLSearchParams({
      token,
      path:'ivr2:/2',
      voice:'Jacob',
      tts_voice:'Jacob'
    });
    const vr=await fetch('https://www.call2all.co.il/ym/api/UpdateExtension?'+voiceQs);
    console.log('[YEMOT_EXTENSION_2_VOICE_JACOB]',vr.status,await vr.text());
  } catch(e) {
    console.error('[YEMOT_WAIT_MUSIC_CONFIG_FAIL]',e?.message||e);
  }
}

const router = YemotRouter({
  printLog:true,
  timeout:450000,
  defaults:{removeInvalidChars:true},
  uncaughtErrorHandler:e=>console.error('YEMOT:',e)
});

const conversations = [];
const activeCalls = new Map();

function timeout(p, ms, label) {
  let t;
  const q = new Promise((_,rej)=>{
    t=setTimeout(()=>{
      const e=new Error('Timeout: '+label);
      e.status=408;
      rej(e);
    },ms);
  });
  return Promise.race([p,q]).finally(()=>clearTimeout(t));
}

function clean(t) {
  return String(t||'')
    .replace(/[*#_~]/g,' ')
    .replace(/[\\[\\]()<>]/g,' ')
    .replace(/[."“”‘’']/g,' ')
    .replace(/[-–—]/g,' ')
    .replace(/\\s+/g,' ')
    .trim();
}

function callerPhone(c) {
  return String(c?.values?.ApiPhone??c?.req?.query?.ApiPhone??c?.req?.body?.ApiPhone??'').trim()||'לא מזוהה';
}


async function connectLive() {
  let last;
  for (const apiKey of apiKeys) {
    try {
      const ai = new GoogleGenAI({apiKey});
      const queue = [];
      let wake;
      const session = await timeout(ai.live.connect({
        model:LIVE_MODEL,
        config:{
          responseModalities:[Modality.AUDIO],
          inputAudioTranscription:{},
          outputAudioTranscription:{},
          systemInstruction:{parts:[{text:SYSTEM}]}
        },
        callbacks:{
          onmessage:message=>{
            queue.push(message);
            if(wake){const w=wake;wake=null;w();}
          },
          onerror:e=>console.error('[LIVE_ERROR]',e?.message||e),
          onclose:e=>console.log('[LIVE_CLOSE]',e?.reason||'')
        }
      }),15000,'Gemini Live connect');
      console.log('[GEMINI_LIVE_CONNECTED]',LIVE_MODEL);
      return {session,queue,getMessage:async()=>{
        while(!queue.length) await new Promise(resolve=>{wake=resolve});
        return queue.shift();
      }};
    } catch(e) {
      last=e;
      console.error('[GEMINI_LIVE_CONNECT_FAIL]',String(e?.message||e));
    }
  }
  throw last || new Error('No Gemini API key available');
}

async function liveTurn(live, buf) {
  const {pcm,sampleRate}=wavToPcm(buf);
  const chunkBytes=Math.max(2048, Math.round(sampleRate*2*0.1));

  // Feed the recording as short realtime chunks, matching Google's Live API guidance.
  // A single giant chunk can delay/stall turn detection with prerecorded files.
  for(let offset=0; offset<pcm.length; offset+=chunkBytes){
    const chunk=pcm.subarray(offset, Math.min(offset+chunkBytes, pcm.length));
    live.session.sendRealtimeInput({
      audio:{
        data:chunk.toString('base64'),
        mimeType:'audio/pcm;rate='+sampleRate
      }
    });
  }
  live.session.sendRealtimeInput({audioStreamEnd:true});

  const result=await timeout((async()=>{
    let inputTranscript='';
    let outputTranscript='';
    let seenModelTurn=false;
    while(true) {
      const message=await live.getMessage();
      const sc=message?.serverContent;
      if(sc?.inputTranscription?.text) inputTranscript+=' '+sc.inputTranscription.text;
      if(sc?.outputTranscription?.text) outputTranscript+=' '+sc.outputTranscription.text;
      if(sc?.modelTurn) seenModelTurn=true;
      if(sc?.turnComplete) {
        return {transcript:clean(inputTranscript),reply:clean(outputTranscript),seenModelTurn};
      }
    }
  })(),20000,'Gemini 3.8 Live');

  return result;
}


async function transcribeSpeech(buf) {
  let last;
  console.log('[ZMANIM_TRANSCRIPTION_KEYS]', apiKeys.length);
  for (const apiKey of apiKeys) {
    const ai = new GoogleGenAI({apiKey});
    for (const model of AUDIO_MODELS) {
      try {
        const response = await timeout(ai.models.generateContent({
          model,
          contents:[{
            role:'user',
            parts:[
              {text:'האזן להקלטה המצורפת. החזר רק את שם היישוב או הכתובת שהמתקשר אמר בעברית. בלי הסברים, בלי סימני פיסוק מיותרים. אם נאמר שם עיר בלבד, החזר רק את שם העיר.'},
              {inlineData:{mimeType:'audio/wav',data:buf.toString('base64')}}
            ]
          }],
          config:{thinkingConfig:{thinkingLevel:'low'}}
        }),15000,'Gemini speech transcription');
        const text = clean(response?.text||'');
        if (!text) throw new Error('Empty transcription');
        console.log('[ZMANIM_TRANSCRIPTION_OK]',model);
        return text;
      } catch (e) {
        last = e;
        console.error('[ZMANIM_TRANSCRIPTION_FAIL]',model,String(e?.message||e));
      }
    }
  }
  throw last || new Error('No Gemini API key available');
}

async function answerAudioFile(buf, history=[]) {
  let last;
  for (const apiKey of apiKeys) {
    const ai = new GoogleGenAI({apiKey});
    for (const model of AUDIO_MODELS) {
      try {
        const context = history.length
          ? 'המשך השיחה הקודמת:\n' + history.map(x => 'מתקשר: ' + x.transcript + '\nעוזר: ' + x.reply).join('\n')
          : '';
        const response = await timeout(ai.models.generateContent({
          model,
          contents:[{
            role:'user',
            parts:[
              {text:[SYSTEM, context, 'הקשב להקלטה המצורפת. תחילה הבן מה המתקשר אמר, ואז ענה ישירות בעברית מדוברת וקצרה. החזר רק את התשובה להקראה בטלפון.'].filter(Boolean).join('\n\n')},
              {inlineData:{mimeType:'audio/wav',data:buf.toString('base64')}}
            ]
          }],
          config:{thinkingConfig:{thinkingLevel:'low'}}
        }),20000,'Gemini audio response '+model);
        const reply=clean(response?.text||'');
        if(!reply) throw new Error('Empty Gemini response');
        console.log('[GEMINI_AUDIO_OK]',model);
        return {transcript:'',reply};
      } catch(e) {
        last=e;
        console.error('[GEMINI_AUDIO_FAIL]',model,String(e?.message||e));
      }
    }
  }
  throw last || new Error('No Gemini API key available');
}

async function answerAudioLive(live, buf) {
  const out=await liveTurn(live,buf);
  console.log('[TRANSCRIPT]',JSON.stringify(out.transcript));
  console.log('[AI_REPLY]',JSON.stringify(out.reply));
  if(!out.reply) throw new Error('Empty Live response');
  return out;
}

async function callHandler(call) {
  const p=callerPhone(call);
  const id=String(call?.callId||call?.values?.ApiCallId||Date.now()+'-'+p);
  activeCalls.set(id,{phone:p,callId:id,lastActivity:Date.now()});
  console.log('[CALL '+id+'] started phone='+p);

  const history=[];
  try {
    const SILENT_RECORD_PROMPT=[{type:'text',data:'\u200B'}];

    for(let turn=0;turn<30;turn++){
      activeCalls.get(id).lastActivity=Date.now();

      const recordStarted=Date.now();
      const recordPrompt = turn===0
        ? [{type:'text',data:'שלום, הגעתם לקו המניין הקרוב אליך של נדרים פלוס. פותח על ידי חייא שיאומי ממתמחים טופ. אנא אמרו עכשיו בקול את שם היישוב או הכתובת שבה אתם גרים, ולאחר מכן המתינו.'}]
        : SILENT_RECORD_PROMPT;
      const recPath=await call.read(
        recordPrompt,
        'record',
        {
          min_length:1,
          max_length:30,
          no_confirm_menu:true,
          save_on_hangup:false
        }
      );

      if(!recPath) break;

      console.log('[CALL '+id+'] recording='+recPath+' record_ms='+(Date.now()-recordStarted));

      const downloadStarted=Date.now();
      const audio=await downloadRecording(String(recPath));
      console.log('[CALL '+id+'] download_ms='+(Date.now()-downloadStarted));

      const aiStarted=Date.now();
      const result=await answerAudioFile(audio,history);
      console.log('[CALL '+id+'] gemini_ms='+(Date.now()-aiStarted));

      history.push({transcript:result.transcript,reply:result.reply});
      conversations.push({
        phone:p,
        callId:id,
        transcript:result.transcript,
        reply:result.reply,
        at:new Date().toISOString()
      });

      activeCalls.get(id).lastActivity=Date.now();

      await call.id_list_message(
        [{type:'text',data:result.reply}],
        {prependToNextAction:true}
      );
    }
  } catch(e) {
    console.error('[CALL '+id+'] ERROR',e?.stack||e);
    try {
      try {
        call.id_list_message([{type:'text',data:'מצטער הייתה תקלה זמנית נסה שוב'}]);
      } catch {}
    } catch {}
  } finally {
    activeCalls.delete(id);
    console.log('[CALL '+id+'] ended');
  }
}

router.all('/yemot',callHandler);
registerZmanimRoute(router, {downloadRecording, transcribeSpeech});
app.use('/',router);

function auth(req,res,next){
  if((req.headers['x-dashboard-key']||req.query.key)!==DASHBOARD_PASSWORD)
    return res.status(401).json({ok:false});
  next();
}

app.post('/api/verify-auth',(req,res)=>res.json({ok:String(req.body?.password||'')===DASHBOARD_PASSWORD}));
app.get('/api/conversations',(req,res)=>{
  const callers=[...new Set(conversations.map(x=>x.phone))];
  res.json({totalMessages:conversations.length,totalCallers:callers.length,activeCalls:[...activeCalls.values()],conversations});
});
app.get('/api/logs',(req,res)=>res.json({
  logs:serverLogs,
  status:{
    online:true,
    geminiConfigured:apiKeys.length>0,
    geminiKeys:apiKeys.length,
    liveModel:LIVE_MODEL,
    audioModels:AUDIO_MODELS,
    activeCalls:activeCalls.size,
    uptime:Math.floor(process.uptime()),
    memory:Math.round(process.memoryUsage().rss/1024/1024)
  }
}));

app.post('/api/test-ai',async(req,res)=>{
  let s;
  try{
    s=await connectLive();
    s.session.sendClientContent({
      turns:{role:'user',parts:[{text:String(req.body?.prompt||'שלום, בדוק תקינות')}]},
      turnComplete:true
    });
    res.json({ok:true,response:'Gemini 3.8 Live connection OK'});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }finally{
    try{s?.session?.close?.()}catch{}
  }
});
app.get('/health',(req,res)=>res.json({
  status:'online',
  service:'ai-phone-line',
  model:LIVE_MODEL,
  geminiConfigured:apiKeys.length>0,
  yemotConfigured:Boolean(process.env.YEMOT_API_KEY)
}));
app.get('/',(req,res)=>res.type('html').send("<!doctype html>\n<html lang=\"he\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>מרכז השליטה • קו AI</title>\n<style>\n:root{font-family:Arial,Heebo,sans-serif;color-scheme:dark}\n*{box-sizing:border-box}\nbody{margin:0;background:radial-gradient(circle at top,#17253f 0,#090e18 48%,#050810 100%);color:#eef3ff;min-height:100vh}\n.wrap{max-width:1200px;margin:auto;padding:22px}\n.top{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:18px}\n.brand{display:flex;gap:13px;align-items:center}\n.logo{width:48px;height:48px;border-radius:16px;background:linear-gradient(135deg,#2f80ed,#22c55e);display:grid;place-items:center;font-size:23px;box-shadow:0 8px 28px #0006}\nh1{font-size:23px;margin:0 0 4px}.sub{color:#9eabc2;font-size:13px}\n.actions{display:flex;gap:8px}.btn{border:1px solid #27344c;background:#111a2b;color:#eaf1ff;padding:10px 14px;border-radius:11px;cursor:pointer}.btn:hover{background:#16233a}\n.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:11px}\n.card{background:#0f1728cc;border:1px solid #1f2b40;border-radius:16px;padding:15px;box-shadow:0 10px 34px #0003;backdrop-filter:blur(8px)}\n.k{font-size:12px;color:#99a8c1;margin-bottom:8px}.v{font-size:22px;font-weight:700}.ok{color:#50e38d}.bad{color:#ff6b7d}.muted{color:#8998b2}\n.main{display:grid;grid-template-columns:1.4fr .9fr;gap:12px;margin-top:12px}\n.title{font-weight:700;font-size:15px;margin-bottom:10px}\n.logbox{height:500px;overflow:auto;background:#080d16;border:1px solid #182238;border-radius:12px;padding:8px}\n.log{display:grid;grid-template-columns:72px 58px 1fr;gap:8px;padding:9px 7px;border-bottom:1px solid #121c2e;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}\n.log:last-child{border-bottom:0}.time{color:#72819b}.info{color:#64a5ff}.warn{color:#ffd166}.error{color:#ff6578}\n.active{display:flex;flex-direction:column;gap:9px}\n.call{border:1px solid #203149;background:#0b1322;border-radius:12px;padding:12px}\n.row{display:flex;justify-content:space-between;gap:10px;margin:6px 0;font-size:13px}.pill{padding:4px 8px;border-radius:999px;background:#163322;color:#63e28f;font-size:11px}\n.empty{padding:30px;text-align:center;color:#70809a}\n.footer{text-align:center;color:#64748b;font-size:11px;margin:16px 0}\n.auth{display:none;position:fixed;inset:0;background:#050810ee;align-items:center;justify-content:center;z-index:5}\n.auth .card{width:min(390px,92vw)}input{width:100%;padding:12px;border-radius:10px;border:1px solid #2b3951;background:#09111e;color:#fff;margin:10px 0}\n@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}.main{grid-template-columns:1fr}.logbox{height:420px}}\n@media(max-width:520px){.wrap{padding:13px}.grid{grid-template-columns:1fr 1fr}.v{font-size:19px}.log{grid-template-columns:58px 45px 1fr;font-size:10px}}\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <div class=\"top\">\n    <div class=\"brand\">\n      <div class=\"logo\">☎</div>\n      <div><h1>מרכז השליטה • קו AI</h1><div class=\"sub\">מעקב חי אחרי השרת, ימות המשיח ו־Gemini</div></div>\n    </div>\n    <div class=\"actions\"><button class=\"btn\" onclick=\"refreshAll()\">↻ רענן</button><button class=\"btn\" onclick=\"showAuth()\">🔐 מפתח</button></div>\n  </div>\n\n  <div class=\"grid\">\n    <div class=\"card\"><div class=\"k\">שרת</div><div class=\"v\" id=\"serverState\">בודק...</div></div>\n    <div class=\"card\"><div class=\"k\">Gemini</div><div class=\"v\" id=\"geminiState\">בודק...</div></div>\n    <div class=\"card\"><div class=\"k\">מפתחות זמינים</div><div class=\"v\" id=\"keyCount\">—</div></div>\n    <div class=\"card\"><div class=\"k\">שיחות פעילות</div><div class=\"v\" id=\"callCount\">—</div></div>\n  </div>\n\n  <div class=\"main\">\n    <div class=\"card\">\n      <div class=\"title\">📡 לוג מערכת חי</div>\n      <div class=\"logbox\" id=\"logs\"><div class=\"empty\">מתחבר ללוגים...</div></div>\n    </div>\n    <div class=\"card\">\n      <div class=\"title\">📞 מה קורה כעת</div>\n      <div class=\"active\" id=\"activeCalls\"><div class=\"empty\">אין שיחות פעילות כרגע</div></div>\n      <div class=\"title\" style=\"margin-top:18px\">⚙️ פרטי מערכת</div>\n      <div id=\"details\" class=\"muted\" style=\"font-size:13px;line-height:1.9\">—</div>\n    </div>\n  </div>\n\n  <div class=\"footer\">AI Phone Line • Live Dashboard • עדכון אוטומטי כל 2 שניות</div>\n</div>\n\n<div class=\"auth\" id=\"authBox\">\n  <div class=\"card\">\n    <div class=\"title\">🔐 מפתח לוגים</div>\n    <div class=\"muted\" style=\"font-size:12px\">הזן את DASHBOARD_PASSWORD שמוגדר ב־Render</div>\n    <input id=\"keyInput\" type=\"password\" placeholder=\"מפתח\">\n    <button class=\"btn\" style=\"width:100%\" onclick=\"saveKey()\">כניסה</button>\n  </div>\n</div>\n\n<script>\nlet key=localStorage.getItem('dashboardKey')||'';\nfunction showAuth(){document.getElementById('authBox').style.display='flex';document.getElementById('keyInput').focus()}\nfunction saveKey(){key=document.getElementById('keyInput').value.trim();localStorage.setItem('dashboardKey',key);document.getElementById('authBox').style.display='none';refreshAll()}\nfunction esc(s){return String(s??'').replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m]))}\nfunction fmtTime(x){try{return new Date(x).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch{return ''}}\nasync function getJson(url){\n  const r=await fetch(url,{headers:{'x-dashboard-key':key}});\n  if(r.status===401){showAuth();throw new Error('unauthorized')}\n  if(!r.ok)throw new Error('HTTP '+r.status);\n  return r.json();\n}\nasync function refreshAll(){\n  try{\n    const [health,logs]=await Promise.all([fetch('/health').then(r=>r.json()),getJson('/api/logs')]);\n    document.getElementById('serverState').innerHTML='<span class=\"ok\">● ONLINE</span>';\n    document.getElementById('geminiState').innerHTML=health.geminiConfigured?'<span class=\"ok\">● מחובר</span>':'<span class=\"bad\">● לא מוגדר</span>';\n    document.getElementById('keyCount').textContent=logs.status.geminiKeys;\n    document.getElementById('callCount').textContent=logs.status.activeCalls;\n    document.getElementById('details').innerHTML=\n      'מודל Live: <b>'+esc(logs.status.liveModel)+'</b><br>'+\n      'מודלי אודיו: <b>'+esc(logs.status.audioModels.join(' • '))+'</b><br>'+\n      'זמן פעילות: <b>'+esc(uptime(logs.status.uptime))+'</b><br>'+\n      'זיכרון: <b>'+esc(logs.status.memory)+'MB</b>';\n    const box=document.getElementById('logs');\n    box.innerHTML=logs.logs.map(l=>'<div class=\"log\"><span class=\"time\">'+fmtTime(l.time)+'</span><span class=\"'+l.level+'\">'+esc(l.level.toUpperCase())+'</span><span>'+esc(l.message)+'</span></div>').join('')||'<div class=\"empty\">אין לוגים עדיין</div>';\n    if(logs.logs.length)box.scrollTop=0;\n    renderCalls(logs.status.activeCalls);\n  }catch(e){\n    document.getElementById('serverState').innerHTML='<span class=\"bad\">● שגיאה</span>';\n  }\n}\nfunction uptime(sec){sec=Number(sec)||0;const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;return (h?h+'ש ':'')+(m?m+'ד ':'')+s+'ש'}\nfunction renderCalls(count){\n  const box=document.getElementById('activeCalls');\n  if(!count){box.innerHTML='<div class=\"empty\">אין שיחות פעילות כרגע</div>';return}\n  box.innerHTML='<div class=\"call\"><div class=\"row\"><span>שיחה פעילה</span><span class=\"pill\">LIVE</span></div><div class=\"row\"><span>מצב</span><b>השרת מטפל בשיחה</b></div></div>';\n}\nsetInterval(refreshAll,2000);refreshAll();\n</script>\n</body>\n</html>"));

process.on('unhandledRejection',e=>{if(!(e instanceof ExitError))console.error(e)});
process.on('uncaughtException',e=>{if(!(e instanceof ExitError))console.error(e)});

const port=process.env.PORT||3000;
app.listen(port,()=>{ 
  console.log('Server running on port '+port); 
  disableYemotWaitMusic(); 
  configureZmanimExtension({
    token: process.env.ZMANIM_YEMOT_TOKEN,
    publicUrl: process.env.ZMANIM_PUBLIC_URL || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL,
    extension: process.env.ZMANIM_EXTENSION || '1'
  }).catch(e=>console.error('[ZMANIM_CONFIG_FATAL]',e?.message||e));
});

