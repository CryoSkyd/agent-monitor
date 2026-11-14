import {spawn} from 'node:child_process';
import {cpus,freemem,totalmem} from 'node:os';

const HISTORY=600;

function busyAndTotal(){
 let busy=0,total=0;
 for(const {times} of cpus()){
  const all=times.user+times.nice+times.sys+times.idle+times.irq;
  total+=all;busy+=all-times.idle;
 }
 return [busy,total];
}

/** Samples machine CPU and memory once a second and keeps ten minutes of history. */
export class SystemMonitor{
 history=[];
 #counter=null;
 #last=busyAndTotal();
 #child=null;
 start(onSample){
  // Task Manager shows "% Processor Utility"; os.cpus() gives "% Processor Time", which reads lower on CPUs that boost clock speed.
  if(process.platform==='win32')this.#watchCounter();
  this.timer=setInterval(()=>{
   const [busy,total]=busyAndTotal(),[lastBusy,lastTotal]=this.#last;
   this.#last=[busy,total];
   const fromTimes=total>lastTotal?100*(busy-lastBusy)/(total-lastTotal):0;
   const sample={t:Date.now(),cpu:Math.round(Math.min(100,this.#counter??fromTimes)*10)/10,memUsed:totalmem()-freemem(),memTotal:totalmem(),cores:cpus().length};
   this.history.push([sample.t,sample.cpu]);
   if(this.history.length>HISTORY)this.history.shift();
   onSample(sample);
  },1000);
 }
 #watchCounter(){
  try{
   this.#child=spawn('typeperf',['\\Processor Information(_Total)\\% Processor Utility','-si','1'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
   this.#child.stdout.on('data',chunk=>{
    const value=/,"(\d+(?:[.,]\d+)?)"\s*$/m.exec(chunk.toString().trim())?.[1];
    if(value!=null)this.#counter=Number(value.replace(',','.'));
   });
   const drop=()=>{this.#counter=null;this.#child=null;};
   this.#child.on('error',drop);
   this.#child.on('exit',drop);
  }catch{this.#counter=null;}
 }
 stop(){clearInterval(this.timer);this.#child?.kill();}
}
