<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Marius SEUL – https://code-by-seul.ro/
/**
 * PageFix – local settings (example)
 *
 * Copy this file to config.local.php and keep only the keys you want to change.
 * config.local.php is ignored by git, so your settings survive application updates.
 * Empty values ('') do not override config.php.
 *
 * RO: Copiază acest fișier ca config.local.php și păstrează doar cheile pe care vrei
 *     să le schimbi. config.local.php nu ajunge pe GitHub și nu e suprascris la actualizări.
 */

return [
    'ui' => [
        'language' => 'ro',     // 'ro' | 'en' | 'auto'
        'theme'    => 'auto',   // 'light' | 'dark' | 'auto'
        // thumbnails on a large screen: start bigger, allow bigger
        // 'thumb_size'     => 320,
        // 'thumb_size_min' => 110,
        // 'thumb_size_max' => 800,
    ],
    // 'defaults' => [
    //     'watermark_text' => ['ro' => 'CONFIDENȚIAL', 'en' => 'CONFIDENTIAL'],
    // ],
];
