const {chromium}=require('playwright');
const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>route.abort());
 let html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
 html=html.replace(/<script src="https:\/\/cdn.jsdelivr.net[^>]*><\/script>/,'<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};</script>');
 await page.setContent(html);
 await page.evaluate(()=>{
   currentUser={email:ADMIN_EMAIL};currentProfile={contract_status:'契約中'};
   allArticles=[{id:"TOPIC-20261018' unsafe",title:'2026年10月18日号',published_at:'2026-10-18',body:'【記事見出し】\n本文の1行目です。\n2行目も表示します。\n\n次の段落。\n【すがCon’s Insight】\n所見です。\n参考資料URL：https://example.com/?a=1&b=2\n<script>window.injected=true</script>\n【次の記事】\n続きの本文です。'},{id:'no-heading',title:'見出しなし',published_at:'2026-10-11',body:'本文のみ'}];
   renderTopicIndex();openArticle(allArticles[0].id);
 });
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:900});
  assert.equal(await page.locator('#article-modal-body h3').count(),3);
  assert.equal(await page.locator('#article-modal-body script').count(),0);
  assert.equal(await page.evaluate(()=>window.injected),undefined);
  assert.equal(await page.locator('#article-modal-body a').getAttribute('href'),'https://example.com/?a=1&b=2');
  assert.equal(await page.locator('#article-modal-body p').first().evaluate(el=>getComputedStyle(el).whiteSpace),'pre-wrap');
  assert.equal(await page.evaluate(()=>document.querySelector('.article-modal-card').scrollWidth<=document.querySelector('.article-modal-card').clientWidth),true);
  if(process.env.ARTICLE_SCREENSHOT_DIR) await page.screenshot({path:require('node:path').join(process.env.ARTICLE_SCREENSHOT_DIR,`article-${width}.png`)});
 }
 await page.evaluate(()=>closeArticleModal());
 await page.locator('.topic-title-link').first().dispatchEvent('click');
 assert.equal(await page.locator('#article-modal-title').textContent(),'2026年10月18日号');
 await page.evaluate(()=>{closeArticleModal();currentUser={email:'member@example.com'};currentProfile={user_type:'医師',contract_status:'未契約'};renderTopicIndex();});
 assert.equal(await page.locator('#topic-index-list').textContent().then(t=>t.includes('記事見出し')),false);
 assert.deepEqual(errors,[]);
 console.log('PASS: desktop/mobile, DOM escaping, safe links, index navigation with quoted ID, restricted index');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
