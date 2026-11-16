// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Marius SEUL – https://code-by-seul.ro/
// =====================================================================
//  PageFix – interfața aplicației
//
//  - vizualizarea paginilor: pdf.js (lib/pdfjs/)
//  - modificarea PDF-urilor: engine.js (pe baza pdf-lib)
//
//  Toate fișierele sunt procesate local, în browser. Singurele cereri de rețea
//  sunt către serverul aplicației, pentru fișierele ei (librării, fonturi).
//  Rezultatele ajung la utilizator ca descărcări generate local (Blob).
//
//  Structura fișierului:
//    1. configurare și funcții ajutătoare
//    2. starea aplicației, istoric (undo / redo)
//    3. surse (fișierele încărcate)
//    4. grila de pagini, straturi (suprapuneri), miniaturi
//    5. acțiuni pe pagini, selecție, meniuri, drag & drop
//    6. dialoguri
//    7. previzualizare mare
//    8. comenzi, temă, limbă, tastatură, pornire
// =====================================================================
import * as pdfjsLib from '../../lib/pdfjs/pdf.min.js';
import * as Engine from './engine.js';
import { t, LANG, LOCALE, LANGUAGES } from './i18n.js';

// =====================================================================
//  1. Configurare și funcții ajutătoare
// =====================================================================

// Adresa de bază a aplicației (folderul care conține index.php).
const BASE_URL = new URL('../../', import.meta.url).href;

pdfjsLib.GlobalWorkerOptions.workerSrc = BASE_URL + 'lib/pdfjs/pdf.worker.min.js';

const PDFJS_OPTIONS = {
  cMapUrl: BASE_URL + 'lib/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: BASE_URL + 'lib/pdfjs/standard_fonts/',
  wasmUrl: BASE_URL + 'lib/pdfjs/wasm/',
  iccUrl: BASE_URL + 'lib/pdfjs/iccs/',
  isEvalSupported: false, // SECURITATE: pdf.js nu evaluează cod generat dinamic
  enableXfa: false,       // formularele XFA (cu scripturi) nu sunt afișate
};

// Configurația trimisă de server (index.php): window.APP_CONFIG.
let APP_CONFIG = window.APP_CONFIG;
if (!APP_CONFIG) {
  APP_CONFIG = {};
}

/** Primul element care se potrivește selectorului CSS (sau null). */
function findElement(selector, root = document) {
  return root.querySelector(selector);
}

/** Toate elementele care se potrivesc selectorului CSS, ca listă (Array). */
function findAllElements(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/** Adaugă sau elimină o clasă CSS, după valoarea lui `enabled`. */
function setClass(element, className, enabled) {
  if (enabled) {
    element.classList.add(className);
  } else {
    element.classList.remove(className);
  }
}

/**
 * Escapează un text pentru a fi inserat în HTML (prin innerHTML).
 * SECURITATE: orice text inserat cu innerHTML trece prin această funcție.
 */
function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Mesajul unei erori, pentru afișare. */
function describeError(error) {
  if (error !== null && error !== undefined && error.message) {
    return error.message;
  }
  return String(error);
}

function compareNumbersAscending(first, second) {
  return first - second;
}

/** Promisiune care se rezolvă după numărul dat de milisecunde. */
function waitMilliseconds(milliseconds) {
  return new Promise(function startTimer(resolve) {
    setTimeout(resolve, milliseconds);
  });
}

// =====================================================================
//  2. Starea aplicației
// =====================================================================
//  sources[id] = { id, name, bytes, pdf (pdf.js), numPages, derived, libPromise (pdf-lib) }
//  pages[i]    = { uid, sourceId, pageIndex, rotation, label }
//                – pagina nr. pageIndex (de la 0) din sursa sourceId, cu o rotație suplimentară
//  overlays[i] = straturi: { id, version, type, hidden, scope: 'all' | Set(uid), …setări }
const state = {
  sources: [],
  pages: [],
  selectedUids: new Set(),
  selectionAnchorUid: null,   // pagina de la care pornește selecția cu Shift+click
  undoStack: [],
  redoStack: [],
  thumbnailSize: 190,
  thumbnailResolution: 200,   // rezoluția la care se randează miniaturile (crește la zoom)
  hasUnsavedChanges: false,
  overlays: [],
  isLayersPanelOpen: false,
};

let nextOverlayId = 1;
let nextPageUid = 1;

/** Identificator unic pentru o pagină nouă din document. */
function createPageUid() {
  const uid = nextPageUid;
  nextPageUid = nextPageUid + 1;
  return uid;
}

/** Copie a unei referințe de pagină (obiectele de pagină nu se modifică pe loc – vezi istoricul). */
function copyPageRef(page) {
  return {
    uid: page.uid,
    sourceId: page.sourceId,
    pageIndex: page.pageIndex,
    rotation: page.rotation,
    label: page.label,
  };
}

const gridElement = findElement('#grid');
const emptyStateElement = findElement('#empty');

// ---------------------------------------------------------------------
//  Utilitare de interfață
// ---------------------------------------------------------------------

/** Mesaj temporar în colțul ecranului. kind: 'info' | 'ok' | 'warn' | 'error'. */
function showToast(message, kind = 'info', durationMs = 4500) {
  const toastElement = document.createElement('div');
  toastElement.className = `toast ${kind}`;
  toastElement.textContent = message;
  findElement('#toasts').appendChild(toastElement);

  function removeToast() {
    toastElement.remove();
  }
  function startHiding() {
    toastElement.classList.add('out');
    setTimeout(removeToast, 400); // după animația de ascundere
  }
  setTimeout(startHiding, durationMs);
}

// Indicatorul „Se lucrează…”; operațiile pot fi imbricate, așa că se numără.
let busyDepth = 0;

function setBusyMessage(message) {
  findElement('#busyMsg').textContent = message;
}

/**
 * Rulează o operație lungă cu indicatorul „Se lucrează…” afișat.
 * Erorile operației sunt prinse aici și afișate utilizatorului.
 */
async function runWithBusyIndicator(message, operation) {
  busyDepth = busyDepth + 1;
  setBusyMessage(message);
  findElement('#busy').hidden = false;

  await waitMilliseconds(30); // lasă browserul să redeseneze ecranul înainte de operație

  try {
    return await operation();
  } catch (error) {
    console.error(error);
    showToast(describeError(error), 'error', 8000);
  } finally {
    busyDepth = busyDepth - 1;
    if (busyDepth === 0) {
      findElement('#busy').hidden = true;
    }
  }
}

/**
 * Oferă utilizatorului un fișier generat local, ca descărcare.
 * Datele nu părăsesc browserul: se creează o adresă temporară blob: și se „apasă” un link.
 */
function downloadFile(data, fileName, mimeType = 'application/pdf') {
  let blob;
  if (data instanceof Blob) {
    blob = data;
  } else {
    blob = new Blob([data], { type: mimeType });
  }

  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  function releaseBlobUrl() {
    URL.revokeObjectURL(blobUrl);
  }
  setTimeout(releaseBlobUrl, 60000); // adresa temporară se eliberează după un minut
}

/** Numele unui fișier fără extensie ("raport.pdf" -> "raport"). */
function fileNameWithoutExtension(fileName) {
  let text = 'document';
  if (fileName) {
    text = String(fileName);
  }
  return text.replace(/\.[^.]+$/, '');
}

/**
 * Nume de fișier sigur pentru descărcare: fără extensia .pdf, fără caracterele
 * interzise în numele de fișiere (\ / : * ? " < > |, rânduri noi), maximum 120 de caractere.
 */
function makeSafeFileName(name) {
  let text = 'document';
  if (name) {
    text = String(name);
  }
  text = text.trim();
  text = text.replace(/\.pdf$/i, '');
  text = text.replace(/[\\/:*?"<>|\r\n]+/g, '_');
  text = text.slice(0, 120);
  if (text === '') {
    text = 'document';
  }
  return text;
}

/** Numele documentului, așa cum apare (editabil) în bara de sus. */
function getDocumentName() {
  return makeSafeFileName(findElement('#docName').textContent);
}

function setDocumentName(name) {
  findElement('#docName').textContent = makeSafeFileName(name);
}

/** Indici de pagină (de la 0) -> text de intervale. Ex.: [0,1,2,4,6,7] -> "1-3, 5, 7-8". */
function formatPageRanges(pageIndexes) {
  const sortedIndexes = Array.from(pageIndexes);
  sortedIndexes.sort(compareNumbersAscending);

  const rangeTexts = [];
  let rangeStart = 0;
  while (rangeStart < sortedIndexes.length) {
    // Extinde intervalul cât timp paginile sunt consecutive.
    let rangeEnd = rangeStart;
    while (rangeEnd + 1 < sortedIndexes.length && sortedIndexes[rangeEnd + 1] === sortedIndexes[rangeEnd] + 1) {
      rangeEnd++;
    }

    const firstPageNumber = sortedIndexes[rangeStart] + 1;
    const lastPageNumber = sortedIndexes[rangeEnd] + 1;
    if (rangeEnd > rangeStart) {
      rangeTexts.push(`${firstPageNumber}-${lastPageNumber}`);
    } else {
      rangeTexts.push(`${firstPageNumber}`);
    }

    rangeStart = rangeEnd + 1;
  }

  return rangeTexts.join(', ');
}

/** Indicii paginilor selectate, în ordinea din document. */
function getSelectedPageIndexes() {
  const selectedIndexes = [];
  for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
    if (state.selectedUids.has(state.pages[pageIndex].uid)) {
      selectedIndexes.push(pageIndex);
    }
  }
  return selectedIndexes;
}

/** Poziția în document a paginii cu identificatorul dat (sau -1). */
function findPageIndexByUid(uid) {
  for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
    if (state.pages[pageIndex].uid === uid) {
      return pageIndex;
    }
  }
  return -1;
}

/** Toți indicii paginilor documentului: [0, 1, …, n-1]. */
function getAllPageIndexes() {
  const allIndexes = [];
  for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
    allIndexes.push(pageIndex);
  }
  return allIndexes;
}

/** Indicii paginilor selectate; dacă nu e nimic selectat, afișează un avertisment și întoarce null. */
function requireSelection() {
  const selectedIndexes = getSelectedPageIndexes();
  if (selectedIndexes.length === 0) {
    showToast(t('msg.selectFirst'), 'warn');
    return null;
  }
  return selectedIndexes;
}

// ---------------------------------------------------------------------
//  Istoric (undo / redo)
// ---------------------------------------------------------------------
// Fiecare modificare a documentului se face astfel:
//     recordUndoSnapshot();   // 1. se salvează starea curentă
//     …modificarea…           // 2. se modifică state.pages / state.overlays
//     finishChange();         // 3. se marchează documentul ca modificat și se redesenează
// Obiectele din state.pages / state.overlays nu se modifică pe loc, ci se înlocuiesc cu
// copii modificate, pentru ca instantaneele salvate să rămână neschimbate.

const MAX_UNDO_STEPS = 200;

function takeSnapshot() {
  const pagesCopy = [];
  for (const page of state.pages) {
    pagesCopy.push(copyPageRef(page));
  }
  const overlaysCopy = Array.from(state.overlays);
  return { pages: pagesCopy, overlays: overlaysCopy };
}

function restoreSnapshot(snapshot) {
  state.pages = snapshot.pages;
  state.overlays = snapshot.overlays;
}

/** Pasul 1 al unei modificări: salvează starea curentă pentru „Anulează”. */
function recordUndoSnapshot() {
  state.undoStack.push(takeSnapshot());
  if (state.undoStack.length > MAX_UNDO_STEPS) {
    state.undoStack.shift(); // se renunță la cel mai vechi pas
  }
  state.redoStack = [];
}

/** Pasul 3 al unei modificări: documentul e marcat ca modificat și se redesenează. */
function finishChange() {
  state.hasUnsavedChanges = true;
  render();
}

function undo() {
  if (state.undoStack.length === 0) {
    return;
  }
  state.redoStack.push(takeSnapshot());
  restoreSnapshot(state.undoStack.pop());
  removeDeletedPagesFromSelection();
  state.hasUnsavedChanges = true;
  render();
}

function redo() {
  if (state.redoStack.length === 0) {
    return;
  }
  state.undoStack.push(takeSnapshot());
  restoreSnapshot(state.redoStack.pop());
  removeDeletedPagesFromSelection();
  state.hasUnsavedChanges = true;
  render();
}

/** Scoate din selecție paginile care nu mai există în document. */
function removeDeletedPagesFromSelection() {
  const existingUids = new Set();
  for (const page of state.pages) {
    existingUids.add(page.uid);
  }
  const selectedUids = Array.from(state.selectedUids);
  for (const uid of selectedUids) {
    if (!existingUids.has(uid)) {
      state.selectedUids.delete(uid);
    }
  }
}

// =====================================================================
//  3. Surse (fișierele PDF încărcate și documentele intermediare generate)
// =====================================================================

// Codul pdf.js pentru „parolă greșită” (PasswordResponses.INCORRECT_PASSWORD).
const PDFJS_PASSWORD_INCORRECT = 2;

/**
 * Deschide un PDF (octeții lui) cu pdf.js și îl adaugă la lista de surse.
 * derived = true pentru documentele generate de aplicație (ex. pagini albe, rezultatul unei decupări).
 */
async function addSource(bytes, name, options = {}) {
  let derived = false;
  if (options.derived !== undefined) {
    derived = options.derived;
  }

  // pdf.js primește o copie a octeților (îi poate transfera în worker).
  const loadOptions = Object.assign({}, PDFJS_OPTIONS);
  loadOptions.data = bytes.slice();
  const loadingTask = pdfjsLib.getDocument(loadOptions);

  // Fișier protejat cu parolă: se cere parola utilizatorului (de mai multe ori, dacă e greșită).
  loadingTask.onPassword = function askForPassword(providePassword, reason) {
    let promptText = t('pw.ask', { name: name });
    if (reason === PDFJS_PASSWORD_INCORRECT) {
      promptText = t('pw.wrong');
    }
    const password = prompt(promptText);
    if (password === null) {
      loadingTask.destroy(); // utilizatorul a renunțat
    } else {
      providePassword(password);
    }
  };

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    throw new Error(t('err.open', { name: name, msg: describeError(error) }));
  }

  const source = {
    id: state.sources.length,
    name: name,
    bytes: bytes,
    pdf: pdf,
    numPages: pdf.numPages,
    derived: derived,
  };
  state.sources.push(source);

  if (!derived) {
    // pdf-lib încarcă fișierul în fundal (fără await), ca să avertizăm devreme
    // dacă fișierul este criptat sau nu poate fi editat.
    warnIfSourceNotEditable(source);
  }

  return source;
}

/** Verifică (în fundal) dacă pdf-lib poate citi sursa; afișează un avertisment dacă nu. */
async function warnIfSourceNotEditable(source) {
  let libDocument;
  try {
    libDocument = await Engine.getLibDoc(source);
  } catch (error) {
    showToast(t('err.pdflib', { name: source.name, msg: error.message }), 'error', 10000);
    return;
  }
  if (libDocument.isEncrypted) {
    showToast(t('warn.encrypted', { name: source.name }), 'warn', 10000);
  }
}

/**
 * Referințe de pagină noi pentru paginile unei surse.
 * pageIndexes = null -> toate paginile sursei. label = null -> „<nume fișier> · p. <nr>”.
 */
function createPageRefs(source, pageIndexes = null, label = null) {
  let indexes = pageIndexes;
  if (indexes === null || indexes === undefined) {
    indexes = [];
    for (let pageIndex = 0; pageIndex < source.numPages; pageIndex++) {
      indexes.push(pageIndex);
    }
  }

  const pageRefs = [];
  for (const pageIndex of indexes) {
    let pageLabel = label;
    if (pageLabel === null || pageLabel === undefined) {
      pageLabel = `${source.name} · p. ${pageIndex + 1}`;
    }
    pageRefs.push({
      uid: createPageUid(),
      sourceId: source.id,
      pageIndex: pageIndex,
      rotation: 0,
      label: pageLabel,
    });
  }
  return pageRefs;
}

/** Dimensiunea vizibilă [lățime, înălțime] (în puncte) a unei pagini din document, după rotație. */
async function getVisibleSizeOfPage(page) {
  const pdfPage = await state.sources[page.sourceId].pdf.getPage(page.pageIndex + 1);
  const rotation = Engine.normalizeAngle(pdfPage.rotate + page.rotation);
  const viewport = pdfPage.getViewport({ scale: 1, rotation: rotation });
  return [viewport.width, viewport.height];
}

function isPdfFile(file) {
  return /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);
}

function isImageFile(file) {
  return /^image\//i.test(file.type) || /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(file.name);
}

/**
 * Încarcă fișiere alese de utilizator (PDF-uri și/sau imagini).
 *
 * options.replace = true -> înlocuiesc documentul curent;
 * altfel se inserează la poziția options.at (implicit: la final).
 * Imaginile consecutive sunt convertite împreună într-un PDF (câte o pagină A4 pentru fiecare).
 */
async function loadFiles(fileList, options = {}) {
  let replaceDocument = false;
  if (options.replace !== undefined) {
    replaceDocument = options.replace;
  }
  let insertPosition = null;
  if (options.at !== undefined) {
    insertPosition = options.at;
  }

  // Validare: se păstrează doar PDF-urile și imaginile.
  const files = [];
  for (const file of Array.from(fileList)) {
    if (isPdfFile(file) || isImageFile(file)) {
      files.push(file);
    }
  }
  if (files.length === 0) {
    showToast(t('msg.noFiles'), 'warn');
    return;
  }

  async function loadAllFiles() {
    const newPageRefs = [];
    let pendingImages = [];

    // Sursele adăugate de acum înainte primesc id-uri >= această valoare (vezi replaceDocumentSources).
    const firstNewSourceId = state.sources.length;

    // Convertește imaginile adunate până acum într-un PDF și adaugă paginile lui.
    async function convertPendingImages() {
      if (pendingImages.length === 0) {
        return;
      }
      setBusyMessage(t('busy.convertImages', { n: pendingImages.length }));
      const pdfBytes = await Engine.imagesToPdf(pendingImages, { format: 'A4', margin: 10 });
      const source = await addSource(pdfBytes, 'imagini', { derived: true });
      for (let imageNumber = 0; imageNumber < pendingImages.length; imageNumber++) {
        const imageFile = pendingImages[imageNumber];
        const refs = createPageRefs(source, [imageNumber], `${imageFile.name}`);
        for (const ref of refs) {
          newPageRefs.push(ref);
        }
      }
      pendingImages = [];
    }

    for (const file of files) {
      const isImageOnly = isImageFile(file) && !isPdfFile(file);
      if (isImageOnly) {
        pendingImages.push(file);
        continue;
      }

      await convertPendingImages();
      setBusyMessage(t('busy.opening', { name: file.name }));
      const fileBuffer = await file.arrayBuffer();
      const source = await addSource(new Uint8Array(fileBuffer), file.name);
      const refs = createPageRefs(source);
      for (const ref of refs) {
        newPageRefs.push(ref);
      }
    }
    await convertPendingImages();

    const documentIsEmpty = state.pages.length === 0;
    if (replaceDocument || documentIsEmpty) {
      if (replaceDocument) {
        // Documentul vechi se închide abia acum, după ce fișierele noi s-au încărcat cu succes,
        // păstrând sursele noi (dacă încărcarea eșuează, documentul vechi rămâne deschis).
        replaceDocumentSources(firstNewSourceId, newPageRefs);
      }
      state.pages = newPageRefs;
      state.undoStack = [];
      state.redoStack = [];
      setDocumentName(fileNameWithoutExtension(files[0].name));
      state.hasUnsavedChanges = false;
      render();
    } else {
      let position = insertPosition;
      if (position === null || position === undefined) {
        position = state.pages.length;
      }
      recordUndoSnapshot();
      state.pages.splice(position, 0, ...newPageRefs);
      finishChange();
    }

    showToast(t('msg.added', { n: newPageRefs.length }), 'ok', 2500);
  }

  await runWithBusyIndicator(t('busy.loading'), loadAllFiles);
}

/** Eliberează resursele pdf.js ale surselor date. */
function destroySources(sources) {
  for (const source of sources) {
    try {
      source.pdf.destroy();
    } catch (error) {
      // ignorat: sursa poate fi deja închisă
    }
  }
}

/** Închide documentul curent: eliberează sursele și golește starea. */
function resetDocument(rerender = true) {
  destroySources(state.sources);
  state.sources = [];
  clearDocumentState();

  if (rerender) {
    setDocumentName('document');
    render();
  }
}

/**
 * Înlocuiește documentul curent cu sursele încărcate tocmai acum („Deschide” cu un document deja deschis).
 *
 * Sursele vechi (id < firstNewSourceId) se închid, iar cele noi se renumerotează de la 0,
 * pentru că id-ul unei surse este chiar poziția ei în state.sources. Referințele noilor pagini
 * (newPageRefs) se actualizează la fel, ca să indice în continuare sursa corectă.
 */
function replaceDocumentSources(firstNewSourceId, newPageRefs) {
  const oldSources = state.sources.slice(0, firstNewSourceId);
  const newSources = state.sources.slice(firstNewSourceId);

  destroySources(oldSources);

  for (const source of newSources) {
    source.id = source.id - firstNewSourceId;
  }
  for (const pageRef of newPageRefs) {
    pageRef.sourceId = pageRef.sourceId - firstNewSourceId;
  }

  state.sources = newSources;
  clearDocumentState();
}

/** Golește paginile, straturile, selecția, istoricul și cartonașele (fără a atinge sursele). */
function clearDocumentState() {
  state.pages = [];
  state.overlays = [];
  state.selectedUids.clear();
  state.undoStack = [];
  state.redoStack = [];
  state.selectionAnchorUid = null;
  state.hasUnsavedChanges = false;

  for (const [uid, card] of pageCards) {
    thumbnailObserver.unobserve(card.element);
    card.element.remove();
    thumbnailQueue.delete(uid);
  }
  pageCards.clear();
}

/**
 * Aplică o operație de conținut (pdf-lib, vezi engine.js) pe paginile indicate și
 * le înlocuiește cu rezultatul (care devine o sursă nouă).
 */
async function applyBake(pageIndexes, pageOperation, busyMessage) {
  if (pageIndexes.length === 0) {
    throw new Error(t('err.nothing'));
  }

  async function bakeAndReplacePages() {
    const pageRefs = [];
    for (const pageIndex of pageIndexes) {
      pageRefs.push(state.pages[pageIndex]);
    }

    const pdfBytes = await Engine.bake(pageRefs, state.sources, pageOperation);
    const source = await addSource(pdfBytes, '(modificat)', { derived: true });

    recordUndoSnapshot();
    for (let resultIndex = 0; resultIndex < pageIndexes.length; resultIndex++) {
      const documentIndex = pageIndexes[resultIndex];
      const updatedPage = copyPageRef(state.pages[documentIndex]);
      updatedPage.sourceId = source.id;
      updatedPage.pageIndex = resultIndex;
      updatedPage.rotation = 0; // rotația a fost deja aplicată în noul PDF
      state.pages[documentIndex] = updatedPage;
    }
    finishChange();

    showToast(t('msg.applied', { n: pageIndexes.length }), 'ok', 2500);
  }

  await runWithBusyIndicator(busyMessage, bakeAndReplacePages);
}

// =====================================================================
//  4. Grila de pagini
// =====================================================================

// Cartonașele (miniaturile) paginilor, după uid:
//   { element,
//     baseRender: { key, canvas, scale, visibleWidth, visibleHeight } | null  – pagina randată (fără straturi),
//     wanted: { baseKey, overlayKey }  – ce ar trebui să arate miniatura acum,
//     done:   { overlayKey }           – straturile desenate efectiv în miniatură }
const pageCards = new Map();

/** Marcajul HTML al unei iconițe (simbolurile SVG sunt definite în index.php). */
function iconHtml(iconName) {
  return `<svg class="ic" aria-hidden="true"><use href="#i-${iconName}"/></svg>`;
}

/** Cheia care descrie imaginea de bază a unei miniaturi; dacă se schimbă, pagina se randează din nou. */
function getBaseRenderKey(page) {
  return `${page.sourceId}:${page.pageIndex}:${page.rotation}:${state.thumbnailResolution}`;
}

/** Cheia imaginii de bază deja randate pentru un cartonaș (undefined dacă nu există încă). */
function getRenderedBaseKey(card) {
  if (card.baseRender) {
    return card.baseRender.key;
  }
  return undefined;
}

function createPageCard(page) {
  const element = document.createElement('div');
  element.className = 'card loading';
  element.draggable = true;
  element.dataset.uid = page.uid;
  element.innerHTML = `
    <div class="thumb"><div class="ph"></div></div>
    <input type="checkbox" class="chk" title="${escapeHtml(t('card.select'))}" tabindex="-1">
    <div class="cap"><span class="num"></span><span class="meta"></span></div>
    <div class="acts">
      <button data-a="rotL" title="${escapeHtml(t('card.rotL'))}">${iconHtml('rotl')}</button>
      <button data-a="rotR" title="${escapeHtml(t('card.rotR'))}">${iconHtml('rotr')}</button>
      <button data-a="more" title="${escapeHtml(t('card.more'))}">${iconHtml('more')}</button>
      <button data-a="del" class="del" title="${escapeHtml(t('card.delTitle'))}">${escapeHtml(t('card.del'))}</button>
    </div>`;
  return { element: element, baseRender: null, wanted: {}, done: {} };
}

// =====================================================================
//  Straturi (suprapuneri) – se aplică „din zbor”, nu modifică sursele
// =====================================================================

const OVERLAY_TYPE_NAMES = {
  num: t('ov.num'),
  text: t('ov.text'),
  wm: t('ov.wm'),
  img: t('ov.img'),
};

const OVERLAY_TYPE_ICONS = {
  num: 'hash',
  text: 'header',
  wm: 'stamp',
  img: 'image',
};

const POSITION_NAMES = {};
for (const positionCode of ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']) {
  POSITION_NAMES[positionCode] = t(`pos.${positionCode}`);
}

/** Data de azi, în formatul limbii curente. */
function getTodayText() {
  return new Date().toLocaleDateString(LOCALE);
}

/** Lista paginilor (uid) din domeniul unui strat, ca indici în documentul curent. */
function getOverlayScopePageIndexes(overlay) {
  const scopeIndexes = [];
  for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
    if (overlay.scope.has(state.pages[pageIndex].uid)) {
      scopeIndexes.push(pageIndex);
    }
  }
  return scopeIndexes;
}

/** Straturile care se aplică paginii pageIndex, cu variabilele calculate ({n}, {total}, …). */
function getOverlaysForPage(pageIndex) {
  const page = state.pages[pageIndex];
  const pageCount = state.pages.length;
  const result = [];

  for (const overlay of state.overlays) {
    if (overlay.hidden) {
      continue;
    }
    const appliesToAllPages = overlay.scope === 'all';
    if (!appliesToAllPages && !overlay.scope.has(page.uid)) {
      continue;
    }

    let pageNumber = pageIndex + 1;
    let totalPages = pageCount;

    if (overlay.type === 'num') {
      let skippedPages = 0;
      if (overlay.skipFirst) {
        skippedPages = 1;
      }
      if (skippedPages === 1 && pageIndex === 0) {
        continue; // prima pagină nu se numerotează
      }
      pageNumber = pageIndex - skippedPages + overlay.start;
      totalPages = pageCount - skippedPages + overlay.start - 1;
    }

    result.push({
      spec: overlay,
      vars: { n: pageNumber, total: totalPages, date: getTodayText(), file: getDocumentName() },
    });
  }

  return result;
}

/** Cheia care descrie straturile unei pagini; dacă se schimbă, miniatura se redesenează. */
function getOverlayKey(overlayList) {
  const keyParts = [];
  for (const entry of overlayList) {
    keyParts.push(`${entry.spec.id}.${entry.spec.version}:${entry.vars.n}/${entry.vars.total}:${entry.vars.file}`);
  }
  return keyParts.join('|');
}

/** Straturile pentru fiecare pagină din listă (în aceeași ordine). */
function getOverlaysForPages(pageIndexes) {
  const overlaysByPage = [];
  for (const pageIndex of pageIndexes) {
    overlaysByPage.push(getOverlaysForPage(pageIndex));
  }
  return overlaysByPage;
}

// Promisiunea încărcării fonturilor (se setează la pornire, la finalul fișierului).
let fontsReadyPromise = null;

/** Încarcă fonturile suprapunerilor, atât pentru PDF (engine), cât și pentru browser (previzualizare). */
async function initFonts() {
  const fontBytes = await Engine.loadFonts(BASE_URL + 'lib/pdfjs/standard_fonts/');

  const regularFace = new FontFace('PageFixSans', fontBytes.regular, { weight: '400' });
  const boldFace = new FontFace('PageFixSans', fontBytes.bold, { weight: '700' });
  await Promise.all([regularFace.load(), boldFace.load()]);

  document.fonts.add(regularFace);
  document.fonts.add(boldFace);
}

// Imaginile straturilor, decodate pentru desenarea pe canvas: "<id>.<versiune>" -> Promise<ImageBitmap>
const overlayBitmaps = new Map();

function getOverlayBitmap(spec) {
  const cacheKey = `${spec.id}.${spec.version}`;
  if (!overlayBitmaps.has(cacheKey)) {
    let mimeType = 'image/png';
    if (spec.image.kind === 'jpg') {
      mimeType = 'image/jpeg';
    }
    const imageBlob = new Blob([spec.image.bytes], { type: mimeType });
    overlayBitmaps.set(cacheKey, createImageBitmap(imageBlob));
  }
  return overlayBitmaps.get(cacheKey);
}

/**
 * Desenează straturile pe un canvas (previzualizare).
 * pixelsPerPoint = pixeli de canvas per punct PDF; visibleWidth × visibleHeight = pagina vizibilă, în puncte.
 */
async function drawOverlaysOnCanvas(context, pixelsPerPoint, visibleWidth, visibleHeight, overlayList) {
  if (overlayList.length === 0) {
    return;
  }
  await fontsReadyPromise;

  for (const entry of overlayList) {
    const spec = entry.spec;
    const items = Engine.layoutOverlay(spec, visibleWidth, visibleHeight, entry.vars);

    for (const item of items) {
      context.save();
      // Sistemul de coordonate PDF: unități în puncte, originea jos, axa Y în sus.
      context.setTransform(pixelsPerPoint, 0, 0, -pixelsPerPoint, 0, visibleHeight * pixelsPerPoint);
      context.globalAlpha = item.opacity;

      if (item.kind === 'text') {
        context.translate(item.x, item.y);
        context.rotate((item.angle * Math.PI) / 180);
        context.scale(1, -1); // textul se scrie cu axa Y în jos, ca să nu apară răsturnat

        let fontWeight = 400;
        if (item.bold) {
          fontWeight = 700;
        }
        context.font = `${fontWeight} ${item.size}px PageFixSans`;
        context.fontKerning = 'none'; // la fel ca în PDF (lățimile vin din font, fără kerning)
        context.textBaseline = 'alphabetic';
        context.fillStyle = item.color;
        context.fillText(item.text, 0, 0);
      } else {
        const bitmap = await getOverlayBitmap(spec);
        context.translate(item.x, item.y + item.h);
        context.scale(1, -1);
        context.drawImage(bitmap, 0, 0, item.w, item.h);
      }

      context.restore();
    }
  }
}

// ---------------------------------------------------------------------
//  Afișarea grilei și a elementelor din jur
// ---------------------------------------------------------------------

/** Actualizează grila de pagini după starea curentă (creează / mută / elimină cartonașe). */
function render() {
  const hasPages = state.pages.length > 0;
  gridElement.hidden = !hasPages;
  emptyStateElement.hidden = hasPages;
  setClass(document.body, 'nodoc', !hasPages);

  // Cartonașele paginilor care nu mai există se elimină.
  const existingUids = new Set();
  for (const page of state.pages) {
    existingUids.add(page.uid);
  }
  for (const [uid, card] of pageCards) {
    if (!existingUids.has(uid)) {
      thumbnailObserver.unobserve(card.element);
      card.element.remove();
      pageCards.delete(uid);
      thumbnailQueue.delete(uid);
    }
  }

  for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
    const page = state.pages[pageIndex];

    let card = pageCards.get(page.uid);
    if (!card) {
      card = createPageCard(page);
      pageCards.set(page.uid, card);
    }

    // Cartonașul trebuie să stea pe poziția pageIndex în grilă.
    const elementAtPosition = gridElement.children[pageIndex];
    if (elementAtPosition !== card.element) {
      let insertBeforeElement = null;
      if (elementAtPosition) {
        insertBeforeElement = elementAtPosition;
      }
      gridElement.insertBefore(card.element, insertBeforeElement);
    }

    card.element.querySelector('.num').textContent = t('card.page', { n: pageIndex + 1 });

    let labelText = '';
    if (page.label) {
      labelText = page.label;
    }
    const metaElement = card.element.querySelector('.meta');
    metaElement.textContent = labelText;
    metaElement.title = labelText;

    const isSelected = state.selectedUids.has(page.uid);
    setClass(card.element, 'selected', isSelected);
    card.element.querySelector('.chk').checked = isSelected;

    // Dacă miniatura trebuie să arate altceva, se cere o nouă randare (când devine vizibilă).
    const wanted = {
      baseKey: getBaseRenderKey(page),
      overlayKey: getOverlayKey(getOverlaysForPage(pageIndex)),
    };
    const baseChanged = wanted.baseKey !== card.wanted.baseKey;
    const overlaysChanged = wanted.overlayKey !== card.wanted.overlayKey;
    if (baseChanged || overlaysChanged) {
      card.wanted = wanted;
      if (getRenderedBaseKey(card) !== wanted.baseKey) {
        card.element.classList.add('loading');
      }
      // Re-observarea declanșează imediat verificarea vizibilității.
      thumbnailObserver.unobserve(card.element);
      thumbnailObserver.observe(card.element);
    }
  }

  renderChrome();
}

/** Bara de stare, starea butoanelor din ribbon și panoul de straturi. */
function renderChrome() {
  const pageCount = state.pages.length;
  const selectedCount = state.selectedUids.size;

  findElement('#stPages').textContent = t('status.pages', { n: pageCount });

  let selectedText = '';
  if (selectedCount > 0) {
    selectedText = t('status.selected', { n: selectedCount });
  }
  findElement('#stSel').textContent = selectedText;

  const selectionBadge = findElement('#selCount');
  selectionBadge.hidden = selectedCount === 0;
  selectionBadge.textContent = selectedCount;

  findElement('[data-cmd="undo"]').disabled = state.undoStack.length === 0;
  findElement('[data-cmd="redo"]').disabled = state.redoStack.length === 0;

  // Butoanele care lucrează pe selecție apar estompate când nu e nimic selectat.
  for (const button of findAllElements('[data-needsel]')) {
    setClass(button, 'dim', selectedCount === 0);
  }

  const layerBadge = findElement('#layerCount');
  layerBadge.hidden = state.overlays.length === 0;
  layerBadge.textContent = state.overlays.length;

  setClass(findElement('[data-cmd="layers"].rb'), 'on', state.isLayersPanelOpen);
  findElement('#layers').hidden = !state.isLayersPanelOpen;

  renderLayersPanel();
}

/** Descrierea paginilor la care se aplică un strat (ex. „toate paginile”, „pag. 2-5”). */
function describeOverlayScope(overlay) {
  if (overlay.scope === 'all') {
    return t('scope.all');
  }
  const scopeIndexes = getOverlayScopePageIndexes(overlay);
  if (scopeIndexes.length > 0) {
    return t('scope.pages', { r: formatPageRanges(scopeIndexes) });
  }
  return t('scope.none');
}

/** Text între ghilimelele limbii curente (ex. „text” sau “text”). */
function quoteText(text) {
  return t('_meta.quote', { s: text });
}

/** Rezumatul unui strat, afișat în panoul de straturi. */
function describeOverlay(overlay) {
  const pageCount = state.pages.length;
  const exampleVars = { n: 1, total: pageCount, date: getTodayText(), file: getDocumentName() };

  if (overlay.type === 'num') {
    let skippedPages = 0;
    if (overlay.skipFirst) {
      skippedPages = 1;
    }
    const numberingVars = {
      n: overlay.start,
      total: pageCount - skippedPages + overlay.start - 1,
      date: exampleVars.date,
      file: exampleVars.file,
    };
    const example = Engine.fillVars(overlay.fmt, numberingVars);
    return `${quoteText(example)} · ${POSITION_NAMES[overlay.pos]}`;
  }

  if (overlay.type === 'text') {
    const example = Engine.fillVars(overlay.text, exampleVars);
    return `${quoteText(example)} · ${POSITION_NAMES[overlay.pos]}`;
  }

  if (overlay.type === 'wm') {
    return `${quoteText(overlay.text)} · ${overlay.angle}° · ${overlay.opacity}%`;
  }

  // imagine
  let imageName = overlay.imageName;
  if (!imageName) {
    imageName = t('ov.img.default');
  }
  return `${imageName} · ${overlay.widthPct}% · ${POSITION_NAMES[overlay.pos]}`;
}

function renderLayersPanel() {
  if (!state.isLayersPanelOpen) {
    return;
  }

  const layerList = findElement('#layerList');

  if (state.overlays.length === 0) {
    layerList.innerHTML = `<p class="lempty">${escapeHtml(t('layers.empty'))}</p>`;
    return;
  }

  layerList.replaceChildren();
  for (const overlay of state.overlays) {
    const layerElement = document.createElement('div');

    let cssClass = 'layer';
    if (overlay.hidden) {
      cssClass = 'layer off';
    }
    layerElement.className = cssClass;
    layerElement.dataset.id = overlay.id;

    let toggleTitle = t('layers.hide');
    let toggleIcon = 'eye';
    if (overlay.hidden) {
      toggleTitle = t('layers.show');
      toggleIcon = 'eyeoff';
    }

    layerElement.innerHTML = `${iconHtml(OVERLAY_TYPE_ICONS[overlay.type])}
      <div class="linfo"><b></b><small class="sum"></small><small class="scope"></small></div>
      <div class="lacts">
        <button class="iconbtn" data-l="edit" title="${escapeHtml(t('layers.edit'))}">${iconHtml('edit')}</button>
        <button class="iconbtn" data-l="toggle" title="${escapeHtml(toggleTitle)}">${iconHtml(toggleIcon)}</button>
        <button class="iconbtn danger" data-l="del" title="${escapeHtml(t('layers.delete'))}">${iconHtml('trash')}</button>
      </div>`;

    // Textele variabile se pun cu textContent (nu se interpretează ca HTML).
    layerElement.querySelector('b').textContent = OVERLAY_TYPE_NAMES[overlay.type];
    layerElement.querySelector('.sum').textContent = describeOverlay(overlay);
    layerElement.querySelector('.scope').textContent = describeOverlayScope(overlay);

    layerList.appendChild(layerElement);
  }
}

/** Click în panoul de straturi: editare, ascundere / afișare sau ștergere. */
function handleLayerListClick(event) {
  const layerElement = event.target.closest('.layer');
  if (!layerElement) {
    return;
  }

  const overlayId = Number(layerElement.dataset.id);
  let overlay = null;
  for (const candidate of state.overlays) {
    if (candidate.id === overlayId) {
      overlay = candidate;
      break;
    }
  }
  if (!overlay) {
    return;
  }

  // Click pe un buton -> acțiunea butonului; click în altă parte a rândului -> editare.
  let action = 'edit';
  const actionButton = event.target.closest('[data-l]');
  if (actionButton && actionButton.dataset.l) {
    action = actionButton.dataset.l;
  }

  if (action === 'edit') {
    openOverlayDialog(overlay.type, overlay);
  } else if (action === 'toggle') {
    recordUndoSnapshot();
    const updatedOverlays = [];
    for (const existingOverlay of state.overlays) {
      if (existingOverlay.id === overlayId) {
        const toggledOverlay = Object.assign({}, existingOverlay);
        toggledOverlay.hidden = !existingOverlay.hidden;
        toggledOverlay.version = existingOverlay.version + 1;
        updatedOverlays.push(toggledOverlay);
      } else {
        updatedOverlays.push(existingOverlay);
      }
    }
    state.overlays = updatedOverlays;
    finishChange();
  } else if (action === 'del') {
    recordUndoSnapshot();
    state.overlays = removeOverlayById(state.overlays, overlayId);
    finishChange();
    showToast(t('msg.layerDeleted', { type: OVERLAY_TYPE_NAMES[overlay.type] }), 'ok', 2500);
  }
}

/** O listă nouă de straturi, fără stratul cu id-ul dat. */
function removeOverlayById(overlays, overlayId) {
  const remainingOverlays = [];
  for (const overlay of overlays) {
    if (overlay.id !== overlayId) {
      remainingOverlays.push(overlay);
    }
  }
  return remainingOverlays;
}

findElement('#layerList').addEventListener('click', handleLayerListClick);

// ---------------------------------------------------------------------
//  Randarea leneșă a miniaturilor: doar cele vizibile (sau aproape), max. 3 în paralel
// ---------------------------------------------------------------------
const MAX_PARALLEL_THUMBNAILS = 3;
const thumbnailQueue = new Set(); // uid-urile paginilor care așteaptă randarea
let activeThumbnailRenders = 0;

function handleThumbnailVisibility(entries) {
  for (const entry of entries) {
    const uid = Number(entry.target.dataset.uid);
    const card = pageCards.get(uid);
    if (!card) {
      continue;
    }

    const baseIsOutdated = getRenderedBaseKey(card) !== card.wanted.baseKey;
    const overlaysAreOutdated = card.done.overlayKey !== card.wanted.overlayKey;
    const needsRender = baseIsOutdated || overlaysAreOutdated;

    if (entry.isIntersecting && needsRender) {
      thumbnailQueue.add(uid);
    } else {
      thumbnailQueue.delete(uid);
    }
  }
  processThumbnailQueue();
}

const thumbnailObserver = new IntersectionObserver(handleThumbnailVisibility, {
  root: findElement('#scroller'),
  rootMargin: '600px 0px', // pregătește și miniaturile aflate puțin sub / deasupra ecranului
});

/** Pornește randări din coadă, cât timp sunt sub limita de randări simultane. */
function processThumbnailQueue() {
  while (activeThumbnailRenders < MAX_PARALLEL_THUMBNAILS && thumbnailQueue.size > 0) {
    let nextUid;
    for (const queuedUid of thumbnailQueue) {
      nextUid = queuedUid; // primul din coadă
      break;
    }
    thumbnailQueue.delete(nextUid);
    activeThumbnailRenders = activeThumbnailRenders + 1;
    renderThumbnailInBackground(nextUid);
  }
}

/** Randează o miniatură; la final eliberează locul și continuă cu coada. Rulează fără await. */
async function renderThumbnailInBackground(uid) {
  try {
    await renderThumbnail(uid);
  } catch (error) {
    console.error('miniatură', error);
  } finally {
    activeThumbnailRenders = activeThumbnailRenders - 1;
    processThumbnailQueue();
  }
}

async function renderThumbnail(uid) {
  const card = pageCards.get(uid);
  const pageIndex = findPageIndexByUid(uid);
  if (!card || pageIndex < 0) {
    return;
  }
  const page = state.pages[pageIndex];
  const wanted = card.wanted;

  // --- Pasul 1: pagina propriu-zisă (pdf.js) – doar dacă s-a schimbat sursa / rotația / rezoluția ---
  if (getRenderedBaseKey(card) !== wanted.baseKey) {
    const pdfPage = await state.sources[page.sourceId].pdf.getPage(page.pageIndex + 1);
    const rotation = Engine.normalizeAngle(pdfPage.rotate + page.rotation);
    const viewportAtScale1 = pdfPage.getViewport({ scale: 1, rotation: rotation });

    let devicePixelRatio = window.devicePixelRatio;
    if (!devicePixelRatio) {
      devicePixelRatio = 1;
    }
    const targetPixels = state.thumbnailResolution * Math.min(2, devicePixelRatio);
    const scale = targetPixels / Math.max(viewportAtScale1.width, viewportAtScale1.height);
    const viewport = pdfPage.getViewport({ scale: scale, rotation: rotation });

    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = Math.ceil(viewport.width);
    pageCanvas.height = Math.ceil(viewport.height);
    const pageContext = pageCanvas.getContext('2d');
    pageContext.fillStyle = '#fff';
    pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    await pdfPage.render({ canvas: pageCanvas, canvasContext: pageContext, viewport: viewport }).promise;

    if (card.wanted.baseKey !== wanted.baseKey) {
      return; // între timp s-a cerut altceva – randarea se reia
    }

    card.baseRender = {
      key: wanted.baseKey,
      canvas: pageCanvas,
      scale: scale,
      visibleWidth: viewportAtScale1.width,
      visibleHeight: viewportAtScale1.height,
    };
    const widthMm = Math.round(viewportAtScale1.width / Engine.MM);
    const heightMm = Math.round(viewportAtScale1.height / Engine.MM);
    card.element.querySelector('.thumb').title = `${widthMm} × ${heightMm} mm`;
  }

  // --- Pasul 2: compunerea finală – pagina + straturile ---
  const overlayKey = card.wanted.overlayKey;
  const baseRender = card.baseRender;

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = baseRender.canvas.width;
  outputCanvas.height = baseRender.canvas.height;
  const outputContext = outputCanvas.getContext('2d');
  outputContext.drawImage(baseRender.canvas, 0, 0);

  const currentPageIndex = findPageIndexByUid(uid);
  if (currentPageIndex >= 0) {
    const overlayList = getOverlaysForPage(currentPageIndex);
    await drawOverlaysOnCanvas(outputContext, baseRender.scale, baseRender.visibleWidth, baseRender.visibleHeight, overlayList);
  }

  const overlaysChangedMeanwhile = card.wanted.overlayKey !== overlayKey;
  const baseChangedMeanwhile = card.baseRender !== baseRender;
  if (overlaysChangedMeanwhile || baseChangedMeanwhile) {
    thumbnailQueue.add(uid); // se reia cu datele noi
    return;
  }

  card.element.querySelector('.thumb').replaceChildren(outputCanvas);
  card.done.overlayKey = overlayKey;
  card.element.classList.remove('loading');
}

// =====================================================================
//  5. Acțiuni pe pagini
// =====================================================================

/** Rotește paginile indicate cu unghiul dat (în grade, multiplu de 90). */
function rotatePages(pageIndexes, angleDegrees) {
  if (!pageIndexes || pageIndexes.length === 0) {
    return;
  }
  recordUndoSnapshot();
  for (const pageIndex of pageIndexes) {
    const rotatedPage = copyPageRef(state.pages[pageIndex]);
    rotatedPage.rotation = Engine.normalizeAngle(state.pages[pageIndex].rotation + angleDegrees);
    state.pages[pageIndex] = rotatedPage;
  }
  finishChange();
}

/** Elimină paginile indicate din document (se poate anula cu Ctrl+Z). */
function removePages(pageIndexes) {
  if (!pageIndexes || pageIndexes.length === 0) {
    return;
  }
  const indexesToRemove = new Set(pageIndexes);

  recordUndoSnapshot();
  const remainingPages = [];
  for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
    if (!indexesToRemove.has(pageIndex)) {
      remainingPages.push(state.pages[pageIndex]);
    }
  }
  state.pages = remainingPages;
  finishChange();

  removeDeletedPagesFromSelection();
  render();
  showToast(t('msg.removed', { n: pageIndexes.length }), 'ok', 2500);
}

/** Inserează o copie a paginii imediat după ea. */
function duplicatePage(pageIndex) {
  recordUndoSnapshot();
  const pageCopy = copyPageRef(state.pages[pageIndex]);
  pageCopy.uid = createPageUid();
  state.pages.splice(pageIndex + 1, 0, pageCopy);
  finishChange();
}

/** Inversează ordinea paginilor selectate (dacă sunt cel puțin 2) sau a tuturor paginilor. */
function reversePageOrder() {
  let positions = getSelectedPageIndexes();
  if (positions.length < 2) {
    positions = getAllPageIndexes();
  }

  recordUndoSnapshot();
  const pickedPages = [];
  for (const position of positions) {
    pickedPages.push(state.pages[position]);
  }
  pickedPages.reverse();
  for (let pickIndex = 0; pickIndex < positions.length; pickIndex++) {
    state.pages[positions[pickIndex]] = pickedPages[pickIndex];
  }
  finishChange();

  if (positions.length === state.pages.length) {
    showToast(t('msg.reversedAll'), 'ok', 2500);
  } else {
    showToast(t('msg.reversedSel', { n: positions.length }), 'ok', 2500);
  }
}

/** Construiește documentul final (pdf-lib) pentru paginile indicate, cu straturile aplicate. */
async function buildExportDocument(pageIndexes) {
  const pageRefs = [];
  for (const pageIndex of pageIndexes) {
    pageRefs.push(state.pages[pageIndex]);
  }
  const doc = await Engine.buildDoc(pageRefs, state.sources);

  const overlaysByPage = getOverlaysForPages(pageIndexes);
  let hasAnyOverlay = false;
  for (const overlayList of overlaysByPage) {
    if (overlayList.length > 0) {
      hasAnyOverlay = true;
      break;
    }
  }
  if (hasAnyOverlay) {
    await Engine.applyOverlays(doc, overlaysByPage);
  }

  return doc;
}

/** Generează PDF-ul final și îl oferă pentru descărcare. */
async function saveDocument() {
  if (state.pages.length === 0) {
    showToast(t('msg.noPages'), 'warn');
    return;
  }

  async function generateAndDownload() {
    const doc = await buildExportDocument(getAllPageIndexes());
    doc.setTitle(getDocumentName());
    const pdfBytes = await Engine.saveDoc(doc);

    const fileName = `${getDocumentName()}.pdf`;
    downloadFile(pdfBytes, fileName);
    state.hasUnsavedChanges = false;

    const sizeInMegabytes = (pdfBytes.length / 1024 / 1024).toFixed(2);
    showToast(t('msg.saved', { file: fileName, size: sizeInMegabytes }), 'ok');
  }

  await runWithBusyIndicator(t('busy.saving'), generateAndDownload);
}

// ---------------------------------------------------------------------
//  Selecție și evenimente în grilă
// ---------------------------------------------------------------------

/** Selectează paginile cu uid-urile date (înlocuind selecția sau adăugând la ea). */
function setSelection(uids, addToExisting = false) {
  if (!addToExisting) {
    state.selectedUids.clear();
  }
  for (const uid of uids) {
    state.selectedUids.add(uid);
  }
  render();
}

/** uid-urile paginilor dintre pozițiile firstIndex și lastIndex (inclusiv). */
function getUidsBetween(firstIndex, lastIndex) {
  const uids = [];
  for (let pageIndex = firstIndex; pageIndex <= lastIndex; pageIndex++) {
    uids.push(state.pages[pageIndex].uid);
  }
  return uids;
}

function handleGridClick(event) {
  const cardElement = event.target.closest('.card');

  // Click pe fundalul grilei: se anulează selecția.
  if (!cardElement) {
    if (event.target === gridElement) {
      setSelection([]);
    }
    return;
  }

  const uid = Number(cardElement.dataset.uid);
  const pageIndex = findPageIndexByUid(uid);

  // Butoanele de pe cartonaș
  const actionButton = event.target.closest('button[data-a]');
  if (actionButton) {
    event.stopPropagation();
    const action = actionButton.dataset.a;
    if (action === 'rotL') {
      rotatePages([pageIndex], -90);
    } else if (action === 'rotR') {
      rotatePages([pageIndex], 90);
    } else if (action === 'del') {
      removePages([pageIndex]);
    } else if (action === 'more') {
      openPageMenu(actionButton, pageIndex);
    }
    return;
  }

  // Căsuța de bifare: adaugă / scoate pagina din selecție
  if (event.target.classList.contains('chk')) {
    if (event.target.checked) {
      state.selectedUids.add(uid);
    } else {
      state.selectedUids.delete(uid);
    }
    state.selectionAnchorUid = uid;
    render();
    return;
  }

  const modifierPressed = event.ctrlKey || event.metaKey;
  const anchorExists = state.selectionAnchorUid !== null
    && state.selectionAnchorUid !== undefined
    && findPageIndexByUid(state.selectionAnchorUid) >= 0;

  if (event.shiftKey && anchorExists) {
    // Shift+click: toate paginile dintre ancoră și pagina curentă
    const anchorIndex = findPageIndexByUid(state.selectionAnchorUid);
    let firstIndex = pageIndex;
    let lastIndex = anchorIndex;
    if (anchorIndex < pageIndex) {
      firstIndex = anchorIndex;
      lastIndex = pageIndex;
    }
    setSelection(getUidsBetween(firstIndex, lastIndex), modifierPressed);
  } else if (modifierPressed) {
    // Ctrl+click: comută pagina în / din selecție
    if (state.selectedUids.has(uid)) {
      state.selectedUids.delete(uid);
    } else {
      state.selectedUids.add(uid);
    }
    state.selectionAnchorUid = uid;
    render();
  } else {
    // Click simplu: doar această pagină
    state.selectionAnchorUid = uid;
    setSelection([uid]);
  }
}

function handleGridDoubleClick(event) {
  const cardElement = event.target.closest('.card');
  if (!cardElement) {
    return;
  }
  if (event.target.closest('button, input')) {
    return;
  }
  openPreview(findPageIndexByUid(Number(cardElement.dataset.uid)));
}

gridElement.addEventListener('click', handleGridClick);
gridElement.addEventListener('dblclick', handleGridDoubleClick);

// ---------------------------------------------------------------------
//  Meniuri contextuale (meniul „⋯” al unei pagini și meniul de selecție)
// ---------------------------------------------------------------------
// Un element de meniu: { label, action, checked (opțional) } sau MENU_SEPARATOR.
const MENU_SEPARATOR = { separator: true };
const menuElement = findElement('#menu');

function openPageMenu(button, pageIndex) {
  function previewPage() {
    openPreview(pageIndex);
  }
  function rotatePage180() {
    rotatePages([pageIndex], 180);
  }
  function duplicateThisPage() {
    duplicatePage(pageIndex);
  }
  function insertBlankAfter() {
    openInsertDialog({ tab: 'blank', where: 'after', ref: pageIndex + 1 });
  }
  function insertPdfAfter() {
    openInsertDialog({ tab: 'pdf', where: 'after', ref: pageIndex + 1 });
  }
  function insertImageAfter() {
    openInsertDialog({ tab: 'image', where: 'after', ref: pageIndex + 1 });
  }
  function extractThisPage() {
    const fileName = `${getDocumentName()}${t('file.page')}${pageIndex + 1}`;
    extractPages([pageIndex], fileName);
  }
  function cropThisPage() {
    setSelection([state.pages[pageIndex].uid]);
    openCropDialog('crop');
  }
  function fitThisPage() {
    setSelection([state.pages[pageIndex].uid]);
    openCropDialog('fit');
  }

  const menuItems = [
    { label: t('menu.preview'), action: previewPage },
    { label: t('menu.rot180'), action: rotatePage180 },
    { label: t('menu.duplicate'), action: duplicateThisPage },
    MENU_SEPARATOR,
    { label: t('menu.insBlank'), action: insertBlankAfter },
    { label: t('menu.insPdf'), action: insertPdfAfter },
    { label: t('menu.insImg'), action: insertImageAfter },
    MENU_SEPARATOR,
    { label: t('menu.extract'), action: extractThisPage },
    { label: t('menu.crop'), action: cropThisPage },
    { label: t('menu.fit'), action: fitThisPage },
  ];
  showMenu(button, menuItems);
}

/** Creează butonul unui element de meniu. */
function createMenuButton(menuItem) {
  const button = document.createElement('button');

  if (menuItem.checked !== undefined) {
    const checkMark = document.createElement('span');
    checkMark.className = 'check';
    if (menuItem.checked) {
      checkMark.textContent = '✓';
    } else {
      checkMark.textContent = '';
    }
    button.append(checkMark);
  }
  button.append(menuItem.label);

  function runMenuAction() {
    closeMenu();
    menuItem.action();
  }
  button.onclick = runMenuAction;

  return button;
}

/** Afișează meniul sub butonul dat (sau deasupra, dacă nu încape). align: 'right' | 'left'. */
function showMenu(button, menuItems, align = 'right') {
  menuElement.replaceChildren();
  for (const menuItem of menuItems) {
    if (menuItem.separator) {
      menuElement.appendChild(document.createElement('hr'));
    } else {
      menuElement.appendChild(createMenuButton(menuItem));
    }
  }
  menuElement.hidden = false;

  // Poziționare: aliniat cu butonul, în interiorul ferestrei (min. 8 px de la margini).
  const buttonRect = button.getBoundingClientRect();
  const menuWidth = menuElement.offsetWidth;
  const menuHeight = menuElement.offsetHeight;

  let left = buttonRect.right - menuWidth;
  if (align === 'left') {
    left = buttonRect.left;
  }
  const clampedLeft = Math.min(window.innerWidth - menuWidth - 8, Math.max(8, left));
  menuElement.style.left = `${clampedLeft}px`;

  let top = buttonRect.bottom + 4;
  const fitsBelow = buttonRect.bottom + menuHeight + 8 <= window.innerHeight;
  if (!fitsBelow) {
    top = buttonRect.top - menuHeight - 4;
  }
  menuElement.style.top = `${top}px`;
}

function closeMenu() {
  menuElement.hidden = true;
}

/** Click în afara meniului: meniul se închide. */
function handleDocumentMouseDown(event) {
  if (!menuElement.hidden && !menuElement.contains(event.target)) {
    closeMenu();
  }
}

document.addEventListener('mousedown', handleDocumentMouseDown);
window.addEventListener('scroll', closeMenu, true); // true = și la derularea oricărui element interior

// ---------------------------------------------------------------------
//  Drag & drop: reordonarea paginilor + fișiere trase din afara browserului
// ---------------------------------------------------------------------
let draggedUids = null;  // paginile trase în acest moment (null = nu se trag pagini)
let dropMarker = null;   // { element, after }: cartonașul lângă care se va lăsa

function handleDragStart(event) {
  const cardElement = event.target.closest('.card');
  if (!cardElement) {
    return;
  }
  const uid = Number(cardElement.dataset.uid);

  // Dacă pagina trasă e selectată, se mută toată selecția; altfel doar ea.
  if (state.selectedUids.has(uid)) {
    draggedUids = [];
    for (const page of state.pages) {
      if (state.selectedUids.has(page.uid)) {
        draggedUids.push(page.uid);
      }
    }
  } else {
    draggedUids = [uid];
  }

  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/x-pagefix', String(uid));

  for (const draggedUid of draggedUids) {
    const card = pageCards.get(draggedUid);
    if (card) {
      card.element.classList.add('dragging');
    }
  }

  // La mai multe pagini, imaginea trasă e o etichetă „N pagini”.
  if (draggedUids.length > 1) {
    const dragLabel = document.createElement('div');
    dragLabel.className = 'dragghost';
    dragLabel.textContent = t('drag.count', { n: draggedUids.length });
    document.body.appendChild(dragLabel);
    event.dataTransfer.setDragImage(dragLabel, 20, 20);

    function removeDragLabel() {
      dragLabel.remove();
    }
    setTimeout(removeDragLabel, 0); // browserul a copiat deja imaginea
  }
}

/** Scoate marcajul „trage” de pe cartonașele paginilor trase. */
function clearDraggingState() {
  if (draggedUids) {
    for (const draggedUid of draggedUids) {
      const card = pageCards.get(draggedUid);
      if (card) {
        card.element.classList.remove('dragging');
      }
    }
  }
  draggedUids = null;
}

function handleDragEnd() {
  clearDraggingState();
  clearDropMarker();
}

function clearDropMarker() {
  if (dropMarker) {
    dropMarker.element.classList.remove('drop-before', 'drop-after');
  }
  dropMarker = null;
}

/** Unde s-ar lăsa elementele trase: înainte / după cartonașul de sub cursor, sau după ultimul. */
function computeDropMarker(event) {
  let cardElement = null;
  if (typeof event.target.closest === 'function') {
    cardElement = event.target.closest('.card');
  }

  if (cardElement) {
    const cardRect = cardElement.getBoundingClientRect();
    const isRightHalf = event.clientX > cardRect.left + cardRect.width / 2;
    return { element: cardElement, after: isRightHalf };
  }

  const lastCard = gridElement.lastElementChild;
  if (lastCard) {
    return { element: lastCard, after: true };
  }
  return null;
}

/** Poziția din document corespunzătoare marcajului de lăsare. */
function getDropPosition(marker) {
  if (!marker) {
    return state.pages.length;
  }
  const pageIndex = findPageIndexByUid(Number(marker.element.dataset.uid));
  if (marker.after) {
    return pageIndex + 1;
  }
  return pageIndex;
}

/** Se trag fișiere din afara browserului (ex. din Explorer / Finder)? */
function isDraggingExternalFiles(event) {
  if (!event.dataTransfer || !event.dataTransfer.types) {
    return false;
  }
  const dataTypes = event.dataTransfer.types;
  for (let typeIndex = 0; typeIndex < dataTypes.length; typeIndex++) {
    if (dataTypes[typeIndex] === 'Files') {
      return true;
    }
  }
  return false;
}

function handleGridDragOver(event) {
  if (!draggedUids && !isDraggingExternalFiles(event)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();

  if (draggedUids) {
    event.dataTransfer.dropEffect = 'move';
  } else {
    event.dataTransfer.dropEffect = 'copy';
  }

  const marker = computeDropMarker(event);
  if (!marker) {
    return;
  }

  const markerChanged = !dropMarker || dropMarker.element !== marker.element || dropMarker.after !== marker.after;
  if (markerChanged) {
    clearDropMarker();
    dropMarker = marker;
    if (marker.after) {
      marker.element.classList.add('drop-after');
    } else {
      marker.element.classList.add('drop-before');
    }
  }
}

function handleGridDragLeave(event) {
  if (!gridElement.contains(event.relatedTarget)) {
    clearDropMarker();
  }
}

function handleGridDrop(event) {
  event.preventDefault();
  event.stopPropagation();

  const dropPosition = getDropPosition(dropMarker);
  clearDropMarker();

  if (draggedUids) {
    // Reordonare: paginile trase se scot din listă și se inserează la noua poziție.
    const movingUids = new Set(draggedUids);

    // Poziția de inserare, raportată la lista fără paginile mutate.
    const pagesBeforeDropPosition = state.pages.slice(0, dropPosition);
    let insertPosition = 0;
    for (const page of pagesBeforeDropPosition) {
      if (!movingUids.has(page.uid)) {
        insertPosition++;
      }
    }

    const movedPages = [];
    const reorderedPages = [];
    for (const page of state.pages) {
      if (movingUids.has(page.uid)) {
        movedPages.push(page);
      } else {
        reorderedPages.push(page);
      }
    }
    reorderedPages.splice(insertPosition, 0, ...movedPages);

    let orderChanged = false;
    for (let pageIndex = 0; pageIndex < reorderedPages.length; pageIndex++) {
      if (reorderedPages[pageIndex].uid !== state.pages[pageIndex].uid) {
        orderChanged = true;
        break;
      }
    }

    clearDraggingState();

    if (orderChanged) {
      recordUndoSnapshot();
      state.pages = reorderedPages;
      finishChange();
    }
  } else if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
    // Fișiere externe lăsate în grilă: se inserează la poziția marcată.
    loadFiles(event.dataTransfer.files, { at: dropPosition });
  }
}

gridElement.addEventListener('dragstart', handleDragStart);
gridElement.addEventListener('dragend', handleDragEnd);
gridElement.addEventListener('dragover', handleGridDragOver);
gridElement.addEventListener('dragleave', handleGridDragLeave);
gridElement.addEventListener('drop', handleGridDrop);

// Fișiere trase oriunde în fereastră (în afara grilei): se adaugă la finalul documentului.
function handleWindowDragOver(event) {
  if (isDraggingExternalFiles(event)) {
    event.preventDefault();
    document.body.classList.add('dragfile');
  }
}

function handleWindowDragLeave(event) {
  if (!event.relatedTarget) {
    document.body.classList.remove('dragfile'); // cursorul a ieșit din fereastră
  }
}

function handleWindowDrop(event) {
  document.body.classList.remove('dragfile');
  if (!isDraggingExternalFiles(event)) {
    return;
  }
  event.preventDefault();
  if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
    loadFiles(event.dataTransfer.files);
  }
}

function removeDragFileHighlight() {
  document.body.classList.remove('dragfile');
}

window.addEventListener('dragover', handleWindowDragOver);
window.addEventListener('dragleave', handleWindowDragLeave);
window.addEventListener('drop', handleWindowDrop);
gridElement.addEventListener('drop', removeDragFileHighlight, true); // faza de captură: înaintea handleGridDrop

// =====================================================================
//  6. Dialoguri
// =====================================================================

// ---------------------------------------------------------------------
//  Infrastructură: file (tab-uri) și rularea unui dialog
// ---------------------------------------------------------------------

/** Activează fila `tabName` dintr-o bară de file și afișează panoul ei. */
function selectTab(tabBar, tabName) {
  const form = tabBar.closest('form');

  for (const tabButton of findAllElements('[data-tab]', tabBar)) {
    setClass(tabButton, 'active', tabButton.dataset.tab === tabName);
  }
  for (const tabPane of findAllElements('[data-pane]', form)) {
    tabPane.hidden = tabPane.dataset.pane !== tabName;
  }

  form.dataset.tab = tabName; // fila activă se citește din form.dataset.tab
  form.dispatchEvent(new CustomEvent('tabchange', { detail: tabName }));
}

function attachTabBar(tabBar) {
  function handleTabClick(event) {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) {
      selectTab(tabBar, tabButton.dataset.tab);
    }
  }
  tabBar.addEventListener('click', handleTabClick);
}

for (const dialogElement of findAllElements('dialog.dlg')) {
  for (const tabBar of findAllElements('[data-tabs]', dialogElement)) {
    attachTabBar(tabBar);
  }
}

/**
 * Deschide un dialog modal.
 *
 * handleOk(form, action) este apelată la apăsarea butonului „OK” (sau „Șterge”, action = 'delete').
 * Ea validează datele și poate întoarce o funcție (task) care rulează DUPĂ închiderea dialogului.
 * Dacă handleOk aruncă o eroare, mesajul este afișat și dialogul rămâne deschis.
 */
function runDialog(dialogElement, handleOk) {
  const form = findElement('form', dialogElement);

  // Atribuire (nu addEventListener): fiecare deschidere înlocuiește handler-ul anterior.
  form.onsubmit = async function handleSubmit(event) {
    let action;
    if (event.submitter) {
      action = event.submitter.value;
    }
    if (action !== 'ok' && action !== 'delete') {
      return; // „Renunță”: formularul (method="dialog") închide singur dialogul
    }
    event.preventDefault();

    try {
      const task = await handleOk(form, action);
      dialogElement.close();
      if (typeof task === 'function') {
        await task();
      }
    } catch (error) {
      console.error(error);
      showToast(describeError(error), 'error', 7000);
    }
  };

  dialogElement.showModal();
}

/** Paginile alese în câmpul „Se aplică la” (scope) al unui formular. */
function getScopePageIndexes(form) {
  const scope = form.elements.scope.value;

  if (scope === 'all') {
    return getAllPageIndexes();
  }

  if (scope === 'range') {
    const rangeIndexes = Engine.parseRanges(form.elements.scopeRange.value, state.pages.length);
    rangeIndexes.sort(compareNumbersAscending);
    return rangeIndexes;
  }

  // 'sel': paginile selectate
  const selectedIndexes = getSelectedPageIndexes();
  if (selectedIndexes.length === 0) {
    throw new Error(t('err.noSelScope'));
  }
  return selectedIndexes;
}

// ---------------------------------------------------------------------
//  Dialog: selectare după interval
// ---------------------------------------------------------------------
function openSelectRangeDialog() {
  const dialogElement = findElement('#dlgRange');
  const form = findElement('form', dialogElement);
  form.elements.range.value = formatPageRanges(getSelectedPageIndexes());

  function handleOk(submittedForm) {
    const pageIndexes = Engine.parseRanges(submittedForm.elements.range.value, state.pages.length);
    const uids = [];
    for (const pageIndex of pageIndexes) {
      uids.push(state.pages[pageIndex].uid);
    }
    setSelection(uids, submittedForm.elements.add.checked);
  }

  runDialog(dialogElement, handleOk);
  form.elements.range.select();
}

// ---------------------------------------------------------------------
//  Dialog: ștergere pagini
// ---------------------------------------------------------------------
function openDeleteDialog() {
  const dialogElement = findElement('#dlgDelete');
  const form = findElement('form', dialogElement);
  findElement('[data-bind="selCount"]', dialogElement).textContent = state.selectedUids.size;

  if (state.selectedUids.size > 0) {
    form.elements.mode.value = 'sel';
  } else {
    form.elements.mode.value = 'range';
  }

  function handleOk(submittedForm) {
    const mode = submittedForm.elements.mode.value;
    let pageIndexes;

    if (mode === 'sel') {
      pageIndexes = getSelectedPageIndexes();
      if (pageIndexes.length === 0) {
        throw new Error(t('err.noSel'));
      }
    } else if (mode === 'range') {
      pageIndexes = Engine.parseRanges(submittedForm.elements.range.value, state.pages.length);
    } else {
      // 'even' = paginile pare (2, 4, …), 'odd' = paginile impare (1, 3, …)
      let wantedRemainder = 1;
      if (mode === 'even') {
        wantedRemainder = 0;
      }
      pageIndexes = [];
      for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
        const pageNumber = pageIndex + 1;
        if (pageNumber % 2 === wantedRemainder) {
          pageIndexes.push(pageIndex);
        }
      }
    }

    const deletesAllPages = pageIndexes.length === state.pages.length;
    if (deletesAllPages && !confirm(t('confirm.deleteAll'))) {
      throw new Error(t('err.cancelled'));
    }

    removePages(pageIndexes);
  }

  runDialog(dialogElement, handleOk);
}

// ---------------------------------------------------------------------
//  Dialog: inserare (pagini albe, pagini din alt PDF, imagini)
// ---------------------------------------------------------------------

// Formatele de pagină albă: cod -> [format, peisaj (1) / portret (0)]
const BLANK_PAGE_FORMATS = {
  A4P: ['A4', 0],
  A4L: ['A4', 1],
  A3P: ['A3', 0],
  A5P: ['A5', 0],
  LetterP: ['Letter', 0],
};

/**
 * options.tab   = fila deschisă: 'blank' | 'pdf' | 'image'
 * options.where = 'after' | 'before' | 'start' | 'end' (implicit: după ultima pagină selectată)
 * options.ref   = numărul paginii de referință (de la 1)
 */
function openInsertDialog(options = {}) {
  let initialTab = 'blank';
  if (options.tab !== undefined) {
    initialTab = options.tab;
  }
  let initialWhere = null;
  if (options.where !== undefined) {
    initialWhere = options.where;
  }
  let initialReference = null;
  if (options.ref !== undefined) {
    initialReference = options.ref;
  }

  const dialogElement = findElement('#dlgInsert');
  const form = findElement('form', dialogElement);
  const pageCount = state.pages.length;
  const selectedIndexes = getSelectedPageIndexes();

  // Poziția implicită: după ultima pagină selectată (sau după ultima pagină / la final).
  let whereValue = initialWhere;
  if (whereValue === null || whereValue === undefined) {
    if (pageCount > 0) {
      whereValue = 'after';
    } else {
      whereValue = 'end';
    }
  }
  form.elements.where.value = whereValue;

  let referenceValue = initialReference;
  if (referenceValue === null || referenceValue === undefined) {
    if (selectedIndexes.length > 0) {
      referenceValue = selectedIndexes[selectedIndexes.length - 1] + 1;
    } else if (pageCount > 0) {
      referenceValue = pageCount;
    } else {
      referenceValue = 1;
    }
  }
  form.elements.ref.value = referenceValue;
  form.elements.ref.max = Math.max(1, pageCount);

  form.elements.pdfFile.value = '';
  form.elements.imgFiles.value = '';
  selectTab(findElement('[data-tabs]', form), initialTab);

  function handleOk(submittedForm) {
    const fields = submittedForm.elements;
    const where = fields.where.value;
    const referencePage = parseInt(fields.ref.value, 10);

    // Validarea paginii de referință (doar pentru „după” / „înainte de”).
    const needsReference = where === 'after' || where === 'before';
    const referenceIsValid = referencePage >= 1 && referencePage <= pageCount;
    if (needsReference && pageCount > 0 && !referenceIsValid) {
      throw new Error(t('err.refPage', { n: pageCount }));
    }

    // Poziția de inserare în document
    let insertPosition;
    if (pageCount === 0) {
      insertPosition = 0;
    } else if (where === 'start') {
      insertPosition = 0;
    } else if (where === 'end') {
      insertPosition = pageCount;
    } else if (where === 'before') {
      insertPosition = referencePage - 1;
    } else {
      insertPosition = referencePage;
    }

    // Pagina de referință pentru opțiunea „ca pagina de referință” (mărime)
    let referencePageRef = null;
    if (pageCount > 0) {
      let referenceIndex;
      if (where === 'start') {
        referenceIndex = 0;
      } else if (where === 'end') {
        referenceIndex = pageCount - 1;
      } else {
        referenceIndex = referencePage - 1;
      }
      referenceIndex = Math.min(pageCount - 1, Math.max(0, referenceIndex));
      referencePageRef = state.pages[referenceIndex];
    }

    const selectedTab = submittedForm.dataset.tab;

    // --- Pagini albe ---
    if (selectedTab === 'blank') {
      let blankCount = parseInt(fields.blankCount.value, 10);
      if (!blankCount) {
        blankCount = 1;
      }
      blankCount = Math.max(1, Math.min(500, blankCount)); // între 1 și 500
      const blankFormat = fields.blankFormat.value;

      async function insertBlankPages() {
        let pageSize;
        if (blankFormat === 'same' && referencePageRef) {
          pageSize = await getVisibleSizeOfPage(referencePageRef);
        } else {
          let formatInfo = BLANK_PAGE_FORMATS[blankFormat];
          if (!formatInfo) {
            formatInfo = BLANK_PAGE_FORMATS.A4P;
          }
          const formatName = formatInfo[0];
          const isLandscape = formatInfo[1];
          const portraitWidth = Engine.FORMATS[formatName][0];
          const portraitHeight = Engine.FORMATS[formatName][1];
          if (isLandscape) {
            pageSize = [portraitHeight, portraitWidth];
          } else {
            pageSize = [portraitWidth, portraitHeight];
          }
        }

        const pageSizes = [];
        for (let blankNumber = 0; blankNumber < blankCount; blankNumber++) {
          pageSizes.push(pageSize);
        }
        const pdfBytes = await Engine.makeBlankPdf(pageSizes);
        const source = await addSource(pdfBytes, t('card.blank'), { derived: true });

        recordUndoSnapshot();
        const newPageRefs = createPageRefs(source, null, t('card.blank'));
        state.pages.splice(insertPosition, 0, ...newPageRefs);
        finishChange();
      }

      return function runInsertBlankPages() {
        return runWithBusyIndicator(t('busy.blank'), insertBlankPages);
      };
    }

    // --- Pagini din alt PDF ---
    if (selectedTab === 'pdf') {
      const pdfFile = fields.pdfFile.files[0];
      if (!pdfFile) {
        throw new Error(t('err.choosePdf'));
      }
      const rangeText = fields.pdfRange.value;

      async function insertPdfPages() {
        const fileBuffer = await pdfFile.arrayBuffer();
        const source = await addSource(new Uint8Array(fileBuffer), pdfFile.name);
        const pageIndexes = Engine.parseRanges(rangeText, source.numPages, { allowEmpty: true });

        recordUndoSnapshot();
        const newPageRefs = createPageRefs(source, pageIndexes);
        state.pages.splice(insertPosition, 0, ...newPageRefs);
        finishChange();

        showToast(t('msg.insertedFrom', { n: pageIndexes.length, name: pdfFile.name }), 'ok', 2500);
      }

      return function runInsertPdfPages() {
        return runWithBusyIndicator(t('busy.loadingFile', { name: pdfFile.name }), insertPdfPages);
      };
    }

    // --- Imagini ca pagini ---
    if (selectedTab === 'image') {
      const imageFiles = Array.from(fields.imgFiles.files);
      if (imageFiles.length === 0) {
        throw new Error(t('err.chooseImages'));
      }
      const imageFormat = fields.imgFormat.value;
      let marginMm = Number(fields.imgMargin.value);
      if (!marginMm) {
        marginMm = 0;
      }

      async function insertImagePages() {
        let referenceSize = null;
        if (imageFormat === 'same' && referencePageRef) {
          referenceSize = await getVisibleSizeOfPage(referencePageRef);
        }

        // „ca pagina de referință” fără pagină de referință -> A4
        let formatToUse = imageFormat;
        if (imageFormat === 'same' && !referenceSize) {
          formatToUse = 'A4';
        }

        const pdfBytes = await Engine.imagesToPdf(imageFiles, {
          format: formatToUse,
          margin: marginMm,
          refSize: referenceSize,
        });
        const source = await addSource(pdfBytes, 'imagini', { derived: true });

        recordUndoSnapshot();
        const newPageRefs = [];
        for (let imageNumber = 0; imageNumber < imageFiles.length; imageNumber++) {
          const refs = createPageRefs(source, [imageNumber], imageFiles[imageNumber].name);
          newPageRefs.push(refs[0]);
        }
        state.pages.splice(insertPosition, 0, ...newPageRefs);
        finishChange();
      }

      return function runInsertImagePages() {
        return runWithBusyIndicator(t('busy.convertImages', { n: imageFiles.length }), insertImagePages);
      };
    }

    return null;
  }

  runDialog(dialogElement, handleOk);
}

// ---------------------------------------------------------------------
//  Dialog: extragere pagini într-un PDF nou
// ---------------------------------------------------------------------

/** Generează un PDF doar cu paginile indicate și îl oferă pentru descărcare. */
async function extractPages(pageIndexes, fileName) {
  async function generateAndDownload() {
    const doc = await buildExportDocument(pageIndexes);
    const pdfBytes = await Engine.saveDoc(doc);
    downloadFile(pdfBytes, `${makeSafeFileName(fileName)}.pdf`);
  }
  await runWithBusyIndicator(t('busy.extracting'), generateAndDownload);
}

function openExtractDialog() {
  const dialogElement = findElement('#dlgExtract');
  const form = findElement('form', dialogElement);
  form.elements.range.value = formatPageRanges(getSelectedPageIndexes());
  form.elements.name.value = `${getDocumentName()}${t('file.extract')}`;
  form.elements.remove.checked = false;

  function handleOk(submittedForm) {
    const pageIndexes = Engine.parseRanges(submittedForm.elements.range.value, state.pages.length);

    let fileName = submittedForm.elements.name.value;
    if (!fileName) {
      fileName = `${getDocumentName()}${t('file.extract')}`;
    }
    const removeAfterExtract = submittedForm.elements.remove.checked;

    return async function extractAndMaybeRemove() {
      await extractPages(pageIndexes, fileName);
      if (removeAfterExtract) {
        removePages(pageIndexes);
      }
    };
  }

  runDialog(dialogElement, handleOk);
}

// ---------------------------------------------------------------------
//  Dialog: intercalare cu alt PDF (ex. scanări față / verso făcute separat)
// ---------------------------------------------------------------------
function openInterleaveDialog() {
  const dialogElement = findElement('#dlgInterleave');
  const form = findElement('form', dialogElement);
  form.elements.file.value = '';

  function handleOk(submittedForm) {
    const pdfFile = submittedForm.elements.file.files[0];
    if (!pdfFile) {
      throw new Error(t('err.choosePdf'));
    }
    const reverseNewPages = submittedForm.elements.reverse.checked;
    const newPagesFirst = submittedForm.elements.newFirst.checked;

    async function interleavePages() {
      const fileBuffer = await pdfFile.arrayBuffer();
      const source = await addSource(new Uint8Array(fileBuffer), pdfFile.name);

      const newPages = createPageRefs(source);
      if (reverseNewPages) {
        newPages.reverse();
      }
      const currentPages = state.pages;

      // Alternativ: o pagină din documentul curent, una din cel nou (sau invers).
      const interleavedPages = [];
      const longestLength = Math.max(currentPages.length, newPages.length);
      for (let pairIndex = 0; pairIndex < longestLength; pairIndex++) {
        let firstPage = currentPages[pairIndex];
        let secondPage = newPages[pairIndex];
        if (newPagesFirst) {
          firstPage = newPages[pairIndex];
          secondPage = currentPages[pairIndex];
        }
        if (firstPage) {
          interleavedPages.push(firstPage);
        }
        if (secondPage) {
          interleavedPages.push(secondPage);
        }
      }

      recordUndoSnapshot();
      state.pages = interleavedPages;
      finishChange();

      if (currentPages.length !== newPages.length) {
        showToast(t('warn.interleave', { a: currentPages.length, b: newPages.length }), 'warn', 7000);
      }
    }

    return function runInterleave() {
      return runWithBusyIndicator(t('busy.interleaving', { name: pdfFile.name }), interleavePages);
    };
  }

  runDialog(dialogElement, handleOk);
}

// ---------------------------------------------------------------------
//  Dialog: împărțirea documentului în mai multe PDF-uri (arhivă ZIP)
// ---------------------------------------------------------------------
function openSplitDialog() {
  const dialogElement = findElement('#dlgSplit');
  const form = findElement('form', dialogElement);
  form.elements.prefix.value = getDocumentName();

  function handleOk(submittedForm) {
    const pageCount = state.pages.length;
    const mode = submittedForm.elements.mode.value;
    let groups;

    if (mode === 'each') {
      // câte un fișier pentru fiecare pagină
      groups = [];
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        groups.push([pageIndex]);
      }
    } else if (mode === 'every') {
      // câte N pagini per fișier
      const pagesPerFile = parseInt(submittedForm.elements.n.value, 10);
      const pagesPerFileIsValid = pagesPerFile >= 1; // false și pentru NaN
      if (!pagesPerFileIsValid) {
        throw new Error(t('err.perFile'));
      }
      groups = [];
      for (let groupStart = 0; groupStart < pageCount; groupStart += pagesPerFile) {
        const groupSize = Math.min(pagesPerFile, pageCount - groupStart);
        const group = [];
        for (let offset = 0; offset < groupSize; offset++) {
          group.push(groupStart + offset);
        }
        groups.push(group);
      }
    } else {
      // intervale separate prin „;”
      groups = Engine.parseRangeGroups(submittedForm.elements.ranges.value, pageCount);
    }

    let prefixText = submittedForm.elements.prefix.value;
    if (!prefixText) {
      prefixText = getDocumentName();
    }
    const filePrefix = makeSafeFileName(prefixText);

    async function splitIntoZip() {
      const zip = new window.JSZip();
      const numberWidth = String(groups.length).length; // pentru numerotare cu zerouri: 01, 02, …

      for (let groupNumber = 0; groupNumber < groups.length; groupNumber++) {
        setBusyMessage(t('busy.splitFile', { i: groupNumber + 1, n: groups.length }));

        const doc = await buildExportDocument(groups[groupNumber]);
        const rangeLabel = formatPageRanges(groups[groupNumber]).replace(/,\s*/g, '_');
        const sequenceNumber = String(groupNumber + 1).padStart(numberWidth, '0');
        const fileName = `${filePrefix}_${sequenceNumber}_p${rangeLabel}.pdf`;

        const pdfBytes = await Engine.saveDoc(doc);
        zip.file(fileName, pdfBytes);
      }

      setBusyMessage(t('busy.zip'));
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      downloadFile(zipBlob, `${filePrefix}${t('file.split')}.zip`, 'application/zip');
      showToast(t('msg.split', { n: groups.length }), 'ok');
    }

    return function runSplit() {
      return runWithBusyIndicator(t('busy.splitting'), splitIntoZip);
    };
  }

  runDialog(dialogElement, handleOk);
}

// ---------------------------------------------------------------------
//  Dialog: decupare margini și încadrare în format
// ---------------------------------------------------------------------
// Starea previzualizării de decupare. Dreptunghiul (rect) e în pixeli CSS ai canvas-ului: {x, y, w, h}.
const cropState = { scale: 1, width: 0, height: 0, rect: null, drag: null };

async function openCropDialog(initialTab = 'crop') {
  const dialogElement = findElement('#dlgCrop');
  const form = findElement('form', dialogElement);

  if (state.selectedUids.size > 0) {
    form.elements.scope.value = 'sel';
  } else {
    form.elements.scope.value = 'all';
  }
  for (const marginField of ['mt', 'mr', 'mb', 'ml']) {
    form.elements[marginField].value = 0;
  }
  selectTab(findElement('[data-tabs]', form), initialTab);

  // Pagina afișată în previzualizare: prima selectată sau prima din document.
  const selectedIndexes = getSelectedPageIndexes();
  let previewIndex = 0;
  if (selectedIndexes.length > 0) {
    previewIndex = selectedIndexes[0];
  }
  const previewPage = state.pages[previewIndex];

  function handleOk(submittedForm) {
    const pageIndexes = getScopePageIndexes(submittedForm);
    const fields = submittedForm.elements;

    // --- Încadrare în format ---
    if (submittedForm.dataset.tab === 'fit') {
      let fitMarginMm = Number(fields.fitMargin.value);
      if (!fitMarginMm) {
        fitMarginMm = 0;
      }
      const fitOptions = {
        format: fields.format.value,
        orient: fields.orient.value,
        margin: fitMarginMm,
        noUpscale: fields.noUpscale.checked,
      };
      const busyMessage = t('busy.fitting', { n: pageIndexes.length, f: fitOptions.format });

      return function runFit() {
        return applyBake(pageIndexes, Engine.fitOp(fitOptions), busyMessage);
      };
    }

    // --- Decupare margini ---
    const marginsMm = {
      t: readNumberOrZero(fields.mt.value),
      r: readNumberOrZero(fields.mr.value),
      b: readNumberOrZero(fields.mb.value),
      l: readNumberOrZero(fields.ml.value),
    };
    const marginValues = [marginsMm.t, marginsMm.r, marginsMm.b, marginsMm.l];

    let hasNegativeMargin = false;
    let hasPositiveMargin = false;
    for (const marginValue of marginValues) {
      if (marginValue < 0) {
        hasNegativeMargin = true;
      }
      if (marginValue > 0) {
        hasPositiveMargin = true;
      }
    }
    if (hasNegativeMargin) {
      throw new Error(t('err.negMargins'));
    }
    if (!hasPositiveMargin) {
      throw new Error(t('err.zeroMargins'));
    }

    const busyMessage = t('busy.cropping', { n: pageIndexes.length });
    return function runCrop() {
      return applyBake(pageIndexes, Engine.cropOp(marginsMm), busyMessage);
    };
  }

  runDialog(dialogElement, handleOk);

  // --- Previzualizarea paginii, la o mărime care încape în dialog ---
  const previewWrapper = findElement('#cropPreview');
  const previewCanvas = findElement('canvas', previewWrapper);
  const pdfPage = await state.sources[previewPage.sourceId].pdf.getPage(previewPage.pageIndex + 1);
  const rotation = Engine.normalizeAngle(pdfPage.rotate + previewPage.rotation);
  const viewportAtScale1 = pdfPage.getViewport({ scale: 1, rotation: rotation });

  const maxWidth = Math.min(460, window.innerWidth * 0.5);
  const maxHeight = Math.min(560, window.innerHeight * 0.6);
  cropState.scale = Math.min(maxWidth / viewportAtScale1.width, maxHeight / viewportAtScale1.height);

  let devicePixelRatio = window.devicePixelRatio;
  if (!devicePixelRatio) {
    devicePixelRatio = 1;
  }
  const pixelRatio = Math.min(2, devicePixelRatio);
  const viewport = pdfPage.getViewport({ scale: cropState.scale * pixelRatio, rotation: rotation });

  previewCanvas.width = Math.ceil(viewport.width);
  previewCanvas.height = Math.ceil(viewport.height);
  cropState.width = viewport.width / pixelRatio;
  cropState.height = viewport.height / pixelRatio;
  previewCanvas.style.width = `${cropState.width}px`;
  previewCanvas.style.height = `${cropState.height}px`;

  const previewContext = previewCanvas.getContext('2d');
  previewContext.fillStyle = '#fff';
  previewContext.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  await pdfPage.render({ canvas: previewCanvas, canvasContext: previewContext, viewport: viewport }).promise;

  cropState.rect = { x: 0, y: 0, w: cropState.width, h: cropState.height };
  drawCropRectangle();
}

/** Valoarea numerică a unui câmp; 0 dacă e gol sau invalid. */
function readNumberOrZero(fieldValue) {
  const numberValue = Number(fieldValue);
  if (!numberValue) {
    return 0;
  }
  return numberValue;
}

/** Pixeli de previzualizare per milimetru. */
function cropPixelsPerMm() {
  return cropState.scale * Engine.MM;
}

function drawCropRectangle() {
  const rect = cropState.rect;
  const rectElement = findElement('#cropRect');
  if (!rect) {
    return;
  }
  rectElement.style.left = `${rect.x}px`;
  rectElement.style.top = `${rect.y}px`;
  rectElement.style.width = `${rect.w}px`;
  rectElement.style.height = `${rect.h}px`;
}

/** Dreptunghiul desenat -> câmpurile de margini (mm, rotunjite la 0,5 mm). */
function copyCropRectangleToInputs() {
  const fields = findElement('#dlgCrop form').elements;
  const rect = cropState.rect;
  const pixelsPerMm = cropPixelsPerMm();

  function pixelsToRoundedMm(pixels) {
    return Math.max(0, Math.round((pixels / pixelsPerMm) * 2) / 2);
  }

  fields.mt.value = pixelsToRoundedMm(rect.y);
  fields.ml.value = pixelsToRoundedMm(rect.x);
  fields.mb.value = pixelsToRoundedMm(cropState.height - rect.y - rect.h);
  fields.mr.value = pixelsToRoundedMm(cropState.width - rect.x - rect.w);
}

/** Câmpurile de margini -> dreptunghiul desenat. */
function copyInputsToCropRectangle() {
  const fields = findElement('#dlgCrop form').elements;
  const pixelsPerMm = cropPixelsPerMm();

  const topPixels = readNumberOrZero(fields.mt.value) * pixelsPerMm;
  const leftPixels = readNumberOrZero(fields.ml.value) * pixelsPerMm;
  const bottomPixels = readNumberOrZero(fields.mb.value) * pixelsPerMm;
  const rightPixels = readNumberOrZero(fields.mr.value) * pixelsPerMm;

  cropState.rect = {
    x: leftPixels,
    y: topPixels,
    w: Math.max(4, cropState.width - leftPixels - rightPixels),
    h: Math.max(4, cropState.height - topPixels - bottomPixels),
  };
  drawCropRectangle();
}

function handleCropFormInput(event) {
  const isMarginField = /^m[trbl]$/.test(event.target.name); // mt, mr, mb, ml
  if (isMarginField) {
    copyInputsToCropRectangle();
  }
}

/** Butonul „Anulează decupările existente” – se aplică imediat paginilor alese. */
function handleResetCropClick() {
  const dialogElement = findElement('#dlgCrop');
  let pageIndexes;
  try {
    pageIndexes = getScopePageIndexes(findElement('form', dialogElement));
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  dialogElement.close();
  applyBake(pageIndexes, Engine.resetCropOp(), t('busy.resetCrop'));
}

findElement('#dlgCrop form').addEventListener('input', handleCropFormInput);
findElement('#dlgCrop [data-act="resetCrop"]').addEventListener('click', handleResetCropClick);

/** Desenarea / mutarea / redimensionarea dreptunghiului de decupare cu mouse-ul. */
function setupCropRectangleDragging() {
  const previewWrapper = findElement('#cropPreview');

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  /** Poziția cursorului în previzualizare (px), limitată la marginile paginii. */
  function getPointerPosition(event) {
    const canvasRect = findElement('canvas', previewWrapper).getBoundingClientRect();
    return {
      x: clamp(event.clientX - canvasRect.left, 0, cropState.width),
      y: clamp(event.clientY - canvasRect.top, 0, cropState.height),
    };
  }

  function copyRect(rect) {
    return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  }

  function handlePointerDown(event) {
    if (!cropState.rect) {
      return;
    }
    event.preventDefault();
    previewWrapper.setPointerCapture(event.pointerId);

    const pointer = getPointerPosition(event);
    const rect = cropState.rect;
    const resizeHandle = event.target.closest('.h');
    const rectCoversWholePage = rect.w >= cropState.width - 2 && rect.h >= cropState.height - 2;

    if (resizeHandle) {
      // Tragere de un colț: redimensionare. Colțul e a doua clasă a mânerului: nw, ne, sw, se.
      let cornerName;
      for (const className of resizeHandle.classList) {
        if (className !== 'h') {
          cornerName = className;
          break;
        }
      }
      cropState.drag = { mode: 'resize', corner: cornerName, start: pointer, original: copyRect(rect) };
    } else if (event.target.closest('#cropRect') && !rectCoversWholePage) {
      // Tragere în interiorul unui dreptunghi mai mic decât pagina: mutare.
      cropState.drag = { mode: 'move', start: pointer, original: copyRect(rect) };
    } else {
      // Altfel: se desenează un dreptunghi nou.
      cropState.drag = { mode: 'new', start: pointer };
    }
  }

  function handlePointerMove(event) {
    const drag = cropState.drag;
    if (!drag) {
      return;
    }
    const pointer = getPointerPosition(event);

    if (drag.mode === 'new') {
      cropState.rect = {
        x: Math.min(drag.start.x, pointer.x),
        y: Math.min(drag.start.y, pointer.y),
        w: Math.abs(pointer.x - drag.start.x),
        h: Math.abs(pointer.y - drag.start.y),
      };
    } else if (drag.mode === 'move') {
      const original = drag.original;
      cropState.rect = {
        x: clamp(original.x + pointer.x - drag.start.x, 0, cropState.width - original.w),
        y: clamp(original.y + pointer.y - drag.start.y, 0, cropState.height - original.h),
        w: original.w,
        h: original.h,
      };
    } else {
      // resize: colțul tras urmează cursorul, colțul opus rămâne pe loc
      const original = drag.original;
      let left = original.x;
      let top = original.y;
      let right = original.x + original.w;
      let bottom = original.y + original.h;

      if (drag.corner.includes('n')) {
        top = pointer.y;
      } else {
        bottom = pointer.y;
      }
      if (drag.corner.includes('w')) {
        left = pointer.x;
      } else {
        right = pointer.x;
      }

      cropState.rect = {
        x: Math.min(left, right),
        y: Math.min(top, bottom),
        w: Math.abs(right - left),
        h: Math.abs(bottom - top),
      };
    }

    drawCropRectangle();
    copyCropRectangleToInputs();
  }

  function handlePointerEnd() {
    // Un dreptunghi prea mic (ex. un simplu click) revine la pagina întreagă.
    const rectIsTooSmall = cropState.rect && (cropState.rect.w < 6 || cropState.rect.h < 6);
    if (cropState.drag && rectIsTooSmall) {
      cropState.rect = { x: 0, y: 0, w: cropState.width, h: cropState.height };
      drawCropRectangle();
      copyCropRectangleToInputs();
    }
    cropState.drag = null;
  }

  previewWrapper.addEventListener('pointerdown', handlePointerDown);
  previewWrapper.addEventListener('pointermove', handlePointerMove);
  previewWrapper.addEventListener('pointerup', handlePointerEnd);
  previewWrapper.addEventListener('pointercancel', handlePointerEnd);
}

setupCropRectangleDragging();

// ---------------------------------------------------------------------
//  Dialog: adăugare / editare strat (numerotare, antet/subsol, watermark, imagine)
// ---------------------------------------------------------------------

// Valorile implicite din configurație (config.php -> index.php -> window.APP_CONFIG.defaults).
let CONFIG_DEFAULTS = APP_CONFIG.defaults;
if (!CONFIG_DEFAULTS) {
  CONFIG_DEFAULTS = {};
}

let defaultPageNumberFormat = CONFIG_DEFAULTS.page_number_format;
if (!defaultPageNumberFormat) {
  defaultPageNumberFormat = t('ov.fmt.pageOf');
}
let defaultHeaderText = CONFIG_DEFAULTS.header_text;
if (!defaultHeaderText) {
  defaultHeaderText = '';
}
let defaultWatermarkText = CONFIG_DEFAULTS.watermark_text;
if (!defaultWatermarkText) {
  defaultWatermarkText = t('ov.defaultWatermark');
}

// Setările implicite ale unui strat nou, pe tipuri.
const OVERLAY_DEFAULTS = {
  num: { pos: 'bc', margin: 10, size: 10, color: '#333333', bold: false, fmt: defaultPageNumberFormat, start: 1, skipFirst: false },
  text: { pos: 'tc', margin: 10, size: 9, color: '#333333', bold: false, text: defaultHeaderText },
  wm: { text: defaultWatermarkText, angle: 45, opacity: 20, size: 0, color: '#cc0000', bold: true },
  img: { pos: 'br', margin: 10, widthPct: 20, opacity: 100 },
};

/** Valoarea `value`, sau `fallback` dacă `value` este null / undefined. */
function valueOrDefault(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  return value;
}

/**
 * Deschide dialogul de strat.
 * overlayType: 'num' | 'text' | 'wm' | 'img'; existingOverlay = stratul editat (null = strat nou).
 */
function openOverlayDialog(overlayType, existingOverlay = null) {
  if (state.pages.length === 0) {
    showToast(t('msg.openFirst'), 'warn');
    return;
  }

  const dialogElement = findElement('#dlgOverlay');
  const form = findElement('form', dialogElement);
  const fields = form.elements;
  const isEditing = existingOverlay !== null && existingOverlay !== undefined;

  // Valorile afișate: ale stratului editat sau cele implicite.
  let settings = OVERLAY_DEFAULTS[overlayType];
  if (isEditing) {
    settings = existingOverlay;
  }

  // --- Titlul și câmpurile vizibile pentru acest tip de strat ---
  let titleKey = 'ov.titleAdd';
  if (isEditing) {
    titleKey = 'ov.titleEdit';
  }
  findElement('#ovTitle').textContent = t(titleKey, { type: OVERLAY_TYPE_NAMES[overlayType] });

  for (const pane of findAllElements('[data-ov]', form)) {
    pane.hidden = pane.dataset.ov !== overlayType;
  }
  for (const fieldLabel of findAllElements('[data-hide-for]', form)) {
    const hiddenForTypes = fieldLabel.dataset.hideFor.split(' ');
    fieldLabel.hidden = hiddenForTypes.includes(overlayType);
  }

  // --- Câmpurile comune (aspect) ---
  fields.pos.value = valueOrDefault(settings.pos, 'bc');
  fields.margin.value = valueOrDefault(settings.margin, 10);
  if (overlayType === 'num' || overlayType === 'text') {
    fields.size.value = settings.size;
  } else {
    fields.size.value = 10; // la watermark mărimea are câmp propriu; la imagine nu se folosește
  }
  fields.color.value = valueOrDefault(settings.color, '#333333');
  fields.bold.checked = Boolean(settings.bold);

  // --- Câmpurile specifice tipului ---
  if (overlayType === 'num') {
    // Un format din config.php care nu e în listă se adaugă ca opțiune nouă.
    let formatIsListed = false;
    for (const option of fields.numFmt.options) {
      if (option.value === settings.fmt) {
        formatIsListed = true;
      }
    }
    if (!formatIsListed) {
      const exampleText = settings.fmt.replace('{n}', '1').replace('{total}', '10');
      fields.numFmt.add(new Option(exampleText, settings.fmt));
    }
    fields.numFmt.value = settings.fmt;
    fields.numStart.value = settings.start;
    fields.numSkipFirst.checked = Boolean(settings.skipFirst);
  }

  if (overlayType === 'text') {
    fields.txt.value = valueOrDefault(settings.text, '');
  }

  if (overlayType === 'wm') {
    fields.wmText.value = settings.text;
    fields.wmAngle.value = settings.angle;
    fields.wmOpacity.value = settings.opacity;
    let watermarkSize = settings.size;
    if (!watermarkSize) {
      watermarkSize = 0;
    }
    fields.wmSize.value = watermarkSize;
  }

  if (overlayType === 'img') {
    fields.imgFile.value = '';
    fields.imgWidth.value = settings.widthPct;
    fields.imgOpacity.value = settings.opacity;

    const currentImageText = findElement('#ovImgCurrent');
    currentImageText.hidden = !isEditing;
    if (isEditing) {
      let imageName = existingOverlay.imageName;
      if (!imageName) {
        imageName = t('ov.img.default');
      }
      currentImageText.textContent = t('ov.img.current', { name: imageName });
    } else {
      currentImageText.textContent = '';
    }
  }

  // --- Domeniul (paginile la care se aplică) ---
  if (isEditing) {
    if (existingOverlay.scope === 'all') {
      fields.scope.value = 'all';
      fields.scopeRange.value = '';
    } else {
      fields.scope.value = 'range';
      fields.scopeRange.value = formatPageRanges(getOverlayScopePageIndexes(existingOverlay));
    }
  } else {
    if (state.selectedUids.size > 0) {
      fields.scope.value = 'sel';
    } else {
      fields.scope.value = 'all';
    }
    fields.scopeRange.value = '';
  }

  // --- Dacă există deja un strat de același tip, se oferă editarea lui (în loc de încă o copie) ---
  const sameTypeOverlays = [];
  for (const overlay of state.overlays) {
    if (overlay.type === overlayType) {
      sameTypeOverlays.push(overlay);
    }
  }

  const noticeElement = findElement('#ovNotice');
  noticeElement.hidden = isEditing || sameTypeOverlays.length === 0;
  if (!noticeElement.hidden) {
    let noticeText;
    if (sameTypeOverlays.length === 1) {
      noticeText = t('ov.noticeOne');
    } else {
      noticeText = t('ov.noticeMany', { n: sameTypeOverlays.length });
    }
    noticeElement.innerHTML = `${escapeHtml(noticeText)} `
      + `<button type="button" class="btn small">${escapeHtml(t('ov.noticeEdit'))}</button>`
      + `<br><small>${escapeHtml(t('ov.noticeOr'))}</small>`;

    function editExistingOverlay() {
      dialogElement.close();
      openOverlayDialog(overlayType, sameTypeOverlays[sameTypeOverlays.length - 1]);
    }
    noticeElement.querySelector('button').onclick = editExistingOverlay;
  }

  findElement('#ovDelete').hidden = !isEditing;
  let okButtonKey = 'ov.add';
  if (isEditing) {
    okButtonKey = 'ov.save';
  }
  findElement('#ovOk').textContent = t(okButtonKey);

  // --- Salvarea ---
  async function handleOk(submittedForm, action) {
    if (action === 'delete') {
      recordUndoSnapshot();
      state.overlays = removeOverlayById(state.overlays, existingOverlay.id);
      finishChange();
      showToast(t('msg.layerDeleted', { type: OVERLAY_TYPE_NAMES[overlayType] }), 'ok', 2500);
      return null;
    }

    // Paginile la care se aplică stratul: 'all' sau mulțimea uid-urilor paginilor.
    let scope;
    if (fields.scope.value === 'all') {
      scope = 'all';
    } else if (fields.scope.value === 'sel') {
      if (state.selectedUids.size === 0) {
        throw new Error(t('err.noSelScope'));
      }
      scope = new Set(state.selectedUids);
    } else {
      const rangeIndexes = Engine.parseRanges(fields.scopeRange.value, state.pages.length);
      scope = new Set();
      for (const pageIndex of rangeIndexes) {
        scope.add(state.pages[pageIndex].uid);
      }
    }

    // Identificatorul și versiunea (versiunea crește la fiecare modificare -> miniaturile se redesenează).
    let overlayId;
    let version;
    let hidden;
    if (isEditing) {
      overlayId = existingOverlay.id;
      version = existingOverlay.version + 1;
      hidden = existingOverlay.hidden;
    } else {
      overlayId = nextOverlayId;
      nextOverlayId = nextOverlayId + 1;
      version = 1;
      hidden = false;
    }

    const overlay = {
      id: overlayId,
      version: version,
      type: overlayType,
      hidden: hidden,
      scope: scope,
      pos: fields.pos.value,
      margin: readNumberOrZero(fields.margin.value),
      size: readNumberOrDefault(fields.size.value, 10),
      color: fields.color.value,
      bold: fields.bold.checked,
    };

    if (overlayType === 'num') {
      let startNumber = parseInt(fields.numStart.value, 10);
      if (!startNumber) {
        startNumber = 1;
      }
      overlay.fmt = fields.numFmt.value;
      overlay.start = startNumber;
      overlay.skipFirst = fields.numSkipFirst.checked;
    }

    if (overlayType === 'text') {
      overlay.text = fields.txt.value;
      if (!overlay.text.trim()) {
        throw new Error(t('err.textHeader'));
      }
    }

    if (overlayType === 'wm') {
      overlay.text = fields.wmText.value;
      overlay.angle = readNumberOrZero(fields.wmAngle.value);
      overlay.opacity = readNumberOrDefault(fields.wmOpacity.value, 20);
      overlay.size = readNumberOrZero(fields.wmSize.value);
      if (!overlay.text.trim()) {
        throw new Error(t('err.textWm'));
      }
    }

    if (overlayType === 'img') {
      const imageFile = fields.imgFile.files[0];
      if (imageFile) {
        overlay.image = await Engine.readImage(imageFile);
        overlay.imageName = imageFile.name;
      } else if (isEditing && existingOverlay.image) {
        overlay.image = existingOverlay.image; // se păstrează imaginea existentă
        overlay.imageName = existingOverlay.imageName;
      } else {
        throw new Error(t('err.chooseImage'));
      }
      overlay.widthPct = readNumberOrDefault(fields.imgWidth.value, 20);
      overlay.opacity = readNumberOrDefault(fields.imgOpacity.value, 100);
    }

    recordUndoSnapshot();
    if (isEditing) {
      const updatedOverlays = [];
      for (const existing of state.overlays) {
        if (existing.id === overlay.id) {
          updatedOverlays.push(overlay);
        } else {
          updatedOverlays.push(existing);
        }
      }
      state.overlays = updatedOverlays;
    } else {
      const extendedOverlays = Array.from(state.overlays);
      extendedOverlays.push(overlay);
      state.overlays = extendedOverlays;
      if (state.overlays.length === 1) {
        state.isLayersPanelOpen = true; // la primul strat, panoul de straturi se deschide singur
      }
    }
    finishChange();

    let messageKey = 'msg.ovAdded';
    if (isEditing) {
      messageKey = 'msg.ovUpdated';
    }
    showToast(t(messageKey, { type: OVERLAY_TYPE_NAMES[overlayType] }), 'ok', 3500);
    return null;
  }

  runDialog(dialogElement, handleOk);
}

/** Valoarea numerică a unui câmp; `fallback` dacă e goală, invalidă sau 0. */
function readNumberOrDefault(fieldValue, fallback) {
  const numberValue = Number(fieldValue);
  if (!numberValue) {
    return fallback;
  }
  return numberValue;
}

// =====================================================================
//  7. Previzualizare mare (cu zoom și deplasare)
// =====================================================================
// Zoom 100% = mărimea reală a paginii pe ecran (1 pt = 96/72 px, ca în Acrobat / pdf.js).
const CSS_PIXELS_PER_POINT = 96 / 72;
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const MAX_CANVAS_PIXELS = 24e6; // limită pentru memoria plăcii video; peste ea imaginea se întinde

let initialPreviewZoom = 'page';
if (APP_CONFIG.ui && APP_CONFIG.ui.preview_fit === 'width') {
  initialPreviewZoom = 'width';
}

const preview = {
  pageIndex: 0,
  zoom: initialPreviewZoom,  // număr (1 = 100%) sau 'page' / 'width' (încadrare automată)
  pdfPage: null,
  rotation: 0,
  viewportAtScale1: null,
  renderTask: null,
  generation: 0,             // crește la fiecare randare; o randare veche nu mai afișează nimic
  redrawTimer: null,
};

const previewDialog = findElement('#dlgPreview');
const previewBody = findElement('#pvBody');
const previewCanvas = findElement('#pvCanvas');

function openPreview(pageIndex, options = {}) {
  let keepScroll = false;
  if (options.keepScroll !== undefined) {
    keepScroll = options.keepScroll;
  }

  if (pageIndex < 0 || pageIndex >= state.pages.length) {
    return;
  }
  preview.pageIndex = pageIndex;
  if (!previewDialog.open) {
    previewDialog.showModal();
  }
  renderPreviewAndResetScroll(keepScroll); // rulează fără await
}

async function renderPreviewAndResetScroll(keepScroll) {
  await renderPreview();
  if (!keepScroll) {
    previewBody.scrollTo(0, 0);
  }
}

/** Factorul de zoom efectiv (1 = 100%), inclusiv pentru 'page' / 'width'. */
function getPreviewZoomFactor() {
  if (typeof preview.zoom === 'number') {
    return preview.zoom;
  }
  if (!preview.viewportAtScale1) {
    return 1;
  }

  const padding = 32;
  const scrollbarSpace = 18; // loc pentru bara de derulare verticală
  const pageWidthPx = preview.viewportAtScale1.width * CSS_PIXELS_PER_POINT;
  const pageHeightPx = preview.viewportAtScale1.height * CSS_PIXELS_PER_POINT;
  const widthFactor = (previewBody.clientWidth - padding) / pageWidthPx;

  if (preview.zoom === 'width') {
    return Math.max(0.05, (previewBody.clientWidth - padding - scrollbarSpace) / pageWidthPx);
  }

  const heightFactor = (previewBody.clientHeight - padding) / pageHeightPx;
  return Math.max(0.05, Math.min(widthFactor, heightFactor));
}

/** Sincronizează lista de zoom cu zoom-ul curent. */
function syncPreviewZoomSelect() {
  const zoomSelect = findElement('#pvZoomSel');
  const customOption = zoomSelect.querySelector('option[value="custom"]');

  if (typeof preview.zoom === 'string') {
    zoomSelect.value = preview.zoom;
    customOption.hidden = true;
    return;
  }

  let matchingOption = null;
  for (const option of zoomSelect.options) {
    if (option.value === 'custom') {
      continue;
    }
    if (Math.abs(Number(option.value) - preview.zoom) < 1e-3) {
      matchingOption = option;
      break;
    }
  }

  if (matchingOption) {
    zoomSelect.value = matchingOption.value;
    customOption.hidden = true;
  } else {
    // Zoom în afara listei (ex. cu rotița): se afișează într-o opțiune „personalizată”.
    customOption.hidden = false;
    customOption.textContent = `${Math.round(preview.zoom * 100)}%`;
    zoomSelect.value = 'custom';
  }
  zoomSelect.title = `Zoom: ${Math.round(getPreviewZoomFactor() * 100)}%`;
}

/** Aplică mărimea pe ecran a canvas-ului (instant; imaginea se re-randează puțin mai târziu). */
function layoutPreview() {
  if (!preview.viewportAtScale1) {
    return;
  }
  const cssScale = getPreviewZoomFactor() * CSS_PIXELS_PER_POINT;
  previewCanvas.style.width = `${Math.round(preview.viewportAtScale1.width * cssScale)}px`;
  previewCanvas.style.height = `${Math.round(preview.viewportAtScale1.height * cssScale)}px`;

  const overflowsHorizontally = previewBody.scrollWidth > previewBody.clientWidth + 1;
  const overflowsVertically = previewBody.scrollHeight > previewBody.clientHeight + 1;
  setClass(previewBody, 'pannable', overflowsHorizontally || overflowsVertically);

  syncPreviewZoomSelect();
}

async function renderPreview() {
  const page = state.pages[preview.pageIndex];
  if (!page) {
    previewDialog.close();
    return;
  }

  let pageLabel = '';
  if (page.label) {
    pageLabel = page.label;
  }
  const positionText = t('pv.label', { i: preview.pageIndex + 1, n: state.pages.length });
  findElement('#pvLabel').textContent = `${positionText}  ·  ${pageLabel}`;

  const pdfPage = await state.sources[page.sourceId].pdf.getPage(page.pageIndex + 1);
  preview.pdfPage = pdfPage;
  preview.rotation = Engine.normalizeAngle(pdfPage.rotate + page.rotation);
  preview.viewportAtScale1 = pdfPage.getViewport({ scale: 1, rotation: preview.rotation });

  layoutPreview();
  await drawPreview();
}

/** Randează pagina (+ straturile) la rezoluția zoom-ului curent. */
async function drawPreview() {
  preview.generation = preview.generation + 1;
  const generation = preview.generation;

  const pdfPage = preview.pdfPage;
  const viewportAtScale1 = preview.viewportAtScale1;
  const rotation = preview.rotation;
  if (!pdfPage) {
    return;
  }

  let devicePixelRatio = window.devicePixelRatio;
  if (!devicePixelRatio) {
    devicePixelRatio = 1;
  }
  const pixelRatio = Math.min(2, devicePixelRatio);

  // Pixeli de canvas per punct PDF, limitați ca suprafața totală să nu depășească MAX_CANVAS_PIXELS.
  let pixelsPerPoint = getPreviewZoomFactor() * CSS_PIXELS_PER_POINT * pixelRatio;
  const canvasArea = viewportAtScale1.width * viewportAtScale1.height * pixelsPerPoint * pixelsPerPoint;
  if (canvasArea > MAX_CANVAS_PIXELS) {
    pixelsPerPoint *= Math.sqrt(MAX_CANVAS_PIXELS / canvasArea);
  }

  // Randarea anterioară, dacă încă rulează, se anulează.
  try {
    if (preview.renderTask) {
      preview.renderTask.cancel();
    }
  } catch (error) {
    // ignorat: randarea se poate fi terminat deja
  }

  const viewport = pdfPage.getViewport({ scale: pixelsPerPoint, rotation: rotation });
  const offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = Math.ceil(viewport.width);
  offscreenCanvas.height = Math.ceil(viewport.height);
  const offscreenContext = offscreenCanvas.getContext('2d');
  offscreenContext.fillStyle = '#fff';
  offscreenContext.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

  preview.renderTask = pdfPage.render({ canvas: offscreenCanvas, canvasContext: offscreenContext, viewport: viewport });
  try {
    await preview.renderTask.promise;
  } catch (error) {
    return; // anulată de o randare mai nouă
  }

  const overlayList = getOverlaysForPage(preview.pageIndex);
  await drawOverlaysOnCanvas(offscreenContext, pixelsPerPoint, viewportAtScale1.width, viewportAtScale1.height, overlayList);

  if (generation !== preview.generation) {
    return; // între timp a pornit o randare mai nouă
  }

  // Imaginea completă se copiază dintr-o dată pe ecran (fără pâlpâire).
  previewCanvas.width = offscreenCanvas.width;
  previewCanvas.height = offscreenCanvas.height;
  previewCanvas.getContext('2d').drawImage(offscreenCanvas, 0, 0);
}

/**
 * Schimbă zoom-ul. newZoom = număr (1 = 100%) sau 'page' / 'width'.
 * anchor = { x, y } (coordonate pe ecran): punctul de sub cursor rămâne pe loc.
 * Fără anchor, rămâne pe loc centrul zonei vizibile.
 */
function setPreviewZoom(newZoom, anchor = null) {
  if (!preview.viewportAtScale1) {
    return;
  }

  const oldScale = getPreviewZoomFactor() * CSS_PIXELS_PER_POINT;
  const canvasRectBefore = previewCanvas.getBoundingClientRect();

  let anchorPoint = anchor;
  if (anchorPoint === null || anchorPoint === undefined) {
    const bodyRect = previewBody.getBoundingClientRect();
    anchorPoint = {
      x: bodyRect.left + previewBody.clientWidth / 2,
      y: bodyRect.top + previewBody.clientHeight / 2,
    };
  }

  // Punctul din pagină (în puncte PDF) aflat sub ancoră
  const pagePointX = (anchorPoint.x - canvasRectBefore.left) / oldScale;
  const pagePointY = (anchorPoint.y - canvasRectBefore.top) / oldScale;

  if (typeof newZoom === 'number') {
    preview.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
  } else {
    preview.zoom = newZoom;
  }
  layoutPreview();

  // Derularea se ajustează astfel încât același punct al paginii să fie din nou sub ancoră.
  const newScale = getPreviewZoomFactor() * CSS_PIXELS_PER_POINT;
  const canvasRectAfter = previewCanvas.getBoundingClientRect();
  previewBody.scrollLeft += canvasRectAfter.left + pagePointX * newScale - anchorPoint.x;
  previewBody.scrollTop += canvasRectAfter.top + pagePointY * newScale - anchorPoint.y;

  // Re-randarea la noua rezoluție se face după o mică pauză (zoom-ul poate continua).
  clearTimeout(preview.redrawTimer);
  preview.redrawTimer = setTimeout(drawPreview, 140);
}

/** Următorul / precedentul nivel de zoom din ZOOM_STEPS. direction: +1 sau -1. */
function stepPreviewZoom(direction, anchor) {
  const currentZoom = getPreviewZoomFactor();
  let nextZoom;

  if (direction > 0) {
    nextZoom = MAX_ZOOM;
    for (const step of ZOOM_STEPS) {
      if (step > currentZoom * 1.01) {
        nextZoom = step;
        break;
      }
    }
  } else {
    nextZoom = MIN_ZOOM;
    for (let stepIndex = ZOOM_STEPS.length - 1; stepIndex >= 0; stepIndex--) {
      if (ZOOM_STEPS[stepIndex] < currentZoom * 0.99) {
        nextZoom = ZOOM_STEPS[stepIndex];
        break;
      }
    }
  }

  setPreviewZoom(nextZoom, anchor);
}

/** Factorul de zoom pentru „toată pagina”, indiferent de zoom-ul curent. */
function getFitPageZoomFactor() {
  const savedZoom = preview.zoom;
  preview.zoom = 'page';
  const fitPageFactor = getPreviewZoomFactor();
  preview.zoom = savedZoom;
  return fitPageFactor;
}

function handleZoomSelectChange(event) {
  const selectedValue = event.target.value;
  if (selectedValue === 'custom') {
    return;
  }
  if (selectedValue === 'page' || selectedValue === 'width') {
    setPreviewZoom(selectedValue);
  } else {
    setPreviewZoom(Number(selectedValue));
  }
  event.target.blur();
}

/** Ctrl + rotița mouse-ului = zoom pe pagină (nu zoom-ul browserului). */
function handlePreviewWheel(event) {
  if (!(event.ctrlKey || event.metaKey)) {
    return;
  }
  event.preventDefault();

  const pointerIsOnPage = previewBody.contains(event.target);
  let anchor = null;
  if (pointerIsOnPage) {
    anchor = { x: event.clientX, y: event.clientY };
  }
  const newZoom = getPreviewZoomFactor() * Math.exp(-event.deltaY * 0.0018);
  setPreviewZoom(newZoom, anchor);
}

findElement('#pvZoomSel').addEventListener('change', handleZoomSelectChange);
previewDialog.addEventListener('wheel', handlePreviewWheel, { passive: false }); // passive: false permite preventDefault()

/** Tragere cu mouse-ul = deplasarea paginii mărite. */
function setupPreviewPanning() {
  let panStart = null; // { x, y, scrollLeft, scrollTop } la începutul tragerii

  function handlePointerDown(event) {
    if (event.button !== 0 || !previewBody.classList.contains('pannable')) {
      return;
    }
    panStart = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: previewBody.scrollLeft,
      scrollTop: previewBody.scrollTop,
    };
    previewBody.setPointerCapture(event.pointerId);
    previewBody.classList.add('panning');
  }

  function handlePointerMove(event) {
    if (!panStart) {
      return;
    }
    const deltaX = event.clientX - panStart.x;
    const deltaY = event.clientY - panStart.y;
    previewBody.scrollLeft = panStart.scrollLeft - deltaX;
    previewBody.scrollTop = panStart.scrollTop - deltaY;
  }

  function handlePointerEnd() {
    panStart = null;
    previewBody.classList.remove('panning');
  }

  previewBody.addEventListener('pointerdown', handlePointerDown);
  previewBody.addEventListener('pointermove', handlePointerMove);
  previewBody.addEventListener('pointerup', handlePointerEnd);
  previewBody.addEventListener('pointercancel', handlePointerEnd);
}

setupPreviewPanning();

/** Dublu-click pe pagină: comută între „toată pagina” și 200% în punctul respectiv. */
function handlePreviewDoubleClick(event) {
  const isZoomedIn = typeof preview.zoom === 'number' && preview.zoom > getFitPageZoomFactor() * 1.05;
  if (isZoomedIn) {
    setPreviewZoom('page');
  } else {
    setPreviewZoom(2, { x: event.clientX, y: event.clientY });
  }
}

/** La redimensionarea ferestrei, încadrările automate ('page' / 'width') se recalculează. */
function handleWindowResize() {
  if (!previewDialog.open || typeof preview.zoom === 'number') {
    return;
  }
  layoutPreview();
  clearTimeout(preview.redrawTimer);
  preview.redrawTimer = setTimeout(drawPreview, 200);
}

/** Butoanele din bara previzualizării. */
function handlePreviewToolbarClick(event) {
  const button = event.target.closest('[data-pv]');
  if (!button) {
    return;
  }
  const action = button.dataset.pv;

  if (action === 'close') {
    previewDialog.close();
  } else if (action === 'prev') {
    openPreview(Math.max(0, preview.pageIndex - 1));
  } else if (action === 'next') {
    openPreview(Math.min(state.pages.length - 1, preview.pageIndex + 1));
  } else if (action === 'zoomIn') {
    stepPreviewZoom(1);
  } else if (action === 'zoomOut') {
    stepPreviewZoom(-1);
  } else if (action === 'fitPage') {
    setPreviewZoom('page');
  } else if (action === 'fitWidth') {
    setPreviewZoom('width');
  } else if (action === 'rotL' || action === 'rotR') {
    let angle = 90;
    if (action === 'rotL') {
      angle = -90;
    }
    rotatePages([preview.pageIndex], angle);
    renderPreview();
  } else if (action === 'del') {
    removePages([preview.pageIndex]);
    if (state.pages.length === 0) {
      previewDialog.close();
    } else {
      openPreview(Math.min(preview.pageIndex, state.pages.length - 1));
    }
  }
}

/** Tastatura în previzualizare: zoom (+ − 0 W) și navigare între pagini. */
function handlePreviewKeyDown(event) {
  if (event.target.closest('select, input')) {
    return; // tastele din lista de zoom nu se interceptează
  }
  const modifierPressed = event.ctrlKey || event.metaKey;
  const key = event.key;

  if (key === '+' || key === '=' || (modifierPressed && key === 'Add')) {
    event.preventDefault();
    stepPreviewZoom(1);
    return;
  }
  if (key === '-' || key === '_' || (modifierPressed && key === 'Subtract')) {
    event.preventDefault();
    stepPreviewZoom(-1);
    return;
  }
  if (key === '0') {
    event.preventDefault();
    setPreviewZoom('page');
    return;
  }
  if (!modifierPressed && (key === 'w' || key === 'W')) {
    event.preventDefault();
    setPreviewZoom('width');
    return;
  }
  if (modifierPressed) {
    return;
  }

  // Săgețile stânga / dreapta schimbă pagina doar dacă nu e nevoie de ele pentru derulare orizontală.
  const canScrollHorizontally = previewBody.scrollWidth > previewBody.clientWidth + 1;
  if (key === 'PageUp' || (key === 'ArrowLeft' && !canScrollHorizontally)) {
    event.preventDefault();
    openPreview(Math.max(0, preview.pageIndex - 1));
  }
  if (key === 'PageDown' || (key === 'ArrowRight' && !canScrollHorizontally)) {
    event.preventDefault();
    openPreview(Math.min(state.pages.length - 1, preview.pageIndex + 1));
  }
  if (key === 'Home' && event.altKey) {
    openPreview(0);
  }
}

previewCanvas.addEventListener('dblclick', handlePreviewDoubleClick);
window.addEventListener('resize', handleWindowResize);
previewDialog.addEventListener('click', handlePreviewToolbarClick);
previewDialog.addEventListener('keydown', handlePreviewKeyDown);

// =====================================================================
//  8. Comenzi (bara de sus și ribbon), temă, limbă, tastatură, pornire
// =====================================================================

// Câmpul ascuns de alegere a fișierelor, folosit de „Deschide” și „Adaugă fișiere”.
const fileInput = findElement('#fileOpen');
let fileInputMode = 'append'; // 'replace' = „Deschide”, 'append' = „Adaugă fișiere”

function handleFileInputChange() {
  const chosenFiles = Array.from(fileInput.files);
  fileInput.value = ''; // permite alegerea aceluiași fișier încă o dată
  if (chosenFiles.length > 0) {
    loadFiles(chosenFiles, { replace: fileInputMode === 'replace' });
  }
}

fileInput.addEventListener('change', handleFileInputChange);

// ---------------------------------------------------------------------
//  Temă (luminoasă / întunecată / automată) și limbă
// ---------------------------------------------------------------------
let darkModeQuery = null;
if (typeof window.matchMedia === 'function') {
  darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
}

/** Aplică tema după preferința salvată în <html data-theme-pref>: 'light' | 'dark' | 'auto'. */
function applyTheme() {
  const root = document.documentElement;

  let themePreference = root.dataset.themePref;
  if (!themePreference) {
    themePreference = 'auto';
  }

  let useDarkTheme = false;
  if (themePreference === 'dark') {
    useDarkTheme = true;
  } else if (themePreference === 'auto' && darkModeQuery && darkModeQuery.matches) {
    useDarkTheme = true;
  }

  // Iconița arată tema în care se trece la click: lună = spre întunecat, soare = spre luminos.
  const themeButton = findElement('#themeBtn');
  if (useDarkTheme) {
    root.dataset.theme = 'dark';
    themeButton.querySelector('use').setAttribute('href', '#i-sun');
    themeButton.title = t('theme.toLight');
  } else {
    root.dataset.theme = 'light';
    themeButton.querySelector('use').setAttribute('href', '#i-moon');
    themeButton.title = t('theme.toDark');
  }
}

/** Salvează preferința de temă în browser (localStorage) și o aplică. */
function setTheme(themePreference) {
  document.documentElement.dataset.themePref = themePreference;
  try {
    localStorage.setItem(`${APP_CONFIG.id}.theme`, themePreference);
  } catch (error) {
    // ignorat: localStorage poate fi indisponibil (setări de confidențialitate)
  }
  applyTheme();
}

if (darkModeQuery && typeof darkModeQuery.addEventListener === 'function') {
  darkModeQuery.addEventListener('change', applyTheme); // tema sistemului s-a schimbat
}
applyTheme();

/**
 * Schimbă limba: setează un cookie (citit de index.php) și reîncarcă pagina.
 * Documentul deschis se pierde, deci se cere confirmarea.
 */
function setLanguage(languageCode) {
  if (languageCode === LANG) {
    return;
  }
  if (state.pages.length > 0 && !confirm(t('lang.reloadConfirm'))) {
    return;
  }

  const appPath = new URL('.', location.href).pathname;
  const oneYearInSeconds = 31536000;
  document.cookie = `${APP_CONFIG.id}_lang=${languageCode}; path=${appPath}; max-age=${oneYearInSeconds}; SameSite=Lax`;

  state.hasUnsavedChanges = false; // fără întrebarea „Părăsești pagina?”
  location.reload();
}

// ---------------------------------------------------------------------
//  Comenzile (atributul data-cmd al butoanelor)
// ---------------------------------------------------------------------

// Comenzile care au sens doar când este deschis un document.
const COMMANDS_REQUIRING_DOCUMENT = new Set([
  'save', 'close', 'selMenu', 'selAll', 'selNone', 'selOdd', 'selEven', 'selInvert', 'selRange',
  'rotL', 'rotR', 'rot180', 'delete', 'insert', 'extract', 'reverse', 'interleave', 'split',
  'crop', 'fit', 'ovNum', 'ovText', 'ovWm', 'ovImg',
]);

function commandOpen() {
  if (state.pages.length > 0 && state.hasUnsavedChanges && !confirm(t('confirm.open'))) {
    return;
  }
  fileInputMode = 'replace';
  fileInput.click();
}

function commandAppend() {
  fileInputMode = 'append';
  fileInput.click();
}

function commandClose() {
  if (state.hasUnsavedChanges && !confirm(t('confirm.close'))) {
    return;
  }
  resetDocument();
}

function selectAllPages() {
  const uids = [];
  for (const page of state.pages) {
    uids.push(page.uid);
  }
  setSelection(uids);
}

function selectNoPages() {
  setSelection([]);
}

/** Paginile impare: 1, 3, 5… (indicii 0, 2, 4…). */
function selectOddPages() {
  const uids = [];
  for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
    if (pageIndex % 2 === 0) {
      uids.push(state.pages[pageIndex].uid);
    }
  }
  setSelection(uids);
}

/** Paginile pare: 2, 4, 6… (indicii 1, 3, 5…). */
function selectEvenPages() {
  const uids = [];
  for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
    if (pageIndex % 2 === 1) {
      uids.push(state.pages[pageIndex].uid);
    }
  }
  setSelection(uids);
}

function invertSelection() {
  const uids = [];
  for (const page of state.pages) {
    if (!state.selectedUids.has(page.uid)) {
      uids.push(page.uid);
    }
  }
  setSelection(uids);
}

function openSelectionMenu(button) {
  const menuItems = [
    { label: t('sel.all'), action: selectAllPages },
    { label: t('sel.none'), action: selectNoPages },
    MENU_SEPARATOR,
    { label: t('sel.odd'), action: selectOddPages },
    { label: t('sel.even'), action: selectEvenPages },
    { label: t('sel.invert'), action: invertSelection },
    MENU_SEPARATOR,
    { label: t('sel.range'), action: openSelectRangeDialog },
  ];
  showMenu(button, menuItems, 'left');
}

/** „Numerotare”: de obicei există una singură, așa că dacă există deja, se editează. */
function commandPageNumbers() {
  const numberingOverlays = [];
  for (const overlay of state.overlays) {
    if (overlay.type === 'num') {
      numberingOverlays.push(overlay);
    }
  }
  if (numberingOverlays.length === 1) {
    openOverlayDialog('num', numberingOverlays[0]);
  } else {
    openOverlayDialog('num', null);
  }
}

function toggleLayersPanel() {
  state.isLayersPanelOpen = !state.isLayersPanelOpen;
  renderChrome();
}

/** Comutator de temă: luminoasă <-> întunecată (pornind de la tema afișată acum). */
function toggleTheme() {
  if (document.documentElement.dataset.theme === 'dark') {
    setTheme('light');
  } else {
    setTheme('dark');
  }
}

/** Comutator de limbă: trece la limba următoare din listă (RO <-> EN). */
function toggleLanguage() {
  let currentIndex = -1;
  for (let languageIndex = 0; languageIndex < LANGUAGES.length; languageIndex++) {
    if (LANGUAGES[languageIndex].code === LANG) {
      currentIndex = languageIndex;
      break;
    }
  }
  const nextIndex = (currentIndex + 1) % LANGUAGES.length;
  setLanguage(LANGUAGES[nextIndex].code);
}

/** Execută comanda cu numele dat (valoarea atributului data-cmd). Numele necunoscute sunt ignorate. */
function runCommand(commandName, button) {
  switch (commandName) {
    case 'open': commandOpen(); break;
    case 'append': commandAppend(); break;
    case 'save': saveDocument(); break;
    case 'close': commandClose(); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'selAll': selectAllPages(); break;
    case 'selNone': selectNoPages(); break;
    case 'selOdd': selectOddPages(); break;
    case 'selEven': selectEvenPages(); break;
    case 'selInvert': invertSelection(); break;
    case 'selRange': openSelectRangeDialog(); break;
    case 'selMenu': openSelectionMenu(button); break;
    case 'rotL': rotatePages(requireSelection(), -90); break;
    case 'rotR': rotatePages(requireSelection(), 90); break;
    case 'rot180': rotatePages(requireSelection(), 180); break;
    case 'delete': openDeleteDialog(); break;
    case 'insert': openInsertDialog(); break;
    case 'extract': openExtractDialog(); break;
    case 'reverse': reversePageOrder(); break;
    case 'interleave': openInterleaveDialog(); break;
    case 'split': openSplitDialog(); break;
    case 'crop': openCropDialog('crop'); break;
    case 'fit': openCropDialog('fit'); break;
    case 'ovNum': commandPageNumbers(); break;
    case 'ovText': openOverlayDialog('text'); break;
    case 'ovWm': openOverlayDialog('wm'); break;
    case 'ovImg': openOverlayDialog('img'); break;
    case 'layers': toggleLayersPanel(); break;
    case 'about': findElement('#dlgAbout').showModal(); break;
    case 'themeToggle': toggleTheme(); break;
    case 'langToggle': toggleLanguage(); break;
    default: break; // comandă necunoscută: nimic
  }
}

/** Orice click pe un element cu atributul data-cmd rulează comanda respectivă. */
function handleCommandClick(event) {
  const button = event.target.closest('[data-cmd]');
  if (!button || button.disabled) {
    return;
  }
  const commandName = button.dataset.cmd;

  if (COMMANDS_REQUIRING_DOCUMENT.has(commandName) && state.pages.length === 0) {
    showToast(t('msg.openFirst'), 'warn');
    return;
  }
  runCommand(commandName, button);
}

document.addEventListener('click', handleCommandClick);

// ---------------------------------------------------------------------
//  Manualul de utilizare (butonul „?” din bara de sus și tasta F1)
// ---------------------------------------------------------------------

/**
 * Deschide manualul într-o filă nouă; aplicația (și documentul deschis) rămân în fila curentă.
 * Adresa vine de la server (index.php), doar dacă fișierul manualului există.
 * 'noopener': pagina manualului nu primește acces la fila aplicației.
 */
function openUserManual() {
  if (!APP_CONFIG.manualUrl) {
    return; // manualul nu este instalat
  }
  const manualUrl = new URL(APP_CONFIG.manualUrl, BASE_URL).href;
  window.open(manualUrl, '_blank', 'noopener');
}

// ---------------------------------------------------------------------
//  Scurtături de tastatură
// ---------------------------------------------------------------------
function handleGlobalKeyDown(event) {
  // F1 deschide manualul oriunde în aplicație (și peste dialoguri), în locul ajutorului browserului.
  if (event.key === 'F1') {
    event.preventDefault();
    openUserManual();
    return;
  }

  if (document.querySelector('dialog[open]')) {
    return; // celelalte taste: dialogurile au propriile scurtături
  }

  let isInTextField = false;
  if (typeof event.target.closest === 'function') {
    isInTextField = Boolean(event.target.closest('input, textarea, select, [contenteditable="true"]'));
  }
  const modifierPressed = event.ctrlKey || event.metaKey;
  let key = '';
  if (typeof event.key === 'string') {
    key = event.key.toLowerCase(); // unele evenimente sintetice (ex. completarea automată) nu au tastă
  }

  // Ctrl+S funcționează și din câmpurile de text.
  if (modifierPressed && key === 's') {
    event.preventDefault();
    if (state.pages.length > 0) {
      saveDocument();
    }
    return;
  }
  if (isInTextField) {
    return;
  }

  if (modifierPressed && key === 'z' && !event.shiftKey) {
    event.preventDefault();
    undo();
  } else if (modifierPressed && (key === 'y' || (key === 'z' && event.shiftKey))) {
    event.preventDefault();
    redo();
  } else if (modifierPressed && key === 'a') {
    event.preventDefault();
    selectAllPages();
  } else if (event.key === 'Escape') {
    closeMenu();
    setSelection([]);
  } else if (event.key === 'Delete' && state.selectedUids.size > 0) {
    removePages(getSelectedPageIndexes());
  }
}

document.addEventListener('keydown', handleGlobalKeyDown);

// ---------------------------------------------------------------------
//  Numele documentului (editabil în bara de sus)
// ---------------------------------------------------------------------
function handleDocumentNameKeyDown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.target.blur(); // Enter confirmă numele
  }
}

function handleDocumentNameBlur(event) {
  setDocumentName(event.target.textContent);
  if (state.overlays.length > 0) {
    render(); // straturile pot conține {file}
  }
}

findElement('#docName').addEventListener('keydown', handleDocumentNameKeyDown);
findElement('#docName').addEventListener('blur', handleDocumentNameBlur);

// ---------------------------------------------------------------------
//  Mărimea miniaturilor (glisorul din bara de stare)
// ---------------------------------------------------------------------
const thumbnailSizeSlider = findElement('#zoom');

function applyThumbnailSize(sizePx) {
  state.thumbnailSize = sizePx;
  document.documentElement.style.setProperty('--thumb', `${sizePx}px`);

  // Rezoluția de randare crește în trepte de 100 px (nu scade, ca să nu se randeze din nou inutil).
  const neededResolution = Math.ceil(sizePx / 100) * 100;
  if (neededResolution > state.thumbnailResolution) {
    state.thumbnailResolution = neededResolution;
    render();
  }
}

function handleThumbnailSliderInput() {
  applyThumbnailSize(Number(thumbnailSizeSlider.value));
  try {
    localStorage.setItem(`${APP_CONFIG.id}.zoom`, thumbnailSizeSlider.value);
  } catch (error) {
    // ignorat: localStorage indisponibil
  }
}

// Mărimea salvată anterior în browser (dacă există).
try {
  const savedThumbnailSize = Number(localStorage.getItem(`${APP_CONFIG.id}.zoom`));
  if (savedThumbnailSize) {
    thumbnailSizeSlider.value = savedThumbnailSize;
  }
} catch (error) {
  // ignorat: localStorage indisponibil
}
applyThumbnailSize(Number(thumbnailSizeSlider.value));
thumbnailSizeSlider.addEventListener('input', handleThumbnailSliderInput);

// ---------------------------------------------------------------------
//  Avertizare la închiderea paginii cu modificări nesalvate
// ---------------------------------------------------------------------
function handleBeforeUnload(event) {
  if (state.hasUnsavedChanges && state.pages.length > 0) {
    event.preventDefault();
    event.returnValue = ''; // necesar în unele browsere pentru a afișa întrebarea
  }
}

window.addEventListener('beforeunload', handleBeforeUnload);

// ---------------------------------------------------------------------
//  Pornire
// ---------------------------------------------------------------------

/** Încarcă fonturile; o eroare este afișată, dar nu oprește aplicația. */
async function loadFontsAtStartup() {
  try {
    await initFonts();
  } catch (error) {
    console.error(error);
    showToast(t('err.fonts', { msg: error.message }), 'error', 10000);
  }
}

fontsReadyPromise = loadFontsAtStartup();
render();

// Acces pentru depanare din consola browserului (ex. PageFix.S.pages).
window.PageFix = { S: state, E: Engine, CFG: APP_CONFIG, loadFiles: loadFiles, render: render };
