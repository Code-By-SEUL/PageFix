<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Marius SEUL – https://code-by-seul.ro/
/**
 * ============================================================
 *  PageFix – default configuration
 * ============================================================
 *  Recommended: don't edit this file for your own installation.
 *  Copy config.local.example.php to config.local.php and override only the
 *  values you need there (config.local.php is not versioned, so updating the
 *  application never overwrites your settings). config.local.php is read AFTER
 *  this file; empty values ('') in it are ignored.
 *
 *  Any text value can be a plain string or a per-language array:
 *      'tagline' => ['ro' => 'Text în română', 'en' => 'English text'],
 *  An empty value ('') is not displayed / falls back to the language default.
 * ============================================================
 */

return [

    // ---------- Application ----------
    'app' => [
        'name'       => 'PageFix',
        'version'    => '0.7.0',
        'tagline'    => [
            'ro' => 'Editor PDF în browser – fișierele nu părăsesc calculatorul tău',
            'en' => 'In-browser PDF editor – your files never leave your computer',
        ],
        'logo'       => 'assets/img/logo-96.png',   // top bar logo
        'logo_large' => 'assets/img/logo-256.png',  // logo in the About dialog
        // Favicons: assets/img/favicon.ico and favicon-*.png
    ],

    // ---------- User interface ----------
    'ui' => [
        'language'    => 'auto',  // 'ro' | 'en' | 'auto' (browser language); users can switch from the top bar
        'theme'       => 'auto',  // 'light' | 'dark' | 'auto' (follow the OS); users can switch from the top bar
        // Thumbnail size slider (status bar), in px. On large screens you can start with bigger
        // thumbnails, e.g. 'thumb_size' => 320, 'thumb_size_max' => 800.
        // Allowed range: 50 – 2000; min must be smaller than max (otherwise 110 – 420 is used);
        // the start value is kept between min and max. A size the user chose earlier with the
        // slider (remembered by the browser) takes precedence over the start value.
        'thumb_size'     => 190,     // start value
        'thumb_size_min' => 110,     // minimum
        'thumb_size_max' => 420,     // maximum
        'show_hints'  => true,    // help text in the status bar
        'preview_fit' => 'page',  // initial preview zoom: 'page' | 'width'
    ],

    // ---------- Default values in dialogs ('' = language default) ----------
    'defaults' => [
        'watermark_text'     => '',  // e.g. ['ro' => 'CONFIDENȚIAL', 'en' => 'CONFIDENTIAL']
        'page_number_format' => '',  // variables: {n}, {total}
        'header_text'        => '',  // variables: {n}, {total}, {date}, {file}
    ],
];
