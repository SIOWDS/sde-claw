// SDE-Claw Cloudflare Worker
// - Serves React SPA via ASSETS binding (static files under /dist)
// - Proxies /api/deepseek to DeepSeek API (key from Worker Secrets)

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // === API route: DeepSeek proxy ===
    if (url.pathname === "/api/deepseek" && request.method === "POST") {
      return handleDeepSeek(request, env);
    }

    // === API route: health check ===
    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        model_default: "deepseek-chat",
        has_key: !!env.DEEPSEEK_API_KEY,
        time: new Date().toISOString(),
      });
    }

    // === Everything else: static assets (handled by SPA config in wrangler.toml) ===
    return env.ASSETS.fetch(request);
  },
};

async function handleDeepSeek(request, env) {
  if (!env.DEEPSEEK_API_KEY) {
    return Response.json(
      { error: { message: "DEEPSEEK_API_KEY not configured on server" } },
      { status: 500 }
    );
  }

  try {
    const body = await request.json();
    const { model, messages, max_tokens, temperature, stream } = body || {};

    if (!messages || !Array.isArray(messages)) {
      return Response.json(
        { error: { message: "messages[] required" } },
        { status: 400 }
      );
    }

    const upstream = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "deepseek-chat",
        messages,
        max_tokens: max_tokens || 4000,
        temperature: typeof temperature === "number" ? temperature : 0.7,
        stream: !!stream,
      }),
    });

    // Pass through status + body
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch (e) {
    return Response.json(
      { error: { message: e.message || "proxy error" } },
      { status: 500 }
    );
  }
}
