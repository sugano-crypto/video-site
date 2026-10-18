"""Apply only to the reviewed PR #1 index.html; writes a separate candidate file."""
from pathlib import Path
import sys
source=Path(sys.argv[1]).read_text()
old='''await sb
.from("articles")
.select(
"id,title,content_type,published_at,status,price,body,access_type,free_body,target_audience,note_url,notion_article_url,notion_cover_url,notion_audio_url,notion_blocks"
)
.order(
"published_at",
{ascending:false}
);'''
assert old in source,'Expected PR #1 article query not found'
source=source.replace(old,'await sb.rpc("sc_member_articles");',1)
source=source.replace('const locked=Boolean(notionUrl) && !canOpenContractArticle();','const locked=!canOpenContractArticle();')
source=source.replace('function openTopicFromIndex(articleId,topicIndex){','async function openTopicFromIndex(articleId,topicIndex){').replace('  openArticle(articleId);\n  if(!article','  await openArticle(articleId);\n  if(!article',1)
source=source.replace('let currentArticleId = null;', 'let currentArticleId = null;\nlet articleViewVersion=0;\nlet articleMediaTimer=null;')
source=source.replace('function openArticle(id){\n\ncurrentArticleId=id;', '''async function openArticle(id){

currentArticleId=id;
const viewVersion=++articleViewVersion;
clearTimeout(articleMediaTimer);''',1)
source=source.replace('const a=allArticles.find(x=>String(x.id)===String(id));','let a=allArticles.find(x=>String(x.id)===String(id));',1)
anchor='document.getElementById("article-modal-title").textContent=a.title||"無題";'
source=source.replace(anchor,'''// Re-check current server-side entitlement before rendering cached paid content.
const {data:fresh,error:readError}=await sb.rpc("sc_member_article",{p_id:id});
if(viewVersion!==articleViewVersion) return;
if(readError || !fresh){ showLockModal(); return; }
a=fresh;
Object.assign(allArticles.find(x=>String(x.id)===String(id)),fresh);
let signedMedia={cover:null,audio:null};
let mediaError=false;
if(a.notion_cover_url || a.notion_audio_url){
  try{
    const {data,error}=await sb.functions.invoke("article-media-links",{body:{article_id:String(id)}});
    if(error || !data) throw Error("media_unavailable");
    signedMedia=data;
  }catch{ mediaError=true; }
}
if(viewVersion!==articleViewVersion) return;
''' + anchor,1)
source=source.replace('const coverUrl=String(a.notion_cover_url||"").trim();','const coverUrl=String(signedMedia.cover||"").trim();',1).replace('const audioUrl=String(a.notion_audio_url||"").trim();','const audioUrl=String(signedMedia.audio||"").trim();',1)
source=source.replace('document.getElementById("article-modal").style.display="flex";','''if(mediaError){
  const warning=document.createElement("p");
  warning.textContent="画像・音声を読み込めませんでした。記事を開き直してください。";
  source.appendChild(warning);
}
document.getElementById("article-modal").style.display="flex";
if(!mediaError && (signedMedia.cover || signedMedia.audio)){
  const renew=async()=>{
    if(viewVersion!==articleViewVersion) return;
    try{
      const {data,error}=await sb.functions.invoke("article-media-links",{body:{article_id:String(id)}});
      if(viewVersion!==articleViewVersion) return;
      if(error || !data) throw Error("media_unavailable");
      if(data.cover)coverImage.src=data.cover;
      if(data.audio){
        const position=audioPlayer.currentTime,playing=!audioPlayer.paused;
        audioPlayer.src=data.audio;
        audioPlayer.addEventListener("loadedmetadata",()=>{
          if(viewVersion!==articleViewVersion) return;
          audioPlayer.currentTime=position;
          if(playing)audioPlayer.play().catch(()=>{});
        },{once:true});
      }
      articleMediaTimer=setTimeout(renew,240000);
    }catch{
      if(viewVersion!==articleViewVersion) return;
      audioPlayer.pause();audioPlayer.removeAttribute("src");audioPlayer.load();
      coverImage.removeAttribute("src");
      source.textContent="閲覧状態を確認できませんでした。記事を開き直してください。";
    }
  };
  articleMediaTimer=setTimeout(renew,240000);
}''',1)
source=source.replace('function closeArticleModal(){\n\ncurrentArticleId=null;','function closeArticleModal(){\n\narticleViewVersion++;\nclearTimeout(articleMediaTimer);\ncurrentArticleId=null;',1)
Path(sys.argv[2]).write_text(source)
