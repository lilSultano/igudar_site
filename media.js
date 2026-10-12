/* No media source is attached until an eligible preview or a user asks for it. */
(() => {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const desktop = matchMedia('(pointer: fine) and (min-width: 901px)');
    const players = [];
    // Without the Network Information API (Safari, Firefox) only desktops autoplay.
    const canAutoplay = () => !reducedMotion.matches && (connection
        ? !connection.saveData && connection.effectiveType === '4g' && connection.downlink >= 1.5 &&
            (!connection.rtt || connection.rtt < 300)
        : desktop.matches);
    const slowLink = () => !!connection && (connection.saveData || /2g|3g/.test(connection.effectiveType || ''));
    const messages = {
        it: { play: 'Riproduci video', pause: 'Pausa', cancel: 'Annulla', retry: 'Riprova', loading: 'Caricamento…', error: 'Video non disponibile. Puoi riprovare.' },
        en: { play: 'Play video', pause: 'Pause', cancel: 'Cancel', retry: 'Retry', loading: 'Loading…', error: 'Video unavailable. You can try again.' }
    };
    const lang = () => document.documentElement.lang === 'en' ? 'en' : 'it';
    // Posters are small; fetch them a little before the frame scrolls in so it never flashes empty.
    const posterObserver = 'IntersectionObserver' in window && new IntersectionObserver((entries, observer) => entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const video = entry.target.querySelector('video');
        if (video.dataset.poster && !video.poster) video.poster = video.dataset.poster;
        observer.unobserve(entry.target);
    }), { rootMargin: '600px 0px' });
    document.querySelectorAll('[data-media]').forEach(frame => {
        const video = frame.querySelector('video');
        const playbackRate = Number(video.dataset.playbackRate) || 1;
        video.defaultPlaybackRate = playbackRate;
        video.playbackRate = playbackRate;
        const button = frame.querySelector('.media-toggle');
        const label = button.querySelector('[data-media-label]');
        const status = frame.querySelector('.media-status');
        const expand = frame.querySelector('.validation-expand');
        const marks = (frame.dataset.chapters || '').split(',').filter(Boolean).map(Number);
        const chapters = [...frame.querySelectorAll('[data-chapter]')];
        let state = 'idle', visible = false, timer, request = 0, frameLoop = 0, pendingSeek = null, fallback = null;
        let autoAttempted = false, userPaused = false, manuallyStarted = false, suspended = false;
        // Smallest file that still fills the frame: 540p / 720p / 1080p by rendered pixels.
        const pick = () => {
            const { src: hd, srcSd: sd, srcLow: low } = video.dataset;
            if (!sd) return hd;
            if (slowLink()) return low || sd;
            const px = frame.clientWidth * (devicePixelRatio || 1);
            return px > 1400 ? hd : px > 1000 || !low ? sd : low;
        };
        function paint() {
            if (!chapters.length) return;
            const t = pendingSeek ?? (video.currentTime || 0);
            const end = video.duration || Number(frame.dataset.duration) || marks[marks.length - 1] + 1;
            chapters.forEach((chip, i) => {
                const from = marks[i], to = marks[i + 1] ?? end;
                const active = t >= from && (i === chapters.length - 1 || t < to);
                chip.style.setProperty('--p', to > from ? Math.min(1, Math.max(0, (t - from) / (to - from))).toFixed(4) : 0);
                if (active !== chip.hasAttribute('aria-current')) chip.toggleAttribute('aria-current', active);
            });
        }
        function tick() {
            paint();
            frameLoop = state === 'playing' ? requestAnimationFrame(tick) : 0;
        }
        function render() {
            const words = messages[lang()];
            label.textContent = words[state === 'playing' ? 'pause' : state === 'loading' ? 'cancel' : state === 'error' ? 'retry' : 'play'];
            button.firstElementChild.textContent = state === 'playing' ? 'Ⅱ' : state === 'loading' ? '×' : '▷';
            // Automatic starts load silently behind the poster; only a requested video reports progress.
            status.textContent = state === 'loading' && manuallyStarted ? words.loading : state === 'error' ? words.error : '';
            video.classList.toggle('is-ready', state === 'playing' || state === 'paused');
            // 'queued' = an automatic start is still expected, so the idle frame keeps compact controls.
            frame.dataset.state = state === 'idle' && frame.dataset.auto && !autoAttempted && !userPaused && canAutoplay() ? 'queued' : state;
            if (chapters.length && state === 'playing' && !frameLoop) frameLoop = requestAnimationFrame(tick);
            paint();
        }
        function load(src) {
            video.src = src;
            video.load();
        }
        function seek(t) {
            if (video.readyState >= 1) video.currentTime = t;
            else pendingSeek = t;
        }
        function stop(next = 'paused', release = false) {
            request++;
            clearTimeout(timer);
            video.pause();
            if (release) {
                fallback = null;
                video.removeAttribute('src');
                video.load();
            }
            state = next;
            render();
        }
        function start(manual = false, src) {
            if (state === 'playing' || state === 'loading') return;
            if (!manual && (!visible || document.hidden || !canAutoplay() || userPaused)) {
                // A deferred automatic start that no longer applies may try again on the next visit.
                if (!userPaused) autoAttempted = false;
                render();
                return;
            }
            manuallyStarted = manual;
            userPaused = false;
            suspended = false;
            state = 'loading';
            render();
            const id = ++request;
            if (!video.hasAttribute('src')) load(src || pick());
            video.muted = true;
            video.playbackRate = playbackRate;
            // Automatic loading is bounded. A user-requested original can finish
            // buffering at full quality, however slow the connection is.
            if (!manual) timer = setTimeout(() => { if (id === request) stop('idle', true); }, 6000);
            video.play().catch(() => {
                if (id === request && !fallback) stop(manual ? 'error' : 'idle', true);
            });
        }
        // Fullscreen upgrade: swap in the 1080p file in place, keeping position and play state.
        function upgrade() {
            const hd = video.dataset.src, current = video.getAttribute('src');
            if (!video.dataset.srcSd || !current || current === hd || slowLink()) return;
            const t = video.currentTime, resume = !video.paused;
            const restore = src => {
                pendingSeek = t;
                load(src);
                if (resume) video.play().catch(() => {});
            };
            manuallyStarted = true;
            clearTimeout(timer);
            fallback = () => restore(current);
            restore(hd);
        }
        video.addEventListener('loadedmetadata', () => {
            if (pendingSeek !== null) { video.currentTime = pendingSeek; pendingSeek = null; }
            paint();
        });
        video.addEventListener('loadeddata', () => { fallback = null; });
        video.addEventListener('playing', () => {
            // In fullscreen only the native controls exist, so any play there is the user's.
            const full = document.fullscreenElement === video || !!video.webkitDisplayingFullscreen;
            if (full) { userPaused = false; manuallyStarted = true; }
            if ((!visible && !full) || document.hidden || userPaused) { stop(); return; }
            clearTimeout(timer);
            state = 'playing';
            render();
        });
        video.addEventListener('pause', () => {
            if (state === 'playing') { state = 'paused'; render(); }
        });
        video.addEventListener('waiting', () => {
            if (state !== 'playing') return;
            state = 'loading';
            render();
            clearTimeout(timer);
            if (!manuallyStarted) timer = setTimeout(() => stop('idle', true), 10000);
        });
        video.addEventListener('error', () => {
            if (fallback) { const retry = fallback; fallback = null; retry(); return; }
            if (video.hasAttribute('src')) stop(manuallyStarted ? 'error' : 'idle', true);
        });
        if (chapters.length) {
            video.addEventListener('timeupdate', () => { if (!frameLoop) paint(); });
            video.addEventListener('seeked', paint);
            chapters.forEach((chip, i) => chip.addEventListener('click', () => {
                seek(marks[i]);
                if (state === 'loading') { manuallyStarted = true; clearTimeout(timer); }
                else if (state !== 'playing') start(true);
                paint();
            }));
        }
        button.hidden = false;
        button.addEventListener('click', () => {
            if (state === 'playing' || state === 'loading') {
                userPaused = true;
                stop(state === 'loading' ? 'idle' : 'paused', state === 'loading');
            } else start(true);
        });
        const player = {
            suspend() {
                if (state !== 'loading' && state !== 'playing') return;
                suspended = !userPaused;
                stop(state === 'loading' ? 'idle' : 'paused', state === 'loading');
            },
            // Back on screen or in the foreground: continue what was interrupted, never what the user paused.
            resume() {
                if (userPaused || !visible || document.hidden) return;
                if (suspended) {
                    if (manuallyStarted && state === 'paused') start(true);
                    else if (canAutoplay()) start();
                    else suspended = false;
                } else if (frame.dataset.auto && !autoAttempted && canAutoplay()) {
                    autoAttempted = true;
                    start();
                }
            },
            restrict() { if (!canAutoplay() && !manuallyStarted) stop('idle', true); }
        };
        players.push(player);
        if (expand && (video.requestFullscreen || video.webkitEnterFullscreen)) {
            document.addEventListener('fullscreenchange', () => {
                video.controls = document.fullscreenElement === video;
                if (video.controls) upgrade();
            });
            video.addEventListener('webkitbeginfullscreen', () => { video.controls = true; });
            video.addEventListener('webkitendfullscreen', () => { video.controls = false; });
            expand.hidden = false;
            expand.addEventListener('click', () => {
                if (video.requestFullscreen) {
                    // Start with the usual file; fullscreenchange upgrades it once fullscreen really engages.
                    if (!video.hasAttribute('src')) start(true);
                    video.requestFullscreen().catch(() => {});
                    return;
                }
                // iOS: native player, keep the lighter file (swapping src there exits fullscreen).
                if (!video.hasAttribute('src')) start(true);
                try { video.webkitEnterFullscreen(); }
                catch { video.addEventListener('loadedmetadata', () => { try { video.webkitEnterFullscreen(); } catch {} }, { once: true }); }
            });
        }
        if ('IntersectionObserver' in window) {
            posterObserver.observe(frame);
            new IntersectionObserver(entries => {
                visible = entries[0].isIntersecting && entries[0].intersectionRatio >= 0.15;
                if (!visible) {
                    if (document.fullscreenElement !== video && !video.webkitDisplayingFullscreen) player.suspend();
                    return;
                }
                if (video.dataset.poster && !video.poster) video.poster = video.dataset.poster;
                if (suspended) { player.resume(); return; }
                if (frame.dataset.auto && !autoAttempted && canAutoplay()) {
                    autoAttempted = true;
                    const poster = frame.querySelector('img');
                    const schedule = () => {
                        if ('requestIdleCallback' in window) requestIdleCallback(() => start(), { timeout: 1500 });
                        else setTimeout(() => start(), 300);
                    };
                    if (!poster || poster.complete) schedule();
                    else poster.addEventListener('load', schedule, { once: true });
                }
            }, { threshold: 0.15 }).observe(frame);
        } else {
            visible = true;
            if (video.dataset.poster) video.poster = video.dataset.poster;
        }
        new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
        render();
    });
    document.addEventListener('visibilitychange', () => players.forEach(p => document.hidden ? p.suspend() : p.resume()));
    reducedMotion.addEventListener('change', () => players.forEach(p => p.restrict()));
    connection?.addEventListener('change', () => players.forEach(p => p.restrict()));
})();
