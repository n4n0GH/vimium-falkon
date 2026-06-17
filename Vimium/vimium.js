/* ============================================================
 * Vimium for Falkon - in-page content script
 *
 * Runs in an isolated JavaScript world. Handles all page-level
 * keyboard navigation (scrolling, link hints, find, etc.) and
 * delegates browser-level actions (tabs, new-tab navigation) to
 * the Python side through window.__vimiumBridge (a QWebChannel
 * object wired up by the connector that runs before this script).
 * ============================================================ */
(function () {
    "use strict";

    // Guard against double injection (e.g. same world, multiple inserts).
    if (window.__vimiumLoaded) return;
    window.__vimiumLoaded = true;

    // --- bridge helpers -----------------------------------------------------
    function bridge() { return window.__vimiumBridge || null; }
    function call(method, arg) {
        var b = bridge();
        if (!b || typeof b[method] !== "function") return;
        try { arg === undefined ? b[method]() : b[method](arg); } catch (e) { /* ignore */ }
    }

    // --- small state machine ------------------------------------------------
    var Mode = { NORMAL: "normal", INSERT: "insert", HINTS: "hints", FIND: "find" };
    var mode = Mode.NORMAL;
    var pending = "";          // multi-key prefix buffer (e.g. "g", "y")
    var pendingTimer = null;

    function clearPending() {
        pending = "";
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    }
    function setPending(p) {
        pending = p;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(clearPending, 1000);
    }

    // --- scrolling ----------------------------------------------------------
    function scroller() {
        // Pick the scrolling root that actually scrolls.
        var el = document.scrollingElement || document.documentElement || document.body;
        return el;
    }
    function scrollBy(x, y) { window.scrollBy({ left: x, top: y, behavior: "auto" }); }
    function scrollToTop() { window.scrollTo(0, 0); }
    function scrollToBottom() { window.scrollTo(0, scroller().scrollHeight); }
    function halfPage() { return Math.max(window.innerHeight / 2, 100); }

    // Continuous "hold to scroll". We drive scrolling from our own animation
    // loop instead of relying on the OS key-repeat, whose initial delay caused
    // a visible stutter before repeats kicked in. keydown starts the loop,
    // keyup stops it; a short idle watchdog stops it if a keyup is ever missed.
    var heldScroll = {};          // key -> { dir: [dx, dy], t: lastSeen }
    var scrollRAF = null;
    var SCROLL_SPEED = 20;        // px per frame while held
    var SCROLL_TAP = 55;          // px for the initial responsive step on a tap
    var SCROLL_IDLE = 300;        // ms without a keydown before we stop (safety)
    function scrollLoop() {
        var now = Date.now(), dx = 0, dy = 0, any = false;
        for (var k in heldScroll) {
            if (now - heldScroll[k].t > SCROLL_IDLE) { delete heldScroll[k]; continue; }
            dx += heldScroll[k].dir[0]; dy += heldScroll[k].dir[1]; any = true;
        }
        if (any && (dx || dy)) {
            window.scrollBy(dx * SCROLL_SPEED, dy * SCROLL_SPEED);
            scrollRAF = requestAnimationFrame(scrollLoop);
        } else {
            scrollRAF = null;
        }
    }
    function startScroll(key, dir) {
        var fresh = !heldScroll[key];
        heldScroll[key] = { dir: dir, t: Date.now() };   // refresh on auto-repeat too
        if (fresh) window.scrollBy(dir[0] * SCROLL_TAP, dir[1] * SCROLL_TAP);
        if (!scrollRAF) scrollRAF = requestAnimationFrame(scrollLoop);
    }
    function stopScroll(key) { delete heldScroll[key]; }
    function stopAllScroll() { heldScroll = {}; }

    // --- editable detection -------------------------------------------------
    function isEditable(el) {
        if (!el) return false;
        var tag = (el.tagName || "").toLowerCase();
        if (tag === "input") {
            var t = (el.type || "text").toLowerCase();
            return ["text", "search", "email", "url", "password", "tel", "number",
                    "date", "datetime-local", "month", "week", "time"].indexOf(t) !== -1;
        }
        if (tag === "textarea" || tag === "select") return true;
        if (el.isContentEditable) return true;
        return false;
    }

    // ======================================================================
    //  HUD (small status indicator)
    // ======================================================================
    var hud = null, hudTimer = null;
    function showHud(text, persist) {
        if (!hud) {
            hud = document.createElement("div");
            hud.style.cssText =
                "position:fixed;bottom:0;right:0;z-index:2147483647;" +
                "background:#1b1b1b;color:#fff;font:12px/1.6 monospace;" +
                "padding:3px 8px;border-top-left-radius:4px;border:1px solid #555;" +
                "border-right:none;border-bottom:none;pointer-events:none;opacity:.95;";
        }
        hud.textContent = text;
        if (document.body && hud.parentNode !== document.body) document.body.appendChild(hud);
        if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
        if (!persist) hudTimer = setTimeout(hideHud, 1500);
    }
    function hideHud() {
        if (hud && hud.parentNode) hud.parentNode.removeChild(hud);
        if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
    }

    // ======================================================================
    //  Link hints (f / F)
    // ======================================================================
    var HINT_CHARS = "sadfjklewcmpgh";
    var hintState = null; // { items:[{el,label,marker}], typed:"", newTab:bool }

    function clickableSelector() {
        return "a[href], button, input:not([type=hidden]), textarea, select, " +
               "[onclick], [role=button], [role=link], [tabindex], [contenteditable], " +
               "summary, label[for]";
    }

    function isVisible(el) {
        var r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth)
            return false;
        var s = window.getComputedStyle(el);
        if (s.visibility === "hidden" || s.display === "none" || parseFloat(s.opacity) === 0)
            return false;
        return true;
    }

    function genLabels(n) {
        // Generate short, mostly-unique labels using HINT_CHARS.
        var chars = HINT_CHARS.split("");
        if (n <= chars.length) return chars.slice(0, n);
        var labels = [], len = Math.ceil(Math.log(n) / Math.log(chars.length));
        function build(prefix, depth) {
            if (depth === 0) { labels.push(prefix); return; }
            for (var i = 0; i < chars.length && labels.length < n; i++)
                build(prefix + chars[i], depth - 1);
        }
        build("", len);
        return labels.slice(0, n);
    }

    function enterHints(newTab) {
        var els = Array.prototype.slice.call(document.querySelectorAll(clickableSelector()))
            .filter(isVisible);
        if (!els.length) return;
        var labels = genLabels(els.length);
        var container = document.createElement("div");
        container.id = "__vimium_hints";
        container.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;";
        var items = [];
        for (var i = 0; i < els.length; i++) {
            var r = els[i].getBoundingClientRect();
            var marker = document.createElement("div");
            marker.textContent = labels[i].toUpperCase();
            marker.style.cssText =
                "position:absolute;z-index:2147483647;" +
                "left:" + (r.left + window.scrollX) + "px;" +
                "top:" + (r.top + window.scrollY) + "px;" +
                "background:linear-gradient(#fff785,#ffc542);color:#302505;" +
                "font:bold 11px/1.2 monospace;padding:1px 3px;border:1px solid #c38a22;" +
                "border-radius:3px;box-shadow:0 2px 4px rgba(0,0,0,.3);white-space:nowrap;";
            container.appendChild(marker);
            items.push({ el: els[i], label: labels[i], marker: marker });
        }
        (document.body || document.documentElement).appendChild(container);
        hintState = { items: items, typed: "", newTab: !!newTab, container: container };
        mode = Mode.HINTS;
        showHud(newTab ? "hints (new tab)" : "hints", true);
    }

    function exitHints() {
        if (hintState && hintState.container && hintState.container.parentNode)
            hintState.container.parentNode.removeChild(hintState.container);
        hintState = null;
        mode = Mode.NORMAL;
        hideHud();
    }

    function activateHint(item) {
        var el = item.el, newTab = hintState.newTab;
        exitHints();
        var href = el.getAttribute && el.getAttribute("href");
        if (newTab && href) {
            // Resolve relative URLs against the document.
            var url = el.href || href;
            call("openInNewTab", url);
            return;
        }
        if (isEditable(el)) { el.focus(); return; }
        // Prefer a real click so JS handlers fire.
        if (typeof el.click === "function") el.click();
        else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }

    function hintsKey(e) {
        var k = e.key;
        if (k === "Escape") { exitHints(); return; }
        if (k === "Backspace") {
            hintState.typed = hintState.typed.slice(0, -1);
        } else if (HINT_CHARS.indexOf(k.toLowerCase()) !== -1) {
            hintState.typed += k.toLowerCase();
        } else {
            return;
        }
        var typed = hintState.typed, matches = [];
        hintState.items.forEach(function (it) {
            var on = it.label.indexOf(typed) === 0;
            it.marker.style.display = on ? "" : "none";
            if (on) {
                // highlight the typed portion
                var lbl = it.label.toUpperCase();
                it.marker.innerHTML = "<span style='opacity:.4'>" +
                    lbl.slice(0, typed.length) + "</span>" + lbl.slice(typed.length);
                matches.push(it);
            }
        });
        if (matches.length === 1 && matches[0].label === typed) activateHint(matches[0]);
        else if (matches.length === 0) exitHints();
    }

    // ======================================================================
    //  Find (/ , n , N)
    // ======================================================================
    var findBar = null, findQuery = "", lastQuery = "";

    function enterFind() {
        mode = Mode.FIND;
        findQuery = "";
        if (!findBar) {
            findBar = document.createElement("div");
            findBar.id = "__vimium_find";
            findBar.style.cssText =
                "position:fixed;bottom:0;left:0;z-index:2147483647;background:#1b1b1b;" +
                "color:#fff;font:13px/1.6 monospace;padding:4px 8px;border-top-right-radius:4px;" +
                "border:1px solid #555;border-left:none;border-bottom:none;min-width:240px;";
        }
        if (document.body && findBar.parentNode !== document.body) document.body.appendChild(findBar);
        updateFindBar();
    }

    function updateFindBar() {
        if (findBar) findBar.textContent = "/" + findQuery;
    }

    function closeFind() {
        if (findBar && findBar.parentNode) findBar.parentNode.removeChild(findBar);
        mode = Mode.NORMAL;
    }

    function runFind(query, backwards) {
        if (!query) return;
        lastQuery = query;
        try { window.find(query, false, !!backwards, true, false, true, false); }
        catch (e) { /* window.find unsupported */ }
    }

    // We build the query from our own key handling rather than focusing a real
    // <input>. Focusing an input and then removing it left the page without a
    // focused frame in QtWebEngine, so no key events registered until the view
    // was re-focused (e.g. by switching tabs) -- which also broke n/N afterward.
    function findKey(e) {
        var k = e.key;
        if (k === "Escape") { closeFind(); return; }
        if (k === "Enter") { var q = findQuery; closeFind(); runFind(q, false); return; }
        if (k === "Backspace") { findQuery = findQuery.slice(0, -1); updateFindBar(); return; }
        if (k.length === 1) { findQuery += k; updateFindBar(); }
    }

    // ======================================================================
    //  Help overlay (?)
    // ======================================================================
    var helpBox = null;
    var HELP = [
        ["j / k", "Scroll down / up"],
        ["h / l", "Scroll left / right"],
        ["d / u", "Scroll half page down / up"],
        ["gg / G", "Scroll to top / bottom"],
        ["f / F", "Hint: open link (current / new tab)"],
        ["gi", "Focus first text input"],
        ["r", "Reload page"],
        ["yy", "Copy current URL"],
        ["p / P", "Open clipboard URL (current / new tab)"],
        ["/ , n / N", "Find, next / previous match"],
        ["o", "Open URL bar (vomnibar)"],
        ["H / L", "History back / forward"],
        ["t / x / X", "New tab / close / restore tab"],
        ["J / K", "Previous / next tab"],
        ["g0 / g$", "First / last tab"],
        ["yt", "Duplicate tab"],
        ["i", "Insert mode (Esc to leave)"],
        ["?", "Toggle this help"]
    ];
    function toggleHelp() {
        if (helpBox) { helpBox.remove(); helpBox = null; return; }
        helpBox = document.createElement("div");
        helpBox.style.cssText =
            "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;" +
            "background:#222;color:#eee;font:13px/1.7 monospace;padding:16px 22px;border-radius:8px;" +
            "border:1px solid #555;box-shadow:0 8px 30px rgba(0,0,0,.5);max-height:80vh;overflow:auto;";
        var html = "<div style='font-weight:bold;margin-bottom:8px;font-size:15px'>Vimium for Falkon</div>" +
            "<table style='border-collapse:collapse'>";
        HELP.forEach(function (row) {
            html += "<tr><td style='color:#ffd866;padding:1px 14px 1px 0;white-space:nowrap'>" +
                row[0] + "</td><td>" + row[1] + "</td></tr>";
        });
        html += "</table><div style='margin-top:8px;opacity:.6'>Press Esc or ? to close</div>";
        helpBox.innerHTML = html;
        (document.body || document.documentElement).appendChild(helpBox);
    }
    function closeHelp() { if (helpBox) { helpBox.remove(); helpBox = null; } }

    // ======================================================================
    //  Clipboard helpers
    // ======================================================================
    function copyUrl() {
        var url = location.href;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () { showHud("Yanked URL"); },
                                                    function () { fallbackCopy(url); });
        } else { fallbackCopy(url); }
    }
    function fallbackCopy(text) {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.cssText = "position:fixed;top:-1000px;";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); showHud("Yanked URL"); } catch (e) {}
        ta.remove();
    }
    function pasteUrl(newTab) {
        function open(text) {
            text = (text || "").trim();
            if (!text) return;
            if (!/^[a-z]+:\/\//i.test(text) && !/^(about:|falkon:)/i.test(text)) {
                // treat bare text as a search / host
                text = text.indexOf(".") !== -1 && text.indexOf(" ") === -1
                    ? "http://" + text
                    : "https://duckduckgo.com/?q=" + encodeURIComponent(text);
            }
            call(newTab ? "openInNewTab" : "loadUrl", text);
        }
        if (navigator.clipboard && navigator.clipboard.readText)
            navigator.clipboard.readText().then(open, function () { showHud("Clipboard blocked"); });
        else showHud("Clipboard unavailable");
    }

    // ======================================================================
    //  Normal-mode command dispatch
    // ======================================================================
    function handleNormal(e) {
        var k = e.key;

        // Two-key sequences -------------------------------------------------
        if (pending === "g") {
            clearPending();
            switch (k) {
                case "g": scrollToTop(); return true;
                case "i": focusFirstInput(); return true;
                case "0": call("firstTab"); return true;
                case "$": call("lastTab"); return true;
                default: return false;
            }
        }
        if (pending === "y") {
            clearPending();
            switch (k) {
                case "y": copyUrl(); return true;
                case "t": call("duplicateTab"); showHud("Duplicated tab"); return true;
                default: return false;
            }
        }

        // Prefixes ----------------------------------------------------------
        if (k === "g") { setPending("g"); return true; }
        if (k === "y") { setPending("y"); return true; }

        // Single keys -------------------------------------------------------
        switch (k) {
            case "j": startScroll("j", [0, 1]); return true;
            case "k": startScroll("k", [0, -1]); return true;
            case "h": startScroll("h", [-1, 0]); return true;
            case "l": startScroll("l", [1, 0]); return true;
            case "d": scrollBy(0, halfPage()); return true;
            case "u": scrollBy(0, -halfPage()); return true;
            case "G": scrollToBottom(); return true;
            case "r": location.reload(); return true;
            case "f": enterHints(false); return true;
            case "F": enterHints(true); return true;
            case "/": enterFind(); return true;
            case "n": runFind(lastQuery, false); return true;
            case "N": runFind(lastQuery, true); return true;
            case "o": call("focusAddressBar"); return true;
            case "H": history.back(); return true;
            case "L": history.forward(); return true;
            case "t": call("newTab"); return true;
            case "x": call("closeTab"); return true;
            case "X": call("restoreTab"); return true;
            case "J": call("prevTab"); return true;
            case "K": call("nextTab"); return true;
            case "p": pasteUrl(false); return true;
            case "P": pasteUrl(true); return true;
            case "i": mode = Mode.INSERT; showHud("-- INSERT -- (Esc to exit)", true); return true;
            case "?": toggleHelp(); return true;
            default: return false;
        }
    }

    function focusFirstInput() {
        var inputs = document.querySelectorAll(
            "input[type=text], input[type=search], input[type=email], input[type=url], " +
            "input:not([type]), textarea, [contenteditable]");
        for (var i = 0; i < inputs.length; i++) {
            if (isVisible(inputs[i])) { inputs[i].focus(); return; }
        }
    }

    // ======================================================================
    //  Master key listener (capture phase, before the page)
    // ======================================================================
    function onKeyDown(e) {
        // Never interfere with modified shortcuts (Ctrl/Alt/Meta).
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        // Help overlay swallows keys.
        if (helpBox) {
            if (e.key === "Escape" || e.key === "?") { closeHelp(); e.preventDefault(); e.stopPropagation(); }
            return;
        }

        if (mode === Mode.HINTS) {
            hintsKey(e);
            e.preventDefault(); e.stopPropagation();
            return;
        }

        if (mode === Mode.FIND) {
            findKey(e);
            e.preventDefault(); e.stopPropagation();
            return;
        }

        var active = document.activeElement;
        var editing = isEditable(active);

        if (mode === Mode.INSERT || editing) {
            // In a field: only Escape returns control to normal mode.
            if (e.key === "Escape") {
                if (active && typeof active.blur === "function") active.blur();
                mode = Mode.NORMAL;
                clearPending();
                hideHud();
            }
            return;
        }

        if (e.key === "Escape") { clearPending(); hideHud(); return; }

        if (handleNormal(e)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    // Releasing a held scroll key stops the continuous-scroll loop.
    function onKeyUp(e) {
        if (heldScroll[e.key]) stopScroll(e.key);
    }

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", stopAllScroll);
})();
