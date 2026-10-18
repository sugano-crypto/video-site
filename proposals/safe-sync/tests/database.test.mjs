// Real PostgreSQL engine compiled to WASM. No sockets or external database.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const TOKEN='11111111-1111-1111-1111-111111111111',OTHER='22222222-2222-2222-2222-222222222222';
const article={article_id:'TOPIC-20261018',notion_page_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',title:'10月18日号',content_type:'記事',published_at:'2026-10-18',price:100,body:'有料本文',access_type:'有料',free_body:'無料本文',target_audience:'医師',notion_article_url:null,note_url:null,notion_cover_url:'https://storage/old-image',notion_audio_url:'https://storage/old-audio',notion_blocks:[]};
const state={article_id:article.article_id,master_page_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',source_database_id:'3db36098fd3680e596dcfaa1715d566f',fingerprint:'a'.repeat(64)};
await db.exec(`create role anon;create role authenticated;create role service_role;
create table public.articles(id uuid primary key default gen_random_uuid(),article_id text unique,notion_page_id uuid,title text,content_type text,published_at timestamptz,price numeric,body text,access_type text,free_body text,target_audience text,notion_article_url text,note_url text,notion_cover_url text,notion_audio_url text,notion_blocks jsonb,status text default '公開');
alter table public.articles enable row level security;
create policy unchanged_policy on public.articles for select to authenticated using(status='公開');`);
await db.exec(readFileSync(new URL('../sql/001-state.sql',import.meta.url),'utf8'));
const q=(sql,args=[])=>db.query(sql,args);
const commit=(a=article,s=state,token=TOKEN)=>q('select public.sc_sync_commit($1::uuid,$2::jsonb,$3::jsonb)',[token,JSON.stringify(a),JSON.stringify(s)]);
after(()=>db.close());
test('SQL denies public/member RPCs and preserves existing RLS',async()=>{
 for(const name of ['sc_sync_state(text)','sc_sync_acquire(uuid)','sc_sync_release(uuid)','sc_sync_commit(uuid,jsonb,jsonb)']){
  for(const role of ['anon','authenticated'])assert.equal((await q('select has_function_privilege($1,$2,\'EXECUTE\') as allowed',[role,'public.'+name])).rows[0].allowed,false);
  assert.equal((await q('select has_function_privilege(\'service_role\',$1,\'EXECUTE\') as allowed',['public.'+name])).rows[0].allowed,true);
 }
 assert.equal((await q("select count(*)::int as n from pg_policies where schemaname='public' and tablename='articles' and policyname='unchanged_policy'")).rows[0].n,1);
});
test('SQL atomic lease rejects competing owner and commit without lease',async()=>{
 await assert.rejects(()=>commit(),/sync_lease_expired/);
 assert.equal((await q('select sc_sync_acquire($1::uuid) as acquired',[TOKEN])).rows[0].acquired,true);
 assert.equal((await q('select sc_sync_acquire($1::uuid) as acquired',[OTHER])).rows[0].acquired,false);
 await assert.rejects(()=>commit(article,state,OTHER),/sync_lease_expired/);
});
test('SQL commits article and state together; retry keeps original article ID',async()=>{
 await commit();const first=(await q('select id,status,body from articles')).rows[0];assert.equal(first.body,'有料本文');assert.equal(first.status,'公開');
 assert.equal((await q('select sc_sync_state($1) as s',[article.article_id])).rows[0].s.fingerprint,state.fingerprint);
 await commit({...article,body:'更新した本文'},{...state,fingerprint:'b'.repeat(64)});
 const second=(await q('select id,body from articles')).rows[0];assert.equal(second.id,first.id);assert.equal(second.body,'更新した本文');
});
test('SQL state constraint failure rolls back article upsert',async()=>{
 await assert.rejects(()=>commit({...article,body:'保存されてはいけない'},{...state,fingerprint:'invalid'}),/fingerprint|check constraint/);
 assert.equal((await q('select body from articles')).rows[0].body,'更新した本文');
 assert.equal((await q('select sc_sync_state($1) as s',[article.article_id])).rows[0].s.fingerprint,'b'.repeat(64));
});
test('SQL owner change is refused and expired lease cannot write',async()=>{
 await assert.rejects(()=>commit(article,{...state,master_page_id:OTHER}),/sync_owner_mismatch/);
 await q("update sc_sync_private.run_lock set lease_until=clock_timestamp()-interval '1 second'");
 await assert.rejects(()=>commit(),/sync_lease_expired/);
 assert.equal((await q('select sc_sync_acquire($1::uuid) as acquired',[OTHER])).rows[0].acquired,true);
 await q('select sc_sync_release($1::uuid)',[TOKEN]);
 await assert.rejects(()=>commit(article,state,TOKEN),/sync_lease_expired/);
 assert.equal((await q('select token::text as token from sc_sync_private.run_lock')).rows[0].token,OTHER);
});
