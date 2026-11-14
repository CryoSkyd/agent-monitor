import {execFile} from 'node:child_process';

const FIELDS='number,title,headRefName,state,createdAt,mergedAt,closedAt,labels,url';

const DETAIL_FIELDS='number,title,body,state,isDraft,url,headRefName,baseRefName,additions,deletions,changedFiles,files,reviews,comments,statusCheckRollup,reviewDecision,createdAt,mergedAt';
const FILE_LINES=800;

/** Splits a unified diff into files, keeping each file's hunks and cutting long ones. */
export function splitDiff(diff,maxLines=FILE_LINES){
 const files=[];
 for(const block of String(diff).replace(/\r/g,'').split(/^(?=diff --git )/m)){
  if(!block.startsWith('diff --git '))continue;
  const lines=block.split('\n');
  const path=/^\+\+\+ b\/(.*)$/m.exec(block)?.[1]??/^diff --git a\/.* b\/(.*)$/.exec(lines[0])?.[1]??'';
  const start=lines.findIndex(line=>line.startsWith('@@'));
  const body=start<0?[]:lines.slice(start);
  if(body.at(-1)==='')body.pop();
  files.push({path,lines:body.slice(0,maxLines),more:Math.max(0,body.length-maxLines)});
 }
 return files;
}

function shapeDetail(pr,diff){
 const hunks=new Map(splitDiff(diff).map(file=>[file.path,file]));
 const when=text=>Date.parse(text)||0;
 const notes=[
  ...(pr.reviews??[]).map(review=>({who:review.author?.login??'',kind:String(review.state??'').toLowerCase().replace(/_/g,' '),body:review.body??'',at:when(review.submittedAt)})),
  ...(pr.comments??[]).map(comment=>({who:comment.author?.login??'',kind:'comment',body:comment.body??'',at:when(comment.createdAt)})),
 ].filter(note=>note.body.trim()||note.kind!=='commented').sort((a,b)=>a.at-b.at);
 return {
  number:pr.number,title:pr.title,body:pr.body??'',state:pr.isDraft&&pr.state==='OPEN'?'DRAFT':pr.state,url:pr.url,branch:pr.headRefName,base:pr.baseRefName,
  additions:pr.additions,deletions:pr.deletions,decision:String(pr.reviewDecision??'').toLowerCase().replace(/_/g,' '),created:when(pr.createdAt),merged:when(pr.mergedAt),
  checks:(pr.statusCheckRollup??[]).map(check=>({name:check.name??check.context??'',result:String(check.conclusion||check.state||check.status||'').toLowerCase()})),
  notes,
  files:(pr.files??[]).map(file=>({path:file.path,additions:file.additions,deletions:file.deletions,lines:hunks.get(file.path)?.lines??[],more:hunks.get(file.path)?.more??0})),
 };
}

/** Polls the project's pull requests through the gh CLI; stays empty when gh is missing or signed out. */
export class PullRequests{
 list=[];
 error='';
 #details=new Map();
 constructor(cwd,{intervalMs=60_000,enabled=true}={}){Object.assign(this,{cwd,intervalMs,enabled});}
 start(onChange){
  if(!this.enabled)return;
  const tick=()=>execFile('gh',['pr','list','--state','all','--limit','60','--json',FIELDS],{cwd:this.cwd,timeout:20_000,windowsHide:true,maxBuffer:1<<24},(error,stdout)=>{
   if(error){this.error=String(error.message).split('\n')[0];return;}
   try{
    this.list=JSON.parse(stdout).map(pr=>({number:pr.number,title:pr.title,branch:pr.headRefName,state:pr.state,created:Date.parse(pr.createdAt)||0,merged:Date.parse(pr.mergedAt)||0,closed:Date.parse(pr.closedAt)||0,labels:(pr.labels??[]).map(label=>label.name),url:pr.url}));
    this.error='';
    onChange();
   }catch{}
  });
  tick();
  this.timer=setInterval(tick,this.intervalMs);
 }
 /** One pull request with its diff, fetched when someone opens it and kept for half a minute. */
 detail(number){
  if(!this.enabled)return Promise.reject(new Error('Pull requests are switched off'));
  const known=this.#details.get(number);
  if(known&&Date.now()-known.at<30_000)return known.promise;
  const gh=args=>new Promise((resolve,reject)=>execFile('gh',args,{cwd:this.cwd,timeout:30_000,windowsHide:true,maxBuffer:1<<26},(error,stdout)=>error?reject(error):resolve(stdout)));
  // GitHub refuses very large diffs; the file list still comes back without them.
  const promise=Promise.all([gh(['pr','view',String(number),'--json',DETAIL_FIELDS]),gh(['pr','diff',String(number)]).catch(()=>'')]).then(([json,diff])=>shapeDetail(JSON.parse(json),diff));
  this.#details.set(number,{at:Date.now(),promise});
  promise.catch(()=>this.#details.delete(number));
  return promise;
 }
 stop(){clearInterval(this.timer);}
}
