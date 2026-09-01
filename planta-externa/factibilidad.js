(()=>{
const C=window.BP_GIS_CONFIG,RADIUS_KM=1;
const map=L.map("feasibilityMap",{center:[C.mapCenter.lat,C.mapCenter.lng],zoom:C.mapZoom,maxZoom:20,zoomControl:false});
L.control.zoom({position:"bottomright"}).addTo(map);
const satellite=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxNativeZoom:18,maxZoom:20,attribution:"Tiles &copy; Esri"}),streets=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxNativeZoom:19,maxZoom:20,attribution:'&copy; OpenStreetMap'});
satellite.addTo(map);L.control.layers({"Satelital":satellite,"Mapa":streets},null,{position:"topright"}).addTo(map);

function loadNetwork(){
  try{return JSON.parse(localStorage.getItem(C.storageKey)||"null")||{features:[]}}
  catch{return{features:[]}}
}
const db=loadNetwork(),cables=(db.features||[]).filter(feature=>feature.type==="TRK"&&feature.geometry?.type==="LineString"&&feature.geometry.coordinates?.length>1);
if(!cables.length){document.getElementById("noNetwork").classList.remove("hidden");return}

const lines=cables.map(cable=>turf.lineString(cable.geometry.coordinates,{sector:cable.sector||""})),collection=turf.featureCollection(lines);
let buffered=turf.buffer(collection,RADIUS_KM,{units:"kilometers"}),coverage=buffered;
try{if(buffered.features.length>1)coverage=turf.union(turf.featureCollection(buffered.features))||buffered}catch{}

const coverageLayer=L.geoJSON(coverage,{style:{color:"#df4937",weight:2,opacity:.9,fillColor:"#d94736",fillOpacity:.38,interactive:false}}).addTo(map);
L.geoJSON(collection,{style:{color:"#ffe07b",weight:3,opacity:.9,interactive:false}}).addTo(map);
const bounds=coverageLayer.getBounds();if(bounds.isValid())map.fitBounds(bounds,{padding:[30,30],maxZoom:14});

const totalKm=lines.reduce((sum,line)=>sum+turf.length(line,{units:"kilometers"}),0),areaKm2=turf.area(coverage)/1e6;
document.getElementById("networkLength").textContent=`${totalKm.toFixed(1)} km`;
document.getElementById("coverageArea").textContent=`${areaKm2.toFixed(1)} km²`;

const usedLabels=new Set();cables.forEach((cable,index)=>{
  const name=(cable.sector||"").trim();if(!name||usedLabels.has(name))return;usedLabels.add(name);
  const line=lines[index],middle=turf.along(line,turf.length(line,{units:"kilometers"})/2,{units:"kilometers"}).geometry.coordinates;
  L.marker([middle[1],middle[0]],{interactive:false,icon:L.divIcon({className:"",html:`<span class="zone-label">${escapeHtml(name)}</span>`,iconSize:null})}).addTo(map)
});

let queryMarker=null;
map.on("click",event=>{
  const point=turf.point([event.latlng.lng,event.latlng.lat]),distanceKm=Math.min(...lines.map(line=>turf.pointToLineDistance(point,line,{units:"kilometers"}))),available=distanceKm<=RADIUS_KM,status=document.getElementById("commercialStatus");
  status.className=`status ${available?"available":"unavailable"}`;
  status.innerHTML=available?`<b>Factibilidad preliminar disponible</b><span>A ${Math.round(distanceKm*1000)} m de la red. Solicitar validación en terreno.</span>`:`<b>Fuera de cobertura preliminar</b><span>A ${Math.round(distanceKm*1000)} m de la red; supera el radio comercial de 1.000 m.</span>`;
  if(queryMarker)queryMarker.remove();queryMarker=L.marker(event.latlng,{icon:L.divIcon({className:"",html:`<div class="query-marker ${available?"available":"unavailable"}"></div>`,iconSize:[18,18],iconAnchor:[9,9]})}).addTo(map)
});

function escapeHtml(value){return value.replace(/[&<>'"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char])}
})();
