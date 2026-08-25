import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const envFile = path.join(rootDir, ".env");

await loadEnvFile();

const PORT = Number(process.env.PORT || 4180);
const ADMIN_TOKEN = process.env.CLASSFLOW_ADMIN_TOKEN || "";
const BRANDING_ADMIN_PIN = process.env.BRANDING_ADMIN_PIN || "1234";
const DEFAULT_ACTIVATION_MONTHS = Number(process.env.CLASSFLOW_DEFAULT_ACTIVATION_MONTHS || 6);
const DEFAULT_MONTHLY_QNA_LIMIT = Number(process.env.CLASSFLOW_DEFAULT_MONTHLY_QNA_LIMIT || 60);
const FAKE_AI_ENABLED = process.env.CLASSFLOW_FAKE_AI === "true";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const QNA_PROMPT_VERSION = "classroom-v4";
const SERVER_VERSION = "0.1.1";
const DATABASE_URL = process.env.DATABASE_URL || "";
const DATABASE_SSL = process.env.CLASSFLOW_DATABASE_SSL === "true";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Add PostgreSQL on Railway and set DATABASE_URL before starting the server.");
}

if (!ADMIN_TOKEN || ADMIN_TOKEN === "change-this-admin-token") {
  throw new Error("CLASSFLOW_ADMIN_TOKEN must be set to a private value before starting the server.");
}

const { Pool } = pg;
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined
});

await ensureStorage();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(res, status, {
      ok: false,
      error: error instanceof HttpError ? error.code : "SERVER_ERROR",
      message: error.message
    });
  }
});

server.listen(PORT, () => {
  console.log(`Class Flow Cloud Server running on http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin`);
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    sendCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendJson(res, 200, {
      ok: true,
      service: "Class Flow Cloud Server",
      version: SERVER_VERSION,
      admin: "/admin"
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      status: "healthy",
      time: new Date().toISOString(),
      version: SERVER_VERSION,
      aiProvider: aiProviderName(),
      storage: "postgresql"
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin") {
    sendHtml(res, renderAdminPage());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    const body = await readJsonBody(req);
    const result = await registerSchool(body);
    sendJson(res, 201, { ok: true, school: result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/activation/check") {
    const body = await readJsonBody(req);
    const result = await checkActivation(body.schoolId, body.deviceId);
    sendJson(res, 200, { ok: true, activation: result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/branding/verify") {
    const body = await readJsonBody(req);
    const pin = String(body.pin || "").trim();
    if (!/^\d{4}$/.test(pin) || pin !== BRANDING_ADMIN_PIN) {
      throw new HttpError(401, "INVALID_PIN", "Wrong PIN");
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/qna/request") {
    const body = await readJsonBody(req);
    const result = await requestQna(body);
    const status = result.available ? 200 : 404;
    sendJson(res, status, { ok: result.available, ...result });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/qna/upload") {
    const body = await readJsonBody(req, 18 * 1024 * 1024);
    const result = await requestQnaFromPdf(body);
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/schools") {
    requireAdmin(req);
    const schools = await schoolsWithUsage();
    sendJson(res, 200, { ok: true, schools });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/schools.csv") {
    requireAdmin(req);
    const schools = await schoolsWithUsage();
    sendText(res, 200, schoolsCsv(schools), "text/csv; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/config") {
    requireAdmin(req);
    sendJson(res, 200, {
      ok: true,
      config: {
        port: PORT,
        version: SERVER_VERSION,
        defaultActivationMonths: DEFAULT_ACTIVATION_MONTHS,
        defaultMonthlyQnaLimit: DEFAULT_MONTHLY_QNA_LIMIT,
        aiProvider: aiProviderName(),
        storage: "postgresql"
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/usage") {
    requireAdmin(req);
    const usage = await listUsage();
    sendJson(res, 200, { ok: true, usage });
    return;
  }

  const schoolAction = url.pathname.match(/^\/api\/admin\/schools\/([^/]+)\/([^/]+)$/);
  if (req.method === "POST" && schoolAction) {
    requireAdmin(req);
    const body = await readJsonBody(req);
    const result = await updateSchool(schoolAction[1], schoolAction[2], body);
    sendJson(res, 200, { ok: true, school: result });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/admin/qna") {
    requireAdmin(req);
    const body = await readJsonBody(req);
    const result = await saveQna(body);
    sendJson(res, 200, { ok: true, qna: result });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/qna") {
    requireAdmin(req);
    if ([...url.searchParams.keys()].length === 0) {
      const qna = await listQna();
      sendJson(res, 200, { ok: true, qna });
    } else {
      const chapter = chapterFromSearch(url.searchParams);
      const result = await getQna(chapter);
      sendJson(res, result ? 200 : 404, {
        ok: Boolean(result),
        available: Boolean(result),
        qna: result
      });
    }
    return;
  }

  const qnaDelete = url.pathname.match(/^\/api\/admin\/qna\/([a-f0-9]{32})$/);
  if (req.method === "DELETE" && qnaDelete) {
    requireAdmin(req);
    await deleteQna(qnaDelete[1]);
    sendJson(res, 200, { ok: true, deleted: qnaDelete[1] });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: "NOT_FOUND"
  });
}

async function registerSchool(input) {
  const required = ["schoolName", "state", "district"];
  for (const field of required) {
    if (!String(input[field] || "").trim()) {
      throw new HttpError(400, "VALIDATION_ERROR", `${field} is required`);
    }
  }

  const now = new Date();
  const deviceId = clean(input.deviceId);
  const existing = deviceId ? await findSchoolByPanelDeviceId(deviceId) : null;
  if (existing) {
    const updated = await upsertSchool({
      ...existing,
      schoolName: clean(input.schoolName) || existing.schoolName,
      state: clean(input.state) || existing.state,
      district: clean(input.district) || existing.district,
      contactPerson: clean(input.contactPerson) || existing.contactPerson,
      mobile: clean(input.mobile) || existing.mobile,
      email: clean(input.email) || existing.email,
      appVersion: clean(input.appVersion) || existing.appVersion,
      contentVersion: clean(input.contentVersion) || existing.contentVersion,
      updatedAt: now.toISOString()
    });
    return publicSchool(updated);
  }

  const schoolId = `CF-${now.getFullYear()}-${randomCode(6)}`;
  const activationStart = now.toISOString();
  const activationExpires = addMonths(now, DEFAULT_ACTIVATION_MONTHS).toISOString();

  const school = {
    schoolId,
    schoolName: clean(input.schoolName),
    state: clean(input.state),
    district: clean(input.district),
    contactPerson: clean(input.contactPerson),
    mobile: clean(input.mobile),
    email: clean(input.email),
    deviceId,
    appVersion: clean(input.appVersion),
    contentVersion: clean(input.contentVersion),
    status: "active",
    activationStart,
    activationExpires,
    qnaMonthlyLimit: Number(input.qnaMonthlyLimit || DEFAULT_MONTHLY_QNA_LIMIT),
    createdAt: activationStart,
    updatedAt: activationStart
  };

  return publicSchool(await upsertSchool(school));
}

async function checkActivation(schoolId, deviceId = "") {
  const school = await findSchool(schoolId);
  const now = new Date();
  const expires = new Date(school.activationExpires);
  const active = school.status === "active" && expires >= now;

  if (school.deviceId && deviceId && school.deviceId !== deviceId) {
    return {
      schoolId,
      active: false,
      reason: "DEVICE_MISMATCH",
      activationExpires: school.activationExpires,
      status: school.status
    };
  }

  return {
    schoolId,
    panelDeviceId: school.deviceId,
    active,
    reason: active ? "ACTIVE" : school.status === "blocked" ? "BLOCKED" : "EXPIRED",
    activationExpires: school.activationExpires,
    status: school.status,
    appVersion: school.appVersion,
    contentVersion: school.contentVersion
  };
}

async function requestQna(input) {
  const school = await findSchool(input.schoolId);
  const activation = await checkActivation(input.schoolId, input.deviceId);
  if (!activation.active) {
    throw new HttpError(403, "ACTIVATION_INACTIVE", activation.reason);
  }

  const chapter = normalizeChapter(input.chapter || input);
  chapter.chapterText = clean(input.chapterText || input.text || input.chapter?.chapterText).slice(0, 24000);
  const cached = await getQna(chapter);
  if (cached) {
    return {
      available: true,
      source: "cache",
      counted: false,
      qna: cached
    };
  }

  const usage = await getUsageForPanel(school, input.deviceId);
  if (usage.generatedCount >= school.qnaMonthlyLimit) {
    throw new HttpError(429, "QNA_LIMIT_REACHED", "Monthly Q&A generation limit reached for this panel");
  }

  const generated = await generateQna(chapter);
  if (generated) {
    await saveQna({
      chapter,
      items: generated.items,
      notes: generated.notes,
      generatedBy: generated.generatedBy
    });
    await recordQnaGeneration(school, input.deviceId, chapter);
    const saved = await getQna(chapter);
    const updatedUsage = await getUsageForPanel(school, input.deviceId);
    return {
      available: true,
      source: "generated",
      counted: true,
      monthlyLimit: school.qnaMonthlyLimit,
      monthlyUsed: updatedUsage.generatedCount,
      qna: saved
    };
  }

  return {
    available: false,
    error: "QNA_NOT_FOUND",
    message: "Q&A is not cached yet. AI generation is ready to connect on the server.",
    schoolId: school.schoolId,
    monthlyLimit: school.qnaMonthlyLimit,
    monthlyUsed: usage.generatedCount,
    aiConfigured: Boolean(GROQ_API_KEY) || Boolean(GEMINI_API_KEY) || FAKE_AI_ENABLED,
    aiProvider: aiProviderName(),
    cacheKey: qnaKey(chapter),
    chapter
  };
}

async function requestQnaFromPdf(input) {
  const school = await findSchool(input.schoolId);
  const activation = await checkActivation(input.schoolId, input.deviceId);
  if (!activation.active) {
    throw new HttpError(403, "ACTIVATION_INACTIVE", activation.reason);
  }

  const chapter = normalizeChapter(input.chapter || input);
  const cached = await getQna(chapter);
  if (cached) {
    return {
      available: true,
      source: "cache",
      counted: false,
      qna: cached
    };
  }

  const usage = await getUsageForPanel(school, input.deviceId);
  if (usage.generatedCount >= school.qnaMonthlyLimit) {
    throw new HttpError(429, "QNA_LIMIT_REACHED", "Monthly Q&A generation limit reached for this panel");
  }

  if (!input.pdfBase64) {
    throw new HttpError(400, "PDF_REQUIRED", "pdfBase64 is required when Q&A is not cached");
  }

  const pdfBuffer = Buffer.from(String(input.pdfBase64), "base64");
  if (pdfBuffer.length > 12 * 1024 * 1024) {
    throw new HttpError(413, "PDF_TOO_LARGE", "PDF upload is too large");
  }

  const parser = new PDFParse({ data: pdfBuffer });
  const parsed = await parser.getText();
  await parser.destroy();
  const text = clean(parsed.text).slice(0, 24000);
  if (text.length < 100) {
    throw new HttpError(422, "PDF_TEXT_NOT_FOUND", "Could not extract enough text from this PDF");
  }

  return await requestQna({
    schoolId: input.schoolId,
    deviceId: input.deviceId,
    chapter,
    chapterText: text
  });
}

async function generateQna(chapter) {
  const errors = [];
  if (GROQ_API_KEY) {
    try {
      return await generateQnaWithGroq(chapter);
    } catch (error) {
      errors.push(error);
      if (!GEMINI_API_KEY && !FAKE_AI_ENABLED) throw error;
    }
  }

  if (GEMINI_API_KEY) {
    try {
      return await generateQnaWithGemini(chapter);
    } catch (error) {
      errors.push(error);
      if (!FAKE_AI_ENABLED) throw error;
    }
  }

  if (!FAKE_AI_ENABLED) {
    return null;
  }

  return {
    generatedBy: "local-test-generator",
    notes: errors.length
      ? "Fallback test generation after AI provider error. Do not use for production classroom quality."
      : "Test generation only. Replace this with a real free AI provider later.",
    items: fakeQnaItems(chapter)
  };
}

function fakeQnaItems(chapter) {
  const count = targetQuestionCount(chapter);
  const base = [
    ["short", `What is the main topic of ${chapter.chapter}?`, `${chapter.chapter} is the selected lesson or PDF topic for classroom discussion.`],
    ["short", `How can a teacher use ${chapter.chapter} in class?`, "The teacher can use it for explanation, revision, oral questions, and short written practice."],
    ["fill", `${chapter.chapter} is useful for classroom ___.`, "revision"],
    ["true-false", `${chapter.chapter} can be discussed through questions and answers. (True/False)`, "True"],
    ["short", `Why should students discuss ${chapter.chapter}?`, "Discussion helps students recall ideas and explain them in their own words."],
    ["higher-order", `How can students connect ${chapter.chapter} with daily life?`, "They can share examples from home, school, or their surroundings."],
    ["short", `What should a teacher check after teaching ${chapter.chapter}?`, "The teacher should check whether students understood key ideas and can answer simple questions."],
    ["true-false", `Only reading silently is enough to understand every chapter. (True/False)`, "False"],
    ["short", `What is one classroom activity for ${chapter.chapter}?`, "Students can answer oral questions, write short answers, or explain examples."],
    ["higher-order", `Why are follow-up questions helpful after ${chapter.chapter}?`, "They help students think deeper and correct misunderstandings."]
  ];
  return base.slice(0, count).map(([type, question, answer]) => ({
    type,
    question,
    answer,
    explanation: "This is a local test item.\nIt checks the Q&A flow without using online AI.\nUse server AI for final classroom quality."
  }));
}

async function generateQnaWithGroq(chapter) {
  const desiredCount = targetQuestionCount(chapter);
  const attempts = [
    { strictJson: true, retry: false },
    { strictJson: false, retry: false },
    { strictJson: false, retry: true }
  ];
  let lastError = null;

  for (const attempt of attempts) {
    try {
      const response = await fetchJson("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(groqRequestBody(chapter, attempt.strictJson, attempt.retry))
      });
      const text = response?.choices?.[0]?.message?.content || "";
      return generatedQnaFromText(text, `groq:${GROQ_MODEL}`, desiredCount);
    } catch (error) {
      lastError = error;
      const message = String(error.message || "").toLowerCase();
      if (!message.includes("json") && !message.includes("too few")) throw error;
    }
  }

  throw lastError || new HttpError(502, "AI_BAD_RESPONSE", "AI did not return enough usable Q&A");
}

function groqRequestBody(chapter, strictJson, retry = false) {
  const body = {
    model: GROQ_MODEL,
    temperature: strictJson ? 0.2 : 0.35,
    messages: [
      {
        role: "system",
        content: "You create school classroom revision questions. Return one JSON object only. Do not use markdown."
      },
      {
        role: "user",
        content: qnaPrompt(chapter, retry)
      }
    ]
  };
  if (strictJson) {
    body.response_format = { type: "json_object" };
  }
  return body;
}

async function generateQnaWithGemini(chapter) {
  const desiredCount = targetQuestionCount(chapter);
  const response = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: qnaPrompt(chapter, false) }]
          }
        ],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: "application/json"
        }
      })
    }
  );

  const text = response?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();
  return generatedQnaFromText(text, `gemini:${GEMINI_MODEL}`, desiredCount);
}

function targetQuestionCount(chapter) {
  return Math.max(6, Math.min(15, Number(chapter.questionCount || 10)));
}

function minimumQuestionCount(questionCount) {
  if (questionCount <= 6) return 5;
  if (questionCount <= 10) return 8;
  return 12;
}

function qnaPrompt(chapter, retry = false) {
  const questionCount = targetQuestionCount(chapter);
  const style = String(chapter.difficulty || "balanced").toLowerCase();
  const styleLine = style === "easy"
    ? "Use simple recall and understanding questions suitable for quick classroom participation."
    : style === "exam"
      ? "Use exam-practice style questions with clear wording, textbook-specific facts, and a few higher-order questions."
      : "Use a balanced mix of recall, understanding, application, and classroom discussion questions.";
  const lines = [
    "Generate classroom questions and answers for a teacher.",
    retry ? "The previous response had too few questions. This time return the full requested count." : "",
    "Return only valid JSON with this exact shape:",
    "{\"items\":[{\"type\":\"short\",\"question\":\"...\",\"answer\":\"...\",\"explanation\":\"...\"}]}",
    "Do not wrap the JSON in markdown fences.",
    "Do not add any text before or after the JSON object.",
    `Create exactly ${questionCount} items total.`,
    `The items array must contain ${questionCount} complete question objects. Do not return fewer items.`,
    "Use a suitable mix of short answer, MCQ, fill in the blank, true/false, and higher-order questions.",
    "For MCQ, include options array with 4 options and answer as the correct option text.",
    "MCQ option strings must not include labels like A., B., C., D., or numbering. Put only the option text.",
    "For true/false items, write the question as a clear statement ending with (True/False), and set answer to True or False.",
    "Keep answers concise and suitable for classroom reveal.",
    "For every item, include an explanation field with 2-5 simple teacher-friendly lines.",
    "The explanation should help the teacher explain why the answer is correct, and include a small classroom hint or example when useful.",
    "Avoid one-word or one-sentence explanations except for very simple true/false facts.",
    styleLine,
    "Do not translate from another language. Use the supplied chapter text and its language style when chapter text is provided.",
    "Use only the supplied chapter text for textbook-specific facts. If chapter text is not provided, create only general revision questions based on the title and do not invent textbook-specific facts.",
    "",
    "Chapter details:",
    `Board: ${chapter.board}`,
    `Class/Folder: ${chapter.className}`,
    `Subject: ${chapter.subject}`,
    `Book/PDF: ${chapter.book}`,
    `Chapter/PDF: ${chapter.chapter}`,
    `Language: ${chapter.language}`,
    `Question style: ${chapter.difficulty}`,
    `Question count: ${questionCount}`
  ];
  if (chapter.chapterText) {
    lines.push("", "Chapter text:", chapter.chapterText);
  }
  return lines.filter((line) => line !== "").join("\n");
}

function generatedQnaFromText(text, generatedBy, desiredCount = 10) {
  const parsed = parseJsonFromText(text);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  if (!items.length) {
    throw new HttpError(502, "AI_BAD_RESPONSE", "AI did not return usable Q&A");
  }
  const usableItems = items.map((item) => ({
    type: clean(item.type || "short"),
    question: clean(item.question),
    answer: clean(item.answer),
    explanation: clean(item.explanation),
    options: Array.isArray(item.options) ? item.options.map(clean).filter(Boolean).slice(0, 6) : undefined
  })).filter((item) => item.question && item.answer);

  const minimumCount = minimumQuestionCount(desiredCount);
  if (usableItems.length < minimumCount) {
    throw new HttpError(502, "AI_BAD_RESPONSE_TOO_FEW", `AI returned too few questions (${usableItems.length}/${desiredCount})`);
  }

  return {
    generatedBy,
    notes: "Generated by server-side AI and cached for reuse.",
    items: usableItems.slice(0, desiredCount),
    contentGrounded: true
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(502, "AI_PROVIDER_ERROR", text.slice(0, 300));
  }
  return JSON.parse(text);
}

function parseJsonFromText(text = "") {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonText = extractJsonObject(cleaned);
    if (!jsonText) return null;
    try {
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  }
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return "";
}

function aiProviderName() {
  if (GROQ_API_KEY) return `groq:${GROQ_MODEL}`;
  if (GEMINI_API_KEY) return `gemini:${GEMINI_MODEL}`;
  if (FAKE_AI_ENABLED) return "local-test-generator";
  return "not-configured";
}

async function updateSchool(schoolId, action, body) {
  const school = await findSchool(schoolId);
  if (action === "extend") {
    const baseDate = new Date(school.activationExpires) > new Date()
      ? new Date(school.activationExpires)
      : new Date();
    if (body.expiresAt) {
      school.activationExpires = new Date(body.expiresAt).toISOString();
    } else if (body.days) {
      school.activationExpires = addDays(baseDate, Number(body.days)).toISOString();
    } else {
      school.activationExpires = addMonths(baseDate, Number(body.months || 6)).toISOString();
    }
    school.status = "active";
  } else if (action === "block") {
    school.status = "blocked";
  } else if (action === "unblock") {
    school.status = "active";
  } else if (action === "qna-limit") {
    school.qnaMonthlyLimit = Number(body.qnaMonthlyLimit || body.limit || DEFAULT_MONTHLY_QNA_LIMIT);
  } else if (action === "update") {
    for (const field of ["schoolName", "state", "district", "contactPerson", "mobile", "email", "appVersion", "contentVersion"]) {
      if (body[field] !== undefined) school[field] = clean(body[field]);
    }
  } else {
    throw new HttpError(404, "UNKNOWN_ACTION", "Unknown admin action");
  }

  school.updatedAt = new Date().toISOString();
  return publicSchool(await upsertSchool(school));
}

async function saveQna(input) {
  const chapter = normalizeChapter(input.chapter || input);
  const qna = {
    cacheKey: qnaKey(chapter),
    chapter,
    questionType: chapter.questionType,
    difficulty: chapter.difficulty,
    items: Array.isArray(input.items) ? input.items : [],
    notes: clean(input.notes),
    generatedBy: clean(input.generatedBy) || "manual-admin",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (!qna.items.length) {
    throw new HttpError(400, "VALIDATION_ERROR", "items are required");
  }
  if (qna.generatedBy !== "manual-admin" && !qnaHasEnoughItems(qna, chapter.questionCount)) {
    throw new HttpError(502, "AI_BAD_RESPONSE_TOO_FEW", "Generated Q&A did not include enough usable questions");
  }

  await upsertQna(qna);
  return qna;
}

async function listQna() {
  const { rows } = await db.query(`
    select cache_key, chapter, items, generated_by, updated_at
    from qna_cache
    order by updated_at desc
  `);
  return rows.map((row) => {
    const chapter = row.chapter || {};
    const items = Array.isArray(row.items) ? row.items : [];
    return {
      cacheKey: row.cache_key,
      board: chapter.board,
      className: chapter.className,
      subject: chapter.subject,
      book: chapter.book,
      chapter: chapter.chapter,
      language: chapter.language,
      itemCount: items.length,
      generatedBy: row.generated_by,
      updatedAt: iso(row.updated_at)
    };
  });
}

async function deleteQna(cacheKey) {
  await db.query("delete from qna_cache where cache_key = $1", [cacheKey]);
}

async function getQna(chapterInput) {
  const chapter = normalizeChapter(chapterInput);
  const exact = await getQnaByCacheKey(qnaKey(chapter));
  if (exact && qnaHasEnoughItems(exact, chapter.questionCount)) return exact;
  if (chapter.board.toLowerCase() === "pdf") {
    return await findPdfQna(chapter);
  }
  return null;
}

async function findPdfQna(chapter) {
  const wantedBook = looseKey(chapter.book);
  const wantedChapter = looseKey(chapter.chapter);
  const { rows } = await db.query(`
    select cache_key, chapter, question_type, difficulty, items, notes, generated_by, created_at, updated_at
    from qna_cache
    where lower(chapter->>'board') = 'pdf'
    order by updated_at desc
  `);
  for (const row of rows) {
    const qna = qnaFromRow(row);
    const saved = qna.chapter;
    const savedBook = looseKey(saved.book);
    const savedChapter = looseKey(saved.chapter);
    if ((savedBook === wantedBook || savedChapter === wantedChapter)
        || (savedBook === wantedChapter || savedChapter === wantedBook)) {
      if (qnaHasEnoughItems(qna, chapter.questionCount)) return qna;
    }
  }
  return null;
}

function qnaHasEnoughItems(qna, desiredCount = 10) {
  const items = Array.isArray(qna?.items) ? qna.items : [];
  const usableItems = items.filter((item) => clean(item?.question) && clean(item?.answer));
  return usableItems.length >= minimumQuestionCount(targetQuestionCount({ questionCount: desiredCount }));
}

function looseKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.pdf$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

function panelUsageKey(school, deviceId = "") {
  return "panel:" + clean(deviceId || school.deviceId || school.schoolId);
}

async function getUsageForPanel(school, deviceId = "") {
  const month = new Date().toISOString().slice(0, 7);
  const { rows } = await db.query(
    "select generated_count, generated_chapters from panel_usage where panel_key = $1 and usage_month = $2",
    [panelUsageKey(school, deviceId), month]
  );
  if (!rows[0]) return { generatedCount: 0, generatedChapters: [] };
  return {
    generatedCount: Number(rows[0].generated_count || 0),
    generatedChapters: Array.isArray(rows[0].generated_chapters) ? rows[0].generated_chapters : []
  };
}

async function recordQnaGeneration(school, deviceId, chapter) {
  const month = new Date().toISOString().slice(0, 7);
  const key = panelUsageKey(school, deviceId);
  const generatedChapter = {
    cacheKey: qnaKey(chapter),
    title: chapter.chapter,
    book: chapter.book,
    schoolId: school.schoolId,
    deviceId: deviceId || school.deviceId || "",
    generatedAt: new Date().toISOString()
  };
  const { rows } = await db.query(`
    insert into panel_usage (panel_key, usage_month, generated_count, generated_chapters, updated_at)
    values ($1, $2, $3, $4::jsonb, now())
    on conflict (panel_key, usage_month)
    do update set generated_count = panel_usage.generated_count + 1,
      generated_chapters = panel_usage.generated_chapters || excluded.generated_chapters,
      updated_at = now()
    returning generated_count, generated_chapters
  `, [key, month, 1, JSON.stringify([generatedChapter])]);
  return {
    generatedCount: Number(rows[0]?.generated_count || 0),
    generatedChapters: Array.isArray(rows[0]?.generated_chapters) ? rows[0].generated_chapters : []
  };
}

async function schoolsWithUsage() {
  const schools = await listSchools();
  const month = new Date().toISOString().slice(0, 7);
  const { rows } = await db.query("select panel_key, generated_count from panel_usage where usage_month = $1", [month]);
  const usage = new Map(rows.map((row) => [row.panel_key, Number(row.generated_count || 0)]));
  return schools.map((school) => ({
    ...school,
    panelDeviceId: school.deviceId,
    qnaMonthlyUsed: usage.get(panelUsageKey(school, school.deviceId)) || 0
  }));
}

async function findSchool(schoolId) {
  const { rows } = await db.query("select * from schools where school_id = $1", [schoolId]);
  const school = rows[0] ? schoolFromRow(rows[0]) : null;
  if (!school) {
    throw new HttpError(404, "SCHOOL_NOT_FOUND", "School not found");
  }
  return school;
}

function normalizeChapter(input = {}) {
  const chapter = {
    board: clean(input.board || "NCERT"),
    className: clean(input.className || input.class || input.grade),
    subject: clean(input.subject),
    book: clean(input.book),
    chapter: clean(input.chapter || input.chapterName),
    language: clean(input.language || "English"),
    contentVersion: clean(input.contentVersion || "v2026"),
    questionType: clean(input.questionType || "mixed"),
    difficulty: clean(input.difficulty || "balanced"),
    questionCount: Math.max(6, Math.min(15, Number(input.questionCount || 10)))
  };

  for (const field of ["className", "subject", "book", "chapter"]) {
    if (!chapter[field]) {
      throw new HttpError(400, "VALIDATION_ERROR", `chapter.${field} is required`);
    }
  }

  return chapter;
}

function chapterFromSearch(params) {
  return {
    board: params.get("board"),
    className: params.get("className") || params.get("class"),
    subject: params.get("subject"),
    book: params.get("book"),
    chapter: params.get("chapter"),
    language: params.get("language"),
    contentVersion: params.get("contentVersion"),
    questionType: params.get("questionType"),
    difficulty: params.get("difficulty")
  };
}

function qnaKey(chapter) {
  const raw = [
    chapter.board,
    chapter.className,
    chapter.subject,
    chapter.book,
    chapter.chapter,
    chapter.language,
    chapter.contentVersion,
    chapter.questionType,
    chapter.difficulty,
    chapter.questionCount,
    QNA_PROMPT_VERSION
  ].map((value) => String(value || "").toLowerCase().trim()).join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
  }

  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

async function ensureStorage() {
  await db.query(`
    create table if not exists schools (
      school_id text primary key,
      school_name text not null,
      state text not null,
      district text not null,
      contact_person text default '',
      mobile text default '',
      email text default '',
      device_id text unique,
      app_version text default '',
      content_version text default '',
      status text not null default 'active',
      activation_start timestamptz not null,
      activation_expires timestamptz not null,
      qna_monthly_limit integer not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);
  await db.query(`
    create table if not exists qna_cache (
      cache_key text primary key,
      chapter jsonb not null,
      question_type text default '',
      difficulty text default '',
      items jsonb not null,
      notes text default '',
      generated_by text default '',
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);
  await db.query(`
    create table if not exists panel_usage (
      panel_key text not null,
      usage_month text not null,
      generated_count integer not null default 0,
      generated_chapters jsonb not null default '[]'::jsonb,
      updated_at timestamptz not null default now(),
      primary key (panel_key, usage_month)
    )
  `);
  await db.query("create index if not exists schools_device_id_idx on schools (device_id)");
  await db.query("create index if not exists qna_cache_updated_at_idx on qna_cache (updated_at desc)");
  await db.query("create index if not exists panel_usage_month_idx on panel_usage (usage_month)");
}

async function findSchoolByPanelDeviceId(deviceId) {
  const { rows } = await db.query("select * from schools where device_id = $1 limit 1", [deviceId]);
  return rows[0] ? schoolFromRow(rows[0]) : null;
}

async function listSchools() {
  const { rows } = await db.query("select * from schools order by created_at desc");
  return rows.map(schoolFromRow);
}

async function upsertSchool(school) {
  const values = [
    school.schoolId,
    school.schoolName,
    school.state,
    school.district,
    school.contactPerson,
    school.mobile,
    school.email,
    school.deviceId || null,
    school.appVersion,
    school.contentVersion,
    school.status,
    school.activationStart,
    school.activationExpires,
    Number(school.qnaMonthlyLimit || DEFAULT_MONTHLY_QNA_LIMIT),
    school.createdAt,
    school.updatedAt
  ];
  const { rows } = await db.query(`
    insert into schools (
      school_id, school_name, state, district, contact_person, mobile, email, device_id,
      app_version, content_version, status, activation_start, activation_expires,
      qna_monthly_limit, created_at, updated_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    on conflict (school_id)
    do update set school_name = excluded.school_name,
      state = excluded.state,
      district = excluded.district,
      contact_person = excluded.contact_person,
      mobile = excluded.mobile,
      email = excluded.email,
      device_id = excluded.device_id,
      app_version = excluded.app_version,
      content_version = excluded.content_version,
      status = excluded.status,
      activation_start = excluded.activation_start,
      activation_expires = excluded.activation_expires,
      qna_monthly_limit = excluded.qna_monthly_limit,
      updated_at = excluded.updated_at
    returning *
  `, values);
  return schoolFromRow(rows[0]);
}

async function upsertQna(qna) {
  await db.query(`
    insert into qna_cache (
      cache_key, chapter, question_type, difficulty, items, notes, generated_by, created_at, updated_at
    ) values ($1,$2::jsonb,$3,$4,$5::jsonb,$6,$7,$8,$9)
    on conflict (cache_key)
    do update set chapter = excluded.chapter,
      question_type = excluded.question_type,
      difficulty = excluded.difficulty,
      items = excluded.items,
      notes = excluded.notes,
      generated_by = excluded.generated_by,
      updated_at = excluded.updated_at
  `, [
    qna.cacheKey,
    JSON.stringify(qna.chapter),
    qna.questionType,
    qna.difficulty,
    JSON.stringify(qna.items),
    qna.notes,
    qna.generatedBy,
    qna.createdAt,
    qna.updatedAt
  ]);
}

async function getQnaByCacheKey(cacheKey) {
  const { rows } = await db.query(
    "select cache_key, chapter, question_type, difficulty, items, notes, generated_by, created_at, updated_at from qna_cache where cache_key = $1",
    [cacheKey]
  );
  return rows[0] ? qnaFromRow(rows[0]) : null;
}

async function listUsage() {
  const { rows } = await db.query(`
    select panel_key, usage_month, generated_count, generated_chapters, updated_at
    from panel_usage
    order by usage_month desc, updated_at desc
  `);
  return rows.map((row) => ({
    panelKey: row.panel_key,
    month: row.usage_month,
    generatedCount: Number(row.generated_count || 0),
    generatedChapters: Array.isArray(row.generated_chapters) ? row.generated_chapters : [],
    updatedAt: iso(row.updated_at)
  }));
}

function schoolFromRow(row) {
  return {
    schoolId: row.school_id,
    schoolName: row.school_name,
    state: row.state,
    district: row.district,
    contactPerson: row.contact_person || "",
    mobile: row.mobile || "",
    email: row.email || "",
    deviceId: row.device_id || "",
    appVersion: row.app_version || "",
    contentVersion: row.content_version || "",
    status: row.status,
    activationStart: iso(row.activation_start),
    activationExpires: iso(row.activation_expires),
    qnaMonthlyLimit: Number(row.qna_monthly_limit || DEFAULT_MONTHLY_QNA_LIMIT),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function qnaFromRow(row) {
  return {
    cacheKey: row.cache_key,
    chapter: row.chapter || {},
    questionType: row.question_type || "",
    difficulty: row.difficulty || "",
    items: Array.isArray(row.items) ? row.items : [],
    notes: row.notes || "",
    generatedBy: row.generated_by || "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function iso(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

async function loadEnvFile() {
  try {
    const content = await readFile(envFile, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^"|"$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
  }
}

function requireAdmin(req) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) {
    throw new HttpError(401, "UNAUTHORIZED", "Admin token is required");
  }
}

function sendJson(res, status, value) {
  sendCors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

function sendHtml(res, html) {
  sendCors(res);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendText(res, status, text, contentType) {
  sendCors(res);
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

function sendCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Admin-Token");
}

function clean(value) {
  return String(value || "").trim();
}

function publicSchool(school) {
  return {
    schoolId: school.schoolId,
    schoolName: school.schoolName,
    state: school.state,
    district: school.district,
    contactPerson: school.contactPerson,
    mobile: school.mobile,
    email: school.email,
    deviceId: school.deviceId,
    panelDeviceId: school.deviceId,
    appVersion: school.appVersion,
    contentVersion: school.contentVersion,
    status: school.status,
    activationStart: school.activationStart,
    activationExpires: school.activationExpires,
    qnaMonthlyLimit: school.qnaMonthlyLimit,
    createdAt: school.createdAt,
    updatedAt: school.updatedAt
  };
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function randomCode(length) {
  return randomUUID().replace(/-/g, "").slice(0, length).toUpperCase();
}

function schoolsCsv(schools) {
  const columns = [
    ["School ID", "schoolId"],
    ["School Name", "schoolName"],
    ["State", "state"],
    ["District", "district"],
    ["Contact Person", "contactPerson"],
    ["Mobile", "mobile"],
    ["Email", "email"],
    ["Panel Device ID", "deviceId"],
    ["Status", "status"],
    ["Activation Expires", "activationExpires"],
    ["Q&A Used This Month", "qnaMonthlyUsed"],
    ["Q&A Monthly Limit Per Panel", "qnaMonthlyLimit"],
    ["App Version", "appVersion"],
    ["Content Version", "contentVersion"]
  ];
  return [
    columns.map(([label]) => csvCell(label)).join(","),
    ...schools.map((school) => columns.map(([, key]) => csvCell(school[key])).join(","))
  ].join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function renderAdminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Class Flow Admin</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f6f8fb; color: #1e293b; }
    header { background: #00a0e3; color: white; padding: 18px 24px; }
    main { padding: 24px; max-width: 1180px; margin: auto; }
    section { background: white; border: 1px solid #d7dee8; border-radius: 8px; padding: 16px; margin-bottom: 18px; }
    input, button { font: inherit; padding: 10px; border-radius: 6px; border: 1px solid #b8c3cf; }
    input, textarea { box-sizing: border-box; }
    textarea { width: 100%; min-height: 78px; font: inherit; padding: 10px; border-radius: 6px; border: 1px solid #b8c3cf; resize: vertical; }
    button { background: #00a0e3; color: white; border: 0; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid #e2e8f0; padding: 10px; text-align: left; vertical-align: top; }
    th { background: #f8fafc; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .muted { color: #64748b; }
    .danger { background: #dc2626; }
    .ok { color: #15803d; font-weight: 700; }
    .bad { color: #b91c1c; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 10px; }
    .grid input { width: 100%; }
    .wide { grid-column: 1 / -1; }
  </style>
</head>
<body>
  <header>
    <h1>Class Flow School Activation Admin</h1>
    <div>Railway server for registration, activation extension, Q&A cache, and panel usage control.</div>
  </header>
  <main>
    <section>
      <h2>Admin Token</h2>
      <div class="row">
        <input id="token" size="36" placeholder="Enter admin token">
        <button onclick="loadSchools()">Load Schools</button>
        <button onclick="loadConfig()">Server Status</button>
        <button onclick="exportSchools()">Export CSV</button>
      </div>
      <div id="configStatus" class="muted"></div>
      <p class="muted">Admin token is stored only as a Railway service variable.</p>
    </section>
    <section>
      <h2>Schools</h2>
      <div id="status" class="muted">Click Load Schools.</div>
      <div style="overflow:auto">
        <table>
          <thead>
            <tr>
              <th>School</th>
              <th>Location</th>
              <th>Status</th>
              <th>Activation</th>
              <th>Q&A Usage</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="schools"></tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>Add Q&A Cache</h2>
      <p class="muted">For PDF Folder testing, use Board = PDF, Subject = PDF, Book = PDF file name, Chapter = PDF file name.</p>
      <div class="grid">
        <input id="qBoard" value="PDF" placeholder="Board">
        <input id="qClass" placeholder="Folder/Class name">
        <input id="qSubject" value="PDF" placeholder="Subject">
        <input id="qBook" placeholder="Book/PDF name">
        <input id="qChapter" placeholder="Chapter/PDF name">
        <input id="qLanguage" value="English" placeholder="Language">
        <input id="qType" value="mixed" placeholder="Question type">
        <input id="qDifficulty" value="standard" placeholder="Difficulty">
        <textarea id="qItems" class="wide" placeholder="One question per line. Use: Question | Answer"></textarea>
      </div>
      <div class="row" style="margin-top:10px">
        <button onclick="saveQna()">Save Q&A</button>
        <button onclick="fillPdfFromPrompt()">Use Same PDF Name</button>
        <span id="qnaStatus" class="muted"></span>
      </div>
    </section>
    <section>
      <h2>Saved Q&A</h2>
      <div class="row">
        <button onclick="loadQna()">Load Saved Q&A</button>
        <span id="qnaListStatus" class="muted"></span>
      </div>
      <div style="overflow:auto; margin-top:10px">
        <table>
          <thead>
            <tr>
              <th>Board</th>
              <th>Class/Folder</th>
              <th>Book</th>
              <th>Chapter/PDF</th>
              <th>Questions</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody id="qnaRows"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    async function api(path, options = {}) {
      const headers = { "Content-Type": "application/json", "X-Admin-Token": document.getElementById("token").value };
      const res = await fetch(path, { ...options, headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Request failed");
      return data;
    }
    async function loadSchools() {
      const status = document.getElementById("status");
      status.textContent = "Loading...";
      try {
        const data = await api("/api/admin/schools");
        document.getElementById("schools").innerHTML = data.schools.map(renderSchool).join("");
        status.textContent = data.schools.length + " school(s) found.";
      } catch (error) {
        status.textContent = error.message;
      }
    }
    function renderSchool(school) {
      const active = school.status === "active" && new Date(school.activationExpires) >= new Date();
      return '<tr>' +
        '<td><strong>' + esc(school.schoolName) + '</strong><br><span class="muted">School ID: ' + esc(school.schoolId) + '</span><br><span class="muted">Panel Device ID: ' + esc(school.panelDeviceId || school.deviceId || "") + '</span><br>' + esc(school.contactPerson || "") + '</td>' +
        '<td>' + esc(school.district) + '<br>' + esc(school.state) + '</td>' +
        '<td class="' + (active ? "ok" : "bad") + '">' + esc(school.status) + '</td>' +
        '<td>' + new Date(school.activationExpires).toLocaleDateString() + '</td>' +
        '<td>' + (school.qnaMonthlyUsed || 0) + ' / ' + school.qnaMonthlyLimit + ' per panel this month</td>' +
        '<td><div class="row">' +
          '<button onclick="extendSchool(\\'' + school.schoolId + '\\', 6)">+6 months</button>' +
          '<button onclick="extendSchool(\\'' + school.schoolId + '\\', 12)">+1 year</button>' +
          '<button onclick="setQnaLimit(\\'' + school.schoolId + '\\')">Set Q&A Limit</button>' +
          '<button class="danger" onclick="blockSchool(\\'' + school.schoolId + '\\')">Block</button>' +
          '<button onclick="unblockSchool(\\'' + school.schoolId + '\\')">Unblock</button>' +
        '</div></td>' +
      '</tr>';
    }
    async function extendSchool(id, months) {
      await api("/api/admin/schools/" + id + "/extend", { method: "POST", body: JSON.stringify({ months }) });
      loadSchools();
    }
    async function blockSchool(id) {
      await api("/api/admin/schools/" + id + "/block", { method: "POST", body: "{}" });
      loadSchools();
    }
    async function unblockSchool(id) {
      await api("/api/admin/schools/" + id + "/unblock", { method: "POST", body: "{}" });
      loadSchools();
    }
    async function setQnaLimit(id) {
      const limit = prompt("Monthly Q&A generation limit per panel:");
      if (!limit) return;
      await api("/api/admin/schools/" + id + "/qna-limit", { method: "POST", body: JSON.stringify({ qnaMonthlyLimit: Number(limit) }) });
      loadSchools();
    }
    async function loadConfig() {
      const status = document.getElementById("configStatus");
      status.textContent = "Loading server status...";
      try {
        const data = await api("/api/admin/config");
        status.textContent = "AI: " + data.config.aiProvider + " | Storage: " + data.config.storage + " | Port: " + data.config.port;
      } catch (error) {
        status.textContent = error.message;
      }
    }
    async function exportSchools() {
      const res = await fetch("/api/admin/schools.csv", { headers: { "X-Admin-Token": document.getElementById("token").value } });
      if (!res.ok) {
        alert("Export failed");
        return;
      }
      const text = await res.text();
      const blob = new Blob([text], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "schools.csv";
      link.click();
      URL.revokeObjectURL(url);
    }
    async function saveQna() {
      const status = document.getElementById("qnaStatus");
      status.textContent = "Saving...";
      try {
        const lines = document.getElementById("qItems").value.split("\\n").map(x => x.trim()).filter(Boolean);
        const items = lines.map(line => {
          const parts = line.split("|");
          return { type: "short", question: (parts[0] || "").trim(), answer: (parts.slice(1).join("|") || "").trim() };
        }).filter(item => item.question && item.answer);
        if (!items.length) throw new Error("Enter at least one question like: Question | Answer");
        const body = {
          chapter: {
            board: value("qBoard"),
            className: value("qClass"),
            subject: value("qSubject"),
            book: value("qBook"),
            chapter: value("qChapter"),
            language: value("qLanguage"),
            contentVersion: "v2026",
            questionType: value("qType"),
            difficulty: value("qDifficulty")
          },
          items
        };
        await api("/api/admin/qna", { method: "PUT", body: JSON.stringify(body) });
        status.textContent = "Saved. Tap Q&A on the tab again.";
      } catch (error) {
        status.textContent = error.message;
      }
    }
    function fillPdfFromPrompt() {
      const name = prompt("Enter the exact PDF name shown in the app, without .pdf if app hides it:");
      if (!name) return;
      document.getElementById("qBook").value = name;
      document.getElementById("qChapter").value = name;
      if (!document.getElementById("qClass").value) document.getElementById("qClass").value = "Selected Folder";
    }
    function value(id) {
      return document.getElementById(id).value.trim();
    }
    async function loadQna() {
      const status = document.getElementById("qnaListStatus");
      status.textContent = "Loading...";
      try {
        const data = await api("/api/admin/qna");
        document.getElementById("qnaRows").innerHTML = data.qna.map(item =>
          '<tr>' +
            '<td>' + esc(item.board) + '</td>' +
            '<td>' + esc(item.className) + '</td>' +
            '<td>' + esc(item.book) + '</td>' +
            '<td>' + esc(item.chapter) + '</td>' +
            '<td>' + item.itemCount + '</td>' +
            '<td>' + (item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '') + '<br><button class="danger" onclick="deleteQna(\\'' + item.cacheKey + '\\')">Delete</button></td>' +
          '</tr>'
        ).join("");
        status.textContent = data.qna.length + " saved Q&A item(s).";
      } catch (error) {
        status.textContent = error.message;
      }
    }
    async function deleteQna(cacheKey) {
      if (!confirm("Delete this saved Q&A?")) return;
      await api("/api/admin/qna/" + cacheKey, { method: "DELETE" });
      loadQna();
    }
    function esc(value) {
      return String(value || "").replace(/[&<>"']/g, function (char) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
      });
    }
  </script>
</body>
</html>`;
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

process.on("uncaughtException", (error) => {
  console.error(error);
});

process.on("unhandledRejection", (error) => {
  console.error(error);
});
