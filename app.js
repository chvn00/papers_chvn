const STORAGE_KEY = "papers_chvn_v1";
const STATUSES = ["Borrador", "En preparación", "Listo para envío", "Enviado", "En revisión", "Revisión solicitada", "Reenviado", "Aceptado", "Publicado", "Rechazado", "Retirado"];
const ACTIVE = new Set(["Listo para envío", "Enviado", "En revisión", "Revisión solicitada", "Reenviado"]);
const SUCCESS = new Set(["Aceptado", "Publicado"]);
const FINAL = new Set(["Aceptado", "Publicado", "Rechazado", "Retirado"]);
const $ = selector => document.querySelector(selector);
const elements = { list: $("#paperList"), empty: $("#emptyState"), statistics: $("#statisticsPanel"), dialog: $("#paperDialog"), form: $("#paperForm"), thesisDialog: $("#thesisDialog"), thesisForm: $("#thesisForm"), congressDialog: $("#congressDialog"), congressForm: $("#congressForm"), search: $("#searchInput"), statusFilter: $("#statusFilter"), sort: $("#sortFilter"), toast: $("#toast"), authGate: $("#authGate"), loginForm: $("#loginForm"), loginError: $("#loginError"), pdfDialog: $("#pdfDialog"), pdfFrame: $("#pdfFrame"), pdfPages: $("#pdfPages") };
let papers = loadLocalPapers();
let theses = [];
let congresses = [];
let currentLibraryTab = "working";
let thesisFormCategory = "Propia";
let pdfJsPromise;
let activePdfDocument;
let pdfRenderToken = 0;

function loadLocalPapers() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } }
function saveLocalMirror() { localStorage.setItem(STORAGE_KEY, JSON.stringify(papers)); }
function escapeHTML(value = "") { return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function safeURL(value) { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } }
function formatDate(value) { if (!value) return "Sin fecha de envío"; return new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)); }
function badgeClass(status) { if (SUCCESS.has(status)) return "accepted"; if (["Rechazado", "Retirado"].includes(status)) return "rejected"; return ""; }

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { showLogin(); throw new Error(data.error || "Sesión requerida"); }
  if (!response.ok) throw new Error(data.error || "No fue posible completar la operación");
  return data;
}

function showLogin() {
  document.body.classList.add("app-locked");
  elements.authGate.hidden = false;
  setTimeout(() => $("#password").focus(), 50);
}

function showApp() {
  elements.authGate.hidden = true;
  document.body.classList.remove("app-locked");
}

async function loadDatabase() {
  const localBackup = loadLocalPapers();
  let [remote, remoteTheses, remoteCongresses] = await Promise.all([request("/api/papers"), request("/api/theses"), request("/api/congresses")]);
  if (!remote.length && localBackup.length) {
    const migration = await request("/api/import", { method: "POST", body: JSON.stringify({ papers: localBackup, replace: false }) });
    remote = Array.isArray(migration) ? migration : migration.papers;
    if (!Array.isArray(migration) && Array.isArray(migration.theses)) remoteTheses = migration.theses;
    if (!Array.isArray(migration) && Array.isArray(migration.congresses)) remoteCongresses = migration.congresses;
    showToast(`${localBackup.length} registros migrados a PostgreSQL`);
  }
  papers = remote;
  theses = remoteTheses;
  congresses = remoteCongresses;
  saveLocalMirror();
  render();
}

async function start() {
  try {
    await request("/api/session");
    showApp();
    await loadDatabase();
  } catch { showLogin(); }
}

function filteredPapers() {
  const query = elements.search.value.trim().toLocaleLowerCase("es");
  const status = elements.statusFilter.value;
  return papers.filter(paper => {
    const inCurrentTab = currentLibraryTab === "published" ? paper.status === "Publicado" : paper.status !== "Publicado";
    return inCurrentTab && (!query || [paper.title, paper.journal, paper.coauthors, paper.citation, paper.notes].join(" ").toLocaleLowerCase("es").includes(query)) && (currentLibraryTab === "published" || !status || paper.status === status);
  }).sort((a, b) => {
    if (currentLibraryTab === "published") {
      const yearDifference = (Number(publicationYear(b)) || 0) - (Number(publicationYear(a)) || 0);
      return yearDifference || (b.updatedAt || "").localeCompare(a.updatedAt || "");
    }
    if (elements.sort.value === "title-asc") return a.title.localeCompare(b.title, "es");
    if (elements.sort.value === "submitted-desc") return (b.submittedAt || "").localeCompare(a.submittedAt || "");
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
}

function publicationYear(paper) {
  const datedValue = paper.submittedAt || paper.updatedAt || "";
  return String(datedValue).match(/^\d{4}/)?.[0] || "Sin año";
}

function filteredTheses() {
  const query = elements.search.value.trim().toLocaleLowerCase("es");
  const category = currentLibraryTab === "directed" ? "Dirigida" : currentLibraryTab === "evaluated" ? "Evaluada" : "Propia";
  return theses.filter(thesis => (thesis.category || "Propia") === category && (!query || [thesis.title, thesis.university, thesis.degree, thesis.year].join(" ").toLocaleLowerCase("es").includes(query)))
    .sort((a, b) => ["directed", "evaluated"].includes(currentLibraryTab) ? (Number(b.year || documentYear(b)) || 0) - (Number(a.year || documentYear(a)) || 0) || (b.updatedAt || "").localeCompare(a.updatedAt || "") : (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

function filteredCongresses() {
  const query = elements.search.value.trim().toLocaleLowerCase("es");
  return congresses.filter(congress => !query || [congress.title, congress.eventName, congress.location, congress.citation, congress.notes].join(" ").toLocaleLowerCase("es").includes(query))
    .sort((a, b) => (b.eventDate || "").localeCompare(a.eventDate || "") || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

function paperCardHTML(paper) {
  const link = safeURL(paper.link);
  const published = paper.status === "Publicado";
  const medal = published ? `<div class="quartile-medal" aria-label="Cuartil ${escapeHTML(paper.quartile || "sin registrar")}" title="Publicación ${escapeHTML(paper.quartile || "sin cuartil")}"><span>${escapeHTML(paper.quartile || "Q?")}</span></div>` : "";
  const publicationControl = link ? `<a class="publication-link" href="${escapeHTML(link)}" target="_blank" rel="noopener">Ver publicación ↗</a><button class="publication-link-edit" type="button" data-publication-link="${paper.id}" aria-label="Cambiar enlace publicado" title="Cambiar enlace">✎</button>` : `<button class="publication-link-add" type="button" data-publication-link="${paper.id}">＋ Cargar enlace publicado</button>`;
  const citationControl = published ? `<div class="citation-row"><p title="${escapeHTML(paper.citation || "Cita no registrada")}">${escapeHTML(paper.citation || "Cita no registrada")}</p>${paper.citation ? `<button type="button" data-copy-citation="${paper.id}">Copiar cita</button>` : `<button type="button" data-add-citation="${paper.id}">Agregar cita</button>`}</div>` : "";
  const folderControl = published ? "" : paper.folderPath ? `<button class="project-folder-button" type="button" data-open-folder="${paper.id}" title="Abrir la carpeta del proyecto en Finder">Abrir carpeta</button>` : `<button class="project-folder-button empty" type="button" data-add-folder="${paper.id}">＋ Carpeta</button>`;
  return `<article class="paper-card ${paper.hasPdf ? "has-pdf" : ""} ${published ? "published" : ""}" data-paper-id="${paper.id}" ${paper.hasPdf ? `tabindex="0" role="button" aria-label="Previsualizar PDF de ${escapeHTML(paper.title)}"` : ""}>${medal}<div class="paper-card-main"><span class="badge ${badgeClass(paper.status)}">${escapeHTML(paper.status)}</span><h3>${escapeHTML(paper.title)}</h3><div class="paper-meta"><span><strong>Journal</strong>${escapeHTML(paper.journal)}</span><span><strong>Envío</strong>${formatDate(paper.submittedAt)}</span>${paper.coauthors ? `<span class="paper-coauthors"><strong>Coautores</strong>${escapeHTML(paper.coauthors)}</span>` : ""}</div>${paper.notes ? `<p class="paper-notes">${escapeHTML(paper.notes)}</p>` : ""}</div><div class="publication-row"><strong>PUBLICACIÓN</strong><div>${publicationControl}</div></div>${citationControl}<div class="card-footer"><div class="paper-resources">${folderControl}${paper.hasPdf ? `<button class="paper-link pdf-open" type="button" data-preview-pdf="${paper.id}" title="${escapeHTML(paper.pdfName)}">Ver PDF</button>` : ""}<button class="pdf-upload" type="button" data-upload-pdf="${paper.id}">${paper.hasPdf ? "Reemplazar PDF" : "Cargar PDF"}</button></div><div class="card-actions"><button class="icon-button" type="button" data-edit="${paper.id}" aria-label="Editar ${escapeHTML(paper.title)}">✎</button><button class="icon-button" type="button" data-delete="${paper.id}" aria-label="Eliminar ${escapeHTML(paper.title)}">×</button></div></div></article>`;
}

function thesisCardHTML(thesis) {
  const link = safeURL(thesis.link);
  const directed = thesis.category === "Dirigida";
  const evaluated = thesis.category === "Evaluada";
  const degreeMedal = directed ? `<div class="quartile-medal degree-medal ${thesis.degree === "Maestría" ? "master-medal" : ""}" aria-label="Tesis de ${escapeHTML(thesis.degree)}" title="${escapeHTML(thesis.degree)}"><span>${thesis.degree === "Maestría" ? "Master" : "DOC"}</span></div>` : "";
  const badge = directed ? "Tesis dirigida" : evaluated ? "Tesis evaluada" : "Tesis";
  return `<article class="paper-card thesis-card ${directed ? "directed-thesis-card" : ""} ${evaluated ? "evaluated-thesis-card" : ""} ${thesis.hasPdf ? "has-pdf" : ""}" data-thesis-id="${thesis.id}" ${thesis.hasPdf ? `tabindex="0" role="button" aria-label="Previsualizar PDF de ${escapeHTML(thesis.title)}"` : ""}>${degreeMedal}<div class="paper-card-main"><span class="badge thesis-badge">${badge}</span><h3>${escapeHTML(thesis.title)}</h3><div class="paper-meta thesis-meta"><span><strong>Universidad</strong>${escapeHTML(thesis.university)}</span><span><strong>${directed ? "Nivel" : "Grado"}</strong>${escapeHTML(thesis.degree)}</span>${directed || evaluated ? `<span><strong>Año</strong>${escapeHTML(thesis.year || documentYear(thesis))}</span>` : ""}</div></div><div class="publication-row thesis-link-row"><strong>ENLACE</strong><div>${link ? `<a class="publication-link" href="${escapeHTML(link)}" target="_blank" rel="noopener">Abrir tesis ↗</a>` : `<span class="thesis-no-link">Sin enlace registrado</span>`}</div></div><div class="card-footer thesis-footer"><div class="paper-resources">${thesis.hasPdf ? `<button class="paper-link pdf-open" type="button" data-preview-thesis-pdf="${thesis.id}" title="${escapeHTML(thesis.pdfName)}">Ver PDF</button>` : ""}<button class="pdf-upload" type="button" data-upload-thesis-pdf="${thesis.id}">${thesis.hasPdf ? "Reemplazar PDF" : "Cargar PDF"}</button></div><div class="card-actions"><button class="icon-button" type="button" data-edit-thesis="${thesis.id}" aria-label="Editar ${escapeHTML(thesis.title)}">✎</button><button class="icon-button" type="button" data-delete-thesis="${thesis.id}" aria-label="Eliminar ${escapeHTML(thesis.title)}">×</button></div></div></article>`;
}

function congressCardHTML(congress) {
  const link = safeURL(congress.link);
  const citationControl = `<div class="citation-row"><p title="${escapeHTML(congress.citation || "Cita no registrada")}">${escapeHTML(congress.citation || "Cita no registrada")}</p>${congress.citation ? `<button type="button" data-copy-congress-citation="${congress.id}">Copiar cita</button>` : `<button type="button" data-add-congress-citation="${congress.id}">Agregar cita</button>`}</div>`;
  return `<article class="paper-card congress-card" data-congress-id="${congress.id}"><div class="paper-card-main"><span class="badge congress-badge">Congreso</span><h3>${escapeHTML(congress.title)}</h3><div class="paper-meta congress-meta"><span><strong>Evento</strong>${escapeHTML(congress.eventName)}</span><span><strong>Fecha</strong>${formatDate(congress.eventDate)}</span>${congress.location ? `<span><strong>Lugar</strong>${escapeHTML(congress.location)}</span>` : ""}</div>${congress.notes ? `<p class="paper-notes">${escapeHTML(congress.notes)}</p>` : ""}</div><div class="publication-row congress-link-row"><strong>ENLACE</strong><div>${link ? `<a class="publication-link" href="${escapeHTML(link)}" target="_blank" rel="noopener">Abrir evento ↗</a>` : `<span class="thesis-no-link">Sin enlace registrado</span>`}</div></div>${citationControl}<div class="card-footer"><span class="congress-date-mark">${formatDate(congress.eventDate)}</span><div class="card-actions"><button class="icon-button" type="button" data-edit-congress="${congress.id}" aria-label="Editar ${escapeHTML(congress.title)}">✎</button><button class="icon-button" type="button" data-delete-congress="${congress.id}" aria-label="Eliminar ${escapeHTML(congress.title)}">×</button></div></div></article>`;
}

function documentYear(item) {
  return String(item.submittedAt || item.createdAt || item.updatedAt || "").match(/^\d{4}/)?.[0] || "Sin año";
}

function degreeGroup(value) {
  const degree = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (degree.includes("doctor")) return "Doctorado";
  if (degree.includes("maestr") || degree.includes("master") || degree.includes("magist")) return "Maestría";
  return "Otro";
}

function processGroup(status) {
  if (["En revisión", "Revisión solicitada", "Reenviado"].includes(status)) return "revision";
  return ({ "Borrador": "draft", "En preparación": "preparing", "Listo para envío": "ready", "Enviado": "submitted" })[status] || "other";
}

function yearlyStackedEntries(items, yearForItem, groupForItem, series) {
  const counts = new Map();
  items.forEach(item => {
    const year = String(yearForItem(item) || "Sin año");
    if (!counts.has(year)) counts.set(year, Object.fromEntries(series.map(part => [part.key, 0])));
    const group = groupForItem(item);
    const target = counts.get(year);
    target[group in target ? group : series.at(-1).key] += 1;
  });
  return [...counts].map(([year, values]) => ({ year, values, total: Object.values(values).reduce((sum, value) => sum + value, 0) }))
    .sort((a, b) => a.year === "Sin año" ? 1 : b.year === "Sin año" ? -1 : Number(a.year) - Number(b.year));
}

function drawYearChart(canvas, entries, series, title) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(280, Math.round(bounds.width || 560));
  const height = Math.max(260, Math.round(bounds.height || 310));
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * scale; canvas.height = height * scale;
  const context = canvas.getContext("2d");
  context.scale(scale, scale);
  context.fillStyle = "#fff"; context.fillRect(0, 0, width, height);
  context.fillStyle = "#173b57"; context.font = "700 15px Georgia, serif"; context.textAlign = "left"; context.textBaseline = "top";
  context.fillText(`${title} · documentos por año`, 18, 14);
  const seriesTotals = Object.fromEntries(series.map(part => [part.key, entries.reduce((sum, entry) => sum + entry.values[part.key], 0)]));
  let legendX = 18; let legendY = 40;
  context.font = "600 9px system-ui";
  series.forEach(part => {
    const label = `${part.label} (${seriesTotals[part.key]})`;
    const itemWidth = context.measureText(label).width + 28;
    if (legendX + itemWidth > width - 15) { legendX = 18; legendY += 17; }
    context.fillStyle = part.color; context.fillRect(legendX, legendY + 1, 10, 10);
    context.fillStyle = "#526f84"; context.textAlign = "left"; context.textBaseline = "top"; context.fillText(label, legendX + 15, legendY);
    legendX += itemWidth;
  });
  if (!entries.length) {
    context.fillStyle = "#71899b"; context.font = "600 13px system-ui"; context.textAlign = "center";
    context.fillText("Sin documentos registrados", width / 2, height / 2);
    return;
  }
  const margin = { top: legendY + 25, right: 16, bottom: 42, left: 42 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(...entries.map(entry => entry.total), 1);
  const tickCount = Math.min(maxValue, 5);
  context.font = "10px system-ui"; context.textBaseline = "middle";
  for (let index = 0; index <= tickCount; index += 1) {
    const value = Math.round(maxValue * index / tickCount);
    const y = margin.top + plotHeight - (plotHeight * value / maxValue);
    context.strokeStyle = "#e1e9ef"; context.lineWidth = 1; context.beginPath(); context.moveTo(margin.left, y); context.lineTo(width - margin.right, y); context.stroke();
    context.fillStyle = "#71899b"; context.textAlign = "right"; context.fillText(String(value), margin.left - 8, y);
  }
  const slot = plotWidth / entries.length;
  const barWidth = Math.min(58, slot * .58);
  entries.forEach((entry, index) => {
    const x = margin.left + slot * index + (slot - barWidth) / 2;
    let currentY = margin.top + plotHeight;
    series.forEach(part => {
      const value = entry.values[part.key];
      if (!value) return;
      const segmentHeight = plotHeight * value / maxValue;
      currentY -= segmentHeight;
      context.fillStyle = part.color; context.fillRect(x, currentY, barWidth, segmentHeight);
      context.strokeStyle = "rgba(255,255,255,.8)"; context.lineWidth = 1; context.strokeRect(x, currentY, barWidth, segmentHeight);
      if (segmentHeight >= 15) {
        context.fillStyle = part.textColor || "#fff"; context.font = "800 9px system-ui"; context.textAlign = "center"; context.textBaseline = "middle";
        context.fillText(String(value), x + barWidth / 2, currentY + segmentHeight / 2);
      }
    });
    context.fillStyle = "#173b57"; context.font = "800 11px system-ui"; context.textAlign = "center"; context.textBaseline = "bottom"; context.fillText(String(entry.total), x + barWidth / 2, currentY - 5);
    context.fillStyle = "#526f84"; context.font = "10px system-ui"; context.textBaseline = "top"; context.fillText(entry.year, x + barWidth / 2, margin.top + plotHeight + 10);
  });
}

function renderStatistics() {
  const processSeries = [
    { key: "draft", label: "Borrador", color: "#71869b" },
    { key: "preparing", label: "En preparación", color: "#2e78bf" },
    { key: "ready", label: "Listo para envío", color: "#24a7b8" },
    { key: "submitted", label: "Enviado", color: "#2fa36f" },
    { key: "revision", label: "En revisión", color: "#d3ab5f", textColor: "#173b57" },
    { key: "other", label: "Otros estados", color: "#8b67b5" }
  ];
  const quartileSeries = [
    { key: "Q1", label: "Q1", color: "#d3ab5f", textColor: "#173b57" },
    { key: "Q2", label: "Q2", color: "#58a5d8" },
    { key: "Q3", label: "Q3", color: "#45a979" },
    { key: "Q4", label: "Q4", color: "#8b67b5" },
    { key: "other", label: "Sin cuartil", color: "#71869b" }
  ];
  const degreeSeries = [
    { key: "Maestría", label: "Maestría", color: "#35a578" },
    { key: "Doctorado", label: "Doctorado", color: "#225ea8" },
    { key: "Otro", label: "Otro grado", color: "#8b67b5" }
  ];
  const charts = [
    { id: "Working", title: "Papers en proceso", items: papers.filter(paper => paper.status !== "Publicado"), year: documentYear, group: paper => processGroup(paper.status), series: processSeries },
    { id: "Published", title: "Papers publicados", items: papers.filter(paper => paper.status === "Publicado"), year: publicationYear, group: paper => quartileSeries.some(part => part.key === paper.quartile) ? paper.quartile : "other", series: quartileSeries },
    { id: "Directed", title: "Tesis dirigidas", items: theses.filter(thesis => thesis.category === "Dirigida"), year: thesis => thesis.year || documentYear(thesis), group: thesis => degreeGroup(thesis.degree), series: degreeSeries },
    { id: "Evaluated", title: "Tesis evaluadas", items: theses.filter(thesis => thesis.category === "Evaluada"), year: thesis => thesis.year || documentYear(thesis), group: thesis => degreeGroup(thesis.degree), series: degreeSeries }
  ];
  charts.forEach(chart => {
    const entries = yearlyStackedEntries(chart.items, chart.year, chart.group, chart.series);
    $(`#chart${chart.id}Total`).textContent = chart.items.length;
    $(`#chart${chart.id}Summary`).textContent = entries.length ? entries.map(entry => `${entry.year}: ${entry.total}`).join(" · ") : "Sin datos";
    drawYearChart($(`#chart${chart.id}`), entries, chart.series, chart.title);
  });
}

function render() {
  const viewingTheses = ["theses", "directed", "evaluated"].includes(currentLibraryTab);
  const viewingCongresses = currentLibraryTab === "congresses";
  const viewingDirected = currentLibraryTab === "directed";
  const viewingEvaluated = currentLibraryTab === "evaluated";
  const viewingStatistics = currentLibraryTab === "statistics";
  const visible = viewingStatistics ? [] : viewingCongresses ? filteredCongresses() : viewingTheses ? filteredTheses() : filteredPapers();
  if (viewingStatistics) elements.list.innerHTML = "";
  else if (viewingCongresses) {
    let activeYear = "";
    elements.list.innerHTML = visible.map(congress => {
      const year = congress.eventDate?.slice(0, 4) || "Sin año";
      const yearCount = visible.filter(item => (item.eventDate?.slice(0, 4) || "Sin año") === year).length;
      const heading = year !== activeYear ? `<div class="year-heading congress-year-heading"><span>${escapeHTML(year)}</span><small>${yearCount} ${yearCount === 1 ? "congreso" : "congresos"}</small></div>` : "";
      activeYear = year;
      return `${heading}${congressCardHTML(congress)}`;
    }).join("");
  }
  else if (viewingDirected || viewingEvaluated) {
    let activeYear = "";
    elements.list.innerHTML = visible.map(thesis => {
      const year = String(thesis.year || documentYear(thesis));
      const yearCount = visible.filter(item => String(item.year || documentYear(item)) === year).length;
      const singular = viewingEvaluated ? "tesis evaluada" : "tesis dirigida";
      const plural = viewingEvaluated ? "tesis evaluadas" : "tesis dirigidas";
      const heading = year !== activeYear ? `<div class="year-heading"><span>${escapeHTML(year)}</span><small>${yearCount} ${yearCount === 1 ? singular : plural}</small></div>` : "";
      activeYear = year;
      return `${heading}${thesisCardHTML(thesis)}`;
    }).join("");
  } else if (viewingTheses) elements.list.innerHTML = visible.map(thesisCardHTML).join("");
  else if (currentLibraryTab === "published") {
    let activeYear = "";
    elements.list.innerHTML = visible.map(paper => {
      const year = publicationYear(paper);
      const heading = year !== activeYear ? `<div class="year-heading"><span>${escapeHTML(year)}</span><small>${visible.filter(item => publicationYear(item) === year).length} ${visible.filter(item => publicationYear(item) === year).length === 1 ? "paper" : "papers"}</small></div>` : "";
      activeYear = year;
      return `${heading}${paperCardHTML(paper)}`;
    }).join("");
  } else {
    const knownStatuses = STATUSES.filter(status => status !== "Publicado");
    const extraStatuses = [...new Set(visible.map(paper => paper.status).filter(status => !knownStatuses.includes(status)))];
    elements.list.innerHTML = [...knownStatuses, ...extraStatuses].map(status => {
      const stagePapers = visible.filter(paper => paper.status === status);
      if (!stagePapers.length) return "";
      const heading = `<div class="year-heading stage-heading"><span>${escapeHTML(status)}</span><small>${stagePapers.length} ${stagePapers.length === 1 ? "paper" : "papers"}</small></div>`;
      return `${heading}${stagePapers.map(paperCardHTML).join("")}`;
    }).join("");
  }
  elements.statistics.hidden = !viewingStatistics;
  elements.empty.hidden = viewingStatistics || visible.length > 0;
  elements.list.hidden = viewingStatistics || visible.length === 0;
  $("#emptyTitle").textContent = viewingCongresses ? "Aún no hay congresos registrados" : viewingEvaluated ? "Aún no hay tesis evaluadas" : viewingDirected ? "Aún no hay tesis dirigidas" : viewingTheses ? "Aún no hay tesis registradas" : currentLibraryTab === "published" ? "Aún no hay papers publicados" : "Aquí comienza tu archivo";
  $("#emptyMessage").textContent = viewingCongresses ? "Agrega tu primera participación y la verás organizada por fecha." : viewingEvaluated ? "Agrega la primera tesis que hayas evaluado." : viewingDirected ? "Agrega una tesis de Maestría o Doctorado que hayas dirigido." : viewingTheses ? "Agrega la primera tesis con su universidad, grado y enlace." : currentLibraryTab === "published" ? "Cuando un paper cambie a Publicado aparecerá aquí, organizado por año." : "Agrega tu primer manuscrito para empezar a seguir su recorrido editorial.";
  $("#emptyAddButton").hidden = currentLibraryTab === "published";
  $("#emptyAddButton").textContent = viewingCongresses ? "Registrar un congreso" : viewingEvaluated ? "Registrar tesis evaluada" : viewingDirected ? "Registrar tesis dirigida" : viewingTheses ? "Registrar una tesis" : "Registrar un paper";
  $("#resultsCount").textContent = viewingStatistics ? "4 gráficos" : viewingCongresses ? `${visible.length} ${visible.length === 1 ? "congreso" : "congresos"}` : viewingTheses ? `${visible.length} ${visible.length === 1 ? "tesis" : "tesis"}` : `${visible.length} ${visible.length === 1 ? "registro" : "registros"}`;
  $("#workingTabCount").textContent = papers.filter(p => p.status !== "Publicado").length;
  $("#publishedTabCount").textContent = papers.filter(p => p.status === "Publicado").length;
  $("#congressesTabCount").textContent = congresses.length;
  $("#thesesTabCount").textContent = theses.filter(thesis => (thesis.category || "Propia") === "Propia").length;
  $("#directedTabCount").textContent = theses.filter(thesis => thesis.category === "Dirigida").length;
  $("#evaluatedTabCount").textContent = theses.filter(thesis => thesis.category === "Evaluada").length;
  $("#statTotal").textContent = papers.length;
  $("#statDraft").textContent = papers.filter(p => p.status === "Borrador").length;
  $("#statPreparing").textContent = papers.filter(p => p.status === "En preparación").length;
  $("#statSubmitted").textContent = papers.filter(p => p.status === "Enviado").length;
  $("#statReview").textContent = papers.filter(p => p.status === "En revisión").length;
  $("#statPublished").textContent = papers.filter(p => p.status === "Publicado").length;
  ["Q1", "Q2", "Q3", "Q4"].forEach(quartile => {
    $(`#stat${quartile}`).textContent = papers.filter(p => p.status === "Publicado" && p.quartile === quartile).length;
  });
  if (viewingStatistics) requestAnimationFrame(renderStatistics);
}

function setLibraryTab(tab) {
  currentLibraryTab = tab;
  document.querySelectorAll("[data-library-tab]").forEach(button => {
    const selected = button.dataset.libraryTab === tab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  const published = tab === "published";
  const congressView = tab === "congresses";
  const thesisView = ["theses", "directed", "evaluated"].includes(tab);
  const viewingStatistics = tab === "statistics";
  const simpleView = published || congressView || thesisView || viewingStatistics;
  $("#quartileStats").hidden = !published;
  $("#libraryFilters").hidden = viewingStatistics;
  $("#statusFilterField").hidden = simpleView;
  $("#sortFilterField").hidden = simpleView;
  $("#libraryFilters").classList.toggle("published", simpleView);
  $("#newPaperButton").textContent = congressView ? "+ Nuevo congreso" : tab === "evaluated" ? "+ Tesis evaluada" : tab === "directed" ? "+ Tesis dirigida" : tab === "theses" ? "+ Nueva tesis" : "+ Nuevo paper";
  $("#libraryTitle").textContent = viewingStatistics ? "Estadísticas" : congressView ? "Congresos" : tab === "evaluated" ? "Tesis evaluadas" : tab === "directed" ? "Tesis dirigidas" : tab === "theses" ? "Tesis CHVN" : "Manuscritos";
  elements.search.placeholder = congressView ? "Buscar por trabajo, congreso, lugar o notas…" : thesisView ? "Buscar por título, universidad o grado…" : "Buscar por título, revista o coautor…";
  elements.statusFilter.value = "";
  elements.search.value = "";
  render();
}

function openForm(paper = null) {
  elements.form.reset(); $("#paperId").value = paper?.id || "";
  $("#dialogEyebrow").textContent = paper ? "Editar registro" : "Nuevo registro";
  $("#dialogTitle").textContent = paper ? "Actualizar paper" : "Agregar paper";
  if (paper) ["title", "journal", "status", "quartile", "coauthors", "affiliation", "folderPath", "submittedAt", "link", "citation", "notes"].forEach(key => $(`#${key}`).value = paper[key] || "");
  syncQuartileField();
  elements.dialog.showModal(); setTimeout(() => $("#title").focus(), 50);
}
function syncQuartileField() {
  const published = $("#status").value === "Publicado";
  $("#quartileField").hidden = !published;
  $("#citationField").hidden = !published;
  $("#folderPathField").hidden = published;
  $("#quartile").required = published;
  if (!published) { $("#quartile").value = ""; $("#citation").value = ""; }
}
function closeForm() { elements.dialog.close(); }
function openThesisForm(thesis = null, category = currentLibraryTab === "directed" ? "Dirigida" : currentLibraryTab === "evaluated" ? "Evaluada" : "Propia") {
  thesisFormCategory = category;
  const directed = category === "Dirigida";
  const evaluated = category === "Evaluada";
  elements.thesisForm.reset();
  $("#thesisId").value = thesis?.id || "";
  $("#thesisDialogEyebrow").textContent = evaluated ? "Evaluación académica" : directed ? "Dirección académica" : thesis ? "Editar tesis" : "Nueva tesis";
  $("#thesisDialogTitle").textContent = evaluated ? (thesis ? "Actualizar tesis evaluada" : "Agregar tesis evaluada") : directed ? (thesis ? "Actualizar tesis dirigida" : "Agregar tesis dirigida") : thesis ? "Actualizar tesis" : "Agregar tesis";
  $("#thesisDegreeField").hidden = directed;
  $("#thesisDegree").disabled = directed;
  $("#directedDegreeField").hidden = !directed;
  $("#directedDegree").disabled = !directed;
  $("#directedYearField").hidden = !(directed || evaluated);
  $("#directedYear").disabled = !(directed || evaluated);
  if (directed || evaluated) $("#directedYear").value = thesis?.year || new Date().getFullYear();
  if (thesis) {
    $("#thesisTitle").value = thesis.title || "";
    $("#thesisUniversity").value = thesis.university || "";
    if (directed) $("#directedDegree").value = thesis.degree || "Maestría";
    else $("#thesisDegree").value = thesis.degree || "";
    $("#thesisLink").value = thesis.link || "";
  }
  elements.thesisDialog.showModal();
  setTimeout(() => $("#thesisTitle").focus(), 50);
}
function closeThesisForm() { elements.thesisDialog.close(); }
function openCongressForm(congress = null) {
  elements.congressForm.reset();
  $("#congressId").value = congress?.id || "";
  $("#congressDialogEyebrow").textContent = congress ? "Editar registro" : "Nuevo registro";
  $("#congressDialogTitle").textContent = congress ? "Actualizar congreso" : "Agregar congreso";
  if (congress) {
    $("#congressTitle").value = congress.title || "";
    $("#congressName").value = congress.eventName || "";
    $("#congressDate").value = congress.eventDate || "";
    $("#congressLocation").value = congress.location || "";
    $("#congressLink").value = congress.link || "";
    $("#congressCitation").value = congress.citation || "";
    $("#congressNotes").value = congress.notes || "";
  }
  elements.congressDialog.showModal();
  setTimeout(() => $("#congressTitle").focus(), 50);
}
function closeCongressForm() { elements.congressDialog.close(); }
function openCurrentForm() { currentLibraryTab === "congresses" ? openCongressForm() : ["theses", "directed", "evaluated"].includes(currentLibraryTab) ? openThesisForm() : openForm(); }
function showToast(message) { elements.toast.textContent = message; elements.toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 2800); }

elements.loginForm.addEventListener("submit", async event => {
  event.preventDefault(); elements.loginError.textContent = "";
  const button = elements.loginForm.querySelector("button"); button.disabled = true;
  try { await request("/api/login", { method: "POST", body: JSON.stringify({ password: $("#password").value }) }); $("#password").value = ""; showApp(); await loadDatabase(); }
  catch (error) { elements.loginError.textContent = error.message; }
  finally { button.disabled = false; }
});

$("#logoutButton").addEventListener("click", async () => { await request("/api/logout", { method: "POST" }); showLogin(); });
elements.form.addEventListener("submit", async event => {
  event.preventDefault();
  const id = $("#paperId").value;
  const paper = {}; ["title", "journal", "status", "quartile", "coauthors", "affiliation", "folderPath", "submittedAt", "link", "citation", "notes"].forEach(key => paper[key] = $(`#${key}`).value.trim());
  try {
    const saved = await request(id ? `/api/papers/${id}` : "/api/papers", { method: id ? "PUT" : "POST", body: JSON.stringify(paper) });
    if (id) papers = papers.map(item => item.id === id ? { ...saved, hasPdf: item.hasPdf, pdfName: item.pdfName, pdfSize: item.pdfSize } : item); else papers.unshift(saved);
    saveLocalMirror(); render(); closeForm(); showToast(id ? "Registro actualizado en PostgreSQL" : "Paper guardado en PostgreSQL");
  } catch (error) { alert(error.message); }
});

elements.thesisForm.addEventListener("submit", async event => {
  event.preventDefault();
  const id = $("#thesisId").value;
  const thesis = { title: $("#thesisTitle").value.trim(), university: $("#thesisUniversity").value.trim(), degree: thesisFormCategory === "Dirigida" ? $("#directedDegree").value : $("#thesisDegree").value.trim(), year: thesisFormCategory === "Propia" ? null : Number($("#directedYear").value), category: thesisFormCategory, link: $("#thesisLink").value.trim() };
  try {
    const saved = await request(id ? `/api/theses/${id}` : "/api/theses", { method: id ? "PUT" : "POST", body: JSON.stringify(thesis) });
    if (id) theses = theses.map(item => item.id === id ? { ...saved, hasPdf: item.hasPdf, pdfName: item.pdfName, pdfSize: item.pdfSize } : item); else theses.unshift(saved);
    render(); closeThesisForm(); showToast(id ? "Tesis actualizada en PostgreSQL" : "Tesis guardada en PostgreSQL");
  } catch (error) { alert(error.message); }
});

elements.congressForm.addEventListener("submit", async event => {
  event.preventDefault();
  const id = $("#congressId").value;
  const congress = { title: $("#congressTitle").value.trim(), eventName: $("#congressName").value.trim(), eventDate: $("#congressDate").value, location: $("#congressLocation").value.trim(), link: $("#congressLink").value.trim(), citation: $("#congressCitation").value.trim(), notes: $("#congressNotes").value.trim() };
  try {
    const saved = await request(id ? `/api/congresses/${id}` : "/api/congresses", { method: id ? "PUT" : "POST", body: JSON.stringify(congress) });
    if (id) congresses = congresses.map(item => item.id === id ? saved : item); else congresses.unshift(saved);
    render(); closeCongressForm(); showToast(id ? "Congreso actualizado en PostgreSQL" : "Congreso guardado en PostgreSQL");
  } catch (error) { alert(error.message); }
});

elements.list.addEventListener("click", async event => {
  const editCongressId = event.target.closest("[data-edit-congress]")?.dataset.editCongress;
  const deleteCongressId = event.target.closest("[data-delete-congress]")?.dataset.deleteCongress;
  const copyCongressCitationId = event.target.closest("[data-copy-congress-citation]")?.dataset.copyCongressCitation;
  const addCongressCitationId = event.target.closest("[data-add-congress-citation]")?.dataset.addCongressCitation;
  const editThesisId = event.target.closest("[data-edit-thesis]")?.dataset.editThesis;
  const deleteThesisId = event.target.closest("[data-delete-thesis]")?.dataset.deleteThesis;
  const uploadThesisPdfId = event.target.closest("[data-upload-thesis-pdf]")?.dataset.uploadThesisPdf;
  const previewThesisPdfId = event.target.closest("[data-preview-thesis-pdf]")?.dataset.previewThesisPdf;
  const editId = event.target.closest("[data-edit]")?.dataset.edit;
  const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
  const uploadId = event.target.closest("[data-upload-pdf]")?.dataset.uploadPdf;
  const previewId = event.target.closest("[data-preview-pdf]")?.dataset.previewPdf;
  const publicationLinkId = event.target.closest("[data-publication-link]")?.dataset.publicationLink;
  const copyCitationId = event.target.closest("[data-copy-citation]")?.dataset.copyCitation;
  const addCitationId = event.target.closest("[data-add-citation]")?.dataset.addCitation;
  const openFolderId = event.target.closest("[data-open-folder]")?.dataset.openFolder;
  const addFolderId = event.target.closest("[data-add-folder]")?.dataset.addFolder;
  if (editCongressId) openCongressForm(congresses.find(item => item.id === editCongressId));
  if (copyCongressCitationId) copyCitation(congresses.find(item => item.id === copyCongressCitationId));
  if (addCongressCitationId) { openCongressForm(congresses.find(item => item.id === addCongressCitationId)); setTimeout(() => $("#congressCitation").focus(), 80); }
  if (deleteCongressId) {
    const congress = congresses.find(item => item.id === deleteCongressId);
    if (confirm(`¿Eliminar el congreso “${congress.title}”? Esta acción no se puede deshacer.`)) {
      try { await request(`/api/congresses/${deleteCongressId}`, { method: "DELETE" }); congresses = congresses.filter(item => item.id !== deleteCongressId); render(); showToast("Congreso eliminado"); }
      catch (error) { alert(error.message); }
    }
  }
  if (editThesisId) { const thesis = theses.find(item => item.id === editThesisId); openThesisForm(thesis, thesis.category || "Propia"); }
  if (uploadThesisPdfId) selectPdf(theses.find(thesis => thesis.id === uploadThesisPdfId), event.target.closest("[data-upload-thesis-pdf]"), "theses");
  if (previewThesisPdfId) openPdfPreview(theses.find(thesis => thesis.id === previewThesisPdfId), "theses");
  if (deleteThesisId) {
    const thesis = theses.find(item => item.id === deleteThesisId);
    if (confirm(`¿Eliminar la tesis “${thesis.title}”? Esta acción no se puede deshacer.`)) {
      try { await request(`/api/theses/${deleteThesisId}`, { method: "DELETE" }); theses = theses.filter(item => item.id !== deleteThesisId); render(); showToast("Tesis eliminada"); }
      catch (error) { alert(error.message); }
    }
  }
  if (editId) openForm(papers.find(p => p.id === editId));
  if (uploadId) selectPdf(papers.find(p => p.id === uploadId), event.target.closest("[data-upload-pdf]"));
  if (previewId) openPdfPreview(papers.find(p => p.id === previewId));
  if (publicationLinkId) editPublicationLink(papers.find(p => p.id === publicationLinkId));
  if (copyCitationId) copyCitation(papers.find(p => p.id === copyCitationId));
  if (addCitationId) { openForm(papers.find(p => p.id === addCitationId)); setTimeout(() => $("#citation").focus(), 80); }
  if (openFolderId) openProjectFolder(papers.find(p => p.id === openFolderId));
  if (addFolderId) { openForm(papers.find(p => p.id === addFolderId)); setTimeout(() => $("#folderPath").focus(), 80); }
  if (deleteId) {
    const paper = papers.find(p => p.id === deleteId);
    if (confirm(`¿Eliminar “${paper.title}”? Esta acción no se puede deshacer.`)) {
      try { await request(`/api/papers/${deleteId}`, { method: "DELETE" }); papers = papers.filter(p => p.id !== deleteId); saveLocalMirror(); render(); showToast("Registro eliminado"); }
      catch (error) { alert(error.message); }
    }
  }
  if (!event.target.closest("button, a")) {
    const paperId = event.target.closest("[data-paper-id]")?.dataset.paperId;
    const thesisId = event.target.closest("[data-thesis-id]")?.dataset.thesisId;
    if (paperId) {
      const paper = papers.find(item => item.id === paperId);
      if (paper.hasPdf) openPdfPreview(paper); else showToast("Carga un PDF para previsualizarlo");
    }
    if (thesisId) {
      const thesis = theses.find(item => item.id === thesisId);
      if (thesis.hasPdf) openPdfPreview(thesis, "theses"); else showToast("Carga un PDF para previsualizarlo");
    }
  }
});

function openProjectFolder(paper) {
  const folderPath = String(paper?.folderPath || "").trim();
  if (!folderPath) return showToast("Agrega primero la ruta de la carpeta");
  if (!folderPath.startsWith("/Users/cesarvalencia/")) return alert("La ruta debe comenzar por /Users/cesarvalencia/");
  window.location.href = `papers-chvn://open?path=${encodeURIComponent(folderPath)}`;
  showToast("Abriendo carpeta en Finder…");
}

async function copyCitation(paper) {
  if (!paper?.citation) return;
  try {
    await navigator.clipboard.writeText(paper.citation);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = paper.citation;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast("Cita copiada al portapapeles");
}

async function editPublicationLink(paper) {
  if (paper.status === "Publicado" && !paper.quartile) {
    openForm(paper);
    showToast("Selecciona primero el cuartil y agrega el enlace");
    setTimeout(() => $("#quartile").focus(), 80);
    return;
  }
  const value = prompt("Pega el enlace donde está publicado el paper. Déjalo vacío para quitarlo.", paper.link || "");
  if (value === null) return;
  const link = value.trim();
  if (link && !safeURL(link)) return alert("Ingresa un enlace válido que comience por http:// o https://");
  if (!link && paper.link && !confirm("¿Quieres quitar el enlace publicado de esta card?")) return;
  try {
    const saved = await request(`/api/papers/${paper.id}`, { method: "PUT", body: JSON.stringify({ ...paper, link }) });
    papers = papers.map(item => item.id === paper.id ? { ...saved, hasPdf: item.hasPdf, pdfName: item.pdfName, pdfSize: item.pdfSize } : item);
    saveLocalMirror();
    render();
    showToast(link ? "Enlace publicado guardado" : "Enlace publicado eliminado");
  } catch (error) { alert(error.message); }
}

elements.list.addEventListener("keydown", event => {
  if (!["Enter", " "].includes(event.key) || event.target.closest("button, a")) return;
  const paperId = event.target.closest("[data-paper-id]")?.dataset.paperId;
  const thesisId = event.target.closest("[data-thesis-id]")?.dataset.thesisId;
  const paper = papers.find(item => item.id === paperId);
  const thesis = theses.find(item => item.id === thesisId);
  if (paper?.hasPdf) { event.preventDefault(); openPdfPreview(paper); }
  if (thesis?.hasPdf) { event.preventDefault(); openPdfPreview(thesis, "theses"); }
});

async function renderMobilePdf(url) {
  const renderToken = ++pdfRenderToken;
  elements.pdfPages.innerHTML = '<p class="pdf-loading">Preparando todas las páginas…</p>';
  try {
    pdfJsPromise ||= import("/vendor/pdf.min.mjs");
    const [pdfjs, response] = await Promise.all([pdfJsPromise, fetch(url)]);
    if (response.status === 401) { showLogin(); throw new Error("Sesión requerida"); }
    if (!response.ok) throw new Error("No fue posible cargar el PDF");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
    const data = await response.arrayBuffer();
    if (renderToken !== pdfRenderToken) return;
    activePdfDocument = await pdfjs.getDocument({ data }).promise;
    elements.pdfPages.innerHTML = "";
    const availableWidth = Math.max(260, elements.pdfPages.clientWidth - 20);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.6);
    for (let pageNumber = 1; pageNumber <= activePdfDocument.numPages; pageNumber += 1) {
      if (renderToken !== pdfRenderToken) return;
      const page = await activePdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const cssScale = availableWidth / baseViewport.width;
      const viewport = page.getViewport({ scale: cssScale * pixelRatio });
      const pageElement = document.createElement("section");
      pageElement.className = "pdf-page";
      pageElement.setAttribute("aria-label", `Página ${pageNumber} de ${activePdfDocument.numPages}`);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(baseViewport.width * cssScale)}px`;
      canvas.style.height = `${Math.floor(baseViewport.height * cssScale)}px`;
      pageElement.append(canvas);
      elements.pdfPages.append(pageElement);
      await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
      page.cleanup();
    }
  } catch (error) {
    if (renderToken === pdfRenderToken) elements.pdfPages.innerHTML = `<p class="pdf-loading pdf-error">${escapeHTML(error.message)}. Usa “Abrir PDF” para verlo aparte.</p>`;
  }
}

function openPdfPreview(item, resource = "papers") {
  const url = `/api/${resource}/${item.id}/pdf`;
  const mobilePreview = window.matchMedia("(max-width: 560px)").matches;
  $("#pdfPreviewTitle").textContent = item.title;
  $("#openPdfNew").href = url;
  $("#downloadPdf").href = `${url}?download=1`;
  $("#downloadPdf").download = (item.pdfName || `${item.title}.pdf`).replace(/[\\/]/g, "-");
  $("#openPdfMobile").href = url;
  elements.pdfDialog.showModal();
  elements.pdfFrame.hidden = mobilePreview;
  elements.pdfPages.hidden = !mobilePreview;
  if (mobilePreview) renderMobilePdf(url);
  else elements.pdfFrame.src = url;
}

function closePdfPreview() {
  elements.pdfDialog.close();
}

function resetPdfPreview() {
  pdfRenderToken += 1;
  activePdfDocument?.destroy();
  activePdfDocument = null;
  elements.pdfFrame.src = "about:blank";
  elements.pdfPages.innerHTML = "";
}

$("#closePdfButton").addEventListener("click", closePdfPreview);
elements.pdfDialog.addEventListener("click", event => { if (event.target === elements.pdfDialog) closePdfPreview(); });
elements.pdfDialog.addEventListener("close", resetPdfPreview);

function selectPdf(item, button, resource = "papers") {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/pdf,.pdf";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.type && file.type !== "application/pdf") return alert("Selecciona un archivo PDF válido.");
    if (file.size > 25 * 1024 * 1024) return alert("El PDF no puede superar 25 MB.");
    if (item.hasPdf && !confirm(`Este documento ya tiene “${item.pdfName}”. ¿Quieres reemplazarlo?`)) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Cargando…";
    try {
      const response = await fetch(`/api/${resource}/${item.id}/pdf`, { method: "POST", headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(file.name) }, body: file });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) { showLogin(); throw new Error("Sesión requerida"); }
      if (!response.ok) throw new Error(result.error || "No fue posible cargar el PDF");
      if (resource === "theses") theses = theses.map(thesis => thesis.id === item.id ? { ...thesis, ...result } : thesis);
      else { papers = papers.map(paper => paper.id === item.id ? { ...paper, ...result } : paper); saveLocalMirror(); }
      render(); showToast("PDF guardado en PostgreSQL");
    } catch (error) { alert(error.message); button.disabled = false; button.textContent = originalText; }
  });
  input.click();
}

elements.statistics.addEventListener("click", event => {
  const button = event.target.closest("[data-download-chart]");
  if (!button) return;
  const canvas = $(`#${button.dataset.downloadChart}`);
  canvas.toBlob(blob => {
    if (!blob) return showToast("No fue posible generar la imagen");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${button.dataset.chartName}-${new Date().toISOString().slice(0, 10)}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast("Gráfico descargado como PNG");
  }, "image/png");
});

window.addEventListener("resize", () => {
  clearTimeout(renderStatistics.resizeTimer);
  renderStatistics.resizeTimer = setTimeout(() => { if (currentLibraryTab === "statistics") renderStatistics(); }, 160);
});

[$("#newPaperButton"), $("#emptyAddButton")].forEach(button => button.addEventListener("click", openCurrentForm));
document.querySelectorAll("[data-library-tab]").forEach(button => button.addEventListener("click", () => setLibraryTab(button.dataset.libraryTab)));
$("#status").addEventListener("change", syncQuartileField);
[$("#closeDialogButton"), $("#cancelButton")].forEach(button => button.addEventListener("click", closeForm));
[$("#closeThesisDialogButton"), $("#cancelThesisButton")].forEach(button => button.addEventListener("click", closeThesisForm));
[$("#closeCongressDialogButton"), $("#cancelCongressButton")].forEach(button => button.addEventListener("click", closeCongressForm));
[elements.search, elements.statusFilter, elements.sort].forEach(control => control.addEventListener("input", render));
elements.dialog.addEventListener("click", event => { if (event.target === elements.dialog) closeForm(); });
elements.thesisDialog.addEventListener("click", event => { if (event.target === elements.thesisDialog) closeThesisForm(); });
elements.congressDialog.addEventListener("click", event => { if (event.target === elements.congressDialog) closeCongressForm(); });
$("#exportButton").addEventListener("click", () => { const blob = new Blob([JSON.stringify({ version: 4, source: "PostgreSQL", exportedAt: new Date().toISOString(), papers, theses, congresses }, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `papers-chvn-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(link.href); showToast("Respaldo exportado"); });
$("#importButton").addEventListener("click", () => $("#importInput").click());
$("#importInput").addEventListener("change", async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text()); const imported = Array.isArray(data) ? data : data.papers;
    if (!Array.isArray(imported)) throw new Error("Formato inválido");
    if ((papers.length || theses.length || congresses.length) && !confirm("La importación reemplazará los registros incluidos en el respaldo. ¿Continuar?")) return;
    const result = await request("/api/import", { method: "POST", body: JSON.stringify({ papers: imported, theses: Array.isArray(data.theses) ? data.theses : undefined, congresses: Array.isArray(data.congresses) ? data.congresses : undefined, replace: true }) });
    papers = Array.isArray(result) ? result : result.papers;
    if (!Array.isArray(result) && Array.isArray(result.theses)) theses = result.theses;
    if (!Array.isArray(result) && Array.isArray(result.congresses)) congresses = result.congresses;
    saveLocalMirror(); render(); showToast("Respaldo importado a PostgreSQL");
  } catch (error) { alert(error.message || "No fue posible importar el respaldo"); }
  event.target.value = "";
});

STATUSES.filter(status => status !== "Publicado").forEach(status => elements.statusFilter.insertAdjacentHTML("beforeend", `<option>${status}</option>`));
render(); start();
