// Cloudflare Worker: proxy → Hugging Face Inference (sd-turbo)
// Caches results by prompt+params, adds CORS for your Pages front-end.

export default {
    async fetch(request, env, ctx) {
      // CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        });
      }
      if (request.method !== "POST") {
        return new Response("Only POST supported", { status: 405 });
      }
  
      let body;
      try { body = await request.json(); } 
      catch { return cors(new Response("Invalid JSON", { status: 400 })); }
  
      const {
        prompt = "collage paper cut-out on white background",
        width = 512,
        height = 384,
        steps = 6,
        guidance = 1.0,
        model = "stabilityai/sd-turbo"
      } = body;
  
      // clamp for safety / iPad perf
      const W = Math.min(Math.max(128, width), 768);
      const H = Math.min(Math.max(128, height), 768);
      const S = Math.min(Math.max(1, steps), 12);
      const G = Math.min(Math.max(0, guidance), 7.5);
  
      // Build cache key (GET URL w/ hash so we can cache a POST)
      const keyStr = JSON.stringify({ model, prompt, W, H, S, G });
      const hash = await sha256(keyStr);
      const cacheUrl = new URL(request.url);
      cacheUrl.pathname = "/image";
      cacheUrl.search = `?key=${hash}`;
      const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  
      // Edge cache
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) return cors(cached);
  
      // Call Hugging Face Inference API
      const r = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.HF_TOKEN}`,
          "Content-Type": "application/json",
          "Accept": "image/png"
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            width: W, height: H,
            num_inference_steps: S,
            guidance_scale: G
          }
        })
      });
  
      if (!r.ok) {
        const text = await r.text();
        return cors(new Response(text || "Upstream error", { status: r.status }));
      }
  
      const buf = await r.arrayBuffer();
      const resp = new Response(buf, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400, s-maxage=86400"
        }
      });
  
      // store in cache (async)
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return cors(resp);
    }
  }
  
  function cors(response) {
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    return new Response(response.body, { status: response.status, headers });
  }
  
  async function sha256(s) {
    const data = new TextEncoder().encode(s);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  