// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Marius SEUL – https://code-by-seul.ro/
// =====================================================================
//  PageFix – font TrueType încorporat în PDF (fără librăria fontkit)
//
//  - citește un fișier .ttf (tabelele cmap, hmtx, glyf/loca și metricile);
//  - creează un subset (păstrează doar glifele folosite; ID-urile glifelor rămân aceleași);
//  - îl încorporează în PDF ca font Type0 / CIDFontType2 (Identity-H) cu tabel ToUnicode,
//    deci textul cu ă, â, î, ș, ț este vectorial, selectabil și căutabil.
//
//  Fontul citit este Liberation Sans, livrat împreună cu aplicația (lib/pdfjs/standard_fonts/).
//  Referință pentru structura fișierului: specificația OpenType / TrueType (Microsoft / Apple).
// =====================================================================
const { CustomFontEmbedder, PDFFont, PDFHexString, PDFString } = window.PDFLib;

// Tabelele fără de care fontul nu poate fi folosit.
const REQUIRED_TABLES = ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'loca', 'glyf'];

// Tabelele copiate neschimbate în subset (dacă există în font).
const TABLES_COPIED_TO_SUBSET = ['hhea', 'maxp', 'hmtx', 'cmap', 'cvt ', 'fpgm', 'prep', 'OS/2', 'name', 'post'];

// Indicatori (flags) pentru componentele unei glife compuse (tabelul glyf).
const COMPONENT_ARGS_ARE_WORDS = 0x0001;    // argumentele de poziție au 2 octeți (altfel 1)
const COMPONENT_HAS_SCALE = 0x0008;         // urmează o scară simplă (2 octeți)
const COMPONENT_MORE_COMPONENTS = 0x0020;   // după această componentă mai urmează una
const COMPONENT_HAS_XY_SCALE = 0x0040;      // urmează scări separate pe X și Y (4 octeți)
const COMPONENT_HAS_2X2_MATRIX = 0x0080;    // urmează o matrice 2×2 (8 octeți)

function compareNumbersAscending(first, second) {
  return first - second;
}

/** Rotunjește o lungime în sus la un multiplu de 4 octeți (tabelele TrueType sunt aliniate la 4). */
function alignTo4Bytes(length) {
  return (length + 3) & ~3;
}

// =====================================================================
//  Citirea fontului
// =====================================================================
export class TTF {
  constructor(fontData) {
    if (fontData instanceof Uint8Array) {
      this.bytes = fontData;
    } else {
      this.bytes = new Uint8Array(fontData);
    }
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const view = this.view;

    // --- Directorul de tabele: la octetul 12 încep înregistrările de câte 16 octeți ---
    const tableCount = view.getUint16(4);
    this.tables = {};
    for (let tableNumber = 0; tableNumber < tableCount; tableNumber++) {
      const recordOffset = 12 + tableNumber * 16;

      let tag = '';
      for (let charIndex = 0; charIndex < 4; charIndex++) {
        tag += String.fromCharCode(this.bytes[recordOffset + charIndex]);
      }

      this.tables[tag] = {
        offset: view.getUint32(recordOffset + 8),
        length: view.getUint32(recordOffset + 12),
      };
    }

    for (const requiredTag of REQUIRED_TABLES) {
      if (!this.tables[requiredTag]) {
        throw new Error(`Invalid font: missing table ${requiredTag}`);
      }
    }

    // --- Tabelul head: unități per em, chenarul glifelor, formatul tabelului loca ---
    const headOffset = this.tables.head.offset;
    this.unitsPerEm = view.getUint16(headOffset + 18);
    this.boundingBox = [
      view.getInt16(headOffset + 36),
      view.getInt16(headOffset + 38),
      view.getInt16(headOffset + 40),
      view.getInt16(headOffset + 42),
    ];
    this.locaFormat = view.getInt16(headOffset + 50); // 0 = offset-uri pe 2 octeți, 1 = pe 4 octeți

    // --- Tabelul hhea: metrici verticale și numărul de lățimi din hmtx ---
    const hheaOffset = this.tables.hhea.offset;
    this.ascender = view.getInt16(hheaOffset + 4);
    this.descender = view.getInt16(hheaOffset + 6);
    const advanceWidthCount = view.getUint16(hheaOffset + 34);

    // --- Tabelul maxp: numărul de glife ---
    this.glyphCount = view.getUint16(this.tables.maxp.offset + 4);

    // --- Tabelul hmtx: lățimea fiecărei glife ---
    // Glifele de după ultima intrare din hmtx au aceeași lățime ca ultima intrare.
    this.advanceWidths = new Uint16Array(this.glyphCount);
    const hmtxOffset = this.tables.hmtx.offset;
    let lastAdvanceWidth = 0;
    for (let glyphId = 0; glyphId < this.glyphCount; glyphId++) {
      if (glyphId < advanceWidthCount) {
        lastAdvanceWidth = view.getUint16(hmtxOffset + glyphId * 4);
      }
      this.advanceWidths[glyphId] = lastAdvanceWidth;
    }

    // --- Tabelele OS/2 și post (opționale): grosime, înălțimi, înclinare ---
    this.capHeight = Math.round(this.ascender * 0.7);
    this.xHeight = Math.round(this.ascender * 0.5);
    this.weight = 400;
    if (this.tables['OS/2']) {
      const os2Offset = this.tables['OS/2'].offset;
      const os2Version = view.getUint16(os2Offset);
      this.weight = view.getUint16(os2Offset + 4);
      if (os2Version >= 2) {
        this.xHeight = view.getInt16(os2Offset + 86);
        this.capHeight = view.getInt16(os2Offset + 88);
      }
    }

    this.italicAngle = 0;
    if (this.tables.post) {
      this.italicAngle = view.getInt32(this.tables.post.offset + 4) / 65536; // număr în format 16.16
    }

    this.postScriptName = this.readPostScriptName();
    if (!this.postScriptName) {
      this.postScriptName = 'EmbeddedFont';
    }

    // --- Tabelul cmap: caracter Unicode -> ID glifă ---
    this.codePointToGlyphId = this.readCharacterMap();

    // --- Tabelul loca: unde începe fiecare glifă în tabelul glyf ---
    this.glyphOffsets = new Uint32Array(this.glyphCount + 1);
    const locaOffset = this.tables.loca.offset;
    for (let glyphId = 0; glyphId <= this.glyphCount; glyphId++) {
      if (this.locaFormat !== 0) {
        this.glyphOffsets[glyphId] = view.getUint32(locaOffset + glyphId * 4);
      } else {
        this.glyphOffsets[glyphId] = view.getUint16(locaOffset + glyphId * 2) * 2;
      }
    }
  }

  /** Numele PostScript al fontului (tabelul name, înregistrarea nr. 6); null dacă lipsește. */
  readPostScriptName() {
    const nameTable = this.tables.name;
    if (!nameTable) {
      return null;
    }

    const view = this.view;
    const tableOffset = nameTable.offset;
    const recordCount = view.getUint16(tableOffset + 2);
    const stringsOffset = tableOffset + view.getUint16(tableOffset + 4);

    for (let recordNumber = 0; recordNumber < recordCount; recordNumber++) {
      const recordOffset = tableOffset + 6 + recordNumber * 12;
      const platformId = view.getUint16(recordOffset);
      const nameId = view.getUint16(recordOffset + 6);
      const stringLength = view.getUint16(recordOffset + 8);
      const stringOffset = view.getUint16(recordOffset + 10);

      if (nameId !== 6) {
        continue;
      }

      const stringStart = stringsOffset + stringOffset;
      const stringBytes = this.bytes.subarray(stringStart, stringStart + stringLength);

      let name = '';
      const isUtf16 = (platformId === 3 || platformId === 0);
      if (isUtf16) {
        // Platformele Unicode (0) și Windows (3): text UTF-16 big-endian.
        for (let byteIndex = 0; byteIndex + 1 < stringBytes.length; byteIndex += 2) {
          const charCode = (stringBytes[byteIndex] << 8) | stringBytes[byteIndex + 1];
          name += String.fromCharCode(charCode);
        }
      } else {
        // Platforma Macintosh (1): un octet per caracter.
        for (let byteIndex = 0; byteIndex < stringBytes.length; byteIndex++) {
          name += String.fromCharCode(stringBytes[byteIndex]);
        }
      }

      // În PDF, numele fontului poate conține doar litere, cifre și '-'.
      name = name.replace(/[^A-Za-z0-9-]/g, '');
      if (name) {
        return name;
      }
    }

    return null;
  }

  /**
   * Citește tabelul cmap și întoarce un Map: punct de cod Unicode -> ID glifă.
   * Se alege cel mai bun subtabel disponibil:
   *   formatul 12 (Unicode complet) > formatul 4 Windows (BMP) > formatul 4 Unicode (BMP).
   */
  readCharacterMap() {
    const view = this.view;
    const cmapOffset = this.tables.cmap.offset;
    const subtableCount = view.getUint16(cmapOffset + 2);

    let bestSubtable = null;
    let bestScore = -1;

    for (let subtableNumber = 0; subtableNumber < subtableCount; subtableNumber++) {
      const recordOffset = cmapOffset + 4 + subtableNumber * 8;
      const platformId = view.getUint16(recordOffset);
      const encodingId = view.getUint16(recordOffset + 2);
      const subtableOffset = cmapOffset + view.getUint32(recordOffset + 4);
      const subtableFormat = view.getUint16(subtableOffset);

      const isWindowsFullUnicode = (platformId === 3 && encodingId === 10);
      const isWindowsBmp = (platformId === 3 && encodingId === 1);
      const isUnicodePlatform = (platformId === 0);

      let score = -1;
      if (subtableFormat === 12 && (isWindowsFullUnicode || isUnicodePlatform)) {
        score = 3;
      } else if (subtableFormat === 4 && isWindowsBmp) {
        score = 2;
      } else if (subtableFormat === 4 && isUnicodePlatform) {
        score = 1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestSubtable = { offset: subtableOffset, format: subtableFormat };
      }
    }

    if (!bestSubtable) {
      throw new Error('Font has no Unicode cmap table.');
    }

    const codePointToGlyphId = new Map();
    const subtableOffset = bestSubtable.offset;

    if (bestSubtable.format === 4) {
      // Formatul 4: segmente de caractere consecutive (doar planul de bază Unicode, BMP).
      const segmentCountTimes2 = view.getUint16(subtableOffset + 6);
      const segmentCount = segmentCountTimes2 / 2;
      const endCodesOffset = subtableOffset + 14;
      const startCodesOffset = endCodesOffset + segmentCountTimes2 + 2;
      const idDeltasOffset = startCodesOffset + segmentCountTimes2;
      const idRangeOffsetsOffset = idDeltasOffset + segmentCountTimes2;

      for (let segment = 0; segment < segmentCount; segment++) {
        const endCode = view.getUint16(endCodesOffset + segment * 2);
        const startCode = view.getUint16(startCodesOffset + segment * 2);
        const idDelta = view.getInt16(idDeltasOffset + segment * 2);
        const idRangeOffset = view.getUint16(idRangeOffsetsOffset + segment * 2);

        for (let codePoint = startCode; codePoint <= endCode && codePoint !== 0xffff; codePoint++) {
          let glyphId;
          if (idRangeOffset === 0) {
            glyphId = (codePoint + idDelta) & 0xffff;
          } else {
            const glyphIndexAddress = idRangeOffsetsOffset + segment * 2 + idRangeOffset + (codePoint - startCode) * 2;
            glyphId = view.getUint16(glyphIndexAddress);
            if (glyphId !== 0) {
              glyphId = (glyphId + idDelta) & 0xffff;
            }
          }

          if (glyphId !== 0) {
            codePointToGlyphId.set(codePoint, glyphId);
          }
        }
      }
    } else {
      // Formatul 12: grupuri de caractere consecutive mapate pe glife consecutive.
      const groupCount = view.getUint32(subtableOffset + 12);
      for (let groupNumber = 0; groupNumber < groupCount; groupNumber++) {
        const groupOffset = subtableOffset + 16 + groupNumber * 12;
        const startCharCode = view.getUint32(groupOffset);
        const endCharCode = view.getUint32(groupOffset + 4);
        const startGlyphId = view.getUint32(groupOffset + 8);

        for (let codePoint = startCharCode; codePoint <= endCharCode; codePoint++) {
          codePointToGlyphId.set(codePoint, startGlyphId + codePoint - startCharCode);
        }
      }
    }

    return codePointToGlyphId;
  }

  /** ID-ul glifei pentru un punct de cod Unicode (0 = glifa „lipsă”, dacă fontul nu are caracterul). */
  glyphIdForCodePoint(codePoint) {
    const glyphId = this.codePointToGlyphId.get(codePoint);
    if (glyphId === undefined) {
      return 0;
    }
    return glyphId;
  }

  /** Factorul de conversie din unitățile fontului în unitățile PDF (1000 per em). */
  scaleToPdfUnits() {
    return 1000 / this.unitsPerEm;
  }

  /** Lățimea unui text, în puncte, la mărimea de font dată. */
  widthOf(text, fontSize) {
    let totalAdvance = 0;
    for (const character of text) {
      const glyphId = this.glyphIdForCodePoint(character.codePointAt(0));
      totalAdvance += this.advanceWidths[glyphId];
    }
    return (totalAdvance / this.unitsPerEm) * fontSize;
  }

  /**
   * Glifele componente ale unei glife compuse (ex. „ș” = „s” + virgula de dedesubt).
   * Pentru o glifă simplă (sau goală) întoarce [].
   */
  compositeGlyphComponents(glyphId) {
    const glyphStart = this.tables.glyf.offset + this.glyphOffsets[glyphId];
    const glyphLength = this.glyphOffsets[glyphId + 1] - this.glyphOffsets[glyphId];
    if (glyphLength < 10) {
      return []; // glifă goală (fără contur)
    }

    const view = this.view;
    const contourCount = view.getInt16(glyphStart);
    if (contourCount >= 0) {
      return []; // glifă simplă
    }

    // Glifă compusă: după antetul de 10 octeți urmează lista componentelor.
    const componentGlyphIds = [];
    let position = glyphStart + 10;
    let flags;
    do {
      flags = view.getUint16(position);
      componentGlyphIds.push(view.getUint16(position + 2));

      // flags (2) + ID glifă (2) + argumentele de poziție (2 × 2 sau 2 × 1 octeți)
      if (flags & COMPONENT_ARGS_ARE_WORDS) {
        position += 4 + 4;
      } else {
        position += 4 + 2;
      }

      // transformarea opțională
      if (flags & COMPONENT_HAS_SCALE) {
        position += 2;
      } else if (flags & COMPONENT_HAS_XY_SCALE) {
        position += 4;
      } else if (flags & COMPONENT_HAS_2X2_MATRIX) {
        position += 8;
      }
    } while (flags & COMPONENT_MORE_COMPONENTS);

    return componentGlyphIds;
  }

  /** Copie independentă a unui tabel din font. */
  copyTable(tag) {
    const table = this.tables[tag];
    const tableCopy = new Uint8Array(table.length);
    tableCopy.set(this.bytes.subarray(table.offset, table.offset + table.length));
    return tableCopy;
  }

  /**
   * Creează un font nou (octeții unui fișier .ttf) care păstrează doar conturul
   * glifelor folosite; celelalte glife rămân goale. ID-urile glifelor nu se schimbă.
   */
  createSubset(usedGlyphIds) {
    // --- 1. Glifele păstrate: glifa 0, cele folosite și componentele glifelor compuse ---
    const keptGlyphIds = new Set([0]);
    for (const glyphId of usedGlyphIds) {
      keptGlyphIds.add(glyphId);
    }

    const glyphsToInspect = [];
    for (const glyphId of keptGlyphIds) {
      glyphsToInspect.push(glyphId);
    }
    while (glyphsToInspect.length > 0) {
      const glyphId = glyphsToInspect.pop();
      const components = this.compositeGlyphComponents(glyphId);
      for (const componentId of components) {
        if (!keptGlyphIds.has(componentId)) {
          keptGlyphIds.add(componentId);
          glyphsToInspect.push(componentId);
        }
      }
    }

    // --- 2. Tabelele glyf și loca noi (loca în format lung: offset-uri pe 4 octeți) ---
    const glyfOffset = this.tables.glyf.offset;
    const glyphChunks = [];
    const newLoca = new DataView(new ArrayBuffer((this.glyphCount + 1) * 4));
    let glyfLength = 0;

    for (let glyphId = 0; glyphId < this.glyphCount; glyphId++) {
      newLoca.setUint32(glyphId * 4, glyfLength);

      if (!keptGlyphIds.has(glyphId)) {
        continue; // glifă eliminată: lungime 0
      }

      const glyphLength = this.glyphOffsets[glyphId + 1] - this.glyphOffsets[glyphId];
      if (glyphLength > 0) {
        const paddedLength = alignTo4Bytes(glyphLength);
        const chunk = new Uint8Array(paddedLength);
        const glyphStart = glyfOffset + this.glyphOffsets[glyphId];
        chunk.set(this.bytes.subarray(glyphStart, glyphStart + glyphLength));
        glyphChunks.push(chunk);
        glyfLength += paddedLength;
      }
    }
    newLoca.setUint32(this.glyphCount * 4, glyfLength);

    const newGlyf = new Uint8Array(glyfLength);
    let writePosition = 0;
    for (const chunk of glyphChunks) {
      newGlyf.set(chunk, writePosition);
      writePosition += chunk.length;
    }

    // --- 3. Tabelul head modificat ---
    const newHead = this.copyTable('head');
    const newHeadView = new DataView(newHead.buffer);
    newHeadView.setInt16(50, 1);   // indexToLocFormat = 1 (format lung)
    newHeadView.setUint32(8, 0);   // checksumAdjustment – se recalculează în buildFontFile()

    // --- 4. Restul tabelelor se copiază neschimbate ---
    const subsetTables = {
      head: newHead,
      glyf: newGlyf,
      loca: new Uint8Array(newLoca.buffer),
    };
    for (const tag of TABLES_COPIED_TO_SUBSET) {
      if (this.tables[tag]) {
        subsetTables[tag] = this.copyTable(tag);
      }
    }

    return buildFontFile(subsetTables);
  }
}

// =====================================================================
//  Scrierea unui fișier de font (format sfnt)
// =====================================================================

/** Suma de control TrueType: suma numerelor pe 32 de biți ale tabelului (aliniat la 4 octeți). */
function tableChecksum(tableBytes) {
  const paddedLength = alignTo4Bytes(tableBytes.length);
  const paddedBytes = new Uint8Array(paddedLength);
  paddedBytes.set(tableBytes);
  const view = new DataView(paddedBytes.buffer);

  let sum = 0;
  for (let offset = 0; offset < paddedLength; offset += 4) {
    sum = (sum + view.getUint32(offset)) >>> 0; // >>> 0 păstrează rezultatul pe 32 de biți, fără semn
  }
  return sum;
}

/** Asamblează tabelele într-un fișier de font TrueType complet. tables = { tag: Uint8Array }. */
function buildFontFile(tables) {
  const tags = Object.keys(tables).sort(); // directorul de tabele trebuie sortat după nume
  const tableCount = tags.length;

  // entrySelector = log2(cea mai mare putere a lui 2 ≤ numărul de tabele)
  let entrySelector = 0;
  while ((1 << (entrySelector + 1)) <= tableCount) {
    entrySelector++;
  }
  const searchRange = (1 << entrySelector) * 16;
  const rangeShift = tableCount * 16 - searchRange;

  const headerLength = 12 + tableCount * 16;
  let totalLength = headerLength;
  for (const tag of tags) {
    totalLength += alignTo4Bytes(tables[tag].length);
  }

  const fontBytes = new Uint8Array(totalLength);
  const view = new DataView(fontBytes.buffer);

  // Antetul fișierului
  view.setUint32(0, 0x00010000); // versiunea sfnt pentru TrueType
  view.setUint16(4, tableCount);
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, rangeShift);

  // Directorul de tabele și conținutul lor
  let dataOffset = headerLength;
  let headTableOffset = 0;
  for (let tableNumber = 0; tableNumber < tags.length; tableNumber++) {
    const tag = tags[tableNumber];
    const tableBytes = tables[tag];
    const recordOffset = 12 + tableNumber * 16;

    for (let charIndex = 0; charIndex < 4; charIndex++) {
      fontBytes[recordOffset + charIndex] = tag.charCodeAt(charIndex);
    }
    view.setUint32(recordOffset + 4, tableChecksum(tableBytes));
    view.setUint32(recordOffset + 8, dataOffset);
    view.setUint32(recordOffset + 12, tableBytes.length);

    fontBytes.set(tableBytes, dataOffset);
    if (tag === 'head') {
      headTableOffset = dataOffset;
    }
    dataOffset += alignTo4Bytes(tableBytes.length);
  }

  // checksumAdjustment din tabelul head (valoarea magică este definită de specificație)
  const checksumAdjustment = (0xB1B0AFBA - tableChecksum(fontBytes)) >>> 0;
  view.setUint32(headTableOffset + 8, checksumAdjustment);

  return fontBytes;
}

// =====================================================================
//  Încorporarea în PDF
// =====================================================================

/** Număr în hexazecimal, 4 cifre, majuscule (ex. 0x1A -> "001A"). */
function toHex4(number) {
  return number.toString(16).padStart(4, '0').toUpperCase();
}

/** Un punct de cod Unicode în UTF-16, ca text hexazecimal (pentru tabelul ToUnicode). */
function codePointToUtf16Hex(codePoint) {
  if (codePoint < 0x10000) {
    return toHex4(codePoint);
  }
  // Caracter din afara BMP: pereche de surogate.
  const offsetValue = codePoint - 0x10000;
  const highSurrogate = 0xd800 + (offsetValue >> 10);
  const lowSurrogate = 0xdc00 + (offsetValue & 0x3ff);
  return toHex4(highSurrogate) + toHex4(lowSurrogate);
}

/** Etichetă de 6 majuscule aleatoare, cerută de PDF pentru fonturile subset (ex. "ABCDEF+Font"). */
function randomSubsetTag() {
  let tag = '';
  for (let letterIndex = 0; letterIndex < 6; letterIndex++) {
    const letterCode = 65 + Math.floor(Math.random() * 26); // 65 = 'A'
    tag += String.fromCharCode(letterCode);
  }
  return tag;
}

/** Conținutul tabelului ToUnicode (CMap), care permite copierea și căutarea textului din PDF. */
function buildToUnicodeCMap(glyphIds, glyphIdToCodePoint) {
  const mappingLines = [];
  for (const glyphId of glyphIds) {
    if (glyphId === 0) {
      continue;
    }
    const codePoint = glyphIdToCodePoint.get(glyphId);
    mappingLines.push(`<${toHex4(glyphId)}> <${codePointToUtf16Hex(codePoint)}>`);
  }

  let cmapText = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
    + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
    + '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';

  // Intrările se scriu în blocuri de maximum 100 (limita din specificație).
  for (let blockStart = 0; blockStart < mappingLines.length; blockStart += 100) {
    const blockLines = mappingLines.slice(blockStart, blockStart + 100);
    cmapText += `${blockLines.length} beginbfchar\n${blockLines.join('\n')}\nendbfchar\n`;
  }

  cmapText += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
  return cmapText;
}

/**
 * Creează un PDFFont (pdf-lib) pentru documentul dat, pe baza fontului citit `ttf`.
 *
 * Glifele folosite se adună pe măsură ce textul este desenat; fontul (doar subsetul
 * necesar) se scrie efectiv în PDF la doc.save().
 *
 * pdf-lib nu poate încorpora fonturi TrueType fără librăria fontkit, așa că aici se
 * construiește manual un obiect compatibil cu clasa internă CustomFontEmbedder a pdf-lib
 * (aceleași metode, implementate cu cititorul TTF de mai sus).
 */
export function embedTTF(doc, ttf) {
  const glyphIdToCodePoint = new Map(); // glifele folosite: ID glifă -> punct de cod Unicode
  const scale = ttf.scaleToPdfUnits();

  const embedder = Object.create(CustomFontEmbedder.prototype);

  embedder.fontName = ttf.postScriptName;

  /** Codifică textul ca ID-uri de glife (2 octeți fiecare) și reține glifele folosite. */
  embedder.encodeText = function encodeText(text) {
    let hexText = '';
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      const glyphId = ttf.glyphIdForCodePoint(codePoint);
      if (!glyphIdToCodePoint.has(glyphId)) {
        glyphIdToCodePoint.set(glyphId, codePoint);
      }
      hexText += toHex4(glyphId);
    }
    return PDFHexString.of(hexText);
  };

  embedder.widthOfTextAtSize = function widthOfTextAtSize(text, fontSize) {
    return ttf.widthOf(text, fontSize);
  };

  embedder.heightOfFontAtSize = function heightOfFontAtSize(fontSize) {
    return ((ttf.ascender - ttf.descender) / ttf.unitsPerEm) * fontSize;
  };

  embedder.sizeOfFontAtHeight = function sizeOfFontAtHeight(height) {
    return (height * ttf.unitsPerEm) / (ttf.ascender - ttf.descender);
  };

  /** Apelată de pdf-lib la doc.save(): scrie în PDF obiectele fontului. */
  embedder.embedIntoContext = async function embedIntoContext(context, fontRef) {
    const baseFontName = `${randomSubsetTag()}+${ttf.postScriptName}`;

    const usedGlyphIds = [];
    for (const glyphId of glyphIdToCodePoint.keys()) {
      usedGlyphIds.push(glyphId);
    }
    usedGlyphIds.sort(compareNumbersAscending);

    // 1) Fișierul de font (subset), comprimat. Length1 = lungimea necomprimată.
    const subsetBytes = ttf.createSubset(usedGlyphIds);
    const fontFileRef = context.register(context.flateStream(subsetBytes, { Length1: subsetBytes.length }));

    // 2) Descriptorul fontului (metrici).
    let fontFlags = 32; // 32 = font nesimbolic (caractere latine standard)
    if (ttf.italicAngle !== 0) {
      fontFlags = fontFlags | 64; // 64 = italic
    }

    const fontBoundingBox = [];
    for (const coordinate of ttf.boundingBox) {
      fontBoundingBox.push(Math.round(coordinate * scale));
    }

    let stemThickness = 80;
    if (ttf.weight >= 600) {
      stemThickness = 120; // font îngroșat
    }

    const descriptorRef = context.register(context.obj({
      Type: 'FontDescriptor',
      FontName: baseFontName,
      Flags: fontFlags,
      FontBBox: fontBoundingBox,
      ItalicAngle: ttf.italicAngle,
      Ascent: Math.round(ttf.ascender * scale),
      Descent: Math.round(ttf.descender * scale),
      CapHeight: Math.round(ttf.capHeight * scale),
      XHeight: Math.round(ttf.xHeight * scale),
      StemV: stemThickness,
      FontFile2: fontFileRef,
    }));

    // 3) Fontul CID: lățimile glifelor folosite (W = [id [lățime] id [lățime] ...]).
    const glyphWidths = [];
    for (const glyphId of usedGlyphIds) {
      glyphWidths.push(glyphId, [Math.round(ttf.advanceWidths[glyphId] * scale)]);
    }

    const cidFontRef = context.register(context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: baseFontName,
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: descriptorRef,
      DW: 1000,
      W: glyphWidths,
      CIDToGIDMap: 'Identity',
    }));

    // 4) Tabelul ToUnicode (pentru copiere / căutare text).
    const toUnicodeText = buildToUnicodeCMap(usedGlyphIds, glyphIdToCodePoint);
    const toUnicodeRef = context.register(context.flateStream(toUnicodeText));

    // 5) Fontul Type0 propriu-zis, la referința rezervată de pdf-lib.
    context.assign(fontRef, context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: baseFontName,
      Encoding: 'Identity-H',
      DescendantFonts: [cidFontRef],
      ToUnicode: toUnicodeRef,
    }));

    return fontRef;
  };

  const font = PDFFont.of(doc.context.nextRef(), doc, embedder);
  doc.fonts.push(font); // pdf-lib încorporează fonturile din această listă la save()
  return font;
}
