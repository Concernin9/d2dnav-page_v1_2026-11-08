/* D2D-Nav project page. Plain JavaScript, no dependencies. */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function onVisible(el, cb, opts) {
    if (!('IntersectionObserver' in window)) { cb(true); return null; }
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { cb(e.isIntersecting, e); }); }, opts || { threshold: 0.15 });
    io.observe(el);
    return io;
  }

  /* ---------------- top bar ---------------- */
  var bar = document.querySelector('.bar');
  var links = Array.prototype.slice.call(document.querySelectorAll('.bar nav a'));
  var marks = links.map(function (a) { return document.querySelector(a.getAttribute('href')); });
  function onScroll() {
    bar.classList.toggle('is-stuck', window.scrollY > 8);
    var here = -1, y = window.scrollY + 120;
    marks.forEach(function (m, i) { if (m && m.getBoundingClientRect().top + window.scrollY <= y) here = i; });
    links.forEach(function (a, i) { a.classList.toggle('is-here', i === here); });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------------- hero: the world in ink ---------------- */
  var HERO = window.HERO;
  var canvas = document.getElementById('ink');
  if (HERO && canvas && canvas.getContext) heroInit();

  function heroInit() {
    var COLORS = { OO: '#6A55E8', OI: '#C24FB3', IO: '#2C9C8E' };
    var ROSE = '#D8436A', PAPER = '#F7F5FC';
    var SYM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/';
    var frame = canvas.parentNode;
    var ctx = canvas.getContext('2d');
    var dpr = 1, W = 0, H = 0, scale = 1, grid = null;
    var inkLayer = document.createElement('canvas'), inkCtx = inkLayer.getContext('2d');
    var routeLayer = document.createElement('canvas'), routeCtx = routeLayer.getContext('2d');
    var render = new Image(), renderReady = false;
    var wash = new Image(), washReady = false;
    wash.onload = function () { washReady = true; kick(); };
    wash.src = 'static/images/hero_wash.webp';
    var WASH = 0.22;
    var cells = [], drawnCells = 0, routes = [], focus = null;
    var t0 = 0, introDone = reduce, running = false, inView = true, raf = 0;
    var lens = { on: false, x: 0, y: 0, r: 100, k: 0 };
    var runners = [];

    render.onload = function () { renderReady = true; };

    // routes in source pixels, with cumulative metres (points are 1 m apart after downsampling)
    var srcRoutes = HERO.routes.map(function (r, i) {
      return { m: r.m, len: r.len, p: r.p, i: i };
    });

    function setup() {
      var rect = frame.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.round(rect.width); H = Math.round(rect.width * HERO.height / HERO.width);
      if (!W) return false;
      [canvas, inkLayer, routeLayer].forEach(function (c) { c.width = W * dpr; c.height = H * dpr; });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      routeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scale = W / HERO.width;
      grid = W < 760 ? HERO.sm : HERO.lg;
      lens.r = Math.max(56, Math.min(130, W * 0.085));
      if (!render.src) render.src = W < 760 ? 'static/images/hero_render_sm.webp' : 'static/images/hero_render.webp';
      buildCells();
      routes = srcRoutes.map(function (r) {
        var pts = r.p.map(function (q) { return [q[0] * scale, q[1] * scale, q[2]]; });
        return { m: r.m, pts: pts, i: r.i };
      });
      return true;
    }

    function buildCells() {
      var cw = W / grid.cols, ch = H / grid.rows;
      var fs = Math.min(cw / 0.602, ch * 0.98);
      inkCtx.clearRect(0, 0, W, H);
      inkCtx.font = fs.toFixed(2) + 'px "Ink Mono", ui-monospace, Menlo, Consolas, monospace';
      inkCtx.textAlign = 'center';
      inkCtx.textBaseline = 'middle';
      cells = [];
      // ink spreads from the plaza: reveal time grows with distance, with a little grain
      var ox = 0.52 * grid.cols, oy = 0.62 * grid.rows, maxd = Math.hypot(grid.cols, grid.rows * 2) * 0.62;
      for (var r = 0; r < grid.rows; r++) {
        var chars = grid.chars[r], cols = grid.colors[r], al = grid.alpha[r];
        for (var c = 0; c < grid.cols; c++) {
          var chr = chars.charAt(c);
          if (chr === ' ') continue;
          var a = (al.charCodeAt(c) - 48) / 9;
          if (a <= 0.05) continue;
          var d = Math.hypot(c - ox, (r - oy) * 2) / maxd;
          var grain = ((c * 73856093) ^ (r * 19349663)) % 1000 / 1000;
          cells.push({ x: (c + 0.5) * cw, y: (r + 0.52) * ch, ch: chr, col: grid.palette[SYM.indexOf(cols.charAt(c))], a: a, t: Math.min(1, d * 0.85 + grain * 0.25) });
        }
      }
      cells.sort(function (p, q) { return p.t - q.t; });
      drawnCells = 0;
    }

    function drawCellsUpTo(tn) {
      var n = cells.length;
      while (drawnCells < n && cells[drawnCells].t <= tn) {
        var e = cells[drawnCells++];
        inkCtx.globalAlpha = e.a;
        inkCtx.fillStyle = e.col;
        inkCtx.fillText(e.ch, e.x, e.y);
      }
      inkCtx.globalAlpha = 1;
    }

    function routeAlpha(m) {
      if (!focus) return 1;
      return focus === m ? 1 : 0.1;
    }

    // draw route i up to fraction f (0..1) on context g
    function strokeRoute(g, rt, f, alphaMul) {
      var pts = rt.pts, n = pts.length, upto = f * (n - 1);
      var col = COLORS[rt.m];
      g.strokeStyle = col;
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (var k = 0; k < n - 1 && k < upto; k++) {
        var a = pts[k], b = pts[k + 1], fl = Math.min(a[2], b[2]) === 2 ? 2 : (a[2] === 0 || b[2] === 0 ? 0 : 1);
        if (fl === 2) continue;
        var t = Math.min(1, upto - k);
        g.globalAlpha = (fl === 1 ? 0.82 : 0.22) * alphaMul;
        g.lineWidth = fl === 1 ? Math.max(1.1, W / 1100) : 1;
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    function drawObstacles(g, alpha) {
      var s = Math.max(3.2, W / 330);
      HERO.obstacles.forEach(function (o) {
        var x = o.u * scale, y = o.v * scale;
        g.globalAlpha = alpha;
        g.fillStyle = ROSE;
        g.fillRect(x - s / 2, y - s / 2, s, s);
        if (o.held) {
          g.strokeStyle = ROSE; g.lineWidth = 1;
          g.strokeRect(x - s, y - s, s * 2, s * 2);
        }
      });
      g.globalAlpha = 1;
    }

    function paintRouteLayer() {
      routeCtx.clearRect(0, 0, W, H);
      routes.forEach(function (rt) { strokeRoute(routeCtx, rt, 1, 0.75 * routeAlpha(rt.m)); });
      drawObstacles(routeCtx, focus ? 0.45 : 0.9);
    }

    function makeRunners() {
      runners = [];
      srcRoutes.forEach(function (r, i) {
        if (i % 3 !== 0) return;
        var n = r.p.length;
        runners.push({ i: i, n: n, s: (i * 7.31) % n, v: 2.2 + (i % 5) * 0.18 });
      });
    }

    function at(rt, s) {
      var n = rt.pts.length, k = Math.max(0, Math.min(n - 2, Math.floor(s))), t = s - k;
      var a = rt.pts[k], b = rt.pts[k + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (t < 0.5 ? a[2] : b[2])];
    }

    function drawRunners(dt) {
      runners.forEach(function (u) {
        var rt = routes[u.i];
        if (focus && focus !== rt.m) return;
        u.s += u.v * dt;
        if (u.s > u.n - 1) u.s = 0;
        var head = at(rt, u.s);
        if (head[2] === 2) return;
        var col = COLORS[rt.m];
        // short tail behind the robot
        ctx.strokeStyle = col; ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(2, W / 520);
        var steps = 6;
        for (var j = steps; j > 0; j--) {
          var s0 = Math.max(0, u.s - j * 0.7), s1 = Math.max(0, u.s - (j - 1) * 0.7);
          var p0 = at(rt, s0), p1 = at(rt, s1);
          if (p0[2] === 2 || p1[2] === 2) continue;
          ctx.globalAlpha = (1 - j / (steps + 1)) * (head[2] === 1 ? 0.9 : 0.35);
          ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
        }
        var rr = Math.max(2.4, W / 520);
        ctx.globalAlpha = head[2] === 1 ? 0.22 : 0.08;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(head[0], head[1], rr * 2.6, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = head[2] === 1 ? 1 : 0.4;
        ctx.fillStyle = PAPER;
        ctx.beginPath(); ctx.arc(head[0], head[1], rr * 1.25, 0, 6.2832); ctx.fill();
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(head[0], head[1], rr, 0, 6.2832); ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    function drawLens() {
      if (lens.k <= 0.01 || !renderReady) return;
      var r = lens.r * lens.k;
      ctx.save();
      ctx.beginPath(); ctx.arc(lens.x, lens.y, r, 0, 6.2832); ctx.clip();
      ctx.drawImage(render, 0, 0, W, H);
      ctx.restore();
      ctx.globalAlpha = 0.5 * lens.k;
      ctx.strokeStyle = '#241E3E'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(lens.x, lens.y, r, 0, 6.2832); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    var last = 0;
    function frameFn(now) {
      raf = 0;
      if (!t0) t0 = now;
      var t = (now - t0) / 1000, dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      ctx.clearRect(0, 0, W, H);
      if (washReady) {
        ctx.globalAlpha = WASH * (introDone ? 1 : Math.min(1, t / 1.6));
        ctx.drawImage(wash, 0, 0, W, H);
        ctx.globalAlpha = 1;
      }
      if (!introDone) {
        drawCellsUpTo(Math.min(1, t / 1.5));
        ctx.drawImage(inkLayer, 0, 0, W, H);
        var tr = t - 0.9;
        if (tr > 0) {
          routes.forEach(function (rt, k) {
            var st = (k % 48) * 0.035, f = Math.max(0, Math.min(1, (tr - st) / 1.4));
            if (f > 0) strokeRoute(ctx, rt, f, 0.75);
          });
          drawObstacles(ctx, Math.min(0.9, tr / 1.2));
        }
        if (t > 4.2) { introDone = true; drawCellsUpTo(1); paintRouteLayer(); }
      } else {
        ctx.drawImage(inkLayer, 0, 0, W, H);
        lens.k += ((lens.on ? 1 : 0) - lens.k) * 0.22;
        drawLens();
        ctx.drawImage(routeLayer, 0, 0, W, H);
        if (!reduce) drawRunners(dt);
      }
      if (running && inView && !document.hidden && (!reduce || !introDone || lens.k > 0.01 && lens.k < 0.99)) raf = requestAnimationFrame(frameFn);
      else if (reduce) staticFrame();
    }
    function staticFrame() {
      ctx.clearRect(0, 0, W, H);
      if (washReady) { ctx.globalAlpha = WASH; ctx.drawImage(wash, 0, 0, W, H); ctx.globalAlpha = 1; }
      ctx.drawImage(inkLayer, 0, 0, W, H); drawLens(); ctx.drawImage(routeLayer, 0, 0, W, H);
    }
    function kick() { if (!raf && running) { last = 0; raf = requestAnimationFrame(frameFn); } }

    function start() {
      if (!setup()) return;
      makeRunners();
      if (reduce) { drawCellsUpTo(1); paintRouteLayer(); introDone = true; }
      // the ink starts to spread once a good part of the picture is on screen
      var first = onVisible(canvas, function (v) {
        if (v && !running) { running = true; kick(); if (first) first.disconnect(); }
      }, { threshold: 0.3 });
      if (!first) { running = true; kick(); }
    }

    // pointer lens
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      lens.x = e.clientX - r.left; lens.y = e.clientY - r.top;
    }
    canvas.addEventListener('pointerenter', function (e) { pos(e); lens.on = true; kick(); });
    canvas.addEventListener('pointermove', function (e) { pos(e); lens.on = true; kick(); if (reduce) frameFn(performance.now()); });
    canvas.addEventListener('pointerleave', function () { lens.on = false; kick(); if (reduce) frameFn(performance.now()); });
    canvas.addEventListener('pointerdown', function (e) { pos(e); lens.on = true; kick(); });
    canvas.addEventListener('pointerup', function (e) { if (e.pointerType !== 'mouse') { lens.on = false; kick(); } });

    // legend focus
    var legend = Array.prototype.slice.call(document.querySelectorAll('.hero-legend button'));
    legend.forEach(function (b) {
      b.setAttribute('aria-pressed', 'false');
      function set(m) {
        focus = m;
        legend.forEach(function (x) { x.setAttribute('aria-pressed', String(x.dataset.m === m)); });
        if (introDone) { paintRouteLayer(); kick(); if (reduce) frameFn(performance.now()); }
      }
      b.addEventListener('mouseenter', function () { if (!b.dataset.locked) set(b.dataset.m); });
      b.addEventListener('mouseleave', function () { if (!legend.some(function (x) { return x.dataset.locked; })) set(null); });
      b.addEventListener('click', function () {
        var was = b.dataset.locked;
        legend.forEach(function (x) { delete x.dataset.locked; });
        if (!was) { b.dataset.locked = '1'; set(b.dataset.m); } else set(null);
      });
    });

    onVisible(canvas, function (v) { inView = v; if (v) kick(); }, { threshold: 0 });
    document.addEventListener('visibilitychange', kick);
    var rz = 0;
    window.addEventListener('resize', function () {
      clearTimeout(rz);
      rz = setTimeout(function () {
        var w = Math.round(frame.getBoundingClientRect().width);
        if (w === W) return;
        setup(); drawCellsUpTo(1); paintRouteLayer(); introDone = true; kick();
        if (reduce) frameFn(performance.now());
      }, 150);
    });

    var go = function () { start(); };
    if (document.fonts && document.fonts.load) {
      Promise.race([document.fonts.load('12px "Ink Mono"'), new Promise(function (r) { setTimeout(r, 900); })]).then(go, go);
    } else go();
  }

  /* ---------------- six skies ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('.skies'), function (box) {
    var imgs = box.querySelectorAll('.skies-stage img'), tabs = box.querySelectorAll('.skies-pick button');
    var cur = 0, timer = 0, auto = !reduce, seen = false;
    function show(i) {
      cur = i;
      Array.prototype.forEach.call(imgs, function (im, k) { im.classList.toggle('on', k === i); if (k === i) im.loading = 'eager'; });
      Array.prototype.forEach.call(tabs, function (t, k) { t.setAttribute('aria-selected', String(k === i)); t.tabIndex = k === i ? 0 : -1; });
    }
    Array.prototype.forEach.call(tabs, function (t, k) {
      t.addEventListener('click', function () { auto = false; clearInterval(timer); show(k); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          var n = (cur + (e.key === 'ArrowRight' ? 1 : imgs.length - 1)) % imgs.length;
          auto = false; clearInterval(timer); show(n); tabs[n].focus();
        }
      });
    });
    onVisible(box, function (v) {
      clearInterval(timer);
      if (v && !seen) { seen = true; Array.prototype.forEach.call(imgs, function (im) { im.loading = 'eager'; }); }
      if (v && auto) timer = setInterval(function () { show((cur + 1) % imgs.length); }, 3600);
    }, { threshold: 0.4 });
    show(0);
  });

  /* ---------------- route lock schematic ---------------- */
  (function lock() {
    var fig = document.querySelector('.lock');
    if (!fig) return;
    var svgs = fig.querySelectorAll('svg');
    var A = svgs[0], B = svgs[1];
    var NS = 'http://www.w3.org/2000/svg';
    var robA = A.querySelector('.robot'), robB = B.querySelector('.robot');
    var noteA = A.querySelector('.lock-note'), noteB = B.querySelector('.lock-note');
    var rect = B.querySelector('.rectified');
    var L = rect.getTotalLength();
    // exploration traces in action space: they wander near the route and stop at the obstacle
    var tg = A.querySelector('.trace-group');
    for (var k = 0; k < 5; k++) {
      var d = 'M30 100', amp = 4 + k * 2.2, ph = k * 1.7;
      for (var x = 34; x <= 270; x += 4) d += ' L' + x + ' ' + (100 + amp * Math.sin(x / (17 + k * 3) + ph) * Math.min(1, (x - 30) / 60)).toFixed(1);
      var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('class', 'trace'); tg.appendChild(p);
    }
    var T = 7.2, t0 = 0, raf = 0, inView = false;
    function place(g, x, y, ang) { g.setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') rotate(' + ang.toFixed(1) + ')'); }
    function step(now) {
      raf = 0;
      if (!t0) t0 = now;
      var t = ((now - t0) / 1000) % T, u = Math.min(1, t / 5.2);
      // A: tracks the planned route with small wobble, halts in front of the obstacle
      var xa = 30 + Math.min(1, u * 1.25) * (262 - 30);
      var ya = 100 + 3 * Math.sin(xa / 14) * Math.min(1, (xa - 30) / 60) * (xa < 255 ? 1 : 0.2);
      place(robA, xa, ya, 9 * Math.cos(xa / 14));
      noteA.classList.toggle('show', u * 1.25 >= 1);
      // B: follows the rectified route to the door
      var s = u * L, p = rect.getPointAtLength(s), q = rect.getPointAtLength(Math.min(L, s + 2));
      place(robB, p.x, p.y, Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI);
      noteB.classList.toggle('show', u >= 1);
      rect.style.strokeDasharray = L; rect.style.strokeDashoffset = Math.max(0, L - (u * 1.6) * L);
      if (inView) raf = requestAnimationFrame(step);
    }
    if (reduce) {
      place(robA, 262, 100, 0); noteA.classList.add('show');
      var e = rect.getPointAtLength(L); place(robB, e.x - 8, e.y, 0); noteB.classList.add('show');
      return;
    }
    onVisible(fig, function (v) { inView = v; if (v && !raf) raf = requestAnimationFrame(step); }, { threshold: 0.2 });
  })();

  /* ---------------- two-frame flips (DeRoute approaching, passing) ---------------- */
  function flipper(box, getImgs, period) {
    var timer = 0, i = 0;
    function tick() {
      var imgs = getImgs();
      if (!imgs) return;
      i = 1 - i;
      imgs[0].classList.toggle('on', i === 0);
      imgs[1].classList.toggle('on', i === 1);
    }
    return {
      start: function () { if (!timer && !reduce) timer = setInterval(tick, period); },
      stop: function () { clearInterval(timer); timer = 0; },
      reset: function () { i = 1; tick(); }
    };
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-flip]'), function (box) {
    var imgs = box.querySelectorAll('img');
    var f = flipper(box, function () { return imgs; }, 1700);
    onVisible(box, function (v) { if (v) f.start(); else f.stop(); }, { threshold: 0.3 });
  });

  /* ---------------- case gallery ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('.case'), function (card, n) {
    var media = card.querySelector('.case-media');
    var fa = media.querySelector('.fa'), fb = media.querySelector('.fb'), fc = media.querySelector('.fc');
    var btns = card.querySelectorAll('.case-switch button');
    var mode = 'ours', vis = false;
    var f = flipper(media, function () { return mode === 'ours' ? [fa, fb] : null; }, 1500 + (n % 3) * 170);
    function set(m) {
      mode = m;
      Array.prototype.forEach.call(btns, function (b) { b.setAttribute('aria-pressed', String(b.dataset.mode === m)); });
      if (m === 'res') { f.stop(); fa.classList.remove('on'); fb.classList.remove('on'); fc.classList.add('on'); }
      else { fc.classList.remove('on'); f.reset(); if (vis) f.start(); }
    }
    Array.prototype.forEach.call(btns, function (b) { b.addEventListener('click', function () { set(b.dataset.mode); }); });
    onVisible(media, function (v) { vis = v; if (v && mode === 'ours') f.start(); else f.stop(); }, { threshold: 0.4 });
  });
  var more = document.getElementById('more-cases'), grid = document.getElementById('cases');
  if (more && grid) more.addEventListener('click', function () {
    var open = grid.classList.toggle('show-all');
    more.setAttribute('aria-expanded', String(open));
    more.textContent = open ? 'Show fewer cases' : 'Show all 18 cases';
    if (!open) grid.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  });

  /* ---------------- results bars ---------------- */
  var bars = document.querySelector('.bars');
  if (bars && !reduce && 'IntersectionObserver' in window) {
    bars.classList.add('is-waiting');
    var io = onVisible(bars, function (v) { if (v) { bars.classList.remove('is-waiting'); io && io.disconnect(); } }, { threshold: 0.35 });
  }

  /* ---------------- videos: play only while visible ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('video[data-play]'), function (v) {
    if (reduce) { v.controls = true; return; }
    onVisible(v, function (vis) {
      if (vis) { if (v.preload === 'none') v.preload = 'auto'; var p = v.play(); if (p && p.catch) p.catch(function () { v.controls = true; }); }
      else v.pause();
    }, { threshold: 0.25 });
  });

  /* ---------------- figure zoom ---------------- */
  var dlg = document.getElementById('zoom');
  if (dlg && dlg.showModal) {
    var zimg = dlg.querySelector('img');
    Array.prototype.forEach.call(document.querySelectorAll('.zoomable > img'), function (im) {
      im.tabIndex = 0;
      im.setAttribute('role', 'button');
      function open() { zimg.src = im.currentSrc || im.src; zimg.alt = im.alt; dlg.showModal(); }
      im.addEventListener('click', open);
      im.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    dlg.addEventListener('click', function (e) { if (e.target === dlg || e.target.classList.contains('zoom-body')) dlg.close(); });
  }
})();
