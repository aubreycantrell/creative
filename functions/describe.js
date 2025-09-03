// functions/describe.js  (Cloudflare Pages Function)

export async function onRequestOptions({ request }) {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      "Cache-Control": "no-store",
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
        "Cache-Control": "no-store",
      },
    });

  try {
    const { imageDataURL } = await request.json();
    if (!env.FAL_KEY) return cors(500, { error: "Missing FAL_KEY in environment." });
    if (!imageDataURL) return cors(400, { error: "imageDataURL required." });

    // Convert DataURL -> Blob (so we don’t need a public URL)
    const dataURLtoBlob = (dataURL) => {
      const m = /^data:(.*?);base64,(.*)$/.exec(dataURL);
      if (!m) throw new Error("Invalid data URL");
      const mime = m[1] || "application/octet-stream";
      const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      return new Blob([bin], { type: mime });
    };

    const form = new FormData();
    form.append("image", dataURLtoBlob(imageDataURL), "image.jpg");
    form.append(
      "prompt",
      'Describe the main subject in one concise sentence, then list 8-12 single-word lowercase keywords (mostly concrete nouns). ' +
      'Respond ONLY as minified JSON: {"caption": "...", "keywords": ["...","..."]}'
    );

    // Use a visual-language model you have access to on FAL.
    // If "fal-ai/llava-next" isn't available for your account, swap to
    // another captioning model you do have (e.g., a different llava variant).
    const submit = await fetch("https://queue.fal.run/fal-ai/llava-next", {
      method: "POST",
      headers: { Authorization: `Key ${env.FAL_KEY}` },
      body: form,
    });

    const out = await submit.json();
    // Many FAL VLMs return { output_text: "<json string>" }
    let caption = "", keywords = [];
    try {
      const txt = out?.output_text || out?.text || "";
      const parsed = JSON.parse(txt);
      caption = parsed.caption || "";
      keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
    } catch {
      // conservative fallback
      caption = out?.caption || "scene";
      keywords = Array.isArray(out?.keywords) ? out.keywords : [];
    }

    return cors(200, { caption, keywords });
  } catch (err) {
    return cors(500, { error: err.message || String(err) });
  }
}
