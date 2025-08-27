export async function onRequestPost({ request, env }) {
    try {
      const { imageDataURL, prompt, steps = 28, guidance = 4 } = await request.json();
  
      // send to fal
      const submit = await fetch("https://queue.fal.run/fal-ai/qwen-image-edit", {
        method: "POST",
        headers: {
          "Authorization": `Key ${env.FAL_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt,
          image_url: imageDataURL,   // fal expects "image_url"
          num_inference_steps: steps,
          guidance_scale: guidance,
          output_format: "png",
          sync_mode: true            // try to get result immediately
        })
      });
  
      const submitJson = await submit.json();
  
      // Case A: immediate image response
      if (submitJson?.images?.length) {
        return new Response(JSON.stringify({ url: submitJson.images[0].url }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
  
      // Case B: poll with request_id
      const reqId = submitJson.request_id;
      if (!reqId) {
        throw new Error("No request_id or images from fal");
      }
  
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        const res = await fetch(`https://queue.fal.run/fal-ai/qwen-image-edit/requests/${reqId}`, {
          headers: { "Authorization": `Key ${env.FAL_KEY}` }
        });
        const out = await res.json();
        if (out?.images?.length) {
          return new Response(JSON.stringify({ url: out.images[0].url }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }
      }
  
      throw new Error("Timeout waiting for fal result");
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
  
  