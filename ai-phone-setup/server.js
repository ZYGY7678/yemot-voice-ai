const express=require('express'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const app=express();app.use(express.json());app.use(express.static(path.join(__dirname,'public')));
const E=process.env,CID=E.GITHUB_CLIENT_ID,SEC=E.GITHUB_CLIENT_SECRET,BASE=E.BASE_URL||'';
const GH=E.GH_API||'https://api.github.com',RD=E.RENDER_API||'https://api.render.com/v1',YM=E.YEMOT_API||'https://www.call2all.co.il/ym/api';
const S=new Map();
const URLRE=E.ALLOW_HTTP?/^https?:\/\/[\w.:-]+$/:/^https:\/\/[\w.-]+$/;
const sid=r=>(/sid=(\w+)/.exec(r.headers.cookie||'')||[])[1];
const sess=r=>S.get(sid(r))||{};
const newSess=(s,data)=>{const id=crypto.randomBytes(16).toString('hex');S.set(id,data);s.setHeader('Set-Cookie',`sid=${id}; HttpOnly; Path=/; SameSite=Lax${BASE.startsWith('https')?'; Secure':''}`);return id};
async function jf(url,opt){const r=await fetch(url,opt);const t=await r.text();let j;try{j=JSON.parse(t)}catch{j={raw:t}}return {r,j}}
async function gh(t,p,m='GET',b){const {r,j}=await jf(GH+p,{method:m,headers:{Authorization:'Bearer '+t,Accept:'application/vnd.github+json','User-Agent':'ai-phone-setup','Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});if(!r.ok)throw new Error('GitHub: '+(j.message||r.status));return j}
async function rd(key,p,m='GET',b){const {r,j}=await jf(RD+p,{method:m,headers:{Authorization:'Bearer '+key,Accept:'application/json','Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});if(!r.ok)throw new Error('Render: '+(j.message||r.status));return j}
async function ym(cmd,params){const u=new URL(YM+'/'+cmd);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);const {r,j}=await jf(u);if(!r.ok||j.responseStatus!=='OK')throw new Error('ימות: '+(j.message||j.exceptionMessage||r.status));return j}
const wrap=f=>async(q,s)=>{try{s.json(await f(q,s))}catch(e){s.status(400).json({error:e.message})}};
app.get('/api/config',(q,s)=>s.json({oauth:!!CID,login:sess(q).login||null}));
app.get('/auth/github',(q,s)=>{if(!CID)return s.status(400).send('OAuth not configured');const id=newSess(s,{});s.redirect(`https://github.com/login/oauth/authorize?client_id=${CID}&scope=repo&state=${id}&redirect_uri=${encodeURIComponent(BASE+'/auth/callback')}`)});
app.get('/auth/callback',async(q,s)=>{try{if(!q.query.state||q.query.state!==sid(q))return s.status(400).send('state');
 const {j}=await jf('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:CID,client_secret:SEC,code:q.query.code})});
 if(!j.access_token)return s.status(400).send('auth failed');
 const u=await gh(j.access_token,'/user');S.set(sid(q),{token:j.access_token,login:u.login});s.redirect('/')}catch(e){s.status(500).send(e.message)}});
app.post('/api/github-token',wrap(async(q,s)=>{const t=String(q.body.token||'').trim();const u=await gh(t,'/user');newSess(s,{token:t,login:u.login});return {login:u.login}}));
async function aiTest(p,m,k){
 let r,j;
 if(p==='anthropic')({r,j}=await jf('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':k,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:m,max_tokens:5,messages:[{role:'user',content:'hi'}]})}));
 else if(p==='gemini')({r,j}=await jf(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(k)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:'hi'}]}]})}));
 else ({r,j}=await jf('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+k,'content-type':'application/json'},body:JSON.stringify({model:m,max_tokens:5,messages:[{role:'user',content:'hi'}]})}));
 if(!r.ok)throw new Error('ספק הבינה: '+(j.error?.message||j.error||r.status));}
app.post('/api/check',wrap(async q=>{
 const {renderKey,yemotKey,provider,model,aiKey}=q.body,out={};
 const run=async(n,f)=>{try{await f();out[n]={ok:true}}catch(e){out[n]={ok:false,error:e.message}}};
 await run('render',async()=>{const o=await rd(renderKey,'/owners?limit=1');if(!o[0]?.owner?.id)throw new Error('לא נמצא workspace')});
 await run('yemot',()=>ym('GetSession',{token:yemotKey}));
 if(!E.SKIP_AI_CHECK)await run('ai',()=>aiTest(provider,model,aiKey));
 return out}));
app.post('/api/repo',wrap(async q=>{
 const {token,login}=sess(q);if(!token)throw new Error('לא מחובר ל-GitHub');
 const name='ai-phone-bot-'+crypto.randomBytes(3).toString('hex');
 const repo=await gh(token,'/user/repos','POST',{name,private:!q.body.isPublic,auto_init:true,description:'AI phone bot'});
 const walk=(d,b='')=>fs.readdirSync(d,{withFileTypes:true}).filter(e=>e.name!=='node_modules').flatMap(e=>e.isDirectory()?walk(path.join(d,e.name),b+e.name+'/'):[{p:b+e.name,f:path.join(d,e.name)}]);
 for(const x of walk(path.join(__dirname,'template')))
  await gh(token,`/repos/${login}/${name}/contents/${x.p}`,'PUT',{message:'add '+x.p,content:fs.readFileSync(x.f).toString('base64'),branch:repo.default_branch});
 return {repo:`${login}/${name}`,branch:repo.default_branch}}));
app.post('/api/render',wrap(async q=>{
 const {repo,branch,renderKey,yemotKey,provider,model,aiKey,plan}=q.body;
 if(!sess(q).token||!String(repo).startsWith(sess(q).login+'/'))throw new Error('repo לא תקין');
 const o=await rd(renderKey,'/owners?limit=1');const ownerId=o[0]?.owner?.id;if(!ownerId)throw new Error('לא נמצא workspace ב-Render');
 const envVars=[['AI_PROVIDER',provider],['AI_MODEL',model],['AI_KEY',aiKey]].map(([key,value])=>({key,value}));
 const r=await rd(renderKey,'/services','POST',{type:'web_service',name:repo.split('/')[1],ownerId,repo:'https://github.com/'+repo,branch:branch||'main',autoDeploy:'yes',envVars,
  serviceDetails:{runtime:'node',plan:plan==='starter'?'starter':'free',region:'frankfurt',envSpecificDetails:{buildCommand:'npm install',startCommand:'node server.js'}}});
 const id=r.service?.id;if(!id)throw new Error('Render: לא התקבל מזהה שירות');
 return {serviceId:id,dashboardUrl:r.service.dashboardUrl,url:r.service.serviceDetails?.url||null}}));
app.post('/api/status',wrap(async q=>{
 const {renderKey,serviceId}=q.body;
 const sv=await rd(renderKey,'/services/'+encodeURIComponent(serviceId));
 const url=sv.serviceDetails?.url||null;let deploy=null;
 try{const d=await rd(renderKey,`/services/${encodeURIComponent(serviceId)}/deploys?limit=1`);deploy=d[0]?.deploy?.status||d[0]?.status||null}catch{}
 const failed=['build_failed','update_failed','pre_deploy_failed','canceled'].includes(deploy);
 let up=false;
 if(url&&!failed){try{const r=await fetch(url+'/health',{signal:AbortSignal.timeout(8000)});up=r.ok&&(await r.json()).ok===true}catch{}}
 return {url,deploy,failed,up,dashboardUrl:sv.dashboardUrl}}));
app.post('/api/yemot',wrap(async q=>{
 const {yemotKey,ext,url}=q.body;
 if(!/^\d{1,4}$/.test(String(ext)))throw new Error('מספר שלוחה לא תקין');
 if(!URLRE.test(String(url)))throw new Error('url');
 const link=url+'/ivr';
 await ym('UpdateExtension',{token:yemotKey,path:'ivr2:'+ext,type:'api',api_link:link,api_hangup_send:'no'});
 const t=await ym('GetTextFile',{token:yemotKey,what:`ivr2:${ext}/ext.ini`});
 if(!String(t.contents||'').includes(link))throw new Error('השלוחה עודכנה אך ext.ini לא מכיל את הכתובת — בדקו ידנית');
 return {link}}));
app.post('/api/selftest',wrap(async q=>{
 const url=String(q.body.url||'');if(!URLRE.test(url))throw new Error('url');
 const a=await (await fetch(url+'/selftest',{signal:AbortSignal.timeout(20000)})).json();
 const id='t'+Date.now();
 const t=await (await fetch(`${url}/ivr?ApiCallId=${id}&ApiPhone=0500000000&ApiDID=0000&ApiExtension=0&ApiEnterID=1`,{signal:AbortSignal.timeout(20000)})).text();
 return {ai:!!a.ok,ivr:t.startsWith('read=')}}));
app.listen(E.PORT||3000);
