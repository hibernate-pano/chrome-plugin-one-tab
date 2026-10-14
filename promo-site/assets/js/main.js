/* TapStack 宣传页 · 交互脚本
   只做两件事：导航状态、进入视口时揭示。无依赖、无框架。 */

(function () {
  'use strict';

  var topbar = document.getElementById('topbar');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 导航底边线 ---------- */
  function onScroll() {
    if (topbar) {
      topbar.setAttribute('data-scrolled', window.scrollY > 8 ? 'true' : 'false');
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- 进入视口揭示 ---------- */
  var targets = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  if (reduceMotion || !('IntersectionObserver' in window)) {
    targets.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

    targets.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Hero 三层卡片：极轻的视差 ---------- */
  var stage = document.querySelector('.stack-stage');
  if (stage && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    var cards = Array.prototype.slice.call(stage.querySelectorAll('.stack-card'));
    var raf = null;

    stage.addEventListener('mousemove', function (e) {
      if (raf) return;
      raf = window.requestAnimationFrame(function () {
        var r = stage.getBoundingClientRect();
        var dx = (e.clientX - r.left) / r.width - 0.5;
        var dy = (e.clientY - r.top) / r.height - 0.5;
        cards.forEach(function (card, i) {
          var depth = (i + 1) * 7;
          card.style.transform =
            'translate3d(' + (dx * depth).toFixed(2) + 'px,' +
            (dy * depth).toFixed(2) + 'px,0)';
        });
        raf = null;
      });
    });

    stage.addEventListener('mouseleave', function () {
      cards.forEach(function (card) { card.style.transform = ''; });
    });
  }
})();
