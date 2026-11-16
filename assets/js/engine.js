// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Marius SEUL – https://code-by-seul.ro/
// =====================================================================
//  PageFix – motorul de manipulare PDF (bazat pe librăria pdf-lib)
//
//  Toate operațiile rulează local, în browser; nimic nu este trimis în rețea,
//  cu o singură excepție: loadFonts() descarcă fișierele de font ale aplicației
//  de pe serverul propriu (lib/pdfjs/standard_fonts/).
//
//  Unități: coordonatele PDF sunt în puncte (1 pt = 1/72 inch); originea este
//  în colțul stânga-jos, iar axa Y crește în sus.
// =====================================================================
import { TTF, embedTTF } from './ttf.js';
import { t } from './i18n.js';

const PDFLib = window.PDFLib;
const PDFDocument = PDFLib.PDFDocument;
const degrees = PDFLib.degrees;
const rgb = PDFLib.rgb;
const pushGraphicsState = PDFLib.pushGraphicsState;
const popGraphicsState = PDFLib.popGraphicsState;
const concatTransformationMatrix = PDFLib.concatTransformationMatrix;

/** 1 mm exprimat în puncte PDF. */
export const MM = 72 / 25.4;

/** Formatele de hârtie, în orientare portret: [lățime, înălțime] în puncte. */
export const FORMATS = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
};

/** Aduce un unghi (în grade) în intervalul 0…359, rotunjit la grad întreg. Ex.: -90 -> 270, 450 -> 90. */
export function normalizeAngle(angleDegrees) {
  const roundedAngle = Math.round(angleDegrees);
  return ((roundedAngle % 360) + 360) % 360;
}

// =====================================================================
//  Intervale de pagini: "2, 5-8, 12, 20-"  ->  indici numărați de la 0
// =====================================================================

/**
 * Transformă un text de forma "2, 5-8, 12, 20-" într-o listă de indici de pagină (de la 0),
 * fără duplicate, în ordinea în care apar.
 *
 * - "5-8"  = paginile 5, 6, 7, 8;   "8-5" = aceleași, în ordine inversă;
 * - "20-"  = de la 20 până la final; "-3" = de la 1 până la 3;
 * - separatori acceptați: virgulă și spațiu.
 *
 * Aruncă o eroare (cu mesaj pentru utilizator) dacă textul este invalid sau se referă la
 * pagini inexistente. Dacă textul e gol: cu allowEmpty = true întoarce toate paginile,
 * altfel aruncă o eroare.
 *
 * @param {string} rangeText     textul introdus de utilizator
 * @param {number} totalPages    numărul de pagini al documentului
 */
export function parseRanges(rangeText, totalPages, options = {}) {
  let allowEmpty = false;
  if (options.allowEmpty !== undefined) {
    allowEmpty = options.allowEmpty;
  }

  let inputText = '';
  if (rangeText !== null && rangeText !== undefined) {
    inputText = String(rangeText);
  }
  inputText = inputText.trim();

  if (inputText === '') {
    if (allowEmpty) {
      const allPages = [];
      for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
        allPages.push(pageIndex);
      }
      return allPages;
    }
    throw new Error(t('err.noPagesGiven'));
  }

  const pageIndexes = [];
  const alreadyAdded = new Set();
  const parts = inputText.split(/[,\s]+/);

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part === '') {
      continue;
    }

    // Validarea formatului: fie "a-b" (oricare capăt poate lipsi), fie un singur număr.
    let firstPage;
    let lastPage;
    const rangeMatch = part.match(/^(\d*)\s*[-–]\s*(\d*)$/);
    const isSingleNumber = /^\d+$/.test(part);

    if (rangeMatch) {
      if (rangeMatch[1]) {
        firstPage = parseInt(rangeMatch[1], 10);
      } else {
        firstPage = 1;
      }
      if (rangeMatch[2]) {
        lastPage = parseInt(rangeMatch[2], 10);
      } else {
        lastPage = totalPages;
      }
    } else if (isSingleNumber) {
      firstPage = parseInt(part, 10);
      lastPage = firstPage;
    } else {
      throw new Error(t('err.badRange', { part: part }));
    }

    // Validarea limitelor: ambele capete trebuie să fie pagini existente.
    const firstIsInvalid = firstPage < 1 || firstPage > totalPages;
    const lastIsInvalid = lastPage < 1 || lastPage > totalPages;
    if (firstIsInvalid || lastIsInvalid) {
      let invalidPage = lastPage;
      if (firstIsInvalid) {
        invalidPage = firstPage;
      }
      throw new Error(t('err.noSuchPage', { p: invalidPage, n: totalPages }));
    }

    // Adăugarea paginilor din interval, în direcția dată (crescător sau descrescător).
    if (firstPage <= lastPage) {
      for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber++) {
        if (!alreadyAdded.has(pageNumber)) {
          alreadyAdded.add(pageNumber);
          pageIndexes.push(pageNumber - 1);
        }
      }
    } else {
      for (let pageNumber = firstPage; pageNumber >= lastPage; pageNumber--) {
        if (!alreadyAdded.has(pageNumber)) {
          alreadyAdded.add(pageNumber);
          pageIndexes.push(pageNumber - 1);
        }
      }
    }
  }

  if (pageIndexes.length === 0) {
    throw new Error(t('err.noPagesGiven'));
  }
  return pageIndexes;
}

/**
 * Grupuri de intervale separate prin ";" -> o listă de liste de indici.
 * Ex.: "1-3; 4-10; 11-" -> [[0,1,2], [3,…,9], [10,…]]
 */
export function parseRangeGroups(groupsText, totalPages) {
  let inputText = '';
  if (groupsText !== null && groupsText !== undefined) {
    inputText = String(groupsText);
  }

  const groupTexts = [];
  for (const rawGroup of inputText.split(';')) {
    const groupText = rawGroup.trim();
    if (groupText !== '') {
      groupTexts.push(groupText);
    }
  }

  if (groupTexts.length === 0) {
    throw new Error(t('err.noRanges'));
  }

  const groups = [];
  for (const groupText of groupTexts) {
    groups.push(parseRanges(groupText, totalPages));
  }
  return groups;
}

// =====================================================================
//  Surse (fiecare fișier PDF încărcat sau document intermediar generat)
// =====================================================================

/**
 * Documentul pdf-lib al unei surse. Se încarcă o singură dată; promisiunea
 * rezultată este păstrată în source.libPromise și refolosită.
 */
export function getLibDoc(source) {
  if (!source.libPromise) {
    source.libPromise = PDFDocument.load(source.bytes, { ignoreEncryption: true, updateMetadata: false });
  }
  return source.libPromise;
}

/** Completează metadatele (Producer, Creator, data modificării) și întoarce octeții PDF-ului. */
export async function saveDoc(doc) {
  let appConfig = globalThis.APP_CONFIG;
  if (!appConfig) {
    appConfig = {};
  }

  let appName = 'PageFix';
  if (appConfig.name) {
    appName = appConfig.name;
  }
  let appVersion = '';
  if (appConfig.version) {
    appVersion = appConfig.version;
  }

  // Dacă versiunea lipsește, rămân două spații consecutive – se reduc la unul.
  const producerText = `${appName} ${appVersion} (pdf-lib)`.replace('  ', ' ');

  doc.setProducer(producerText);
  doc.setCreator(appName);
  doc.setModificationDate(new Date());

  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

/**
 * Construiește un document pdf-lib nou din lista de pagini `pageRefs`
 * (fiecare: { sourceId, pageIndex, rotation }).
 *
 * Paginile din aceeași sursă sunt copiate într-un singur apel, astfel încât resursele
 * comune (fonturi, imagini) se copiază o singură dată și fișierul rezultat nu crește
 * inutil (ex. la intercalări).
 */
export async function buildDoc(pageRefs, sources) {
  const newDoc = await PDFDocument.create();
  const copiedPages = new Array(pageRefs.length);

  // --- 1. Gruparea pozițiilor după sursă (în ordinea primei apariții) ---
  const positionsBySource = new Map();
  for (let position = 0; position < pageRefs.length; position++) {
    const sourceId = pageRefs[position].sourceId;
    if (!positionsBySource.has(sourceId)) {
      positionsBySource.set(sourceId, []);
    }
    positionsBySource.get(sourceId).push(position);
  }

  // --- 2. Copierea paginilor, sursă cu sursă ---
  for (const [sourceId, positions] of positionsBySource) {
    const sourceDoc = await getLibDoc(sources[sourceId]);

    // O pagină folosită de mai multe ori are nevoie de copii distincte, așa că se copiază
    // în „runde”: într-o rundă, fiecare pagină a sursei apare cel mult o dată.
    let pendingPositions = positions;
    while (pendingPositions.length > 0) {
      const pagesInRound = new Set();
      const roundPositions = [];
      const nextRoundPositions = [];

      for (const position of pendingPositions) {
        const pageIndex = pageRefs[position].pageIndex;
        if (pagesInRound.has(pageIndex)) {
          nextRoundPositions.push(position);
        } else {
          pagesInRound.add(pageIndex);
          roundPositions.push(position);
        }
      }

      const roundPageIndexes = [];
      for (const position of roundPositions) {
        roundPageIndexes.push(pageRefs[position].pageIndex);
      }

      const pagesCopiedInRound = await newDoc.copyPages(sourceDoc, roundPageIndexes);
      for (let roundIndex = 0; roundIndex < roundPositions.length; roundIndex++) {
        copiedPages[roundPositions[roundIndex]] = pagesCopiedInRound[roundIndex];
      }

      pendingPositions = nextRoundPositions;
    }
  }

  // --- 3. Adăugarea paginilor în ordinea cerută, cu rotația suplimentară ---
  for (let position = 0; position < copiedPages.length; position++) {
    const page = copiedPages[position];
    let extraRotation = pageRefs[position].rotation;
    if (!extraRotation) {
      extraRotation = 0;
    }
    const newAngle = normalizeAngle(page.getRotation().angle + extraRotation);
    page.setRotation(degrees(newAngle));
    newDoc.addPage(page);
  }

  return newDoc;
}

/**
 * „Coace” o modificare: copiază paginile într-un document nou, aplică operația pe fiecare
 * pagină și întoarce octeții noului PDF (care devine o sursă nouă în aplicație).
 *
 * pageOperation(doc, page, pageIndex, context) poate și înlocui pagina (ex. flatten()).
 */
export async function bake(pageRefs, sources, pageOperation) {
  const doc = await buildDoc(pageRefs, sources);
  const context = { doc: doc, fonts: {}, imgCache: new Map() };
  const pageCount = doc.getPageCount();

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const page = doc.getPage(pageIndex);
    await pageOperation(doc, page, pageIndex, context);
  }

  return saveDoc(doc);
}

// =====================================================================
//  Geometrie
// =====================================================================

/** CropBox-ul paginii (zona vizibilă), ca {x, y, w, h}. */
function cropBoxOf(page) {
  const cropBox = page.getCropBox();
  return { x: cropBox.x, y: cropBox.y, w: cropBox.width, h: cropBox.height };
}

/** Dimensiunile vizibile [lățime, înălțime] ale unei pagini pdf-lib, după CropBox și rotație. */
export function visualSize(page) {
  const box = cropBoxOf(page);
  const rotation = normalizeAngle(page.getRotation().angle);
  const isSideways = (rotation % 180) !== 0; // 90° sau 270°
  if (isSideways) {
    return [box.h, box.w];
  }
  return [box.w, box.h];
}

/**
 * Aplatizează pagina `pageIndex`: zona vizibilă (CropBox + rotație) devine o pagină nouă,
 * cu rotația 0, care o înlocuiește pe cea veche.
 *
 * target = { W, H, margin, noUpscale } -> conținutul e scalat și centrat pe o pagină W×H
 * (toate în puncte). Fără target, pagina nouă are exact mărimea zonei vizibile.
 *
 * Atenție: adnotările (linkuri, câmpuri de formular) nu se păstrează.
 */
export async function flatten(doc, pageIndex, target = null) {
  const page = doc.getPage(pageIndex);
  const rotation = normalizeAngle(page.getRotation().angle);
  const box = cropBoxOf(page);

  const embeddedPage = await doc.embedPage(page, {
    left: box.x,
    bottom: box.y,
    right: box.x + box.w,
    top: box.y + box.h,
  });

  const contentWidth = box.w;
  const contentHeight = box.h;

  // Dimensiunile vizibile (după rotație)
  const isSideways = (rotation % 180) !== 0;
  let visibleWidth = contentWidth;
  let visibleHeight = contentHeight;
  if (isSideways) {
    visibleWidth = contentHeight;
    visibleHeight = contentWidth;
  }

  // Mărimea paginii noi și factorul de scalare
  let newPageWidth = visibleWidth;
  let newPageHeight = visibleHeight;
  let scale = 1;
  if (target) {
    newPageWidth = target.W;
    newPageHeight = target.H;
    let margin = target.margin;
    if (!margin) {
      margin = 0;
    }
    scale = Math.min((newPageWidth - 2 * margin) / visibleWidth, (newPageHeight - 2 * margin) / visibleHeight);
    if (target.noUpscale) {
      scale = Math.min(scale, 1);
    }
    const scaleIsValid = scale > 0; // false și pentru NaN
    if (!scaleIsValid) {
      throw new Error(t('err.marginTooBig'));
    }
  }

  // Colțul stânga-jos al zonei în care se desenează conținutul (centrat)
  const boxX = (newPageWidth - visibleWidth * scale) / 2;
  const boxY = (newPageHeight - visibleHeight * scale) / 2;
  const scaledWidth = contentWidth * scale;
  const scaledHeight = contentHeight * scale;

  // Rotația PDF (/Rotate) este în sensul acelor de ceasornic, iar pdf-lib rotește
  // trigonometric (invers), în jurul punctului de desenare – de aici deplasările de mai jos.
  let drawX = boxX;
  let drawY = boxY;
  if (rotation === 90) {
    drawX = boxX;
    drawY = boxY + scaledWidth;
  } else if (rotation === 180) {
    drawX = boxX + scaledWidth;
    drawY = boxY + scaledHeight;
  } else if (rotation === 270) {
    drawX = boxX + scaledHeight;
    drawY = boxY;
  }

  const newPage = doc.insertPage(pageIndex, [newPageWidth, newPageHeight]);
  newPage.drawPage(embeddedPage, {
    x: drawX,
    y: drawY,
    xScale: scale,
    yScale: scale,
    rotate: degrees(-rotation),
  });
  doc.removePage(pageIndex + 1); // pagina veche a ajuns după cea nouă

  return newPage;
}

// =====================================================================
//  Operații de conținut (se folosesc împreună cu bake())
// =====================================================================

// Pentru fiecare rotație: ce muchie a CropBox-ului (în spațiul PDF) corespunde fiecărei
// laturi vizuale (sus / dreapta / jos / stânga). x0/y0 = muchiile minime, x1/y1 = maxime.
const VISUAL_SIDE_TO_PDF_EDGE = {
  0: { t: 'y1', r: 'x1', b: 'y0', l: 'x0' },
  90: { t: 'x0', r: 'y1', b: 'x1', l: 'y0' },
  180: { t: 'y0', r: 'x0', b: 'y1', l: 'x1' },
  270: { t: 'x1', r: 'y0', b: 'x0', l: 'y1' },
};

/**
 * Decupare nedistructivă (se modifică doar CropBox-ul).
 * marginsMm = { t, r, b, l }: marginile vizuale de eliminat, în mm.
 */
export function cropOp(marginsMm) {
  return async function cropPage(doc, page, pageIndex) {
    const rotation = normalizeAngle(page.getRotation().angle);
    const box = cropBoxOf(page);
    const edges = {
      x0: box.x,
      y0: box.y,
      x1: box.x + box.w,
      y1: box.y + box.h,
    };

    for (const visualSide of ['t', 'r', 'b', 'l']) {
      const edgeName = VISUAL_SIDE_TO_PDF_EDGE[rotation][visualSide];

      let marginMm = Number(marginsMm[visualSide]);
      if (!marginMm) {
        marginMm = 0; // și pentru NaN
      }
      const marginPt = marginMm * MM;

      // Muchiile minime (x0, y0) se mută spre interior crescând, cele maxime scăzând.
      if (edgeName.endsWith('0')) {
        edges[edgeName] += marginPt;
      } else {
        edges[edgeName] -= marginPt;
      }
    }

    const remainingWidth = edges.x1 - edges.x0;
    const remainingHeight = edges.y1 - edges.y0;
    if (remainingWidth < 10 || remainingHeight < 10) {
      throw new Error(t('err.marginsPage', { n: pageIndex + 1 }));
    }

    page.setCropBox(edges.x0, edges.y0, remainingWidth, remainingHeight);
  };
}

/** Anulează decupările: CropBox-ul devine din nou egal cu MediaBox-ul (pagina întreagă). */
export function resetCropOp() {
  return async function resetPageCrop(doc, page) {
    const mediaBox = page.getMediaBox();
    page.setCropBox(mediaBox.x, mediaBox.y, mediaBox.width, mediaBox.height);
    // TrimBox / BleedBox / ArtBox rămase din decupări anterioare nu afectează afișarea.
  };
}

/**
 * Încadrare într-un format (A4 etc.): conținutul vizibil e scalat și centrat pe pagina nouă.
 * options = { format: 'A4', orient: 'auto' | 'P' | 'L', margin: mm, noUpscale: bool }
 */
export function fitOp(options) {
  let format = options.format;
  if (format === undefined) {
    format = 'A4';
  }
  let orientation = options.orient;
  if (orientation === undefined) {
    orientation = 'auto';
  }
  let marginMm = options.margin;
  if (marginMm === undefined) {
    marginMm = 0;
  }
  let noUpscale = options.noUpscale;
  if (noUpscale === undefined) {
    noUpscale = false;
  }

  let formatSize = FORMATS[format];
  if (!formatSize) {
    formatSize = FORMATS.A4;
  }
  const portraitWidth = formatSize[0];
  const portraitHeight = formatSize[1];

  return async function fitPageToFormat(doc, page, pageIndex) {
    const visible = visualSize(page);
    const visibleWidth = visible[0];
    const visibleHeight = visible[1];

    let useLandscape = false;
    if (orientation === 'L') {
      useLandscape = true;
    } else if (orientation === 'auto' && visibleWidth > visibleHeight) {
      useLandscape = true;
    }

    let targetWidth = portraitWidth;
    let targetHeight = portraitHeight;
    if (useLandscape) {
      targetWidth = portraitHeight;
      targetHeight = portraitWidth;
    }

    await flatten(doc, pageIndex, {
      W: targetWidth,
      H: targetHeight,
      margin: marginMm * MM,
      noUpscale: noUpscale,
    });
  };
}

// =====================================================================
//  Suprapuneri (numere de pagină, antet/subsol, watermark, imagine)
// =====================================================================
// Textul folosește fontul Liberation Sans încorporat (subset), deci diacriticele
// românești sunt text vectorial real. Aceeași funcție de așezare (layoutOverlay) este
// folosită și la previzualizarea pe canvas, astfel încât miniaturile arată exact ca PDF-ul final.

// Fonturile citite: r = normal (regular), b = îngroșat (bold).
const FONTS = { r: null, b: null };

/**
 * Încarcă fonturile (o singură dată, la pornirea aplicației).
 * Acces la rețea: descarcă două fișiere .ttf de pe serverul aplicației (baseUrl).
 * Întoarce octeții, ca să poată fi folosiți și de browser (FontFace) la previzualizare.
 */
export async function loadFonts(baseUrl) {
  async function fetchFontBytes(fileName) {
    const response = await fetch(baseUrl + fileName);
    if (!response.ok) {
      throw new Error(t('err.fontLoad', { f: fileName, s: response.status }));
    }
    const fontBuffer = await response.arrayBuffer();
    return new Uint8Array(fontBuffer);
  }

  // Cele două descărcări pornesc în paralel.
  const downloadedFonts = await Promise.all([
    fetchFontBytes('LiberationSans-Regular.ttf'),
    fetchFontBytes('LiberationSans-Bold.ttf'),
  ]);
  const regularBytes = downloadedFonts[0];
  const boldBytes = downloadedFonts[1];

  FONTS.r = new TTF(regularBytes);
  FONTS.b = new TTF(boldBytes);

  return { regular: regularBytes, bold: boldBytes };
}

/** Lățimea unui text (în puncte) scris cu fontul aplicației. */
export function measure(text, fontSize, bold = false) {
  if (bold) {
    return FONTS.b.widthOf(text, fontSize);
  }
  return FONTS.r.widthOf(text, fontSize);
}

/** Culoare din format text („#rrggbb” sau „#rgb”) -> culoare pdf-lib. */
function hexToRgb(hexColor) {
  let colorText = '#000000';
  if (hexColor) {
    colorText = String(hexColor);
  }
  let hexDigits = colorText.replace('#', '');

  // Forma scurtă „#abc” înseamnă „#aabbcc”.
  if (hexDigits.length === 3) {
    let expandedDigits = '';
    for (const digit of hexDigits) {
      expandedDigits += digit + digit;
    }
    hexDigits = expandedDigits;
  }

  let colorNumber = parseInt(hexDigits, 16);
  if (!colorNumber) {
    colorNumber = 0; // și pentru NaN (text invalid)
  }

  const red = ((colorNumber >> 16) & 255) / 255;
  const green = ((colorNumber >> 8) & 255) / 255;
  const blue = (colorNumber & 255) / 255;
  return rgb(red, green, blue);
}

/**
 * Înlocuiește variabilele dintr-un text de suprapunere:
 * {n} = numărul paginii, {total} = total pagini, {date} = data, {file} = numele documentului.
 */
export function fillVars(templateText, values) {
  let text = '';
  if (templateText !== null && templateText !== undefined) {
    text = String(templateText);
  }

  let dateText = values.date;
  if (dateText === null || dateText === undefined) {
    dateText = '';
  }
  let fileText = values.file;
  if (fileText === null || fileText === undefined) {
    fileText = '';
  }

  text = text.replaceAll('{n}', String(values.n));
  text = text.replaceAll('{total}', String(values.total));
  text = text.replaceAll('{date}', dateText);
  text = text.replaceAll('{file}', fileText);
  return text;
}

// Poziția pe grila 3×3 este un cod de 2 litere:
//   prima: t = sus (top), m = mijloc, b = jos (bottom);
//   a doua: l = stânga (left), c = centru, r = dreapta (right).
//   Ex.: 'bc' = jos, centru.

/** Poziția (punctul de start al liniei de bază) unui text pe pagină. */
function placeText(position, pageWidth, pageHeight, textWidth, fontSize, margin) {
  const vertical = position[0];
  const horizontal = position[1];

  let x;
  if (horizontal === 'l') {
    x = margin;
  } else if (horizontal === 'r') {
    x = pageWidth - margin - textWidth;
  } else {
    x = (pageWidth - textWidth) / 2;
  }

  // Coeficienții aproximează înălțimea majusculelor / coborâșurilor fontului.
  let y;
  if (vertical === 't') {
    y = pageHeight - margin - fontSize * 0.72;
  } else if (vertical === 'b') {
    y = margin + fontSize * 0.21;
  } else {
    y = pageHeight / 2 - fontSize * 0.36;
  }

  return { x: x, y: y };
}

/** Poziția (colțul stânga-jos) unui dreptunghi (ex. o imagine) pe pagină. */
function placeBox(position, pageWidth, pageHeight, boxWidth, boxHeight, margin) {
  const vertical = position[0];
  const horizontal = position[1];

  let x;
  if (horizontal === 'l') {
    x = margin;
  } else if (horizontal === 'r') {
    x = pageWidth - margin - boxWidth;
  } else {
    x = (pageWidth - boxWidth) / 2;
  }

  let y;
  if (vertical === 't') {
    y = pageHeight - margin - boxHeight;
  } else if (vertical === 'b') {
    y = margin;
  } else {
    y = (pageHeight - boxHeight) / 2;
  }

  return { x: x, y: y };
}

/** Opacitatea unei suprapuneri (procente în spec) ca număr între 0 și 1; implicit 100%. */
function opacityFraction(spec) {
  let opacityPercent = Number(spec.opacity);
  if (!opacityPercent) {
    opacityPercent = 100;
  }
  return opacityPercent / 100;
}

/**
 * Calculează elementele de desenat pentru o suprapunere, în coordonatele vizuale ale paginii
 * (originea în colțul stânga-jos al zonei vizibile, axa Y în sus, unități: puncte).
 *
 * @param spec           setările suprapunerii (type: 'num' | 'text' | 'wm' | 'img', …)
 * @param pageWidth      lățimea vizibilă a paginii
 * @param pageHeight     înălțimea vizibilă a paginii
 * @param variableValues valorile pentru {n}, {total}, {date}, {file}
 * @returns lista elementelor:
 *   { kind: 'text', text, x, y, size, angle, color, bold, opacity }  sau
 *   { kind: 'image', x, y, w, h, opacity }
 */
export function layoutOverlay(spec, pageWidth, pageHeight, variableValues) {
  let marginMm = Number(spec.margin);
  if (!marginMm) {
    marginMm = 0;
  }
  const margin = marginMm * MM;
  const bold = Boolean(spec.bold);

  // --- Numerotare și antet / subsol: un rând de text pe grila 3×3 ---
  if (spec.type === 'num' || spec.type === 'text') {
    let templateText = spec.text;
    if (spec.type === 'num') {
      templateText = spec.fmt;
    }
    const text = fillVars(templateText, variableValues);
    if (!text.trim()) {
      return [];
    }

    let fontSize = Number(spec.size);
    if (!fontSize) {
      fontSize = 10;
    }

    let position = spec.pos;
    if (!position) {
      position = 'bc';
    }

    let color = spec.color;
    if (!color) {
      color = '#000000';
    }

    const textWidth = measure(text, fontSize, bold);
    const point = placeText(position, pageWidth, pageHeight, textWidth, fontSize, margin);

    return [{
      kind: 'text',
      text: text,
      x: point.x,
      y: point.y,
      size: fontSize,
      angle: 0,
      color: color,
      bold: bold,
      opacity: 1,
    }];
  }

  // --- Watermark: text rotit, centrat pe pagină ---
  if (spec.type === 'wm') {
    const text = fillVars(spec.text, variableValues);
    if (!text.trim()) {
      return [];
    }

    let angleDegrees = Number(spec.angle);
    if (!angleDegrees) {
      angleDegrees = 0;
    }
    const angleRadians = (angleDegrees * Math.PI) / 180;

    let fontSize = Number(spec.size);
    if (!fontSize) {
      fontSize = 0;
    }

    if (fontSize === 0) {
      // Mărime automată: textul ocupă ~80% din pagină pe direcția lui.
      const widthAt100 = measure(text, 100, bold);
      const cosine = Math.abs(Math.cos(angleRadians));
      const sine = Math.abs(Math.sin(angleRadians));

      let lengthLimitedByWidth = Infinity;
      if (cosine > 1e-3) {
        lengthLimitedByWidth = pageWidth / cosine;
      }
      let lengthLimitedByHeight = Infinity;
      if (sine > 1e-3) {
        lengthLimitedByHeight = pageHeight / sine;
      }
      const availableLength = Math.min(lengthLimitedByWidth, lengthLimitedByHeight) * 0.8;

      // între 6 și 300 de puncte
      fontSize = Math.max(6, Math.min(300, (availableLength / widthAt100) * 100));
    }

    // Punctul de start, ales astfel încât centrul textului să cadă în centrul paginii.
    const halfTextWidth = measure(text, fontSize, bold) / 2;
    const halfTextHeight = fontSize * 0.36;
    const x = pageWidth / 2 - (halfTextWidth * Math.cos(angleRadians) - halfTextHeight * Math.sin(angleRadians));
    const y = pageHeight / 2 - (halfTextWidth * Math.sin(angleRadians) + halfTextHeight * Math.cos(angleRadians));

    let color = spec.color;
    if (!color) {
      color = '#cc0000';
    }

    return [{
      kind: 'text',
      text: text,
      x: x,
      y: y,
      size: fontSize,
      angle: angleDegrees,
      color: color,
      bold: bold,
      opacity: opacityFraction(spec),
    }];
  }

  // --- Imagine: lățimea e un procent din lățimea paginii, proporțiile se păstrează ---
  if (spec.type === 'img' && spec.image) {
    let widthPercent = Number(spec.widthPct);
    if (!widthPercent) {
      widthPercent = 20;
    }
    const imageWidth = pageWidth * widthPercent / 100;
    const imageHeight = imageWidth * (spec.image.h / spec.image.w);

    let position = spec.pos;
    if (!position) {
      position = 'br';
    }
    const corner = placeBox(position, pageWidth, pageHeight, imageWidth, imageHeight, margin);

    return [{
      kind: 'image',
      x: corner.x,
      y: corner.y,
      w: imageWidth,
      h: imageHeight,
      opacity: opacityFraction(spec),
    }];
  }

  return [];
}

/**
 * Sistemul de coordonate vizual al paginii (vezi layoutOverlay) și matricea care îl
 * transformă în spațiul PDF al paginii, ținând cont de CropBox și de /Rotate.
 * Astfel suprapunerile se desenează fără aplatizarea paginii (linkurile rămân).
 *
 * Întoarce { vw, vh, m }: lățimea și înălțimea vizibile și matricea [a, b, c, d, e, f].
 */
function visualFrame(page) {
  const rotation = normalizeAngle(page.getRotation().angle);
  const box = cropBoxOf(page);
  const x0 = box.x;
  const y0 = box.y;
  const w = box.w;
  const h = box.h;

  if (rotation === 90) {
    return { vw: h, vh: w, m: [0, 1, -1, 0, x0 + w, y0] };
  }
  if (rotation === 180) {
    return { vw: w, vh: h, m: [-1, 0, 0, -1, x0 + w, y0 + h] };
  }
  if (rotation === 270) {
    return { vw: h, vh: w, m: [0, -1, 1, 0, x0, y0 + h] };
  }
  return { vw: w, vh: h, m: [1, 0, 0, 1, x0, y0] };
}

/**
 * Desenează suprapunerile în documentul final.
 * overlaysByPage[k] = [{ spec, vars }, …] pentru pagina k a documentului.
 */
export async function applyOverlays(doc, overlaysByPage) {
  // Fonturile se încorporează doar la prima folosire (unul pentru normal, unul pentru îngroșat).
  const embeddedFonts = {};
  function getEmbeddedFont(bold) {
    let fontKey = 'r';
    if (bold) {
      fontKey = 'b';
    }
    if (embeddedFonts[fontKey] === null || embeddedFonts[fontKey] === undefined) {
      embeddedFonts[fontKey] = embedTTF(doc, FONTS[fontKey]);
    }
    return embeddedFonts[fontKey];
  }

  // Fiecare imagine se încorporează o singură dată (după id-ul stratului), chiar dacă apare pe mai multe pagini.
  const embeddedImages = new Map();

  for (let pageIndex = 0; pageIndex < overlaysByPage.length; pageIndex++) {
    const overlayList = overlaysByPage[pageIndex];
    if (!overlayList || overlayList.length === 0) {
      continue;
    }

    const page = doc.getPage(pageIndex);
    const frame = visualFrame(page);
    const matrix = frame.m;

    // Toate suprapunerile paginii se desenează în sistemul vizual (salvat / restaurat ca grup).
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]),
    );

    for (const overlayEntry of overlayList) {
      const spec = overlayEntry.spec;
      const items = layoutOverlay(spec, frame.vw, frame.vh, overlayEntry.vars);

      for (const item of items) {
        // Opacitatea se scrie în PDF doar dacă e sub 100%.
        let opacity = undefined;
        if (item.opacity < 1) {
          opacity = item.opacity;
        }

        if (item.kind === 'text') {
          const font = getEmbeddedFont(item.bold);
          page.drawText(item.text, {
            x: item.x,
            y: item.y,
            size: item.size,
            font: font,
            color: hexToRgb(item.color),
            rotate: degrees(item.angle),
            opacity: opacity,
          });
        } else {
          if (!embeddedImages.has(spec.id)) {
            const embeddedImage = await embedImage(doc, spec.image);
            embeddedImages.set(spec.id, embeddedImage);
          }
          page.drawImage(embeddedImages.get(spec.id), {
            x: item.x,
            y: item.y,
            width: item.w,
            height: item.h,
            opacity: opacity,
          });
        }
      }
    }

    page.pushOperators(popGraphicsState());
  }
}

// =====================================================================
//  Imagini și pagini noi
// =====================================================================

/**
 * Citește un fișier imagine (orice format suportat de browser) și îl convertește în PNG sau JPEG.
 * Întoarce { bytes, kind: 'png' | 'jpg', w, h }.
 */
export async function readImage(file) {
  // Decodarea imaginii (orientarea EXIF se aplică automat).
  const bitmap = await createImageBitmap(file);

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');

  let fileName = '';
  if (file.name) {
    fileName = file.name;
  }
  const typeIsJpeg = /jpe?g/i.test(file.type);
  const nameIsJpeg = /\.jpe?g$/i.test(fileName);
  const isJpeg = typeIsJpeg || nameIsJpeg;

  // JPEG nu are transparență: fundalul se face alb.
  if (isJpeg) {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(bitmap, 0, 0);
  if (typeof bitmap.close === 'function') {
    bitmap.close(); // eliberează memoria imaginii decodate
  }

  let outputType = 'image/png';
  let outputKind = 'png';
  if (isJpeg) {
    outputType = 'image/jpeg';
    outputKind = 'jpg';
  }

  // canvas.toBlob() anunță rezultatul printr-o funcție; o transformăm în promisiune.
  const blob = await new Promise(function waitForBlob(resolve) {
    canvas.toBlob(resolve, outputType, 0.93);
  });
  const imageBuffer = await blob.arrayBuffer();

  return {
    bytes: new Uint8Array(imageBuffer),
    kind: outputKind,
    w: canvas.width,
    h: canvas.height,
  };
}

/** Încorporează o imagine (rezultat de la readImage) într-un document pdf-lib. */
async function embedImage(doc, image) {
  if (image.kind === 'jpg') {
    return doc.embedJpg(image.bytes);
  }
  return doc.embedPng(image.bytes);
}

/** PDF cu pagini albe; pageSizes = [[lățime, înălțime], …] în puncte. */
export async function makeBlankPdf(pageSizes) {
  const doc = await PDFDocument.create();
  for (const pageSize of pageSizes) {
    doc.addPage(pageSize);
  }
  return saveDoc(doc);
}

/**
 * Transformă imagini în pagini PDF (o imagine pe pagină, centrată și scalată).
 * options.format: 'A4'   – A4, orientare după imagine
 *                 'fit'  – pagina are exact mărimea imaginii (la 96 dpi), fără margine
 *                 'same' – mărimea options.refSize = [lățime, înălțime]
 * options.margin: marginea în mm
 */
export async function imagesToPdf(files, options = {}) {
  let format = options.format;
  if (format === undefined) {
    format = 'A4';
  }
  let marginMm = options.margin;
  if (marginMm === undefined) {
    marginMm = 10;
  }
  let referenceSize = options.refSize;
  if (referenceSize === undefined) {
    referenceSize = null;
  }

  const doc = await PDFDocument.create();
  const defaultMarginPt = marginMm * MM;

  for (const file of files) {
    const image = await readImage(file);
    const embeddedImage = await embedImage(doc, image);

    let pageWidth;
    let pageHeight;
    let marginPt = defaultMarginPt;

    if (format === 'fit') {
      // 96 dpi: 1 pixel = 0,75 puncte
      pageWidth = image.w * 0.75;
      pageHeight = image.h * 0.75;
      marginPt = 0;
    } else if (format === 'same' && referenceSize) {
      pageWidth = referenceSize[0];
      pageHeight = referenceSize[1];
    } else {
      const a4Width = FORMATS.A4[0];
      const a4Height = FORMATS.A4[1];
      if (image.w > image.h) {
        pageWidth = a4Height; // imagine lată -> A4 peisaj
        pageHeight = a4Width;
      } else {
        pageWidth = a4Width;
        pageHeight = a4Height;
      }
    }

    const page = doc.addPage([pageWidth, pageHeight]);
    const scale = Math.min((pageWidth - 2 * marginPt) / image.w, (pageHeight - 2 * marginPt) / image.h);
    const drawWidth = image.w * scale;
    const drawHeight = image.h * scale;

    page.drawImage(embeddedImage, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }

  return saveDoc(doc);
}
