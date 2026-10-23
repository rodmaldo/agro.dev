const R='/opt/npm-tools/node_modules/';
const React=require(R+'react');globalThis.window=globalThis;globalThis.React=React;
globalThis.htm={bind:()=>()=>null};
const base=__dirname+'/../js/';
require(base+'engine.js');require(base+'layers.js');require(base+'geo.js');const M=require(base+'mosaic.js');
/* ---- JPEG sintético con EXIF GPS + XMP DJI ---- */
function rat(n,d){const b=Buffer.alloc(8);b.writeUInt32LE(n,0);b.writeUInt32LE(d,4);return b}
function jpeg(lat,lon,yaw,alt,rtk,W=5280,H=3956){
  const ifd0=Buffer.alloc(18);ifd0.writeUInt16LE(1,0);ifd0.writeUInt16LE(0x8825,2);ifd0.writeUInt16LE(4,4);ifd0.writeUInt32LE(1,6);ifd0.writeUInt32LE(26,10);
  const gps=Buffer.alloc(54);gps.writeUInt16LE(4,0);
  const ent=(i,tag,type,cnt,val)=>{const o=2+i*12;gps.writeUInt16LE(tag,o);gps.writeUInt16LE(type,o+2);gps.writeUInt32LE(cnt,o+4);if(Buffer.isBuffer(val))val.copy(gps,o+8);else gps.writeUInt32LE(val,o+8)};
  ent(0,1,2,2,Buffer.from(lat<0?'S\0':'N\0'));ent(1,2,5,3,80);ent(2,3,2,2,Buffer.from(lon<0?'W\0':'E\0'));ent(3,4,5,3,104);
  const dms=x=>{x=Math.abs(x);const d=Math.floor(x),m=Math.floor((x-d)*60),s=Math.round(((x-d)*60-m)*60*1000);return Buffer.concat([rat(d,1),rat(m,1),rat(s,1000)])};
  const tiff=Buffer.concat([Buffer.from([0x49,0x49,0x2a,0,8,0,0,0]),ifd0,gps,dms(lat),dms(lon)]);
  const seg=(m,body)=>{const h=Buffer.alloc(4);h.writeUInt16BE(m,0);h.writeUInt16BE(body.length+2,2);return Buffer.concat([h,body])};
  const exif=seg(0xFFE1,Buffer.concat([Buffer.from('Exif\0\0','latin1'),tiff]));
  const xmp=seg(0xFFE1,Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0','latin1'),Buffer.from(`<x drone-dji:GimbalYawDegree="${yaw}" drone-dji:RelativeAltitude="${alt}" drone-dji:RtkFlag="${rtk}"/>`)]));
  const sof=Buffer.alloc(15);sof[0]=8;sof.writeUInt16BE(H,1);sof.writeUInt16BE(W,3);sof[5]=3;
  return Buffer.concat([Buffer.from([0xFF,0xD8]),exif,xmp,seg(0xFFC0,sof),Buffer.from([0xFF,0xDA,0,2,0,0,0,0,0,0,0,0])]);
}
const mk=(name,buf,size)=>({name,size:size||buf.length,slice:()=>({arrayBuffer:async()=>buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.length)})});
(async()=>{
  const e=await AZGeo.exif(mk('a.jpg',jpeg(-33.5,-61.25,90.5,100,50)));
  console.log('EXIF',JSON.stringify(e));
  const ok=Math.abs(e.lat+33.5)<1e-6&&Math.abs(e.lon+61.25)<1e-6&&e.yaw===90.5&&e.relAlt===100&&e.rtk===50&&e.w===5280&&e.h===3956;console.log('EXIF correcto:',ok);
  /* ---- layout: 3x3 fotos cada 50 m ---- */
  const KY=110574,KX=111320*Math.cos(33.5*Math.PI/180),metas=[];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)metas.push({lat:-33.5+i*50/KY,lon:-61.25+j*50/KX,yaw:0,w:5280,h:3956});
  let L=M.layout(metas,{res:0.03,maxD:3200});console.log('layout yaw0 →',L.W,'x',L.H,'mpp',L.mpp.toFixed(4),'hull',L.hull.length,'centro',L.lat.toFixed(5),L.lon.toFixed(5));
  const ha=L.W*L.H*L.mpp*L.mpp/1e4;console.log('área bbox ha',ha.toFixed(2),'(esperado ≈',((100+158.4)*(100+118.68)/1e4).toFixed(2),')');
  metas.forEach(m=>m.yaw=90);L=M.layout(metas,{res:0.03,maxD:3200});console.log('layout yaw90 →',L.W,'x',L.H,'(ancho/alto se invierten)');
  /* ---- analyze + acumulación (2 carpetas, 150 fotos c/u) ---- */
  require(R+'react');
  const files=[];for(const d of['100MEDIA','101MEDIA'])for(let k=0;k<150;k++){const f=mk(`DJI_2026_${d}_${k}_D.JPG`,jpeg(-33.5+k*1e-4,-61.25,0,100,50),8e6);files.push({f,path:`DCIM/${d}/${f.name}`});
    files.push({f:mk(`DJI_2026_${d}_${k}_MS_NIR.TIF`,Buffer.alloc(10),2e6),path:`DCIM/${d}/DJI_2026_${d}_${k}_MS_NIR.TIF`})}
  for(const f of['api.js']);
  globalThis.htm={bind:()=>()=>null};
  const U=require(base+'components/common.js');
  require(base+'files.js');
  const {analyze}=AZFiles;
  const a=await analyze(files.slice(0,300)),b=await analyze(files);
  console.log('carpeta 1:',a.raw.length,'RGB ·',a.ms,'MS | ambas:',b.raw.length,'RGB ·',b.ms,'MS · carpetas',b.folders.map(x=>x[0]+':'+x[1].rgb).join(', '),'· GPS',b.gps&&b.gps.lat.toFixed(4),'RTK',b.rtk,'alt',b.alt);
  /* ---- engine: píxeles transparentes ---- */
  const AZ=globalThis.AZ,W=400,H=200,data=new Uint8ClampedArray(W*H*4);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const p=(y*W+x)*4;data[p]=60;data[p+1]=120;data[p+2]=50;data[p+3]=x<200?0:255}
  const S=AZ.newState();AZ.setImage(S,{width:W,height:H,getContext:()=>({getImageData:()=>({data})})},1,null);AZ.prepare(S,10);
  const st=AZ.stats(S);console.log('transparente: total ha',st.tot.toFixed(2),'(esperado 4.00) lote ha',st.lote.toFixed(2));
})().catch(e=>{console.error('ERROR',e);process.exit(1)});
