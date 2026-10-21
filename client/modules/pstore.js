(function(r,f){typeof module!=='undefined'?module.exports=f():r.PStore=f();})(typeof self!=='undefined'?self:this,function(){
'use strict';
function getStorage(c){if(c)return c;if(typeof localStorage!=='undefined')return localStorage;var m={};return {getItem:function(k){return m.hasOwnProperty(k)?m[k]:null;},setItem:function(k,v){m[k]=String(v);}};}
function createPStore(opts){
opts=opts||{};
var storage=getStorage(opts.storage),keyName=opts.storageKey||'vidsrc_player_pstore',throttle=opts.throttleMs!==undefined?opts.throttleMs:10000,maxEntries=opts.maxEntries!==undefined?opts.maxEntries:60,lastSaved={};
function parse(s){try{var v=JSON.parse(s);return (v&&typeof v==='object'&&!Array.isArray(v))?v:{};}catch(e){return {};}}
function getAll(){return parse(storage.getItem(keyName));}
function saveAll(d){try{storage.setItem(keyName,JSON.stringify(d));}catch(e){}}
function buildKey(type,tmdb,s,e){if(typeof type==='object'&&type!==null)return (type.type||'movie')+'|'+(type.tmdb||type.tmdbId||'0')+'|'+(type.s||type.season||0)+'|'+(type.e||type.episode||0);return (type||'movie')+'|'+(tmdb||'0')+'|'+(s||0)+'|'+(e||0);}
function prune(d){var keys=Object.keys(d);if(keys.length<=maxEntries)return d;var items=keys.map(function(k){return {k:k,u:d[k].updatedAt||0};});items.sort(function(a,b){return b.u-a.u;});var out={};for(var i=0;i<maxEntries&&i<items.length;i++)out[items[i].k]=d[items[i].k];return out;}
function save(keyOrSpec,posData,force){var k=typeof keyOrSpec==='string'?keyOrSpec:buildKey(keyOrSpec),pos=parseFloat(posData?posData.position:0)||0,dur=parseFloat(posData?posData.duration:0)||0,now=Date.now();if(!force&&lastSaved[k]&&(now-lastSaved[k]<throttle))return false;var data=getAll();data[k]={position:pos,duration:dur,updatedAt:now};saveAll(prune(data));lastSaved[k]=now;return true;}
function resume(keyOrSpec){var k=typeof keyOrSpec==='string'?keyOrSpec:buildKey(keyOrSpec),entry=getAll()[k];return entry?{position:entry.position||0,updatedAt:entry.updatedAt||0,duration:entry.duration||0}:null;}
return {buildKey:buildKey,save:save,resume:resume,remove:function(k){var d=getAll(),id=typeof k==='string'?k:buildKey(k);delete d[id];delete lastSaved[id];saveAll(d);},clear:function(){saveAll({});lastSaved={};},getAll:getAll};
}
return {createPStore:createPStore};
});
