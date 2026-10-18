// Explicit capability construction only. No environment, file, account or key-refresh access.
export function createPushplusTransport({enabled=false,queryEnabled=false,token,accessKey,request=fetch,simulated=false}={}) {
  const sendEnabled=enabled===true&&typeof token==='string'&&token.trim().length>0;
  const resultEnabled=sendEnabled&&queryEnabled===true&&typeof accessKey==='string'&&accessKey.trim().length>0;
  const decode=async response=>{if(response.status>=500)return {code:500};let json;try{json=await response.json();}catch{return {code:null};}return json&&typeof json==='object'?json:{code:null};};
  return {
    enabled:sendEnabled,queryEnabled:resultEnabled,simulated,
    async send({title,content,template='txt',signal}){
      if(!sendEnabled)throw new Error('发送能力未启用');
      const result=await decode(await request('https://www.pushplus.plus/send',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,title,content,template:['txt','html'].includes(template)?template:'txt',channel:'wechat'}),signal}));
      return {code:result.code,shortCode:typeof result.data==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(result.data)?result.data:null};
    },
    async query({shortCode,signal}){
      if(!resultEnabled)throw new Error('结果查询能力未启用');
      const result=await decode(await request('https://www.pushplus.plus/api/open/message/sendMessageResult?shortCode='+encodeURIComponent(shortCode),{method:'GET',redirect:'error',headers:{'access-key':accessKey},signal}));
      return {code:result.code,status:result.data?.status};
    },
  };
}
