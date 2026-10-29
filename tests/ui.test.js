const path=require('path'),fs=require('fs');
const R='/opt/npm-tools/node_modules/';
const React=require(R+'react'),Server=require(R+'react-dom/server');
globalThis.window=globalThis;globalThis.React=React;
globalThis.document={fonts:{load:()=>Promise.resolve()},createElement:()=>({getContext:()=>({})})};globalThis.localStorage={getItem:()=>null,setItem(){}};globalThis.sessionStorage={getItem:()=>null,setItem(){},removeItem(){}};globalThis.screen={width:1920,height:1080};globalThis.devicePixelRatio=1;globalThis.confirm=()=>true;
globalThis.innerWidth=1400;globalThis.addEventListener=()=>{};globalThis.removeEventListener=()=>{};
/* mini htm (solo para esta prueba) */
function miniHtm(statics,...vals){
  const h=this;let src=statics[0];for(let i=0;i<vals.length;i++)src+='\u0001'+i+'\u0002'+statics[i+1];
  let pos=0;const M=/\u0001(\d+)\u0002/g;
  const val=s=>{const m=/^\u0001(\d+)\u0002$/.exec(s);if(m)return vals[+m[1]];return s.replace(M,(_,i)=>vals[+i])};
  const err=m=>{throw new Error('htm: '+m+' @ '+JSON.stringify(src.slice(Math.max(0,pos-40),pos+40)))};
  function nodes(){const out=[];
    while(pos<src.length){
      if(src[pos]==='<'){
        if(src.startsWith('<//>',pos)){pos+=4;return{out,closed:true}}
        if(src[pos+1]==='/'){const e=src.indexOf('>',pos);pos=e+1;return{out,closed:true,named:true}}
        pos++;let tag;const mm=/^\u0001(\d+)\u0002/.exec(src.slice(pos));
        if(mm){tag=vals[+mm[1]];pos+=mm[0].length}else{const t=/^[A-Za-z][\w.-]*/.exec(src.slice(pos));if(!t)err('tag');tag=t[0];pos+=tag.length}
        const props={};let self=false;
        for(;;){while(/\s/.test(src[pos]))pos++;
          if(src.startsWith('/>',pos)){pos+=2;self=true;break}
          if(src[pos]==='>'){pos++;break}
          if(pos>=src.length)err('eof en tag '+String(tag));
          const a=/^[^\s=\/>]+/.exec(src.slice(pos));if(!a)err('attr');pos+=a[0].length;let v=true;
          if(src[pos]==='='){pos++;if(src[pos]==='"'||src[pos]==="'"){const q=src[pos],e=src.indexOf(q,pos+1);v=val(src.slice(pos+1,e));pos=e+1}else{const b=/^(\u0001\d+\u0002|[^\s>\/]+)/.exec(src.slice(pos));v=val(b[0]);pos+=b[0].length}}
          props[a[0]]=v}
        let kids=[];if(!self){const r=nodes();kids=r.out;if(!r.closed)err('sin cierre de '+String(tag&&tag.name||tag))}
        out.push(h(tag,props,...kids));
      }else{let e=src.indexOf('<',pos);if(e<0)e=src.length;let t=src.slice(pos,e);pos=e;
        if(/\n/.test(t))t=t.replace(/^\s*\n\s*|\s*\n\s*$/g,'').replace(/\s*\n\s*/g,' ');
        if(!t)continue;let last=0,m;M.lastIndex=0;while((m=M.exec(t))){if(m.index>last)out.push(t.slice(last,m.index));out.push(vals[+m[1]]);last=M.lastIndex}if(last<t.length)out.push(t.slice(last))}
    }return{out,closed:false}}
  const r=nodes();return r.out.length===1?r.out[0]:r.out;
}
globalThis.htm={bind:h=>miniHtm.bind(h)};
/* parche de useState para forzar estados de UI */
const realUS=React.useState;let FORCE=null;
React.useState=init=>{let v=typeof init==='function'?init():init;if(FORCE&&v&&v.tool==='pan'&&v.vis)v={...v,...FORCE};return realUS(()=>v)};
const base=path.join(__dirname,'..','js')+'/';
for(const f of['api.js','engine.js','layers.js','exporter.js','geo.js','mosaic.js','map.js','files.js','desktop.js','lotstate.js','learn.js','sys.js','components/common.js','components/shared.js','components/splash.js','components/progress.js','components/home.js','components/mapcanvas.js','components/wizard.js','components/dashboard.js'])require(base+f);
const U=AZUI,h=React.createElement;
const ok=(n,el,...must)=>{const s=Server.renderToString(el);const miss=must.filter(m=>!m.test(s));console.log(miss.length?'FALLA':'OK',n,s.length,'bytes',miss.map(String).join(' '));if(miss.length)process.exitCode=1;return s};
ok('Splash',h(U.Splash,{phase:'splash',onEnter(){}}));
ok('Login',h(U.Login,{onOk(){},onCancel(){}}));
ok('Proyecto',h(U.Project,{user:'rodma',farm:{id:'r1',name:'Estancia Norte'},onOpen(){},onBack(){},onLogout(){}}),/Nuevo lote/,/Estancia Norte/);
ok('Home',h(U.Home,{user:'rodma',onOpenFarm(){},onLogout(){}}),/Nuevo proyecto/,/v(<!-- -->)?0\.2\.0/,/hilos/);
const field={id:'f1',name:'Lote Norte'};
const info={n:10,mb:20,folders:[['100MEDIA',{rgb:8,ms:0,otros:0}]],raw:[{f:{name:'a_D.JPG',size:5},path:'a'},{f:{name:'b_D.JPG',size:6},path:'b'}],ms:0,tif:0,other:0,ortho:null,gps:{lat:-33.1,lon:-61.2},rtk:50,alt:100,yaw:12,geoPhotos:2};
ok('Field vacío',h(U.Field,{user:'rodma',field,job:{items:[],info:null,preset:null},setJob(){},onBack(){},onNext(){},onLogout(){}}),/Subir carpeta/,/Importar proyecto/,/Subir archivos/);
ok('Field con vuelo',h(U.Field,{user:'rodma',field,job:{items:[1],info,preset:null},setJob(){},onBack(){},onNext(){},onLogout(){}}),/Fotos RGB/,/Siguiente/);
const mkS=()=>{const d=AZ.demoPixels(),c={width:d.W,height:d.H,getContext:()=>({getImageData:()=>({data:d.data})})},S=AZ.newState();AZ.setImage(S,c,d.mpp,d.poly);AZ.prepare(S,5);return S};
const cfg={kind:'rgb',source:'mosaic',ndvi:null,res:'3',quality:'media',detail:'norm',prec:'rtk',lat:-33.1,lon:-61.2,gridM:5,rot:0,detName:'Salitre',color:'#E69F00',sens:50};
const job={items:[1],info,preset:null,base:{},note:'2 de 2 fotos'};
for(const [st,re] of [[0,[/Tipo de im/,/RGB \+ Multiespectral/,/Par.metros avanzados/]],[1,[/Configurar grilla/,/Orientaci.n de la grilla/,/Usar rumbo del vuelo/,/Aplicar/]],[2,[/L.mites del lote/,/Importar KML/,/Dentro del l.mite/]],[3,[/Detecci.n de zonas/,/Procesamiento por IA/,/agro-tono/,/al menos 5 puntos positivos/]]]){
  const S=mkS();ok('Wizard paso '+st,h(U.Wizard,{user:'rodma',field,job,S,cfg,setCfg(){},initStep:st,onBack(){},onDone(){},onLogout(){}}),...re);}
/* Dashboard con detección, manual, histograma y buffer */
const S=mkS();
[[420,330,1],[1130,640,1],[800,880,1],[300,500,-1],[900,200,-1],[1400,600,-1]].forEach(([x,y,v])=>{const [i,j]=AZ.cellAt(S,x,y);AZ.togglePoint(S,i,j,v)});
AZ.detect(S,50,true);AZ.addManual(S);const [bi,bj]=AZ.cellAt(S,300,500);AZ.brush(S,'man',bi,bj,4,1);const hid=AZ.addHist(S),L=AZ.layerOf(S,hid);AZ.histRange(S,L,S.lim.exg[0],S.lim.exg[0]+0.05);AZ.setBuffer(S,true,10);
for(const f of[{tool:'pan'},{tool:'wand',active:hid,exportOpen:true},{tool:'brush',active:'man',ba:true,ctx:{x:10,y:10},help:true}]){FORCE=f;
  ok('Dashboard '+Object.keys(f),h(U.Dashboard,{user:'rodma',field,S,cfg,job,onLogout(){},onHome(){},onReconfig(){}}),/Hect.reas f.rtiles/,/Hect.reas inf.rtiles/,/Ortomosaico original/,/Salitre/,/Buffer/,/Histograma 1/);}
console.log('FIN');
