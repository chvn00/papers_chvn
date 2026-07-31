const STORAGE_KEY = "papers_chvn_v1";
const STATUSES = ["Borrador", "En preparación", "Enviado", "En revisión", "Revisión solicitada", "Reenviado", "Aceptado", "Publicado", "Rechazado", "Retirado"];
const ACTIVE = new Set(["Enviado", "En revisión", "Revisión solicitada", "Reenviado"]);
const SUCCESS = new Set(["Aceptado", "Publicado"]);
const FINAL = new Set(["Aceptado", "Publicado", "Rechazado", "Retirado"]);
const $ = selector => document.querySelector(selector);
const elements = { list: $("#paperList"), empty: $("#emptyState"), dialog: $("#paperDialog"), form: $("#paperForm"), search: $("#searchInput"), statusFilter: $("#statusFilter"), sort: $("#sortFilter"), toast: $("#toast"), authGate: $("#authGate"), loginForm: $("#loginForm"), loginError: $("#loginError"), pdfDialog: $("#pdfDialog"), pdfFrame: $("#pdfFrame") };
let papers = loadLocalPapers();

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
  let remote = await request("/api/papers");
  if (!remote.length && localBackup.length) {
    remote = await request("/api/import", { method: "POST", body: JSON.stringify({ papers: localBackup, replace: false }) });
    showToast(`${localBackup.length} registros migrados a PostgreSQL`);
  }
  papers = remote;
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
  return papers.filter(paper => (!query || [paper.title, paper.journal, paper.coauthors, paper.notes].join(" ").toLocaleLowerCase("es").includes(query)) && (!status || paper.status === status)).sort((a, b) => {
    if (elements.sort.value === "title-asc") return a.title.localeCompare(b.title, "es");
    if (elements.sort.value === "submitted-desc") return (b.submittedAt || "").localeCompare(a.submittedAt || "");
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
}

function render() {
  const visible = filteredPapers();
  elements.list.innerHTML = visible.map(paper => {
    const link = safeURL(paper.link);
    return `<article class="paper-card ${paper.hasPdf ? "has-pdf" : ""}" data-paper-id="${paper.id}" ${paper.hasPdf ? `tabindex="0" role="button" aria-label="Previsualizar PDF de ${escapeHTML(paper.title)}"` : ""}><div class="paper-card-main"><span class="badge ${badgeClass(paper.status)}">${escapeHTML(paper.status)}</span><h3>${escapeHTML(paper.title)}</h3><div class="paper-meta"><span><strong>Journal</strong>${escapeHTML(paper.journal)}</span><span><strong>Envío</strong>${formatDate(paper.submittedAt)}</span>${paper.coauthors ? `<span class="paper-coauthors"><strong>Coautores</strong>${escapeHTML(paper.coauthors)}</span>` : ""}</div>${paper.notes ? `<p class="paper-notes">${escapeHTML(paper.notes)}</p>` : ""}</div><div class="card-footer"><div class="paper-resources">${link ? `<a class="paper-link" href="${escapeHTML(link)}" target="_blank" rel="noopener">Enlace ↗</a>` : ""}${paper.hasPdf ? `<button class="paper-link pdf-open" type="button" data-preview-pdf="${paper.id}" title="${escapeHTML(paper.pdfName)}">Ver PDF</button>` : ""}<button class="pdf-upload" type="button" data-upload-pdf="${paper.id}">${paper.hasPdf ? "Reemplazar PDF" : "Cargar PDF"}</button></div><div class="card-actions"><button class="icon-button" type="button" data-edit="${paper.id}" aria-label="Editar ${escapeHTML(paper.title)}">✎</button><button class="icon-button" type="button" data-delete="${paper.id}" aria-label="Eliminar ${escapeHTML(paper.title)}">×</button></div></div></article>`;
  }).join("");
  elements.empty.hidden = visible.length > 0;
  elements.list.hidden = visible.length === 0;
  $("#resultsCount").textContent = `${visible.length} ${visible.length === 1 ? "registro" : "registros"}`;
  $("#statTotal").textContent = papers.length;
  $("#statDraft").textContent = papers.filter(p => p.status === "Borrador").length;
  $("#statPreparing").textContent = papers.filter(p => p.status === "En preparación").length;
  $("#statSubmitted").textContent = papers.filter(p => p.status === "Enviado").length;
  $("#statReview").textContent = papers.filter(p => p.status === "En revisión").length;
}

function openForm(paper = null) {
  elements.form.reset(); $("#paperId").value = paper?.id || "";
  $("#dialogEyebrow").textContent = paper ? "Editar registro" : "Nuevo registro";
  $("#dialogTitle").textContent = paper ? "Actualizar paper" : "Agregar paper";
  if (paper) ["title", "journal", "status", "coauthors", "affiliation", "submittedAt", "link", "notes"].forEach(key => $(`#${key}`).value = paper[key] || "");
  elements.dialog.showModal(); setTimeout(() => $("#title").focus(), 50);
}
function closeForm() { elements.dialog.close(); }
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
  const paper = {}; ["title", "journal", "status", "coauthors", "affiliation", "submittedAt", "link", "notes"].forEach(key => paper[key] = $(`#${key}`).value.trim());
  try {
    const saved = await request(id ? `/api/papers/${id}` : "/api/papers", { method: id ? "PUT" : "POST", body: JSON.stringify(paper) });
    if (id) papers = papers.map(item => item.id === id ? { ...saved, hasPdf: item.hasPdf, pdfName: item.pdfName, pdfSize: item.pdfSize } : item); else papers.unshift(saved);
    saveLocalMirror(); render(); closeForm(); showToast(id ? "Registro actualizado en PostgreSQL" : "Paper guardado en PostgreSQL");
  } catch (error) { alert(error.message); }
});

elements.list.addEventListener("click", async event => {
  const editId = event.target.closest("[data-edit]")?.dataset.edit;
  const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
  const uploadId = event.target.closest("[data-upload-pdf]")?.dataset.uploadPdf;
  const previewId = event.target.closest("[data-preview-pdf]")?.dataset.previewPdf;
  if (editId) openForm(papers.find(p => p.id === editId));
  if (uploadId) selectPdf(papers.find(p => p.id === uploadId), event.target.closest("[data-upload-pdf]"));
  if (previewId) openPdfPreview(papers.find(p => p.id === previewId));
  if (deleteId) {
    const paper = papers.find(p => p.id === deleteId);
    if (confirm(`¿Eliminar “${paper.title}”? Esta acción no se puede deshacer.`)) {
      try { await request(`/api/papers/${deleteId}`, { method: "DELETE" }); papers = papers.filter(p => p.id !== deleteId); saveLocalMirror(); render(); showToast("Registro eliminado"); }
      catch (error) { alert(error.message); }
    }
  }
  if (!event.target.closest("button, a")) {
    const paperId = event.target.closest("[data-paper-id]")?.dataset.paperId;
    if (paperId) {
      const paper = papers.find(item => item.id === paperId);
      if (paper.hasPdf) openPdfPreview(paper); else showToast("Carga un PDF para previsualizarlo");
    }
  }
});

elements.list.addEventListener("keydown", event => {
  if (!["Enter", " "].includes(event.key) || event.target.closest("button, a")) return;
  const paperId = event.target.closest("[data-paper-id]")?.dataset.paperId;
  const paper = papers.find(item => item.id === paperId);
  if (paper?.hasPdf) { event.preventDefault(); openPdfPreview(paper); }
});

function openPdfPreview(paper) {
  const url = `/api/papers/${paper.id}/pdf`;
  $("#pdfPreviewTitle").textContent = paper.title;
  $("#openPdfNew").href = url;
  elements.pdfFrame.src = url;
  elements.pdfDialog.showModal();
}

function closePdfPreview() {
  elements.pdfDialog.close();
  elements.pdfFrame.src = "about:blank";
}

$("#closePdfButton").addEventListener("click", closePdfPreview);
elements.pdfDialog.addEventListener("click", event => { if (event.target === elements.pdfDialog) closePdfPreview(); });
elements.pdfDialog.addEventListener("close", () => { elements.pdfFrame.src = "about:blank"; });

function selectPdf(paper, button) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/pdf,.pdf";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.type && file.type !== "application/pdf") return alert("Selecciona un archivo PDF válido.");
    if (file.size > 25 * 1024 * 1024) return alert("El PDF no puede superar 25 MB.");
    if (paper.hasPdf && !confirm(`Este paper ya tiene “${paper.pdfName}”. ¿Quieres reemplazarlo?`)) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Cargando…";
    try {
      const response = await fetch(`/api/papers/${paper.id}/pdf`, { method: "POST", headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(file.name) }, body: file });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) { showLogin(); throw new Error("Sesión requerida"); }
      if (!response.ok) throw new Error(result.error || "No fue posible cargar el PDF");
      papers = papers.map(item => item.id === paper.id ? { ...item, ...result } : item);
      saveLocalMirror(); render(); showToast("PDF guardado en PostgreSQL");
    } catch (error) { alert(error.message); button.disabled = false; button.textContent = originalText; }
  });
  input.click();
}

[$("#newPaperButton"), $("#emptyAddButton")].forEach(button => button.addEventListener("click", () => openForm()));
[$("#closeDialogButton"), $("#cancelButton")].forEach(button => button.addEventListener("click", closeForm));
[elements.search, elements.statusFilter, elements.sort].forEach(control => control.addEventListener("input", render));
elements.dialog.addEventListener("click", event => { if (event.target === elements.dialog) closeForm(); });
$("#exportButton").addEventListener("click", () => { const blob = new Blob([JSON.stringify({ version: 2, source: "PostgreSQL", exportedAt: new Date().toISOString(), papers }, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `papers-chvn-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(link.href); showToast("Respaldo exportado"); });
$("#importButton").addEventListener("click", () => $("#importInput").click());
$("#importInput").addEventListener("change", async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text()); const imported = Array.isArray(data) ? data : data.papers;
    if (!Array.isArray(imported)) throw new Error("Formato inválido");
    if (papers.length && !confirm("La importación reemplazará todos los registros de PostgreSQL. ¿Continuar?")) return;
    papers = await request("/api/import", { method: "POST", body: JSON.stringify({ papers: imported, replace: true }) }); saveLocalMirror(); render(); showToast("Respaldo importado a PostgreSQL");
  } catch (error) { alert(error.message || "No fue posible importar el respaldo"); }
  event.target.value = "";
});

STATUSES.forEach(status => elements.statusFilter.insertAdjacentHTML("beforeend", `<option>${status}</option>`));
render(); start();
