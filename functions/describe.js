// /functions/describe.js

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
      const { imageDataURL } = await request.json();
  
      // If you later want real captions via FAL, uncomment and configure:
       if (env.FAL_KEY && imageDataURL) {
         const dataURLtoBlob = (dataURL) => {
           const m = /^data:(.*?);base64,(.*)$/.exec(dataURL);
           if (!m) throw new Error("Invalid data URL");
           const mime = m[1] || "application/octet-stream";
           const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
          return new Blob([bin], { type: mime });
         };
         const form = new FormData();
         form.append("image", dataURLtoBlob(imageDataURL), "image.png");
         form.append("prompt", "Describe the main subject, theme keywords, and medium hints in a few words.");
         const r = await fetch("https://queue.fal.run/fal-ai/llava-next/image-to-text", {
           method: "POST",
           headers: { Authorization: `Key ${env.FAL_KEY}` },
           body: form,
         });
         const j = await r.json();
         // Try to map model text into fields expected by the client:
         const text = j?.text || "";
         return cors(200, { theme: text.slice(0, 160) });
      }
  
      // Neutral placeholder response (keeps the app working without errors)
      // Client will fall back to "infer from image".
      return cors(200, { theme: "" });
    } catch (err) {
      return cors(500, { error: err.message || String(err) });
    }
  }
  