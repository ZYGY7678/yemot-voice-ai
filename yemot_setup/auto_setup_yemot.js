#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
const args=process.argv.slice(2),token=(args[0]||process.env.YEMOT_API_KEY||'').trim(),publicUrl=((args[1]||process.env.PUBLIC_BASE_URL||'').trim()).replace(/\/$/,'')||'',extNumber=(args[2]||'1').trim();
if(!token||!publicUrl){console.log('Usage: node auto_setup_yemot.js <YEMOT_TOKEN> <RENDER_URL> [EXTENSION_NUMBER]');process.exit(1)}
const BASE_URL='https://www.call2all.co.il/ym/api';
async function apiRequest(endpoint,params={}){const qs=new URLSearchParams({token,...params}),r=await fetch(BASE_URL+'/'+endpoint+'?'+qs),t=await r.text();try{return JSON.parse(t)}catch{return{raw:t}}}
async function uploadFile(remotePath,localPath){if(!fs.existsSync(localPath))return null;const b=fs.readFileSync(localPath),f=new FormData();f.append('file',new Blob([b],{type:'audio/wav'}),path.basename(localPath));const r=await fetch(BASE_URL+'/UploadFile?token='+encodeURIComponent(token)+'&path='+encodeURIComponent(remotePath)+'&convertAudio=0',{method:'POST',body:f}),t=await r.text();try{return JSON.parse(t)}catch{return{raw:t}}}
async function run(){const extConfig={type:'api',api_link:publicUrl+'/yemot',api_wait:'yes',api_wait_play:'yes',api_wait_answer_music_on_hold:'yes',api_wait_answer_music_on_hold_different:'M0000',api_timeout:'60',tts_rate:'2',rate:'2'};console.log('Configuring Yemot extension '+extNumber);console.log(await apiRequest('UpdateExtension',{path:'ivr2:/'+extNumber,...extConfig}));const dir=path.dirname(new URL(import.meta.url).pathname);console.log(await uploadFile('ivr2:'+extNumber+'/M0000.wav',path.join(dir,'M0000.wav')));console.log(await uploadFile('ivr2:'+extNumber+'/M1000.wav',path.join(dir,'M1000.wav')));console.log('Done');}
run().catch(e=>{console.error(e);process.exit(1)});