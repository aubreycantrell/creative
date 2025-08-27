export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
  
      // --- CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders(env, request) });
      }
  
      try {
        if (url.pathname === "/qwen-edit" && request.method === "POST") {
          return await handleQwenEdit(request, env);
        }
  
        if (url.pathname === "/diffuse" && request.method === "POST") {
          // Optional text-to-image passthrough (keep for future)
          return await handleDiffuse(request, env);
        }
  
        return new Response("Not found", { status: 404, headers: corsHeaders(env, request) });
      } catch (err) {
        return json({ error: err.message }, 500, env, request);
      }
    }
  };
  
  /* ------------------------ Handlers ------------------------ */
  
  async function handleQwenEdit(request, env) {
    const { imageDataURL, prompt, steps = 28, guidance = 4 } = await request.json();
  
    // Submit job to fal queue
    const submit = await fetch("https://queue.fal.run/fal-ai/qwen-image-edit", {
      method: "POST",
      headers: {
        "Authorization": `Key ${env.FAL_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        image_url: imageDataURL,        // data: URL OK with fal
        num_inference_steps: steps,
        guidance_scale: guidance,
        output_format: "png",
        sync_mode: true                 // if unsupported, we'll poll below
      })
    });
  
    // If auth/model issues, surface body text for debugging
    if (!submit.ok) {
      const t = await submit.text();
      throw new Error(`fal submit failed: ${submit.status} ${t}`);
    }
  
    const submitJson = await submit.json();
  
    // If sync mode returned output, send it back now
    if (submitJson?.images?.length) {
      return json({ url: submitJson.images[0].url }, 200, env, request);
    }
  
    const reqId = submitJson.request_id;
    if (!reqId) throw new Error("No request_id from fal");
  
    // Poll queue for result (up to ~30s)
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const res = await fetch(`https://queue.fal.run/fal-ai/qwen-image-edit/requests/${reqId}`, {
        headers: { "Authorization": `Key ${env.FAL_KEY}` }
      });
      if (!res.ok) continue;
      const out = await res.json();
      if (out?.images?.length) {
        return json({ url: out.images[0].url }, 200, env, request);
      }
    }
  
    throw new Error("Timeout waiting for fal result");
  }
  
  // Stub text-to-image proxy (wire to your chosen fal model later)
  async function handleDiffuse(request, env) {
    const { prompt, width = 512, height = 384 } = await request.json();
  
    // Example queue call (replace with your preferred model id)
    const submit = await fetch("https://queue.fal.run/fal-ai/flux/schnell", {
      method: "POST",
      headers: {
        "Authorization": `Key ${env.FAL_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        image_size: `${width}x${height}`,
        output_format: "png",
        sync_mode: true
      })
    });
  
    if (!submit.ok) {
      const t = await submit.text();
      throw new Error(`fal submit failed: ${submit.status} ${t}`);
    }
  
    const submitJson = await submit.json();
    if (submitJson?.images?.length) {
      return json({ url: submitJson.images[0].url }, 200, env, request);
    }
  
    const reqId = submitJson.request_id;
    if (!reqId) throw new Error("No request_id from fal");
  
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const res = await fetch(`https://queue.fal.run/fal-ai/flux/schnell/requests/${reqId}`, {
        headers: { "Authorization": `Key ${env.FAL_KEY}` }
      });
      if (!res.ok) continue;
      const out = await res.json();
      if (out?.images?.length) {
        return json({ url: out.images[0].url }, 200, env, request);
      }
    }
  
    throw new Error("Timeout waiting for fal result");
  }
  
  /* ------------------------ Helpers ------------------------ */
  
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  
  function allowedOrigins(env) {
    // Comma-separated in wrangler.toml vars
    const raw = env.ALLOWED_ORIGINS || "";
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  }
  
  function corsHeaders(env, request) {
    const origin = request.headers.get("Origin") || "";
    const list = allowedOrigins(env);
    const allow = list.includes(origin) ? origin : list[0] || "*";
    return {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "86400"
    };
  }
  
  function json(obj, status, env, request) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(env, request)
      }
    });
  }
  