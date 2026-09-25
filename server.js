import express from 'express';
import { GoogleGenAI, Modality } from '@google/genai';
import { YemotRouter, ExitError } from 'yemot-router2';
import YemotApi from 'yemot-api';

if (process.loadEnvFile) { try { process.loadEnvFile(); } catch {} }

const app = express();
app.use(express.urlencoded({extended:true}));
app.use(express.json());

const apiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',').map(x => x.trim()).filter(Boolean);

const LIVE_MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const AUDIO_MODELS = (process.env.GEMINI_MODELS || 'gemini-3-flash-preview,gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(x=>x.trim()).filter(Boolean);
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
  if(!token) {
    console.error('[YEMOT_EXTENSION_1_CONFIG_FAIL] YEMOT_API_KEY missing');
    return;
  }
  try {
    const qs=new URLSearchParams({
      token,
      path:'ivr2:/1',
      api_link:(process.env.PUBLIC_BASE_URL||'').replace(/\/+$/,'')+'/yemot',
      api_wait:'yes',
      api_wait_play:'yes',
      api_wait_answer_music_on_hold:'no',
      api_wait_answer_music_on_hold_different:'',
      api_record_beep:'no',
      option_record:'1-1-30',
      api_timeout:'60',
      tts_rate:'2',
      rate:'2'
    });
    const r=await fetch('https://www.call2all.co.il/ym/api/UpdateExtension?'+qs);
    const body=await r.text();
    console.log('[YEMOT_EXTENSION_1_CONFIGURED]',r.status,body);
    if(!r.ok || !body.includes('"responseStatus":"OK"')) {
      console.error('[YEMOT_EXTENSION_1_CONFIG_FAIL]',body);
    }
  } catch(e) {
    console.error('[YEMOT_EXTENSION_1_CONFIG_FAIL]',e?.message||e);
  }
}

const router = YemotRouter({
  printLog:true,
  timeout:450000,
  defaults:{removeInvalidChars:true},
  uncaughtErrorHandler:e=>console.error('YEMOT:',e)
});

const conversations = [];

// Keep the dashboard useful across requests; transcripts are populated from Gemini where available.

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

async function downloadRecording(path) {
  const p=path.startsWith('ivr2:')?path:'ivr2:'+path;
  const token=String(process.env.YEMOT_API_KEY||'').trim();
  if(token){
    const u='https://www.call2all.co.il/ym/api/DownloadFile?token='+encodeURIComponent(token)+'&path='+encodeURIComponent(p);
    const r=await timeout(fetch(u),REQUEST_TIMEOUT_MS,'download recording');
    if(!r.ok) throw new Error('DownloadFile HTTP '+r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  if(process.env.YEMOT_API_USERNAME&&process.env.YEMOT_API_PASSWORD){
    const api=new YemotApi(process.env.YEMOT_API_USERNAME,process.env.YEMOT_API_PASSWORD);
    const r=await timeout(api.download_file(p),REQUEST_TIMEOUT_MS,'download recording');
    return Buffer.isBuffer(r.data)?r.data:Buffer.from(r.data);
  }
  throw new Error('YEMOT credentials are missing');
}

function wavToPcm(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw new Error('Invalid WAV');
  if (buf.toString('ascii',0,4)!=='RIFF' || buf.toString('ascii',8,12)!=='WAVE') {
    throw new Error('Recording is not WAV');
  }

  let pos=12, audioFormat=null, channels=null, sampleRate=null, bits=null, dataStart=null, dataSize=null;
  while(pos+8<=buf.length){
    const id=buf.toString('ascii',pos,pos+4);
    const size=buf.readUInt32LE(pos+4);
    const body=pos+8;
    if(id==='fmt ' && size>=16){
      audioFormat=buf.readUInt16LE(body);
      channels=buf.readUInt16LE(body+2);
      sampleRate=buf.readUInt32LE(body+4);
      bits=buf.readUInt16LE(body+14);
    } else if(id==='data'){
      dataStart=body;
      dataSize=Math.min(size,buf.length-body);
      break;
    }
    pos=body+size+(size%2);
  }
  if(audioFormat!==1 || !channels || !sampleRate || bits!==16 || dataStart==null){
    throw new Error('WAV must contain PCM 16-bit audio');
  }

  const src=buf.subarray(dataStart,dataStart+dataSize);
  const frames=src.length/(2*channels);
  if(!Number.isInteger(frames) || frames<1) throw new Error('WAV contains no PCM frames');

  const mono=Buffer.allocUnsafe(frames*2);
  for(let i=0;i<frames;i++){
    let sum=0;
    for(let ch=0;ch<channels;ch++) sum+=src.readInt16LE((i*channels+ch)*2);
    mono.writeInt16LE(Math.round(sum/channels),i*2);
  }

  const targetRate=16000;
  if(sampleRate===targetRate) return {pcm:mono,sampleRate:targetRate};

  const outFrames=Math.max(1,Math.round(frames*targetRate/sampleRate));
  const out=Buffer.allocUnsafe(outFrames*2);
  if(outFrames===1){
    out.writeInt16LE(mono.readInt16LE(0),0);
    return {pcm:out,sampleRate:targetRate};
  }

  const scale=(frames-1)/(outFrames-1);
  for(let i=0;i<outFrames;i++){
    const srcPos=i*scale;
    const left=Math.floor(srcPos);
    const right=Math.min(left+1,frames-1);
    const frac=srcPos-left;
    const a=mono.readInt16LE(left*2);
    const b=mono.readInt16LE(right*2);
    out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(a+(b-a)*frac))),i*2);
  }
  return {pcm:out,sampleRate:targetRate};
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

      if(turn===0){
        const previousContext=history.length
          ? history.map(x=>'מתקשר: '+x.transcript+'\\nעוזר: '+x.reply).join('\\n')
          : '';
        let opening='מה קורה גבר, אני איתך. מה קורה?';
        try{
          const ai=new GoogleGenAI({apiKey:apiKeys[0]});
          const prompt=[
            SYSTEM,
            'זהו פתיח לשיחה טלפונית. צור משפט פתיחה קצר, טבעי, חברי ולא רשמי בעברית מדוברת.',
            previousContext
              ? 'יש הקשר מהשיחה הקודמת. התייחס אליו בעדינות ובאופן טבעי, בלי להמציא פרטים:\\n'+previousContext
              : 'אין שיחה קודמת זמינה, לכן פתח בברכה טבעית וקצרה.',
            'החזר רק את משפט הפתיחה להקראה בטלפון, בלי הסברים ובלי מרכאות.'
          ].join('\\n\\n');
          const response=await timeout(ai.models.generateContent({
            model:AUDIO_MODELS[0],
            contents:[{role:'user',parts:[{text:prompt}]}],
            config:{thinkingConfig:{thinkingLevel:'low'}}
          }),10000,'Opening greeting');
          const generated=clean(response?.text||'');
          if(generated) opening=generated;
        }catch(e){
          console.error('[OPENING_FAIL]',String(e?.message||e));
        }
        await call.id_list_message(
          [{type:'text',data:opening}],
          {prependToNextAction:true}
        );
      }

      const recordStarted=Date.now();
      // אין תשובת פתיחה מקומית — ההקלטה נשלחת ישירות ל-Gemini.
      const recordPrompt = SILENT_RECORD_PROMPT;
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
      console.log('[CALL '+id+'] AI result reply='+JSON.stringify(result.reply));
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
app.use('/',router);

function auth(req,res,next){
  if((req.headers['x-dashboard-key']||req.query.key)!==DASHBOARD_PASSWORD)
    return res.status(401).json({ok:false});
  next();
}

app.post('/api/verify-auth',(req,res)=>res.json({ok:String(req.body?.password||'')===DASHBOARD_PASSWORD}));
app.get('/api/conversations',auth,(req,res)=>{
  const callers=[...new Set(conversations.map(x=>x.phone))];
  res.json({totalMessages:conversations.length,totalCallers:callers.length,activeCalls:[...activeCalls.values()],conversations});
});
app.get('/api/logs',auth,(req,res)=>res.json({logs:[]}));
app.post('/api/test-ai',auth,async(req,res)=>{
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
app.get('/dashboard',(req,res)=>res.type('html').send(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>לוח שיחות</title><style>body{font-family:Arial;background:#0b1220;color:#fff;max-width:1000px;margin:25px auto;padding:15px}.card{background:#111c30;padding:18px;border-radius:14px;margin:12px 0}input,button{padding:12px;margin:5px;border-radius:8px;border:0}button{cursor:pointer}.msg{border-top:1px solid #334;padding:12px 0}.muted{color:#9fb0c8}</style><div class="card"><h1>לוח השיחות</h1><div id="login"><p>הזן סיסמת לוח הבקרה:</p><input id="pw" type="password"><button onclick="load()">כניסה</button></div><div id="app" hidden><p id="stats"></p><div id="messages"></div></div></div><script>async function load(){const key=document.getElementById('pw').value;const r=await fetch('/api/conversations',{headers:{'x-dashboard-key':key}});if(!r.ok){alert('סיסמה שגויה');return}const d=await r.json();document.getElementById('login').hidden=true;document.getElementById('app').hidden=false;document.getElementById('stats').textContent='הודעות: '+d.totalMessages+' | מתקשרים: '+d.totalCallers+' | שיחות פעילות: '+d.activeCalls.length;document.getElementById('messages').innerHTML=d.conversations.slice().reverse().map(x=>'<div class="msg"><b>מתקשר: '+esc(x.phone)+'</b><div>'+esc(x.transcript||'(לא זוהה תמלול)')+'</div><div><b>AI:</b> '+esc(x.reply)+'</div><div class="muted">'+esc(x.at)+'</div></div>').join('')||'<p>עדיין אין שיחות.</p>'}function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}</script></html>`));\n\napp.get('/health',(req,res)=>res.json({
  status:'online',
  service:'ai-phone-line',
  model:LIVE_MODEL,
  geminiConfigured:apiKeys.length>0,
  yemotConfigured:Boolean(process.env.YEMOT_API_KEY)
}));
app.get('/',(req,res)=>res.type('html').send('<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>AI Phone Line</title><style>body{font-family:Arial;background:#0b1220;color:#fff;max-width:900px;margin:40px auto;padding:20px}.card{background:#111c30;padding:20px;border-radius:14px;margin:12px 0}input,button{padding:10px;margin:5px}</style><div class="card"><h1>קו טלפון אישי עם בינה מלאכותית</h1><p>Gemini 3.8 Live + ימות המשיח</p><p><a href="/health" style="color:#6cf">בדיקת שרת</a></p></div></html>'));

process.on('unhandledRejection',e=>{if(!(e instanceof ExitError))console.error(e)});
process.on('uncaughtException',e=>{if(!(e instanceof ExitError))console.error(e)});

const port=process.env.PORT||3000;
app.listen(port,()=>{ console.log('Server running on port '+port); disableYemotWaitMusic(); });