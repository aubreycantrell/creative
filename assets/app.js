/* Serverless collage analyzer — runs fully in-browser (GitHub Pages / Cloudflare Pages friendly) */

// If you don't have a diffusion worker yet, keep this null.
const DIFFUSION_URL = null; // 'https://<YOUR-WORKER>.workers.dev'
// top of file
const API_BASE = 'https://collage-proxy.ac138.workers.dev';


const fileInput = document.getElementById("fileInput");
const analyzeBtn = document.getElementById("analyzeBtn");
const directBtn = document.getElementById("directBtn");
const downloadPngBtn = document.getElementById("downloadPngBtn");
const featuresEl = document.getElementById("features");
const recsEl = document.getElementById("recs");
const acceptBtn = document.getElementById("acceptBtn");
const skipBtn = document.getElementById("skipBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const statusEl = document.getElementById("status");
const historyGrid = document.getElementById("historyGrid");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

let srcImage = null;
let lastAnalysis = null;
let lastRecommendations = null;
let lastReasons = null;
let logRows = [["timestamp","user_decision","prompts","internal_explanations"]];
const HISTORY_KEY = "collage_history_dataurls";

/* ---------- helpers ---------- */
async function createBitmapFromBlob(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob); } catch (_) {}
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

function whiteToTransparent(bitmap, thr = 242) {
  const c = document.createElement("canvas");
  c.width = bitmap.width; c.height = bitmap.height;
  const p = c.getContext("2d");
  p.drawImage(bitmap, 0, 0);
  const d = p.getImageData(0,0,c.width,c.height);
  const a = d.data;
  for (let i=0;i<a.length;i+=4){
    const r=a[i], g=a[i+1], b=a[i+2];
    if (r>=thr && g>=thr && b>=thr) a[i+3]=0;
  }
  p.putImageData(d,0,0);
  return c;
}

function promptFromRecs(features, recs) {
  const base = (recs||[]).join(" ; ");
  const temp = features?.temperature || "neutral";
  return `${base}. collage paper cut-out, torn edges, matte texture, photographed on plain white background, hard crisp silhouette, ${temp} palette accent, no drop shadow, high contrast`;
}

async function fetchDiffusionPNG(prompt, w=512, h=384) {
  if (!DIFFUSION_URL) throw new Error("No diffusion URL configured");
  const r = await fetch(DIFFUSION_URL, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ prompt, width: w, height: h, steps: 6, guidance: 1.0 })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.blob();
}

/* ---------- core UI flow ---------- */

function loadImageToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxW = 1200;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      srcImage = img;
      downloadPngBtn.disabled = false;
      resolve();
    };
    img.onerror = reject;
    img.src = url;
  });
}

fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  await loadImageToCanvas(f);
  clearOutputs();
});

function clearOutputs() {
  featuresEl.innerHTML = "";
  recsEl.innerHTML = "";
  statusEl.textContent = "";
  lastAnalysis = null;
  lastRecommendations = null;
  lastReasons = null;
}

/* ---------- analysis (features) ---------- */
function getImageData() { return ctx.getImageData(0, 0, canvas.width, canvas.height); }
function toGray(imgData) {
  const { data, width, height } = imgData;
  const g = new Uint8ClampedArray(width*height);
  for (let i=0, j=0; i<data.length; i+=4, j++) {
    const r = data[i], gg = data[i+1], b = data[i+2];
    g[j] = Math.round(0.299*r + 0.587*gg + 0.114*b);
  }
  return { data: g, width, height };
}
function dominantColorMean(imgData){const{data}=imgData;let r=0,g=0,b=0,n=0;for(let i=0;i<data.length;i+=4){r+=data[i];g+=data[i+1];b+=data[i+2];n++;}return [Math.round(r/n),Math.round(g/n),Math.round(b/n)];}
function colorfulnessHasler(imgData){const{data}=imgData;const rg=[],yb=[];for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],b=data[i+2];rg.push(Math.abs(r-g));yb.push(Math.abs(0.5*(r+g)-b));}const mean=a=>a.reduce((x,c)=>x+c,0)/a.length;const mrg=mean(rg),myb=mean(yb);const srg=Math.sqrt(mean(rg.map(v=>(v-mrg)*(v-mrg))));const syb=Math.sqrt(mean(yb.map(v=>(v-myb)*(v-myb))));return Math.sqrt(srg*srg+syb*syb)+0.3*Math.sqrt(mrg*mrg+myb*myb);}
function contrastStd(gray){const{data}=gray;const mu=data.reduce((a,c)=>a+c,0)/data.length;const v=data.reduce((a,c)=>a+(c-mu)*(c-mu),0)/data.length;return Math.sqrt(v)/255;}
function sobelGrad(gray){const{data,width,height}=gray;const gxK=[-1,0,1,-2,0,2,-1,0,1],gyK=[-1,-2,-1,0,0,0,1,2,1];const out=new Float32Array(width*height);for(let y=1;y<height-1;y++){for(let x=1;x<width-1;x++){let gx=0,gy=0,i=0;for(let ky=-1;ky<=1;ky++){for(let kx=-1;kx<=1;kx++){const p=(y+ky)*width+(x+kx);const v=data[p];gx+=gxK[i]*v;gy+=gyK[i]*v;i++;}}out[y*width+x]=Math.hypot(gx,gy);}}let max=0;for(let i=0;i<out.length;i++) if(out[i]>max) max=out[i];const inv=max>0?1/max:0;const norm=new Float32Array(out.length);for(let i=0;i<out.length;i++) norm[i]=out[i]*inv;return {data:norm,width,height};}
function edgeDensity(gray){const g=sobelGrad(gray);let c=0;const th=0.25;for(let i=0;i<g.data.length;i++) if(g.data[i]>th)c++;return c/g.data.length;}
function entropy(gray){const hist=new Uint32Array(256);for(let i=0;i<gray.data.length;i++) hist[gray.data[i]]++;const total=gray.data.length;let H=0;for(let v=0;v<256;v++){if(!hist[v])continue;const p=hist[v]/total;H-=p*Math.log2(p);}return H;}
function rgb2hsv(r,g,b){const rn=r/255,gn=g/255,bn=b/255;const cmax=Math.max(rn,gn,bn),cmin=Math.min(rn,gn,bn);const d=cmax-cmin;let h=0;if(d!==0){if(cmax===rn)h=60*(((gn-bn)/d)%6);else if(cmax===gn)h=60*(((bn-rn)/d)+2);else h=60*(((rn-gn)/d)+4);}if(h<0)h+=360;const s=cmax===0?0:d/cmax;return [h,s,cmax];}
function mainHueAndTemp(img){const{data}=img;let sumH=0,sumS=0,n=0;for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],b=data[i+2];const[h,s]=rgb2hsv(r,g,b);if(s>0.1){sumH+=h;sumS+=s;n++;}}const hue=n?sumH/n:0;const satMean=n?sumS/n:0;const warm=(hue<30)||(hue>330)||(hue>=30&&hue<=60);return {hue,temperature:warm?"warm":"cool",meanS:satMean};}
function gridOccupancy(img, gray, grad, rows=3, cols=3){const w=img.width,h=img.height;const masses=[];const cellW=Math.floor(w/cols),cellH=Math.floor(h/rows);for(let r=0;r<rows;r++){const row=[];for(let c=0;c<cols;c++){const x0=c*cellW,y0=r*cellH;const x1=(c===cols-1)?w:x0+cellW;const y1=(r===rows-1)?h:y0+cellH;let sum=0,count=0;for(let y=y0;y<y1;y++){for(let x=x0;x<x1;x++){const p=y*w+x;const invWhite=1-gray.data[p]/255;const gmag=grad.data[p];sum+=0.6*invWhite+0.4*gmag;count++;}}row.push(sum/Math.max(1,count));}masses.push(row);}return masses;}
function topKEmptiest(masses,k=3){const flat=[];for(let i=0;i<masses.length;i++)for(let j=0;j<masses[i].length;j++)flat.push({i,j,score:masses[i][j]});flat.sort((a,b)=>a.score-b.score);return flat.slice(0,k);}
function cellName(i,j){const names=[["top left","top center","top right"],["middle left","center","middle right"],["bottom left","bottom center","bottom right"]];return names[Math.max(0,Math.min(2,i))][Math.max(0,Math.min(2,j))];}

/* ---------- recommendation logic ---------- */
/* ---------- recommendation library ---------- */
const LIB = {
  "newsprint halftone dot field": {
    type: "pattern",
    fmt: where =>
      `Lay a **newsprint halftone dot field** as a translucent sheet across the ${where}, letting dots clash with your smooth areas.`,
    why: "Introduce mechanical texture to disrupt soft gradients / uniform fills."
  },
  "checkerboard strip": {
    type: "pattern",
    fmt: (where, dir) =>
      `Tape a **thin checkerboard strip** running ${dir} through the ${where}, slightly misaligned.`,
    why: "High-contrast, regular checkers oppose blended/low-contrast zones."
  },
  "CMY misregistration swatch": {
    type: "pattern",
    fmt: where =>
      `Add a **CMY misregistration swatch** (cyan/magenta/yellow blocks) in the ${where}, offset 2–4px per channel.`,
    why: "Printers’ marks add industrial color conflict against cohesive palettes."
  },
  "ransom-letter typography": {
    type: "concept",
    fmt: where =>
      `Collage a **ransom-letter word** from mismatched magazines across the ${where}.`,
    why: "Mixed fonts/forms fracture typographic cohesion and inject narrative tension."
  },
  "found map fragment": {
    type: "concept",
    fmt: where =>
      `Glue a **small torn map fragment** into the ${where} with a hard edge crossing your calm area.`,
    why: "Cartographic lines disrupt organic imagery; a ‘place’ reference counters abstraction."
  },
  "barcode/receipt sliver": {
    type: "concept",
    fmt: where =>
      `Slip a **barcode or receipt sliver** into the ${where}, slightly tilted.`,
    why: "Commodity marks oppose hand-made continuity and draw crisp verticals."
  },
  "torn paper diagonal": {
    type: "occurrence",
    fmt: where =>
      `Tear a **paper diagonal** from corner to corner through the ${where}; let the deckle edge show.`,
    why: "Jagged tear adds directional energy and interrupts symmetry."
  },
  "masking tape X": {
    type: "occurrence",
    fmt: where =>
      `Place a **masking-tape X** over the ${where}; leave a slight shadow gap.`,
    why: "Tape reads provisional; the X symbolically ‘cancels’ cohesion."
  },
  "photocopy overlay": {
    type: "occurrence",
    fmt: where =>
      `Overlay a **high-contrast photocopy** rectangle in the ${where}, 5–10° rotated.`,
    why: "Brittle, desaturated toner fights saturated blends; rotation breaks alignment."
  }
};

function randomDirection() {
  return ["diagonally", "vertically", "horizontally"][Math.floor(Math.random() * 3)];
}

/* ---------- recommendation logic ---------- */
function opposeCohesion(features) {
  if (!features) return { recs: [], reasons: [] };

  const recs = [];
  const reasons = [];

  const temp = features.temperature;           // "warm" | "cool"
  const cf   = features.colorfulness;          // number
  const cont = features.contrast;              // number (0..~0.5)
  const edges= features.edge_density;          // 0..1
  const ent  = features.entropy;               // ~0..8
  const region = features.suggested_region || "center";

  // 1) Color temperature opposition
  if (temp === "cool") {
    const R = LIB["CMY misregistration swatch"];
    recs.push(R.fmt(region));
    reasons.push(
      `Image skews cool; add warm-biased CMY blocks and misregistration to create chroma conflict near ${region}.`
    );
  } else {
    const R = LIB["photocopy overlay"];
    recs.push(R.fmt(region));
    reasons.push(
      `Image reads warm/saturated (colorfulness=${cf.toFixed(1)}); a desaturated photocopy slab opposes palette unity.`
    );
  }

  // 2) Texture / edge presence
  if (edges < 0.06) {
    const R = LIB["newsprint halftone dot field"];
    recs.push(R.fmt(region));
    reasons.push(
      `Edge density is low (${edges.toFixed(3)}); halftone dots add micro-structure and noise.`
    );
  } else {
    const R = LIB["masking tape X"];
    recs.push(R.fmt(region));
    reasons.push(
      `Edges already active (${edges.toFixed(3)}); a bold tape ‘X’ creates symbolic interruption instead.`
    );
  }

  // 3) Contrast / complexity
  if (cont < 0.12 || ent < 6.0) {
    const R = LIB["checkerboard strip"];
    recs.push(R.fmt(region, randomDirection()));
    reasons.push(
      `Contrast=${cont.toFixed(2)}, entropy=${ent.toFixed(2)}; a crisp checker strip injects periodic contrast.`
    );
  } else {
    const R = LIB["ransom-letter typography"];
    recs.push(R.fmt(region));
    reasons.push(
      `High image complexity (entropy=${ent.toFixed(2)}); mixed-letter typography shifts attention and breaks semantic cohesion.`
    );
  }

  return { recs, reasons };
}

/* ---------- overlay drawing ---------- */
function getOverlayKindFromRecs(recs=[]){const t=recs.join(" ").toLowerCase();if(t.includes("halftone"))return"halftone";if(t.includes("checker"))return"checker";if(t.includes("misregistration")||t.includes("cmy"))return"cmy";if(t.includes("masking-tape")||t.includes("tape x")||t.includes("masking"))return"tapex";if(t.includes("photocopy"))return"photocopy";return"checker";}
function buildOverlayPatch(kind, w, h) {
  const patch = document.createElement("canvas");
  patch.width = w; patch.height = h;
  const p = patch.getContext("2d");

  if (kind === "checker") {
    const cell = 12;
    const img = p.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const on = ((Math.floor(x / cell) ^ Math.floor(y / cell)) & 1) === 1;
        const v = on ? 245 : 25;
        img.data[i + 0] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 185;
      }
    }
    p.putImageData(img, 0, 0);
  }

  if (kind === "halftone") {
    p.clearRect(0, 0, w, h);
    const spacing = 10;
    for (let y = spacing / 2; y < h; y += spacing) {
      for (let x = spacing / 2; x < w; x += spacing) {
        const r = 2 + Math.random() * 3;
        p.beginPath();
        p.arc(x, y, r, 0, Math.PI * 2);
        p.fillStyle = "rgba(0,0,0,0.65)";
        p.fill();
      }
    }
  }

  if (kind === "cmy") {
    const pad = Math.floor(w * 0.05);
    const bw = Math.floor((w - 3 * pad) / 3);
    const bh = Math.floor(h - 2 * pad);
    const off = () => Math.floor((Math.random() * 6) - 3); // -3..+3 px
    p.globalAlpha = 0.7;
    p.fillStyle = "rgb(0,255,255)";
    p.fillRect(pad + off(), pad + off(), bw, bh);
    p.fillStyle = "rgb(255,0,255)";
    p.fillRect(pad + bw + pad + off(), pad + off(), bw, bh);
    p.fillStyle = "rgb(255,255,0)";
    p.fillRect(pad + 2 * (bw + pad) + off(), pad + off(), bw, bh);
    p.globalAlpha = 1.0;
  }

  if (kind === "tapex") {
    const tape = (x, y, len, th, rot, alpha = 0.75) => {
      p.save();
      p.translate(x, y); p.rotate(rot);
      p.fillStyle = `rgba(245,230,180,${alpha})`;
      p.fillRect(0, -th / 2, len, th);
      // add little speckles to feel papery
      for (let i = 0; i < Math.floor(len * th * 0.01); i++) {
        p.fillStyle = "rgba(200,185,140,0.2)";
        p.fillRect(Math.random() * len - 0.5, (Math.random() - 0.5) * th, 1, 1);
      }
      p.restore();
    };
    p.clearRect(0, 0, w, h);
    const len = Math.max(w, h) * 0.9;
    const th = Math.max(10, Math.min(w, h) * 0.12);
    tape(w * 0.05, h * 0.5, len, th, 0.8);
    tape(w * 0.95, h * 0.5, -len, th, -0.8);
  }

  if (kind === "photocopy") {
    p.fillStyle = "#f8f8f8";
    p.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 2) {
      p.fillStyle = Math.random() < 0.5 ? "rgba(0,0,0,0.1)" : "rgba(0,0,0,0.03)";
      p.fillRect(0, y, w, 1);
    }
    for (let i = 0; i < w * h * 0.006; i++) {
      p.fillStyle = "rgba(0,0,0,0.5)";
      p.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
    p.strokeStyle = "rgba(0,0,0,0.8)";
    p.lineWidth = 2;
    p.strokeRect(1, 1, w - 2, h - 2);
    p.globalAlpha = 0.85;
  }

  return patch;
}

function applySyntheticOverlay(){
  const region=lastAnalysis?.suggested_region||"center";
  const W=canvas.width,H=canvas.height;
  const w=Math.floor(W*0.45),h=Math.floor(H*0.25);
  const kind=getOverlayKindFromRecs(lastRecommendations);
  const patch=buildOverlayPatch(kind,w,h);
  const anchors={"top left":[0.05,0.08],"top center":[0.35,0.08],"top right":[0.65,0.08],"middle left":[0.05,0.38],"center":[0.35,0.38],"middle right":[0.65,0.38],"bottom left":[0.05,0.68],"bottom center":[0.35,0.68],"bottom right":[0.65,0.68]};
  const [ax,ay]=anchors[region]||[0.35,0.38];
  const jx=(Math.random()*0.16-0.08)*W, jy=(Math.random()*0.16-0.08)*H;
  let x=Math.floor(W*ax+jx), y=Math.floor(H*ay+jy);
  x=Math.max(0,Math.min(W-w,x)); y=Math.max(0,Math.min(H-h,y));
  const rot=(Math.random()*12-6)*Math.PI/180;
  ctx.save(); ctx.translate(x+w/2,y+h/2); ctx.rotate(rot); ctx.drawImage(patch,-w/2,-h/2); ctx.restore();
}

/* ---------- analyze + buttons ---------- */
async function analyze(mode){
  if(!srcImage){alert("Choose an image first.");return;}
  const img=getImageData(); const gray=toGray(img); const grad=sobelGrad(gray);
  const dom=dominantColorMean(img); const cf=colorfulnessHasler(img); const cont=contrastStd(gray);
  const ed=edgeDensity(gray); const H=entropy(gray); const {hue,temperature,meanS}=mainHueAndTemp(img);
  const masses=gridOccupancy(img,gray,grad,3,3); const candidates=topKEmptiest(masses,3);
  const pick=candidates[Math.floor(Math.random()*candidates.length)]; const region=cellName(pick.i,pick.j);

  lastAnalysis={dominant_color:dom,colorfulness:cf,contrast:cont,edge_density:ed,entropy:H,hue,temperature,mean_saturation:meanS,suggested_region:region};
  const {recs,reasons}=opposeCohesion(lastAnalysis); lastRecommendations=recs; lastReasons=reasons;

  renderFeatures(lastAnalysis); renderRecs(recs);
  if(mode==="direct") applySyntheticOverlay();
  saveHistoryThumb();
}

function renderFeatures(f){featuresEl.innerHTML=""; const entries={"temperature":f.temperature,"colorfulness":f.colorfulness.toFixed(3),"contrast":f.contrast.toFixed(3),"edge_density":f.edge_density.toFixed(3),"entropy":f.entropy.toFixed(3),"suggested_region":f.suggested_region}; Object.entries(entries).forEach(([k,v])=>{const li=document.createElement("li"); li.textContent=`${k}: ${v}`; featuresEl.appendChild(li);});}
function renderRecs(list){recsEl.innerHTML=""; list.forEach(t=>{const li=document.createElement("li"); li.innerHTML=t; recsEl.appendChild(li);});}

/* Diffusion button (optional) */
async function applyDiffusionOverlay(){
  const prompt=promptFromRecs(lastAnalysis,lastRecommendations);
  statusEl.textContent="Generating diffusion overlay…";
  try{
    const targetW=Math.floor(canvas.width*0.45), targetH=Math.floor(canvas.height*0.25);
    const blob=await fetchDiffusionPNG(prompt,targetW,targetH);
    const bmp=await createBitmapFromBlob(blob);
    const cut=whiteToTransparent(bmp,242);
    const region=lastAnalysis?.suggested_region||"center";
    const anchors={"top left":[0.05,0.08],"top center":[0.35,0.08],"top right":[0.65,0.08],"middle left":[0.05,0.38],"center":[0.35,0.38],"middle right":[0.65,0.38],"bottom left":[0.05,0.68],"bottom center":[0.35,0.68],"bottom right":[0.65,0.68]};
    const [ax,ay]=anchors[region]||[0.35,0.38]; const W=canvas.width,H=canvas.height;
    const jx=(Math.random()*0.16-0.08)*W, jy=(Math.random()*0.16-0.08)*H;
    const scale=Math.min(targetW/cut.width,targetH/cut.height);
    const rw=Math.max(8,Math.floor(cut.width*scale)), rh=Math.max(8,Math.floor(cut.height*scale));
    let x=Math.floor(W*ax+jx), y=Math.floor(H*ay+jy); x=Math.max(0,Math.min(W-rw,x)); y=Math.max(0,Math.min(H-rh,y));
    const rot=(Math.random()*12-6)*Math.PI/180; ctx.save(); ctx.translate(x+rw/2,y+rh/2); ctx.rotate(rot); ctx.drawImage(cut,-rw/2,-rh/2,rw,rh); ctx.restore();
    statusEl.textContent="Overlay added.";
  }catch(e){console.warn("Diffusion failed, using local overlay:",e); statusEl.textContent="Diffusion unavailable—used local overlay."; applySyntheticOverlay();}
}

/* Logging + history */
async function submitDecision(dec){ if(!lastRecommendations) return; const ts=new Date().toISOString(); logRows.push([ts,dec,lastRecommendations.join(" | "),(lastReasons||[]).join(" ; ")]); statusEl.textContent="Saved (in-memory). Use 'Download CSV Log' to export."; }
acceptBtn.addEventListener("click",()=>submitDecision("accept"));
skipBtn.addEventListener("click",()=>submitDecision("skip"));
downloadCsvBtn.addEventListener("click",()=>{const csv=logRows.map(r=>r.map(v=>`"${(v+"").replace(/"/g,'""')}"`).join(",")).join("\n"); const blob=new Blob([csv],{type:"text/csv"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="interactions.csv"; a.click(); URL.revokeObjectURL(url);});

analyzeBtn.addEventListener("click",()=>analyze("general"));
directBtn.addEventListener("click",()=>analyze("direct"));
document.getElementById("diffuseBtn").addEventListener("click",async()=>{ if(!srcImage){alert("Choose an image first."); return;} await analyze("general"); await applyDiffusionOverlay(); });

/* Qwen edit */
document.getElementById("qwenBtn").addEventListener("click", async () => {
  if (!srcImage) { alert("Choose an image first."); return; }
  await analyze("general");
  const instruction = (lastRecommendations?.[0] || "Add a small collage element in the suggested region.")
    .replace(/\*\*/g, "") + ` Only modify the ${lastAnalysis?.suggested_region || "center"} area; keep all other areas unchanged.`;
  statusEl.textContent = "Editing via Qwen…";
  try {
    const url = await editWithQwen(canvas.toDataURL("image/png"), instruction);
    const edited = new Image();
    edited.crossOrigin = "anonymous";
    edited.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(edited, 0, 0, canvas.width, canvas.height);
      statusEl.textContent = "Done.";
      saveHistoryThumb();
    };
    edited.src = url;
  } catch (e) {
    console.warn(e);
    statusEl.textContent = "Qwen edit failed—using local overlay.";
    applySyntheticOverlay();
  }
});

async function editWithQwen(imageDataURL, instruction) {
  const res = await fetch(`${API_BASE}/qwen-edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageDataURL,
      prompt: instruction,
      steps: 28,
      guidance: 4
    })
  });
  const { url, error } = await res.json();
  if (error) throw new Error(error);
  return url;
}



function saveHistoryThumb() {
  // make a small thumbnail from the current canvas
  const thumb = document.createElement("canvas");
  const w = 220, h = Math.max(1, Math.round(canvas.height * (220 / canvas.width)));
  thumb.width = w; thumb.height = h;
  const t = thumb.getContext("2d");
  t.drawImage(canvas, 0, 0, w, h);

  const dataURL = thumb.toDataURL("image/png");

  try {
    const list = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || "[]");
    list.push(dataURL);

    // keep only the last 20 to stay safe on quota
    if (list.length > 20) list.splice(0, list.length - 20);

    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    renderHistory();
  } catch (e) {
    console.warn("Could not save history thumbnail:", e);
  }
}

function renderHistory() {
  const list = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || "[]");
  historyGrid.innerHTML = "";
  list.slice().reverse().forEach(u => {
    const img = document.createElement("img");
    img.src = u;
    img.alt = "history item";
    img.className = "thumb";
    historyGrid.appendChild(img);
  });
}
