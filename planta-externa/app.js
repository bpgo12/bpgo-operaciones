(()=>{const C=BP_GIS_CONFIG,$=id=>document.getElementById(id);
const COLORS={OLT:"#db2d2d",MUF:"#f3b61f",CTO:"#1577e5",CAJ:"#d98a13",POS:"#728092",CLI:"#19c6b3"};
const LABELS={OLT:"OLT / Central",MUF:"Mufa",CTO:"Caja de terminación óptica",CAJ:"Caja",POS:"Poste",CLI:"Cliente / ONT",TRK:"Cable de fibra"};
const CABLE_CLASS_LABELS={TRK:"Troncal",DST:"Distribución",DRP:"Drop"};
const CABLE_CLASS_COLORS={TRK:"#20d34a",DST:"#1787e8",DRP:"#f28c28"};
const FIBER_COLORS=["#0066ff","#ff8c00","#00a651","#8b4513","#808080","#ffffff","#ff0000","#000000","#ffff00","#800080","#ff69b4","#00ffff"];
const FIBER_COLOR_NAMES=["Azul","Naranjo","Verde","Café","Gris","Blanco","Rojo","Negro","Amarillo","Violeta","Rosa","Celeste"];
const TUBE_COLORS=FIBER_COLORS;
const TUBE_COLOR_NAMES=FIBER_COLOR_NAMES;
let map,tool="select",selectedId=null,draft=null,overlays=new Map(),undoStack=[],redoStack=[],opticalCache=new Map(),db=load();
db.features=(db.features||[]);
db.features.filter(f=>f.type==="TRK").forEach(f=>{f.cableClass=f.cableClass||(/^DST-/.test(f.code)?"DST":/^DRP-/.test(f.code)?"DRP":"TRK")});
let selectedCableId=null,selectedFiberIndex=null,contextPoint=null,contextCableId=null,lastContextMenuAt=0;

function now(){return new Date().toISOString()}
function load(){try{
  let raw=localStorage.getItem(C.storageKey);
  if(raw)return JSON.parse(raw);
  let previous=localStorage.getItem("bp-gis-v1.8")||localStorage.getItem("bp-gis-v1.7")||localStorage.getItem("bp-gis-v1.6-reconstruida")||localStorage.getItem("bp-gis-v1.5")||localStorage.getItem("bp-gis-v1.4");
  if(previous){let migrated=JSON.parse(previous);localStorage.setItem(C.storageKey,JSON.stringify(migrated));return migrated}
}catch(e){}
let id=crypto.randomUUID();return{
 counters:{OLT:2,MUF:1,CTO:1,CAJ:1,POS:1,CLI:1,TRK:1},
 features:[{id,type:"OLT",code:"OLT-0001",name:"Central principal BP",sector:"Cañete",status:"Operativo",pon:"",capacity:"16 PON",oltPower:2.3,reference:"Nodo principal",notes:"",
 geometry:{type:"Point",coordinates:[C.mapCenter.lng,C.mapCenter.lat]},
 internals:{pons:Array.from({length:16},(_,i)=>({port:i+1,active:i<14})),splitters:[],splices:[]},
 history:[{at:now(),action:"Creado"}]}]}}
function get(id){return db.features.find(f=>f.id===id)}
function snapshot(){return JSON.stringify(db)}
function pushUndo(){undoStack.push(snapshot());redoStack=[]}
function save(){localStorage.setItem(C.storageKey,JSON.stringify(db));autoBackup();render()}
function autoBackup(){
  const key=`${C.storageKey}-backups`,last=Number(localStorage.getItem(`${key}-at`)||0);
  if(Date.now()-last<300000)return;
  try{
    const backups=JSON.parse(localStorage.getItem(key)||"[]");
    backups.unshift({at:now(),data:db});
    localStorage.setItem(key,JSON.stringify(backups.slice(0,5)));
    localStorage.setItem(`${key}-at`,String(Date.now()))
  }catch(e){}
}
function nextAvailableCode(type){const used=new Set(db.features.filter(f=>f.type===type).map(f=>Number((f.code||"").split("-")[1])).filter(Number.isFinite));let n=1;while(used.has(n))n++;return`${type}-${String(n).padStart(4,"0")}`}
function nextCableCode(prefix){const used=new Set(db.features.filter(f=>f.type==="TRK"&&(f.cableClass||"TRK")===prefix).map(f=>Number((f.code||"").split("-")[1])).filter(Number.isFinite));let n=1;while(used.has(n))n++;return`${prefix}-${String(n).padStart(4,"0")}`}
function toast(msg){$("toast").textContent=msg;$("toast").className="show";setTimeout(()=>$("toast").className="",1600)}

window.bpInitMap=()=>{map=L.map("map",{center:[C.mapCenter.lat,C.mapCenter.lng],zoom:C.mapZoom,maxZoom:22,editable:true});const streets=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxNativeZoom:19,maxZoom:22,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}),satellite=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxNativeZoom:18,maxZoom:22,attribution:"Tiles &copy; Esri"});streets.addTo(map);L.control.layers({"OpenStreetMap":streets,"Satelital":satellite},null,{position:"topright"}).addTo(map);map.on("click",e=>{hideMapContextMenu();mapClick(e.latlng)});const mapElement=$("map");mapElement.addEventListener("contextmenu",event=>{event.preventDefault();event.stopPropagation();const latLng=map.mouseEventToLatLng(event),cableId=event.target.closest?.("[data-cable-id]")?.dataset.cableId||null;showMapContextMenu(latLng,event,cableId)},true);map.on("movestart zoomstart",hideMapContextMenu);if(!$("cableLegend")){const legend=document.createElement("div");legend.id="cableLegend";legend.className="map-legend";legend.innerHTML=`<div><i style="background:${CABLE_CLASS_COLORS.TRK}"></i>Troncal</div><div><i style="background:${CABLE_CLASS_COLORS.DST}"></i>Distribución</div><div><i style="background:${CABLE_CLASS_COLORS.DRP}"></i>Drop</div><div class="legend-divider">Cliente: <b class="level-dot good"></b>óptimo <b class="level-dot warning"></b>revisar <b class="level-dot critical"></b>crítico</div>`;document.querySelector("main").appendChild(legend)}render();setTool("select")};
if(window.L)window.bpInitMap();else window.addEventListener("load",()=>window.bpInitMap());

function markerIcon(type,code,override){let fill=override||COLORS[type]||"#666",num=(code.split("-")[1]||"");let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="58" height="42"><rect x="2" y="2" width="54" height="31" rx="5" fill="${fill}" stroke="#071018" stroke-width="3"/><text x="29" y="22" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="${type==="MUF"?"#111":"#fff"}">${type}</text><text x="29" y="40" text-anchor="middle" font-family="Arial" font-size="8" fill="#fff">${num}</text></svg>`;return L.divIcon({className:"bp-gis-marker",html:svg,iconSize:[58,42],iconAnchor:[29,18]})}

function powered(){let adjacency=new Map(),fibers=db.features.filter(f=>f.type==="TRK"&&f.status!=="Fuera de servicio");
fibers.forEach(f=>{if(!f.sourceId||!f.destId)return;(adjacency.get(f.sourceId)||adjacency.set(f.sourceId,[]).get(f.sourceId)).push([f.destId,f.id]);(adjacency.get(f.destId)||adjacency.set(f.destId,[]).get(f.destId)).push([f.sourceId,f.id])});
let starts=db.features.filter(f=>f.type==="OLT"&&f.status==="Operativo"&&+f.oltPower>-40).map(f=>f.id),assets=new Set(starts),fiberSet=new Set(),queue=[...starts];
while(queue.length){let a=queue.shift();for(let [b,fid] of(adjacency.get(a)||[])){fiberSet.add(fid);if(!assets.has(b)){assets.add(b);queue.push(b)}}}
return{assets,fibers:fiberSet}}

function render(){opticalCache.clear();if(map)renderMap();renderList();if(selectedId)renderDetails(selectedId)}
function removeOverlay(o){if(o&&map?.hasLayer(o))map.removeLayer(o)}
function renderMap(){overlays.forEach(removeOverlay);overlays.clear();let P=powered(),visibleTypes=new Set([...document.querySelectorAll(".layerAsset:checked")].map(x=>x.dataset.type));
db.features.forEach(f=>{if(f.type==="TRK"){if(!$("layerFiber").checked)return;let cableClass=f.cableClass||"TRK";let line=L.polyline(f.geometry.coordinates.map(([lng,lat])=>[lat,lng]),{color:CABLE_CLASS_COLORS[cableClass]||CABLE_CLASS_COLORS.TRK,weight:5}).addTo(map);const lineElement=line.getElement();if(lineElement)lineElement.dataset.cableId=f.id;line.on("click",()=>select(f.id));line.on("contextmenu",e=>showMapContextMenu(e.latlng,e.originalEvent,f.id));if(selectedId===f.id&&tool==="select"&&line.enableEdit){line.enableEdit();line.on("editable:vertex:dragend editable:vertex:new editable:vertex:deleted",()=>syncLine(f,line))}overlays.set(f.id,line)}
else{if(!visibleTypes.has(f.type))return;let[lng,lat]=f.geometry.coordinates,estimate=f.type==="CLI"?opticalEstimate(f.id):null,clientColor=estimate?(estimate.level==="good"?"#20d34a":estimate.level==="warning"?"#f3b61f":"#ef3d32"):null;let marker=L.marker([lat,lng],{icon:markerIcon(f.type,f.code,clientColor),title:f.type==="CLI"?(estimate?`${f.code} · ${estimate.rx.toFixed(1)} dBm`:`${f.code} · Sin ruta óptica`):f.code,draggable:selectedId===f.id&&tool==="select"}).addTo(map);marker.on("click",()=>assetClick(f.id));marker.on("dragend",e=>{pushUndo();const p=e.target.getLatLng();f.geometry.coordinates=[p.lng,p.lat];f.history.push({at:now(),action:"Movido"});save()});overlays.set(f.id,marker)}})
let active=db.features.filter(f=>f.type==="OLT"&&f.status==="Operativo"),mx=active.length?Math.max(...active.map(f=>+f.oltPower||0)):null,clients=db.features.filter(f=>f.type==="CLI"),online=clients.filter(f=>opticalEstimate(f.id)?.rx>=-27).length;$("powerSummary").textContent=clients.length?`Clientes con nivel: ${online}/${clients.length}`:"Potencia OLT: "+(mx==null?"--":(mx>=0?"+":"")+mx.toFixed(1)+" dBm")}
function syncLine(f,line){pushUndo();f.geometry.coordinates=line.getLatLngs().map(p=>[p.lng,p.lat]);save()}

function createAssetAt(type,lng,lat){pushUndo();let f={id:crypto.randomUUID(),type,code:nextAvailableCode(type),name:"",sector:"",status:"Operativo",pon:"",capacity:"",oltPower:type==="OLT"?2.3:"",reference:"",notes:"",geometry:{type:"Point",coordinates:[lng,lat]},internals:{pons:type==="OLT"?Array.from({length:16},(_,i)=>({port:i+1,active:false})):[],splitters:[],splices:[]},history:[{at:now(),action:"Creado"}]};db.features.push(f);save();select(f.id);setTool("select");return f}
function mapClick(latLng){if(tool==="asset")createAssetAt($("assetType").value,latLng.lng,latLng.lat);else if(tool==="fiber"&&draft){draft.path.push({lat:latLng.lat,lng:latLng.lng});drawDraft()}}
function assetClick(id){if(tool==="fiber"){if(!draft){let f=get(id),[lng,lat]=f.geometry.coordinates;draft={sourceId:id,path:[{lat,lng}]};$("toolHelp").textContent=`Origen ${f.code}; agrega vértices y elige destino`;drawDraft()}else if(id!==draft.sourceId){finishFiber(id)}return}select(id)}
function drawDraft(){removeOverlay(overlays.get("_draft"));let line=L.polyline(draft.path.map(p=>[p.lat,p.lng]),{color:"#38bdf8",weight:4}).addTo(map);overlays.set("_draft",line)}
function makeFibers(count){return Array.from({length:count},(_,i)=>({index:i+1,condition:"Normal",color:FIBER_COLORS[i%12]}))}
function ensureCableFibers(cable){
  const count=Number(cable.capacity)||cable.fibers?.length||12;
  const old=cable.fibers||[];
  cable.fibers=Array.from({length:count},(_,i)=>({
    ...(old[i]||{}),
    index:i+1,
    condition:old[i]?.condition||"Normal",
    color:FIBER_COLORS[i%12]
  }));
  cable.capacity=String(count);
  return cable.fibers
}
function fiberTechnicalInfo(cable,index){
  ensureCableFibers(cable);
  return{
    number:index+1,
    color:cable.fibers[index].color,
    colorName:FIBER_COLOR_NAMES[index%12],
    tube:Math.floor(index/12)+1,
    tubeColor:TUBE_COLORS[Math.floor(index/12)%12],
    tubeColorName:TUBE_COLOR_NAMES[Math.floor(index/12)%12]
  }
}

function localSpliceFor(asset,cableId,fiberIndex){return (asset.internals?.splices||[]).find(sp=>sp.cableId===cableId&&sp.fiberIndex===fiberIndex)}
function fiberEndStatus(asset,cable,fiberIndex){const sp=localSpliceFor(asset,cable.id,fiberIndex);if(sp)return{occupied:true,target:spliceTargetLabel(asset,sp),splice:sp};return{occupied:false,target:null,splice:null}}
function allFiberEndUses(cableId,fiberIndex){return db.features.filter(a=>a.geometry?.type==="Point").map(a=>({asset:a,splice:localSpliceFor(a,cableId,fiberIndex)})).filter(x=>x.splice)}
function spliceTargetType(sp){return sp?.targetType||"SPL"}
function spliceTargetKey(sp){
  return spliceTargetType(sp)==="PON"
    ? `PON:${sp.targetPonPort}`
    : `SPL:${sp.targetSplitterIndex}:${sp.targetPort}`
}
function spliceTargetLabel(asset,sp){
  if(spliceTargetType(sp)==="PON")return `PON ${sp.targetPonPort}`;
  if(spliceTargetType(sp)==="FIBER"){
    const targetCable=get(sp.targetCableId);
    return `${targetCable?.code||"Cable"} · F${Number(sp.targetFiberIndex)+1}`
  }
  const spl=asset.internals?.splitters?.[sp.targetSplitterIndex];
  return `${spl?.code||"SPL"} · ${sp.targetPort==="IN"?"Entrada":"Salida "+sp.targetPort}`
}
function endpointKey(assetId,cableId,fiberIndex){return `E|${assetId}|${cableId}|${fiberIndex}`}
function ponKey(assetId,port){return `P|${assetId}|${port}`}
function splitterKey(assetId,index,port){return `S|${assetId}|${index}|${port}`}

function finishFiber(destId){let dest=get(destId),source=get(draft.sourceId),[lng,lat]=dest.geometry.coordinates;draft.path.push({lat,lng});const cableClass=(dest.type==="CLI"||source?.type==="CLI")?"DRP":($("newCableClass").value||"TRK");const initialCapacity=cableClass==="DRP"?1:12;pushUndo();db.features.push({id:crypto.randomUUID(),type:"TRK",cableClass,code:nextCableCode(cableClass),name:"",sector:"",status:"Operativo",pon:"",capacity:String(initialCapacity),reference:"",notes:"",sourceId:draft.sourceId,destId,geometry:{type:"LineString",coordinates:draft.path.map(p=>[p.lng,p.lat])},fibers:makeFibers(initialCapacity),history:[{at:now(),action:`Cable ${CABLE_CLASS_LABELS[cableClass]} creado`}]});draft=null;save();setTool("select");if(dest.type==="CLI")toast("Cliente conectado con drop de 1 fibra")}

function select(id){selectedId=id;render();let f=get(id),o=overlays.get(id);if(!o||!map)return;if(f.type==="TRK")map.fitBounds(o.getBounds(),{padding:[30,30]});else{map.panTo(o.getLatLng());map.setZoom(Math.max(17,map.getZoom()))}}
function renderList(){
  const q=$("search").value.trim().toLowerCase(),list=$("elementList"),filtered=db.features.filter(f=>!q||[f.code,f.name,f.sector,LABELS[f.type]].join(" ").toLowerCase().includes(q));
  const groups=[{key:"OLT",label:"OLT / Centrales"},{key:"MUF",label:"Mufas"},{key:"CTO",label:"CTO"},{key:"CAJ",label:"Cajas"},{key:"POS",label:"Postes"},{key:"CLI",label:"Clientes / ONT"},{key:"TRK",label:"Cables"}];
  list.innerHTML="";$("elementCount").textContent=String(filtered.length);
  groups.forEach(group=>{
    const items=filtered.filter(f=>f.type===group.key);if(!items.length)return;
    const details=document.createElement("details"),containsSelected=items.some(f=>f.id===selectedId);details.className="element-group";details.open=Boolean(q)||containsSelected||group.key==="OLT";
    const summary=document.createElement("summary");summary.innerHTML=`<span>${group.label}</span><b>${items.length}</b>`;details.appendChild(summary);
    const body=document.createElement("div");body.className="element-group-body";
    items.forEach(f=>{let d=document.createElement("div");d.className="item"+(selectedId===f.id?" selected":"");const subtype=f.type==="TRK"?CABLE_CLASS_LABELS[f.cableClass||"TRK"]:(LABELS[f.type]||f.type);d.innerHTML=`<b>${f.code}</b><span>${f.name||""}</span><small>${subtype} · ${f.sector||"Sin sector"}</small>`;d.onclick=()=>select(f.id);body.appendChild(d)});
    details.appendChild(body);list.appendChild(details)
  });
  if(!filtered.length)list.innerHTML='<p class="hint empty-list">No se encontraron elementos.</p>'
}
function distance(coords){let R=6371000,total=0;for(let i=1;i<coords.length;i++){let a=coords[i-1],b=coords[i],p1=a[1]*Math.PI/180,p2=b[1]*Math.PI/180,dp=(b[1]-a[1])*Math.PI/180,dl=(b[0]-a[0])*Math.PI/180,x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;total+=2*R*Math.asin(Math.sqrt(x))}return total}
function opticalTopologyEstimate(assetId){
  const cfg={fiberLossDbKm:.35,spliceLossDb:.10,connectorLossDb:.30,safetyMarginDb:1,...(C.optical||{})};
  const assets=db.features.filter(f=>f.geometry?.type==="Point"),cables=db.features.filter(f=>f.type==="TRK"&&f.status!=="Fuera de servicio"&&f.sourceId&&f.destId);
  const adj=new Map();
  cables.forEach(c=>{
    const cableLoss=distance(c.geometry.coordinates)/1000*cfg.fiberLossDbKm+2*cfg.spliceLossDb;
    const add=(a,b)=>{if(!adj.has(a))adj.set(a,[]);adj.get(a).push({to:b,cable:c,loss:cableLoss})};add(c.sourceId,c.destId);add(c.destId,c.sourceId)
  });
  let best=null;
  assets.filter(a=>a.type==="OLT"&&a.status==="Operativo").forEach(olt=>{
    const dist=new Map([[olt.id,0]]),paths=new Map([[olt.id,[]]]),queue=[olt.id];
    while(queue.length){queue.sort((a,b)=>dist.get(a)-dist.get(b));const id=queue.shift(),node=get(id);
      for(const edge of adj.get(id)||[]){
        const splitters=node?.type!=="OLT"?(node?.internals?.splitters||[]):[];
        const splitterLoss=splitters.length?Math.min(...splitters.map(s=>10*Math.log10(Number(s.ratio)||1)+1)):0;
        const candidate=dist.get(id)+edge.loss+splitterLoss;
        if(candidate<(dist.get(edge.to)??Infinity)){dist.set(edge.to,candidate);paths.set(edge.to,[...(paths.get(id)||[]),edge.cable.id]);if(!queue.includes(edge.to))queue.push(edge.to)}
      }
    }
    if(dist.has(assetId)){
      const target=get(assetId),connectorLoss=target?.type==="CLI"?2*cfg.connectorLossDb:cfg.connectorLossDb;
      const loss=dist.get(assetId)+connectorLoss+cfg.safetyMarginDb,rx=(Number(olt.oltPower)||0)-loss;
      if(!best||rx>best.rx)best={olt,loss,rx,path:paths.get(assetId)||[],distance:(paths.get(assetId)||[]).reduce((n,id)=>n+distance(get(id).geometry.coordinates),0)}
    }
  });
  if(!best)return null;
  best.level=best.rx>=-20?"good":best.rx>=-27?"warning":"critical";
  best.label=best.level==="good"?"Óptima":best.level==="warning"?"Revisar":"Crítica";
  return best
}
function opticalFiberEstimate(assetId){
  const cfg={fiberLossDbKm:.35,spliceLossDb:.10,connectorLossDb:.30,safetyMarginDb:1,...(C.optical||{})},adj=new Map(),meta=new Map();
  const node=(key,data={})=>{if(!adj.has(key))adj.set(key,[]);if(!meta.has(key))meta.set(key,data)};
  const edge=(a,b,loss,data={})=>{node(a);node(b);adj.get(a).push({to:b,loss,data});adj.get(b).push({to:a,loss,data})};
  db.features.filter(c=>c.type==="TRK"&&c.status!=="Fuera de servicio"&&c.sourceId&&c.destId).forEach(c=>{
    ensureCableFibers(c);const meters=distance(c.geometry.coordinates),loss=meters/1000*cfg.fiberLossDbKm;
    c.fibers.forEach((fiber,i)=>{const a=endpointKey(c.sourceId,c.id,i),b=endpointKey(c.destId,c.id,i);node(a,{kind:"endpoint",assetId:c.sourceId,cableId:c.id,fiberIndex:i});node(b,{kind:"endpoint",assetId:c.destId,cableId:c.id,fiberIndex:i});edge(a,b,loss,{kind:"cable",cableId:c.id,meters})})
  });
  db.features.filter(a=>a.geometry?.type==="Point").forEach(asset=>{
    (asset.internals?.pons||[]).forEach(p=>node(ponKey(asset.id,p.port),{kind:"pon",assetId:asset.id,port:p.port}));
    (asset.internals?.splitters||[]).forEach((s,si)=>{const input=splitterKey(asset.id,si,"IN");node(input,{kind:"splitter",assetId:asset.id,splitterIndex:si,port:"IN"});for(let p=1;p<=Number(s.ratio);p++){const out=splitterKey(asset.id,si,String(p));node(out,{kind:"splitter",assetId:asset.id,splitterIndex:si,port:String(p)});edge(input,out,10*Math.log10(Number(s.ratio)||1)+1,{kind:"splitter",ratio:Number(s.ratio)})}});
    (asset.internals?.splices||[]).forEach(sp=>{const a=endpointKey(asset.id,sp.cableId,sp.fiberIndex);let b,loss=cfg.spliceLossDb;if(spliceTargetType(sp)==="PON"){b=ponKey(asset.id,sp.targetPonPort);loss=cfg.connectorLossDb}else if(spliceTargetType(sp)==="FIBER")b=endpointKey(asset.id,sp.targetCableId,sp.targetFiberIndex);else b=splitterKey(asset.id,sp.targetSplitterIndex,String(sp.targetPort));if(adj.has(a)&&adj.has(b))edge(a,b,loss,{kind:"splice"})})
  });
  const targets=[...meta.entries()].filter(([,m])=>m.kind==="endpoint"&&m.assetId===assetId).map(([k])=>k);if(!targets.length)return null;
  let best=null;
  db.features.filter(a=>a.type==="OLT"&&a.status==="Operativo").forEach(olt=>(olt.internals?.pons||[]).forEach(p=>{
    const root=ponKey(olt.id,p.port);if(!adj.has(root))return;const dist=new Map([[root,0]]),previous=new Map(),queue=[root],done=new Set();
    while(queue.length){queue.sort((a,b)=>dist.get(a)-dist.get(b));const current=queue.shift();if(done.has(current))continue;done.add(current);for(const e of adj.get(current)||[]){const candidate=dist.get(current)+e.loss;if(candidate<(dist.get(e.to)??Infinity)){dist.set(e.to,candidate);previous.set(e.to,{from:current,edge:e});queue.push(e.to)}}}
    targets.forEach(target=>{if(!dist.has(target))return;const extra=(get(assetId)?.type==="CLI"?cfg.connectorLossDb:0)+cfg.safetyMarginDb,loss=dist.get(target)+extra,rx=(Number(olt.oltPower)||0)-loss;if(best&&rx<=best.rx)return;let cursor=target,meters=0,splices=0,splitters=0;while(previous.has(cursor)){const step=previous.get(cursor);meters+=step.edge.data.meters||0;if(step.edge.data.kind==="splice")splices++;if(step.edge.data.kind==="splitter")splitters++;cursor=step.from}best={olt,pon:p.port,loss,rx,distance:meters,splices,splitters,exact:true}}
    )
  }));
  if(!best)return null;best.level=best.rx>=-20?"good":best.rx>=-27?"warning":"critical";best.label=best.level==="good"?"Óptima":best.level==="warning"?"Revisar":"Crítica";return best
}
function opticalEstimate(assetId){if(opticalCache.has(assetId))return opticalCache.get(assetId);const exact=opticalFiberEstimate(assetId);if(exact){opticalCache.set(assetId,exact);return exact}const fallback=opticalTopologyEstimate(assetId);if(fallback)fallback.exact=false;opticalCache.set(assetId,fallback);return fallback}
function renderDetails(id){let f=get(id);if(f?.type==="TRK")ensureCableFibers(f);if(!f){$("featureForm").classList.add("hidden");$("emptyPanel").classList.remove("hidden");return}$("emptyPanel").classList.add("hidden");$("featureForm").classList.remove("hidden");$("badge").textContent=f.type;$("badge").style.background=COLORS[f.type]||"#555";$("featureTitle").textContent=f.code;$("featureSubtitle").textContent=f.type==="TRK"?`${CABLE_CLASS_LABELS[f.cableClass||"TRK"]} · Cable de fibra`:(LABELS[f.type]||f.type);$("featureId").value=f.id;["code","name","sector","pon","capacity","reference","notes"].forEach(k=>$(k).value=f[k]??"");$("cableClass").value=f.cableClass||"TRK";$("status").value=f.status;$("oltPower").value=f.oltPower??"";$("oltPowerLabel").style.display=f.type==="OLT"?"block":"none";$("cableClassLabel").style.display=f.type==="TRK"?"block":"none";$("capacityLabel").style.display=f.type==="TRK"?"block":"none";$("openCabinetBtn").style.display=["TRK","POS","CLI"].includes(f.type)?"none":"block";$("geometryInfo").textContent=f.geometry.type==="Point"?`Coordenadas: ${f.geometry.coordinates[1].toFixed(7)}, ${f.geometry.coordinates[0].toFixed(7)}`:`${Math.round(distance(f.geometry.coordinates))} m · ${get(f.sourceId)?.code||"--"} → ${get(f.destId)?.code||"--"} · Potencia: ${powered().fibers.has(f.id)?"Sí":"No"}`;
const optical=$("opticalEstimate"),estimate=f.geometry.type==="Point"&&f.type!=="OLT"?opticalEstimate(f.id):null;
optical.classList.toggle("hidden",f.geometry.type!=="Point"||f.type==="OLT");
if(f.geometry.type==="Point"&&f.type!=="OLT")optical.innerHTML=estimate
  ?`<div class="optical-head"><span>Potencia estimada</span><strong>${estimate.rx.toFixed(1)} dBm</strong></div><div class="optical-meter"><i class="${estimate.level}" style="width:${Math.max(5,Math.min(100,(estimate.rx+35)/20*100))}%"></i></div><small>${estimate.label} · pérdida ${estimate.loss.toFixed(1)} dB · ${Math.round(estimate.distance)} m · desde ${estimate.olt.code}${estimate.exact?` PON ${estimate.pon} · ruta por filamentos`:` · aproximación topológica`}</small>`
  :`<div class="optical-head"><span>Potencia estimada</span><strong>Sin ruta</strong></div><small>Conecta este elemento a una ruta que llegue hasta una OLT operativa.</small>`
const client=f.client||{};$("clientFields").classList.toggle("hidden",f.type!=="CLI");if(f.type==="CLI"){const mapping={clientRut:"rut",clientPhone:"phone",clientAddress:"address",clientPlan:"plan",clientOntSerial:"ontSerial",clientCtoPort:"ctoPort",clientInstallDate:"installDate",clientMeasuredPower:"measuredPower"};Object.entries(mapping).forEach(([id,key])=>$(id).value=client[key]??"");const measured=Number(String(client.measuredPower??"").replace(",","."));if(estimate&&Number.isFinite(measured)&&client.measuredPower!=="")optical.insertAdjacentHTML("beforeend",`<div class="measured-power"><span>Medida en terreno</span><b>${measured.toFixed(1)} dBm</b><small>Diferencia: ${(measured-estimate.rx).toFixed(1)} dB</small></div>`)}
renderIncidents(f)
}

function renderIncidents(f){const list=$("incidentList"),items=f.incidents||[];list.innerHTML=items.length?items.map(x=>`<div class="incident-row ${x.status==="Cerrada"?"closed":""}"><div><b>${x.type}</b> <span class="priority priority-${x.priority}">${x.priority}</span><small>${new Date(x.at).toLocaleDateString()} · ${x.description}</small></div><button type="button" data-close-incident="${x.id}">${x.status==="Cerrada"?"Reabrir":"Cerrar"}</button></div>`).join(""):"<small class='hint'>Sin incidencias registradas.</small>";document.querySelectorAll("[data-close-incident]").forEach(b=>b.onclick=()=>{const item=(f.incidents||[]).find(x=>x.id===b.dataset.closeIncident);if(!item)return;pushUndo();item.status=item.status==="Cerrada"?"Abierta":"Cerrada";item.closedAt=item.status==="Cerrada"?now():null;save();toast(`Incidencia ${item.status.toLowerCase()}`)})}

$("featureForm").onsubmit=e=>{
  e.preventDefault();
  let f=get($("featureId").value);
  if(!f)return;
  const requested=Number($("capacity").value||0);
  if(f.type==="TRK"&&requested){
    ensureCableFibers(f);
    const hasUsedOutside=f.fibers.slice(requested).some((_,offset)=>allFiberEndUses(f.id,requested+offset).length>0);
    if(hasUsedOutside){toast("No puedes reducir el cable: existen fusiones sobre el nuevo límite");return}
  }
  pushUndo();
  ["name","sector","pon","reference","notes"].forEach(k=>f[k]=$(k).value.trim());
  f.status=$("status").value;
  if(f.type==="CLI"){f.client=f.client||{};const mapping={clientRut:"rut",clientPhone:"phone",clientAddress:"address",clientPlan:"plan",clientOntSerial:"ontSerial",clientCtoPort:"ctoPort",clientInstallDate:"installDate",clientMeasuredPower:"measuredPower"};Object.entries(mapping).forEach(([id,key])=>f.client[key]=$(id).value.trim())}
  if(f.type==="OLT"){
    const parsedPower=Number(String($("oltPower").value).trim().replace(",","."));
    if(!Number.isFinite(parsedPower)){toast("Ingresa una potencia válida, por ejemplo 2,3");return}
    f.oltPower=parsedPower
  }
  if(f.type==="TRK"&&requested){
    const oldClass=f.cableClass||"TRK";
    const newClass=$("cableClass").value||"TRK";
    if(oldClass!==newClass){f.cableClass=newClass;f.code=nextCableCode(newClass)}
    const previous=f.fibers||[];
    f.capacity=String(requested);
    f.fibers=Array.from({length:requested},(_,i)=>previous[i]||makeFibers(requested)[i]);
    ensureCableFibers(f);
    db.features.filter(a=>a.geometry?.type==="Point").forEach(a=>{
      a.internals.splices=(a.internals.splices||[]).filter(sp=>sp.cableId!==f.id||sp.fiberIndex<requested)
    })
  }
  f.history.push({at:now(),action:"Ficha actualizada"});
  save();toast("Guardado")
};

function setTool(t){tool=t;document.querySelectorAll("[data-tool]").forEach(b=>b.classList.toggle("active",b.dataset.tool===t));$("addAssetBtn").classList.toggle("active",t==="asset");$("assetType").classList.toggle("hidden",t!=="asset");if(t!=="fiber"){draft=null;removeOverlay(overlays.get("_draft"))}$("newCableClass").closest("label").style.display=t==="fiber"?"block":"none";$("toolHelp").textContent=t==="select"?"＋ Clic derecho en el mapa para agregar elementos":t==="asset"?`Haz clic donde quieras ubicar: ${LABELS[$("assetType").value]}.`:"Elige origen, agrega vértices y elige destino.";$("mapStatus").textContent="Modo: "+t}
function showMapContextMenu(latLng,domEvent,cableId){
  lastContextMenuAt=performance.now();
  domEvent?.preventDefault?.();domEvent?.stopPropagation?.();
  contextPoint={lng:typeof latLng.lng==="function"?latLng.lng():latLng.lng,lat:typeof latLng.lat==="function"?latLng.lat():latLng.lat};contextCableId=cableId;
  const menu=$("mapContextMenu"),x=domEvent?.clientX??window.innerWidth/2,y=domEvent?.clientY??window.innerHeight/2;
  $("contextInsertMuf").classList.toggle("hidden",!cableId);
  $("contextInsertBox").classList.toggle("hidden",!cableId);
  menu.classList.remove("hidden");const width=menu.offsetWidth||220,height=menu.offsetHeight||250;menu.style.left=`${Math.max(8,Math.min(x,window.innerWidth-width-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,window.innerHeight-height-8))}px`
}
function hideMapContextMenu(){$("mapContextMenu").classList.add("hidden");contextPoint=null;contextCableId=null}
function splitLineAtPoint(coords,point){
  let best=null,cos=Math.cos(point.lat*Math.PI/180);
  for(let i=0;i<coords.length-1;i++){
    const a=coords[i],b=coords[i+1],px=point.lng*cos,py=point.lat,ax=a[0]*cos,ay=a[1],bx=b[0]*cos,by=b[1],dx=bx-ax,dy=by-ay;
    const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy||1))),q=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t],d=(px-q[0]*cos)**2+(py-q[1])**2;
    if(!best||d<best.d)best={i,t,q,d}
  }
  if(!best||best.t<.001||best.t>.999)return null;
  return{point:best.q,parts:[[...coords.slice(0,best.i+1),best.q],[best.q,...coords.slice(best.i+1)]]}
}
function insertCabinetAtPoint(cableId,point,type="MUF"){
  const cable=get(cableId);if(!cable||cable.type!=="TRK")return;
  const split=splitLineAtPoint(cable.geometry.coordinates,point);if(!split){toast("Elige un punto del cable alejado de sus extremos");return}
  pushUndo();ensureCableFibers(cable);const original=JSON.parse(JSON.stringify(cable)),oldDestId=original.destId;
  const label=type==="CAJ"?"Caja":"Mufa",asset={id:crypto.randomUUID(),type,code:nextAvailableCode(type),name:`Intervención ${original.code}`,sector:original.sector||"",status:"Operativo",pon:"",capacity:"",oltPower:"",reference:"Insertada sobre cable existente",notes:`${label} insertada sobre ${original.code}; continuidad automática de filamentos.`,geometry:{type:"Point",coordinates:split.point},internals:{pons:[],splitters:[],splices:[]},history:[{at:now(),action:`Insertada sobre ${original.code}`}]};
  db.features.push(asset);cable.destId=asset.id;cable.geometry.coordinates=split.parts[0];cable.history.push({at:now(),action:`Cable intervenido con ${asset.code}`});
  const right={...JSON.parse(JSON.stringify(original)),id:crypto.randomUUID(),code:nextCableCode(original.cableClass||"TRK"),sourceId:asset.id,destId:oldDestId,geometry:{type:"LineString",coordinates:split.parts[1]},fibers:JSON.parse(JSON.stringify(original.fibers)),history:[{at:now(),action:`Tramo creado al insertar ${asset.code}`}]};db.features.push(right);
  const oldDest=get(oldDestId);if(oldDest?.internals?.splices)oldDest.internals.splices.forEach(sp=>{if(sp.cableId===original.id)sp.cableId=right.id;if(sp.targetCableId===original.id)sp.targetCableId=right.id});
  original.fibers.forEach((fiber,fiberIndex)=>{const fusionId=crypto.randomUUID();asset.internals.splices.push(
    {id:crypto.randomUUID(),fusionId,assetId:asset.id,cableId:cable.id,fiberIndex,targetType:"FIBER",targetCableId:right.id,targetFiberIndex:fiberIndex},
    {id:crypto.randomUUID(),fusionId,assetId:asset.id,cableId:right.id,fiberIndex,targetType:"FIBER",targetCableId:cable.id,targetFiberIndex:fiberIndex}
  )});asset.history.push({at:now(),action:`${original.fibers.length} fibras fusionadas para mantener continuidad`});
  selectedId=asset.id;save();select(asset.id);toast(`${asset.code} insertada; ${original.fibers.length} fibras con continuidad`)
}
function splitLineEvenly(coords,count){
  const lengths=coords.slice(1).map((p,i)=>distance([coords[i],p])),total=lengths.reduce((a,b)=>a+b,0);
  const cuts=Array.from({length:count},(_,i)=>total*(i+1)/(count+1));
  const parts=[],points=[],current=[coords[0]],pending=[...cuts];let traveled=0;
  for(let i=0;i<lengths.length;i++){
    const a=coords[i],b=coords[i+1],length=lengths[i];
    while(pending.length&&pending[0]<=traveled+length){
      const ratio=length?(pending[0]-traveled)/length:0,point=[a[0]+(b[0]-a[0])*ratio,a[1]+(b[1]-a[1])*ratio];
      current.push(point);parts.push([...current]);points.push(point);current.length=0;current.push(point);pending.shift()
    }
    current.push(b);traveled+=length
  }
  parts.push(current);return{parts,points}
}
function insertMufsInSelectedCable(){
  const cable=get(selectedId);if(!cable||cable.type!=="TRK")return;
  const answer=prompt("¿Cuántas mufas deseas insertar en este cable? (1 a 10)","1");
  if(answer===null)return;const count=Number(answer);
  if(!Number.isInteger(count)||count<1||count>10){toast("Ingresa una cantidad entre 1 y 10");return}
  if(!confirm(`Se dividirá ${cable.code} en ${count+1} tramos y todas sus fibras quedarán fusionadas en ${count} mufa(s).`))return;
  pushUndo();ensureCableFibers(cable);
  const original=JSON.parse(JSON.stringify(cable)),oldDestId=original.destId,{parts,points}=splitLineEvenly(original.geometry.coordinates,count),mufs=[];
  points.forEach((coordinates,index)=>{
    const muf={id:crypto.randomUUID(),type:"MUF",code:nextAvailableCode("MUF"),name:`Intervención ${original.code} ${index+1}`,sector:original.sector||"",status:"Operativo",pon:"",capacity:"",oltPower:"",reference:"Insertada sobre cable existente",notes:`Mufa insertada sobre ${original.code}; continuidad automática de filamentos.`,geometry:{type:"Point",coordinates},internals:{pons:[],splitters:[],splices:[]},history:[{at:now(),action:`Insertada sobre ${original.code}`}]};
    db.features.push(muf);mufs.push(muf)
  });
  const segments=[];
  cable.destId=mufs[0].id;cable.geometry.coordinates=parts[0];cable.history.push({at:now(),action:`Cable dividido para insertar ${count} mufa(s)`});segments.push(cable);
  for(let i=1;i<parts.length;i++){
    const segment={...JSON.parse(JSON.stringify(original)),id:crypto.randomUUID(),code:nextCableCode(original.cableClass||"TRK"),sourceId:mufs[i-1].id,destId:i<count?mufs[i].id:oldDestId,geometry:{type:"LineString",coordinates:parts[i]},fibers:JSON.parse(JSON.stringify(original.fibers)),history:[{at:now(),action:`Tramo creado al intervenir ${original.code}`}]};
    db.features.push(segment);segments.push(segment)
  }
  const last=segments[segments.length-1];
  const oldDest=get(oldDestId);if(oldDest?.internals?.splices)oldDest.internals.splices.forEach(sp=>{if(sp.cableId===original.id)sp.cableId=last.id;if(sp.targetCableId===original.id)sp.targetCableId=last.id});
  mufs.forEach((muf,index)=>{
    const left=segments[index],right=segments[index+1];
    original.fibers.forEach((fiber,fiberIndex)=>{const fusionId=crypto.randomUUID();muf.internals.splices.push(
      {id:crypto.randomUUID(),fusionId,assetId:muf.id,cableId:left.id,fiberIndex,targetType:"FIBER",targetCableId:right.id,targetFiberIndex:fiberIndex},
      {id:crypto.randomUUID(),fusionId,assetId:muf.id,cableId:right.id,fiberIndex,targetType:"FIBER",targetCableId:left.id,targetFiberIndex:fiberIndex}
    )});
    muf.history.push({at:now(),action:`${original.fibers.length} fibras fusionadas para mantener continuidad`})
  });
  selectedId=mufs[0].id;save();select(mufs[0].id);toast(`${count} mufa(s) insertadas; ${original.fibers.length} fibras con continuidad`)
}
function deleteSelected(){let f=get(selectedId);if(!f)return;if(!confirm(`¿Eliminar ${f.code}? También se eliminarán sus tramos conectados.`))return;pushUndo();db.features=db.features.filter(x=>x.id!==f.id&&x.sourceId!==f.id&&x.destId!==f.id);selectedId=null;save();renderDetails(null)}

function openCabinet(){let f=get(selectedId);if(!f)return;f.internals=f.internals||{pons:[],splitters:[],splices:[]};f.internals.pons=f.internals.pons||[];f.internals.splitters=f.internals.splitters||[];f.internals.splices=f.internals.splices||[];$("cabinetTitle").textContent=`Gabinete: ${f.code}`;$("cabinetSubtitle").textContent=f.name||LABELS[f.type]||f.type;$("oltControls").classList.toggle("hidden",f.type!=="OLT");$("ponCount").value=f.internals.pons.length||16;const connected=db.features.filter(x=>x.type==="TRK"&&(x.sourceId===f.id||x.destId===f.id));selectedCableId=connected[0]?.id||null;selectedFiberIndex=null;renderCabinet(f);switchCabTab("overview");$("cabinetModal").classList.remove("hidden")}
function renderCabinet(f){let pons=f.internals.pons||[],splitters=f.internals.splitters||[],con=db.features.filter(x=>x.type==="TRK"&&(x.sourceId===f.id||x.destId===f.id));
const totalFibers=con.reduce((sum,c)=>sum+(c.fibers?.length||Number(c.capacity)||12),0);
const usedEnds=con.reduce((sum,c)=>sum+Array.from({length:c.fibers?.length||Number(c.capacity)||12},(_,i)=>fiberEndStatus(f,c,i).occupied).filter(Boolean).length,0);
$("cabinetStats").innerHTML=`<span><b>${con.length}</b> cables</span><span><b>${usedEnds}/${totalFibers}</b> fibras ocupadas</span><span><b>${splitters.length}</b> splitters</span>`;
let visual=`<div class="internal-box">${f.code}<br><small>${f.type}</small></div>`;
if(f.type==="OLT")visual+=`<div class="pon-grid">${pons.map(p=>{const connected=(f.internals.splices||[]).some(sp=>spliceTargetType(sp)==="PON"&&Number(sp.targetPonPort)===Number(p.port));return `<div class="pon-port ${p.active?"active":""} ${connected?"connected":""}" data-open-pon="${p.port}" title="Abrir mapa de red del PON ${p.port}">PON ${p.port}${connected?" ●":""}</div>`}).join("")}</div>`;
visual+=splitters.map(s=>`<div class="internal-box splitter-box">${s.code}<br><small>1:${s.ratio}</small></div>`).join("");
$("cabinetVisual").innerHTML=visual;
document.querySelectorAll("[data-open-pon]").forEach(el=>el.onclick=()=>{
  $("schemePonSelect").value=el.dataset.openPon;
  switchCabTab("scheme");
  renderPonNetworkTree(f,Number(el.dataset.openPon));
});
$("internalList").innerHTML=splitters.length?splitters.map((s,i)=>`<div class="internal-row"><span><b>${s.code}</b> · 1:${s.ratio}</span><button type="button" data-remove-splitter="${i}">Eliminar</button></div>`).join(""):"<p>No hay splitters internos.</p>";
document.querySelectorAll("[data-remove-splitter]").forEach(b=>b.onclick=()=>{
  pushUndo();
  const removed=+b.dataset.removeSplitter;
  f.internals.splitters.splice(removed,1);
  f.internals.splices=(f.internals.splices||[]).filter(sp=>spliceTargetType(sp)!=="SPL"||sp.targetSplitterIndex!==removed).map(sp=>{
    if(spliceTargetType(sp)==="SPL"&&sp.targetSplitterIndex>removed)sp.targetSplitterIndex--;
    return sp
  });
  f.history.push({at:now(),action:"Splitter interno eliminado"});save();renderCabinet(f)
});
$("connectionTable").innerHTML=con.map((x,i)=>{let other=get(x.sourceId===f.id?x.destId:x.sourceId),p=powered().fibers.has(x.id);return`<tr><td>${i+1}</td><td>${other?.code||"--"}</td><td>${x.code}</td><td>${x.capacity||x.fibers?.length||"--"}F</td><td class="${p?"ok":"bad"}">${p?"Activa":"Sin potencia"}</td></tr>`}).join("");
renderCableList(f,con);renderSplitterTargets(f);renderFiberFusionTargets(f,con);renderBulkControls(f,con);renderSplices(f)}

function renderCableList(f,con){$("cabCableList").innerHTML=con.length?con.map(x=>{let other=get(x.sourceId===f.id?x.destId:x.sourceId);return`<div class="cable-card ${selectedCableId===x.id?"selected":""}" data-cable="${x.id}"><b>${x.code}</b><span class="cable-class-badge cable-class-${x.cableClass||"TRK"}">${CABLE_CLASS_LABELS[x.cableClass||"TRK"]}</span><br><small>${x.fibers?.length||x.capacity||12}F · hacia ${other?.code||"--"}</small></div>`}).join(""):"<p>Sin cables conectados.</p>";
document.querySelectorAll("[data-cable]").forEach(el=>el.onclick=()=>{selectedCableId=el.dataset.cable;selectedFiberIndex=null;renderCableList(f,con);renderFiberGrid(f);renderFiberFusionTargets(f,con);renderBulkControls(f,con)})}

function renderFiberGrid(f){let cable=get(selectedCableId);if(!cable){$("fiberCableTitle").textContent="Selecciona un cable";$("fiberCableSubtitle").textContent="";$("fiberGrid").innerHTML="";return}
cable.fibers=cable.fibers||makeFibers(Number(cable.capacity)||12);$("fiberCableTitle").textContent=cable.code;
const usedCount=cable.fibers.filter((_,i)=>fiberEndStatus(f,cable,i).occupied).length;
const endpoint=f.id===cable.sourceId?"Extremo A":"Extremo B";
$("fiberCableSubtitle").textContent=`${endpoint} en ${f.code} · ${cable.fibers.length} filamentos · ${usedCount}/${cable.fibers.length} ocupados (${Math.round(usedCount/cable.fibers.length*100)}%)`;$("fiberCountSelect").value=String(cable.fibers.length);
const filter=$("fiberFilter").value;$("fiberGrid").innerHTML=cable.fibers.map((fb,i)=>{const end=fiberEndStatus(f,cable,i);const condition=fb.condition||((fb.state==="Cortada"||fb.state==="Reserva")?fb.state:"Normal");const css=end.occupied?"used":condition==="Cortada"?"cut":condition==="Reserva"?"reserve":"",kind=end.occupied?"used":condition==="Cortada"?"cut":condition==="Reserva"?"reserve":"free";if(filter!=="all"&&filter!==kind)return"";const status=end.occupied?`Ocupada → ${end.target}`:condition==="Normal"?"Libre":condition;return `<div class="fiber ${selectedFiberIndex===i?"selected":""} ${css}" data-fiber="${i}" title="${status}"><span class="fiber-color" style="background:${fb.color}"></span><b>F${i+1}</b><br><small>${status}</small></div>`}).join("");
document.querySelectorAll("[data-fiber]").forEach(el=>el.onclick=()=>{const idx=+el.dataset.fiber;const end=fiberEndStatus(f,cable,idx);if(end.occupied){toast(`F${idx+1} ya está ocupada en este extremo por ${end.target}`);return}selectedFiberIndex=idx;renderFiberGrid(f);const con=db.features.filter(x=>x.type==="TRK"&&(x.sourceId===f.id||x.destId===f.id));renderFiberFusionTargets(f,con)})}

function renderSplitterTargets(f){
  let targets=[];
  if(f.type==="OLT"){
    (f.internals.pons||[]).forEach(p=>targets.push({label:`PON ${p.port}`,type:"PON",ponPort:p.port}));
  }
  (f.internals.splitters||[]).forEach((s,si)=>{
    targets.push({label:`${s.code} · Entrada`,type:"SPL",splitterIndex:si,port:"IN"});
    for(let p=1;p<=s.ratio;p++)targets.push({label:`${s.code} · Salida ${p}`,type:"SPL",splitterIndex:si,port:String(p)});
  });
  $("splitterTargetList").innerHTML=targets.length?targets.map(t=>{
    const used=(f.internals.splices||[]).some(sp=>t.type==="PON"
      ? spliceTargetType(sp)==="PON"&&Number(sp.targetPonPort)===Number(t.ponPort)
      : spliceTargetType(sp)==="SPL"&&sp.targetSplitterIndex===t.splitterIndex&&String(sp.targetPort)===String(t.port));
    const attrs=t.type==="PON"
      ? `data-target-type="PON" data-pon-port="${t.ponPort}"`
      : `data-target-type="SPL" data-si="${t.splitterIndex}" data-port="${t.port}"`;
    return `<div class="target ${t.type==="PON"?"target-pon":""} ${used?"target-used":""}" ${attrs}>${t.label}${used?" · Ocupado":""}</div>`
  }).join(""):"<p>No hay destinos internos configurados.</p>";
  document.querySelectorAll(".target").forEach(el=>el.onclick=()=>{
    if(el.classList.contains("target-used")){toast("Ese destino interno ya está ocupado");return}
    connectFiberToTarget(f,{
      type:el.dataset.targetType,
      splitterIndex:el.dataset.si!==undefined?Number(el.dataset.si):null,
      port:el.dataset.port||null,
      ponPort:el.dataset.ponPort?Number(el.dataset.ponPort):null
    })
  })
}


function renderFiberFusionTargets(f,con){
  const list=$("fiberFusionTargetList");
  if(!list)return;
  if(!selectedCableId||selectedFiberIndex===null){
    list.innerHTML='<p class="hint">Selecciona una fibra libre para ver las fibras disponibles de los otros cables.</p>';
    return
  }
  const sourceCable=get(selectedCableId);
  const groups=con.filter(c=>c.id!==selectedCableId).map(cable=>{
    ensureCableFibers(cable);
    const free=cable.fibers.map((fiber,index)=>({fiber,index,end:fiberEndStatus(f,cable,index)})).filter(x=>!x.end.occupied);
    if(!free.length)return"";
    return `<div class="fiber-target-group">
      <div class="fiber-target-group-title">${cable.code} · ${CABLE_CLASS_LABELS[cable.cableClass||"TRK"]} · ${cable.fibers.length}F</div>
      <div class="fiber-target-list">${free.map(({fiber,index})=>{
        const info=fiberTechnicalInfo(cable,index);
        return `<div class="fiber-fusion-target" data-fusion-cable="${cable.id}" data-fusion-fiber="${index}" title="Fusionar con ${cable.code} F${index+1}">
          <span class="fiber-dot" style="background:${info.color}"></span>F${index+1} ${info.colorName}
        </div>`
      }).join("")}</div>
    </div>`
  }).join("");
  list.innerHTML=groups||'<p class="hint">No hay fibras libres en los otros cables.</p>';
  document.querySelectorAll("[data-fusion-cable]").forEach(el=>el.onclick=()=>{
    connectFiberToFiber(f,{
      targetCableId:el.dataset.fusionCable,
      targetFiberIndex:Number(el.dataset.fusionFiber)
    })
  })
}

function renderBulkControls(f,con){
  const source=get(selectedCableId),targets=con.filter(c=>c.id!==selectedCableId),panel=$("bulkSplicePanel");panel.classList.toggle("hidden",!source||!targets.length);if(!source||!targets.length)return;
  const previous=$("bulkTargetCable").value;$("bulkTargetCable").innerHTML=targets.map(c=>`<option value="${c.id}">${c.code} · ${c.fibers?.length||c.capacity||12}F</option>`).join("");if(targets.some(c=>c.id===previous))$("bulkTargetCable").value=previous;
  $("bulkCount").max=String(Math.min(source.fibers?.length||Number(source.capacity)||12,12))
}
function applyBulkSplice(){
  const f=get(selectedId),source=get(selectedCableId),target=get($("bulkTargetCable").value);if(!f||!source||!target){toast("Selecciona cables de origen y destino");return}ensureCableFibers(source);ensureCableFibers(target);
  const sourceStart=Number($("bulkSourceStart").value)-1,targetStart=Number($("bulkTargetStart").value)-1,count=Number($("bulkCount").value);
  if(!Number.isInteger(count)||count<1||sourceStart<0||targetStart<0||sourceStart+count>source.fibers.length||targetStart+count>target.fibers.length){toast("El rango supera la capacidad de uno de los cables");return}
  const conflicts=[];for(let i=0;i<count;i++){if(fiberEndStatus(f,source,sourceStart+i).occupied)conflicts.push(`${source.code} F${sourceStart+i+1}`);if(fiberEndStatus(f,target,targetStart+i).occupied)conflicts.push(`${target.code} F${targetStart+i+1}`)}if(conflicts.length){toast(`Rango ocupado: ${conflicts.slice(0,3).join(", ")}`);return}
  pushUndo();for(let i=0;i<count;i++){const fusionId=crypto.randomUUID(),aIndex=sourceStart+i,bIndex=targetStart+i;f.internals.splices.push({id:crypto.randomUUID(),fusionId,assetId:f.id,cableId:source.id,fiberIndex:aIndex,targetType:"FIBER",targetCableId:target.id,targetFiberIndex:bIndex},{id:crypto.randomUUID(),fusionId,assetId:f.id,cableId:target.id,fiberIndex:bIndex,targetType:"FIBER",targetCableId:source.id,targetFiberIndex:aIndex})}
  f.history.push({at:now(),action:`Empalme múltiple ${source.code} F${sourceStart+1}–F${sourceStart+count} ↔ ${target.code} F${targetStart+1}–F${targetStart+count}`});selectedFiberIndex=null;save();renderCabinet(f);switchCabTab("fibers");toast(`${count} fibras fusionadas correctamente`)
}

function connectFiberToFiber(f,target){
  if(!selectedCableId||selectedFiberIndex===null){toast("Selecciona primero una fibra de origen");return}
  const sourceCable=get(selectedCableId),targetCable=get(target.targetCableId);
  if(!sourceCable||!targetCable){toast("No se encontró uno de los cables");return}
  if(sourceCable.id===targetCable.id&&selectedFiberIndex===target.targetFiberIndex){toast("No puedes fusionar una fibra consigo misma");return}
  if(fiberEndStatus(f,sourceCable,selectedFiberIndex).occupied){toast("La fibra de origen ya está ocupada en este gabinete");return}
  if(fiberEndStatus(f,targetCable,target.targetFiberIndex).occupied){toast("La fibra de destino ya está ocupada en este gabinete");return}
  const fusionId=crypto.randomUUID();
  const a={id:crypto.randomUUID(),fusionId,assetId:f.id,cableId:sourceCable.id,fiberIndex:selectedFiberIndex,targetType:"FIBER",targetCableId:targetCable.id,targetFiberIndex:target.targetFiberIndex};
  const b={id:crypto.randomUUID(),fusionId,assetId:f.id,cableId:targetCable.id,fiberIndex:target.targetFiberIndex,targetType:"FIBER",targetCableId:sourceCable.id,targetFiberIndex:selectedFiberIndex};
  f.internals.splices.push(a,b);
  f.history.push({at:now(),action:`Fusión ${sourceCable.code} F${selectedFiberIndex+1} ↔ ${targetCable.code} F${target.targetFiberIndex+1}`});
  selectedFiberIndex=null;
  save();renderCabinet(f);switchCabTab("fibers");toast("Fusión entre fibras guardada")
}

function connectFiberToTarget(f,target){
  if(!selectedCableId||selectedFiberIndex===null){toast("Selecciona primero un cable y filamento");return}
  let cable=get(selectedCableId);cable.fibers=cable.fibers||makeFibers(Number(cable.capacity)||12);
  const end=fiberEndStatus(f,cable,selectedFiberIndex);
  if(end.occupied){toast(`F${selectedFiberIndex+1} ya está ocupada en ${f.code} por ${end.target}`);return}
  const targetUsed=(f.internals.splices||[]).find(sp=>spliceTargetType(sp)!=="FIBER"&&(target.type==="PON"
    ? spliceTargetType(sp)==="PON"&&Number(sp.targetPonPort)===Number(target.ponPort)
    : spliceTargetType(sp)==="SPL"&&sp.targetSplitterIndex===target.splitterIndex&&String(sp.targetPort)===String(target.port)));
  if(targetUsed){toast("Ese destino interno ya está ocupado");return}
  const splice={id:crypto.randomUUID(),assetId:f.id,cableId:selectedCableId,fiberIndex:selectedFiberIndex,targetType:target.type};
  if(target.type==="PON")splice.targetPonPort=target.ponPort;
  else{splice.targetSplitterIndex=target.splitterIndex;splice.targetPort=target.port}
  f.internals.splices.push(splice);
  f.history.push({at:now(),action:`${cable.code} F${selectedFiberIndex+1}, extremo en ${f.code}, conectado a ${spliceTargetLabel(f,splice)}`});
  selectedFiberIndex=null;save();renderCabinet(f);switchCabTab("fibers");toast("Conexión del extremo guardada")
}

function renderSplices(f){
  const all=f.internals.splices||[];
  const visible=all.filter((sp,index,arr)=>spliceTargetType(sp)!=="FIBER"||arr.findIndex(x=>x.fusionId===sp.fusionId)===index);
  $("spliceList").innerHTML=visible.length?visible.map((x,i)=>{
    const cable=get(x.cableId);
    if(spliceTargetType(x)==="FIBER"){
      const other=get(x.targetCableId);
      return `<div class="splice-row"><div><b>${cable?.code||"--"} · F${x.fiberIndex+1}</b><br><small>Extremo en ${f.code}</small></div><div>Fusionada con ${other?.code||"--"} · F${x.targetFiberIndex+1}</div><button type="button" data-remove-fusion="${x.fusionId}">Eliminar</button></div>`
    }
    return `<div class="splice-row"><div><b>${cable?.code||"--"} · F${x.fiberIndex+1}</b><br><small>Extremo en ${f.code}</small></div><div>${spliceTargetLabel(f,x)}</div><button type="button" data-remove-splice-id="${x.id}">Eliminar</button></div>`
  }).join(""):"<p>No hay empalmes registrados.</p>";
  document.querySelectorAll("[data-remove-fusion]").forEach(el=>el.onclick=()=>{pushUndo();f.internals.splices=f.internals.splices.filter(sp=>sp.fusionId!==el.dataset.removeFusion);save();renderCabinet(f);toast("Fusión eliminada")});
  document.querySelectorAll("[data-remove-splice-id]").forEach(el=>el.onclick=()=>{pushUndo();f.internals.splices=f.internals.splices.filter(sp=>sp.id!==el.dataset.removeSpliceId);save();renderCabinet(f);toast("Conexión eliminada")})
}


function renderLocalScheme(f){
  $("schemeTitle").textContent=`Vista técnica · ${f.code}`;
  $("schemeSubtitle").textContent="Tubos, colores de filamento y conexiones registradas.";
  const cables=db.features.filter(x=>x.type==="TRK"&&(x.sourceId===f.id||x.destId===f.id));
  if(!cables.length){
    $("schemeCanvas").innerHTML='<div class="scheme-empty">No hay cables conectados a este gabinete.</div>';
    return
  }

  const cableHtml=cables.map(cable=>{
    ensureCableFibers(cable);
    const other=get(cable.sourceId===f.id?cable.destId:cable.sourceId);
    const tubes=new Map();
    cable.fibers.forEach((fiber,index)=>{
      const info=fiberTechnicalInfo(cable,index);
      if(!tubes.has(info.tube))tubes.set(info.tube,{...info,items:[]});
      tubes.get(info.tube).items.push({fiber,index,info,end:fiberEndStatus(f,cable,index)})
    });

    return `<section class="technical-cable">
      <div class="technical-cable-header">
        <div><h4>${cable.code} · ${CABLE_CLASS_LABELS[cable.cableClass||"TRK"]} · ${cable.fibers.length}F</h4><small>Extremo en ${f.code} · hacia ${other?.code||"--"}</small></div>
        <small>${Math.round(distance(cable.geometry.coordinates))} m</small>
      </div>
      ${[...tubes.values()].map(tube=>`
        <div class="tube-section">
          <div class="tube-heading"><span class="tube-dot" style="background:${tube.tubeColor}"></span>Tubo ${tube.tube} · ${tube.tubeColorName}</div>
          <div class="technical-fiber-grid">
            ${tube.items.map(({fiber,index,info,end})=>`
              <div class="technical-fiber ${end.occupied?"connected":"free"}">
                <span class="fiber-dot" style="background:${info.color}"></span>
                <span class="technical-fiber-code">F${info.number}<br><small>${info.colorName}</small></span>
                <span class="technical-fiber-detail">${end.occupied?end.target:(fiber.condition==="Normal"?"Libre":fiber.condition)}</span>
                <div class="technical-line" style="background:${info.color}"></div>
              </div>`).join("")}
          </div>
        </div>`).join("")}
    </section>`
  }).join("");

  const splitterHtml=(f.internals.splitters||[]).map((splitter,splitterIndex)=>{
    const ports=[{port:"IN",label:"Entrada"},...Array.from({length:splitter.ratio},(_,i)=>({port:String(i+1),label:`Salida ${i+1}`}))];
    return `<section class="technical-splitter">
      <h4>${splitter.code} · 1:${splitter.ratio}</h4>
      <div class="technical-ports">
        ${ports.map(port=>{
          const splice=(f.internals.splices||[]).find(sp=>spliceTargetType(sp)==="SPL"&&sp.targetSplitterIndex===splitterIndex&&String(sp.targetPort)===String(port.port));
          const cable=splice?get(splice.cableId):null;
          const info=cable?fiberTechnicalInfo(cable,splice.fiberIndex):null;
          return `<div class="technical-port ${splice?"used":"free"}">
            <div class="technical-port-title"><span class="fiber-dot" style="background:${info?.color||"#667788"};margin-right:6px"></span>${port.label}</div>
            <div class="technical-port-detail">${splice&&cable?`${cable.code} · F${splice.fiberIndex+1} ${info.colorName} · Tubo ${info.tube}`:"Libre"}</div>
          </div>`
        }).join("")}
      </div>
    </section>`
  }).join("");

  $("schemeCanvas").innerHTML=`<div class="technical-scheme">
    <div class="technical-legend">
      <span><i class="fiber-dot" style="background:#20d34a"></i>Conectado</span>
      <span><i class="fiber-dot" style="background:#667788"></i>Libre</span>
    </div>
    ${cableHtml}
    ${splitterHtml||'<div class="scheme-empty">No hay splitters internos.</div>'}
  </div>`
}

function buildNetworkGraph(){
  const adj=new Map(),labels=new Map(),meta=new Map();
  const addNode=(k,label,m={})=>{labels.set(k,label);meta.set(k,m);if(!adj.has(k))adj.set(k,[])};
  const edge=(a,b)=>{if(!adj.has(a))adj.set(a,[]);if(!adj.has(b))adj.set(b,[]);adj.get(a).push(b);adj.get(b).push(a)};
  db.features.filter(f=>f.type==="TRK").forEach(c=>{
    const count=c.fibers?.length||Number(c.capacity)||12;
    for(let i=0;i<count;i++){
      const a=endpointKey(c.sourceId,c.id,i),b=endpointKey(c.destId,c.id,i);
      const fi=fiberTechnicalInfo(c,i);
      addNode(a,`${get(c.sourceId)?.code||"--"} · ${c.code} · T${fi.tube} ${fi.tubeColorName} · F${i+1} ${fi.colorName}`,{kind:"endpoint",assetId:c.sourceId,cableId:c.id,fiberIndex:i});
      addNode(b,`${get(c.destId)?.code||"--"} · ${c.code} · T${fi.tube} ${fi.tubeColorName} · F${i+1} ${fi.colorName}`,{kind:"endpoint",assetId:c.destId,cableId:c.id,fiberIndex:i});
      edge(a,b);
    }
  });
  db.features.filter(f=>f.geometry?.type==="Point").forEach(asset=>{
    (asset.internals?.pons||[]).forEach(p=>addNode(ponKey(asset.id,p.port),`${asset.code} · PON ${p.port}`,{kind:"pon",assetId:asset.id,port:p.port}));
    (asset.internals?.splitters||[]).forEach((s,si)=>{
      const input=splitterKey(asset.id,si,"IN");
      addNode(input,`${asset.code} · ${s.code} Entrada`,{kind:"splitter",assetId:asset.id,splitterIndex:si,port:"IN"});
      for(let p=1;p<=s.ratio;p++){
        const out=splitterKey(asset.id,si,String(p));
        addNode(out,`${asset.code} · ${s.code} Salida ${p}`,{kind:"splitter",assetId:asset.id,splitterIndex:si,port:String(p)});
        edge(input,out);
      }
    });
    (asset.internals?.splices||[]).forEach(sp=>{
      const e=endpointKey(asset.id,sp.cableId,sp.fiberIndex);
      let t;
      if(spliceTargetType(sp)==="PON")t=ponKey(asset.id,sp.targetPonPort);
      else if(spliceTargetType(sp)==="FIBER")t=endpointKey(asset.id,sp.targetCableId,sp.targetFiberIndex);
      else t=splitterKey(asset.id,sp.targetSplitterIndex,String(sp.targetPort));
      if(adj.has(e)&&adj.has(t))edge(e,t);
    });
  });
  return{adj,labels,meta}
}

function tracePonTree(asset,port){
  const graph=buildNetworkGraph(),root=ponKey(asset.id,port);
  if(!graph.adj.has(root))return{label:`${asset.code} · PON ${port}`,children:[]};
  const visited=new Set();
  function walk(node,parent,depth){
    if(depth>80)return null;
    visited.add(node);
    const children=[];
    for(const next of graph.adj.get(node)||[]){
      if(next===parent||visited.has(next))continue;
      const child=walk(next,node,depth+1);
      if(child)children.push(child)
    }
    return{key:node,label:graph.labels.get(node)||node,meta:graph.meta.get(node)||{},children}
  }
  return walk(root,null,0)
}

function treeHtml(node,isRoot=false){
  if(!node)return"";
  const m=node.meta||{};
  let cls=isRoot?"root ":"";
  if(m.kind==="splitter")cls+="splitter ";
  if(m.kind==="endpoint"){
    const a=get(m.assetId);cls+=`asset-${a?.type||""} cable `;
  }
  const attrs=m.assetId?`data-tree-asset="${m.assetId}"`:``;
  return `<li><div class="tree-node ${cls}" ${attrs}><span>${node.label}</span></div>${node.children?.length?`<ul>${node.children.map(c=>treeHtml(c)).join("")}</ul>`:""}</li>`
}

function renderPonNetworkTree(f,port){
  $("schemeTitle").textContent=`Mapa de red · ${f.code} PON ${port}`;
  $("schemeSubtitle").textContent="Trazado lógico según filamentos, empalmes y splitters registrados.";
  const tree=tracePonTree(f,port);
  $("schemeCanvas").innerHTML=tree.children?.length
    ? `<ul class="network-tree">${treeHtml(tree,true)}</ul>`
    : `<div class="scheme-empty">Este PON todavía no tiene un filamento conectado.</div>`;
  document.querySelectorAll("[data-tree-asset]").forEach(el=>el.onclick=()=>{
    const id=el.dataset.treeAsset;
    if(!get(id))return;
    $("cabinetModal").classList.add("hidden");
    select(id);
  })
}

function prepareSchemeControls(f){
  const isOlt=f.type==="OLT";
  $("schemePonLabel").classList.toggle("hidden",!isOlt);
  $("showPonTreeBtn").classList.toggle("hidden",!isOlt);
  if(isOlt){
    $("schemePonSelect").innerHTML=(f.internals.pons||[]).map(p=>`<option value="${p.port}">PON ${p.port}</option>`).join("");
  }
}
function switchCabTab(tab){
  document.querySelectorAll(".cab-tab").forEach(b=>b.classList.toggle("active",b.dataset.cabtab===tab));
  document.querySelectorAll(".cab-pane").forEach(p=>p.classList.toggle("hidden",p.dataset.cabpane!==tab));
  const f=get(selectedId);
  if(tab==="fibers"){let con=db.features.filter(x=>x.type==="TRK"&&(x.sourceId===f.id||x.destId===f.id));renderCableList(f,con);renderFiberGrid(f);renderSplitterTargets(f);renderFiberFusionTargets(f,con);renderBulkControls(f,con)}
  if(tab==="splices")renderSplices(f);
  if(tab==="scheme"){prepareSchemeControls(f);renderLocalScheme(f)}
}
document.querySelectorAll(".cab-tab").forEach(b=>b.onclick=()=>switchCabTab(b.dataset.cabtab));
$("showLocalSchemeBtn").onclick=()=>renderLocalScheme(get(selectedId));
$("showPonTreeBtn").onclick=()=>renderPonNetworkTree(get(selectedId),Number($("schemePonSelect").value));
$("schemePonSelect").onchange=()=>renderPonNetworkTree(get(selectedId),Number($("schemePonSelect").value));


$("openCabinetBtn").onclick=openCabinet;$("closeCabinetBtn").onclick=()=>$("cabinetModal").classList.add("hidden");
$("oltPower").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();$("featureForm").requestSubmit()}};
$("addIncidentBtn").onclick=()=>{const f=get($("featureId").value),description=$("incidentDescription").value.trim();if(!f||!description){toast("Describe la incidencia o mantenimiento");return}pushUndo();f.incidents=f.incidents||[];f.incidents.unshift({id:crypto.randomUUID(),at:now(),type:$("incidentType").value,priority:$("incidentPriority").value,description,status:"Abierta"});f.history=f.history||[];f.history.push({at:now(),action:`Incidencia: ${$("incidentType").value}`});$("incidentDescription").value="";save();toast("Incidencia registrada")};
document.querySelectorAll("[data-context-asset]").forEach(button=>button.onclick=()=>{if(!contextPoint)return;const point={...contextPoint},type=button.dataset.contextAsset;hideMapContextMenu();createAssetAt(type,point.lng,point.lat)});
$("addAssetBtn").onclick=()=>setTool(tool==="asset"?"select":"asset");
$("assetType").onchange=()=>setTool("asset");
$("contextInsertMuf").onclick=()=>{if(!contextPoint||!contextCableId)return;const point={...contextPoint},cableId=contextCableId;hideMapContextMenu();insertCabinetAtPoint(cableId,point,"MUF")};
$("contextInsertBox").onclick=()=>{if(!contextPoint||!contextCableId)return;const point={...contextPoint},cableId=contextCableId;hideMapContextMenu();insertCabinetAtPoint(cableId,point,"CAJ")};
$("mapContextMenu").addEventListener("pointerdown",event=>event.stopPropagation());
$("mapContextMenu").addEventListener("contextmenu",event=>{event.preventDefault();event.stopPropagation()});
document.addEventListener("click",e=>{if(!$("mapContextMenu").contains(e.target))hideMapContextMenu()});
document.addEventListener("keydown",e=>{
  const modalOpen=!$("cabinetModal").classList.contains("hidden");
  if(e.key==="Escape"&&modalOpen){$("cabinetModal").classList.add("hidden");return}
  if(modalOpen&&["1","2","3","4"].includes(e.key)&&!e.ctrlKey&&!e.metaKey){
    const tag=document.activeElement?.tagName;
    if(["INPUT","SELECT","TEXTAREA"].includes(tag))return;
    switchCabTab(["overview","fibers","splices","scheme"][Number(e.key)-1])
  }
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"&&!modalOpen){e.preventDefault();$("featureForm").requestSubmit()}
});
$("addSplitterBtn").onclick=()=>{let f=get(selectedId);if(!f)return;pushUndo();f.internals=f.internals||{pons:[],splitters:[],splices:[]};let ratio=+$("splitterRatio").value,code=`SPL-${String(f.internals.splitters.length+1).padStart(3,"0")}`;f.internals.splitters.push({code,ratio});f.history.push({at:now(),action:`Splitter interno ${code} 1:${ratio} agregado`});save();renderCabinet(f);toast("Splitter agregado dentro del gabinete")};
$("applyPonCountBtn").onclick=()=>{let f=get(selectedId),n=Math.max(1,Math.min(128,+$("ponCount").value||16));pushUndo();f.internals.pons=Array.from({length:n},(_,i)=>f.internals.pons[i]||{port:i+1,active:false});f.history.push({at:now(),action:`Cantidad de PON ajustada a ${n}`});save();renderCabinet(f)};
$("applyFiberCountBtn").onclick=()=>{let f=get(selectedId),c=get(selectedCableId);if(!c){toast("Selecciona un cable");return}let n=+$("fiberCountSelect").value;const occupiedOutside=db.features.some(a=>(a.internals?.splices||[]).some(sp=>sp.cableId===c.id&&sp.fiberIndex>=n));if(occupiedOutside){toast("No puedes reducir: hay extremos fusionados sobre el nuevo límite");return}pushUndo();let previous=c.fibers||[];c.fibers=Array.from({length:n},(_,i)=>previous[i]||{index:i+1,condition:"Normal",color:FIBER_COLORS[i%12]});c.capacity=String(n);save();renderCabinet(f);switchCabTab("fibers");renderFiberGrid(f);toast(`Cable ajustado a ${n}F`)};
$("fiberFilter").onchange=()=>{const f=get(selectedId);if(f)renderFiberGrid(f)};$("applyBulkSpliceBtn").onclick=applyBulkSplice;

document.querySelectorAll("[data-tool]").forEach(b=>b.onclick=()=>setTool(b.dataset.tool));$("cancelTool").onclick=()=>setTool("select");$("deleteBtn").onclick=$("deleteFeatureBtn").onclick=deleteSelected;$("undoBtn").onclick=()=>{if(!undoStack.length)return;redoStack.push(snapshot());db=JSON.parse(undoStack.pop());save()};$("redoBtn").onclick=()=>{if(!redoStack.length)return;undoStack.push(snapshot());db=JSON.parse(redoStack.pop());save()};$("search").oninput=renderList;$("layerFiber").onchange=renderMap;document.querySelectorAll(".layerAsset").forEach(x=>x.onchange=renderMap);
$("toggleAllLayers").onclick=()=>{const boxes=[$("layerFiber"),...document.querySelectorAll(".layerAsset")],next=!boxes.every(x=>x.checked);boxes.forEach(x=>x.checked=next);renderMap();$("toggleAllLayers").textContent=next?"Ocultar":"Mostrar"};
$("assetType").onchange=()=>{if($("assetType").value==="CLI")$("newCableClass").value="DRP"};

$("exportBtn").onclick=()=>{let out={type:"FeatureCollection",metadata:{version:"1.9",exportedAt:now(),counters:db.counters,optical:C.optical},features:db.features.map(f=>({type:"Feature",id:f.id,geometry:f.geometry,properties:Object.fromEntries(Object.entries(f).filter(([k])=>!["id","geometry"].includes(k)))}))};let a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:"application/json"}));a.download=`BP-GIS-v1.9-${now().slice(0,10)}.geojson`;a.click()};
$("importFile").onchange=async e=>{let file=e.target.files[0];if(!file)return;let p=JSON.parse(await file.text());pushUndo();db.features=p.features.map(x=>({id:x.id||crypto.randomUUID(),...x.properties,geometry:x.geometry}));db.counters=p.metadata?.counters||db.counters;save()};
})();
