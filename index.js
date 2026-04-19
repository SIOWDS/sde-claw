// SDEClaw-GCG Cloudflare Worker — Global Premium Edition + Student Cost Tracking
// ================================================================================
// Product: SDEClaw-GCG v0.7 (面向全球开放 · Global Premium Edition)
// Engine : Gemini (E1) + Claude (E2) + GPT (E3) — true GCG triangulation
// Tier   : Internal Team Testing · FULL PREMIUM (Opus 4.7 + GPT-4.1 + Gemini 2.5 Pro)
//          ~ $6-8/paper at top quality, designed for 3-dev × 10-paper internal validation
//          Prompt Caching: Anthropic (explicit), OpenAI & Gemini (automatic) — 15-25% savings
//          Per-person hard limit: $20 (¥140)
// NOT IN GCG: DeepSeek is deliberately excluded from /api/ai (brand purity + compliance)
//
// REQUIRED WORKER BINDINGS (configure in wrangler.toml):
//   - Secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY (DEEPSEEK_API_KEY optional)
//   - KV namespace binding: STUDENTS (for student cost tracking)
//   - Secret: ADMIN_TOKEN (random string; required for /api/admin/* endpoints)
//
// wrangler.toml KV binding example:
//   [[kv_namespaces]]
//   binding = "STUDENTS"
//   id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
//
// ENDPOINTS:
//   /api/ai                       : GCG multi-provider (REQUIRES student_code)
//   /api/deepseek                 : legacy (no student tracking, not called by frontend)
//   /api/health                   : product identity + provider key status
//   /api/student/:code            : public — student self-check their usage
//   /api/admin/students           : POST (create batch) | GET (list all) [admin only]
//   /api/admin/student/:code      : POST (update limits) [admin only]

const DEEPSEEK_URL  = "https://api.deepseek.com/chat/completions";
const OPENAI_URL    = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GEMINI_URL    = "https://generativelanguage.googleapis.com/v1beta/models";

const DEFAULT_MODELS = {
  // ─────────────────────────────────────────────────────────────
  // Internal Team Testing · FULL PREMIUM (current)
  //   All three providers at flagship — no compromise on quality
  //     Claude  : Opus 4.7   (flagship)
  //     OpenAI  : GPT-4.1    (flagship)
  //     Gemini  : 2.5 Pro    (flagship)
  //   Rationale: 3-person internal team + ¥3000 budget → product quality ceiling validation
  //              Identifies whether top-model output is publishable; downgrade decisions later
  //   Per-person budget: $20 (¥140) hard limit, $15 (¥105) soft warning
  //
  //   TIER_MODELS below still works for future per-workstation downgrades post-internal-testing
  // ─────────────────────────────────────────────────────────────
  anthropic: "claude-opus-4-7",    // E2 Reasoning — flagship
  openai:    "gpt-4.1",             // E3 Entanglement — flagship
  gemini:    "gemini-2.5-pro",      // E1 Reality — flagship
  deepseek:  "deepseek-chat",       // legacy, not invoked by frontend
};

const TIER_MODELS = {
  premium:  { anthropic: "claude-opus-4-7",   openai: "gpt-4.1",       gemini: "gemini-2.5-pro"   },
  balanced: { anthropic: "claude-sonnet-4-6", openai: "gpt-4.1",       gemini: "gemini-2.5-pro"   },
  economy:  { anthropic: "claude-sonnet-4-6", openai: "gpt-4.1-mini",  gemini: "gemini-2.5-flash" },
};

const ALLOWED_GCG_PROVIDERS = new Set(["anthropic", "openai", "gemini"]);

// Pricing (USD per 1M tokens, as of 2026)
const PRICING = {
  "claude-opus-4-7":     { input: 15.00, output: 75.00, cache_read: 1.50,  cache_write: 18.75 },
  "claude-sonnet-4-6":   { input: 3.00,  output: 15.00, cache_read: 0.30,  cache_write: 3.75  },
  "claude-haiku-4-5":    { input: 0.80,  output: 4.00,  cache_read: 0.08,  cache_write: 1.00  },
  "gpt-4.1":             { input: 2.00,  output: 8.00,  cache_read: 0.50,  cache_write: 2.00  },
  "gpt-4.1-mini":        { input: 0.40,  output: 1.60,  cache_read: 0.10,  cache_write: 0.40  },
  "gemini-2.5-pro":      { input: 1.25,  output: 10.00, cache_read: 0.31,  cache_write: 1.25  },
  "gemini-2.5-flash":    { input: 0.30,  output: 2.50,  cache_read: 0.075, cache_write: 0.30  },
};

// Student defaults (internal team testing: 3 people × ¥1000 budget → $20 per person hard limit)
const DEFAULT_STUDENT_LIMITS = {
  soft_limit_usd: 15.00,   // warning banner — 75% of hard limit
  hard_limit_usd: 20.00,   // ~¥140 per person; 3 people × $20 = $60 / ¥430 cohort limit
  papers_target:  10,       // 10 papers per internal tester (30 total across 3 devs)
};

// ═══════════════════════════════════════════════════════════════════════
//                          REQUEST ROUTER
// ═══════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === "/api/deepseek" && method === "POST") return handleDeepSeek(request, env);
    if (url.pathname === "/api/ai"       && method === "POST") return handleMultiProvider(request, env);

    if (url.pathname.startsWith("/api/student/") && method === "GET") {
      const code = url.pathname.slice("/api/student/".length);
      return handleStudentQuery(code, env);
    }

    // Student self-mark paper done: POST /api/student/:code/paper-done
    //   No admin token — student with valid code can only +1 their own counter
    if (url.pathname.match(/^\/api\/student\/[^/]+\/paper-done$/) && method === "POST") {
      const code = url.pathname.split("/")[3];
      return handleStudentPaperDone(code, env);
    }

    if (url.pathname === "/api/admin/students" && method === "POST") return handleAdminCreate(request, env);
    if (url.pathname === "/api/admin/students" && method === "GET")  return handleAdminList(request, env);
    if (url.pathname.startsWith("/api/admin/student/") && method === "POST") {
      const code = url.pathname.slice("/api/admin/student/".length);
      return handleAdminUpdate(code, request, env);
    }

    if (url.pathname === "/api/health") return handleHealth(env);

    return env.ASSETS.fetch(request);
  },
};

// ═══════════════════════════════════════════════════════════════════════
//                       STUDENT MANAGEMENT (KV)
// ═══════════════════════════════════════════════════════════════════════

async function getStudent(env, code) {
  if (!env.STUDENTS) return null;
  const raw = await env.STUDENTS.get(`student:${code}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveStudent(env, student) {
  if (!env.STUDENTS) return;
  await env.STUDENTS.put(`student:${student.code}`, JSON.stringify(student));
}

function newStudent(code, name, limits = {}) {
  return {
    code,
    name: name || code,
    created_at: new Date().toISOString(),
    soft_limit_usd: limits.soft_limit_usd ?? DEFAULT_STUDENT_LIMITS.soft_limit_usd,
    hard_limit_usd: limits.hard_limit_usd ?? DEFAULT_STUDENT_LIMITS.hard_limit_usd,
    papers_target:  limits.papers_target  ?? DEFAULT_STUDENT_LIMITS.papers_target,
    total_spent_usd: 0,
    api_calls: 0,
    papers_completed: 0,
    by_provider: { anthropic: 0, openai: 0, gemini: 0 },
    by_tier:     { premium: 0, balanced: 0, economy: 0, default: 0 },
    last_call_at: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//                       COST CALCULATION
// ═══════════════════════════════════════════════════════════════════════

function extractUsage(provider, data) {
  if (provider === "anthropic") {
    const u = data.usage || {};
    return {
      input_tokens:        u.input_tokens || 0,
      output_tokens:       u.output_tokens || 0,
      cache_read_tokens:   u.cache_read_input_tokens || 0,
      cache_write_tokens:  u.cache_creation_input_tokens || 0,
    };
  }
  if (provider === "openai") {
    const u = data.usage || {};
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    return {
      input_tokens:        (u.prompt_tokens || 0) - cached,
      output_tokens:       u.completion_tokens || 0,
      cache_read_tokens:   cached,
      cache_write_tokens:  0,
    };
  }
  if (provider === "gemini") {
    const u = data.usageMetadata || {};
    const cached = u.cachedContentTokenCount || 0;
    return {
      input_tokens:        (u.promptTokenCount || 0) - cached,
      output_tokens:       u.candidatesTokenCount || 0,
      cache_read_tokens:   cached,
      cache_write_tokens:  0,
    };
  }
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
}

function calculateCost(model, usage) {
  const price = PRICING[model];
  if (!price) return 0;
  return (
    (usage.input_tokens       * price.input       +
     usage.output_tokens      * price.output      +
     usage.cache_read_tokens  * price.cache_read  +
     usage.cache_write_tokens * (price.cache_write ?? price.input)) / 1_000_000
  );
}

// ═══════════════════════════════════════════════════════════════════════
//                       MAIN HANDLER (student-aware)
// ═══════════════════════════════════════════════════════════════════════

async function handleMultiProvider(request, env) {
  try {
    const body = await request.json();
    const { provider, model, tier, messages, max_tokens, temperature, student_code } = body || {};

    if (!messages || !Array.isArray(messages)) return jsonError(400, "messages[] required");
    if (!provider || !ALLOWED_GCG_PROVIDERS.has(provider)) {
      return jsonError(400, "provider must be one of: anthropic, openai, gemini");
    }

    // Student validation (only if KV binding exists)
    let student = null;
    if (env.STUDENTS) {
      if (!student_code) {
        return jsonError(401, "student_code required — please enter your invite code in the header");
      }
      student = await getStudent(env, student_code);
      if (!student) return jsonError(403, `Invalid invite code: ${student_code}`);
      if (student.total_spent_usd >= student.hard_limit_usd) {
        return jsonError(402,
          `Hard limit reached: spent $${student.total_spent_usd.toFixed(2)} of $${student.hard_limit_usd.toFixed(2)}. Contact admin to extend.`
        );
      }
    }

    const resolvedModel =
      model
      || (tier && TIER_MODELS[tier]?.[provider])
      || DEFAULT_MODELS[provider];

    // Upstream call
    let upstreamResult;
    switch (provider) {
      case "openai":    upstreamResult = await callOpenAIRaw(env, resolvedModel, messages, max_tokens, temperature); break;
      case "anthropic": upstreamResult = await callAnthropicRaw(env, resolvedModel, messages, max_tokens, temperature); break;
      case "gemini":    upstreamResult = await callGeminiRaw(env, resolvedModel, messages, max_tokens, temperature); break;
    }

    if (upstreamResult.error) {
      return Response.json({ error: { message: upstreamResult.error } }, { status: upstreamResult.status });
    }

    const { data, normalizedResponse } = upstreamResult;

    // Track student usage
    if (student) {
      const usage = extractUsage(provider, data);
      const cost = calculateCost(resolvedModel, usage);

      student.total_spent_usd += cost;
      student.api_calls += 1;
      student.by_provider[provider] = (student.by_provider[provider] || 0) + cost;
      const tierKey = tier || "default";
      student.by_tier[tierKey] = (student.by_tier[tierKey] || 0) + cost;
      student.last_call_at = new Date().toISOString();

      await saveStudent(env, student);

      normalizedResponse.student_status = {
        spent_usd: +student.total_spent_usd.toFixed(4),
        hard_limit_usd: student.hard_limit_usd,
        soft_limit_usd: student.soft_limit_usd,
        remaining_usd: +(student.hard_limit_usd - student.total_spent_usd).toFixed(4),
        warning: student.total_spent_usd >= student.soft_limit_usd,
        call_cost_usd: +cost.toFixed(4),
      };
    }

    return Response.json(normalizedResponse);
  } catch (e) {
    return jsonError(500, e.message || "proxy error");
  }
}

// ═══════════════════════════════════════════════════════════════════════
//                       PROVIDER CALLS (RAW)
// ═══════════════════════════════════════════════════════════════════════

async function callOpenAIRaw(env, model, messages, max_tokens, temperature) {
  if (!env.OPENAI_API_KEY) return { error: "OPENAI_API_KEY not configured", status: 500 };
  const upstream = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, messages,
      max_tokens: max_tokens || 4000,
      temperature: typeof temperature === "number" ? temperature : 0.7,
    }),
  });
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    return { error: `OpenAI ${upstream.status}: ${t.slice(0, 400)}`, status: upstream.status };
  }
  const data = await upstream.json();
  return { data, normalizedResponse: data };
}

async function callAnthropicRaw(env, model, messages, max_tokens, temperature) {
  if (!env.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not configured", status: 500 };

  const systemMsgs = messages.filter(m => m.role === "system");
  const convoMsgs  = messages.filter(m => m.role !== "system").map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));
  const systemCombined = systemMsgs.map(m => m.content).join("\n\n");
  const systemBlock = systemCombined
    ? [{ type: "text", text: systemCombined, cache_control: { type: "ephemeral" } }]
    : undefined;

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      system: systemBlock,
      messages: convoMsgs,
      max_tokens: max_tokens || 4000,
      temperature: typeof temperature === "number" ? temperature : 0.7,
    }),
  });
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    return { error: `Anthropic ${upstream.status}: ${t.slice(0, 400)}`, status: upstream.status };
  }
  const data = await upstream.json();
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const normalizedResponse = {
    id: data.id,
    model: data.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: data.stop_reason }],
    usage: data.usage,
  };
  return { data, normalizedResponse };
}

async function callGeminiRaw(env, model, messages, max_tokens, temperature) {
  if (!env.GEMINI_API_KEY) return { error: "GEMINI_API_KEY not configured", status: 500 };

  const systemMsgs = messages.filter(m => m.role === "system");
  const convoMsgs  = messages.filter(m => m.role !== "system");
  const systemCombined = systemMsgs.map(m => m.content).join("\n\n");
  const contents = convoMsgs.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const url = `${GEMINI_URL}/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: systemCombined ? { parts: [{ text: systemCombined }] } : undefined,
      generationConfig: {
        maxOutputTokens: max_tokens || 4000,
        temperature: typeof temperature === "number" ? temperature : 0.7,
      },
    }),
  });
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    return { error: `Gemini ${upstream.status}: ${t.slice(0, 400)}`, status: upstream.status };
  }
  const data = await upstream.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  const normalizedResponse = {
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: data.candidates?.[0]?.finishReason }],
    usage: data.usageMetadata,
  };
  return { data, normalizedResponse };
}

// Legacy DeepSeek handler (unchanged, no student tracking)
async function handleDeepSeek(request, env) {
  if (!env.DEEPSEEK_API_KEY) return jsonError(500, "DEEPSEEK_API_KEY not configured");
  try {
    const body = await request.json();
    const { model, messages, max_tokens, temperature, stream } = body || {};
    if (!messages || !Array.isArray(messages)) return jsonError(400, "messages[] required");
    const upstream = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || DEFAULT_MODELS.deepseek,
        messages,
        max_tokens: max_tokens || 4000,
        temperature: typeof temperature === "number" ? temperature : 0.7,
        stream: !!stream,
      }),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") || "application/json" },
    });
  } catch (e) {
    return jsonError(500, e.message || "proxy error");
  }
}

// ═══════════════════════════════════════════════════════════════════════
//                       STUDENT & ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

async function handleStudentQuery(code, env) {
  if (!env.STUDENTS) return jsonError(500, "STUDENTS KV binding not configured");
  const student = await getStudent(env, code);
  if (!student) return jsonError(404, "Student not found");

  return Response.json({
    code: student.code,
    name: student.name,
    created_at: student.created_at,
    total_spent_usd: +student.total_spent_usd.toFixed(4),
    soft_limit_usd: student.soft_limit_usd,
    hard_limit_usd: student.hard_limit_usd,
    remaining_usd:  +(student.hard_limit_usd - student.total_spent_usd).toFixed(4),
    warning: student.total_spent_usd >= student.soft_limit_usd,
    blocked: student.total_spent_usd >= student.hard_limit_usd,
    api_calls: student.api_calls,
    papers_completed: student.papers_completed || 0,
    papers_target: student.papers_target,
    by_provider: student.by_provider,
    by_tier: student.by_tier,
    last_call_at: student.last_call_at,
  });
}

// Student self-mark paper completion.
// No admin required — possessing the code lets you +1 your own counter (low-risk op).
async function handleStudentPaperDone(code, env) {
  if (!env.STUDENTS) return jsonError(500, "STUDENTS KV binding not configured");
  const student = await getStudent(env, code);
  if (!student) return jsonError(404, "Student not found");

  student.papers_completed = (student.papers_completed || 0) + 1;
  await saveStudent(env, student);

  return Response.json({
    code: student.code,
    papers_completed: student.papers_completed,
    papers_target: student.papers_target,
    progress_pct: student.papers_target ? Math.round(100 * student.papers_completed / student.papers_target) : 0,
  });
}

function requireAdmin(request, env) {
  const token = request.headers.get("x-admin-token");
  if (!env.ADMIN_TOKEN) return "ADMIN_TOKEN not configured on server";
  if (token !== env.ADMIN_TOKEN) return "Invalid admin token";
  return null;
}

async function handleAdminCreate(request, env) {
  const err = requireAdmin(request, env);
  if (err) return jsonError(401, err);
  if (!env.STUDENTS) return jsonError(500, "STUDENTS KV binding not configured");

  try {
    const body = await request.json();
    const list = body?.students;
    if (!Array.isArray(list)) return jsonError(400, "students[] required");

    const created = [];
    const skipped = [];
    for (const s of list) {
      if (!s.code) { skipped.push({ ...s, reason: "missing code" }); continue; }
      const existing = await getStudent(env, s.code);
      if (existing) { skipped.push({ ...s, reason: "already exists" }); continue; }
      const student = newStudent(s.code, s.name, {
        soft_limit_usd: s.soft_limit_usd,
        hard_limit_usd: s.hard_limit_usd,
        papers_target:  s.papers_target,
      });
      await saveStudent(env, student);
      created.push(student.code);
    }
    return Response.json({ created, skipped });
  } catch (e) {
    return jsonError(500, e.message);
  }
}

async function handleAdminList(request, env) {
  const err = requireAdmin(request, env);
  if (err) return jsonError(401, err);
  if (!env.STUDENTS) return jsonError(500, "STUDENTS KV binding not configured");

  const list = await env.STUDENTS.list({ prefix: "student:" });
  const students = [];
  let totalSpent = 0;
  for (const { name: key } of list.keys) {
    const raw = await env.STUDENTS.get(key);
    if (!raw) continue;
    try {
      const s = JSON.parse(raw);
      totalSpent += s.total_spent_usd || 0;
      students.push({
        code: s.code,
        name: s.name,
        spent_usd: +(s.total_spent_usd || 0).toFixed(4),
        hard_limit_usd: s.hard_limit_usd,
        papers_completed: s.papers_completed || 0,
        api_calls: s.api_calls,
        last_call_at: s.last_call_at,
      });
    } catch {}
  }
  return Response.json({
    total_students: students.length,
    cohort_total_spent_usd: +totalSpent.toFixed(2),
    students: students.sort((a, b) => b.spent_usd - a.spent_usd),
  });
}

async function handleAdminUpdate(code, request, env) {
  const err = requireAdmin(request, env);
  if (err) return jsonError(401, err);
  if (!env.STUDENTS) return jsonError(500, "STUDENTS KV binding not configured");

  const student = await getStudent(env, code);
  if (!student) return jsonError(404, "Student not found");

  try {
    const body = await request.json();
    if (typeof body.soft_limit_usd === "number") student.soft_limit_usd = body.soft_limit_usd;
    if (typeof body.hard_limit_usd === "number") student.hard_limit_usd = body.hard_limit_usd;
    if (typeof body.papers_target  === "number") student.papers_target  = body.papers_target;
    if (typeof body.papers_completed === "number") student.papers_completed = body.papers_completed;
    if (body.increment_papers) student.papers_completed = (student.papers_completed || 0) + 1;
    if (body.reset_spent) student.total_spent_usd = 0;
    if (body.name) student.name = body.name;

    await saveStudent(env, student);
    return Response.json(student);
  } catch (e) {
    return jsonError(500, e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//                       HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════

async function handleHealth(env) {
  return Response.json({
    ok: true,
    product: "SDEClaw-GCG",
    version: "v0.7",
    edition: "Internal Team Testing · FULL PREMIUM (Opus 4.7 + GPT-4.1 + Gemini 2.5 Pro)",
    tier: "full_premium",
    endpoints: {
      "/api/ai":                  "GCG multi-provider with student tracking",
      "/api/deepseek":            "legacy, not called by frontend",
      "/api/student/:code":             "public — student self-check",
      "/api/student/:code/paper-done":  "public — student mark paper completed (POST)",
      "/api/admin/students":      "admin — POST create batch | GET list all",
      "/api/admin/student/:code": "admin — POST update limits or increment papers",
    },
    gcg_providers: {
      anthropic: { role: "E2 Reasoning",    configured: !!env.ANTHROPIC_API_KEY, default_model: DEFAULT_MODELS.anthropic },
      openai:    { role: "E3 Entanglement", configured: !!env.OPENAI_API_KEY,    default_model: DEFAULT_MODELS.openai    },
      gemini:    { role: "E1 Reality",      configured: !!env.GEMINI_API_KEY,    default_model: DEFAULT_MODELS.gemini    },
    },
    student_tracking: {
      kv_binding_configured: !!env.STUDENTS,
      admin_token_configured: !!env.ADMIN_TOKEN,
      default_limits: DEFAULT_STUDENT_LIMITS,
    },
    prompt_caching: {
      anthropic: "explicit · 90% input discount on hit",
      openai:    "automatic ≥1024 tokens · 50% discount",
      gemini:    "automatic Gemini 2.5 · ~75% discount",
    },
    default_models: DEFAULT_MODELS,
    tier_models: TIER_MODELS,
    time: new Date().toISOString(),
  });
}

function jsonError(status, message) {
  return Response.json({ error: { message } }, { status });
}
