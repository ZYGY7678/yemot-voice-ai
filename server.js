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
  return {pcm:buf.subarray(dataStart,dataStart+dataSize),sampleRate,channels};
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
  live.session.sendRealtimeInput({
    audio:{
      data:pcm.toString('base64'),
      mimeType:'audio/pcm;rate='+sampleRate
    }
  });
  live.session.sendRealtimeInput({audioStreamEnd:true});

  return await new Promise(async(resolve,reject)=>{
    let inputTranscript='';
    let outputTranscript='';
    const timer=setTimeout(()=>reject(Object.assign(new Error('Timeout: Gemini 3.8 Live'),{status:408})),25000);
    try {
      while(true) {
        const message=await Promise.race([
          live.getMessage(),
          new Promise((_,rej)=>setTimeout(()=>rej(Object.assign(new Error('Timeout: Gemini 3.8 Live'),{status:408})),25000))
        ]);
        const sc=message?.serverContent;
        if(sc?.inputTranscription?.text) inputTranscript+=' '+sc.inputTranscription.text;
        if(sc?.outputTranscription?.text) outputTranscript+=' '+sc.outputTranscription.text;
        if(sc?.turnComplete) {
          clearTimeout(timer);
          resolve({transcript:clean(inputTranscript),reply:clean(outputTranscript)});
          return;
        }
      }
    } catch(e) {
      clearTimeout(timer);
      reject(e);
    }
  });
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

  let live;
  try {
    for(let turn=0;turn<30;turn++){
      activeCalls.get(id).lastActivity=Date.now();

      // Speak the greeting and start recording before doing any Gemini network work.
      const recPath=await call.read(
        [{type:'text',data:'שלום מה נשמע'}],
        'record',
        {
          min_length:1,
          max_length:30,
          no_confirm_menu:true,
          save_on_hangup:false
        }
      );

      if(!recPath) break;

      if(!live){
        live=await connectLive();
        console.log('[CALL '+id+'] Gemini 3.8 Live ready');
      }
      console.log('[CALL '+id+'] recording='+recPath);

      const audio=await downloadRecording(String(recPath));
      const result=await answerAudioLive(live,audio);

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
      await call.id_list_message(
        [{type:'text',data:'מצטער הייתה תקלה זמנית נסה שוב'}],
        true
      );
    } catch {}
  } finally {
    try { live?.session?.close?.(); } catch {}
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