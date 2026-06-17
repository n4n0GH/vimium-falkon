# ============================================================
# Vimium for Falkon - Python <-> JavaScript bridge
#
# A single QObject exposed to every page through QWebChannel.
# Its slots perform browser-level actions (tab management,
# opening URLs in new tabs, focusing the address bar) on the
# currently active Falkon window.
# ============================================================
import Falkon
from PySide6 import QtCore
from PySide6.QtCore import QUrl, Slot


def _app():
    return Falkon.MainApplication.instance()


def _window():
    """The currently active browser window (or None)."""
    app = _app()
    return app.getWindow() if app else None


def _tabs():
    w = _window()
    return w.tabWidget() if w else None


def _webview():
    w = _window()
    return w.weView() if w else None


class VimiumBridge(QtCore.QObject):
    """Exposed to page JS as the `vimium_bridge` QWebChannel object."""

    # -- tab lifecycle --------------------------------------------------
    @Slot()
    def newTab(self):
        # Empty URL + NT_NewEmptyTab opens the user's configured new-tab page.
        view = _webview()
        if view:
            view.openUrlInNewTab(QUrl(), Falkon.Qz.NT_SelectedNewEmptyTab)

    @Slot()
    def closeTab(self):
        tabs = _tabs()
        if tabs:
            tabs.closeTab(tabs.currentIndex())

    @Slot()
    def restoreTab(self):
        tabs = _tabs()
        if tabs:
            tabs.restoreClosedTab()

    @Slot()
    def duplicateTab(self):
        tabs = _tabs()
        if tabs:
            tabs.duplicateTab(tabs.currentIndex())

    # -- tab navigation -------------------------------------------------
    @Slot()
    def nextTab(self):
        tabs = _tabs()
        if tabs:
            tabs.nextTab()

    @Slot()
    def prevTab(self):
        tabs = _tabs()
        if tabs:
            tabs.previousTab()

    @Slot()
    def firstTab(self):
        tabs = _tabs()
        if tabs:
            tabs.setCurrentIndex(0)

    @Slot()
    def lastTab(self):
        tabs = _tabs()
        if tabs:
            tabs.setCurrentIndex(tabs.count() - 1)

    @Slot()
    def moveTabLeft(self):
        tabs = _tabs()
        if tabs:
            i = tabs.currentIndex()
            if i > 0:
                tabs.moveTab(i, i - 1)
                tabs.setCurrentIndex(i - 1)

    @Slot()
    def moveTabRight(self):
        tabs = _tabs()
        if tabs:
            i = tabs.currentIndex()
            if i < tabs.count() - 1:
                tabs.moveTab(i, i + 1)
                tabs.setCurrentIndex(i + 1)

    # -- navigation -----------------------------------------------------
    @Slot(str)
    def openInNewTab(self, url):
        view = _webview()
        if view and url:
            view.openUrlInNewTab(QUrl(url), Falkon.Qz.NT_NotSelectedTab)

    @Slot(str)
    def loadUrl(self, url):
        w = _window()
        if w and url:
            w.loadAddress(QUrl(url))

    @Slot()
    def focusAddressBar(self):
        w = _window()
        if not w:
            return
        try:
            bar = w.locationBar()
            if bar:
                bar.setFocus(QtCore.Qt.ShortcutFocusReason)
                if hasattr(bar, "selectAll"):
                    bar.selectAll()
        except Exception:
            pass
