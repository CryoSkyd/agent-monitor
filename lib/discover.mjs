import {readdirSync,statSync} from 'node:fs';

/** Helpers the agent adapters share for finding transcript files. */
export const fresh=(path,cutoff)=>{try{return statSync(path).mtimeMs>=cutoff;}catch{return false;}};
export const list=dir=>{try{return readdirSync(dir,{withFileTypes:true});}catch{return[];}};
