// functions/qwen-edit.js — Cloudflare Pages Function
// POST body (JSON):
// { imageDataURL: string, maskDataURL?: string, prompt: string, steps?: number, guidance?: number }
//
// Response JSON on success: { url: string }

export async function onRequestOptions({ request }) {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
  });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin") || "*";
  const cors = (status, data) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
      },
    });

  try {
    if (!env.FAL_KEY) {
      return cors(500, { error: "Missing FAL_KEY in environment." });
    }

    // ---- read JSON body ----
    let body;
    try {
      body = await request.json();
    } catch {
      return cors(400, { error: "Expected JSON body." });
    }

    const {
      imageDataURL,
      maskDataURL,
      prompt,
      steps = 28,
      guidance = 4,
    } = body || {};

    if (!imageDataURL || !prompt) {
      return cors(400, { error: "imageDataURL and prompt are required." });
    }

    // ---- helpers ----
    const dataURLtoBlob = (dataURL) => {
      const m = /^data:(.*?);base64,(.*)$/.exec(dataURL);
      if (!m) throw new Error("Invalid data URL");
      const mime = m[1] || "application/octet-stream";
      const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      return new Blob([bin], { type: mime });
    };

    // ---- build multipart form for FAL ----
    const form = new FormData();
    form.append("prompt", String(prompt));
    form.append("num_inference_steps", String(steps));
    form.append("guidance_scale", String(guidance));
    form.append("output_format", "png");
    form.append("sync_mode", "true"); // try for immediate return when possible
    form.append("image", dataURLtoBlob(imageDataURL), "image.png");
    if (maskDataURL) {
      form.append("mask", dataURLtoBlob(maskDataURL), "mask.png"); // white=edit, black=protect
    }

    // ---- submit to FAL queue endpoint ----
    const submit = await fetch("https://queue.fal.run/fal-ai/qwen-image-edit", {
      method: "POST",
      headers: { Authorization: `Key ${env.FAL_KEY}` },
      body: form,
    });

    const ctype = submit.headers.get("content-type") || "";
    if (!submit.ok) {
      const errText = ctype.includes("application/json")
        ? JSON.stringify(await submit.json())
        : await submit.text();
      return cors(submit.status, { error: `FAL error: ${errText}` });
    }

    const submitJson = ctype.includes("application/json") ? await submit.json() : {};

    // Case A: immediate image(s) returned
    if (submitJson?.images?.length) {
      return cors(200, { url: submitJson.images[0].url });
    }

    // Case B: queued → poll for result
    const reqId = submitJson.request_id;
    if (!reqId) {
      return cors(502, { error: "FAL returned neither images nor request_id." });
    }

    const waitMs = Number(env.FAL_WAIT_MS || 90000);
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(
        `https://queue.fal.run/fal-ai/qwen-image-edit/requests/${reqId}`,
        { headers: { Authorization: `Key ${env.FAL_KEY}` } }
      );

      const outCtype = res.headers.get("content-type") || "";
      const out = outCtype.includes("application/json") ? await res.json() : {};

      if (out?.error) {
        return cors(500, { error: `FAL queued error: ${out.error}` });
      }
      if (out?.images?.length) {
        return cors(200, { url: out.images[0].url });
      }
      // otherwise keep polling…
    }

    return cors(504, { error: "Timeout waiting for FAL result." });
  } catch (err) {
    return cors(500, { error: err.message || String(err) });
  }
}
