(function(r,f){typeof module!=='undefined'?module.exports=f():r.Subtitles=f();})(typeof self!=='undefined'?self:this,function(){
'use strict';
function parseTime(t){if(!t)return null;var p=t.trim().replace(',','.').split(':');if(p.length===2)p.unshift('00');if(p.length!==3)return null;var h=parseFloat(p[0]),m=parseFloat(p[1]),s=parseFloat(p[2]);return(isNaN(h)||isNaN(m)||isNaN(s))?null:h*3600+m*60+s;}
function formatTime(s){s=Math.max(0,s||0);var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=(s%60).toFixed(3);return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(sec).padStart(6,'0');}
function parse(txt){if(!txt)return[];var blocks=txt.replace(/^\ufeff/,'').replace(/\r\n|\r/g,'\n').split(/\n\n+/),cues=[],id=1;for(var i=0;i<blocks.length;i++){var lines=blocks[i].trim().split('\n'),arr=-1;for(var j=0;j<lines.length;j++)if(lines[j].indexOf('-->')!==-1){arr=j;break;}if(arr===-1)continue;var times=lines[arr].split('-->'),st=parseTime(times[0]),en=parseTime(times[1]?times[1].trim().split(' ')[0]:'');if(st===null||en===null||en<=st)continue;var ct=lines.slice(arr+1).join('\n').trim();if(ct)cues.push({id:id++,start:st,end:en,text:ct});}return cues;}
function toVTT(cues){return 'WEBVTT\n\n'+(cues||[]).map(function(c,i){return(c.id||(i+1))+'\n'+formatTime(c.start)+' --> '+formatTime(c.end)+'\n'+c.text;}).join('\n\n')+'\n';}
function escHtml(str){str=String(str==null?'':str);return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function createSubtitleManager(){
var cues=[],offset=0,style={fontSize:1,bgOpacity:0,bottomOffset:64,color:'#ffffff',fontWeight:'700',edge:'outline',fontFamily:'',letterSpacing:0};
return {
parse:function(t){cues=parse(t);return cues;},
setOffset:function(s){offset=parseFloat(s)||0;},
setStyle:function(st){if(!st)return;['fontSize','bgOpacity','bottomOffset','color','fontWeight','edge','fontFamily','letterSpacing'].forEach(function(k){if(st[k]!==undefined)style[k]=st[k];});},
getActiveCues:function(t){var a=t-offset;return cues.filter(function(c){return a>=c.start&&a<=c.end;});},
renderAt:function(t,cnt,st){if(st)this.setStyle(st);var act=this.getActiveCues(t);if(cnt){cnt.innerHTML=act.map(function(c){return escHtml(c.text);}).join('<br/>');cnt.style.display=act.length?'block':'none';cnt.style.fontSize=parseFloat((1.2*style.fontSize).toFixed(2))+'rem';cnt.style.backgroundColor='rgba(0,0,0,'+style.bgOpacity+')';cnt.style.bottom=style.bottomOffset+'px';cnt.style.color=style.color||'#ffffff';cnt.style.fontWeight=style.fontWeight||'700';cnt.style.letterSpacing=(style.letterSpacing||0)+'px';cnt.style.fontFamily=style.fontFamily||'';cnt.style.textShadow=style.edge==='outline'?'1px 0 0 #000,-1px 0 0 #000,0 1px 0 #000,0 -1px 0 #000,1px 1px 0 #000,-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000':(style.edge==='shadow'?'0 2px 8px rgba(0,0,0,0.95)':'');}return act;},
getCues:function(){return cues;},
toVTT:function(){return toVTT(cues);}
};}
return {parse:parse,toVTT:toVTT,createSubtitleManager:createSubtitleManager};
});
