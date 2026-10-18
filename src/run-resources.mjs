import {AsyncLocalStorage} from 'node:async_hooks';
import {serialize,deserialize} from 'node:v8';

// Acquisition and parsing may be shared inside one source check only. Identity,
// qualification and matching remain per job. A new check always fetches afresh.
const scope=new AsyncLocalStorage();
export const withRunResources=work=>scope.run({entries:new Map(),bytes:0},work);
export async function reuseRunResource(kind,key,read,{cacheable=()=>true}={}) {
 const state=scope.getStore();if(!state)return read();
 const id=JSON.stringify([kind,key]),prior=state.entries.get(id);
 if(prior)return deserialize(await prior);
 if(state.entries.size>=128)return read();
 const pending=Promise.resolve().then(read).then(value=>{
  const bytes=serialize(value);
  if(!cacheable(value)||bytes.length>8*1024*1024||state.bytes+bytes.length>32*1024*1024)state.entries.delete(id);
  else state.bytes+=bytes.length;
  return bytes;
 });
 state.entries.set(id,pending);
 try{return deserialize(await pending);}catch(error){state.entries.delete(id);throw error;}
}
