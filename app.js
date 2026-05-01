// --- Service Worker ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' })
    .catch(err => console.warn('SW registration failed:', err));
}

// --- DOM ---
const uploadScreen     = document.getElementById('upload-screen');
const loadingScreen    = document.getElementById('loading-screen');
const readerScreen     = document.getElementById('reader-screen');
const fileInput        = document.getElementById('file-input');
const loadingText      = document.getElementById('loading-text');
const readerPages      = document.getElementById('reader-pages');
const comicTitle       = document.getElementById('comic-title');
const pageIndicator    = document.getElementById('page-indicator');
const closeBtn         = document.getElementById('close-btn');
const dropZone         = document.getElementById('drop-zone');
const chapterNav       = document.getElementById('chapter-nav');
const chapterLabel     = document.getElementById('chapter-label');
const prevChBtn        = document.getElementById('prev-ch');
const nextChBtn        = document.getElementById('next-ch');
const modeToggle       = document.getElementById('mode-toggle');
const autoscrollToggle = document.getElementById('autoscroll-toggle');
const autoscrollBar    = document.getElementById('autoscroll-bar');
const asPlaypause      = document.getElementById('as-playpause');
const asSlower         = document.getElementById('as-slower');
const asFaster         = document.getElementById('as-faster');
const asSpeedLabel     = document.getElementById('as-speed-label');

// --- State ---
let pages        = [];   // [{entry, url, loading, img}]
let chapters     = [];   // [{name, start, end}]
let blobUrls     = [];
let lazyObserver = null;
let currentPage  = 0;
let currentChIdx = 0;
let chapterMode  = false;

const IMAGE_EXT   = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const ARCHIVE_EXT = /\.(cbz|zip)$/i;

// Pages to keep loaded either side of current page.
// Beyond this window, blob URLs are revoked to free memory.
const MEMORY_WINDOW = 12;

// --- Screens ---
function showScreen(id) {
  [uploadScreen, loadingScreen, readerScreen].forEach(s => s.style.display = 'none');
  // reader-screen uses position:absolute children, so block is correct
  document.getElementById(id).style.display = id === 'reader-screen' ? 'block' : 'flex';
}

// --- Header show/hide ---
const readerHeader = document.getElementById('reader-header');
let headerHidden   = false;
let headerTimer    = null;

function hideHeader() {
  if (headerHidden) return;
  headerHidden = true;
  readerHeader.classList.add('header-hidden');
}

function showHeader(autoHideMs = 0) {
  clearTimeout(headerTimer);
  headerHidden = false;
  readerHeader.classList.remove('header-hidden');
  if (autoHideMs > 0) headerTimer = setTimeout(hideHeader, autoHideMs);
}

// --- Cleanup ---
function cleanup() {
  stopAutoScroll();
  autoscrollBar.classList.add('hidden');
  if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
  blobUrls.forEach(url => URL.revokeObjectURL(url));
  blobUrls = []; pages = []; chapters = [];
  currentPage = 0; currentChIdx = 0; chapterMode = false;
  readerPages.innerHTML = '';
}

// --- File input — handles single file, single ZIP, or multiple CBZs ---
fileInput.addEventListener('change', e => {
  const files = Array.from(e.target.files).filter(f => ARCHIVE_EXT.test(f.name));
  fileInput.value = '';
  if (!files.length) { alert('Please select .cbz or .zip files.'); return; }
  if (files.length === 1) {
    openSingleFile(files[0]);
  } else {
    openFileList(files.sort((a, b) => naturalSort(a.name, b.name)));
  }
});

closeBtn.addEventListener('click', () => { cleanup(); showScreen('upload-screen'); });

// --- Drag & drop (supports multiple dropped files) ---
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files)
    .filter(f => ARCHIVE_EXT.test(f.name))
    .sort((a, b) => naturalSort(a.name, b.name));
  if (!files.length) { alert('No .cbz or .zip files found.'); return; }
  files.length === 1 ? openSingleFile(files[0]) : openFileList(files);
});

// --- Sorting ---
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function basename(path) { return path.replace(/^.*[\\/]/, ''); }

// --- Extract image entries from a JSZip, recursing into nested archives ---
// Returns [{images: JSZipEntry[], chapterName: string}]
async function extractEntries(zip, fallbackName) {
  const allFiles = Object.values(zip.files)
    .filter(f => !f.dir)
    .sort((a, b) => naturalSort(a.name, b.name));

  const archives = allFiles.filter(f => ARCHIVE_EXT.test(f.name));
  const images   = allFiles.filter(f => IMAGE_EXT.test(f.name));

  // Flat archive (no nested CBZs) — one chapter
  if (!archives.length) {
    return images.length ? [{ images, chapterName: fallbackName }] : [];
  }

  // Has nested archives — each becomes a chapter
  const result = [];
  for (let i = 0; i < archives.length; i++) {
    loadingText.textContent = `Opening ${i + 1} / ${archives.length}: ${basename(archives[i].name)}`;
    try {
      const buf   = await archives[i].async('arraybuffer');
      const inner = await JSZip.loadAsync(buf);
      const imgs  = Object.values(inner.files)
        .filter(f => !f.dir && IMAGE_EXT.test(f.name))
        .sort((a, b) => naturalSort(a.name, b.name));
      if (imgs.length) {
        result.push({ images: imgs, chapterName: basename(archives[i].name).replace(ARCHIVE_EXT, '') });
      }
    } catch (err) {
      console.warn(`Skipping ${archives[i].name}:`, err);
    }
  }

  // Any top-level images become an Extras chapter at the front
  if (images.length) result.unshift({ images, chapterName: 'Extras' });
  return result;
}

// --- Open one ZIP/CBZ file ---
async function openSingleFile(file) {
  cleanup();
  showScreen('loading-screen');
  loadingText.textContent = 'Reading file…';
  try {
    const buf  = await file.arrayBuffer();
    const zip  = await JSZip.loadAsync(buf);
    const name = file.name.replace(ARCHIVE_EXT, '');
    const groups = await extractEntries(zip, name);
    finalize(name, groups);
  } catch (err) {
    console.error(err);
    alert('Could not open this file. Make sure it is a valid CBZ or ZIP archive.');
    showScreen('upload-screen');
  }
}

// --- Open a list of CBZ files (multi-select) ---
async function openFileList(files) {
  cleanup();
  showScreen('loading-screen');
  const groups = [];
  for (let i = 0; i < files.length; i++) {
    loadingText.textContent = `Opening ${i + 1} / ${files.length}: ${files[i].name}`;
    try {
      const buf  = await files[i].arrayBuffer();
      const zip  = await JSZip.loadAsync(buf);
      const imgs = Object.values(zip.files)
        .filter(f => !f.dir && IMAGE_EXT.test(f.name))
        .sort((a, b) => naturalSort(a.name, b.name));
      if (imgs.length) groups.push({ images: imgs, chapterName: files[i].name.replace(ARCHIVE_EXT, '') });
    } catch (err) {
      console.warn(`Skipping ${files[i].name}:`, err);
    }
  }
  const title = files[0].webkitRelativePath
    ? files[0].webkitRelativePath.split('/')[0]
    : files[0].name.replace(ARCHIVE_EXT, '');
  finalize(title, groups);
}

// --- Build state and render ---
function finalize(title, groups) {
  if (!groups.length) {
    alert('No images found.');
    showScreen('upload-screen');
    return;
  }
  groups.forEach(({ images, chapterName }) => {
    const start = pages.length;
    images.forEach(entry => pages.push({ entry, url: null, loading: false, img: null }));
    chapters.push({ name: chapterName, start, end: pages.length - 1 });
  });

  comicTitle.textContent = title;
  renderPages();
  showScreen('reader-screen');
  setupChapterUI();
  setupLazyLoading();
  setupScrollTracking();
  for (let i = 0; i < Math.min(3, pages.length); i++) loadPage(i);
}

// --- Render placeholders ---
function renderPages() {
  const frag = document.createDocumentFragment();
  chapters.forEach((ch, chIdx) => {
    if (chapters.length > 1) {
      const div = document.createElement('div');
      div.className = 'chapter-divider';
      div.dataset.chapterDiv = chIdx;
      div.textContent = ch.name;
      frag.appendChild(div);
    }
    for (let i = ch.start; i <= ch.end; i++) {
      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.dataset.pageIndex = i;
      wrapper.dataset.chapterIdx = chIdx;

      const img = document.createElement('img');
      img.className = 'comic-page placeholder';
      img.alt = `Page ${i + 1}`;
      img.decoding = 'async';
      img.dataset.pageIndex = i;

      pages[i].img = img;
      wrapper.appendChild(img);
      frag.appendChild(wrapper);
    }
  });
  readerPages.appendChild(frag);
  updateIndicator();
}

// --- Chapter UI ---
function setupChapterUI() {
  const multi = chapters.length > 1;
  chapterNav.classList.toggle('hidden', !multi);
  modeToggle.classList.toggle('hidden', !multi);
  if (multi) {
    updateChapterLabel();
    prevChBtn.addEventListener('click', () => goToChapter(currentChIdx - 1));
    nextChBtn.addEventListener('click', () => goToChapter(currentChIdx + 1));
    modeToggle.addEventListener('click', toggleMode);
    modeToggle.textContent = 'Scroll';
  }
}

function updateChapterLabel() {
  chapterLabel.textContent = `${currentChIdx + 1} / ${chapters.length}`;
  prevChBtn.style.opacity = currentChIdx === 0 ? '.3' : '1';
  nextChBtn.style.opacity = currentChIdx === chapters.length - 1 ? '.3' : '1';
}

function goToChapter(idx) {
  if (idx < 0 || idx >= chapters.length) return;
  currentChIdx = idx;
  updateChapterLabel();
  if (chapterMode) {
    applyChapterMode();
    readerPages.scrollTop = 0;
    const ch = chapters[idx];
    for (let i = ch.start; i < Math.min(ch.start + 4, ch.end + 1); i++) loadPage(i);
  } else {
    const el = readerPages.querySelector(`.page-wrapper[data-chapter-idx="${idx}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }
}

function toggleMode() {
  chapterMode = !chapterMode;
  modeToggle.textContent = chapterMode ? 'Chapter' : 'Scroll';
  if (chapterMode) {
    currentChIdx = Math.max(0, chapters.findIndex(ch => currentPage >= ch.start && currentPage <= ch.end));
    applyChapterMode();
    readerPages.scrollTop = 0;
    const ch = chapters[currentChIdx];
    for (let i = ch.start; i <= ch.end; i++) loadPage(i);
  } else {
    applyScrollMode();
    const el = readerPages.querySelector(`.page-wrapper[data-page-index="${currentPage}"]`);
    if (el) el.scrollIntoView();
  }
  updateChapterLabel();
}

function applyChapterMode() {
  readerPages.querySelectorAll('.page-wrapper').forEach(el =>
    el.classList.toggle('ch-hidden', parseInt(el.dataset.chapterIdx) !== currentChIdx)
  );
  readerPages.querySelectorAll('.chapter-divider').forEach(el => el.classList.add('ch-hidden'));
  updateIndicator();
}
function applyScrollMode() {
  readerPages.querySelectorAll('.ch-hidden').forEach(el => el.classList.remove('ch-hidden'));
}

// --- Lazy loading ---
function setupLazyLoading() {
  lazyObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const idx = parseInt(entry.target.dataset.pageIndex, 10);
      for (let i = idx; i < Math.min(idx + 4, pages.length); i++) loadPage(i);
    });
  }, { rootMargin: '500px 0px 500px 0px' });
  pages.forEach(p => { if (p.img) lazyObserver.observe(p.img); });
}

async function loadPage(idx) {
  const page = pages[idx];
  if (!page || page.url || page.loading) return;
  page.loading = true;
  try {
    const blob = await page.entry.async('blob');
    const url  = URL.createObjectURL(blob);
    page.url   = url;
    blobUrls.push(url);
    if (page.img) {
      page.img.onload = () => page.img.classList.remove('placeholder');
      page.img.src = url;
    }
  } catch (err) {
    console.error(`Page ${idx} failed:`, err);
    page.loading = false;
  }
}

// Release blob URLs for pages outside the memory window.
// The placeholder class and lazy observer keep them reload-able on scroll-back.
function unloadDistantPages() {
  pages.forEach((page, idx) => {
    if (!page.url) return;
    if (Math.abs(idx - currentPage) > MEMORY_WINDOW) {
      URL.revokeObjectURL(page.url);
      blobUrls = blobUrls.filter(u => u !== page.url);
      page.url     = null;
      page.loading = false;
      if (page.img) {
        page.img.src = '';
        page.img.classList.add('placeholder');
      }
    }
  });
}

// --- Scroll tracking ---
function setupScrollTracking() {
  let raf = false;
  let lastY = 0;
  readerPages.addEventListener('scroll', () => {
    if (raf) return;
    raf = true;
    requestAnimationFrame(() => {
      raf = false;
      const y = readerPages.scrollTop;
      const delta = y - lastY;
      lastY = y;

      // Auto-hide header when scrolling down; reveal on scroll up or at top
      if (!autoRunning) {
        if (delta > 8 && y > 60) hideHeader();
        else if (delta < -8 || y < 10) showHeader();
      }

      trackPage();
      unloadDistantPages();
    });
  }, { passive: true });
}

function trackPage() {
  const wrappers = readerPages.querySelectorAll('.page-wrapper:not(.ch-hidden)');
  if (!wrappers.length) return;
  const midY = readerPages.scrollTop + readerPages.clientHeight / 2;
  let best = 0;
  for (let i = 0; i < wrappers.length; i++) {
    if (wrappers[i].offsetTop <= midY) best = i;
    else break;
  }
  const globalIdx = parseInt(wrappers[best].dataset.pageIndex, 10);
  if (globalIdx === currentPage) return;
  currentPage = globalIdx;
  if (!chapterMode) {
    const chIdx = chapters.findIndex(ch => currentPage >= ch.start && currentPage <= ch.end);
    if (chIdx >= 0 && chIdx !== currentChIdx) { currentChIdx = chIdx; updateChapterLabel(); }
  }
  updateIndicator();
}

function updateIndicator() {
  if (chapterMode) {
    const ch = chapters[currentChIdx];
    pageIndicator.textContent = `${currentPage - ch.start + 1} / ${ch.end - ch.start + 1}`;
  } else {
    pageIndicator.textContent = `${currentPage + 1} / ${pages.length}`;
  }
}

// ── Auto-scroll ──────────────────────────────────────────────────────────────

// Speed levels: pixels scrolled per animation frame (60fps)
// 0.5 px/f = ~30 px/s (very slow), 8 px/f = ~480 px/s (fast)
const SPEED_LEVELS = [0.3, 0.5, 0.8, 1.2, 1.8, 2.5, 3.5, 5.0, 7.0];
const SPEED_LABELS = ['0.3×', '0.5×', '0.8×', '1.2×', '1.8×', '2.5×', '3.5×', '5.0×', '7.0×'];
let speedIdx     = 3;   // default: 1.2 px/frame
let autoRunning  = false;
let scrollRaf    = null;
let barVisible   = false;

autoscrollToggle.addEventListener('click', () => {
  barVisible = !barVisible;
  autoscrollBar.classList.toggle('hidden', !barVisible);
  if (!barVisible && autoRunning) stopAutoScroll();
});

asPlaypause.addEventListener('click', () => {
  autoRunning ? stopAutoScroll() : startAutoScroll();
});

asSlower.addEventListener('click', () => {
  if (speedIdx > 0) { speedIdx--; updateSpeedLabel(); }
});
asFaster.addEventListener('click', () => {
  if (speedIdx < SPEED_LEVELS.length - 1) { speedIdx++; updateSpeedLabel(); }
});

function updateSpeedLabel() {
  asSpeedLabel.textContent = SPEED_LABELS[speedIdx];
  asSlower.style.opacity = speedIdx === 0 ? '.3' : '1';
  asFaster.style.opacity = speedIdx === SPEED_LEVELS.length - 1 ? '.3' : '1';
}

function startAutoScroll() {
  autoRunning = true;
  asPlaypause.textContent = '⏸';
  autoscrollBar.classList.add('hidden');
  barVisible = false;
  hideHeader();
  function step() {
    if (!autoRunning) return;
    readerPages.scrollTop += SPEED_LEVELS[speedIdx];
    const atBottom = readerPages.scrollTop + readerPages.clientHeight >= readerPages.scrollHeight - 2;
    if (atBottom) { stopAutoScroll(); return; }
    scrollRaf = requestAnimationFrame(step);
  }
  scrollRaf = requestAnimationFrame(step);
}

function stopAutoScroll() {
  autoRunning = false;
  asPlaypause.textContent = '▶';
  if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
}

// Tap the page: pause scroll, restore header and controls
readerPages.addEventListener('touchstart', () => {
  if (autoRunning) stopAutoScroll();
  showHeader();
  if (!barVisible) {
    barVisible = true;
    autoscrollBar.classList.remove('hidden');
  }
}, { passive: true });

updateSpeedLabel();
