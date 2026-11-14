import {createHash,createPublicKey,randomBytes,timingSafeEqual,verify} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';

const MAX_FAILURES=5,LOCK_MS=15*60_000,MAX_TRACKED=10_000,KEY_REFRESH_MS=60_000;
const digest=text=>createHash('sha256').update(text).digest();
const home=name=>join(homedir(),'.agent-monitor',name);

/** The remote-access password: the AGENT_MONITOR_PASSWORD variable, or the first line of ~/.agent-monitor/password. */
export function readPassword(file=home('password')){
 if(process.env.AGENT_MONITOR_PASSWORD)return process.env.AGENT_MONITOR_PASSWORD;
 try{return existsSync(file)?readFileSync(file,'utf8').replace(/^﻿/,'').split(/\r?\n/)[0].trim():'';}catch{return '';}
}

/** The secret machines share to read each other's summaries: the first line of ~/.agent-monitor/peer-secret. Short ones are ignored. */
export function readSecret(file=home('peer-secret')){
 try{const secret=existsSync(file)?readFileSync(file,'utf8').replace(/^﻿/,'').split(/\r?\n/)[0].trim():'';return secret.length>=16?secret:'';}catch{return '';}
}
/** The secret for a machine that shares: the one on file, or a new random one written there. Returns {secret, created, file}. */
export function ensureSecret(file=home('peer-secret')){
 const existing=readSecret(file);
 if(existing)return {secret:existing,created:false,file};
 const secret=randomBytes(24).toString('hex');
 mkdirSync(dirname(file),{recursive:true});
 writeFileSync(file,`${secret}\n`,{mode:0o600});
 return {secret,created:true,file};
}
export const isLoopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
/** Whether a request from another machine carries the shared secret. With no secret set, nothing passes. */
export const makeSecretCheck=secret=>given=>Boolean(secret)&&typeof given==='string'&&timingSafeEqual(digest(given),digest(secret));

/** Cloudflare Access settings from ~/.agent-monitor/access.json: {"team": "...", "aud": "...", "emails": ["..."]}. */
export function readAccess(file=home('access.json')){
 try{
  if(!existsSync(file))return null;
  const {team,aud,emails}=JSON.parse(readFileSync(file,'utf8').replace(/^﻿/,''));
  if(!team||!aud)return null;
  const host=String(team).replace(/^https?:\/\//,'').replace(/\/.*$/,'');
  return {issuer:`https://${host.includes('.')?host:`${host}.cloudflareaccess.com`}`,aud:String(aud),emails:(emails??[]).map(email=>String(email).toLowerCase())};
 }catch{return null;}
}

const fetchKeys=async issuer=>(await (await fetch(`${issuer}/cdn-cgi/access/certs`)).json()).keys??[];
const decode=part=>JSON.parse(Buffer.from(part,'base64url').toString());

/** Checks the signed token Cloudflare Access attaches to each request it lets through. */
function makeAccessCheck({issuer,aud,emails},now,loadKeys){
 const keys=new Map();
 let loadedAt=-Infinity;
 async function keyFor(kid){
  if(!keys.has(kid)&&now()-loadedAt>KEY_REFRESH_MS){
   loadedAt=now();
   try{for(const jwk of await loadKeys(issuer))keys.set(jwk.kid,createPublicKey({key:jwk,format:'jwk'}));}catch{}
  }
  return keys.get(kid);
 }
 return async token=>{
  try{
   const [head,body,signature]=String(token).split('.');
   const {alg,kid}=decode(head),claims=decode(body);
   if(alg!=='RS256')return false;
   const key=await keyFor(kid);
   if(!key||!verify('RSA-SHA256',Buffer.from(`${head}.${body}`),key,Buffer.from(signature,'base64url')))return false;
   if(claims.iss!==issuer||![].concat(claims.aud).includes(aud)||!(claims.exp*1000>now()))return false;
   return !emails.length||emails.includes(String(claims.email??'').toLowerCase());
  }catch{return false;}
 };
}

/**
 * Decides whether a request may see the dashboard: 'ok', 'login', 'locked', 'denied' or 'closed'.
 * Requests made on this computer pass. Requests relayed by a proxy or tunnel need a valid Cloudflare Access token or the password, and are refused when neither is set up.
 */
export function makeGate({password='',access=null,now=Date.now,loadKeys=fetchKeys}={}){
 const expected=password?digest(password):null,failures=new Map();
 const signedIn=access?makeAccessCheck(access,now,loadKeys):null;
 return async headers=>{
  // A tunnel connects from this computer too, so the address cannot tell a visitor apart; the headers a proxy adds can.
  const client=headers['cf-connecting-ip']??headers['x-forwarded-for']??headers['x-real-ip']??(headers['cf-ray']||headers.forwarded||headers['x-forwarded-host']?'proxy':null);
  if(client==null)return 'ok';
  if(signedIn&&headers['cf-access-jwt-assertion']&&await signedIn(headers['cf-access-jwt-assertion']))return 'ok';
  if(!expected)return signedIn?'denied':'closed';
  const record=failures.get(client);
  if(record?.until>now())return 'locked';
  const given=/^Basic\s+(.+)$/i.exec(headers.authorization??'')?.[1];
  if(given==null)return 'login';
  const secret=Buffer.from(given,'base64').toString().replace(/^[^:]*:/,'');
  if(timingSafeEqual(digest(secret),expected)){failures.delete(client);return 'ok';}
  if(failures.size>=MAX_TRACKED)failures.clear();
  const count=(record?.count??0)+1;
  failures.set(client,count>=MAX_FAILURES?{count:0,until:now()+LOCK_MS}:{count,until:0});
  return 'login';
 };
}
