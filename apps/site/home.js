/* global document, window, IntersectionObserver, Node */
// SudoWall home: scroll story with GSAP + ScrollTrigger (vendored, no outside requests).
(() => {
  'use strict';

  // Optional demo video: paste a youtube-nocookie embed URL here.
  const VIDEO_URL = '';
  if (VIDEO_URL.startsWith('https://www.youtube-nocookie.com/embed/')) {
    const slot = document.getElementById('video');
    slot.querySelector('iframe').src = VIDEO_URL;
    slot.hidden = false;
  }

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  // Rail: highlight the chapter in view (works with or without GSAP).
  const railLinks = new Map($$('[data-rail]').map((a) => [a.dataset.rail, a]));
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of railLinks.values()) a.classList.remove('on');
        railLinks.get(e.target.dataset.section)?.classList.add('on');
      }
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );
  $$('[data-section]').forEach((s) => io.observe(s));

  // Split the problem statement into words for the scrubbed reveal.
  const reveal = $('[data-reveal]');
  const wrapWords = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const part of child.textContent.split(/(\s+)/)) {
          if (part.trim() === '') frag.append(part);
          else {
            const w = document.createElement('span');
            w.className = 'w';
            w.textContent = part;
            frag.append(w);
          }
        }
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        wrapWords(child);
      }
    }
  };
  if (reveal) wrapWords(reveal);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const gsap = window.gsap;
  if (reduced || !gsap || !window.ScrollTrigger) {
    // Static page: everything readable, the hidden line shown.
    $$('.reveal-text .w').forEach((w) => (w.style.opacity = '1'));
    const hidden = $('[data-hidden]');
    if (hidden) {
      hidden.style.color = '#111';
      hidden.style.background = '#fbdcc8';
    }
    $$('[data-step]').forEach((s) => s.classList.add('lit'));
    return;
  }

  const ScrollTrigger = window.ScrollTrigger;
  gsap.registerPlugin(ScrollTrigger);
  gsap.defaults({ ease: 'power3.out', duration: 0.9 });

  // Count a number up when it comes into view.
  const countUp = (el) => {
    const end = Number(el.dataset.count);
    const o = { v: 0 };
    gsap.to(o, {
      v: end,
      duration: 1.4,
      ease: 'power2.out',
      onUpdate: () => (el.textContent = String(Math.round(o.v))),
      scrollTrigger: { trigger: el, start: 'top 90%', once: true },
    });
  };
  $$('[data-count]').forEach(countUp);

  // 01 hero: one orchestrated entrance.
  const intro = gsap.timeline({ defaults: { duration: 1 } });
  intro
    .from('.hero-title .line > span', { yPercent: 110, stagger: 0.12, ease: 'power4.out' })
    .from('[data-hero]:not(.hero-title)', { y: 30, opacity: 0, stagger: 0.1 }, '-=0.6')
    .from(
      '[data-tile]',
      {
        y: 80,
        scale: 0.86,
        rotate: (i) => (i % 2 ? 6 : -6),
        opacity: 0,
        stagger: 0.12,
        ease: 'back.out(1.6)',
      },
      '-=0.7',
    )
    .from('.topbar > *', { y: -30, opacity: 0, stagger: 0.08 }, 0.2)
    .from('.rail', { x: -120, duration: 1.1 }, 0);

  // The blobs breathe, and drift as you scroll away.
  gsap.to('.blob-a', {
    borderRadius: '58% 42% 38% 62% / 55% 60% 40% 45%',
    scale: 1.06,
    duration: 6,
    ease: 'sine.inOut',
    repeat: -1,
    yoyo: true,
  });
  gsap.to('.blob-b', { rotate: 40, duration: 9, ease: 'sine.inOut', repeat: -1, yoyo: true });
  gsap.to('.blob-a', {
    yPercent: 30,
    ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
  });
  gsap.to('[data-tile]', {
    y: (i) => -40 - i * 18,
    ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
  });

  // 02 problem: words light up as you read.
  gsap.to('.reveal-text .w', {
    opacity: 1,
    stagger: 0.04,
    ease: 'none',
    scrollTrigger: { trigger: '.problem', start: 'top 70%', end: 'bottom 75%', scrub: true },
  });

  const mm = gsap.matchMedia();

  // Wide screens: pinned scenes.
  mm.add('(min-width: 721px)', () => {
    // 03 how it works: a tool call travels through the four checks.
    const steps = $$('[data-step]');
    const how = gsap.timeline({
      scrollTrigger: {
        trigger: '.how',
        pin: '.how-pin',
        start: 'top top',
        end: '+=220%',
        scrub: 0.6,
        onUpdate: (st) => {
          const lit = Math.min(steps.length, Math.floor(st.progress * (steps.length + 0.4)));
          steps.forEach((s, i) => s.classList.toggle('lit', i < lit));
        },
      },
    });
    how
      .to('.track-fill', { scaleX: 1, ease: 'none' }, 0)
      .to(
        '.token',
        {
          x: () => $('.track').offsetWidth - $('.token').offsetWidth,
          ease: 'none',
        },
        0,
      )
      .from('[data-step]', { y: 60, opacity: 0, stagger: 0.12, duration: 0.3 }, 0);

    // 04 the attack: the hidden line is exposed, then each decision lands.
    const attack = gsap.timeline({
      scrollTrigger: {
        trigger: '.attack',
        pin: '.attack-pin',
        start: 'top top',
        end: '+=240%',
        scrub: 0.6,
      },
    });
    attack
      .to('[data-hidden]', { color: '#111111', backgroundColor: '#fbdcc8', duration: 0.6 })
      .from('[data-hidden-note]', { opacity: 0, y: 12, duration: 0.4 }, '<0.2')
      .from('[data-verdict]', {
        x: 120,
        opacity: 0,
        rotate: 4,
        stagger: 0.6,
        duration: 0.6,
        ease: 'back.out(1.4)',
      });
  });

  // Phones: the same story without pinning.
  mm.add('(max-width: 720px)', () => {
    $$('[data-step]').forEach((s) => {
      gsap.from(s, { y: 40, opacity: 0, scrollTrigger: { trigger: s, start: 'top 88%' } });
      ScrollTrigger.create({ trigger: s, start: 'top 70%', onEnter: () => s.classList.add('lit') });
    });
    gsap.to('[data-hidden]', {
      color: '#111111',
      backgroundColor: '#fbdcc8',
      scrollTrigger: { trigger: '.email', start: 'top 60%' },
    });
    $$('[data-verdict]').forEach((v) =>
      gsap.from(v, { x: 60, opacity: 0, scrollTrigger: { trigger: v, start: 'top 88%' } }),
    );
  });

  // 05 the app: the dashboard assembles itself.
  const app = gsap.timeline({ scrollTrigger: { trigger: '[data-mock]', start: 'top 80%' } });
  app
    .from('[data-mock]', { y: 100, scale: 0.94, opacity: 0, duration: 1.1 })
    .from('[data-mcard]', { y: 40, opacity: 0, stagger: 0.1, ease: 'back.out(1.5)' }, '-=0.5')
    .from('[data-mrow]', { x: -30, opacity: 0, stagger: 0.12 }, '-=0.4');

  // 06 works with.
  gsap.from('[data-wtile]', {
    y: 60,
    opacity: 0,
    rotate: (i) => (i % 2 ? 3 : -3),
    stagger: { each: 0.07, from: 'start' },
    ease: 'back.out(1.4)',
    scrollTrigger: { trigger: '.logos', start: 'top 82%' },
  });

  // 07 the terminal types itself once it is visible.
  const term = $('[data-term]');
  if (term) {
    const typed = $$('[data-type]', term);
    const outs = $$('[data-out]', term);
    typed.forEach((t) => (t.textContent = ''));
    gsap.set(outs, { opacity: 0 });
    const tl = gsap.timeline({ paused: true });
    let o = 0;
    typed.forEach((t, i) => {
      const text = t.dataset.type;
      const st = { n: 0 };
      tl.to(st, {
        n: text.length,
        duration: text.length * 0.035,
        ease: 'none',
        onUpdate: () => (t.textContent = text.slice(0, Math.round(st.n))),
      });
      const count = i === 1 ? 3 : 1;
      for (let k = 0; k < count && o < outs.length; k++, o++) {
        tl.to(outs[o], { opacity: 1, duration: 0.25 }, k === 0 ? '+=0.25' : '+=0.15');
      }
    });
    ScrollTrigger.create({ trigger: term, start: 'top 80%', once: true, onEnter: () => tl.play() });
    gsap.from('.start-panel', {
      y: 80,
      scale: 0.96,
      opacity: 0,
      scrollTrigger: { trigger: '.start-panel', start: 'top 85%' },
    });
  }
})();
