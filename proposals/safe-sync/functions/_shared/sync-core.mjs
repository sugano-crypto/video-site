// Review candidate. No network or environment access at import time.
export const PUBLISHED = new Set(['公開']);
const AUDIENCES = new Set(['医師','医師向け','doctor','doctors','事務','事務向け','staff','office','admin','全員','共通','all','both']);
const ACCESS = new Set(['無料','有料']);
export const plain = (items=[]) => items.map(x=>x.plain_text ?? x.text?.content ?? '').join('');
export const statusOf = p => p?.select?.name ?? p?.status?.name ?? '';
export const compactId = s => String(s||'').replaceAll('-','').toLowerCase();
export const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string' ? new TextEncoder().encode(value) : value))].map(x=>x.toString(16).padStart(2,'0')).join('');
export async function authorized(request, secret){
  if(typeof secret!=='string' || secret.length<32) return false;
  const incoming=request.headers.get('x-sync-secret')||'';
  if(incoming.length>512) return false;
  // Hash both fixed-length values, then compare every byte.
  const [a,b]=await Promise.all([sha256(incoming),sha256(secret)]);
  let diff=0; for(let i=0;i<a.length;i++) diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
export function notionPageId(value){
  if(!value) return null;
  const u=new URL(value);
  if(u.protocol!=='https:' || !['notion.so','www.notion.so','notion.site'].includes(u.hostname) && !u.hostname.endsWith('.notion.site')) throw Error('invalid_notion_article_url');
  // Query parameters may contain a view ID: only inspect the path.
  const m=decodeURIComponent(u.pathname).match(/([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
  if(!m) throw Error('invalid_notion_page_id');
  const id=compactId(m[1]);return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}
export function firstFile(property){
  for(const f of property?.files||[]){ const url=f.file?.url||f.external?.url; if(url) return url; }
  return null;
}
export function firstAudio(blocks){
  for(const b of blocks){
    if(b.type==='audio'){const u=b.audio?.file?.url||b.audio?.external?.url;if(u)return u;}
    const child=firstAudio(b.children||[]);if(child)return child;
  }
  return null;
}
export function validateSchema(db){
  const p=db?.properties||{};
  for(const [name,types] of Object.entries({記事ID:['rich_text'],ステータス:['select','status'],無料公開部分:['rich_text'],有料公開部分:['rich_text'],公開区分:['select'],対象読者:['multi_select'],公開日:['date']})){
    if(!types.includes(p[name]?.type)) throw Error(`schema_mismatch:${name}`);
  }
  if(!['タイトル','Name','Title'].some(k=>p[k]?.type==='title')) throw Error('schema_mismatch:title');
}
export function metadata(page){
  const p=page.properties||{};
  const id=plain(p['記事ID']?.rich_text).trim();
  const title=['タイトル','Name','Title'].map(k=>plain(p[k]?.title).trim()).find(Boolean);
  if(!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id)||!title) throw Error('invalid_article_identity');
  const status=statusOf(p['ステータス']);if(!status) throw Error(`missing_status:${id}`);
  const access=p['公開区分']?.select?.name;
  const audiences=(p['対象読者']?.multi_select||[]).map(x=>x.name);
  if(PUBLISHED.has(status)){
    if(!ACCESS.has(access)) throw Error(`invalid_access_type:${id}`);
    if(audiences.length!==1 || !AUDIENCES.has(audiences[0])) throw Error(`invalid_audience:${id}`);
    if(!p['公開日']?.date?.start || !Number.isFinite(Date.parse(p['公開日'].date.start))) throw Error(`invalid_publish_date:${id}`);
  }
  return {id,title,status,access,audience:audiences[0],contentId:notionPageId(p['Notion記事URL']?.url)||page.id};
}
export async function fingerprint(master, content){
  if(!master.last_edited_time||!content.last_edited_time) throw Error('missing_edit_timestamp');
  return sha256(JSON.stringify(['safe-sync-v1',master.id,master.last_edited_time,content.id,content.last_edited_time]));
}
export async function collectPages(load){
  let cursor;const seen=new Set(),out=[];
  do{
    const data=await load(cursor);
    if(!Array.isArray(data?.results)||typeof data.has_more!=='boolean') throw Error('invalid_pagination_response');
    out.push(...data.results);
    if(!data.has_more) break;
    if(typeof data.next_cursor!=='string'||!data.next_cursor||seen.has(data.next_cursor)) throw Error('incomplete_pagination');
    cursor=data.next_cursor;seen.add(cursor);
    if(seen.size>1000) throw Error('pagination_limit');
  }while(true);
  return out;
}
export async function syncArticles(io, {apply=false, force=false}={}){
  // Validate the entire source listing BEFORE any persistent write.
  validateSchema(await io.schema());
  const pages=await io.pages();
  if(!pages.length) throw Error('empty_source_no_writes');
  const entries=pages.map(page=>({page,meta:metadata(page)}));
  const ids=new Set();
  for(const {meta} of entries){if(ids.has(meta.id))throw Error(`duplicate_article_id:${meta.id}`);ids.add(meta.id);}
  const existing=await io.existing();
  const byId=new Map(existing.filter(a=>a.article_id).map(a=>[a.article_id,a]));
  const report={dry_run:!apply,scanned:pages.length,unchanged:0,updated:[],would_update:[],attention:[],errors:[],deleted:0};
  // Never infer deletion/withdrawal from absence. Flag it for review.
  for(const row of existing){
    if(row.article_id&&!ids.has(row.article_id)) report.attention.push({article_id:row.article_id,reason:'absent_from_source'});
  }
  for(const {page,meta} of entries){
    const old=byId.get(meta.id);
    if(!PUBLISHED.has(meta.status)||page.archived||page.in_trash){
      if(old)report.attention.push({article_id:meta.id,reason:'explicit_non_public'});
      continue;
    }
    try{
      const state=await io.state(meta.id);
      if(state && (compactId(state.master_page_id)!==compactId(page.id)||compactId(state.source_database_id)!==compactId(io.databaseId))) throw Error('ownership_conflict');
      if(old && !state && compactId(old.notion_page_id)!==compactId(meta.contentId)) throw Error('unowned_article_collision');
      if(old?.status&&!['published','公開','公開中'].includes(String(old.status).toLowerCase())) throw Error('existing_status_requires_review');
      const content=await io.page(meta.contentId);
      if(content.archived||content.in_trash) throw Error('content_page_not_active');
      const revision=await fingerprint(page,content);
      if(!force && old && state?.fingerprint===revision){report.unchanged++;continue;}
      const blocks=await io.blocks(meta.contentId);
      const [free,paid]=await Promise.all([io.richText(page,'無料公開部分'),io.richText(page,'有料公開部分')]);
      if(!free.trim()&&!paid.trim()&&!blocks.length)throw Error('empty_article');
      const cp=content.properties||{},mp=page.properties||{};
      const cover=content.cover?.file?.url||content.cover?.external?.url||firstFile(cp['アイキャッチ画像']);
      const audio=firstFile(cp['音声データ'])||firstFile(mp['音声データ'])||firstAudio(blocks);
      // Missing media never clears a working URL automatically.
      const coverUrl=cover ? await io.media(cover,meta.id,'cover',apply) : old?.notion_cover_url||null;
      const audioUrl=audio ? await io.media(audio,meta.id,'audio',apply) : old?.notion_audio_url||null;
      // A second metadata read catches most edits during extraction.
      const [masterNow,contentNow]=await Promise.all([io.page(page.id),io.page(meta.contentId)]);
      if(await fingerprint(masterNow,contentNow)!==revision || !PUBLISHED.has(statusOf(masterNow.properties?.['ステータス'])) || masterNow.archived || masterNow.in_trash || contentNow.archived || contentNow.in_trash) throw Error('source_changed_retry');
      const article={article_id:meta.id,notion_page_id:meta.contentId,title:meta.title,
        content_type:mp['コンテンツ種別']?.select?.name||'',published_at:mp['公開日'].date.start,
        price:mp['通常販売価格']?.number??0,body:paid,access_type:meta.access,free_body:free,
        target_audience:meta.audience,notion_article_url:mp['Notion記事URL']?.url||null,note_url:mp['note URL']?.url||null,
        notion_cover_url:coverUrl,notion_audio_url:audioUrl,notion_blocks:blocks};
      if(apply){
        await io.commit(article,{article_id:meta.id,master_page_id:page.id,source_database_id:io.databaseId,fingerprint:revision});
        report.updated.push(meta.id);
      }else report.would_update.push(meta.id);
    }catch(error){
      // Do not include raw provider responses, signed URLs or bodies in logs.
      report.errors.push({article_id:meta.id,reason:io.errorCode(error)});
    }
  }
  return report;
}
export function makeHandler({secret,applyEnabled=false,ioFactory}){
  return async request=>{
    const json=(data,status)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    if(!await authorized(request,secret))return json({error:'unauthorized'},401);
    let options;
    try{
      const text=await request.text();if(text.length>1024)throw Error();
      options=JSON.parse(text||'{}');
      if(!options||Array.isArray(options)||typeof options!=='object'||Object.keys(options).some(k=>!['dry_run','force'].includes(k))||['dry_run','force'].some(k=>k in options&&typeof options[k]!=='boolean'))throw Error();
    }catch{return json({error:'invalid_request'},400);}
    const apply=applyEnabled&&options.dry_run===false;
    if(options.dry_run===false&&!applyEnabled)return json({error:'apply_disabled'},403);
    const io=ioFactory();let token;
    try{
      // Dry-runs do not create locks, state, articles or storage objects.
      if(apply){token=await io.acquire();if(!token)return json({error:'sync_busy'},409);}
      const report=await syncArticles(io,{apply,force:options.force===true});
      return json(report,report.errors.length?502:report.attention.length?409:200);
    }catch(error){return json({error:io.errorCode(error),deleted:0},502);}
    finally{if(token)await io.release(token).catch(()=>{});}
  };
}
