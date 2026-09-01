(()=>{
const C=window.BP_GIS_CONFIG,RADIUS_KM=.5;
const map=L.map("feasibilityMap",{center:[C.mapCenter.lat,C.mapCenter.lng],zoom:C.mapZoom,maxZoom:20,zoomControl:false});
L.control.zoom({position:"bottomright"}).addTo(map);
const satellite=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxNativeZoom:18,maxZoom:20,attribution:"Tiles &copy; Esri"}),streets=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxNativeZoom:19,maxZoom:20,attribution:'&copy; OpenStreetMap'});
satellite.addTo(map);L.control.layers({"Satelital":satellite,"Mapa":streets},null,{position:"topright"}).addTo(map);

function loadNetwork(){
  try{return JSON.parse(localStorage.getItem(C.storageKey)||"null")||{features:[]}}
  catch{return{features:[]}}
}
const db=loadNetwork(),boxes=(db.features||[]).filter(feature=>feature.type==="CAJ"&&feature.status!=="Fuera de servicio"&&feature.geometry?.type==="Point"&&feature.geometry.coordinates?.length===2);
if(!boxes.length){document.getElementById("noNetwork").classList.remove("hidden");return}

const points=boxes.map(box=>turf.point(box.geometry.coordinates,{sector:box.sector||""})),collection=turf.featureCollection(points);
let buffered=turf.buffer(collection,RADIUS_KM,{units:"kilometers"}),coverage=buffered;
try{if(buffered.features.length>1)coverage=turf.union(turf.featureCollection(buffered.features))||buffered}catch{}

const coverageLayer=L.geoJSON(coverage,{style:{color:"#df4937",weight:2,opacity:.9,fillColor:"#d94736",fillOpacity:.38,interactive:false}}).addTo(map);
const bounds=coverageLayer.getBounds();if(bounds.isValid())map.fitBounds(bounds,{padding:[30,30],maxZoom:14});

const areaKm2=turf.area(coverage)/1e6;
document.getElementById("boxCount").textContent=String(boxes.length);
document.getElementById("coverageArea").textContent=`${areaKm2.toFixed(1)} km²`;

const usedLabels=new Set();boxes.forEach(box=>{
  const name=(box.sector||"").trim();if(!name||usedLabels.has(name))return;usedLabels.add(name);
  const [lng,lat]=box.geometry.coordinates;
  L.marker([lat,lng],{interactive:false,icon:L.divIcon({className:"",html:`<span class="zone-label">${escapeHtml(name)}</span>`,iconSize:null})}).addTo(map)
});

let queryMarker=null;
map.on("click",event=>{
  const point=turf.point([event.latlng.lng,event.latlng.lat]),distanceKm=Math.min(...points.map(box=>turf.distance(point,box,{units:"kilometers"}))),available=distanceKm<=RADIUS_KM,status=document.getElementById("commercialStatus");
  status.className=`status ${available?"available":"unavailable"}`;
  status.innerHTML=available?`<b>Factibilidad preliminar disponible</b><span>A ${Math.round(distanceKm*1000)} m de la caja más cercana. Solicitar validación en terreno.</span>`:`<b>Fuera de cobertura preliminar</b><span>A ${Math.round(distanceKm*1000)} m de la caja más cercana; supera el radio comercial de 500 m.</span>`;
  if(queryMarker)queryMarker.remove();queryMarker=L.marker(event.latlng,{icon:L.divIcon({className:"",html:`<div class="query-marker ${available?"available":"unavailable"}"></div>`,iconSize:[18,18],iconAnchor:[9,9]})}).addTo(map)
});

function escapeHtml(value){return value.replace(/[&<>'"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char])}
})();
