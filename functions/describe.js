// functions/describe.js  — Cloudflare Pages Function for image description
// Returns JSON: { caption: string, keywords: string[] }

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
      const { imageDataURL, extraPrompt } = await request.json();
      if (!imageDataURL) return cors(400, { error: "imageDataURL required" });
  
      // If no API key, return a benign empty result so UI can fall back gracefully.
      if (!env.FAL_KEY) return cors(200, { caption: "", keywords: [] });
  
      // ---- helpers ----
      const dataURLtoBlob = (dataURL) => {
        const m = /^data:(.*?);base64,(.*)$/.exec(dataURL);
        if (!m) throw new Error("Invalid data URL");
        const mime = m[1] || "application/octet-stream";
        const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
        return new Blob([bin], { type: mime });
      };
  
      // Build multipart body so we don't need a public URL
      const form = new FormData();
      form.append(
        "prompt",
        [
          // keep it short + structured so we can parse reliably
          "Describe the main subject in ONE short sentence.",
          "Then on a new line write: Keywords: five lower-case nouns or activities, comma-separated.",
          extraPrompt ? `Context: ${extraPrompt}` : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      form.append("image", dataURLtoBlob(imageDataURL), "image.jpg");
  
      // Use a general vision-captioning model on FAL; change path if you prefer another
      const submit = await fetch("https://queue.fal.run/fal-ai/llava-next", {
        method: "POST",
        headers: { Authorization: `Key ${env.FAL_KEY}` },
        body: form,
      });
  
      const ct = submit.headers.get("content-type") || "";
      if (!submit.ok) {
        const errText = ct.includes("application/json")
          ? JSON.stringify(await submit.json())
          : await submit.text();
        return cors(submit.status, { error: `FAL error: ${errText}` });
      }
  
      const submitJson = ct.includes("application/json") ? await submit.json() : {};
  
      // Case A: some endpoints respond immediately with text
      let text =
        submitJson.output_text ||
        submitJson.text ||
        submitJson.result ||
        (Array.isArray(submitJson.choices) && submitJson.choices[0]?.text) ||
        "";
  
      // Case B: queued → poll with request_id
      if (!text && submitJson.request_id) {
        const waitMs = Number(env.FAL_WAIT_MS || 45000);
        const deadline = Date.now() + waitMs;
  
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          const res = await fetch(
            `https://queue.fal.run/fal-ai/llava-next/requests/${submitJson.request_id}`,
            { headers: { Authorization: `Key ${env.FAL_KEY}` } }
          );
          const out = await res.json();
          if (out?.error) return cors(500, { error: `FAL queued error: ${out.error}` });
  
          text =
            out.output_text ||
            out.text ||
            out.result ||
            (Array.isArray(out.choices) && out.choices[0]?.text) ||
            "";
  
          if (text) break;
        }
  
        if (!text) return cors(504, { error: "Timeout waiting for FAL result." });
      }
  
      // Robust parsing: extract "Keywords: a, b, c" if present
      const m = /keywords:\s*([^\n]+)/i.exec(text || "");
      let keywords = (m ? m[1] : "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8);
  
      // Caption = first line before Keywords:
      let caption = (text || "").split(/keywords:/i)[0]?.trim() || "";
  
      // Fallbacks if model didn't follow the format
      if (!caption) {
        caption = (text || "").split("\n")[0].trim();
      }
      if (keywords.length === 0) {
        // naive fallback keyworder: pick distinct words >3 chars from caption
        const seen = new Set();
        for (const w of caption.toLowerCase().split(/[^a-z0-9]+/g)) {
          if (w.length > 3 && !seen.has(w)) {
            seen.add(w);
          }
        }
        keywords = Array.from(seen).slice(0, 5);
      }
  
      return cors(200, { caption, keywords });
    } catch (err) {
      return cors(500, { error: err.message || String(err) });
    }
  }
  