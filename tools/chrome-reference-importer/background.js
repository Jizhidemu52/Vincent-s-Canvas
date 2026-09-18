chrome.action.onClicked.addListener(tab => {
    if (tab.id) chrome.tabs.create({ url: chrome.runtime.getURL(`collector.html?sourceTab=${tab.id}`) });
});
