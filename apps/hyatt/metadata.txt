// ==UserScript==
// @name         Hyatt Card Elite Night Tracker for Chase
// @namespace    https://github.com/robo-tools/ink-tracker
// @version      1.1.2
// @description  Tracks World of Hyatt personal and business card spend toward elite-night thresholds locally.
// @author       Robo (@robo77 on Discord)
// @homepageURL  https://github.com/robo-tools/ink-tracker
// @supportURL   https://github.com/robo-tools/ink-tracker/issues
// @updateURL    https://robo-tools.github.io/ink-tracker/hyatt-tracker.meta.js
// @downloadURL  https://robo-tools.github.io/ink-tracker/hyatt-tracker.user.js
// @match        https://secure.chase.com/*
// @run-at       document-start
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.getResourceText
// @grant        unsafeWindow
// @resource     CHASE_TRACKER_PDFJS https://robo-tools.github.io/ink-tracker/vendor/pdf-5.6.205.min.mjs
// @resource     CHASE_TRACKER_PDFJS_WORKER https://robo-tools.github.io/ink-tracker/vendor/pdf.worker-5.6.205.min.mjs
// @noframes
// ==/UserScript==
