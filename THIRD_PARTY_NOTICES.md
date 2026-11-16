# Third-party notices

PageFix bundles the following components, unmodified, so that it works offline.
Each keeps its own license; the full license texts are included in the paths listed.

| Component | Version | License | Location | License text |
|---|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`, legacy build) | 6.2.108 | Apache-2.0 | `lib/pdfjs/` | `lib/pdfjs/LICENSE` |
| pdf.js WebAssembly modules: OpenJPEG (BSD-2-Clause), JBIG2 from PDFium (BSD-3-Clause), QCMS (MIT), QuickJS (MIT), Mozilla wrappers (Apache-2.0 / BSD) | bundled with pdf.js | see column 1 | `lib/pdfjs/wasm/` | `lib/pdfjs/wasm/LICENSE_*` |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | `lib/pdf-lib.min.js` | `lib/pdf-lib.LICENSE.md` |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT (dual-licensed MIT / GPLv3; used under MIT) | `lib/jszip.min.js` | `lib/jszip.LICENSE.md` |
| [Liberation Sans](https://github.com/liberationfonts/liberation-fonts) (Regular, Bold, Italic, Bold Italic) | 2.x | SIL Open Font License 1.1 | `lib/pdfjs/standard_fonts/LiberationSans-*.ttf` | `lib/pdfjs/standard_fonts/LICENSE_LIBERATION` |
| Foxit standard fonts (used by pdf.js to render non-embedded fonts) | bundled with pdf.js | BSD-style (PDFium) | `lib/pdfjs/standard_fonts/Foxit*.pfb` | `lib/pdfjs/standard_fonts/LICENSE_FOXIT` |
| Adobe CMaps (used by pdf.js) | bundled with pdf.js | BSD-3-Clause (Adobe) | `lib/pdfjs/cmaps/` | `lib/pdfjs/cmaps/LICENSE` |
| ICC colour profiles (used by pdf.js) | bundled with pdf.js | CC0 1.0 | `lib/pdfjs/iccs/` | `lib/pdfjs/iccs/LICENSE` |

Notes

- PageFix embeds a **subset** of Liberation Sans into the PDF files it produces (only for text the user adds,
  such as page numbers or watermarks). The SIL OFL 1.1 explicitly allows embedding fonts in documents.
- The PageFix logo and icons in `assets/img/` belong to the PageFix project and are covered by the project license
  (Apache-2.0) unless stated otherwise.
- PageFix itself is licensed under the Apache License 2.0 (`LICENSE`, `NOTICE`). All the components above use
  permissive licenses that are compatible with it.
