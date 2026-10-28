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

// límites KML / GeoJSON
const kml='<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>-61.20,-33.10,0 -61.19,-33.10,0 -61.19,-33.11,0 -61.20,-33.11,0 -61.20,-33.10,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>';
const rk=AZ.X.parseBoundary(kml);assert.strictEqual(rk.length,1);assert.strictEqual(rk[0].length,4);
const rg=AZ.X.parseBoundary(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Polygon',coordinates:[[[-61.2,-33.1],[-61.19,-33.1],[-61.19,-33.11],[-61.2,-33.1]]]}}]}));assert.strictEqual(rg.length,1);assert.strictEqual(rg[0].length,3);
assert.strictEqual(AZ.X.parseBoundary('basura').length,0);
// ida y vuelta geo <-> píxel
{const q=AZ.pxToGeo(S,500,400),b=AZ.geoToPx(S,q.lat,q.lon);assert(Math.hypot(b[0]-500,b[1]-400)<1e-6);}
console.log('límites OK');
// plano tangente exacto: ida y vuelta y coincidencia con el motor (Python: Frame.to_latlon(1500,-1500) con lat0=-33.11, lon0=-61.19)
{const r=AZ.enuToGeo(-33.11,-61.19,1500,-1500),b=AZ.geoToEnu(-33.11,-61.19,r.lat,r.lon);assert(Math.hypot(b[0]-1500,b[1]+1500)<1e-6);console.log('enu',r.lat.toFixed(9),r.lon.toFixed(9));
 const S2=AZ.newState();S2.W=1000;S2.H=800;S2.mpp=0.1;S2.rot=20;S2.geo={lat:0,lon:0,lat0:-33.11,lon0:-61.19,cE:100,cN:-50,exact:true};
 const q=AZ.pxToGeo(S2,321,654),p=AZ.geoToPx(S2,q.lat,q.lon);assert(Math.hypot(p[0]-321,p[1]-654)<1e-5);console.log('geo exacto OK');}

// regiones con huecos y esquinas que se tocan
{const gw=6,gh=5,m=new Uint8Array(gw*gh);for(let j=0;j<gh;j++)for(let i=0;i<gw;i++)m[j*gw+i]=1;m[2*gw+2]=0;m[2*gw+3]=0;      // hueco 2x1
 const r=AZ.X.regions(m,gw,gh);assert.strictEqual(r.length,1);assert.strictEqual(r[0].rings.length,2);assert.strictEqual(r[0].cells,28);
 const d=new Uint8Array(9);d[0]=1;d[4]=1;d[8]=1;const rd=AZ.X.regions(d,3,3);assert.strictEqual(rd.length,3);rd.forEach(q=>assert.strictEqual(q.cells,1));console.log('regiones OK');}
// ambientación de 5 niveles
{AZ.addAmb(S,'exg');const A=S.amb;assert.strictEqual(A.th.length,4);const st0=AZ.ambStats(S);assert(Math.abs(st0.tot-AZ.stats(S).lote)<1e-6);
 A.rates=[0,0,20,30,40];const o2={field:'Lote Norte',dose:40,mode:'apl',price:2.5,version:'0.2.0',machine:'JD',omitZero:false},c2=AZ.X.consumption(S,o2);
 const it=AZ.X.prescription(S,o2);const tot=it.reduce((a,i)=>a+i.ha,0);assert(Math.abs(tot-AZ.stats(S).lote)<1e-4,'las zonas cubren todo el lote sin solaparse');
 const used=it.reduce((a,i)=>a+i.ha*i.rate,0);assert(Math.abs(used-c2.used)<1e-3);console.log('amb niveles',st0.ha.map(v=>v.toFixed(1)).join('/'),'volumen',c2.used.toFixed(0),'poligonos',it.length);
 fs.writeFileSync('out_rx_amb.zip',AZ.X.prescriptionZip(S,o2).bytes);
 const n0=AZ.ambToDet(S);console.log('niveles 0 -> detección',n0);}
