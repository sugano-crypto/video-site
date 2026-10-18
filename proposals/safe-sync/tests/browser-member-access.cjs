// Optional: npm install --no-save playwright, and set CHROMIUM_PATH if needed.
const {chromium}=require('playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>r.abort());
 let html=fs.readFileSync(path.join(__dirname,'../member-access/index.candidate.html'),'utf8');
 html=html.replace(/<script src="https:\/\/cdn.jsdelivr.net[^>]*><\/script>/,`<script>
 window.mediaCalls=0;window.serverAllowed=true;
 window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})},
 rpc:async(name,args)=>name==='sc_member_article'?{data:window.serverAllowed?window.testArticles.find(a=>String(a.id)===String(args.p_id)):null,error:null}:{data:window.testArticles,error:null},
 functions:{invoke:async()=>{window.mediaCalls++;return {data:{cover:'https://media.example/signed-cover?token=test',audio:'https://media.example/signed-audio?token=test',expires_in:300},error:null}}}
 })};</script>`);
 await page.setContent(html);
 await page.evaluate(async()=>{
  currentUser={email:ADMIN_EMAIL};currentProfile={contract_status:'契約中'};
  window.testArticles=[{id:1,title:'10月18日号',published_at:'2026-10-18',body:'【記事見出し】\n本文の1行目\n2行目\n\n次の段落\n【すがCon’s Insight】\n所見\n参考資料URL：https://example.com',notion_audio_url:'https://project.supabase.co/storage/v1/object/public/article-media/audio.mp3',notion_cover_url:'https://project.supabase.co/storage/v1/object/public/article-media/cover.jpg'}];
  allArticles=window.testArticles.map(x=>({...x}));renderTopicIndex();await openArticle(1);
 });
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:900});
  assert.equal(await page.locator('#article-modal-body h3').count(),2);
  assert.equal(await page.locator('#article-audio-player').getAttribute('src'),'https://media.example/signed-audio?token=test');
  assert.equal(await page.locator('#article-cover-image').getAttribute('src'),'https://media.example/signed-cover?token=test');
  assert.equal(await page.evaluate(()=>document.querySelector('.article-modal-card').scrollWidth<=document.querySelector('.article-modal-card').clientWidth),true);
 }
 await page.evaluate(()=>closeArticleModal());
 await page.locator('.topic-title-link').first().dispatchEvent('click');
 await page.waitForFunction(()=>document.getElementById('article-modal').style.display==='flex');
 const calls=await page.evaluate(()=>window.mediaCalls);
 await page.evaluate(async()=>{closeArticleModal();window.serverAllowed=false;await openArticle(1);});
 assert.equal(await page.locator('#article-modal').evaluate(el=>el.style.display),'none');
 assert.equal(await page.evaluate(()=>window.mediaCalls),calls);
 await page.evaluate(()=>{currentUser={email:'unpaid@example.test'};currentProfile={user_type:'医師',contract_status:'未契約'};allArticles=window.testArticles.map(a=>({...a,body:null,notion_blocks:null,notion_audio_url:null,notion_cover_url:null}));renderTopicIndex();});
 assert.equal((await page.locator('#topic-index-list').textContent()).includes('記事見出し'),false);
 assert.deepEqual(errors,[]);
 console.log('PASS: signed media, server re-check, unpaid sidebar, async index navigation, desktop/mobile');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
