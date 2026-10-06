import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.ZMANIM_DATA_DIR || path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'searches.json');
let state = { callers:{} };
let loaded = false;
let writeQueue = Promise.resolve();

function normalizePhone(phone) {
  const value=String(phone||'').trim();
  return value || 'unknown';
}
function cleanLocation(location) {
  return String(location||'').replace(/[.。]/g,'').replace(/\s+/g,' ').trim();
}
async function ensureLoaded() {
  if (loaded) return;
  try {
    const raw=await fs.readFile(DATA_FILE,'utf8');
    const parsed=JSON.parse(raw);
    if (parsed && typeof parsed==='object' && parsed.callers && typeof parsed.callers==='object') state=parsed;
  } catch {}
  loaded=true;
}
async function persist() {
  await fs.mkdir(DATA_DIR,{recursive:true});
  const tmp=DATA_FILE+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(state),'utf8');
  await fs.rename(tmp,DATA_FILE);
}
function enqueueWrite(mutator) {
  writeQueue=writeQueue.then(async()=>{
    await ensureLoaded();
    await mutator();
    await persist();
  }).catch(error=>console.error('[ZMANIM_STORE_WRITE_FAIL]',error?.message||error));
  return writeQueue;
}
export async function saveLastSearch(phone,result) {
  await enqueueWrite(async()=>{
    const key=normalizePhone(phone);
    const caller=state.callers[key]||{saved:[],lastSearch:null};
    caller.lastSearch={
      location:cleanLocation(result?.location),
      items:Array.isArray(result?.items)?result.items.slice(0,10):[],
      fetchedAt:result?.fetchedAt||new Date().toISOString()
    };
    state.callers[key]=caller;
  });
}
export async function saveSearch(phone,location) {
  const normalized=cleanLocation(location);
  if(!normalized) return;
  await enqueueWrite(async()=>{
    const key=normalizePhone(phone);
    const caller=state.callers[key]||{saved:[],lastSearch:null};
    const exists=caller.saved.find(x=>cleanLocation(x.location)===normalized);
    if(!exists) caller.saved.unshift({location:normalized,savedAt:new Date().toISOString()});
    else {
      exists.savedAt=new Date().toISOString();
      caller.saved=[exists,...caller.saved.filter(x=>x!==exists)];
    }
    caller.saved=caller.saved.slice(0,20);
    state.callers[key]=caller;
  });
}
export async function getSavedSearches(phone) {
  await ensureLoaded();
  const key=normalizePhone(phone);
  return Array.isArray(state.callers[key]?.saved)?state.callers[key].saved.slice(0,20):[];
}
export async function getLastSearch(phone) {
  await ensureLoaded();
  const key=normalizePhone(phone);
  const value=state.callers[key]?.lastSearch;
  if(!value?.location || !Array.isArray(value.items) || !value.items.length) return null;
  return {location:value.location,items:value.items,fetchedAt:value.fetchedAt||null};
}
