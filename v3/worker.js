/* Copyright (C) 2014-2026 InBasic
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.

 * Home: https://webextension.org/listing/bulk-media-downloader.html
 * GitHub: https://github.com/inbasic/bulk-media-downloader/
 */

'use strict';

const BUFFER_LIMIT = 2000;

const buffer = {
  // writes are serialized so concurrent network events never overwrite each other
  chain: Promise.resolve(),
  push(item) {
    buffer.chain = buffer.chain.then(async () => {
      const {items = []} = await chrome.storage.local.get({
        items: []
      });
      if (items.some(o => o.url === item.url)) {
        return;
      }
      items.push(item);
      if (items.length > BUFFER_LIMIT) {
        items.splice(0, items.length - BUFFER_LIMIT);
      }
      await chrome.storage.local.set({items});
    }).catch(() => {});
    return buffer.chain;
  },
  async read() {
    const {items = []} = await chrome.storage.local.get({
      items: []
    });
    return items;
  },
  async replace(items) {
    await chrome.storage.local.set({items});
  }
};

// network capture that runs in the background worker whether the grabber
// window is open or not; items are persisted so nothing is lost
const capture = {
  observe(d) {
    if (d.tabId === -1) {
      return;
    }

    let type = d.responseHeaders.filter(o => o.name === 'content-type' || o.name === 'Content-Type');
    if (type.length === 0) {
      return;
    }
    type = type[0].value;

    const length = d.responseHeaders
      .filter(o => o.name === 'content-length' || o.name === 'Content-Length')
      .map(l => l.value).shift();

    const disposition = d.responseHeaders
      .filter(o => o.name === 'content-disposition' || o.name === 'Content-Disposition')
      .map(o => o.value)
      .shift();

    const isHls = type.startsWith('application/vnd.apple.mpegurl') ||
      type.startsWith('application/x-mpegurl') || /\.m3u8(\?|$)/i.test(d.url);
    const isDash = type.startsWith('application/dash+xml') || /\.mpd(\?|$)/i.test(d.url);

    const media = type.startsWith('image') ||
      type.startsWith('video') ||
      type.startsWith('audio') ||
      isHls ||
      isDash ||
      (type.startsWith('application') && type.indexOf('javascript') === -1);

    if (media === false) {
      return;
    }

    buffer.push({
      id: d.requestId,
      url: d.url,
      type,
      tabId: d.tabId,
      timeStamp: d.timeStamp,
      method: d.method,
      length,
      disposition,
      hls: isHls,
      dash: isDash
    });
  },
  activate() {
    chrome.webRequest.onHeadersReceived.removeListener(capture.observe);
    chrome.webRequest.onHeadersReceived.addListener(capture.observe, {
      urls: ['*://*/*']
    }, ['responseHeaders']);
  },
  deactivate() {
    chrome.webRequest.onHeadersReceived.removeListener(capture.observe);
  }
};
capture.activate();

// minimal HLS (m3u8) parser and downloader; produces a single .ts file
const hls = {
  async fetchText(url) {
    const r = await fetch(url, {
      credentials: 'include'
    });
    if (r.ok === false) {
      throw new Error('HTTP ' + r.status + ' while fetching the manifest');
    }
    const type = r.headers.get('content-type') || '';
    if (type.startsWith('text/html')) {
      throw new Error('manifest request returned an HTML page');
    }
    return r.text();
  },
  parse(text, base) {
    const lines = text.split(/\r?\n/);
    const out = {
      segments: [],
      variants: [],
      map: null,
      encrypted: false,
      isLive: false,
      isMaster: false
    };
    let sawEndList = false;
    let sawInf = false;
    let cursor = 0;
    let pendingByteRange = null;

    for (let line of lines) {
      line = line.trim();
      if (line === '' || line.startsWith('#EXTM3U')) {
        continue;
      }
      if (line.startsWith('#EXT-X-ENDLIST')) {
        sawEndList = true;
        continue;
      }
      if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
        out.encrypted = true;
        continue;
      }
      if (line.startsWith('#EXT-X-MAP:')) {
        const uri = /URI="([^"]+)"/.exec(line);
        if (uri) {
          out.map = new URL(uri[1], base).href;
        }
        continue;
      }
      if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const spec = line.substring(line.indexOf(':') + 1).split('@');
        pendingByteRange = {
          length: parseInt(spec[0], 10),
          offset: spec.length > 1 ? parseInt(spec[1], 10) : null
        };
        continue;
      }
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        out.isMaster = true;
        continue;
      }
      if (line.startsWith('#EXTINF:')) {
        sawInf = true;
        continue;
      }
      if (line.startsWith('#')) {
        continue;
      }
      const absolute = new URL(line, base).href;
      if (out.isMaster) {
        out.variants.push(absolute);
      }
      else {
        const seg = {url: absolute};
        if (pendingByteRange) {
          if (pendingByteRange.offset === null) {
            pendingByteRange.offset = cursor;
          }
          seg.range = pendingByteRange;
          pendingByteRange = null;
        }
        cursor = seg.range ? seg.range.offset + seg.range.length : 0;
        out.segments.push(seg);
      }
    }
    out.isLive = sawInf && !sawEndList;
    return out;
  },
  async resolve(url) {
    let parsed = hls.parse(await hls.fetchText(url), url);
    if (parsed.variants.length) {
      // prefer the first (usually highest quality) media playlist
      const variant = parsed.variants[0];
      parsed = hls.parse(await hls.fetchText(variant), variant);
    }
    return parsed;
  }
};

const hlsJobs = {
  queue: [],
  busy: false,
  add(job) {
    hlsJobs.queue.push(job);
    hlsJobs.next();
  },
  next() {
    if (hlsJobs.busy) {
      return;
    }
    const job = hlsJobs.queue.shift();
    if (job) {
      hlsJobs.run(job);
    }
  },
  async run(job) {
    hlsJobs.busy = true;
    const report = (status, extra = {}) => chrome.runtime.sendMessage({
      panel: 'hls-progress',
      id: job.id,
      status,
      ...extra
    }).catch(() => {});

    report('running', {done: 0, total: 0});
    try {
      const parsed = await hls.resolve(job.url);
      if (parsed.encrypted) {
        throw new Error('encrypted stream (EXT-X-KEY) is not supported');
      }
      if (parsed.isLive) {
        throw new Error('live stream without EXT-X-ENDLIST is not supported');
      }
      const parts = [];
      if (parsed.map) {
        parts.push({url: parsed.map});
      }
      parts.push(...parsed.segments);
      if (parts.length === 0) {
        throw new Error('no media segments found in the manifest');
      }
      const chunks = [];
      for (let i = 0; i < parts.length; i += 1) {
        const seg = parts[i];
        const options = {
          credentials: 'include'
        };
        if (seg.range) {
          options.headers = {
            Range: 'bytes=' + seg.range.offset + '-' + (seg.range.offset + seg.range.length - 1)
          };
        }
        const r = await fetch(seg.url, options);
        if (r.ok === false && r.status !== 206) {
          throw new Error('HTTP ' + r.status + ' while fetching segment ' + (i + 1));
        }
        chunks.push(await r.arrayBuffer());
        report('running', {done: i + 1, total: parts.length});
      }
      const blob = new Blob(chunks, {type: 'video/mp2t'});
      const filename = (job.filename || 'video').replace(/\.[a-z0-9]{2,5}$/i, '') + '.ts';
      const objectUrl = URL.createObjectURL(blob);
      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename: 'hls/' + filename.replace(/[\\/:*?"<>|]/g, '_'),
        saveAs: false
      });
      chrome.downloads.onChanged.addListener(function onChanged(delta) {
        if (delta.id === downloadId && delta.state && delta.state.current === 'complete') {
          URL.revokeObjectURL(objectUrl);
          chrome.downloads.onChanged.removeListener(onChanged);
        }
      });
      report('done', {done: parts.length, total: parts.length});
    }
    catch (e) {
      report('error', {message: e.message});
    }
    hlsJobs.busy = false;
    hlsJobs.next();
  }
};

chrome.runtime.onMessage.addListener((request, sender, response) => {
  if (request.cmd === 'focus') {
    chrome.tabs.update(sender.tab.id, {
      highlighted: true
    });
    chrome.windows.update(sender.tab.windowId, {
      focused: true
    });
  }
  else if (request.cmd === 'grabber-paused') {
    capture.deactivate();
  }
  else if (request.cmd === 'grabber-resumed') {
    capture.activate();
  }
  else if (request.cmd === 'list-items') {
    buffer.read().then(response);
    return true;
  }
  else if (request.cmd === 'replace-items') {
    buffer.replace(request.items).then(() => response(true));
    return true;
  }
  else if (request.cmd === 'hls-download') {
    hlsJobs.add(request.job);
    response(true);
  }
  else if (request.panel === 'bring-to-front') {
    response(true);
  }
});

chrome.action.onClicked.addListener(async tab => {
  const resp = await chrome.runtime.sendMessage({
    panel: 'bring-to-front'
  }).catch(() => {});

  if (resp === true) {
    chrome.tabs.sendMessage(tab.id, {
      cmd: 'update-id',
      id: tab.id
    });
  }
  else {
    const win = await chrome.windows.getCurrent();

    const prefs = await chrome.storage.local.get({
      width: 800,
      height: 600
    });
    chrome.windows.create({
      url: 'data/window/index.html?tabId=' + tab.id,
      width: prefs.width,
      height: prefs.height,
      left: win.left + Math.round((win.width - prefs.width) / 2),
      top: win.top + Math.round((win.height - prefs.height) / 2),
      type: 'popup'
    });
  }
});

// Image Downloader (Open modified @belaviyo's image downloader UI [with developer's permission])
{
  const once = () => {
    if (once.done) {
      return;
    }
    once.done = true;

    chrome.contextMenus.create({
      title: 'Download all Images',
      contexts: ['action'],
      documentUrlPatterns: ['*://*/*'],
      id: 'save-images'
    });
    chrome.contextMenus.create({
      title: 'Download Live Streams',
      contexts: ['action'],
      documentUrlPatterns: ['*://*/*'],
      id: 'hls-downloader'
    });
  };
  chrome.runtime.onInstalled.addListener(once);
  chrome.runtime.onStartup.addListener(once);
}
chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'save-images' || info.menuItemId === 'hls-downloader') {
    const {href} = Object.assign(new URL(chrome.runtime.getManifest().homepage_url), {
      pathname: 'listing/' + info.menuItemId + '.html'
    });
    chrome.tabs.create({
      url: href
    });
  }
});

/* FAQs & Feedback */
{
  const {management, runtime: {onInstalled, setUninstallURL, getManifest}, storage, tabs} = chrome;
  if (navigator.webdriver !== true) {
    const {homepage_url: page, name, version} = getManifest();
    onInstalled.addListener(({reason, previousVersion}) => {
      management.getSelf(({installType}) => installType === 'normal' && storage.local.get({
        'faqs': true,
        'last-update': 0
      }, prefs => {
        if (reason === 'install' || (prefs.faqs && reason === 'update')) {
          const doUpdate = (Date.now() - prefs['last-update']) / 1000 / 60 / 60 / 24 > 45;
          if (doUpdate && previousVersion !== version) {
            tabs.query({active: true, lastFocusedWindow: true}, tbs => tabs.create({
              url: page + '?version=' + version + (previousVersion ? '&p=' + previousVersion : '') + '&type=' + reason,
              active: reason === 'install',
              ...(tbs && tbs.length && {index: tbs[0].index + 1})
            }));
            storage.local.set({'last-update': Date.now()});
          }
        }
      }));
    });
    setUninstallURL(page + '?rd=feedback&name=' + encodeURIComponent(name) + '&version=' + version);
  }
}
