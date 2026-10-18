import {collectPages,plain,sha256} from './sync-core.mjs';
const DATABASE_ID='3db36098fd3680e596dcfaa1715d566f';
const EXPECTED_PROJECT='bicqctaxvponqbzjsjbw';
const MIME={
  cover:{'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp'},
  audio:{'audio/mpeg':'mp3','audio/mp3':'mp3','audio/mp4':'m4a','audio/x-m4a':'m4a','audio/aac':'aac','audio/ogg':'ogg','audio/wav':'wav','audio/x-wav':'wav','audio/webm':'webm'},
};
// Explicit hostnames only: configure the actual Notion CDN hosts during staging.
export function createIO({env,createClient,fetchImpl=fetch,pauseImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const allowedMediaHosts=new Set(env('SYNC_MEDIA_HOSTS').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
  const base=env('SUPABASE_URL');
  if(base!==`https://${EXPECTED_PROJECT}.supabase.co`||!env('NOTION_TOKEN')||!env('SUPABASE_SERVICE_ROLE_KEY'))throw Error('invalid_server_configuration');
  const sb=createClient(base,env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
  const started=Date.now();let lockToken;let lastNotion=0;
  function deadline(){if(Date.now()-started>100_000)throw Error('run_budget_exceeded');}
  const pause=pauseImpl;
  async function request(url,options={},notion=true){
    for(let attempt=0;attempt<3;attempt++){
      deadline();
      if(notion){const wait=360-(Date.now()-lastNotion);if(wait>0)await pause(wait);lastNotion=Date.now();}
      const response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(12_000)});
      if(notion&&[429,502,503,504].includes(response.status)&&attempt<2){
        const header=response.headers.get('retry-after');
        const delay=header&&Number.isFinite(Number(header))?Number(header)*1000:700*2**attempt;
        await response.body?.cancel();
        if(delay<0||delay>5000)throw Error('notion_retry_later');
        await pause(delay);continue;
      }
      if(!response.ok){await response.body?.cancel();throw Error(notion?`notion_http_${response.status}`:`media_http_${response.status}`);}
      return response;
    }
    throw Error('notion_unavailable');
  }
  async function notion(path,body){
    const res=await request(`https://api.notion.com/v1/${path}`,{
      method:body?'POST':'GET',headers:{Authorization:`Bearer ${env('NOTION_TOKEN')}`,'Notion-Version':'2022-06-28','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    // Headers and signed URLs are never logged.
    return await res.json();
  }
  async function rpc(name,args={}){
    deadline();const {data,error}=await sb.rpc(name,args).abortSignal(AbortSignal.timeout(12_000));
    if(error)throw Error(`database_rpc_failed:${name}`);return data;
  }
  async function blocks(id,depth=0){
    if(depth>15)throw Error('block_depth_limit');
    const rows=await collectPages(cursor=>notion(`blocks/${encodeURIComponent(id)}/children?page_size=100${cursor?'&start_cursor='+encodeURIComponent(cursor):''}`));
    for(const block of rows)if(block.has_children)block.children=await blocks(block.id,depth+1);
    return rows;
  }
  return {
    databaseId:DATABASE_ID,
    errorCode(error){
      const code=String(error?.message||'sync_failed');
      // Keep locally generated codes; never return raw upstream messages.
      return /^[a-z][a-z0-9_:.-]{0,160}$/i.test(code)?code:'upstream_failure';
    },
    schema:()=>notion(`databases/${DATABASE_ID}`),
    pages:()=>collectPages(cursor=>notion(`databases/${DATABASE_ID}/query`,{page_size:100,...(cursor?{start_cursor:cursor}:{})})),
    page:id=>notion(`pages/${encodeURIComponent(id)}`),
    blocks,
    async richText(page,name){
      const prop=page.properties?.[name];
      if(!prop||prop.type!=='rich_text')throw Error('invalid_body_property');
      // Retrieve long properties through the property endpoint, avoiding Notion's inline truncation.
      if((prop.rich_text||[]).length<25)return plain(prop.rich_text);
      const items=await collectPages(cursor=>notion(`pages/${encodeURIComponent(page.id)}/properties/${encodeURIComponent(decodeURIComponent(prop.id))}?page_size=100${cursor?'&start_cursor='+encodeURIComponent(cursor):''}`));
      return plain(items.map(x=>x.rich_text));
    },
    async existing(){
      const all=[];
      for(let from=0;;from+=500){
        deadline();
        const {data,error}=await sb.from('articles').select('id,article_id,notion_page_id,status,notion_cover_url,notion_audio_url').order('id').range(from,from+499).abortSignal(AbortSignal.timeout(12_000));
        if(error)throw Error('articles_read_failed');all.push(...data);if(data.length<500)return all;
      }
    },
    state:id=>rpc('sc_sync_state',{p_article_id:id}),
    async acquire(){
      lockToken=crypto.randomUUID();
      const acquired=await rpc('sc_sync_acquire',{p_token:lockToken});return acquired?lockToken:null;
    },
    release:token=>rpc('sc_sync_release',{p_token:token}),
    commit:async(article,state)=>{deadline();await rpc('sc_sync_commit',{p_token:lockToken,p_article:article,p_state:state});},
    async media(url,id,kind,apply){
      const source=new URL(url);
      if(source.protocol!=='https:'||source.username||source.password||source.port||!allowedMediaHosts.has(source.hostname.toLowerCase()))throw Error('media_host_not_allowed');
      const response=await request(source.toString(),{},false);
      const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      const ext=MIME[kind][type];
      if(!ext){await response.body?.cancel();throw Error('unsupported_media_type');}
      const max=kind==='cover'?8*1024*1024:40*1024*1024;
      if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw Error('media_too_large');}
      const reader=response.body?.getReader();if(!reader)throw Error('empty_media');
      let size=0;const chunks=[];
      try{while(true){deadline();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw Error('media_too_large');chunks.push(value);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}
      if(!size)throw Error('empty_media');
      const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
      const digest=await sha256(bytes);
      const path=`safe-v1/${id}/${kind}-${digest}.${ext}`;
      if(apply){
        deadline();
        // Content-addressed files cannot overwrite a currently playing file.
        const {data:listed,error:listError}=await sb.storage.from('article-media').list(`safe-v1/${id}`,{search:`${kind}-${digest}.${ext}`,limit:2});
        if(listError)throw Error('storage_list_failed');
        if(!listed.some(x=>x.name===`${kind}-${digest}.${ext}`)){
          const {error}=await sb.storage.from('article-media').upload(path,bytes,{contentType:type,cacheControl:'31536000',upsert:false});
          if(error)throw Error('storage_upload_failed');
        }
      }
      const {data}=sb.storage.from('article-media').getPublicUrl(path);
      if(!data.publicUrl)throw Error('storage_url_failed');return data.publicUrl;
    },
  };
}
