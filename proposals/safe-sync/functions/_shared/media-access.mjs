export function privateMediaPath(value,base){
  if(!value)return null;
  const url=new URL(value);
  const expected=new URL(base);
  const prefix='/storage/v1/object/public/article-media/';
  if(url.origin!==expected.origin||!url.pathname.startsWith(prefix))throw Error('unmanaged_media_url');
  const path=decodeURIComponent(url.pathname.slice(prefix.length));
  if(!path||path.split('/').some(p=>p==='..'||p==='.'||!p)||path.includes('\\'))throw Error('invalid_media_path');
  return path;
}
export function mediaHandler(io){
  return async request=>{
    const origin=request.headers.get('origin');
    const allowed=origin==='https://sugano-crypto.github.io';
    const cors=allowed?{'access-control-allow-origin':origin,'vary':'Origin',
      'access-control-allow-headers':'authorization, apikey, content-type, x-client-info',
      'access-control-allow-methods':'POST, OPTIONS'}:{};
    const json=(body,status)=>new Response(JSON.stringify(body),{status,headers:{...cors,'content-type':'application/json','cache-control':'no-store'}});
    if(origin&&!allowed)return json({error:'origin_not_allowed'},403);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if(!token)return json({error:'unauthorized'},401);
    let user;
    try{user=await io.user(token);}catch{return json({error:'unauthorized'},401);}
    if(!user)return json({error:'unauthorized'},401);
    try{if(!await io.ready())return json({error:'access_controls_not_ready'},503);}catch{return json({error:'access_controls_not_ready'},503);}
    let body;
    try{const text=await request.text();if(text.length>1024)throw Error();body=JSON.parse(text);if(!/^\d+$/.test(String(body?.article_id||'')))throw Error();}
    catch{return json({error:'invalid_request'},400);}
    try{
      // This query runs with the caller's JWT and the protected articles RLS.
      const article=await io.article(token,String(body.article_id));
      if(!article)return json({error:'article_unavailable'},404);
      const result={cover:null,audio:null,expires_in:300};
      for(const kind of ['cover','audio']){
        const path=privateMediaPath(article[`notion_${kind}_url`],io.base);
        if(path)result[kind]=await io.sign(path,300);
      }
      return json(result,200);
    }catch{return json({error:'media_unavailable'},502);}
  };
}
