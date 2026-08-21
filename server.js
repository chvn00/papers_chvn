const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const databaseUrl = process.env.DATABASE_URL;
const appPassword = process.env.APP_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET;
const pool = new Pool({ connectionString: databaseUrl, ssl: databaseUrl?.includes("railway.internal") ? false : { rejectUnauthorized: false } });
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const MAX_PDF_SIZE = 25 * 1024 * 1024;
const loginAttempts = new Map();
const publicFiles = new Set(["index.html", "styles.css", "app.js", "assets/logo-chvn.png"]);
const vendorFiles = new Map([
  ["vendor/pdf.min.mjs", path.join(root, "node_modules/pdfjs-dist/build/pdf.min.mjs")],
  ["vendor/pdf.worker.min.mjs", path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs")]
]);
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".png": "image/png" };

function json(response, status, payload, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

function signature(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function createSession() {
  const expires = String(Date.now() + SESSION_SECONDS * 1000);
  return `${expires}.${signature(expires)}`;
}

function hasValidSession(request) {
  if (!sessionSecret) return false;
  const token = parseCookies(request).papers_session || "";
  const [expires, suppliedSignature] = token.split(".");
  if (!expires || !suppliedSignature || Number(expires) < Date.now()) return false;
  const expected = signature(expires);
  const supplied = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expected);
  return supplied.length === expectedBuffer.length && crypto.timingSafeEqual(supplied, expectedBuffer);
}

function safePasswordEqual(supplied = "") {
  const actual = Buffer.from(appPassword || "");
  const candidate = Buffer.from(String(supplied));
  return actual.length === candidate.length && actual.length > 0 && crypto.timingSafeEqual(actual, candidate);
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; }
  catch { return false; }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Payload demasiado grande");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readRawBody(request, maxSize) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new Error("El PDF supera el límite de 25 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeFilename(value) {
  let decoded = "paper.pdf";
  try { decoded = decodeURIComponent(String(value || decoded)); } catch {}
  const cleaned = decoded.replace(/[\r\n\/\\]/g, "_").replace(/[^\p{L}\p{N}._() -]/gu, "_").trim().slice(0, 180);
  return (cleaned || "paper.pdf").toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

function normalizePaper(input = {}) {
  const text = key => String(input[key] || "").trim();
  const title = text("title");
  const journal = text("journal");
  const status = text("status") || "Borrador";
  const quartile = status === "Publicado" ? text("quartile").toUpperCase() : "";
  if (!title || !journal) throw new Error("Título y journal son obligatorios");
  if (status === "Publicado" && !["Q1", "Q2", "Q3", "Q4"].includes(quartile)) throw new Error("Selecciona el cuartil de la publicación");
  return {
    id: text("id") || crypto.randomUUID(), title, journal, status, quartile,
    coauthors: text("coauthors"), affiliation: text("affiliation"), submittedAt: text("submittedAt") || null,
    link: text("link"), notes: text("notes"), createdAt: text("createdAt") || new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

function fromRow(row) {
  const dateOnly = value => !value ? "" : (typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10));
  const iso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return {
    id: row.id, title: row.title, journal: row.journal, status: row.status, quartile: row.quartile || "", coauthors: row.coauthors || "",
    affiliation: row.affiliation || "", submittedAt: dateOnly(row.submitted_at),
    link: row.link || "", notes: row.notes || "", createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    hasPdf: Boolean(row.has_pdf), pdfName: row.pdf_name || "", pdfSize: Number(row.pdf_size || 0)
  };
}

const upsertSql = `INSERT INTO papers
  (id, title, journal, status, quartile, coauthors, affiliation, submitted_at, link, notes, created_at, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, journal=EXCLUDED.journal, status=EXCLUDED.status,
  quartile=EXCLUDED.quartile, coauthors=EXCLUDED.coauthors, affiliation=EXCLUDED.affiliation, submitted_at=EXCLUDED.submitted_at,
  link=EXCLUDED.link, notes=EXCLUDED.notes, updated_at=EXCLUDED.updated_at RETURNING *`;

function paperValues(paper) {
  return [paper.id, paper.title, paper.journal, paper.status, paper.quartile || null, paper.coauthors, paper.affiliation, paper.submittedAt, paper.link, paper.notes, paper.createdAt, paper.updatedAt];
}

function normalizeThesis(input = {}) {
  const text = key => String(input[key] || "").trim();
  const title = text("title");
  const university = text("university");
  const degree = text("degree");
  if (!title || !university || !degree) throw new Error("Título, universidad y grado son obligatorios");
  return {
    id: text("id") || crypto.randomUUID(), title, university, degree, link: text("link"),
    createdAt: text("createdAt") || new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

function thesisFromRow(row) {
  const iso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return { id: row.id, title: row.title, university: row.university, degree: row.degree, link: row.link || "", createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), hasPdf: Boolean(row.has_pdf), pdfName: row.pdf_name || "", pdfSize: Number(row.pdf_size || 0) };
}

const thesisUpsertSql = `INSERT INTO theses (id, title, university, degree, link, created_at, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, university=EXCLUDED.university,
  degree=EXCLUDED.degree, link=EXCLUDED.link, updated_at=EXCLUDED.updated_at RETURNING *`;

function thesisValues(thesis) {
  return [thesis.id, thesis.title, thesis.university, thesis.degree, thesis.link, thesis.createdAt, thesis.updatedAt];
}

async function api(request, response, pathname) {
  if (!sameOrigin(request)) return json(response, 403, { error: "Origen no permitido" });

  if (pathname === "/api/session" && request.method === "GET") {
    return json(response, hasValidSession(request) ? 200 : 401, { authenticated: hasValidSession(request) });
  }

  if (pathname === "/api/login" && request.method === "POST") {
    const ip = request.headers["x-forwarded-for"]?.split(",")[0] || request.socket.remoteAddress || "unknown";
    const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
    if (attempt.until > Date.now()) return json(response, 429, { error: "Espera unos minutos antes de volver a intentar" });
    const body = await readBody(request);
    if (!safePasswordEqual(body.password)) {
      attempt.count += 1;
      if (attempt.count >= 5) { attempt.count = 0; attempt.until = Date.now() + 5 * 60 * 1000; }
      loginAttempts.set(ip, attempt);
      return json(response, 401, { error: "Contraseña incorrecta" });
    }
    loginAttempts.delete(ip);
    const cookie = `papers_session=${createSession()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
    return json(response, 200, { authenticated: true }, { "Set-Cookie": cookie });
  }

  if (pathname === "/api/logout" && request.method === "POST") {
    return json(response, 200, { authenticated: false }, { "Set-Cookie": "papers_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
  }

  if (!hasValidSession(request)) return json(response, 401, { error: "Sesión requerida" });

  if (pathname === "/api/papers" && request.method === "GET") {
    const result = await pool.query(`SELECT p.*, (f.paper_id IS NOT NULL) AS has_pdf, f.filename AS pdf_name, f.size_bytes AS pdf_size
      FROM papers p LEFT JOIN paper_pdfs f ON f.paper_id = p.id ORDER BY p.updated_at DESC`);
    return json(response, 200, result.rows.map(fromRow));
  }

  if (pathname === "/api/papers" && request.method === "POST") {
    const paper = normalizePaper(await readBody(request));
    const result = await pool.query(upsertSql, paperValues(paper));
    return json(response, 201, fromRow(result.rows[0]));
  }

  if (pathname === "/api/theses" && request.method === "GET") {
    const result = await pool.query(`SELECT t.*, (f.thesis_id IS NOT NULL) AS has_pdf, f.filename AS pdf_name, f.size_bytes AS pdf_size
      FROM theses t LEFT JOIN thesis_pdfs f ON f.thesis_id = t.id ORDER BY t.updated_at DESC`);
    return json(response, 200, result.rows.map(thesisFromRow));
  }

  if (pathname === "/api/theses" && request.method === "POST") {
    const thesis = normalizeThesis(await readBody(request));
    const result = await pool.query(thesisUpsertSql, thesisValues(thesis));
    return json(response, 201, thesisFromRow(result.rows[0]));
  }

  const thesisMatch = pathname.match(/^\/api\/theses\/([a-zA-Z0-9-]+)$/);
  if (thesisMatch && request.method === "PUT") {
    const current = await pool.query("SELECT created_at FROM theses WHERE id=$1", [thesisMatch[1]]);
    if (!current.rowCount) return json(response, 404, { error: "Tesis no encontrada" });
    const thesis = normalizeThesis({ ...(await readBody(request)), id: thesisMatch[1], createdAt: current.rows[0].created_at.toISOString() });
    const result = await pool.query(thesisUpsertSql, thesisValues(thesis));
    return json(response, 200, thesisFromRow(result.rows[0]));
  }

  if (thesisMatch && request.method === "DELETE") {
    await pool.query("DELETE FROM theses WHERE id=$1", [thesisMatch[1]]);
    return json(response, 200, { deleted: true });
  }

  const thesisPdfMatch = pathname.match(/^\/api\/theses\/([a-zA-Z0-9-]+)\/pdf$/);
  if (thesisPdfMatch && request.method === "POST") {
    if (!(request.headers["content-type"] || "").toLowerCase().startsWith("application/pdf")) return json(response, 415, { error: "Selecciona un archivo PDF válido" });
    const content = await readRawBody(request, MAX_PDF_SIZE);
    if (content.length < 5 || content.subarray(0, 5).toString("ascii") !== "%PDF-") return json(response, 400, { error: "El archivo no contiene un PDF válido" });
    const filename = safeFilename(request.headers["x-file-name"]);
    const result = await pool.query(`INSERT INTO thesis_pdfs (thesis_id, filename, mime_type, size_bytes, content, uploaded_at)
      SELECT id, $2, 'application/pdf', $3, $4, NOW() FROM theses WHERE id=$1
      ON CONFLICT (thesis_id) DO UPDATE SET filename=EXCLUDED.filename, mime_type=EXCLUDED.mime_type,
      size_bytes=EXCLUDED.size_bytes, content=EXCLUDED.content, uploaded_at=NOW()
      RETURNING filename, size_bytes, uploaded_at`, [thesisPdfMatch[1], filename, content.length, content]);
    if (!result.rowCount) return json(response, 404, { error: "Tesis no encontrada" });
    return json(response, 201, { hasPdf: true, pdfName: result.rows[0].filename, pdfSize: Number(result.rows[0].size_bytes) });
  }

  if (thesisPdfMatch && request.method === "GET") {
    const result = await pool.query("SELECT filename, mime_type, size_bytes, content FROM thesis_pdfs WHERE thesis_id=$1", [thesisPdfMatch[1]]);
    if (!result.rowCount) return json(response, 404, { error: "Esta tesis no tiene un PDF cargado" });
    const file = result.rows[0];
    response.writeHead(200, {
      "Content-Type": file.mime_type,
      "Content-Length": file.size_bytes,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(file.content);
    return;
  }

  const pdfMatch = pathname.match(/^\/api\/papers\/([a-zA-Z0-9-]+)\/pdf$/);
  if (pdfMatch && request.method === "POST") {
    if (!(request.headers["content-type"] || "").toLowerCase().startsWith("application/pdf")) return json(response, 415, { error: "Selecciona un archivo PDF válido" });
    const content = await readRawBody(request, MAX_PDF_SIZE);
    if (content.length < 5 || content.subarray(0, 5).toString("ascii") !== "%PDF-") return json(response, 400, { error: "El archivo no contiene un PDF válido" });
    const filename = safeFilename(request.headers["x-file-name"]);
    const result = await pool.query(`INSERT INTO paper_pdfs (paper_id, filename, mime_type, size_bytes, content, uploaded_at)
      SELECT id, $2, 'application/pdf', $3, $4, NOW() FROM papers WHERE id=$1
      ON CONFLICT (paper_id) DO UPDATE SET filename=EXCLUDED.filename, mime_type=EXCLUDED.mime_type,
      size_bytes=EXCLUDED.size_bytes, content=EXCLUDED.content, uploaded_at=NOW()
      RETURNING filename, size_bytes, uploaded_at`, [pdfMatch[1], filename, content.length, content]);
    if (!result.rowCount) return json(response, 404, { error: "Paper no encontrado" });
    return json(response, 201, { hasPdf: true, pdfName: result.rows[0].filename, pdfSize: Number(result.rows[0].size_bytes) });
  }

  if (pdfMatch && request.method === "GET") {
    const result = await pool.query("SELECT filename, mime_type, size_bytes, content FROM paper_pdfs WHERE paper_id=$1", [pdfMatch[1]]);
    if (!result.rowCount) return json(response, 404, { error: "Este paper no tiene un PDF cargado" });
    const file = result.rows[0];
    response.writeHead(200, {
      "Content-Type": file.mime_type,
      "Content-Length": file.size_bytes,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(file.content);
    return;
  }

  const match = pathname.match(/^\/api\/papers\/([a-zA-Z0-9-]+)$/);
  if (match && request.method === "PUT") {
    const current = await pool.query("SELECT created_at FROM papers WHERE id=$1", [match[1]]);
    if (!current.rowCount) return json(response, 404, { error: "Registro no encontrado" });
    const paper = normalizePaper({ ...(await readBody(request)), id: match[1], createdAt: current.rows[0].created_at.toISOString() });
    const result = await pool.query(upsertSql, paperValues(paper));
    return json(response, 200, fromRow(result.rows[0]));
  }

  if (match && request.method === "DELETE") {
    await pool.query("DELETE FROM papers WHERE id=$1", [match[1]]);
    return json(response, 200, { deleted: true });
  }

  if (pathname === "/api/import" && request.method === "POST") {
    const body = await readBody(request);
    if (!Array.isArray(body.papers) || body.papers.length > 2000) return json(response, 400, { error: "Respaldo inválido" });
    if (body.theses !== undefined && (!Array.isArray(body.theses) || body.theses.length > 2000)) return json(response, 400, { error: "Respaldo de tesis inválido" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (body.replace) await client.query("DELETE FROM papers");
      if (body.replace && Array.isArray(body.theses)) await client.query("DELETE FROM theses");
      for (const input of body.papers) {
        const paper = normalizePaper(input);
        await client.query(upsertSql, paperValues(paper));
      }
      for (const input of body.theses || []) {
        const thesis = normalizeThesis(input);
        await client.query(thesisUpsertSql, thesisValues(thesis));
      }
      await client.query("COMMIT");
      const paperResult = await client.query(`SELECT p.*, (f.paper_id IS NOT NULL) AS has_pdf, f.filename AS pdf_name, f.size_bytes AS pdf_size
        FROM papers p LEFT JOIN paper_pdfs f ON f.paper_id = p.id ORDER BY p.updated_at DESC`);
      const thesisResult = await client.query(`SELECT t.*, (f.thesis_id IS NOT NULL) AS has_pdf, f.filename AS pdf_name, f.size_bytes AS pdf_size
        FROM theses t LEFT JOIN thesis_pdfs f ON f.thesis_id = t.id ORDER BY t.updated_at DESC`);
      return json(response, 200, { papers: paperResult.rows.map(fromRow), theses: thesisResult.rows.map(thesisFromRow) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  return json(response, 404, { error: "Ruta no encontrada" });
}

function serveFile(request, response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = vendorFiles.get(relativePath) || (publicFiles.has(relativePath) ? path.join(root, relativePath) : null);
  if (!filePath) return response.writeHead(404).end("Not found");
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) return response.writeHead(404).end("Not found");
    const cacheControl = path.extname(filePath) === ".png" ? "public, max-age=86400" : "no-cache, no-store, must-revalidate";
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)], "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'", "Referrer-Policy": "no-referrer" });
    fs.createReadStream(filePath).pipe(response);
  });
}

async function initialize() {
  if (!databaseUrl) throw new Error("DATABASE_URL no está configurada");
  if (!appPassword || !sessionSecret) throw new Error("APP_PASSWORD y SESSION_SECRET son obligatorias");
  await pool.query(`CREATE TABLE IF NOT EXISTS papers (
    id UUID PRIMARY KEY, title TEXT NOT NULL, journal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Borrador',
    quartile TEXT, coauthors TEXT, affiliation TEXT, submitted_at DATE, link TEXT, notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("ALTER TABLE papers ADD COLUMN IF NOT EXISTS quartile TEXT");
  await pool.query("CREATE INDEX IF NOT EXISTS papers_updated_at_idx ON papers (updated_at DESC)");
  await pool.query(`CREATE TABLE IF NOT EXISTS theses (
    id UUID PRIMARY KEY, title TEXT NOT NULL, university TEXT NOT NULL, degree TEXT NOT NULL, link TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS theses_updated_at_idx ON theses (updated_at DESC)");
  await pool.query(`CREATE TABLE IF NOT EXISTS paper_pdfs (
    paper_id UUID PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT 'application/pdf', size_bytes INTEGER NOT NULL,
    content BYTEA NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS thesis_pdfs (
    thesis_id UUID PRIMARY KEY REFERENCES theses(id) ON DELETE CASCADE,
    filename TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT 'application/pdf', size_bytes INTEGER NOT NULL,
    content BYTEA NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      if (pathname.startsWith("/api/")) await api(request, response, pathname);
      else serveFile(request, response, pathname);
    } catch (error) {
      console.error(error);
      const tooLarge = error.message === "El PDF supera el límite de 25 MB";
      if (!response.headersSent) json(response, tooLarge ? 413 : 500, { error: tooLarge ? error.message : "Error interno" });
      else response.end();
    }
  }).listen(port, "0.0.0.0", () => console.log(`Papers CHVN disponible en el puerto ${port}`));
}

initialize().catch(error => { console.error(error); process.exit(1); });
