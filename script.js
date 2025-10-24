document.addEventListener('DOMContentLoaded', () => {
  // Centralized element selectors
  const elements = {
    urlInput: document.getElementById('urlInput'),
    loadUrlBtn: document.getElementById('loadUrlBtn'),
    channelsList: document.getElementById('channelsList'),
    search: document.getElementById('search'),
    video: document.getElementById('video'),
    currentInfo: document.getElementById('currentInfo'),
    muteBtn: document.getElementById('muteBtn'),
    pipBtn: document.getElementById('pipBtn'),
    openNewTabBtn: document.getElementById('openNewTabBtn'),
    statusDiv: document.getElementById('status'),
    layout: document.getElementById('layout'),
    sidebar: document.getElementById('sidebar'),
    sidebarOverlay: document.getElementById('sidebar-overlay'),
    toggleMenuBtn: document.getElementById('toggleMenuBtn'),
    themeToggle: document.getElementById('theme-toggle'),
  };

  let playlist = [];
  let filteredPlaylist = [];
  let currentChannelIndex = -1;
  let hls = null;
  let virtualList = null;
  const ITEM_HEIGHT = 60; // Approximate height of a channel list item in pixels

  // Utility for debouncing functions
  function debounce(func, delay) {
    let timeout;
    return function(...args) {
      const context = this;
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(context, args), delay);
    };
  }

  // --- VIRTUAL LIST CLASS ---
  class VirtualList {
    constructor(container, items, itemHeight, renderItemCallback) {
      this.container = container;
      this.items = items;
      this.itemHeight = itemHeight;
      this.renderItemCallback = renderItemCallback;

      this.container.style.overflowY = 'auto';
      this.container.style.position = 'relative';
      this.container.style.willChange = 'transform';

      this.innerContainer = document.createElement('div');
      this.innerContainer.style.position = 'relative';
      this.container.appendChild(this.innerContainer);

      this.lastScrollTop = 0;
      this.visibleHeight = 0;
      this.updateVisibleHeight();

      this.container.addEventListener('scroll', () => this.handleScroll());
      window.addEventListener('resize', debounce(() => this.updateVisibleHeight(), 150));
    }

    updateVisibleHeight() {
      this.visibleHeight = this.container.clientHeight;
      this.totalHeight = this.items.length * this.itemHeight;
      this.innerContainer.style.height = `${this.totalHeight}px`;
      this.render();
    }

    updateItems(newItems) {
      this.items = newItems;
      this.totalHeight = this.items.length * this.itemHeight;
      this.innerContainer.style.height = `${this.totalHeight}px`;
      this.container.scrollTop = 0; // Reset scroll on new list
      this.render();
    }

    handleScroll() {
      const scrollTop = this.container.scrollTop;
      const delta = scrollTop - this.lastScrollTop;
      this.lastScrollTop = scrollTop;

      // Simple optimization: only re-render if scrolled a significant amount
      if (Math.abs(delta) > this.itemHeight / 2) {
        this.render();
      }
    }

    render() {
      const scrollTop = this.container.scrollTop;
      const startIndex = Math.max(0, Math.floor(scrollTop / this.itemHeight) - 5); // Render a few extra for smooth scrolling
      const endIndex = Math.min(this.items.length, Math.ceil((scrollTop + this.visibleHeight) / this.itemHeight) + 5);

      // Clear only if a full re-render is needed, or optimize with diffing (future improvement)
      this.innerContainer.innerHTML = '';

      const fragment = document.createDocumentFragment();
      for (let i = startIndex; i < endIndex; i++) {
        const item = this.items[i];
        if (item) {
          const element = this.renderItemCallback(item, i);
          element.style.position = 'absolute';
          element.style.top = `${i * this.itemHeight}px`;
          element.style.width = '100%';
          element.style.height = `${this.itemHeight}px`;
          fragment.appendChild(element);
        }
      }
      this.innerContainer.appendChild(fragment);
    }
  }

  // --- THEME MANAGER ---
  const themeManager = {
    init() {
      elements.themeToggle.addEventListener('click', () => this.toggleTheme());
      this.applyTheme();
    },
    getSystemTheme() {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    },
    applyTheme() {
      const savedTheme = localStorage.getItem('theme') || this.getSystemTheme();
      document.documentElement.setAttribute('data-theme', savedTheme);
    },
    toggleTheme() {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
    },
  };

  // --- SIDEBAR MANAGER ---
  const sidebarManager = {
    init() {
      elements.toggleMenuBtn.addEventListener('click', () => this.handleToggle());
      elements.sidebarOverlay.addEventListener('click', () => this.closeMobileSidebar());
    },
    isMobile() {
      return window.innerWidth <= 768; // Based on CSS media query breakpoint
    },
    handleToggle() {
      if (this.isMobile()) {
        elements.sidebar.classList.toggle('is-open');
        elements.sidebarOverlay.classList.toggle('is-open');
      } else {
        elements.layout.classList.toggle('sidebar-collapsed');
      }
    },
    closeMobileSidebar() {
      if (this.isMobile()) {
        elements.sidebar.classList.remove('is-open');
        elements.sidebarOverlay.classList.remove('is-open');
      }
    },
  };

  // --- M3U PARSER ---
  function parseM3U(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXTINF')) {
        const meta = line;
        const url = (lines[i + 1] || '').trim();
        if (url) {
          const info = parseExtInf(meta);
          items.push({ ...info, url });
          i++;
        }
      } else if (!line.startsWith('#')) {
        // Fallback for simple URLs in list without EXTINF
        items.push({ name: line, url: line });
      }
    }
    return items;
  }

  function parseExtInf(extinfLine) {
    const obj = { name: '', tvg_logo: '', group: '' };
    const commaIndex = extinfLine.indexOf(',');
    if (commaIndex > -1) {
      obj.name = extinfLine.slice(commaIndex + 1).trim();
    }
    const attrRegex = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = attrRegex.exec(extinfLine))) {
      const k = m[1].toLowerCase();
      const v = m[2];
      if (k.includes('logo') || k === 'tvg-logo') obj.tvg_logo = v;
      if (k.includes('group')) obj.group = v;
    }
    return obj;
  }

  // --- PLAYER LOGIC ---
  function showStatus(msg, isError = false) {
    elements.statusDiv.style.display = msg ? 'block' : 'none';
    elements.statusDiv.style.backgroundColor = isError ? 'var(--error-color)' : 'var(--accent-color)';
    elements.statusDiv.style.color = 'var(--accent-text-color)';
    elements.statusDiv.textContent = msg || '';
    console.log('STATUS:', msg);
  }

  // Callback for VirtualList to render a single channel item
  const renderChannelItem = (ch, idx) => {
    const name = (ch.name || ch.title || ch.url || '').toString();

    const row = document.createElement('div');
    row.className = 'channel';
    row.dataset.idx = idx;
    if (idx === currentChannelIndex) row.classList.add('playing');

    const img = document.createElement('img');
    img.className = 'logo';
    img.src = ch.tvg_logo || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; // Transparent pixel
    if (ch.tvg_logo) img.onerror = () => { img.style.visibility = 'hidden'; };

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = name;
    const group = document.createElement('div');
    group.className = 'group';
    group.textContent = ch.group || 'Sin grupo';
    meta.append(title, group);

    row.append(img, meta);
    row.addEventListener('click', () => playChannel(idx));
    return row;
  };

  const updateFilteredPlaylist = () => {
    const q = (elements.search.value || '').trim().toLowerCase();
    if (!q) {
      filteredPlaylist = playlist;
    } else {
      filteredPlaylist = playlist.filter(ch =>
        (ch.name || ch.title || ch.url || '').toString().toLowerCase().includes(q) ||
        (ch.group || '').toLowerCase().includes(q)
      );
    }
    if (virtualList) {
      virtualList.updateItems(filteredPlaylist);
    }
  };

  const debouncedUpdateFilteredPlaylist = debounce(updateFilteredPlaylist, 300);

  function setPlaylist(p) {
    playlist = p || [];
    currentChannelIndex = -1; // Reset selection
    updateFilteredPlaylist();
    showStatus(`${playlist.length} canales cargados.`, false);
  }

  async function loadUrl() {
    const url = (elements.urlInput.value || '').trim();
    if (!url) return showStatus('Introduce una URL.', true);
    showStatus(`Cargando lista desde ${url}...`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const txt = await res.text();
      if (!txt.includes('#EXTM3U')) throw new Error('El contenido no parece una lista M3U.');
      const items = parseM3U(txt);
      setPlaylist(items);
    } catch (e) {
      console.error('Fetch error', e);
      showStatus(`Error al cargar la URL: ${e.message}`, true);
    }
  }

  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  function playChannel(index) {
    const ch = filteredPlaylist[index]; // Play from filtered list
    if (!ch) return;

    currentChannelIndex = index;
    // Re-render only to highlight the playing channel correctly
    virtualList.render(); 

    elements.currentInfo.textContent = ch.name || ch.url;
    const src = ch.url;

    destroyHls();
    elements.video.pause();
    elements.video.removeAttribute('src');
    elements.video.load();

    const video = elements.video;

    if (video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => {});
    } else if (window.Hls && Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (event, data) => {
        showStatus(`Error de HLS: ${data.details}`, true);
      });
      video.play().catch(() => {});
    } else {
      video.src = src;
      video.play().catch(() => { showStatus('No se puede reproducir este stream.', true); });
    }
    sidebarManager.closeMobileSidebar();
  }

  // --- EVENT LISTENERS ---
  elements.loadUrlBtn.addEventListener('click', loadUrl);
  elements.search.addEventListener('input', debouncedUpdateFilteredPlaylist);
  elements.muteBtn.addEventListener('click', () => {
    elements.video.muted = !elements.video.muted;
    elements.muteBtn.textContent = elements.video.muted ? 'Sonido' : 'Silenciar';
  });
  elements.pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await elements.video.requestPictureInPicture();
      }
    } catch (e) {
      showStatus(`Error de PIP: ${e.message}`, true);
    }
  });
  elements.openNewTabBtn.addEventListener('click', () => {
    const ch = filteredPlaylist[currentChannelIndex];
    if (ch && ch.url) window.open(ch.url, '_blank');
  });

  // --- INITIALIZATION ---
  themeManager.init();
  sidebarManager.init();

  // Initialize VirtualList AFTER the elements are ready
  virtualList = new VirtualList(elements.channelsList, filteredPlaylist, ITEM_HEIGHT, renderChannelItem);

  // Re-enable proxy options for the user
  const proxySection = document.createElement('div');
  proxySection.className = 'sidebar-section';
  proxySection.innerHTML = "\n    <div class=\"sidebar-label\">\n        <svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M10.25 4.75H5.75L4.75 5.75V18.25L5.75 19.25H18.25L19.25 18.25V13.75\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13.75 10.75H19.25V4.75L13.75 10.75Z\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>\n        <span>Proxy CORS (opcional)</span>\n    </div>\n    <div class=\"input-group\" style=\"align-items:center\">\n        <input id=\"useProxy\" type=\"checkbox\" />\n        <label for=\"useProxy\">Activar Proxy</label>\n    </div>\n    <input id=\"proxyInput\" type=\"text\" placeholder=\"Ej: https://proxy.io/?url=\" style=\"margin-top: 8px;\" />\n    <p class=\"note small\" style=\"margin-top:8px;\">Si tienes problemas de carga, activa un proxy. Ej: <code>https://corsproxy.io/?</code></p>\n  ";
  elements.sidebar.insertBefore(proxySection, elements.statusDiv.parentNode);

  const useProxyCheckbox = document.getElementById('useProxy');
  const proxyInputElem = document.getElementById('proxyInput');

  // Helper for generating proxy URL (re-added)
  function buildProxyUrl(proxyBase, targetUrl) {
    if (!proxyBase) return targetUrl;
    if (proxyBase.includes('{url}')) return proxyBase.replace('{url}', encodeURIComponent(targetUrl));
    if (proxyBase.endsWith('=') || proxyBase.endsWith('?')) return proxyBase + encodeURIComponent(targetUrl);
    if (proxyBase.endsWith('/')) return proxyBase + encodeURIComponent(targetUrl);
    return proxyBase + (proxyBase.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(targetUrl);
  }

  // Modify loadUrl to use proxy if enabled
  const originalLoadUrl = loadUrl;
  loadUrl = async function() {
    const url = (elements.urlInput.value || '').trim();
    if (!url) return showStatus('Introduce una URL.', true);

    let finalUrl = url;
    if (useProxyCheckbox && useProxyCheckbox.checked) {
      const proxyBase = (proxyInputElem.value || '').trim();
      if (!proxyBase) return showStatus('Proxy activado, pero no se ha introducido URL de proxy.', true);
      finalUrl = buildProxyUrl(proxyBase, url);
      showStatus(`Cargando con proxy: ${finalUrl.substring(0, 50)}...`);
    } else {
      showStatus(`Cargando lista desde ${url}...`);
    }

    try {
      const res = await fetch(finalUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const txt = await res.text();
      if (!txt.includes('#EXTM3U')) throw new Error('El contenido no parece una lista M3U.');
      const items = parseM3U(txt);
      setPlaylist(items);
    } catch (e) {
      console.error('Fetch error', e);
      showStatus(`Error al cargar la URL (proxy?): ${e.message}`, true);
    }
  };

  // Load a demo list on start
  (function autoDemo(){
    const items=[{name:'Sintel HLS (demo)',url:'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',group:'Demo'}];
    setPlaylist(items);
  })();
});