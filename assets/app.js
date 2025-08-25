/* Serverless collage analyzer — runs fully in-browser (GitHub Pages friendly) */

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
const ctx = canvas.getContext("2d");

let srcImage = null;             // HTMLImageElement
let lastAnalysis = null;         // features object
let lastRecommendations = null;  // array of strings (user-facing)
let lastReasons = null;          // array of strings (hidden)
let logRows = [["timestamp","user_decision","prompts","internal_explanations"]];

const HISTORY_KEY = "collage_history_dataurls";

/* ---------- helpers ---------- */

function loadImageToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // scale down to a manageable width to keep analysis fast
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

/* canvas utils */
function getImageData() {
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function toGray(imgData) {
  const { data, width, height } = imgData;
  const g = new Uint8ClampedArray(width*height);
  for (let i=0, j=0; i<data.length; i+=4, j++) {
    const r = data[i], gch = data[i+1], b = data[i+2];
    g[j] = Math.round(0.299*r + 0.587*gch + 0.114*b);
  }
  return { data: g, width, height };
}

/* ---------- feature extraction (JS versions of your Python metrics) ---------- */

function dominantColorMean(imgData) {
  const { data } = imgData;
  let r=0,g=0,b=0, n=0;
  for (let i=0; i<data.length; i+=4) {
    r += data[i]; g += data[i+1]; b += data[i+2]; n++;
  }
  return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
}

function colorfulnessHasler(imgData) {
  // Hasler & Süsstrunk: sqrt(std_rg^2 + std_yb^2) + 0.3*sqrt(mean_rg^2 + mean_yb^2)
  const { data } = imgData;
  const rgArr = [];
  const ybArr = [];
  for (let i=0; i<data.length; i+=4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const rg = Math.abs(r - g);
    const yb = Math.abs(0.5*(r + g) - b);
    rgArr.push(rg); ybArr.push(yb);
  }
  const mean = arr => arr.reduce((a,c)=>a+c,0)/arr.length;
  const mrg = mean(rgArr), myb = mean(ybArr);
  const srg = Math.sqrt(mean(rgArr.map(v => (v-mrg)*(v-mrg))));
  const syb = Math.sqrt(mean(ybArr.map(v => (v-myb)*(v-myb))));
  return Math.sqrt(srg*srg + syb*syb) + 0.3*Math.sqrt(mrg*mrg + myb*myb);
}

function contrastStd(gray) {
  const { data } = gray;
  const mean = data.reduce((a,c)=>a+c,0)/data.length;
  const varg = data.reduce((a,c)=>a+(c-mean)*(c-mean),0)/data.length;
  return Math.sqrt(varg)/255.0;  // ~0..0.5
}

function sobelGrad(gray) {
  const { data, width, height } = gray;
  const gxK = [-1,0,1,-2,0,2,-1,0,1];
  const gyK = [-1,-2,-1,0,0,0,1,2,1];
  const mag = new Float32Array(width*height);
  // skip border
  for (let y=1; y<height-1; y++) {
    for (let x=1; x<width-1; x++) {
      let gx=0, gy=0, idx=0;
      for (let ky=-1; ky<=1; ky++) {
        for (let kx=-1; kx<=1; kx++) {
          const p = (y+ky)*width + (x+kx);
          const v = data[p];
          gx += gxK[idx]*v;
          gy += gyK[idx]*v;
          idx++;
        }
      }
      const m = Math.hypot(gx, gy);
      mag[y*width+x] = m;
    }
  }
  // normalize
  let max=0;
  for (let i=0;i<mag.length;i++) if (mag[i]>max) max=mag[i];
  const norm = new Float32Array(mag.length);
  const inv = max>0 ? 1/max : 0;
  for (let i=0;i<mag.length;i++) norm[i] = mag[i]*inv;
  return { data: norm, width, height };
}

function edgeDensity(gray) {
  const grad = sobelGrad(gray);
  // consider pixels "edge" if grad > threshold
  let count=0;
  const th = 0.25;
  for (let i=0;i<grad.data.length;i++) if (grad.data[i] > th) count++;
  return count / grad.data.length; // 0..1
}

function entropy(gray) {
  const hist = new Uint32Array(256);
  for (let i=0;i<gray.data.length;i++) hist[gray.data[i]]++;
  const total = gray.data.length;
  let H = 0;
  for (let v=0; v<256; v++) {
    if (!hist[v]) continue;
    const p = hist[v]/total;
    H -= p * Math.log2(p);
  }
  return H; // ~0..8
}

function rgb2hsv(r,g,b) {
  const rn = r/255, gn = g/255, bn = b/255;
  const cmax = Math.max(rn,gn,bn), cmin = Math.min(rn,gn,bn);
  const delta = cmax - cmin;
  let h = 0;
  if (delta !== 0) {
    if (cmax === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (cmax === gn) h = 60 * (((bn - rn) / delta) + 2);
    else h = 60 * (((rn - gn) / delta) + 4);
  }
  if (h < 0) h += 360;
  const s = cmax === 0 ? 0 : delta / cmax;
  const v = cmax;
  return [h,s,v];
}

function mainHueAndTemp(imgData) {
  const { data } = imgData;
  let sumH = 0, n = 0, sumS = 0;
  for (let i=0; i<data.length; i+=4) {
    const r=data[i], g=data[i+1], b=data[i+2];
    const [h,s,_v] = rgb2hsv(r,g,b);
    if (s > 0.1) { sumH += h; sumS += s; n++; }
  }
  const hue = n ? (sumH/n) : 0;
  const satMean = n ? (sumS/n) : 0;
  const warm = (hue < 30) || (hue > 330) || (hue >= 30 && hue <= 60);
  return { hue, temperature: warm ? "warm" : "cool", meanS: satMean };
}

function gridOccupancy(imgData, gray, grad, rows=3, cols=3) {
  const w = imgData.width, h = imgData.height;
  const masses = [];
  const cellW = Math.floor(w/cols), cellH = Math.floor(h/rows);
  for (let r=0; r<rows; r++) {
    const row = [];
    for (let c=0; c<cols; c++) {
      const x0 = c*cellW, y0 = r*cellH;
      const x1 = (c===cols-1) ? w : x0 + cellW;
      const y1 = (r===rows-1) ? h : y0 + cellH;
      let sum=0, count=0;
      for (let y=y0; y<y1; y++) {
        for (let x=x0; x<x1; x++) {
          const p = y*w + x;
          const invWhite = 1 - gray.data[p]/255;
          const gmag = grad.data[p]; // already 0..1
          sum += 0.6*invWhite + 0.4*gmag;
          count++;
        }
      }
      row.push(sum / Math.max(1,count));
    }
    masses.push(row);
  }
  return masses;
}

function emptiestCell(masses) {
  let min=Infinity, mi=0, mj=0;
  for (let i=0; i<masses.length; i++) {
    for (let j=0; j<masses[i].length; j++) {
      if (masses[i][j] < min) { min = masses[i][j]; mi=i; mj=j; }
    }
  }
  return { i: mi, j: mj, mass: min };
}

function cellName(i,j) {
  const names = [
    ["top left","top center","top right"],
    ["middle left","center","middle right"],
    ["bottom left","bottom center","bottom right"]
  ];
  return names[Math.max(0,Math.min(2,i))][Math.max(0,Math.min(2,j))];
}

/* ---------- recommendation logic (mirrors your Python rules) ---------- */

const LIB = {
  "newsprint halftone dot field": {
    type: "pattern",
    fmt: where => `Lay a **newsprint halftone dot field** as a translucent sheet across the ${where}, letting dots clash with your smooth areas.`,
    why: "Introduce mechanical texture to disrupt soft gradients / uniform fills."
  },
  "checkerboard strip": {
    type: "pattern",
    fmt: (where,dir) => `Tape a **thin checkerboard strip** running ${dir} through the ${where}, slightly misaligned.`,
    why: "High-contrast, regular checkers oppose blended/low-contrast zones."
  },
  "CMY misregistration swatch": {
    type: "pattern",
    fmt: where => `Add a **CMY misregistration swatch** (cyan/magenta/yellow blocks) in the ${where}, offset 2–4px per channel.`,
    why: "Printers’ marks add industrial color conflict against cohesive palettes."
  },
  "ransom-letter typography": {
    type: "concept",
    fmt: where => `Collage a **ransom-letter word** from mismatched magazines across the ${where}.`,
    why: "Mixed fonts/forms fracture typographic cohesion and inject narrative tension."
  },
  "found map fragment": {
    type: "concept",
    fmt: where => `Glue a **small torn map fragment** into the ${where} with a hard edge crossing your calm area.`,
    why: "Cartographic lines disrupt organic imagery; a ‘place’ reference counters abstraction."
  },
  "barcode/receipt sliver": {
    type: "concept",
    fmt: where => `Slip a **barcode or receipt sliver** into the ${where}, slightly tilted.`,
    why: "Commodity marks oppose hand-made continuity and draw crisp verticals."
  },
  "torn paper diagonal": {
    type: "occurrence",
    fmt: where => `Tear a **paper diagonal** from corner to corner through the ${where}; let the deckle edge show.`,
    why: "Jagged tear adds directional energy and interrupts symmetry."
  },
  "masking tape X": {
    type: "occurrence",
    fmt: where => `Place a **masking-tape X** over the ${where}; leave a slight shadow gap.`,
    why: "Tape reads provisional; the X symbolically ‘cancels’ cohesion."
  },
  "photocopy overlay": {
    type: "occurrence",
    fmt: where => `Overlay a **high-contrast photocopy** rectangle in the ${where}, 5–10° rotated.`,
    why: "Brittle, desaturated toner fights saturated blends; rotation breaks alignment."
  }
};

function randomDirection() {
  return ["diagonally","vertically","horizontally"][Math.floor(Math.random()*3)];
}

function opposeCohesion(features) {
  const recs = [], reasons = [];
  const temp = features.temperature;
  const cf = features.colorfulness;
  const cont = features.contrast;
  const edges = features.edge_density;
  const ent = features.entropy;
  const region = features.suggested_region;

  // 1) Color temperature opposition
  if (temp === "cool") {
    const R = LIB["CMY misregistration swatch"];
    recs.push(R.fmt(region));
    reasons.push(`Image skews cool; add warm-biased CMY blocks and misregistration to create chroma conflict near ${region}.`);
  } else {
    const R = LIB["photocopy overlay"];
    recs.push(R.fmt(region));
    reasons.push(`Image reads warm/saturated (colorfulness=${cf.toFixed(1)}); a desaturated photocopy slab opposes palette unity.`);
  }

  // 2) Texture / edge presence
  if (edges < 0.06) {
    const R = LIB["newsprint halftone dot field"];
    recs.push(R.fmt(region));
    reasons.push(`Edge density is low (${edges.toFixed(3)}); halftone dots add micro-structure and noise.`);
  } else {
    const R = LIB["masking tape X"];
    recs.push(R.fmt(region));
    reasons.push(`Edges already active (${edges.toFixed(3)}); a bold tape ‘X’ creates symbolic interruption instead.`);
  }

  // 3) Contrast / complexity
  if (cont < 0.12 || ent < 6.0) {
    const R = LIB["checkerboard strip"];
    recs.push(R.fmt(region, randomDirection()));
    reasons.push(`Contrast=${cont.toFixed(2)}, entropy=${ent.toFixed(2)}; a crisp checker strip injects periodic contrast.`);
  } else {
    const R = LIB["ransom-letter typography"];
    recs.push(R.fmt(region));
    reasons.push(`High image complexity (entropy=${ent.toFixed(2)}); mixed-letter typography shifts attention and breaks semantic cohesion.`);
  }
  return { recs, reasons };
}

/* ---------- analysis + UI ---------- */

async function analyze(mode) {
  if (!srcImage) {
    alert("Choose an image first.");
    return;
  }
  const img = getImageData();
  const gray = toGray(img);
  const grad = sobelGrad(gray);

  const dom = dominantColorMean(img);
  const cf = colorfulnessHasler(img);
  const cont = contrastStd(gray);
  const ed = edgeDensity(gray);
  const H = entropy(gray);
  const { hue, temperature, meanS } = mainHueAndTemp(img);
  const masses = gridOccupancy(img, gray, grad, 3, 3);
  const empty = emptiestCell(masses);
  const region = cellName(empty.i, empty.j);

  const features = {
    dominant_color: dom,
    colorfulness: cf,
    contrast: cont,
    edge_density: ed,
    entropy: H,
    hue,
    temperature,
    mean_saturation: meanS,
    suggested_region: region
  };
  lastAnalysis = features;

  const { recs, reasons } = opposeCohesion(features);
  lastRecommendations = recs;
  lastReasons = reasons;

  renderFeatures(features);
  renderRecs(recs);

  if (mode === "direct") {
    applySyntheticOverlay();
  }

  // Save history snapshot for this device
  saveHistoryThumb();
}

function renderFeatures(f) {
  featuresEl.innerHTML = "";
  const entries = {
    "temperature": f.temperature,
    "colorfulness": f.colorfulness.toFixed(3),
    "contrast": f.contrast.toFixed(3),
    "edge_density": f.edge_density.toFixed(3),
    "entropy": f.entropy.toFixed(3),
    "suggested_region": f.suggested_region
  };
  Object.entries(entries).forEach(([k,v]) => {
    const li = document.createElement("li");
    li.textContent = `${k}: ${v}`;
    featuresEl.appendChild(li);
  });
}

function renderRecs(list) {
  recsEl.innerHTML = "";
  list.forEach(t => {
    const li = document.createElement("li");
    li.innerHTML = t; // contains **bold** markup
    recsEl.appendChild(li);
  });
}

/* A “direct overlay” stand-in: transparent noisy patch pasted onto the canvas */
function applySyntheticOverlay() {
  const w = Math.floor(canvas.width * 0.45);
  const h = Math.floor(canvas.height * 0.25);
  const patch = document.createElement("canvas");
  patch.width = w; patch.height = h;
  const pctx = patch.getContext("2d");
  const imgData = pctx.createImageData(w, h);
  for (let i=0; i<imgData.data.length; i+=4) {
    const val = Math.floor(Math.random()*256);
    imgData.data[i] = val;
    imgData.data[i+1] = val;
    imgData.data[i+2] = val;
    imgData.data[i+3] = 170; // alpha
  }
  pctx.putImageData(imgData, 0, 0);

  // place in the “emptiest” suggested region
  const region = lastAnalysis?.suggested_region || "center";
  let x = Math.floor(canvas.width*0.3), y = Math.floor(canvas.height*0.35);
  const map = {
    "top left":[0.05,0.08], "top center":[0.35,0.08], "top right":[0.65,0.08],
    "middle left":[0.05,0.38], "center":[0.35,0.38], "middle right":[0.65,0.38],
    "bottom left":[0.05,0.68], "bottom center":[0.35,0.68], "bottom right":[0.65,0.68]
  };
  if (map[region]) {
    x = Math.floor(canvas.width*map[region][0]);
    y = Math.floor(canvas.height*map[region][1]);
  }
  ctx.drawImage(patch, x, y);
}

analyzeBtn.addEventListener("click", () => analyze("general"));
directBtn.addEventListener("click", () => analyze("direct"));

downloadPngBtn.addEventListener("click", () => {
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = "collage_result.png";
  a.click();
});

/* logging: never shows hidden reasons to participants, but lets you export CSV */
async function submitDecision(decision) {
  if (!lastRecommendations) return;
  const ts = new Date().toISOString();
  logRows.push([
    ts,
    decision,
    lastRecommendations.join(" | "),
    (lastReasons || []).join(" ; ")
  ]);
  statusEl.textContent = "Saved (in-memory). Use 'Download CSV Log' to export.";
}

acceptBtn.addEventListener("click", () => submitDecision("accept"));
skipBtn.addEventListener("click", () => submitDecision("skip"));

downloadCsvBtn.addEventListener("click", () => {
  const csv = logRows.map(r => r.map(v => `"${(v+"").replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "interactions.csv";
  a.click();
  URL.revokeObjectURL(url);
});

/* history (device-local only via localStorage) */
function saveHistoryThumb() {
  // store a small thumbnail dataURL
  const thumb = document.createElement("canvas");
  const w = 220, h = Math.round(canvas.height * (220/canvas.width));
  thumb.width = w; thumb.height = h;
  const tctx = thumb.getContext("2d");
  tctx.drawImage(canvas, 0, 0, w, h);
  const dataURL = thumb.toDataURL("image/png");

  const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  list.push(dataURL);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  renderHistory();
}

function renderHistory() {
  const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  historyGrid.innerHTML = "";
  list.slice().reverse().forEach(u => {
    const img = document.createElement("img");
    img.src = u; img.alt = "history item"; img.className = "thumb";
    historyGrid.appendChild(img);
  });
}
renderHistory();
