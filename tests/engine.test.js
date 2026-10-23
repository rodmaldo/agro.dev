const AZ=require('../js/engine.js');globalThis.AZ=AZ;require('../js/layers.js');
const assert=require('assert');
const d=AZ.demoPixels();
const S=AZ.newState();
const canvas={width:d.W,height:d.H,getContext:()=>({getImageData:()=>({data:d.data})})};
AZ.setImage(S,canvas,d.mpp,d.poly);
let t=Date.now();AZ.prepare(S,5);console.log('prepare',Date.now()-t,'ms grid',S.gw,'x',S.gh,'cell m',AZ.cellM(S).toFixed(2));
let st=AZ.stats(S);console.log('lote ha',st.lote.toFixed(1),'total ha',st.tot.toFixed(1));
// puntos snapped a celdas
let c;[[420,330,1],[1130,640,1],[800,880,1],[300,500,-1],[900,200,-1],[1400,600,-1]].forEach(([x,y,v])=>{const [i,j]=AZ.cellAt(S,x,y);c=AZ.togglePoint(S,i,j,v);});
assert.deepStrictEqual(c,{pos:3,neg:3});
S.pts.forEach(p=>assert(Math.abs((p.x/S.cs)%1-0.5)<1e-6));
t=Date.now();const n=AZ.detect(S,50,true);console.log('detect',Date.now()-t,'ms cells',n);
st=AZ.stats(S);console.log('inf',st.inf.toFixed(1),'fer',st.fer.toFixed(1),'pct',(st.inf/st.lote*100).toFixed(1),'avg',st.avgFer.toFixed(3),st.avgInf.toFixed(3));
assert(n>0); assert(Math.abs(st.inf+st.fer-st.lote)<1e-6);
const at=(x,y)=>S.det[Math.floor(y/S.cs)*S.gw+Math.floor(x/S.cs)];
console.log('salitre',at(420,330),'sano',at(300,500),'borde',at(30,30));
// pincel/borrador sobreviven a re-detección
const [ci,cj]=AZ.cellAt(S,300,500);AZ.brush(S,'det',ci,cj,3,1);assert(at(300,500)===1);
AZ.detect(S,50,true);assert(at(300,500)===1,'brush persiste');
AZ.brush(S,'det',ci,cj,3,0);assert(at(300,500)===0);
// manual + combinar
AZ.addManual(S);AZ.brush(S,'man',ci,cj,5,1);const m1=AZ.stats(S).inf;assert(m1>st.inf);
AZ.combineManual(S);assert(!S.man);assert(Math.abs(AZ.stats(S).inf-m1)<1e-6);
// histograma + varita
const id=AZ.addHist(S),L=AZ.layerOf(S,id);
const [wi,wj]=AZ.cellAt(S,1420,820);
console.log('wand',AZ.wandSel(S,L,wi,wj,false,8),'celdas',AZ.count(L.mask));
const k1=AZ.count(L.mask);AZ.wandSel(S,L,ci,cj,true,8);assert(AZ.count(L.mask)>=k1);
console.log('erase',AZ.wandErase(S,L,wi,wj),'celdas',AZ.count(L.mask));
AZ.histRange(S,L,S.lim.exg[0],S.lim.exg[1]);assert(AZ.selectRange(S,L)>0);
const hb=AZ.histBins(S,'exg',32);assert(hb.rest.length===32);
AZ.clearLayer(S,L);
// buffer
AZ.setBuffer(S,true,20);st=AZ.stats(S);console.log('buffer ha',st.buf.toFixed(1),'treat',st.treat.toFixed(1));assert(st.buf>0&&st.treat<st.fer);
const b1=st.buf;AZ.setBuffer(S,true,40);assert(AZ.stats(S).buf>b1);
// grilla extremas
for(const gm of [1,25]){t=Date.now();AZ.prepare(S,gm);console.log('grid',gm,'->',AZ.cellM(S).toFixed(2),S.gw*S.gh,'cells',Date.now()-t,'ms');}
console.log('OK');
/* rotación: punto del mosaico original -> imagen girada -> geo debe coincidir con el geo del original */
{
  const A=AZ.newState();A.W=3000;A.H=2000;A.mpp=0.05;A.geo={lat:-33.1,lon:-61.2,rtk:false};A.rot=0;
  const th=23.5,t=th*Math.PI/180,c=Math.abs(Math.cos(t)),s=Math.abs(Math.sin(t)),w1=Math.ceil(3000*c+2000*s),h1=Math.ceil(3000*s+2000*c);
  const B=AZ.newState();B.W=w1;B.H=h1;B.mpp=0.05;B.geo=A.geo;B.rot=th;
  for(const p of [[100,200],[2900,150],[1500,1000],[40,1900]]){
    const q=AZ.rotPts([p],th,3000,2000,w1,h1)[0],g0=AZ.pxToGeo(A,p[0],p[1]),g1=AZ.pxToGeo(B,q[0],q[1]);
    assert(Math.abs(g0.lat-g1.lat)<1e-9&&Math.abs(g0.lon-g1.lon)<1e-9,'rotación inconsistente '+JSON.stringify([g0,g1]));
  }
  console.log('rotación OK');
}
