/* eebookk 官网交互：导航、滚动入场、产品导览标签页。 */
(function () {
  'use strict';

  var header = document.querySelector('[data-header]');
  var nav = document.getElementById('site-nav');
  var navToggle = document.querySelector('[data-nav-toggle]');
  var mqMobile = window.matchMedia('(max-width: 820px)');
  var staticMode = document.documentElement.classList.contains('static');

  /* ---------- 顶栏 ---------- */
  function onScroll() {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 8);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  function setNav(open) {
    if (!header || !navToggle) return;
    header.classList.toggle('nav-open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  }

  if (navToggle) {
    navToggle.addEventListener('click', function () {
      setNav(!header.classList.contains('nav-open'));
    });
  }

  if (nav) {
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a') && mqMobile.matches) setNav(false);
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && header && header.classList.contains('nav-open')) {
      setNav(false);
      if (navToggle) navToggle.focus();
    }
  });

  document.addEventListener('click', function (event) {
    if (!header || !header.classList.contains('nav-open')) return;
    if (!header.contains(event.target)) setNav(false);
  });

  var onViewportChange = function () {
    if (!mqMobile.matches) setNav(false);
  };
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', onViewportChange);
  else if (mqMobile.addListener) mqMobile.addListener(onViewportChange);

  /* ---------- 下载按钮：本地有安装包就用本地，否则回退 GitHub Releases ---------- */
  var downloadBtn = document.querySelector('[data-download]');
  if (downloadBtn && downloadBtn.dataset.local && /^https?:$/.test(location.protocol)) {
    var localHref = downloadBtn.dataset.local;
    fetch(localHref, { method: 'HEAD', cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) return;
        downloadBtn.href = localHref;
        downloadBtn.setAttribute('download', '');
        downloadBtn.removeAttribute('target');
        downloadBtn.setAttribute('rel', 'noopener');
        downloadBtn.dataset.source = 'local';
      })
      .catch(function () { /* 保持 GitHub Releases 作为兜底 */ });
  }

  /* ---------- 滚动入场 ---------- */
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (staticMode) {
    reveals.forEach(function (el) { el.classList.add('is-in'); });
    Array.prototype.forEach.call(document.images, function (img) { img.loading = 'eager'; });
  } else if (!('IntersectionObserver' in window) || reduceMotion) {
    reveals.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* ---------- 产品导览 ---------- */
  var tour = document.querySelector('[data-tour]');
  if (tour) {
    var tabs = Array.prototype.slice.call(tour.querySelectorAll('[role="tab"]'));
    var panels = tabs.map(function (tab) {
      return document.getElementById(tab.getAttribute('aria-controls'));
    });
    var railEl = tabs[0] && tabs[0].parentElement;
    var mqWideTour = window.matchMedia('(min-width: 961px)');

    function syncTourOrientation() {
      if (railEl) railEl.setAttribute('aria-orientation', mqWideTour.matches ? 'vertical' : 'horizontal');
    }
    syncTourOrientation();
    if (mqWideTour.addEventListener) mqWideTour.addEventListener('change', syncTourOrientation);
    else if (mqWideTour.addListener) mqWideTour.addListener(syncTourOrientation);

    function selectTab(index) {
      var count = tabs.length;
      index = (index + count) % count;
      tabs.forEach(function (tab, i) {
        var active = i === index;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active ? 0 : -1;
        if (panels[i]) panels[i].hidden = !active;
        if (panels[i]) panels[i].classList.toggle('is-active', active);
      });
      var tab = tabs[index];
      var rail = tab && tab.parentElement;
      if (rail) {
        var railRect = rail.getBoundingClientRect();
        var tabRect = tab.getBoundingClientRect();
        if (tabRect.left < railRect.left + 8 || tabRect.right > railRect.right - 8) {
          tab.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
        }
      }
    }

    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () { selectTab(index); });
      tab.addEventListener('keydown', function (event) {
        var next = null;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = index + 1;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = index - 1;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        var count = tabs.length;
        next = (next + count) % count;
        selectTab(next);
        tabs[next].focus();
      });
    });

    /* 提前取回其余截图，切换时不用等 */
    window.addEventListener('load', function () {
      panels.forEach(function (panel) {
        if (!panel) return;
        var img = panel.querySelector('img');
        if (img && img.getAttribute('src')) {
          var preload = new Image();
          preload.src = img.getAttribute('src');
        }
      });
    });
  }
})();
