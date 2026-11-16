<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Marius SEUL – https://code-by-seul.ro/
declare(strict_types=1);

/**
 * PageFix – editor PDF care rulează în întregime în browser.
 *
 * Serverul (Apache + PHP) doar livrează pagina și librăriile; fișierele PDF NU sunt
 * trimise niciodată către server. Pagina nu primește formulare și nu scrie nimic pe disc.
 *
 * Setări:  config.php (implicite, versionat) și config.local.php (setările tale, neversionat).
 * Texte:   lang/<cod>.json
 *
 * Structura fișierului:
 *   1. inițializare (inc/bootstrap.php) și anteturi HTTP;
 *   2. pregătirea valorilor folosite în șablon (toată logica stă aici);
 *   3. șablonul HTML – doar afișare.
 *
 * Notă pentru citirea șablonului: `<?= expresie ?>` este forma scurtă standard pentru
 * `<?php echo expresie; ?>`. Orice text afișat trece prin escapeHtml() / translateHtml(),
 * cu excepția marcajului HTML fix generat de icon(), ribbonButton() și wordmark().
 */

// =====================================================================
//  1. Inițializare și anteturi HTTP
// =====================================================================

require __DIR__ . '/inc/bootstrap.php';

header('Content-Type: text/html; charset=utf-8');
header('X-Content-Type-Options: nosniff');   // browserul nu „ghicește” tipul fișierelor
header('Referrer-Policy: same-origin');       // adresa paginii nu se trimite altor site-uri


// =====================================================================
//  2. Valori pregătite pentru șablon
// =====================================================================

// Opțiuni pentru json_encode() când valoarea ajunge într-un <script>:
// caracterele < > & sunt codificate, deci un text nu poate închide eticheta <script>.
$jsonOptionsForScript = JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP;

// --- Tema (aplicată înainte de afișare, ca să nu apară un „flash” alb în tema întunecată) ---
$themePreferenceJson = json_encode((string) $config['ui']['theme'], $jsonOptionsForScript);
$themeStorageKeyJson = json_encode(APP_ID . '.theme', $jsonOptionsForScript);

// --- Datele pentru JavaScript (window.APP_CONFIG și window.I18N) ---
$jsConfigJson = json_encode($jsConfig, $jsonOptionsForScript);
$jsI18nJson = json_encode($jsI18n, $jsonOptionsForScript);

// --- Butonul de limbă: arată limba în care se trece la click (următoarea din listă) ---
$currentLanguageIndex = array_search($currentLanguage, LANGUAGES, true);
$nextLanguageIndex = ($currentLanguageIndex + 1) % count(LANGUAGES);
$nextLanguage = $availableLanguages[$nextLanguageIndex];

// --- Manualul de utilizare (butonul „?” și legătura din ecranul de pornire) ---
$hasUserManual = $userManual !== null;
$userManualUrl = '';
$userManualTitle = t('top.help');
if ($hasUserManual) {
    $userManualUrl = $userManual['url'];
    // Manualul există doar în altă limbă decât interfața: se precizează limba lui.
    $languageNote = t('help.otherLanguage');
    if ($userManual['language'] !== $currentLanguage && hasValue($languageNote)) {
        $userManualTitle = $userManualTitle . ' ' . $languageNote;
    }
}

// --- Logo-uri ---
$hasTopBarLogo = hasValue($appConfig['logo']);
$hasAboutLogo = hasValue($appConfig['logo_large']);

// --- Descrierea scurtă a aplicației (fereastra „Despre”) ---
$taglineText = localized($appConfig['tagline']);
$hasTagline = hasValue($taglineText);

// --- Autor / contact (subsol și fereastra „Despre”) ---
// Valorile sunt constante în inc/bootstrap.php (AUTHOR_NAME, AUTHOR_URL, AUTHOR_EMAIL, AUTHOR_YEAR).
$hasAuthorName = hasValue($authorConfig['name']);
$hasAuthorUrl = hasValue($authorConfig['url']);
$hasAuthorEmail = hasValue($authorConfig['email']);
$hasAuthorYear = hasValue($authorConfig['year']);
$hasAnyAuthorInfo = $hasAuthorName || $hasAuthorUrl || $hasAuthorEmail;

$authorNameText = localized($authorConfig['name']);
$authorUrl = $authorConfig['url'];
$authorEmail = $authorConfig['email'];

$authorCopyrightText = '';
if ($hasAuthorYear) {
    $authorCopyrightText = ' · © ' . $authorConfig['year'];
}

// --- Bara de stare ---
$statusHintText = '';
if (hasValue($config['ui']['show_hints'])) {
    $statusHintText = t('status.hint');
}
// Glisorul pentru mărimea miniaturilor: limite și valoare de pornire (validate în bootstrap.php).
$thumbnailSizeMin = $thumbnailSizeSettings['min'];
$thumbnailSizeMax = $thumbnailSizeSettings['max'];
$thumbnailSizeStart = $thumbnailSizeSettings['start'];

// --- Fereastra „Despre”: ce fișiere de configurare au fost citite ---
$loadedConfigFilesText = implode(' + ', $loadedConfigFiles);
if (!hasValue($loadedConfigFilesText)) {
    $loadedConfigFilesText = '–';
}

// --- Dialogul de suprapuneri: formatele de numerotare, cu un exemplu („Pagina 1 din 10”) ---
$pageNumberFormatKeys = ['ov.fmt.n', 'ov.fmt.nOf', 'ov.fmt.page', 'ov.fmt.pageOf', 'ov.fmt.dash'];
$pageNumberFormatOptions = [];
foreach ($pageNumberFormatKeys as $formatKey) {
    $formatTemplate = t($formatKey);
    $formatExample = strtr($formatTemplate, ['{n}' => '1', '{total}' => '10']);
    $pageNumberFormatOptions[] = [
        'value' => $formatTemplate,
        'label' => $formatExample,
    ];
}

// --- Dialogul de suprapuneri: pozițiile pe grila 3×3 (sus/mijloc/jos × stânga/centru/dreapta) ---
$overlayPositionCodes = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];

// --- Previzualizare: nivelurile de zoom din listă (1 = 100%) ---
$previewZoomLevels = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6];
$previewZoomOptions = [];
foreach ($previewZoomLevels as $zoomLevel) {
    $zoomPercent = $zoomLevel * 100;
    $previewZoomOptions[] = [
        'value' => (string) $zoomLevel,
        'label' => (string) $zoomPercent . '%',
    ];
}


// =====================================================================
//  3. Șablonul HTML
// =====================================================================
?><!DOCTYPE html>
<html lang="<?= escapeHtml($currentLanguage) ?>">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= escapeHtml(APP_NAME) ?></title>
<meta name="application-name" content="<?= escapeHtml(APP_NAME) ?>">
<link rel="icon" href="<?= escapeHtml(asset('assets/img/favicon.ico')) ?>" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="<?= escapeHtml(asset('assets/img/favicon-32.png')) ?>">
<link rel="icon" type="image/png" sizes="192x192" href="<?= escapeHtml(asset('assets/img/favicon-192.png')) ?>">
<link rel="apple-touch-icon" href="<?= escapeHtml(asset('assets/img/favicon-180.png')) ?>">
<script>
// Tema se aplică înainte de afișare (fără „flash” alb în tema întunecată).
// Preferința: cea salvată în browser (butonul din interfață), altfel cea din configurație.
(function applyInitialTheme() {
  var themePreference = <?= $themePreferenceJson ?>;

  try {
    var storedPreference = localStorage.getItem(<?= $themeStorageKeyJson ?>);
    if (storedPreference) {
      themePreference = storedPreference;
    }
  } catch (storageError) {
    // localStorage poate fi indisponibil (ex. setări de confidențialitate) – rămâne preferința din configurație
  }

  var useDarkTheme = false;
  if (themePreference === 'dark') {
    useDarkTheme = true;
  } else if (themePreference !== 'light') {
    // 'auto': urmează setarea sistemului de operare
    if (window.matchMedia) {
      var systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (systemPrefersDark) {
        useDarkTheme = true;
      }
    }
  }

  if (useDarkTheme) {
    document.documentElement.dataset.theme = 'dark';
  } else {
    document.documentElement.dataset.theme = 'light';
  }
  document.documentElement.dataset.themePref = themePreference;
})();
</script>
<link rel="stylesheet" href="<?= escapeHtml(asset('assets/css/app.css')) ?>">
<script src="<?= escapeHtml(asset('lib/pdf-lib.min.js')) ?>"></script>
<script src="<?= escapeHtml(asset('lib/jszip.min.js')) ?>"></script>
<script>
window.APP_CONFIG = <?= $jsConfigJson ?>;
window.I18N = <?= $jsI18nJson ?>;
</script>
<script type="module" src="<?= escapeHtml(asset('assets/js/app.js')) ?>"></script>
</head>
<body class="nodoc">

<?php // Iconițele SVG – marcaj fix din constanta ICONS (inc/bootstrap.php). ?>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<?php foreach (ICONS as $iconName => $iconSvgPaths): ?>
  <symbol id="i-<?= escapeHtml($iconName) ?>" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><?= $iconSvgPaths ?></symbol>
<?php endforeach; ?>
</svg>

<?php if (count($missingFiles) > 0): ?>
<div class="fatal">
  <strong><?= translateHtml('fatal.missing') ?></strong>
  <ul>
  <?php foreach ($missingFiles as $missingFile): ?>
    <li><?= escapeHtml($missingFile) ?></li>
  <?php endforeach; ?>
  </ul>
</div>
<?php endif; ?>

<header class="topbar">
  <button class="brand" data-cmd="about" title="<?= translateHtml('top.about', ['name' => APP_NAME]) ?>">
    <?php if ($hasTopBarLogo): ?>
    <img src="<?= escapeHtml(asset($appConfig['logo'])) ?>" alt="" class="brandlogo">
    <?php endif; ?>
    <span class="wordmark"><?= wordmark(APP_NAME) ?></span>
    <small>v<?= escapeHtml(APP_VERSION) ?></small>
  </button>
  <div class="docname" id="docName" title="<?= translateHtml('top.docNameTitle') ?>" contenteditable="true" spellcheck="false">document</div>
  <div class="history">
    <button class="btn ghost icononly" data-cmd="undo" title="<?= translateHtml('top.undo') ?>"><?= icon('undo') ?></button>
    <button class="btn ghost icononly" data-cmd="redo" title="<?= translateHtml('top.redo') ?>"><?= icon('redo') ?></button>
  </div>
  <div class="spacer"></div>
  <button class="btn" data-cmd="open" title="<?= translateHtml('top.openTitle') ?>"><?= icon('open') ?> <?= translateHtml('top.open') ?></button>
  <button class="btn" data-cmd="append" title="<?= translateHtml('top.appendTitle') ?>"><?= icon('plus') ?> <?= translateHtml('top.append') ?></button>
  <button class="btn primary" data-cmd="save" title="<?= translateHtml('top.saveTitle') ?>"><?= icon('download') ?> <?= translateHtml('top.save') ?></button>
  <button class="btn ghost icononly" data-cmd="close" title="<?= translateHtml('top.close') ?>"><?= icon('x') ?></button>
  <span class="topsep"></span>
  <button class="btn ghost icononly" data-cmd="themeToggle" id="themeBtn" title="<?= translateHtml('top.theme') ?>"><?= icon('moon') ?></button>
  <?php if ($hasUserManual): ?>
  <a class="btn ghost icononly" href="<?= escapeHtml($userManualUrl) ?>" target="_blank" rel="noopener" title="<?= escapeHtml($userManualTitle) ?>"><?= icon('help') ?></a>
  <?php endif; ?>
  <button class="btn ghost langbtn" data-cmd="langToggle" title="<?= translateHtml('top.lang') ?> → <?= escapeHtml($nextLanguage['name']) ?>"><?= icon('globe') ?> <?= escapeHtml($nextLanguage['short']) ?></button>
</header>

<nav class="ribbon" id="ribbon">
  <section class="rgroup">
    <div class="rbtns">
      <?= ribbonButton('selMenu', 'select', 'rb.select', '', ' <small>▾</small><b class="badge" id="selCount" hidden>0</b>') ?>
    </div>
    <h4><?= translateHtml('grp.selection') ?></h4>
  </section>

  <section class="rgroup">
    <div class="rbtns">
      <?= ribbonButton('rotL', 'rotl', 'rb.left', ' data-needsel') ?>
      <?= ribbonButton('rotR', 'rotr', 'rb.right', ' data-needsel') ?>
      <?= ribbonButton('rot180', 'rot180', 'rb.r180', ' data-needsel') ?>
    </div>
    <h4><?= translateHtml('grp.rotate') ?></h4>
  </section>

  <section class="rgroup">
    <div class="rbtns">
      <?= ribbonButton('insert', 'insert', 'rb.insert') ?>
      <?= ribbonButton('delete', 'trash', 'rb.delete') ?>
      <?= ribbonButton('extract', 'extract', 'rb.extract') ?>
      <?= ribbonButton('split', 'split', 'rb.split') ?>
      <?= ribbonButton('interleave', 'interleave', 'rb.interleave') ?>
      <?= ribbonButton('reverse', 'reverse', 'rb.reverse') ?>
    </div>
    <h4><?= translateHtml('grp.pages') ?></h4>
  </section>

  <section class="rgroup">
    <div class="rbtns">
      <?= ribbonButton('crop', 'crop', 'rb.crop') ?>
      <?= ribbonButton('fit', 'fit', 'rb.fit') ?>
    </div>
    <h4><?= translateHtml('grp.format') ?></h4>
  </section>

  <section class="rgroup">
    <div class="rbtns">
      <?= ribbonButton('ovNum', 'hash', 'rb.num') ?>
      <?= ribbonButton('ovText', 'header', 'rb.text') ?>
      <?= ribbonButton('ovWm', 'stamp', 'rb.wm') ?>
      <?= ribbonButton('ovImg', 'image', 'rb.img') ?>
      <?= ribbonButton('layers', 'layers', 'rb.layers', '', '<b class="badge" id="layerCount" hidden>0</b>') ?>
    </div>
    <h4><?= translateHtml('grp.overlays') ?></h4>
  </section>
</nav>

<main id="main">
  <div id="scroller" class="scroller">
    <section id="empty" class="empty">
      <div class="dropzone">
        <div class="big"><?= icon('open', 'ic huge') ?></div>
        <h2><?= translateHtml('empty.title') ?></h2>
        <p><?= translateHtml('empty.or') ?> <button class="btn primary" data-cmd="open"><?= translateHtml('empty.choose') ?></button></p>
        <p class="muted"><?= translateHtml('empty.local') ?></p>
        <?php if ($hasUserManual): ?>
        <p class="emptyhelp"><?= translateHtml('empty.helpQuestion') ?> <a href="<?= escapeHtml($userManualUrl) ?>" target="_blank" rel="noopener" title="<?= escapeHtml($userManualTitle) ?>"><?= icon('help') ?> <?= translateHtml('empty.helpLink') ?></a></p>
        <?php endif; ?>
      </div>
    </section>
    <section id="grid" class="grid" hidden></section>
  </div>

  <aside id="layers" class="layers" hidden>
    <div class="lhead">
      <?= icon('layers') ?> <b><?= translateHtml('layers.title') ?></b>
      <span class="spacer"></span>
      <button class="iconbtn" data-cmd="layers" title="<?= translateHtml('layers.close') ?>"><?= icon('x') ?></button>
    </div>
    <p class="lhelp"><?= translateHtml('layers.help') ?></p>
    <div id="layerList" class="layerlist"></div>
    <div class="ladd">
      <button class="btn small" data-cmd="ovNum"><?= icon('hash') ?> <?= translateHtml('rb.num') ?></button>
      <button class="btn small" data-cmd="ovText"><?= icon('header') ?> <?= translateHtml('rb.text') ?></button>
      <button class="btn small" data-cmd="ovWm"><?= icon('stamp') ?> <?= translateHtml('rb.wm') ?></button>
      <button class="btn small" data-cmd="ovImg"><?= icon('image') ?> <?= translateHtml('rb.img') ?></button>
    </div>
  </aside>
</main>

<footer class="statusbar">
  <span id="stPages"></span>
  <span id="stSel"></span>
  <span id="stHint" class="hint muted"><?= escapeHtml($statusHintText) ?></span>
  <label class="zoom" title="<?= translateHtml('status.zoom') ?>"><?= icon('image') ?><input type="range" id="zoom" min="<?= $thumbnailSizeMin ?>" max="<?= $thumbnailSizeMax ?>" step="10" value="<?= $thumbnailSizeStart ?>"></label>
  <span class="credits">
    <button class="linkbtn" data-cmd="about" title="<?= translateHtml('credits.about') ?>"><b><?= escapeHtml(APP_NAME) ?></b> v<?= escapeHtml(APP_VERSION) ?></button>
    <?php if ($hasAuthorName): ?>
      <span class="sep">·</span> <?= translateHtml('credits.by') ?>
      <?php if ($hasAuthorUrl): ?>
        <a href="<?= escapeHtml($authorUrl) ?>" target="_blank" rel="noopener"><?= escapeHtml($authorNameText) ?></a>
      <?php else: ?>
        <?= escapeHtml($authorNameText) ?>
      <?php endif; ?>
    <?php endif; ?>
    <?php if ($hasAuthorUrl): ?>
      <a class="iconlink" href="<?= escapeHtml($authorUrl) ?>" target="_blank" rel="noopener" title="<?= escapeHtml($authorUrl) ?>"><?= icon('globe') ?></a>
    <?php endif; ?>
    <?php if ($hasAuthorEmail): ?>
      <a class="iconlink" href="mailto:<?= escapeHtml($authorEmail) ?>" title="<?= escapeHtml($authorEmail) ?>"><?= icon('mail') ?></a>
    <?php endif; ?>
  </span>
</footer>

<input type="file" id="fileOpen" accept="application/pdf,.pdf,image/*" multiple hidden>

<!-- ============ DIALOGURI ============ -->

<dialog id="dlgRange" class="dlg">
  <form method="dialog" novalidate>
    <h3><?= translateHtml('range.title') ?></h3>
    <label><?= translateHtml('range.pages') ?> <input name="range" placeholder="<?= translateHtml('range.ph') ?>" autocomplete="off"></label>
    <p class="help"><?= translateHtml('range.help') ?></p>
    <label class="radio"><input type="checkbox" name="add"> <?= translateHtml('range.add') ?></label>
    <menu><button value="cancel" class="btn ghost"><?= translateHtml('btn.cancel') ?></button><button value="ok" class="btn primary"><?= translateHtml('range.ok') ?></button></menu>
  </form>
</dialog>

<dialog id="dlgDelete" class="dlg">
  <form method="dialog" novalidate>
    <h3><?= translateHtml('del.title') ?></h3>
    <label class="radio"><input type="radio" name="mode" value="sel" checked> <?= translateHtml('del.sel') ?> (<span data-bind="selCount">0</span>)</label>
    <label class="radio"><input type="radio" name="mode" value="range"> <?= translateHtml('del.range') ?> <input name="range" placeholder="<?= translateHtml('del.rangePh') ?>"></label>
    <label class="radio"><input type="radio" name="mode" value="even"> <?= translateHtml('del.even') ?></label>
    <label class="radio"><input type="radio" name="mode" value="odd"> <?= translateHtml('del.odd') ?></label>
    <menu><button value="cancel" class="btn ghost"><?= translateHtml('btn.cancel') ?></button><button value="ok" class="btn danger"><?= translateHtml('del.ok') ?></button></menu>
  </form>
</dialog>

<dialog id="dlgInsert" class="dlg wide">
  <form method="dialog" novalidate>
    <h3><?= translateHtml('ins.title') ?></h3>
    <div class="tabs" data-tabs="what">
      <button type="button" data-tab="blank" class="active"><?= translateHtml('ins.tabBlank') ?></button>
      <button type="button" data-tab="pdf"><?= translateHtml('ins.tabPdf') ?></button>
      <button type="button" data-tab="image"><?= translateHtml('ins.tabImage') ?></button>
    </div>
    <div class="tabpane" data-pane="blank">
      <div class="row">
        <label><?= translateHtml('ins.format') ?>
          <select name="blankFormat">
            <option value="same"><?= translateHtml('ins.fmtSame') ?></option>
            <option value="A4P"><?= translateHtml('ins.A4P') ?></option><option value="A4L"><?= translateHtml('ins.A4L') ?></option>
            <option value="A3P"><?= translateHtml('ins.A3P') ?></option><option value="A5P"><?= translateHtml('ins.A5P') ?></option>
            <option value="LetterP"><?= translateHtml('ins.LetterP') ?></option>
          </select>
        </label>
        <label><?= translateHtml('ins.count') ?> <input type="number" name="blankCount" value="1" min="1" max="500"></label>
      </div>
    </div>
    <div class="tabpane" data-pane="pdf" hidden>
      <label><?= translateHtml('ins.pdfFile') ?> <input type="file" name="pdfFile" accept="application/pdf,.pdf"></label>
      <label><?= translateHtml('ins.pdfRange') ?> <input name="pdfRange" placeholder="<?= translateHtml('ins.pdfRangePh') ?>"></label>
    </div>
    <div class="tabpane" data-pane="image" hidden>
      <label><?= translateHtml('ins.images') ?> <input type="file" name="imgFiles" accept="image/*" multiple></label>
      <div class="row">
        <label><?= translateHtml('ins.pageSize') ?>
          <select name="imgFormat">
            <option value="A4"><?= translateHtml('ins.imgA4') ?></option>
            <option value="fit"><?= translateHtml('ins.imgFit') ?></option>
            <option value="same"><?= translateHtml('ins.imgSame') ?></option>
          </select>
        </label>
        <label><?= translateHtml('ins.margin') ?> <input type="number" name="imgMargin" value="10" min="0" max="100"></label>
      </div>
    </div>
    <fieldset>
      <legend><?= translateHtml('ins.position') ?></legend>
      <select name="where">
        <option value="after"><?= translateHtml('ins.after') ?></option>
        <option value="before"><?= translateHtml('ins.before') ?></option>
        <option value="start"><?= translateHtml('ins.start') ?></option>
        <option value="end"><?= translateHtml('ins.end') ?></option>
      </select>
      <input type="number" name="ref" min="1" value="1" style="max-width:6em">
    </fieldset>
    <menu><button value="cancel" class="btn ghost"><?= translateHtml('btn.cancel') ?></button><button value="ok" class="btn primary"><?= translateHtml('ins.ok') ?></button></menu>
  </form>
</dialog>

<dialog id="dlgExtract" class="dlg">
  <form method="dialog" novalidate>
    <h3><?= translateHtml('ext.title') ?></h3>
    <label><?= translateHtml('ext.pages') ?> <input name="range" placeholder="<?= translateHtml('del.rangePh') ?>"></label>
    <label><?= translateHtml('ext.name') ?> <input name="name"></label>
    <label class="radio"><input type="checkbox" name="remove"> <?= translateHtml('ext.remove') ?></label>
    <menu><button value="cancel" class="btn ghost"><?= translateHtml('btn.cancel') ?></button><button value="ok" class="btn primary"><?= translateHtml('ext.ok') ?></button></menu>
  </form>
</dialog>

<dialog id="dlgInterleave" class="dlg">
  <form method="dialog" novalidate>
    <h3><?= translateHtml('il.title') ?></h3>
    <p class="help"><?= translateHtml('il.help') ?></p>
    <label><?= translateHtml('il.file') ?> <input type="file" name="file" accept="application/pdf,.pdf"></label>
    <label class="radio"><input type="checkbox" name="reverse"> <?= translateHtml('il.reverse') ?></label>
    <label class="radio"><input type="checkbox" name="newFirst"> <?= translateHtml('il.newFirst') ?></label>
    <menu><button value="cancel" class="btn ghost"><?= translateHtml('btn.cancel') ?></button><button value="ok" class="btn primary"><?= translateHtml('il.ok') ?></button></menu>
  </form>
</dialog>

<dialog id="dlgSplit" class="dlg">
  <form method="dialog" novalidate>
    <h3><?= translateHtml('split.title') ?></h3>
    <label class="radio"><input type="radio" name="mode" value="each" checked> <?= translateHtml('split.each') ?></label>
    <label class="radio"><input type="radio" name="mode" value="every"> <?= translateHtml('split.every1') ?> <input type="number" name="n" value="2" min="1" style="max-width:5em;flex:0"> <?= translateHtml('split.every2') ?></label>
    <label class="radio"><input type="radio" name="mode" value="ranges"> <?= translateHtml('split.ranges') ?> <input name="ranges" placeholder="<?= translateHtml('split.rangesPh') ?>"></label>
    <p class="help"><?= translateHtml('split.help') ?></p>
    <label><?= translateHtml('split.prefix') ?> <input name="prefix"></label>
    <p class="help"><?= translateHtml('split.help2') ?></p>
    <menu><button value="cancel" class="btn ghost"><?= translateHtml('btn.cancel') ?></button><button value="ok" class="btn primary"><?= translateHtml('split.ok') ?></button></menu>
  </form>
</dialog>

<dialog id="dlgCrop" class="dlg xwide">
  <form method="dialog" novalidate>
    <h3><?= translateHtml('crop.title') ?></h3>
    <div class="tabs" data-tabs="cropmode">
      <button type="button" data-tab="crop" class="active"><?= translateHtml('crop.tabCrop') ?></button>
      <button type="button" data-tab="fit"><?= translateHtml('crop.tabFit') ?></button>
    </div>
    <div class="cropwrap">
      <div class="croppreview" id="cropPreview">
        <canvas></canvas>
        <div class="croprect" id="cropRect"><span class="h nw"></span><span class="h ne"></span><span class="h sw"></span><span class="h se"></span></div>
      </div>
      <div class="cropside">
        <div class="tabpane" data-pane="crop">
          <p class="help"><?= translateHtml('crop.help') ?></p>
          <div class="grid4">
            <label><?= translateHtml('crop.top') ?> <input type="number" step="0.5" min="0" name="mt" value="0"></label>
            <label><?= translateHtml('crop.bottom') ?> <input type="number" step="0.5" min="0" name="mb" value="0"></label>
            <label><?= translateHtml('crop.left') ?> <input type="number" step="0.5" min="0" name="ml" value="0"></label>
            <label><?= translateHtml('crop.right') ?> <input type="number" step="0.5" min="0" name="mr" value="0"></label>
          </div>
          <p class="help"><?= translateHtml('crop.nondestructive') ?></p>
          <button type="button" class="btn ghost" data-act="resetCrop"><?= translateHtml('crop.reset') ?></button>
        </div>
        <div class="tabpane" data-pane="fit" hidden>
          <div class="row">
            <label><?= translateHtml('crop.format') ?>
              <select name="format"><option>A4</option><option>A3</option><option>A5</option><option>Letter</option><option>Legal</option></select>
            </label>
            <label><?= translateHtml('crop.orient') ?>
              <select name="orient"><option value="auto"><?= translateHtml('crop.orientAuto') ?></option><option value="P"><?= translateHtml('crop.orientP') ?></option><option value="L"><?= translateHtml('crop.orientL') ?></option></select>
            </label>
          </div>
          <div class="row">
            <label><?= translateHtml('crop.fitMargin') ?> <input type="number" name="fitMargin" value="0" min="0" max="100" step="0.5"></label>
            <label class="radio"><input type="checkbox" name="noUpscale"> <?= translateHtml('crop.noUpscale') ?></label>
          </div>
          <p class="help"><?= translateHtml('crop.fitHelp') ?></p>
        </div>
        <fieldset>
          <legend><?= translateHtml('scope.legend') ?></legend>
          <select name="scope"><option value="sel"><?= translateHtml('scope.sel') ?></option><option value="all"><?= translateHtml('scope.all') ?></option><option value="range"><?= translateHtml('scope.range') ?></option></select>
          <input name="scopeRange" placeholder="1-5">
        </fieldset>
      </div>
    </div>
    <menu><button value="cancel" class="btn ghost"><?= translateHtml('btn.cancel') ?></button><button value="ok" class="btn primary"><?= translateHtml('btn.apply') ?></button></menu>
  </form>
</dialog>

<dialog id="dlgOverlay" class="dlg wide">
  <form method="dialog" novalidate>
    <h3 id="ovTitle"></h3>
    <div class="notice" id="ovNotice" hidden></div>

    <div class="tabpane" data-ov="num">
      <div class="row">
        <label><?= translateHtml('ov.numFormat') ?>
          <select name="numFmt">
            <?php foreach ($pageNumberFormatOptions as $formatOption): ?>
            <option value="<?= escapeHtml($formatOption['value']) ?>"><?= escapeHtml($formatOption['label']) ?></option>
            <?php endforeach; ?>
          </select>
        </label>
        <label><?= translateHtml('ov.numStart') ?> <input type="number" name="numStart" value="1"></label>
      </div>
      <label class="radio"><input type="checkbox" name="numSkipFirst"> <?= translateHtml('ov.numSkip') ?></label>
    </div>

    <div class="tabpane" data-ov="text">
      <label><?= translateHtml('ov.text.label') ?> <input name="txt" placeholder="<?= translateHtml('ov.text.ph') ?>"></label>
      <p class="help"><?= translateHtml('ov.text.help') ?></p>
    </div>

    <div class="tabpane" data-ov="wm">
      <label><?= translateHtml('ov.wm.text') ?> <input name="wmText"></label>
      <div class="row">
        <label><?= translateHtml('ov.wm.angle') ?> <input type="number" name="wmAngle" value="45" min="-90" max="90"></label>
        <label><?= translateHtml('ov.wm.opacity') ?> <input type="number" name="wmOpacity" value="20" min="1" max="100"></label>
        <label><?= translateHtml('ov.wm.size') ?> <input type="number" name="wmSize" value="0" min="0" max="400" title="<?= translateHtml('ov.wm.sizeTitle') ?>"></label>
      </div>
      <p class="help"><?= translateHtml('ov.wm.help') ?></p>
    </div>

    <div class="tabpane" data-ov="img">
      <label><?= translateHtml('ov.img.file') ?> <input type="file" name="imgFile" accept="image/*"></label>
      <p class="help" id="ovImgCurrent" hidden></p>
      <div class="row">
        <label><?= translateHtml('ov.img.width') ?> <input type="number" name="imgWidth" value="20" min="1" max="100"></label>
        <label><?= translateHtml('ov.img.opacity') ?> <input type="number" name="imgOpacity" value="100" min="1" max="100"></label>
      </div>
    </div>

    <fieldset>
      <legend><?= translateHtml('ov.appearance') ?></legend>
      <div class="row">
        <label data-hide-for="wm"><?= translateHtml('ov.pos') ?>
          <select name="pos">
            <?php foreach ($overlayPositionCodes as $positionCode): ?>
            <option value="<?= escapeHtml($positionCode) ?>"><?= translateHtml('pos.' . $positionCode) ?></option>
            <?php endforeach; ?>
          </select>
        </label>
        <label data-hide-for="wm"><?= translateHtml('ov.margin') ?> <input type="number" name="margin" value="10" min="0" max="100" step="0.5"></label>
        <label data-hide-for="img wm"><?= translateHtml('ov.size') ?> <input type="number" name="size" value="10" min="4" max="96"></label>
        <label data-hide-for="img" class="narrow"><?= translateHtml('ov.color') ?> <input type="color" name="color" value="#333333"></label>
        <label class="radio" data-hide-for="img"><input type="checkbox" name="bold"> <?= translateHtml('ov.bold') ?></label>
      </div>
    </fieldset>
    <fieldset>
      <legend><?= translateHtml('scope.legend') ?></legend>
      <select name="scope"><option value="all"><?= translateHtml('scope.all') ?></option><option value="sel"><?= translateHtml('scope.sel') ?></option><option value="range"><?= translateHtml('scope.range') ?></option></select>
      <input name="scopeRange" placeholder="2-">
    </fieldset>
    <menu>
      <button value="delete" class="btn danger-ghost" id="ovDelete" hidden><?= translateHtml('ov.delete') ?></button>
      <span class="spacer"></span>
      <button value="cancel" class="btn ghost"><?= translateHtml('btn.cancel') ?></button>
      <button value="ok" class="btn primary" id="ovOk"><?= translateHtml('ov.add') ?></button>
    </menu>
  </form>
</dialog>

<dialog id="dlgAbout" class="dlg about">
  <form method="dialog" novalidate>
    <?php if ($hasAboutLogo): ?>
    <img src="<?= escapeHtml(asset($appConfig['logo_large'])) ?>" alt="<?= escapeHtml(APP_NAME) ?>" class="aboutlogo">
    <?php endif; ?>
    <h2 class="wordmark big"><?= wordmark(APP_NAME) ?></h2>
    <p class="ver"><?= translateHtml('about.version', ['v' => APP_VERSION]) ?></p>
    <?php if ($hasTagline): ?>
    <p class="tagline"><?= escapeHtml($taglineText) ?></p>
    <?php endif; ?>
    <?php if ($hasAnyAuthorInfo): ?>
    <div class="aboutauthor">
      <?php if ($hasAuthorName): ?>
      <div><?= translateHtml('credits.by') ?> <b><?= escapeHtml($authorNameText) ?></b><?= escapeHtml($authorCopyrightText) ?></div>
      <?php endif; ?>
      <?php if ($hasAuthorUrl): ?>
      <div><?= icon('globe') ?> <a href="<?= escapeHtml($authorUrl) ?>" target="_blank" rel="noopener"><?= escapeHtml($authorUrl) ?></a></div>
      <?php endif; ?>
      <?php if ($hasAuthorEmail): ?>
      <div><?= icon('mail') ?> <a href="mailto:<?= escapeHtml($authorEmail) ?>"><?= escapeHtml($authorEmail) ?></a></div>
      <?php endif; ?>
    </div>
    <?php endif; ?>
    <p class="help center"><?= translateHtml('about.local') ?></p>
    <p class="help center cfgfiles"><?= translateHtml('about.config') ?> <code><?= escapeHtml($loadedConfigFilesText) ?></code></p>
    <details>
      <summary><?= translateHtml('about.components') ?></summary>
      <table class="comps">
        <?php foreach ($thirdPartyComponents as $component): ?>
        <tr><td><b><?= escapeHtml($component['name']) ?></b> <?= escapeHtml($component['version']) ?></td><td><?= translateHtml($component['descriptionKey']) ?></td><td class="muted"><?= escapeHtml($component['license']) ?></td></tr>
        <?php endforeach; ?>
      </table>
    </details>
    <menu><button value="cancel" class="btn primary"><?= translateHtml('btn.close') ?></button></menu>
  </form>
</dialog>

<dialog id="dlgPreview" class="preview">
  <div class="pvbar">
    <button class="tb" data-pv="prev" title="<?= translateHtml('pv.prev') ?>">◀</button>
    <span id="pvLabel"></span>
    <button class="tb" data-pv="next" title="<?= translateHtml('pv.next') ?>">▶</button>
    <span class="spacer"></span>
    <div class="pvzoom">
      <button class="tb" data-pv="zoomOut" title="<?= translateHtml('pv.zoomOut') ?>"><?= icon('zoomout') ?></button>
      <select id="pvZoomSel" title="<?= translateHtml('pv.zoomSel') ?>">
        <option value="page"><?= translateHtml('pv.optPage') ?></option>
        <option value="width"><?= translateHtml('pv.optWidth') ?></option>
        <?php foreach ($previewZoomOptions as $zoomOption): ?>
        <option value="<?= escapeHtml($zoomOption['value']) ?>"><?= escapeHtml($zoomOption['label']) ?></option>
        <?php endforeach; ?>
        <option value="custom" hidden></option>
      </select>
      <button class="tb" data-pv="zoomIn" title="<?= translateHtml('pv.zoomIn') ?>"><?= icon('zoomin') ?></button>
      <button class="tb" data-pv="fitPage" title="<?= translateHtml('pv.fitPage') ?>"><?= icon('fitpage') ?></button>
      <button class="tb" data-pv="fitWidth" title="<?= translateHtml('pv.fitWidth') ?>"><?= icon('fitwidth') ?></button>
    </div>
    <span class="pvsep"></span>
    <button class="tb" data-pv="rotL" title="<?= translateHtml('pv.rotL') ?>"><?= icon('rotl') ?></button>
    <button class="tb" data-pv="rotR" title="<?= translateHtml('pv.rotR') ?>"><?= icon('rotr') ?></button>
    <button class="tb" data-pv="del" title="<?= translateHtml('pv.delTitle') ?>"><?= icon('trash') ?> <?= translateHtml('pv.del') ?></button>
    <button class="tb" data-pv="close" title="<?= translateHtml('pv.close') ?>"><?= icon('x') ?></button>
  </div>
  <div class="pvbody" id="pvBody"><canvas id="pvCanvas"></canvas></div>
  <div class="pvhint"><?= translateHtml('pv.hint') ?></div>
</dialog>

<div id="menu" class="ctxmenu" hidden></div>
<div id="busy" class="busy" hidden><div class="spinner"></div><div id="busyMsg"><?= translateHtml('busy.default') ?></div></div>
<div id="toasts" class="toasts"></div>

</body>
</html>
