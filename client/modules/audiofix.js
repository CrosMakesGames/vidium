(function(r,f){typeof module!=='undefined'?module.exports=f():r.AudioFix=f();})(typeof self!=='undefined'?self:this,function(){
'use strict';
function makeTanhCurve(n){n=n||1024;var c=new Float32Array(n);for(var i=0;i<n;i++){var x=(i*2)/(n-1)-1;c[i]=Math.tanh?Math.tanh(x):(Math.exp(x)-Math.exp(-x))/(Math.exp(x)+Math.exp(-x));}return c;}
function createAudioFix(ctx,srcNode){
if(!ctx||!srcNode)throw new Error('ctx and srcNode required');
if(srcNode.__audioFix)return srcNode.__audioFix;
var splitter=ctx.createChannelSplitter(2),gLL=ctx.createGain(),gRL=ctx.createGain(),gRR=ctx.createGain(),gLR=ctx.createGain();
var delayL=ctx.createDelay?ctx.createDelay(1.0):{delayTime:{value:0},connect:function(){}};
var delayR=ctx.createDelay?ctx.createDelay(1.0):{delayTime:{value:0},connect:function(){}};
var merger=ctx.createChannelMerger(2),masterGain=ctx.createGain();
var limiter=ctx.createWaveShaper?ctx.createWaveShaper():{curve:null,connect:function(){}};
if(limiter&&ctx.createWaveShaper)limiter.curve=makeTanhCurve(1024);
srcNode.connect(splitter);splitter.connect(gLL,0);splitter.connect(gRL,1);splitter.connect(gRR,1);splitter.connect(gLR,0);
gLL.connect(delayL);gRL.connect(delayL);gRR.connect(delayR);gLR.connect(delayR);
if(delayL.connect)delayL.connect(merger,0,0);if(delayR.connect)delayR.connect(merger,0,1);
merger.connect(masterGain);masterGain.connect(limiter);limiter.connect(ctx.destination);
var curMode='stereo',curBal=0;
function setGains(ll,rl,rr,lr){gLL.gain.value=ll;gRL.gain.value=rl;gRR.gain.value=rr;gLR.gain.value=lr;}
function setBalance(bal){var b=Math.max(-1,Math.min(1,parseFloat(bal)||0));curBal=b;curMode='balance';setGains(b<=0?1:1-b,0,b>=0?1:1+b,0);}
function setMode(mode){curMode=mode||'stereo';if(curMode==='mono')setGains(0.5,0.5,0.5,0.5);else if(curMode==='swap')setGains(0,1,0,1);else if(curMode==='balance')setBalance(curBal);else {curMode='stereo';setGains(1,0,1,0);}}
function setBoost(b){masterGain.gain.value=Math.max(0,Math.min(10,parseFloat(b)||0));}
function setDelayMs(ms){var val=Math.max(-1000,Math.min(1000,parseFloat(ms)||0)),sec=Math.abs(val)/1000;if(delayL.delayTime)delayL.delayTime.value=val>0?sec:0;if(delayR.delayTime)delayR.delayTime.value=val<0?sec:0;}
function reset(){setMode('stereo');curBal=0;setBoost(1);setDelayMs(0);}
function bindGesture(target){var t=target||(typeof window!=='undefined'?window:null);if(!t||!t.addEventListener)return;var h=function(){if(ctx.state==='suspended'&&typeof ctx.resume==='function')ctx.resume();['click','keydown','touchstart'].forEach(function(e){t.removeEventListener(e,h);});};['click','keydown','touchstart'].forEach(function(e){t.addEventListener(e,h);});}
reset();
var inst={setMode:setMode,setBalance:setBalance,setBoost:setBoost,setDelayMs:setDelayMs,reset:reset,bindGesture:bindGesture,nodes:{splitter:splitter,gLL:gLL,gRL:gRL,gRR:gRR,gLR:gLR,delayL:delayL,delayR:delayR,merger:merger,masterGain:masterGain,limiter:limiter}};
srcNode.__audioFix=inst;return inst;
}
return {createAudioFix:createAudioFix};
});
