<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Marius SEUL – https://code-by-seul.ro/
declare(strict_types=1);

/**
 * PageFix – inițializare: configurație, limbă, traduceri, funcții ajutătoare.
 *
 * Fișierul este inclus de index.php și NU se deschide direct din browser
 * (accesul la folderul inc/ este blocat prin inc/.htaccess).
 *
 * Ce face, în ordine:
 *   1. citește configurația (valori implicite < config.php < config.local.php);
 *   2. alege limba interfeței (cookie > config > antetul Accept-Language al browserului);
 *   3. încarcă textele traduse din lang/<cod>.json;
 *   4. pregătește datele trimise către JavaScript și lista de fișiere obligatorii.
 *
 * Date de intrare care vin de la utilizator / browser:
 *   - $_COOKIE['pagefix_lang']          (validat: acceptat doar dacă e exact un cod din LANGUAGES);
 *   - $_SERVER['HTTP_ACCEPT_LANGUAGE']   (validat la fel; se folosesc doar primele 2 caractere).
 * Restul datelor vin din fișiere locale ale aplicației (config*.php, lang/*.json).
 *
 * Fișierele PDF ale utilizatorului NU ajung niciodată pe server.
 */

// =====================================================================
//  Constante
// =====================================================================

const APP_ID    = 'pagefix';        // prefix pentru cookie-uri și chei localStorage
const LANGUAGES = ['ro', 'en'];    // limbile disponibile (lang/<cod>.json) – listă albă
const ROOT      = __DIR__ . '/..';  // folderul rădăcină al aplicației

// Autorul aplicației (subsol, fereastra „Despre” și linia de copyright).
// Valori fixe, integrate în cod: secțiunea 'author' din fișierele de configurare NU le mai modifică.
const AUTHOR_NAME  = 'by SEUL';
const AUTHOR_URL   = 'https://code-by-seul.ro/';
const AUTHOR_EMAIL = '';
const AUTHOR_YEAR  = '2026';

// Limitele absolute acceptate pentru mărimea miniaturilor (px), indiferent de configurație.
const THUMB_SIZE_LOWEST  = 50;
const THUMB_SIZE_HIGHEST = 2000;
// Valorile folosite dacă limitele din configurație sunt invalide.
const THUMB_SIZE_DEFAULT_MIN   = 110;
const THUMB_SIZE_DEFAULT_MAX   = 420;
const THUMB_SIZE_DEFAULT_START = 190;


// =====================================================================
//  Funcții ajutătoare generale
// =====================================================================

/**
 * Spune dacă o valoare de configurare este „completată”.
 *
 * Reproduce explicit regula PHP de evaluare ca boolean: următoarele valori
 * sunt considerate GOALE: null, false, 0, 0.0, '' (șir gol), '0' și [] (listă goală).
 * Orice altă valoare este considerată completată.
 */
function hasValue(mixed $value): bool
{
    if ($value === null) {
        return false;
    }
    if ($value === false) {
        return false;
    }
    if ($value === 0 || $value === 0.0) {
        return false;
    }
    if ($value === '' || $value === '0') {
        return false;
    }
    if ($value === []) {
        return false;
    }
    return true;
}

/**
 * Citește un fișier JSON local al aplicației și îl întoarce ca tablou asociativ.
 * Dacă fișierul nu poate fi citit sau nu conține un obiect JSON valid, întoarce [].
 */
function readJsonFile(string $filePath): array
{
    // Acces la sistemul de fișiere (doar citire). Dacă fișierul lipsește, PHP emite
    // un avertisment, iar funcția întoarce false.
    $fileContents = file_get_contents($filePath);
    if ($fileContents === false) {
        return [];
    }

    $decodedData = json_decode($fileContents, true);
    if (!is_array($decodedData)) {
        return [];
    }

    return $decodedData;
}


// =====================================================================
//  1. Configurație: valori implicite < config.php < config.local.php
// =====================================================================

/**
 * Îmbină două seturi de setări: valorile din $overrideConfig le înlocuiesc pe cele din $baseConfig.
 *
 * Un câmp gol ('', null sau o secțiune goală []) NU suprascrie nimic – deci un câmp
 * lăsat gol în config.local.php păstrează valoarea din config.php.
 * Secțiunile (tablouri asociative, ex. 'ui' => [...]) se îmbină recursiv, cheie cu cheie;
 * listele simple (ex. [1, 2, 3]) se înlocuiesc în întregime.
 */
function mergeConfig(array $baseConfig, array $overrideConfig): array
{
    foreach ($overrideConfig as $settingKey => $overrideValue) {
        $isEmptyOverride = ($overrideValue === '' || $overrideValue === null || $overrideValue === []);
        if ($isEmptyOverride) {
            continue; // gol = „nu schimba nimic”
        }

        $overrideIsSection = is_array($overrideValue) && !array_is_list($overrideValue);
        $baseIsSection = isset($baseConfig[$settingKey]) && is_array($baseConfig[$settingKey]);

        if ($overrideIsSection && $baseIsSection) {
            $baseConfig[$settingKey] = mergeConfig($baseConfig[$settingKey], $overrideValue);
        } else {
            $baseConfig[$settingKey] = $overrideValue;
        }
    }

    return $baseConfig;
}

// Valorile implicite încorporate (folosite dacă lipsesc din fișierele de configurare).
$config = [
    'app' => [
        'name'       => 'PageFix',
        'version'    => '0.0.0',
        'tagline'    => '',
        'logo'       => '',
        'logo_large' => '',
    ],
    'ui' => [
        'language'       => 'auto',
        'theme'          => 'auto',
        'thumb_size'     => THUMB_SIZE_DEFAULT_START,
        'thumb_size_min' => THUMB_SIZE_DEFAULT_MIN,
        'thumb_size_max' => THUMB_SIZE_DEFAULT_MAX,
        'show_hints'     => true,
        'preview_fit'    => 'page',
    ],
    'defaults' => [
        'watermark_text'     => '',
        'page_number_format' => '',
        'header_text'        => '',
    ],
];

// Fișierele de configurare citite, în ordine. Sunt fișiere PHP scrise de administrator
// (de încredere): `require` le execută, iar ele întorc un tablou cu setări.
$configFileNames = ['config.php', 'config.local.php'];

// Ce fișiere au fost efectiv citite (afișat în fereastra „Despre”).
$loadedConfigFiles = [];

foreach ($configFileNames as $configFileName) {
    $configFilePath = ROOT . '/' . $configFileName;

    if (!is_file($configFilePath)) {
        continue;
    }

    $configFromFile = require $configFilePath;

    if (is_array($configFromFile)) {
        $config = mergeConfig($config, $configFromFile);
        $loadedConfigFiles[] = $configFileName;
    }
}


// =====================================================================
//  2. Limba: cookie (butonul din interfață) > config ui.language > browser
// =====================================================================

/**
 * Alege limba interfeței. Întoarce întotdeauna un cod din LANGUAGES.
 *
 * Valorile primite de la browser (cookie, antet HTTP) sunt acceptate numai dacă
 * se potrivesc EXACT cu un cod din lista albă LANGUAGES. Codul rezultat este folosit
 * mai departe și în calea fișierului lang/<cod>.json, deci validarea previne
 * accesul la alte fișiere (path traversal).
 */
function detectLanguage(array $config): string
{
    // a) Cookie-ul setat de butonul de limbă din interfață (date de la browser).
    $languageCookieName = APP_ID . '_lang';
    $cookieLanguage = '';
    if (isset($_COOKIE[$languageCookieName])) {
        $cookieLanguage = $_COOKIE[$languageCookieName];
    }
    if (in_array($cookieLanguage, LANGUAGES, true)) {
        return $cookieLanguage;
    }

    // b) Limba din configurație ('ro', 'en' sau 'auto').
    $configuredLanguage = 'auto';
    if (isset($config['ui']['language'])) {
        $configuredLanguage = (string) $config['ui']['language'];
    }
    if (in_array($configuredLanguage, LANGUAGES, true)) {
        return $configuredLanguage;
    }

    // c) 'auto': prima limbă suportată din antetul Accept-Language trimis de browser
    //    (ex. "ro-RO,ro;q=0.9,en;q=0.8" -> se verifică pe rând "ro", "ro", "en").
    $acceptLanguageHeader = '';
    if (isset($_SERVER['HTTP_ACCEPT_LANGUAGE'])) {
        $acceptLanguageHeader = $_SERVER['HTTP_ACCEPT_LANGUAGE'];
    }
    $acceptedLanguageParts = explode(',', strtolower($acceptLanguageHeader));

    foreach ($acceptedLanguageParts as $languagePart) {
        $languageCode = substr(trim($languagePart), 0, 2);
        if (in_array($languageCode, LANGUAGES, true)) {
            return $languageCode;
        }
    }

    // d) Nimic potrivit: engleză.
    return 'en';
}

$currentLanguage = detectLanguage($config);


// =====================================================================
//  3. Traduceri (lang/<cod>.json)
// =====================================================================

// $currentLanguage a fost validat de detectLanguage(), deci calea este sigură.
$translations = readJsonFile(ROOT . '/lang/' . $currentLanguage . '.json');

if ($currentLanguage !== 'en') {
    // Cheile care lipsesc din traducerea curentă se iau din engleză.
    $englishTranslations = readJsonFile(ROOT . '/lang/en.json');
    foreach ($englishTranslations as $translationKey => $englishText) {
        if (!array_key_exists($translationKey, $translations)) {
            $translations[$translationKey] = $englishText;
        }
    }
}

// Limba și textele devin constante (nu mai pot fi modificate de restul codului).
define('CURRENT_LANGUAGE', $currentLanguage);
define('TRANSLATIONS', $translations);

/**
 * Alege forma de plural potrivită dintr-un text cu mai multe forme,
 * ex. {"one": "{n} pagină", "other": "{n} pagini"}.
 *
 * Regula (simplificată, aceeași ca în versiunile anterioare):
 *   - dacă variabila n este 1 și există forma "one" -> "one";
 *   - altfel, dacă există forma "other" -> "other";
 *   - altfel, prima formă din listă.
 */
function selectPluralForm(array $pluralForms, array $variables): string
{
    $count = 0;
    if (isset($variables['n'])) {
        $count = $variables['n'];
    }

    // Comparație non-strictă (==), ca 1, '1' și 1.0 să fie tratate la fel.
    $isSingular = ($count == 1);
    if ($isSingular && isset($pluralForms['one'])) {
        return $pluralForms['one'];
    }

    if (isset($pluralForms['other'])) {
        return $pluralForms['other'];
    }

    $firstForm = reset($pluralForms);
    return (string) $firstForm;
}

/**
 * Traduce o cheie (ex. 'top.open') în limba curentă.
 * Marcajele {nume} din text se înlocuiesc cu valorile din $variables.
 * Dacă cheia nu există, se întoarce chiar cheia (ca să se vadă ce lipsește).
 *
 * Exemplu: t('about.version', ['v' => '1.2']) -> "versiunea 1.2"
 *
 * Rezultatul NU este escapat pentru HTML – în șablon se folosește translateHtml().
 */
function t(string $key, array $variables = []): string
{
    $allTranslations = TRANSLATIONS;

    if (!isset($allTranslations[$key])) {
        return $key;
    }

    $text = $allTranslations[$key];

    if (is_array($text)) {
        $text = selectPluralForm($text, $variables);
    }

    if (count($variables) === 0) {
        return $text;
    }

    // Construiește tabela de înlocuire: '{nume}' => 'valoare'.
    $replacements = [];
    foreach ($variables as $variableName => $variableValue) {
        $placeholder = '{' . $variableName . '}';
        $replacements[$placeholder] = strval($variableValue);
    }

    return strtr($text, $replacements);
}

/**
 * O valoare de configurare care poate fi fie un text simplu, fie un tablou
 * pe limbi: ['ro' => '…', 'en' => '…'].
 * Ordinea de alegere: limba curentă > engleză > prima valoare din tablou.
 */
function localized(mixed $value): string
{
    if (!is_array($value)) {
        return (string) $value;
    }

    if (isset($value[CURRENT_LANGUAGE])) {
        return (string) $value[CURRENT_LANGUAGE];
    }

    if (isset($value['en'])) {
        return (string) $value['en'];
    }

    // reset() întoarce primul element (sau false dacă tabloul e gol; (string) false = '').
    $firstValue = reset($value);
    return (string) $firstValue;
}


// =====================================================================
//  Funcții pentru generarea HTML-ului (folosite în index.php)
// =====================================================================

/**
 * Escapează un text pentru a fi inserat în HTML (conținut sau valoare de atribut).
 * SECURITATE: orice valoare care nu este marcaj HTML fix trebuie trecută prin această funcție.
 */
function escapeHtml(mixed $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Text tradus și escapat pentru HTML. */
function translateHtml(string $key, array $variables = []): string
{
    $translatedText = t($key, $variables);
    return escapeHtml($translatedText);
}

$appConfig = $config['app'];

// Datele autorului vin din constantele de mai sus (nu din configurație).
$authorConfig = [
    'name'  => AUTHOR_NAME,
    'url'   => AUTHOR_URL,
    'email' => AUTHOR_EMAIL,
    'year'  => AUTHOR_YEAR,
];

define('APP_NAME', localized($appConfig['name']));
define('APP_VERSION', (string) $appConfig['version']);

/**
 * Numele aplicației în două culori, ca în logo: „PageFix” -> Page (roșu) + Fix (gri).
 * Dacă numele nu are forma „CuvântCuvânt”, se afișează simplu.
 * Întoarce HTML (părțile de text sunt escapate).
 */
function wordmark(string $applicationName): string
{
    // Primul cuvânt: o majusculă urmată de minuscule; restul: începe cu o majusculă.
    $nameParts = [];
    $matchResult = preg_match('/^(\p{Lu}\p{Ll}+)(\p{Lu}.*)$/u', $applicationName, $nameParts);

    if ($matchResult !== 1) {
        return escapeHtml($applicationName);
    }

    $firstPart = $nameParts[1];
    $secondPart = $nameParts[2];

    return '<span class="wm-a">' . escapeHtml($firstPart) . '</span>'
        . '<span class="wm-b">' . escapeHtml($secondPart) . '</span>';
}

/**
 * Adresa unui fișier static cu „cache busting”: se adaugă ?v=<data modificării fișierului>,
 * astfel încât browserul descarcă din nou fișierul imediat ce acesta se schimbă.
 */
function asset(string $relativePath): string
{
    $absolutePath = ROOT . '/' . $relativePath;

    if (is_file($absolutePath)) {
        // filemtime() întoarce false în caz de eroare; (string) false = ''.
        $versionToken = (string) filemtime($absolutePath);
    } else {
        $versionToken = APP_VERSION;
    }

    return $relativePath . '?v=' . $versionToken;
}

/**
 * Iconițe liniare (24×24) – definite o singură dată ca simboluri SVG în pagină
 * și refolosite atât din PHP (icon()), cât și din JavaScript.
 * Conținut fix, scris de dezvoltator (nu provine de la utilizator).
 */
const ICONS = [
    'open'      => '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'plus'      => '<path d="M12 5v14M5 12h14"/>',
    'download'  => '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
    'x'         => '<path d="M18 6 6 18M6 6l12 12"/>',
    'undo'      => '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    'redo'      => '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    'select'    => '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
    'rotl'      => '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    'rotr'      => '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    'rot180'    => '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    'trash'     => '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
    'insert'    => '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6M9 15h6"/>',
    'extract'   => '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/><path d="M13 3l6 6v3"/><path d="M13 3v6h6"/><path d="M15 18h7M19 15l3 3-3 3"/>',
    'split'     => '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
    'interleave'=> '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M15 7h4v4M9 17H5v-4"/>',
    'reverse'   => '<path d="M7 20V4M3 8l4-4 4 4"/><path d="M17 4v16M13 16l4 4 4-4"/>',
    'crop'      => '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
    'fit'       => '<rect x="5" y="2" width="14" height="20" rx="1.5"/><path d="M9 9V7h2M15 15v2h-2M9 15v2h2M15 9V7h-2"/>',
    'hash'      => '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    'header'    => '<rect x="4" y="2" width="16" height="20" rx="1.5"/><path d="M8 6h8M8 18h8"/><path d="M4 9h16M4 15h16" opacity=".35"/>',
    'stamp'     => '<rect x="4" y="2" width="16" height="20" rx="1.5"/><path d="m8 16 8-8"/><path d="M9 9.5 10.5 8M13.5 16 15 14.5" opacity=".5"/>',
    'image'     => '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    'layers'    => '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    'edit'      => '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    'eye'       => '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    'eyeoff'    => '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
    'more'      => '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    'chev'      => '<path d="m6 9 6 6 6-6"/>',
    'globe'     => '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    'mail'      => '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    'info'      => '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    'zoomin'    => '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
    'zoomout'   => '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
    'fitpage'   => '<rect x="6" y="3" width="12" height="18" rx="1.5"/><path d="M3 8V4h2M21 8V4h-2M3 16v4h2M21 16v4h-2" opacity=".6"/>',
    'sun'       => '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    'moon'      => '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    'auto'      => '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
    'fitwidth'  => '<rect x="6" y="3" width="12" height="18" rx="1.5"/><path d="M2 12h3M19 12h3M4 10l-2 2 2 2M20 10l2 2-2 2"/>',
    'help'      => '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6M12 16.8h.01"/>',
];

/** Marcajul HTML pentru o iconiță din ICONS (referință la simbolul SVG „#i-<nume>”). */
function icon(string $iconName, string $cssClass = 'ic'): string
{
    return '<svg class="' . escapeHtml($cssClass) . '" aria-hidden="true">'
        . '<use href="#i-' . escapeHtml($iconName) . '"/>'
        . '</svg>';
}

/**
 * Buton mare din panglica de instrumente (ribbon): iconiță deasupra, eticheta dedesubt.
 *
 * @param string $command           comanda JavaScript executată la click (atributul data-cmd)
 * @param string $iconName          numele iconiței din ICONS
 * @param string $labelKey          cheia de traducere a etichetei; titlul (tooltip) are cheia $labelKey . 'Title'
 * @param string $extraAttributes   atribute HTML suplimentare, fixe (ex. ' data-needsel')
 * @param string $labelSuffixHtml   marcaj HTML fix adăugat după etichetă (ex. un badge)
 */
function ribbonButton(
    string $command,
    string $iconName,
    string $labelKey,
    string $extraAttributes = '',
    string $labelSuffixHtml = ''
): string {
    $titleText = translateHtml($labelKey . 'Title');
    $labelText = translateHtml($labelKey);

    $html = '<button class="rb" data-cmd="' . escapeHtml($command) . '" title="' . $titleText . '"' . $extraAttributes . '>';
    $html .= icon($iconName);
    $html .= '<span>' . $labelText . $labelSuffixHtml . '</span>';
    $html .= '</button>';

    return $html;
}


// =====================================================================
//  4. Date pentru JavaScript și verificări
// =====================================================================

/**
 * Mărimea miniaturilor (glisorul din bara de stare): valoarea minimă, maximă și cea de pornire,
 * citite din configurație (ui.thumb_size_min, ui.thumb_size_max, ui.thumb_size) și validate:
 *   - toate se transformă în numere întregi;
 *   - min și max trebuie să fie între THUMB_SIZE_LOWEST și THUMB_SIZE_HIGHEST, iar min < max –
 *     altfel se folosesc limitele implicite (110 – 420);
 *   - valoarea de pornire se aduce în intervalul [min, max].
 */
function readThumbnailSizeSettings(array $uiConfig): array
{
    $minimumSize = THUMB_SIZE_DEFAULT_MIN;
    if (isset($uiConfig['thumb_size_min'])) {
        $minimumSize = (int) $uiConfig['thumb_size_min'];
    }

    $maximumSize = THUMB_SIZE_DEFAULT_MAX;
    if (isset($uiConfig['thumb_size_max'])) {
        $maximumSize = (int) $uiConfig['thumb_size_max'];
    }

    $minimumIsValid = $minimumSize >= THUMB_SIZE_LOWEST && $minimumSize <= THUMB_SIZE_HIGHEST;
    $maximumIsValid = $maximumSize >= THUMB_SIZE_LOWEST && $maximumSize <= THUMB_SIZE_HIGHEST;
    if (!$minimumIsValid || !$maximumIsValid || $minimumSize >= $maximumSize) {
        $minimumSize = THUMB_SIZE_DEFAULT_MIN;
        $maximumSize = THUMB_SIZE_DEFAULT_MAX;
    }

    $startSize = THUMB_SIZE_DEFAULT_START;
    if (isset($uiConfig['thumb_size'])) {
        $startSize = (int) $uiConfig['thumb_size'];
    }
    if ($startSize < $minimumSize) {
        $startSize = $minimumSize;
    }
    if ($startSize > $maximumSize) {
        $startSize = $maximumSize;
    }

    return [
        'min'   => $minimumSize,
        'max'   => $maximumSize,
        'start' => $startSize,
    ];
}

$thumbnailSizeSettings = readThumbnailSizeSettings($config['ui']);

// ---------------------------------------------------------------------
//  Manualul de utilizare (manual/<cod limbă>/index.html)
// ---------------------------------------------------------------------

// Limba în care se caută manualul dacă nu există unul în limba interfeței.
const MANUAL_FALLBACK_LANGUAGE = 'ro';

/**
 * Găsește manualul de utilizare potrivit limbii interfeței.
 *
 * Ordinea: manualul în limba curentă, apoi cel în MANUAL_FALLBACK_LANGUAGE.
 * Întoarce ['url' => adresa relativă, 'language' => limba manualului],
 * sau null dacă manualul lipsește (atunci butonul de ajutor nu se afișează).
 *
 * $languageCode provine din detectLanguage(), deci este deja un cod din lista albă LANGUAGES.
 */
function findUserManual(string $languageCode): ?array
{
    $candidateLanguages = [$languageCode];
    if ($languageCode !== MANUAL_FALLBACK_LANGUAGE) {
        $candidateLanguages[] = MANUAL_FALLBACK_LANGUAGE;
    }

    foreach ($candidateLanguages as $candidateLanguage) {
        $relativePath = 'manual/' . $candidateLanguage . '/index.html';
        if (is_file(ROOT . '/' . $relativePath)) {
            return [
                'url'      => $relativePath,
                'language' => $candidateLanguage,
            ];
        }
    }

    return null;
}

$userManual = findUserManual($currentLanguage);

// Valorile implicite din dialogurile de suprapuneri:
// valoarea din configurație (dacă e completată) sau textul implicit al limbii.
$watermarkTextDefault = localized($config['defaults']['watermark_text']);
if (!hasValue($watermarkTextDefault)) {
    $watermarkTextDefault = t('ov.defaultWatermark');
}

$pageNumberFormatDefault = localized($config['defaults']['page_number_format']);
if (!hasValue($pageNumberFormatDefault)) {
    $pageNumberFormatDefault = t('ov.fmt.pageOf');
}

$headerTextDefault = localized($config['defaults']['header_text']);

$overlayDefaults = [
    'watermark_text'     => $watermarkTextDefault,
    'page_number_format' => $pageNumberFormatDefault,
    'header_text'        => $headerTextDefault,
];

// Configurația trimisă browserului (doar ce are nevoie interfața – nimic secret).
$jsConfig = [
    'id'       => APP_ID,
    'name'     => APP_NAME,
    'version'  => APP_VERSION,
    'ui'       => $config['ui'],
    'defaults' => $overlayDefaults,
    'manualUrl' => '',   // completat mai jos, dacă manualul există
];
if ($userManual !== null) {
    $jsConfig['manualUrl'] = $userManual['url'];
}

// Textele trimise browserului + lista limbilor disponibile (pentru butonul de limbă).
$currentLocale = $currentLanguage;
if (isset($translations['_meta.locale'])) {
    $currentLocale = $translations['_meta.locale'];
}

$availableLanguages = [];
foreach (LANGUAGES as $languageCode) {
    $languageTexts = readJsonFile(ROOT . '/lang/' . $languageCode . '.json');

    $languageName = $languageCode;
    if (isset($languageTexts['_meta.name'])) {
        $languageName = $languageTexts['_meta.name'];
    }

    $languageShortName = strtoupper($languageCode);
    if (isset($languageTexts['_meta.short'])) {
        $languageShortName = $languageTexts['_meta.short'];
    }

    $availableLanguages[] = [
        'code'  => $languageCode,
        'name'  => $languageName,
        'short' => $languageShortName,
    ];
}

$jsI18n = [
    'lang'      => $currentLanguage,
    'locale'    => $currentLocale,
    'languages' => $availableLanguages,
    'dict'      => $translations,
];

// Componente terțe (afișate în fereastra „Despre”).
$thirdPartyComponents = [
    ['name' => 'pdf.js',          'version' => '6.2.108', 'license' => 'Apache 2.0',  'descriptionKey' => 'about.comp.pdfjs'],
    ['name' => 'pdf-lib',         'version' => '1.17.1',  'license' => 'MIT',         'descriptionKey' => 'about.comp.pdflib'],
    ['name' => 'JSZip',           'version' => '3.10.1',  'license' => 'MIT / GPLv3', 'descriptionKey' => 'about.comp.jszip'],
    ['name' => 'Liberation Sans', 'version' => '2.x',     'license' => 'SIL OFL 1.1', 'descriptionKey' => 'about.comp.font'],
];

// Fișiere fără de care aplicația nu poate funcționa; cele lipsă sunt afișate în pagină.
$requiredFiles = [
    'lib/pdfjs/pdf.min.js',
    'lib/pdfjs/pdf.worker.min.js',
    'lib/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
    'lib/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
    'lib/pdf-lib.min.js',
    'lib/jszip.min.js',
    'config.php',
    'lang/en.json',
    'assets/js/app.js',
    'assets/js/engine.js',
    'assets/js/ttf.js',
    'assets/js/i18n.js',
    'assets/css/app.css',
];

$missingFiles = [];
foreach ($requiredFiles as $requiredFile) {
    if (!is_file(ROOT . '/' . $requiredFile)) {
        $missingFiles[] = $requiredFile;
    }
}
