chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "open-reader" || !message.payload) {
    return false;
  }

  const readerId = crypto.randomUUID();
  const storageKey = `reader:${readerId}`;

  chrome.storage.local
    .set({
      [storageKey]: {
        ...message.payload,
        savedAt: new Date().toISOString(),
        sourceTabId: sender.tab?.id ?? null
      }
    })
    .then(() => {
      const readerUrl = chrome.runtime.getURL(`reader.html?id=${encodeURIComponent(readerId)}`);
      return chrome.tabs.create({ url: readerUrl });
    })
    .then((tab) => {
      sendResponse({ ok: true, tabId: tab.id ?? null });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});