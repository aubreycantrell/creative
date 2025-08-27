export const onRequestPost = async ({ request, env }) => {
    try {
      const { imageDataURL, prompt, steps = 30, guidance = 4 } = await request.json();
  
      // Submit edit job to fal queue
      const submit = await fetch("https://queue.fal.run/fal-ai/qwen-image-edit", {
        method: "POST",
        headers: {
          "Authorization": `Key ${env.FAL_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt,
          image_url: imageDataURL,      // data: URL is OK
          num_inference_steps: steps,
          guidance_scale: guidance,
          output_format: "png",
          sync_mode: true               // returns immediately when supported
        })
      });
  
      const submitJson = await submit.json();
  
      // If we already have an image, return it
      if (submitJson?.images?.length) {
        return new Response(JSON.stringify({ url: submitJson.images[0].url }), {
          headers: { "Content-Type": "application/json" }
        });
      }
  
      // Otherwise poll by request_id
      const reqId = submitJson.request_id;
      if (!reqId) throw new Error("No request_id from fal");
  
      const deadline = Date.now() + 30000; // 30s
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        const res = await fetch(`https://queue.fal.run/fal-ai/qwen-image-edit/requests/${reqId}`, {
          headers: { "Authorization": `Key ${env.FAL_KEY}` }
        });
        if (res.ok) {
          const out = await res.json();
          if (out?.images?.length) {
            return new Response(JSON.stringify({ url: out.images[0].url }), {
              headers: { "Content-Type": "application/json" }
            });
          }
        }
      }
      throw new Error("Timeout waiting for fal result");
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  };
  