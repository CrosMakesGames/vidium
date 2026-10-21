(function(r,f){typeof module!=='undefined'?module.exports=f():r.SkipIntro=f();})(typeof self!=='undefined'?self:this,function(){
'use strict';
function getStorage(c){if(c)return c;if(typeof localStorage!=='undefined')return localStorage;var m={};return {getItem:function(k){return m.hasOwnProperty(k)?m[k]:null;},setItem:function(k,v){m[k]=String(v);}};}
function createSkipIntroController(opts){
opts=opts||{};
var storage=getStorage(opts.storage),key=opts.storageKey||'skip_intro_config';
var defShow=opts.showAt!==undefined?opts.showAt:3,defSeek=opts.seekTo!==undefined?opts.seekTo:85,defHide=opts.hideAfter!==undefined?opts.hideAfter:115;
var enabled=opts.enabled!==undefined?!!opts.enabled:true;
var curTmdb=opts.tmdbId||null,shown=false,usedThisSession=false,onShow=opts.onShow||null,onHide=opts.onHide||null,onSkip=opts.onSkip||null;
/* remote: per-episode intro window from TheIntroDB (community-verified).
   Priority: the user's own local marker > remote > conf defaults. */
var remote=null;
var cfgCache=null;
function loadAll(){try{var r=storage.getItem(key);return r?JSON.parse(r):{};}catch(e){return {};}}
function saveAll(m){try{storage.setItem(key,JSON.stringify(m));}catch(e){}}
function invalidate(){cfgCache=null;}
function getConfig(id){
var tmdb=id||curTmdb;
/* cached - this runs on every timeupdate (was a localStorage hit + JSON.parse each time) */
if(cfgCache&&cfgCache.tmdb===tmdb)return cfgCache.cfg;
var ov=loadAll(),o=tmdb?ov[tmdb]:null;
/* legacy markers were stored under the bare tmdb id (no type prefix) */
if(!o&&tmdb&&tmdb.indexOf(':')>-1)o=ov[tmdb.slice(tmdb.indexOf(':')+1)];
var cfg;
if(o)cfg={showAt:o.showAt!==undefined?o.showAt:defShow,seekTo:o.seekTo!==undefined?o.seekTo:defSeek,hideAfter:o.hideAfter!==undefined?o.hideAfter:defHide};
else if(remote&&remote.end){
/* remote intro: appear no earlier than the intro's own start (cold open
   first), jump to the community-verified end, keep the window open past it */
cfg={showAt:(remote.start!=null&&remote.start>defShow)?remote.start:defShow,seekTo:remote.end,hideAfter:defHide>remote.end?defHide:remote.end+10};
}
else cfg={showAt:defShow,seekTo:defSeek,hideAfter:defHide};
cfgCache={tmdb:tmdb,cfg:cfg};
return cfg;
}
function setOverride(tmdb,cfg){if(!tmdb)return;var ov=loadAll();ov[tmdb]=Object.assign({},ov[tmdb]||{},cfg);saveAll(ov);invalidate();}
function setIntroEnd(t){
/* single argument: the end time. The caller's show id is curTmdb
   (setTmdbId) - the old wiring passed (tmdbId, t) and the first arg
   was silently discarded. */
var end=Math.max(0,parseFloat(t)||0),cfg=getConfig();
cfg.seekTo=end;
if(cfg.hideAfter<end)cfg.hideAfter=end+10;
if(curTmdb)setOverride(curTmdb,cfg);
return cfg;
}
function updateTime(t){
var cfg=getConfig(),time=parseFloat(t)||0;
/* the button only makes sense BEFORE the intro end: never offer the
   skip while already past the jump target, and only once per session */
var inWindow=enabled&&!usedThisSession&&time>=cfg.showAt&&time<cfg.seekTo&&time<=cfg.hideAfter;
if(inWindow){if(!shown){shown=true;if(typeof onShow==='function')onShow(cfg);}}
else{if(shown){shown=false;if(typeof onHide==='function')onHide(cfg);}}
return shown;
}
function skip(){var cfg=getConfig();shown=false;usedThisSession=true;if(typeof onHide==='function')onHide(cfg);if(typeof onSkip==='function')onSkip(cfg);return cfg.seekTo;}
return {setTmdbId:function(id){curTmdb=id;shown=false;invalidate();},getConfig:getConfig,setOverride:setOverride,setIntroEnd:setIntroEnd,setRemoteIntro:function(start,end){remote=(end!=null&&isFinite(end)&&end>=5&&end<=21600)?{start:(start!=null&&isFinite(start)&&start>=0)?start:null,end:end}:null;invalidate();},updateTime:updateTime,skip:skip,reset:function(){shown=false;usedThisSession=false;},onShow:function(f){onShow=f;},onHide:function(f){onHide=f;},onSkip:function(f){onSkip=f;}};
}
return {createSkipIntroController:createSkipIntroController};
});
