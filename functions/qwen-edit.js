// Cloudflare Pages Function (qwen-edit.js)

export async function onRequestOptions({ request }) {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  
  export async function onRequestPost({ request, env }) {
    const cors = (status, data) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
          "Vary": "Origin",
        },
      });
  
    try {
      const { imageDataURL, maskDataURL, prompt, steps = 28, guidance = 4 } =
        await request.json();
  
      if (!env.FAL_KEY) {
        return cors(500, { error: "Missing FAL_KEY in environment." });
      }
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
  
      // Build multipart body so we don't need a public image URL
      const form = new FormData();
      form.append("prompt", prompt);
      form.append("num_inference_steps", String(steps));
      form.append("guidance_scale", String(guidance));
      form.append("output_format", "png");
      form.append("sync_mode", "true"); // try for immediate return
  
      // Primary image
      form.append("image", dataURLtoBlob(imageDataURL), "image.png");
  
      // Optional mask (white = edit, black = protect)
      if (maskDataURL) {
        form.append("mask", dataURLtoBlob(maskDataURL), "mask.png");
      }
  
      // Send to FAL (multipart). Using the queue endpoint covers both sync/async.
      const submit = await fetch("https://queue.fal.run/fal-ai/qwen-image-edit", {
        method: "POST",
        headers: { Authorization: `Key ${env.FAL_KEY}` },
        body: form,
      });
  
      // If FAL returns a non-JSON error, surface it
      const ctype = submit.headers.get("content-type") || "";
      if (!submit.ok) {
        const errText = ctype.includes("application/json")
          ? JSON.stringify(await submit.json())
          : await submit.text();
        return cors(submit.status, { error: `FAL error: ${errText}` });
      }
  
      const submitJson = ctype.includes("application/json")
        ? await submit.json()
        : {};
  
      // Case A: immediate image(s)
      if (submitJson?.images?.length) {
        return cors(200, { url: submitJson.images[0].url });
      }
  
      // Case B: queued, poll with request_id
      const reqId = submitJson.request_id;
      if (!reqId) {
        return cors(500, { error: "FAL returned no images and no request_id." });
      }
  
      const deadline = Date.now() + 30000; // 30s poll
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const res = await fetch(
          `https://queue.fal.run/fal-ai/qwen-image-edit/requests/${reqId}`,
          { headers: { Authorization: `Key ${env.FAL_KEY}` } }
        );
        const out = await res.json();
        if (out?.images?.length) {
          return cors(200, { url: out.images[0].url });
        }
        // if out.status is an error, surface it
        if (out?.error) {
          return cors(500, { error: `FAL queued error: ${out.error}` });
        }
      }
  
      return cors(504, { error: "Timeout waiting for FAL result." });
    } catch (err) {
      return cors(500, { error: err.message || String(err) });
    }
  }
  