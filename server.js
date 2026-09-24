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

const LIVE_MODEL = 'gemini-3.8-live';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 55000);
const DASHBOARD_PASSWORD = String(process.env.DASHBOARD_PASSWORD || '1234');
const SYSTEM = [
  process.env.AI_SYSTEM_INSTRUCTION || '',
  'אתה עוזר קולי בקו טלפון בעברית. ענה בעברית מדוברת, ברורה וקצרה.',
  'ענה ישירות לבקשה האחרונה. אל תמציא מידע. אם לא ברור מה המתקשר אמר, בקש הבהרה קצרה.',
  'אל תשתמש ב-Markdown. שמור על תשובות קצרות ומתאימות להקראה בטלפון.'
].filter(Boolean).join('\n\n');

const router = YemotRouter({
  printLog:true,
  timeout:120000,
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

function limitWords(t,max=80) {
  return String(t||'').trim().split(/\\s+/).filter(Boolean).slice(0,max).join(' ');
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

// Extract raw PCM from a normal PCM WAV without adding another audio conversion service.
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
  // Live API accepts mono/stereo PCM; the sample rate is declared in the MIME type.
  return {pcm:buf.subarray(dataStart,dataStart+dataSize),sampleRate,channels};
}

async function connectLive() {
  let last;
  for (const apiKey of apiKeys) {
    try {
      const ai = new GoogleGenAI({apiKey});
      const session = await timeout(ai.live.connect({
        model:LIVE_MODEL,
        config:{
          responseModalities:[Modality.AUDIO],
          inputAudioTranscription:{},
          outputAudioTranscription:{},
          systemInstruction:{parts:[{text:SYSTEM}]}
        },
        callbacks:{
          onerror:e=>console.error('[LIVE_ERROR]',e?.message||e),
          onclose:e=>console.log('[LIVE_CLOSE]',e?.reason||'')
        }
      }),15000,'Gemini Live connect');
      console.log('[GEMINI_LIVE_CONNECTED]',LIVE_MODEL);
      return session;
    } catch(e) {
      last=e;
      console.error('[GEMINI_LIVE_CONNECT_FAIL]',String(e?.message||e));
    }
  }
  throw last || new Error('No Gemini API key available');
}

async function liveTurn(session, buf) {
  const {pcm,sampleRate}=wavToPcm(buf);
  session.sendRealtimeInput({
    audio:{
      data:pcm.toString('base64'),
      mimeType:'audio/pcm;rate='+sampleRate
    }
  });

  // Flush the completed recording so VAD produces the response promptly.
  session.sendRealtimeInput({audioStreamEnd:true});

  return await new Promise((resolve,reject)=>{
    let inputTranscript='';
    let outputTranscript='';
    let settled=false;
    const finish=(err)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      err?reject(err):resolve({transcript:clean(inputTranscript),reply:clean(outputTranscript)});
    };
    const timer=setTimeout(()=>finish(Object.assign(new Error('Timeout: Gemini 3.8 Live'),{status:408})),25000);

    // The SDK callback receives Live server messages.
    const old = session._callbacks?.onmessage;
    if (!session._callbacks) session._callbacks = {};
    session._callbacks.onmessage = (message)=>{
      try {
        const sc=message?.serverContent;
        if(sc?.inputTranscription?.text) inputTranscript += ' '+sc.inputTranscription.text;
        if(sc?.outputTranscription?.text) outputTranscript += ' '+sc.outputTranscription.text;
        if(sc?.turnComplete){
          finish(null);
        }
      } catch(e){ finish(e); }
      if(typeof old==='function') old(message);
    };
  });
}

async function answerAudioLive(session, buf) {
  const out=await liveTurn(session,buf);
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
  let liveSession=null;

  try {
    liveSession=await connectLive();
    let first=true;

    while(true){
      const msg=first
        ? clean(process.env.WELCOME_MESSAGE||'שלום מדבר צחי במה אוכל לעזור?')
        : 'אמור שאלה נוספת ולסיום הקש סולמית או כוכבית ליציאה';
      first=false;

      console.log('[CALL '+id+'] waiting for recording');
      const path=await call.read([{type:'text',data:msg}],'record',{
        min_length:1,no_confirm_menu:true,max_length:60
      });
      console.log('[CALL '+id+'] recording path='+path);

      if(!path||path==='None'){
        return call.id_list_message([{type:'text',data:'תודה רבה ולהתראות'}]);
      }

      let buf;
      try{
        buf=await downloadRecording(path);
        console.log('[CALL '+id+'] recording downloaded bytes='+(buf?.length||0));
      }catch(e){
        console.error('[CALL '+id+'] recording download failed',e);
        await call.id_list_message([{type:'text',data:'תקלה בהורדת ההקלטה נסה שוב'}],{prependToNextAction:true});
        continue;
      }

      if(!buf||buf.length<500){
        await call.id_list_message([{type:'text',data:'לא שמעתי שאלה אנא נסה שוב'}],{prependToNextAction:true});
        continue;
      }

      let out;
      try{
        out=await answerAudioLive(liveSession,buf);
      }catch(e){
        console.error('[CALL '+id+'] Gemini Live processing failed',e);
        // Reconnect once for a transient WebSocket/API failure.
        try{
          liveSession?.close?.();
          liveSession=await connectLive();
          out=await answerAudioLive(liveSession,buf);
        }catch(e2){
          console.error('[CALL '+id+'] Gemini Live retry failed',e2);
          out={
            transcript:'הקלטה',
            reply:e2?.status===408
              ? 'מצטערים לקח יותר מדי זמן לענות נסה שוב'
              : 'מצטער הייתה תקלה בעיבוד השאלה אפשר לנסות שוב'
          };
        }
      }

      out.reply=limitWords(clean(out.reply),80)||'מצטער לא הצלחתי לנסח תשובה נסה שוב';
      history.push({user:out.transcript,reply:out.reply});
      conversations.push({
        time:new Date().toISOString(),phone:p,callId:id,
        user:out.transcript,gemini:out.reply
      });
      if(conversations.length>1000) conversations.shift();

      console.log('[CALL '+id+'] sending reply');
      await call.id_list_message([{type:'text',data:out.reply}],{prependToNextAction:true});
    }
  }catch(e){
    console.error('[CALL '+id+'] handler failed',e);
    throw e;
  }finally{
    try{liveSession?.close?.()}catch{}
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
    s.sendClientContent({
      turns:{role:'user',parts:[{text:String(req.body?.prompt||'שלום, בדוק תקינות')}]},
      turnComplete:true
    });
    res.json({ok:true,response:'Gemini 3.8 Live connection OK'});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }finally{
    try{s?.close?.()}catch{}
  }
});
app.get('/health',(req,res)=>res.json({
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
app.listen(port,()=>console.log('Server running on port '+port));
