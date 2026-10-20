import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

const base = process.env.SYNCSPACE_URL ?? 'http://localhost:3001';
const email = process.env.SYNCSPACE_EMAIL;
const password = process.env.SYNCSPACE_PASSWORD;
const documentId = process.env.SYNCSPACE_DOCUMENT_ID;
const samples = Number(process.env.SYNCSPACE_BENCH_SAMPLES ?? 1000);
if (!email || !password || !documentId) throw new Error('Set SYNCSPACE_EMAIL, SYNCSPACE_PASSWORD, and SYNCSPACE_DOCUMENT_ID.');

const login = await fetch(`${base}/api/auth/login`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({email,password}) });
if (!login.ok) throw new Error(`Login failed with HTTP ${login.status}.`);
const cookie = login.headers.getSetCookie().find(value=>value.startsWith('syncspace_session='))?.split(';',1)[0];
if (!cookie) throw new Error('The server did not return the session cookie.');
const origin = new URL(base).origin;
class AuthenticatedWebSocket extends WebSocket {
  constructor(url, protocols) { super(url, protocols, {headers:{Cookie:cookie,Origin:origin}}); }
}
const wsBase = base.replace(/^http:/,'ws:').replace(/^https:/,'wss:');
const left = new Y.Doc(); const right = new Y.Doc();
const leftProvider = new WebsocketProvider(`${wsBase}/collaboration`,documentId,left,{WebSocketPolyfill:AuthenticatedWebSocket});
const rightProvider = new WebsocketProvider(`${wsBase}/collaboration`,documentId,right,{WebSocketPolyfill:AuthenticatedWebSocket});
const waitSynced = provider => new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Timed out waiting for Yjs sync.')),15000);
  provider.on('sync',synced=>{if(synced){clearTimeout(timeout);resolve();}});
});
await Promise.all([waitSynced(leftProvider),waitSynced(rightProvider)]);
const latencies=[]; let failures=0;
for(let i=0;i<samples;i++){
  const token=`bench-${i}-`;
  let started=0;
  const visible=new Promise(resolve=>{
    const timeout=setTimeout(()=>{failures++;resolve(null);},10000);
    const check=()=>{if(right.getText('content').toString().includes(token)){clearTimeout(timeout);right.off('update',check);resolve(performance.now());}};
    right.on('update',check);
    started=performance.now();
    left.getText('content').insert(0,token);
  });
  const end=await visible;
  if(end!==null)latencies.push(Math.max(0,end-started));
}
leftProvider.destroy();rightProvider.destroy();left.destroy();right.destroy();
latencies.sort((a,b)=>a-b);
const percentile=p=>latencies.length?latencies[Math.min(latencies.length-1,Math.ceil(p*latencies.length)-1)]:null;
process.stdout.write(JSON.stringify({target:base,documentId,requestedSamples:samples,observedSamples:latencies.length,failures,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:latencies.length>=10000?percentile(.99):null,clock:'single-process performance.now; edit creation to receiving Y.Doc update'},null,2)+'\n');
