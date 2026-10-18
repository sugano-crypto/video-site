import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authorized,collectPages,metadata,fingerprint,notionPageId,syncArticles,makeHandler} from '../functions/_shared/sync-core.mjs';
import {createIO} from '../functions/_shared/supabase-io.mjs';
const MASTER='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',CONTENT='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const prop=(type,value)=>({type,[type]:value});
const rt=s=>[{plain_text:s}];
function master(){return {id:MASTER,last_edited_time:'2026-10-18T01:00:00Z',properties:{
 記事ID:prop('rich_text',rt('TOPIC-20261018')),タイトル:prop('title',rt('10月18日号')),
 ステータス:prop('select',{name:'公開'}),公開区分:prop('select',{name:'有料'}),対象読者:prop('multi_select',[{name:'医師'}]),
 公開日:prop('date',{start:'2026-10-18'}),無料公開部分:prop('rich_text',rt('無料本文')),有料公開部分:prop('rich_text',rt('【記事見出し】\n有料本文')),
 Notion記事URL:prop('url',`https://www.notion.so/${CONTENT}`),音声データ:prop('files',[{file:{url:'https://cdn.example/audio.mp3'}}]),
}};}
function fixture(){
 const m=master(),c={id:CONTENT,last_edited_time:'2026-10-18T01:00:00Z',properties:{},cover:{external:{url:'https://cdn.example/cover.png'}}};
 const writes=[],uploads=[];let state=null;
 const old={article_id:'TOPIC-20261018',notion_page_id:CONTENT,notion_cover_url:'https://old/cover.png',notion_audio_url:'https://old/audio.mp3'};
 const io={databaseId:'3db36098fd3680e596dcfaa1715d566f',schema:async()=>({properties:m.properties}),pages:async()=>[m],existing:async()=>[old],state:async()=>state,
 page:async id=>id===MASTER?m:c,blocks:async()=>[{type:'paragraph',paragraph:{rich_text:rt('既存ブロック')}}],
 richText:async(p,k)=>p.properties[k].rich_text.map(r=>r.plain_text).join(''),
 media:async(url,id,kind,apply)=>{if(apply)uploads.push(kind);return `https://new/${kind}`;},
 commit:async(a,s)=>{writes.push(a);state=s;},errorCode:e=>e.message,acquire:async()=> 'token',release:async()=>{},
 };
 return {io,m,c,old,writes,uploads,setState:s=>state=s};
}
test('authentication rejects missing/public key and malformed short server secret',async()=>{
 const req=value=>new Request('https://local/',{method:'POST',headers:{'x-sync-secret':value}});
 assert.equal(await authorized(req('public-key'),'x'.repeat(40)),false);
 assert.equal(await authorized(req('x'.repeat(40)),'x'.repeat(40)),true);
 assert.equal(await authorized(req(''),'short'),false);
});
test('handler unauthorized and dry-run paths have zero writes; apply requires two gates',async()=>{
 const f=fixture();let made=0,locks=0;f.io.acquire=async()=>{locks++;return 'token';};
 const handler=makeHandler({secret:'s'.repeat(40),applyEnabled:false,ioFactory:()=>{made++;return f.io;}});
 assert.equal((await handler(new Request('https://local/',{method:'POST'}))).status,401);assert.equal(made,0);
 const req=body=>new Request('https://local/',{method:'POST',headers:{'x-sync-secret':'s'.repeat(40)},body:JSON.stringify(body)});
 const response=await handler(req({}));assert.equal(response.status,200);assert.equal((await response.json()).dry_run,true);
 assert.equal(locks,0);assert.deepEqual(f.writes,[]);assert.deepEqual(f.uploads,[]);
 assert.equal((await handler(req({dry_run:false}))).status,403);
 assert.equal((await handler(req({dry_run:'false'}))).status,400);
 assert.equal((await handler(req({article_id:'untrusted'}))).status,400);
});
test('empty database, wrong schema, duplicate ID and missing access fail before writes',async()=>{
 for(const mode of ['empty','schema','duplicate','access']){
  const f=fixture();if(mode==='empty')f.io.pages=async()=>[];
  if(mode==='schema')f.io.schema=async()=>({properties:{}});
  if(mode==='duplicate')f.io.pages=async()=>[f.m,structuredClone(f.m)];
  if(mode==='access')delete f.m.properties['公開区分'];
  await assert.rejects(()=>syncArticles(f.io,{apply:true}));assert.deepEqual(f.writes,[]);assert.deepEqual(f.uploads,[]);
 }
});
test('status type is supported; explicit non-public and missing source rows are never deleted',async()=>{
 const f=fixture();f.m.properties['ステータス']=prop('status',{name:'公開'});assert.equal(metadata(f.m).status,'公開');
 f.m.properties['ステータス'].status.name='下書き';
 const report=await syncArticles(f.io,{apply:true});assert.equal(report.deleted,0);assert.equal(report.attention[0].reason,'explicit_non_public');assert.deepEqual(f.writes,[]);
 const g=fixture();g.io.existing=async()=>[{article_id:'OTHER',notion_page_id:CONTENT}];
 assert.equal((await syncArticles(g.io)).attention[0].reason,'absent_from_source');
});
test('successful sync preserves source fields, block structure and priority of media',async()=>{
 const f=fixture();await syncArticles(f.io,{apply:true});const a=f.writes[0];
 assert.equal(a.body,'【記事見出し】\n有料本文');assert.equal(a.access_type,'有料');assert.equal(a.target_audience,'医師');assert.equal(a.notion_audio_url,'https://new/audio');assert.equal(a.notion_blocks[0].type,'paragraph');assert.deepEqual(f.uploads,['cover','audio']);
});
test('unchanged master+linked page skips body and media; force rechecks them',async()=>{
 const f=fixture();await syncArticles(f.io,{apply:true});f.writes.length=0;f.uploads.length=0;
 assert.equal((await syncArticles(f.io,{apply:true})).unchanged,1);assert.deepEqual(f.uploads,[]);assert.deepEqual(f.writes,[]);
 f.c.last_edited_time='2026-10-18T02:00:00Z';assert.equal((await syncArticles(f.io,{apply:true})).updated.length,1);
 assert.equal((await syncArticles(f.io,{apply:true,force:true})).updated.length,1);
});
test('media/body failures and edits during extraction retain existing article and fingerprint',async()=>{
 for(const mode of ['media','body','edit']){
  const f=fixture();
  if(mode==='media')f.io.media=async()=>{throw Error('download_failed');};
  if(mode==='body')f.io.blocks=async()=>{throw Error('notion_http_429');};
  if(mode==='edit')f.io.blocks=async()=>{f.m.last_edited_time='2026-10-18T03:00:00Z';return [];};
  const result=await syncArticles(f.io,{apply:true});assert.equal(result.errors.length,1);assert.equal(result.deleted,0);assert.deepEqual(f.writes,[]);assert.equal(await f.io.state(),null);
 }
});
test('missing media keeps old URLs and ownership conflicts prevent overwrite',async()=>{
 const f=fixture();delete f.c.cover;delete f.m.properties['音声データ'];await syncArticles(f.io,{apply:true});
 assert.equal(f.writes[0].notion_cover_url,f.old.notion_cover_url);assert.equal(f.writes[0].notion_audio_url,f.old.notion_audio_url);
 const g=fixture();g.old.notion_page_id=MASTER;assert.equal((await syncArticles(g.io,{apply:true})).errors[0].reason,'unowned_article_collision');assert.deepEqual(g.writes,[]);
});
test('pagination follows every cursor and refuses incomplete/repeating responses',async()=>{
 let calls=0;assert.deepEqual(await collectPages(async c=>{calls++;return c?{results:[2],has_more:false}:{results:[1],has_more:true,next_cursor:'next'};}),[1,2]);assert.equal(calls,2);
 await assert.rejects(()=>collectPages(async()=>({results:[],has_more:true,next_cursor:null})),/incomplete/);
 await assert.rejects(()=>collectPages(async()=>({results:[],has_more:true,next_cursor:'loop'})),/incomplete/);
});
test('Notion content ID comes from URL path, not a view/query ID',()=>{
 assert.equal(notionPageId(`https://www.notion.so/${CONTENT}?v=${MASTER.replaceAll('-','')}`),CONTENT);
 assert.throws(()=>notionPageId(`https://evil.example/${CONTENT}`));
});
test('lock contention returns 409; apply errors release the acquired lock',async()=>{
 const f=fixture();let releases=0;f.io.release=async()=>{releases++;};f.io.acquire=async()=>null;
 const handler=makeHandler({secret:'s'.repeat(40),applyEnabled:true,ioFactory:()=>f.io});
 const req=()=>new Request('https://local/',{method:'POST',headers:{'x-sync-secret':'s'.repeat(40)},body:'{"dry_run":false}'});
 assert.equal((await handler(req())).status,409);assert.equal(releases,0);
 f.io.acquire=async()=> 'token';f.io.pages=async()=>{throw Error('notion_http_503');};assert.equal((await handler(req())).status,502);assert.equal(releases,1);
});
function runtime({fetchImpl,storage}={}){
 const values={SUPABASE_URL:'https://bicqctaxvponqbzjsjbw.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-server-secret',NOTION_TOKEN:'test-notion-token',SYNC_MEDIA_HOSTS:'cdn.example'};
 return createIO({env:n=>values[n],createClient:()=>({storage:{from:()=>storage}}),pauseImpl:async()=>{},fetchImpl});
}
test('real media adapter blocks unlisted hosts, rejects bad MIME and keeps dry-run write-free',async()=>{
 const writes=[];const storage={list:async()=>({data:[],error:null}),upload:async(path)=>{writes.push(path);return {error:null};},getPublicUrl:path=>({data:{publicUrl:'https://storage.example/'+path}})};
 const io=runtime({storage,fetchImpl:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg'}})});
 await assert.rejects(()=>io.media('https://127.0.0.1/audio','TOPIC','audio',true),/host/);
 const url=await io.media('https://cdn.example/a.mp3','TOPIC','audio',false);assert.deepEqual(writes,[]);assert.match(url,/audio-[0-9a-f]{64}\.mp3$/);
 await io.media('https://cdn.example/a.mp3','TOPIC','audio',true);assert.equal(writes.length,1);
 const bad=runtime({storage,fetchImpl:async()=>new Response('html',{headers:{'content-type':'text/html'}})});
 await assert.rejects(()=>bad.media('https://cdn.example/a.mp3','TOPIC','audio',true),/unsupported/);
});
test('content-addressed media is reused and downloads are bounded',async()=>{
 let uploads=0;const bytes=new Uint8Array([1,2,3]);
 const storage={list:async()=>({data:[{name:`audio-${await (await import('../functions/_shared/sync-core.mjs')).sha256(bytes)}.mp3`}],error:null}),upload:async()=>{uploads++;return {error:null};},getPublicUrl:path=>({data:{publicUrl:path}})};
 const io=runtime({storage,fetchImpl:async()=>new Response(bytes,{headers:{'content-type':'audio/mpeg'}})});
 await io.media('https://cdn.example/a.mp3','TOPIC','audio',true);assert.equal(uploads,0);
 const large=runtime({storage,fetchImpl:async()=>new Response('x',{headers:{'content-type':'audio/mpeg','content-length':String(41*1024*1024)}})});
 await assert.rejects(()=>large.media('https://cdn.example/a.mp3','TOPIC','audio',true),/too_large/);
});
test('long rich-text properties use all property pages',async()=>{
 const io=runtime({fetchImpl:async url=>new Response(JSON.stringify(url.includes('start_cursor')?{results:[{rich_text:{plain_text:'後半'}}],has_more:false}:{results:[{rich_text:{plain_text:'前半'}}],has_more:true,next_cursor:'next'}))});
 const page={id:MASTER,properties:{有料公開部分:{type:'rich_text',id:'prop%3Aid',rich_text:Array(25).fill({plain_text:'truncated'})}}};
 assert.equal(await io.richText(page,'有料公開部分'),'前半後半');
});
test('Notion 429 honors bounded retry and never retries a 403 as publication removal',async()=>{
 let calls=0;const io=runtime({fetchImpl:async()=>{calls++;return calls===1?new Response('',{status:429,headers:{'retry-after':'0'}}):new Response(JSON.stringify({properties:{}}));}});
 await io.schema();assert.equal(calls,2);
 const denied=runtime({fetchImpl:async()=>new Response('',{status:403})});await assert.rejects(()=>denied.schema(),/notion_http_403/);
});

test('duplicate source content page fails preflight and existing unique page collision is preserved',async()=>{
 const f=fixture();const other=structuredClone(f.m);other.id='cccccccc-cccc-cccc-cccc-cccccccccccc';other.properties['記事ID'].rich_text=[{plain_text:'OTHER'}];
 f.io.pages=async()=>[f.m,other];
 await assert.rejects(()=>syncArticles(f.io,{apply:true}),/duplicate_content_page/);assert.deepEqual(f.writes,[]);assert.deepEqual(f.uploads,[]);
 const g=fixture();g.io.existing=async()=>[{article_id:'OTHER',notion_page_id:CONTENT}];
 const result=await syncArticles(g.io,{apply:true});assert.equal(result.errors[0].reason,'content_page_collision');assert.deepEqual(g.writes,[]);assert.deepEqual(g.uploads,[]);
});
