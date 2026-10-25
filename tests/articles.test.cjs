const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const scripts=[...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const code=scripts.join('\n');
const context=vm.createContext({URL,console,document:{addEventListener(){},getElementById(){return {}}},window:{addEventListener(){}},supabase:{createClient(){return {}}}});
vm.runInContext(code,context);
const run=expression=>vm.runInContext(expression,context);
const block=(text,type='paragraph')=>({type,[type]:{rich_text:[{plain_text:text}]}});
function call(name,...args){context.args=args;return run(`${name}(...args)`);}
test('pasted body: headings, paragraphs, newlines, insight, references and original text',()=>{
 const text='【記事見出し】\n本文1\n本文2\n\n次の段落\n【すがCon’s Insight】\n所見\n参考資料URL：https://example.com/?a=1&b=2';
 const html=call('formatArticleText',text);
 assert.match(html,/<h3 class="article-section-heading">【記事見出し】<\/h3>/);
 assert.match(html,/本文1\n本文2/);assert.match(html,/<p>次の段落/);
 assert.match(html,/article-insight-heading/);assert.match(html,/href="https:\/\/example.com\/\?a=1&amp;b=2"/);
 assert.equal(html.replace(/<[^>]*>/g,'').replaceAll('&amp;','&').replace(/\s/g,''),text.replace(/\s/g,''));
});
test('HTML and unsafe rich-text URLs remain inert',()=>{
 const html=call('formatArticleText','【<img src=x onerror=alert(1)>】\n<script>alert(1)</script> https://example.com/" onclick="alert(1)');
 assert.doesNotMatch(html,/<img|<script|<a[^>]+ onclick=/);
 const b=block('click');b.paragraph.rich_text[0].href='javascript:alert(1)';
 assert.doesNotMatch(call('renderNotionBlocks',[b]),/href=/);
 assert.doesNotMatch(call('renderNotionBlocks',[{type:'bookmark',bookmark:{url:'data:text/html,bad'}}]),/href=/);
});
test('Notion paragraphs preserve rich text across automatic headings and links',()=>{
 const b=block('【見出し】\n本文\n\n参考資料 https://example.com');b.paragraph.rich_text[0].annotations={bold:true};
 const html=call('renderNotionBlocks',[b]);assert.match(html,/<h3[^>]*><strong>【見出し】/);assert.match(html,/<strong>\n本文/);assert.match(html,/<a href="https:\/\/example.com"/);
 for(const type of ['heading_1','heading_2','heading_3','numbered_list_item','bulleted_list_item','quote','callout','code']) assert.match(call('renderNotionBlocks',[block('existing',type)]),/existing/);
});
test('topics support plain body, pasted blocks, legacy numbering and deduplication without four-item cap',()=>{
 const text='【題1】\n本文\n【参考資料URL】\nhttps://example.com\n【すがCon’s Insight】\n所見\n【題2】\n【題1】\n【題3】【題4】【題5】';
 assert.equal(JSON.stringify(call('extractTopicTitles',{body:text})),JSON.stringify(['題1','題2','題3','題4','題5']));
 assert.equal(JSON.stringify(call('extractTopicTitles',{notion_blocks:JSON.stringify([block(text)])})),JSON.stringify(['題1','題2','題3','題4','題5']));
 assert.equal(JSON.stringify(call('extractTopicTitles',{notion_blocks:[block('old','numbered_list_item')]})),JSON.stringify(['old']));
 assert.equal(JSON.stringify(call('extractTopicTitles',{notion_blocks:'bad json',body:'1. fallback'})),JSON.stringify(['fallback']));
});
test('index has no block requirement or ID cutoff; sorted and access filtered',()=>{
 run(`currentUser={email:ADMIN_EMAIL}; allArticles=[{id:'new',published_at:'2026-10-18',body:'【new】'},{id:'old',published_at:'2026-10-04',notion_blocks:[]},{id:'future',published_at:'2026-11-01'}]`);
 assert.equal(JSON.stringify(run('getTopicViewerArticles().map(a=>a.id)')),JSON.stringify(['future','new','old']));
 run(`currentUser={email:'test@example.com'};currentProfile={user_type:'事務',contract_status:'契約中'};allArticles=[{id:'doctor',target_audience:'doctor'},{id:'staff',target_audience:'staff'}]`);
 assert.equal(JSON.stringify(run('getTopicViewerArticles().map(a=>a.id)')),JSON.stringify(['staff']));
 run(`currentProfile.contract_status='契約終了'`);assert.equal(run('getTopicViewerArticles().length'),0);assert.equal(run('canOpenContractArticle()'),false);
});


test('admin sidebar excludes two doctor articles while weekly staff/all and doctor access remain',()=>{
 run(`currentUser={email:ADMIN_EMAIL};currentProfile={contract_status:'契約中'};
 allArticles=[
 {id:'doctor-1',title:'推計患者数の落とし穴と新規患者獲得戦略',target_audience:'doctor',published_at:'2026-10-25'},
 {id:'doctor-2',title:'医師向け記事（検証用）',target_audience:'医師向け',published_at:'2026-10-24'},
 {id:'weekly-staff',title:'週刊医療・介護トピックス',target_audience:'staff',published_at:'2026-10-18'},
 {id:'weekly-all',title:'週刊医療・介護トピックス（共通）',target_audience:'all',published_at:'2026-10-11'}]`);
 assert.equal(JSON.stringify(run('getTopicViewerArticles().map(a=>a.id)')),JSON.stringify(['weekly-staff','weekly-all']));
 assert.equal(run('allArticles.length'),4);
 assert.equal(run('canReadArticle(allArticles[0])'),true);
 assert.equal(run('canReadArticle(allArticles[1])'),true);
});

test('sidebar keeps existing access checks and excludes unknown audience types',()=>{
 run(`allArticles=[{id:'doctor',target_audience:'doctor'},{id:'staff',target_audience:'staff'},{id:'all',target_audience:'all'},{id:'unknown',target_audience:'unrecognized'}];currentUser={email:'staff@example.test'};currentProfile={user_type:'事務',contract_status:'契約中'}`);
 assert.equal(JSON.stringify(run('getTopicViewerArticles().map(a=>a.id)')),JSON.stringify(['staff','all']));
 run(`currentProfile={user_type:'医師',contract_status:'契約中'}`);
 assert.equal(JSON.stringify(run('getTopicViewerArticles().map(a=>a.id)')),JSON.stringify(['all']));
 run(`currentProfile.contract_status='契約終了'`);
 assert.equal(run('getTopicViewerArticles().length'),0);
 run(`currentUser={email:ADMIN_EMAIL}`);
 assert.equal(JSON.stringify(run('getTopicViewerArticles().map(a=>a.id)')),JSON.stringify(['staff','all']));
});
