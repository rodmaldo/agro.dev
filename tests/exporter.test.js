const AZ=require('../js/engine.js');globalThis.AZ=AZ;require('../js/layers.js');require('../js/exporter.js');
const assert=require('assert'),fs=require('fs');
const d=AZ.demoPixels(),S=AZ.newState();
AZ.setImage(S,{width:d.W,height:d.H,getContext:()=>({getImageData:()=>({data:d.data})})},d.mpp,d.poly);
AZ.prepare(S,10);
[[420,330,1],[1130,640,1],[800,880,1],[300,500,-1],[900,200,-1],[1400,600,-1]].forEach(([x,y,v])=>{const [i,j]=AZ.cellAt(S,x,y);AZ.togglePoint(S,i,j,v)});
AZ.detect(S,50,true);AZ.setBuffer(S,true,10);S.geo={lat:-33.1,lon:-61.2,rtk:true};S.rot=15;
const o={field:'Lote Norte',dose:80,mode:'apl',price:2.5,version:'0.2.0'};
const c=AZ.X.consumption(S,o);console.log('lote',c.loteHa.toFixed(1),'tratar',c.treatHa.toFixed(1),'ahorro L',c.save.toFixed(0),c.savePct.toFixed(1)+'%','$',c.money.toFixed(0));
const pz=AZ.X.prescriptionZip(S,o);console.log('rects',pz.n,'zip bytes',pz.bytes.length);
// área de rectángulos == stats
const items=AZ.X.prescription(S,o),sum=k=>items.filter(i=>i.clase===k).reduce((a,i)=>a+i.ha,0),st=AZ.stats(S);
assert(Math.abs(sum('FERTIL')-c.treatHa)<1e-6);assert(Math.abs(sum('INFERTIL')-st.inf)<1e-6);
fs.writeFileSync('out_rx.zip',pz.bytes);
fs.writeFileSync('out_rep.html',AZ.X.reportHtml(S,o));
console.log('geojson',AZ.X.geojson(S,o).features.length);
