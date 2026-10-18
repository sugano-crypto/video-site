import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {mediaHandler} from '../_shared/media-access.mjs';
const env=(name:string):string=>Deno.env.get(name)||'';
Deno.serve(async(request:Request)=>{
 const base=env('SUPABASE_URL');
 if(base!=='https://bicqctaxvponqbzjsjbw.supabase.co'||!env('SUPABASE_SERVICE_ROLE_KEY')||!env('SUPABASE_ANON_KEY'))return new Response('Unavailable',{status:503});
 const options={auth:{persistSession:false,autoRefreshToken:false}};
 const server=createClient(base,env('SUPABASE_SERVICE_ROLE_KEY'),options);
 const handler=mediaHandler({base,
   ready:async()=>{const {data,error}=await server.rpc('sc_sync_access_ready');return !error&&data===true;},
   user:async(token:string)=>{const {data,error}=await server.auth.getUser(token);return error?null:data.user;},
   article:async(token:string,id:string)=>{
     const member=createClient(base,env('SUPABASE_ANON_KEY'),{...options,global:{headers:{Authorization:`Bearer ${token}`}}});
     const {data,error}=await member.from('articles').select('notion_cover_url,notion_audio_url').eq('id',id).maybeSingle().abortSignal(AbortSignal.timeout(10000));
     if(error)throw Error('article_lookup_failed');return data;
   },
   sign:async(path:string,ttl:number)=>{const {data,error}=await server.storage.from('article-media').createSignedUrl(path,ttl);if(error)throw Error('sign_failed');return data.signedUrl;}
 });
 return handler(request);
});
