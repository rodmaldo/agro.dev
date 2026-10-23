const S=require('../js/stitch.js');
function rng(seed){let s=seed>>>0;return()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296}}
const R=rng(7);
/* terreno verdadero: 400 x 300 m a 0.25 m/px, 3 canales: ruido multi-escala + surcos + manchas */
const GW=1600,GH=1200,RES=0.25,GT=new Float32Array(GW*GH*3);
function noiseLayer(cell,amp){const gw=Math.ceil(GW/cell)+2,gh=Math.ceil(GH/cell)+2,g=Array.from({length:gw*gh*3},()=>R()*2-1);
  for(let y=0;y<GH;y++)for(let x=0;x<GW;x++){const fx=x/cell,fy=y/cell,x0=fx|0,y0=fy|0,ax=fx-x0,ay=fy-y0;for(let c=0;c<3;c++){const v=(g[(y0*gw+x0)*3+c]*(1-ax)+g[(y0*gw+x0+1)*3+c]*ax)*(1-ay)+(g[((y0+1)*gw+x0)*3+c]*(1-ax)+g[((y0+1)*gw+x0+1)*3+c]*ax)*ay;GT[(y*GW+x)*3+c]+=v*amp}}}
for(let i=0;i<GT.length;i++)GT[i]=110;
[[160,40],[80,30],[40,22],[16,16],[6,10],[2.5,6]].forEach(([c,a])=>noiseLayer(c,a));
for(let y=0;y<GH;y++)for(let x=0;x<GW;x++)for(let c=0;c<3;c++)GT[(y*GW+x)*3+c]+=25*Math.sin(x*2*Math.PI/2.8)*(c===1?1:.4);
const gt=(E,N,c)=>{const x=(E+200)/RES-.5,y=(150-N)/RES-.5;if(x<0||y<0||x>=GW-1||y>=GH-1)return 110;const x0=x|0,y0=y|0,ax=x-x0,ay=y-y0;return(GT[(y0*GW+x0)*3+c]*(1-ax)+GT[(y0*GW+x0+1)*3+c]*ax)*(1-ay)+(GT[((y0+1)*GW+x0)*3+c]*(1-ax)+GT[((y0+1)*GW+x0+1)*3+c]*ax)*ay};
const gauss=()=>Math.sqrt(-2*Math.log(R()+1e-12))*Math.cos(2*Math.PI*R());
/* vuelo: 5 x 5 fotos de 120 x 90 m cada 50 x 40 m, filas alternadas con rumbo 0/180, GPS con error 1.5 m, brillo distinto por foto */
const FW=120,FH=90,GWt=192,GHt=144,photos=[],truth=[],gainTrue=[];
let id=0;
for(let r=0;r<5;r++)for(let c=0;c<5;c++){
  const et=-100+c*50,nt=-80+r*40,rot=(r%2?Math.PI:0),cs=Math.cos(rot),sn=Math.sin(rot),g=[0.8+R()*0.4,0.8+R()*0.4,0.8+R()*0.4],rgb=new Uint8Array(GWt*GHt*3);
  for(let v=0;v<GHt;v++)for(let u=0;u<GWt;u++){const x=((u+.5)/GWt-.5)*FW,y=((v+.5)/GHt-.5)*FH;
    for(let q=0;q<3;q++){let s=0;for(let a=0;a<3;a++)for(let b=0;b<3;b++){const xx=x+((a-1)/3)*FW/GWt,yy=y+((b-1)/3)*FH/GHt;s+=gt(et+xx*cs-yy*sn,nt-(xx*sn+yy*cs),q)}rgb[(v*GWt+u)*3+q]=Math.max(0,Math.min(255,s/9*g[q]+gauss()*2))}}
  truth.push([et,nt]);gainTrue.push(g);photos.push({e:et+gauss()*1.5,n:nt+gauss()*1.5,rot,fw:FW,fh:FH,gw:GWt,gh:GHt,rgb,id:id++});
}
const rms=(arr)=>Math.sqrt(arr.reduce((s,v)=>s+v*v,0)/arr.length);
(async()=>{let t=Date.now();const A=await S.align(photos,{});
const errB=photos.map((p,i)=>Math.hypot(p.e-truth[i][0],p.n-truth[i][1]));
let A0=0;console.log('align',Date.now()-t,'ms',JSON.stringify(A.stats,(k,v)=>typeof v==='number'?+v.toFixed(2):v));
const mE=photos.reduce((s,p,i)=>s+(p.e+A.d[2*i]-truth[i][0]),0)/photos.length,mN=photos.reduce((s,p,i)=>s+(p.n+A.d[2*i+1]-truth[i][1]),0)/photos.length;
const errA=photos.map((p,i)=>Math.hypot(p.e+A.d[2*i]-truth[i][0]-mE,p.n+A.d[2*i+1]-truth[i][1]-mN));
const mE0=photos.reduce((s,p,i)=>s+(p.e-truth[i][0]),0)/photos.length,mN0=photos.reduce((s,p,i)=>s+(p.n-truth[i][1]),0)/photos.length;
const errB0=photos.map((p,i)=>Math.hypot(p.e-truth[i][0]-mE0,p.n-truth[i][1]-mN0));
console.log('error de posición RMS (m, sin traslación global): GPS',rms(errB0).toFixed(2),'→ alineado',rms(errA).toFixed(2));
/* ganancias: relativas entre fotos (g*gain debe ser ≈ constante) */
const prod=photos.map((p,i)=>[0,1,2].map(q=>gainTrue[i][q]*A.gain[i*3+q]));const cv=q=>{const m=prod.reduce((s,v)=>s+v[q],0)/prod.length;return Math.sqrt(prod.reduce((s,v)=>s+(v[q]-m)**2,0)/prod.length)/m};
const cv0=q=>{const m=gainTrue.reduce((s,v)=>s+v[q],0)/gainTrue.length;return Math.sqrt(gainTrue.reduce((s,v)=>s+(v[q]-m)**2,0)/gainTrue.length)/m};
console.log('variación de brillo entre fotos (CV): antes',[0,1,2].map(q=>cv0(q).toFixed(3)).join('/'),'después',[0,1,2].map(q=>cv(q).toFixed(3)).join('/'));
/* mosaico: comparar con el terreno verdadero */
const MPP=0.5,MW=Math.round(300/MPP),MH=Math.round(230/MPP),cfg={mpp:MPP,cE:0,cN:0,K:0.9};
const src=(i)=>{const sw=300,sh=225,d=new Uint8ClampedArray(sw*sh*4),p=truth[i],rot=photos[i].rot,cs=Math.cos(rot),sn=Math.sin(rot);for(let v=0;v<sh;v++)for(let u=0;u<sw;u++){const x=((u+.5)/sw-.5)*FW,y=((v+.5)/sh-.5)*FH;for(let q=0;q<3;q++)d[(v*sw+u)*4+q]=Math.max(0,Math.min(255,gt(p[0]+x*cs-y*sn,p[1]-(x*sn+y*cs),q)*gainTrue[i][q]));d[(v*sw+u)*4+3]=255}return{data:d,w:sw,h:sh}};
function mosaic(useD,useG){const acc=S.newAcc(MW,MH);photos.forEach((p,i)=>{const q={...p,e:p.e+(useD?A.d[2*i]:0),n:p.n+(useD?A.d[2*i+1]:0)};S.accumulate(acc,q,src(i),cfg,useG?[A.gain[i*3],A.gain[i*3+1],A.gain[i*3+2]]:null)});return S.finish(acc)}
function score(img){/* correlación con el terreno verdadero (canal verde) y error tras ajuste lineal */let n=0,sx=0,sy=0,sxx=0,syy=0,sxy=0;for(let my=0;my<MH;my++)for(let mx=0;mx<MW;mx++){const k=my*MW+mx;if(!img[k*4+3])continue;const E=(mx+.5-MW/2)*MPP,N=-(my+.5-MH/2)*MPP;if(Math.abs(E)>150||Math.abs(N)>110)continue;
  /* promedio local del terreno para igualar la resolución del mosaico */let a=0;for(let i=0;i<2;i++)for(let j=0;j<2;j++)a+=gt(E+(i-.5)*.25,N+(j-.5)*.25,1);a/=4;const b=img[k*4+1];n++;sx+=a;sy+=b;sxx+=a*a;syy+=b*b;sxy+=a*b}
  const cov=sxy/n-sx*sy/n/n,va=sxx/n-(sx/n)**2,vb=syy/n-(sy/n)**2;return{corr:cov/Math.sqrt(va*vb),n}}
t=Date.now();const m0=mosaic(false,false),m1=mosaic(true,true);console.log('mezcla',Date.now()-t,'ms');
const s0=score(m0),s1=score(m1);console.log('correlación con el terreno real  collage GPS:',s0.corr.toFixed(3),' unión alineada + color:',s1.corr.toFixed(3));
const ok=rms(errA)<0.6*rms(errB0)&&s1.corr>s0.corr;console.log(ok?'OK':'FALLA');process.exit(ok?0:1);})();
