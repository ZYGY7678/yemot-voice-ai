const express=require('express');
const {YemotRouter}=require('yemot-router2');
const {AI_PROVIDER='openai',AI_MODEL,AI_KEY}=process.env;
const SYS='אתה עוזר טלפוני. ענה בעברית, בקצרה (עד 3 משפטים), בלי סימנים מיוחדים ובלי רשימות.';
async function ask(hist){
 const last=hist.slice(-12);
 if(AI_PROVIDER==='anthropic'){
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':AI_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:AI_MODEL,max_tokens:300,system:SYS,messages:last})}).then(r=>r.json());
  return r.content?.[0]?.text;}
 if(AI_PROVIDER==='gemini'){
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${AI_KEY}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:SYS}]},contents:last.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}))})}).then(r=>r.json());
  return r.candidates?.[0]?.content?.parts?.[0]?.text;}
 const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+AI_KEY,'content-type':'application/json'},body:JSON.stringify({model:AI_MODEL,max_tokens:300,messages:[{role:'system',content:SYS},...last]})}).then(r=>r.json());
 return r.choices?.[0]?.message?.content;}
const clean=t=>String(t||'').replace(/[\r\n*#_`]+/g,' ').slice(0,600);
const app=express();
app.get('/health',(q,s)=>s.json({ok:true}));
app.get('/selftest',async(q,s)=>{try{const a=await ask([{role:'user',content:'אמור שלום'}]);s.json({ok:!!a})}catch(e){s.status(500).json({ok:false})}});
const router=YemotRouter({printLog:true,timeout:'10m',defaults:{removeInvalidChars:true,read:{stt:{block_typing:undefined}}},uncaughtErrorHandler:async(e,call)=>{console.error(e.message);try{call.hangup()}catch(x){}}});
router.get('/',async call=>{
 const hist=[];
 let msg=[{type:'text',data:'ברוכים הבאים לעוזר הטלפוני. אחרי ההשמעה אמרו את שאלתכם'}];
 for(let i=0;i<20;i++){
  const q=await call.read(msg,'stt',{use_records_recognition_engine:true,allow_empty:true,empty_val:''});
  if(!q||!String(q).trim())return call.hangup();
  hist.push({role:'user',content:String(q)});
  let a;try{a=await ask(hist)}catch(e){}
  a=clean(a)||'מצטער אירעה שגיאה נסו שוב';
  hist.push({role:'assistant',content:a});
  msg=[{type:'text',data:a},{type:'text',data:'לשאלה נוספת אמרו אותה עכשיו או נתקו'}];
 }
 call.hangup();
});
app.use('/ivr',router);
app.listen(process.env.PORT||3000);
