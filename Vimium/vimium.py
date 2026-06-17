# ============================================================
# Vimium for Falkon - plugin entry point
#
# Injects a Vimium-like content script into every web page and
# wires up a QWebChannel bridge so the page can ask Falkon to
# perform browser-level actions (tab management, etc.).
# ============================================================
import os

import Falkon
from PySide6 import QtCore
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEngineScript

from Vimium.bridge import VimiumBridge

PLUGIN_DIR = os.path.dirname(os.path.realpath(__file__))

# Run in a dedicated, isolated JS world so we never clash with the page,
# with Falkon's own channel (ApplicationWorld) or with window add-ons
# (MainWorld). The DOM is shared across worlds, so page navigation works.
VIMIUM_WORLD = int(QWebEngineScript.UserWorld)

SCRIPT_NAME = "_vimium_falkon"

# Connects the injected qwebchannel.js to Falkon's per-page channel and
# exposes the bridge object to vimium.js as window.__vimiumBridge.
CONNECTOR = """
(function () {
    "use strict";
    function connect() {
        if (typeof qt === "undefined" || !qt.webChannelTransport) {
            setTimeout(connect, 50);
            return;
        }
        new QWebChannel(qt.webChannelTransport, function (channel) {
            window.__vimiumBridge = channel.objects.vimium_bridge;
        });
    }
    connect();
})();
"""


def _read(name):
    with open(os.path.join(PLUGIN_DIR, name), "r", encoding="utf-8") as fh:
        return fh.read()


class VimiumPlugin(Falkon.PluginInterface, QtCore.QObject):

    bridge = None
    channels = {}

    # -- PluginInterface ------------------------------------------------
    def init(self, state, settingsPath):
        if self.bridge is None:
            self.bridge = VimiumBridge()
        self._inject_script()

        plugins = Falkon.MainApplication.instance().plugins()
        self.webPageCreated = plugins.webPageCreated
        self.webPageCreated.connect(self.on_page_created)

        # If we were loaded after the browser started, hook up the pages
        # that already exist (they pick up the content script on reload).
        if state == Falkon.PluginInterface.LateInitState:
            for window in Falkon.MainApplication.instance().windows():
                self._attach_existing(window)

    def unload(self):
        profile = Falkon.MainApplication.instance().webProfile()
        for script in profile.scripts().find(SCRIPT_NAME):
            profile.scripts().remove(script)
        try:
            self.webPageCreated.disconnect(self.on_page_created)
        except Exception:
            pass
        self.channels.clear()

    def testPlugin(self):
        return True

    # -- internals ------------------------------------------------------
    def _inject_script(self):
        profile = Falkon.MainApplication.instance().webProfile()
        for old in profile.scripts().find(SCRIPT_NAME):
            profile.scripts().remove(old)

        source = "\n".join([_read("qwebchannel.js"), CONNECTOR, _read("vimium.js")])

        script = QWebEngineScript()
        script.setName(SCRIPT_NAME)
        script.setInjectionPoint(QWebEngineScript.DocumentCreation)
        script.setWorldId(VIMIUM_WORLD)
        script.setRunsOnSubFrames(False)
        script.setSourceCode(source)
        profile.scripts().insert(script)

    def on_page_created(self, page):
        if page is None:
            return
        channel = QWebChannel(page)
        channel.registerObject("vimium_bridge", self.bridge)
        page.setWebChannel(channel, VIMIUM_WORLD)
        self.channels[page] = channel
        page.destroyed.connect(lambda *_: self.channels.pop(page, None))

    def _attach_existing(self, window):
        try:
            tabs = window.tabWidget()
            for i in range(tabs.count()):
                tab = tabs.webTab(i)
                if tab and tab.webView():
                    self.on_page_created(tab.webView().page())
        except Exception:
            pass


Falkon.registerPlugin(VimiumPlugin())
