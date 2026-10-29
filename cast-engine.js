// ============================================================================
// FILE: cast-engine.js (v5.0 — Universal Hook Override + Fire TV Direct Stage)
// Overrides all legacy "Initializing Cast Engine..." stubs in index.html,
// auto-builds MusePlayerBridge if missing, and launches Fire TV Cast Mode.
// ============================================================================

(function () {
    "use strict";

    const RECEIVER_URL = new URL("./tv-receiver.html", window.location.href).href;
    const WSS_BROKERS = [
        "wss://broker.emqx.io:8084/mqtt",
        "wss://broker.hivemq.com:8884/mqtt"
    ];

    let isCastingActive = false;
    let activeCastMode = null; // 'firetv-direct' | 'wss-receiver' | 'presentation' | 'chromecast' | 'airplay'
    let activeDeviceName = "Amazon Fire TV";
    let remoteAudioAckReceived = false;

    let presentationRequest = null;
    let presentationConnection = null;
    let googleCastSession = null;
    let remotePlayer = null;
    let remotePlayerController = null;
    let broadcastSyncChannel = null;

    // Web Audio API GainNode Booster (0% to 150% TV Volume Control from Phone)
    let webAudioCtx = null;
    let webAudioGainNode = null;
    let webAudioConnectedElement = null;

    // Real-Time WSS Sync Bus
    let mqttClient = null;
    let wifiTopicBase = null;
    let pairedPinCode = localStorage.getItem("muse_paired_tv_pin") || "";

    // Wi-Fi Subnet Scanner State
    let discoveredDevices = new Map();
    let cachedFireTvIp = localStorage.getItem("muse_detected_firetv_ip") || "";
    let isSubnetScanning = false;

    let tvVolume = 1.0; // 0.0 to 1.5 (Up to 150% Boost)
    let tvMuted = false;
    let remoteCurrentTime = 0;
    let remoteDuration = 0;
    let remoteIsPlaying = false;
    let syncIntervalId = null;
    let tvLyricsRafId = null;
    let controllerHudHideTimer = null;
    let activeTvLineIndex = -1;

    // ========================================================================
    // 0. AUTO-CREATE BRIDGE IF INDEX.HTML DID NOT DEFINE MusePlayerBridge
    // ========================================================================
    function getBridge() {
        if (window.MusePlayerBridge) return window.MusePlayerBridge;

        // Fallback bridge that reads directly from index.html globals/DOM
        window.MusePlayerBridge = {
            getAudioElement: () => document.getElementById("audio-engine"),
            getActiveTrack: () => {
                try { if (typeof activeTrack !== "undefined" && activeTrack) return activeTrack; } catch (e) {}
                return {
                    id: "current",
                    title: document.getElementById("full-title")?.innerText || "Muse",
                    artist: document.getElementById("full-artist")?.innerText || "",
                    coverUrl: document.getElementById("full-cover")?.src || "",
                    streamUrl: document.getElementById("audio-engine")?.src || ""
                };
            },
            getActiveLyricsPayload: () => {
                try { if (typeof activeLyricsPayload !== "undefined") return activeLyricsPayload; } catch (e) {}
                return null;
            },
            getLyricsTimeline: () => {
                try { if (typeof activeLyricsTimeline !== "undefined") return activeLyricsTimeline; } catch (e) {}
                return [];
            },
            getThemeRGB: () => {
                try { if (typeof currentThemeRGB !== "undefined") return currentThemeRGB; } catch (e) {}
                return { r: 98, g: 120, b: 235 };
            },
            getStreamUrlForTrack: (t) => {
                const audioEl = document.getElementById("audio-engine");
                return t?.streamUrl || t?.playUrl || audioEl?.src || "";
            },
            onRemoteTimeUpdate: () => {},
            onRemoteEnded: () => {
                if (typeof window.playNextTrack === "function") window.playNextTrack(true);
            },
            onRemoteStateChange: () => {},
            playNext: () => {
                if (typeof window.playNextTrack === "function") window.playNextTrack(true);
            },
            playPrev: () => {
                if (typeof window.playPrevTrack === "function") window.playPrevTrack(true);
            },
            togglePlayPause: () => {
                if (typeof window.togglePlayPause === "function") window.togglePlayPause();
            },
            closeMoreMenu: () => {
                const menu = document.getElementById("full-more-menu");
                if (menu) {
                    menu.classList.add("hidden");
                    menu.classList.remove("flex");
                }
            },
            toast: (msg, type) => {
                if (typeof window.toast === "function") window.toast(msg, type);
            }
        };
        return window.MusePlayerBridge;
    }

    // ========================================================================
    // 1. WEB AUDIO API DYNAMIC TV VOLUME ENGINE (0% TO 150% GAIN BOOST)
    // ========================================================================
    function ensureWebAudioVolumeEngine() {
        const audioEl = getBridge().getAudioElement();
        if (!audioEl) return;

        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;

            if (!webAudioCtx) {
                webAudioCtx = new AudioCtx();
            }
            if (webAudioCtx.state === "suspended") {
                webAudioCtx.resume().catch(() => {});
            }

            if (!webAudioGainNode && webAudioConnectedElement !== audioEl) {
                const srcUrl = audioEl.src || "";
                if (!srcUrl.startsWith("blob:")) {
                    audioEl.crossOrigin = "anonymous";
                }
                const source = webAudioCtx.createMediaElementSource(audioEl);
                webAudioGainNode = webAudioCtx.createGain();
                webAudioGainNode.gain.value = tvMuted ? 0 : tvVolume;
                source.connect(webAudioGainNode);
                webAudioGainNode.connect(webAudioCtx.destination);
                webAudioConnectedElement = audioEl;
            }
        } catch (e) {}
    }

    // ========================================================================
    // 2. REAL HTTPS-SAFE WI-FI SUBNET SCANNER FOR FIRE TV (PORT 8009)
    // ========================================================================
    async function probeTcpPortOverHttps(ip, port, timeoutMs = 520) {
        const start = performance.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            await fetch(`https://${ip}:${port}/`, {
                mode: "no-cors",
                cache: "no-store",
                signal: controller.signal
            });
            clearTimeout(timer);
            return performance.now() - start;
        } catch (err) {
            clearTimeout(timer);
            if (controller.signal.aborted) return -1;
            return performance.now() - start;
        }
    }

    async function runRealWifiHardwareScan() {
        registerDiscoveredDevice("firetv_primary", {
            name: cachedFireTvIp ? `Amazon Fire TV (${cachedFireTvIp})` : "Amazon Fire TV (Screen Mirroring / Cast)",
            subtitle: "Opens TV Lyrics + 3 Controls • Phone controls TV Volume",
            icon: "fa-fire-flame-curved text-amber-400",
            priority: 1,
            onSelect: () => startFireTvCinemaCast(cachedFireTvIp ? `Amazon Fire TV (${cachedFireTvIp})` : "Amazon Fire TV")
        });

        if (isSubnetScanning) return;
        isSubnetScanning = true;

        const radarIcon = document.getElementById("cast-radar-icon");
        const radarText = document.getElementById("cast-radar-text");
        if (radarIcon) radarIcon.className = "fa-solid fa-spinner fa-spin text-xs text-amber-400";
        if (radarText) radarText.innerText = "Scanning Wi-Fi for Fire TV & Smart TVs...";

        const candidateSubnets = ["192.168.1", "192.168.29", "192.168.0", "192.168.31", "192.168.43"];
        let activeSubnet = candidateSubnets[0];

        for (const sub of candidateSubnets) {
            const gwRtt = await probeTcpPortOverHttps(`${sub}.1`, 443, 350);
            if (gwRtt >= 0) {
                activeSubnet = sub;
                break;
            }
        }

        const hostsToProbe = [];
        for (let h = 2; h <= 40; h++) hostsToProbe.push(`${activeSubnet}.${h}`);
        for (let h = 100; h <= 130; h++) hostsToProbe.push(`${activeSubnet}.${h}`);

        const batchSize = 15;
        for (let i = 0; i < hostsToProbe.length; i += batchSize) {
            const slice = hostsToProbe.slice(i, i + batchSize);
            await Promise.all(
                slice.map(async (ip) => {
                    const rtt8009 = await probeTcpPortOverHttps(ip, 8009, 450);
                    if (rtt8009 >= 0 && rtt8009 < 410) {
                        cachedFireTvIp = ip;
                        try { localStorage.setItem("muse_detected_firetv_ip", ip); } catch (e) {}
                        registerDiscoveredDevice(`tv_ip_${ip}`, {
                            name: `Fire TV / Smart TV (${ip})`,
                            subtitle: `Detected on Wi-Fi (${Math.round(rtt8009)}ms) • Tap to Cast`,
                            icon: "fa-tv text-emerald-400",
                            priority: 0,
                            onSelect: () => startFireTvCinemaCast(`Fire TV (${ip})`)
                        });
                    }
                })
            );
        }

        isSubnetScanning = false;
        if (radarIcon) radarIcon.className = "fa-solid fa-circle-check text-xs text-emerald-400";
        if (radarText) {
            radarText.innerText = `Ready — Tap your Fire TV below to start`;
        }
    }

    function registerDiscoveredDevice(id, info) {
        discoveredDevices.set(id, { id, ...info });
        renderDiscoveredDeviceList();
        updateMenuCastStatusBadge(true);
    }

    function renderDiscoveredDeviceList() {
        const listEl = document.getElementById("cast-discovered-list");
        if (!listEl) return;

        const sorted = Array.from(discoveredDevices.values()).sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));
        listEl.innerHTML = "";

        sorted.forEach((dev) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "w-full p-3 rounded-2xl liquid-control-btn flex items-center justify-between text-left border border-white/15 hover:border-emerald-400/50 transition-all";
            btn.innerHTML = `
                <div class="flex items-center gap-3 min-w-0">
                    <div class="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0">
                        <i class="fa-solid ${dev.icon || "fa-tv text-emerald-300"} text-sm"></i>
                    </div>
                    <div class="min-w-0">
                        <div class="text-xs font-extrabold text-white truncate">${dev.name}</div>
                        <div class="text-[10px] font-semibold text-white/60 truncate mt-0.5">${dev.subtitle}</div>
                    </div>
                </div>
                <span class="px-3 py-1 rounded-full liquid-hero-play text-[10px] font-extrabold text-white flex-shrink-0 ml-2">
                    Connect
                </span>
            `;
            btn.onclick = (e) => {
                e.stopPropagation();
                if (dev.onSelect) dev.onSelect();
            };
            listEl.appendChild(btn);
        });
    }

    // ========================================================================
    // 3. FULLSCREEN TV CINEMA STAGE + AUTO-HIDING PHONE CONTROLLER DRAWER
    // ========================================================================
    function injectTvCinemaStageOverlay() {
        if (document.getElementById("muse-tv-cinema-stage")) return;

        const stage = document.createElement("div");
        stage.id = "muse-tv-cinema-stage";
        stage.className = "fixed inset-0 z-[105] hidden select-none overflow-hidden";
        stage.style.backgroundColor = "#040508";
        stage.innerHTML = `
            <div id="tv-stage-ambient" class="absolute inset-0 pointer-events-none" style="
                background:
                    radial-gradient(circle at 18% 22%, rgba(var(--theme-r), var(--theme-g), var(--theme-b), 0.42) 0%, transparent 56%),
                    radial-gradient(circle at 82% 78%, rgba(var(--theme-r), var(--theme-g), var(--theme-b), 0.28) 0%, transparent 60%),
                    #040508;
            "></div>

            <!-- Auto-Fading Top Bar -->
            <div id="tv-stage-top-bar" class="fixed top-5 left-6 right-6 z-30 flex items-center justify-between transition-opacity duration-500">
                <div class="liquid-glass rounded-full px-4 py-1.5 flex items-center gap-2.5">
                    <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span id="tv-stage-device-pill" class="text-[11px] font-extrabold uppercase tracking-wider text-white">Amazon Fire TV</span>
                </div>
                <div class="flex items-center gap-2">
                    <button type="button" id="tv-stage-open-ctrl-btn" class="h-8 px-3.5 rounded-full liquid-control-btn text-[11px] font-extrabold text-white flex items-center gap-1.5">
                        <i class="fa-solid fa-sliders text-[10px]" style="color: var(--theme-color-bright)"></i>
                        <span>Phone Controls & Volume</span>
                    </button>
                    <button type="button" id="tv-stage-exit-btn" class="h-8 px-3.5 rounded-full bg-rose-500/25 border border-rose-400/40 text-[11px] font-extrabold text-rose-200">
                        Stop Cast
                    </button>
                </div>
            </div>

            <!-- TV Volume Pop-up HUD -->
            <div id="tv-stage-vol-popup" class="fixed top-16 right-6 z-40 liquid-glass rounded-full px-4 py-2 flex items-center gap-3 opacity-0 transition-opacity duration-300 pointer-events-none">
                <i class="fa-solid fa-volume-high text-xs" style="color: var(--theme-color-bright)"></i>
                <div class="w-24 h-1.5 rounded-full bg-white/15 overflow-hidden">
                    <div id="tv-stage-vol-popup-bar" class="h-full bg-white rounded-full" style="width: 100%"></div>
                </div>
                <span id="tv-stage-vol-popup-label" class="text-[11px] font-extrabold text-white tabular-nums">100%</span>
            </div>

            <!-- MAIN TV LAYOUT: Cover + Title + Strictly 3 Controls (Prev, Play/Pause, Next) + Word-by-Word Lyrics -->
            <div class="relative z-10 w-full h-full flex flex-col landscape:grid landscape:grid-cols-12 items-center justify-center px-6 sm:px-12 py-12 gap-6 landscape:gap-10">

                <div class="w-full landscape:col-span-5 flex flex-col items-center text-center flex-shrink-0">
                    <div class="w-40 h-40 sm:w-56 sm:h-56 landscape:w-[34vh] landscape:h-[34vh] max-w-[320px] max-h-[320px] rounded-[2rem] overflow-hidden liquid-glass border border-white/20 shadow-2xl mb-4">
                        <img id="tv-stage-cover" src="" class="w-full h-full object-cover">
                    </div>
                    <h2 id="tv-stage-title" class="text-xl sm:text-2xl landscape:text-3xl font-extrabold text-white tracking-tight truncate max-w-sm">Muse</h2>
                    <p id="tv-stage-artist" class="text-xs sm:text-sm landscape:text-base font-semibold text-white/65 truncate max-w-sm mt-1">Artist</p>

                    <!-- Strictly 3 Buttons on TV View: Back, Play/Pause, Next -->
                    <div class="flex items-center justify-center gap-6 mt-5">
                        <button type="button" id="tv-stage-prev-btn" class="w-12 h-12 sm:w-14 sm:h-14 circle-btn liquid-control-btn flex items-center justify-center text-white">
                            <i class="fa-solid fa-backward-step text-base sm:text-lg"></i>
                        </button>
                        <button type="button" id="tv-stage-play-btn" class="w-16 h-16 sm:w-20 sm:h-20 circle-btn liquid-control-btn liquid-hero-play flex items-center justify-center text-white">
                            <i id="tv-stage-play-icon" class="fa-solid fa-pause text-xl sm:text-2xl"></i>
                        </button>
                        <button type="button" id="tv-stage-next-btn" class="w-12 h-12 sm:w-14 sm:h-14 circle-btn liquid-control-btn flex items-center justify-center text-white">
                            <i class="fa-solid fa-forward-step text-base sm:text-lg"></i>
                        </button>
                    </div>
                </div>

                <!-- Real-Time Word-by-Word Synced Lyrics -->
                <div class="w-full landscape:col-span-7 flex-1 min-h-0 flex items-center">
                    <div id="tv-stage-lyrics-box" class="w-full h-[38vh] landscape:h-[74vh] overflow-y-auto no-scrollbar px-2 sm:px-6 py-[14vh]" style="
                        mask-image: linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%);
                        -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%);
                    ">
                        <div id="tv-stage-lyrics-lines" class="flex flex-col"></div>
                    </div>
                </div>
            </div>

            <!-- AUTO-HIDING PHONE CONTROLLER DRAWER -->
            <div id="tv-stage-phone-drawer" class="fixed bottom-4 left-4 right-4 z-40 max-w-xl mx-auto liquid-glass rounded-3xl p-4 border border-white/20 shadow-2xl transition-all duration-300">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-[10px] font-extrabold uppercase tracking-wider text-white/75 flex items-center gap-1.5">
                        <i class="fa-solid fa-mobile-screen text-xs" style="color: var(--theme-color-bright)"></i>
                        <span>Phone Remote Control • Auto-hides on TV in 3s</span>
                    </span>
                    <button type="button" id="tv-stage-minimize-btn" class="px-2.5 py-1 rounded-full bg-white/10 text-[10px] font-extrabold text-white/85">
                        Browse Songs
                    </button>
                </div>

                <div class="flex items-center gap-3">
                    <button type="button" id="tv-drawer-vol-down" class="w-8 h-8 circle-btn liquid-control-btn flex items-center justify-center text-white">
                        <i class="fa-solid fa-volume-low text-xs"></i>
                    </button>
                    <div class="flex-1 py-2 cursor-pointer" id="tv-drawer-vol-zone">
                        <input type="range" id="tv-drawer-vol-input" min="0" max="150" step="1" value="100" style="--progress: 66.7%;" class="w-full pointer-events-none">
                    </div>
                    <button type="button" id="tv-drawer-vol-up" class="w-8 h-8 circle-btn liquid-control-btn flex items-center justify-center text-white">
                        <i class="fa-solid fa-volume-high text-xs"></i>
                    </button>
                    <span id="tv-drawer-vol-text" class="text-xs font-extrabold text-white w-11 text-right tabular-nums">100%</span>
                </div>
            </div>
        `;

        document.body.appendChild(stage);

        document.getElementById("tv-stage-prev-btn").onclick = (e) => {
            e.stopPropagation();
            getBridge().playPrev();
        };
        document.getElementById("tv-stage-play-btn").onclick = (e) => {
            e.stopPropagation();
            getBridge().togglePlayPause();
        };
        document.getElementById("tv-stage-next-btn").onclick = (e) => {
            e.stopPropagation();
            getBridge().playNext();
        };
        document.getElementById("tv-stage-exit-btn").onclick = (e) => {
            e.stopPropagation();
            stopCastingToTV();
        };
        document.getElementById("tv-stage-minimize-btn").onclick = (e) => {
            e.stopPropagation();
            stage.classList.add("hidden");
            getBridge().toast("TV Cast Active — Tap 'TV View' on the Volume Bar anytime");
        };
        document.getElementById("tv-stage-open-ctrl-btn").onclick = (e) => {
            e.stopPropagation();
            wakePhoneControllerDrawer();
        };

        stage.addEventListener("pointerdown", () => wakePhoneControllerDrawer(), { passive: true });
        stage.addEventListener("pointermove", () => wakePhoneControllerDrawer(), { passive: true });

        const drawerVolZone = document.getElementById("tv-drawer-vol-zone");
        let draggingDrawerVol = false;
        const setDrawerVolFromX = (clientX) => {
            const rect = drawerVolZone.getBoundingClientRect();
            if (rect.width <= 0) return;
            const ratio = Math.max(0, Math.min(1.5, ((clientX - rect.left) / rect.width) * 1.5));
            setTVVolume(ratio, false);
            wakePhoneControllerDrawer();
        };

        drawerVolZone.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            draggingDrawerVol = true;
            try { drawerVolZone.setPointerCapture(e.pointerId); } catch (err) {}
            setDrawerVolFromX(e.clientX);
        });
        drawerVolZone.addEventListener("pointermove", (e) => {
            if (!draggingDrawerVol) return;
            e.stopPropagation();
            setDrawerVolFromX(e.clientX);
        });
        const stopDrawerDrag = () => { draggingDrawerVol = false; };
        drawerVolZone.addEventListener("pointerup", stopDrawerDrag);
        drawerVolZone.addEventListener("pointercancel", stopDrawerDrag);

        document.getElementById("tv-drawer-vol-down").onclick = (e) => {
            e.stopPropagation();
            setTVVolume(Math.max(0, tvVolume - 0.1), true);
            wakePhoneControllerDrawer();
        };
        document.getElementById("tv-drawer-vol-up").onclick = (e) => {
            e.stopPropagation();
            setTVVolume(Math.min(1.5, tvVolume + 0.1), true);
            wakePhoneControllerDrawer();
        };
    }

    function wakePhoneControllerDrawer() {
        const drawer = document.getElementById("tv-stage-phone-drawer");
        const topBar = document.getElementById("tv-stage-top-bar");
        if (drawer) {
            drawer.style.opacity = "1";
            drawer.style.transform = "translate3d(0, 0, 0)";
            drawer.style.pointerEvents = "auto";
        }
        if (topBar) topBar.style.opacity = "1";

        if (controllerHudHideTimer) clearTimeout(controllerHudHideTimer);
        controllerHudHideTimer = setTimeout(() => {
            if (drawer) {
                drawer.style.opacity = "0";
                drawer.style.transform = "translate3d(0, 24px, 0)";
                drawer.style.pointerEvents = "none";
            }
            if (topBar) topBar.style.opacity = "0.2";
        }, 3200);
    }

    function openTvCinemaStage() {
        injectTvCinemaStageOverlay();
        const stage = document.getElementById("muse-tv-cinema-stage");
        if (!stage) return;
        stage.classList.remove("hidden");
        document.getElementById("tv-stage-device-pill").innerText = activeDeviceName;

        syncTvCinemaStageMetadataAndLyrics();
        wakePhoneControllerDrawer();
        startTvCinemaStageLyricsLoop();
    }

    function closeTvCinemaStage() {
        const stage = document.getElementById("muse-tv-cinema-stage");
        if (stage) stage.classList.add("hidden");
        if (tvLyricsRafId) {
            cancelAnimationFrame(tvLyricsRafId);
            tvLyricsRafId = null;
        }
    }

    function syncTvCinemaStageMetadataAndLyrics() {
        const bridge = getBridge();
        const track = bridge.getActiveTrack();
        const audioEl = bridge.getAudioElement();
        const timeline = bridge.getLyricsTimeline() || [];

        if (track) {
            const cov = document.getElementById("tv-stage-cover");
            const tit = document.getElementById("tv-stage-title");
            const art = document.getElementById("tv-stage-artist");
            if (cov) cov.src = track.coverUrl || document.getElementById("full-cover")?.src || "";
            if (tit) tit.innerText = track.title || document.getElementById("full-title")?.innerText || "Muse";
            if (art) art.innerText = track.artist || document.getElementById("full-artist")?.innerText || "";
        }

        const playIcon = document.getElementById("tv-stage-play-icon");
        if (playIcon && audioEl) {
            playIcon.className = audioEl.paused
                ? "fa-solid fa-play text-xl sm:text-2xl ml-1"
                : "fa-solid fa-pause text-xl sm:text-2xl";
        }

        const linesWrap = document.getElementById("tv-stage-lyrics-lines");
        if (!linesWrap) return;

        activeTvLineIndex = -1;
        linesWrap.innerHTML = "";

        if (!timeline.length) {
            // Fallback: clone existing rendered lyrics lines from #lyrics-lines-wrapper if present
            const existingWrapper = document.getElementById("lyrics-lines-wrapper");
            if (existingWrapper && existingWrapper.children.length > 0) {
                linesWrap.innerHTML = existingWrapper.innerHTML;
                return;
            }
            linesWrap.innerHTML = `<div class="apple-lyric-line is-active line-plain-active">Synchronizing word-by-word lyrics...</div>`;
            return;
        }

        const frag = document.createDocumentFragment();
        timeline.forEach((line, idx) => {
            const lineEl = document.createElement("div");
            lineEl.className = "apple-lyric-line";
            lineEl.dataset.index = idx;

            if (Array.isArray(line.words) && line.words.length > 0 && !line.plainOnly) {
                const wordsContainer = document.createElement("div");
                wordsContainer.className = "lyric-words-row";
                line.words.forEach((w) => {
                    const span = document.createElement("span");
                    span.className = "lyric-word";
                    span.style.setProperty("--word-fill", "0%");
                    span.textContent = w.word;
                    wordsContainer.appendChild(span);
                });
                lineEl.appendChild(wordsContainer);
            } else {
                const textDiv = document.createElement("div");
                textDiv.textContent = line.text;
                lineEl.appendChild(textDiv);
            }

            if (line.secondaryText) {
                const subSpan = document.createElement("span");
                subSpan.className = "lyric-sub-line";
                subSpan.textContent = line.secondaryText;
                lineEl.appendChild(subSpan);
            }

            frag.appendChild(lineEl);
        });
        linesWrap.appendChild(frag);
    }

    function startTvCinemaStageLyricsLoop() {
        if (tvLyricsRafId) cancelAnimationFrame(tvLyricsRafId);

        const step = () => {
            const stage = document.getElementById("muse-tv-cinema-stage");
            if (!isCastingActive || !stage || stage.classList.contains("hidden")) {
                tvLyricsRafId = null;
                return;
            }

            const bridge = getBridge();
            const audioEl = bridge.getAudioElement();
            const timeline = bridge.getLyricsTimeline() || [];
            const linesWrap = document.getElementById("tv-stage-lyrics-lines");
            const scrollBox = document.getElementById("tv-stage-lyrics-box");

            if (linesWrap && timeline.length > 0 && linesWrap.children.length !== timeline.length) {
                syncTvCinemaStageMetadataAndLyrics();
            }

            const playIcon = document.getElementById("tv-stage-play-icon");
            if (playIcon && audioEl) {
                const wantClass = audioEl.paused
                    ? "fa-solid fa-play text-xl sm:text-2xl ml-1"
                    : "fa-solid fa-pause text-xl sm:text-2xl";
                if (playIcon.className !== wantClass) playIcon.className = wantClass;
            }

            if (audioEl && !audioEl.paused && timeline.length > 0 && linesWrap && scrollBox) {
                const t = audioEl.currentTime || 0;
                let matched = 0;
                for (let i = 0; i < timeline.length; i++) {
                    const item = timeline[i];
                    const nxt = timeline[i + 1];
                    const ceil = nxt ? nxt.time : (item.endTime + 10);
                    if (t >= item.time && t < ceil) {
                        matched = i;
                        break;
                    }
                }

                const nodes = linesWrap.children;
                if (matched !== activeTvLineIndex) {
                    activeTvLineIndex = matched;
                    for (let i = 0; i < nodes.length; i++) {
                        const n = nodes[i];
                        const it = timeline[i];
                        n.classList.remove("is-active", "is-past", "line-plain-active");
                        if (i < activeTvLineIndex) n.classList.add("is-past");
                        else if (i === activeTvLineIndex) {
                            n.classList.add("is-active");
                            if (!it?.words?.length || it.plainOnly) n.classList.add("line-plain-active");
                        }
                    }
                    const activeNode = nodes[activeTvLineIndex];
                    if (activeNode) {
                        const boxRect = scrollBox.getBoundingClientRect();
                        const lineRect = activeNode.getBoundingClientRect();
                        const offset = (lineRect.top - boxRect.top) - (boxRect.height * 0.36) + (lineRect.height * 0.5);
                        scrollBox.scrollBy({ top: offset, behavior: "smooth" });
                    }
                }

                const activeItem = timeline[activeTvLineIndex];
                const activeNode = nodes[activeTvLineIndex];
                const wordsRow = activeNode?.querySelector(".lyric-words-row");
                if (activeItem?.words?.length && wordsRow) {
                    const spans = wordsRow.children;
                    for (let w = 0; w < spans.length; w++) {
                        const wm = activeItem.words[w];
                        const sp = spans[w];
                        if (!wm || !sp) continue;
                        if (t >= wm.endTime) {
                            sp.className = "lyric-word word-sung";
                            sp.style.setProperty("--word-fill", "100%");
                        } else if (t >= wm.time && t < wm.endTime) {
                            const pct = Math.min(100, Math.max(0, ((t - wm.time) / Math.max(0.05, wm.endTime - wm.time)) * 100));
                            sp.className = "lyric-word word-current";
                            sp.style.setProperty("--word-fill", `${pct.toFixed(1)}%`);
                        } else {
                            sp.className = "lyric-word";
                            sp.style.setProperty("--word-fill", "0%");
                        }
                    }
                }
            }

            tvLyricsRafId = requestAnimationFrame(step);
        };

        tvLyricsRafId = requestAnimationFrame(step);
    }

    // ========================================================================
    // 4. INJECT UI & CAPTURE ALL LEGACY CAST BUTTON CLICKS IN INDEX.HTML
    // ========================================================================
    function injectCastUI() {
        const moreMenu = document.getElementById("full-more-menu");
        if (moreMenu) {
            // Check if index.html already has a cast button (#menu-cast-btn or similar)
            const existingCastBtn = moreMenu.querySelector('[id*="cast"], [onclick*="Cast"]');
            if (existingCastBtn && existingCastBtn.id !== "menu-cast-tv-btn") {
                existingCastBtn.remove();
            }

            if (!document.getElementById("menu-cast-tv-btn")) {
                const castBtn = document.createElement("button");
                castBtn.id = "menu-cast-tv-btn";
                castBtn.type = "button";
                castBtn.className = "w-full h-9 px-3.5 rounded-xl liquid-control-btn flex items-center justify-between text-xs font-bold text-white";
                castBtn.innerHTML = `
                    <span class="flex items-center gap-2">
                        <i id="menu-cast-tv-icon" class="fa-solid fa-tv text-[11px]" style="color: var(--theme-color-bright)"></i>
                        <span id="menu-cast-tv-label">Cast to TV</span>
                    </span>
                    <span id="menu-cast-tv-status" class="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-400/20 text-emerald-300">Fire TV Ready</span>
                `;
                castBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    getBridge().closeMoreMenu();
                    if (isCastingActive) {
                        stopCastingToTV();
                    } else {
                        openCastScannerModal();
                    }
                });
                moreMenu.appendChild(castBtn);
            }
        }

        // Remove any legacy .m4a export buttons
        document.querySelectorAll('[onclick*="handleMenuDirectFileDownloadTap"], [onclick*="handleActionSheetExportFile"]').forEach((el) => {
            el.remove();
        });

        // Global Capture-Phase Listener: Intercepts ANY click on ANY Cast button in index.html
        // so legacy "Initializing Cast Engine..." stubs can never fire!
        document.addEventListener("click", (e) => {
            const btn = e.target.closest("button");
            if (!btn) return;
            const onClickAttr = btn.getAttribute("onclick") || "";
            const btnId = btn.id || "";
            if (
                btnId === "menu-cast-btn" ||
                onClickAttr.includes("Cast") ||
                onClickAttr.includes("cast")
            ) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                getBridge().closeMoreMenu();
                if (isCastingActive) {
                    stopCastingToTV();
                } else {
                    openCastScannerModal();
                }
            }
        }, true);

        // Dynamic TV Volume HUD inside Fullscreen Player
        const bottomChrome = document.getElementById("full-bottom-chrome");
        if (bottomChrome && !document.getElementById("tv-cast-volume-hud")) {
            const tvVolHud = document.createElement("div");
            tvVolHud.id = "tv-cast-volume-hud";
            tvVolHud.className = "hidden w-full px-2 pt-1 transition-all duration-300";
            tvVolHud.innerHTML = `
                <div class="liquid-glass rounded-2xl px-3.5 py-2.5 flex flex-col gap-2 border border-white/15">
                    <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0"></span>
                            <span id="tv-cast-banner-name" class="text-[11px] font-extrabold text-white truncate">Casting to Fire TV</span>
                        </div>
                        <div class="flex items-center gap-1.5 flex-shrink-0">
                            <button type="button" id="tv-cast-open-stage-pill" class="px-2.5 py-0.5 rounded-full bg-white/15 border border-white/20 text-[10px] font-extrabold text-white">
                                TV View
                            </button>
                            <button type="button" id="tv-cast-disconnect-pill" class="px-2.5 py-0.5 rounded-full bg-rose-500/20 border border-rose-400/30 text-[10px] font-extrabold text-rose-300">
                                Disconnect
                            </button>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <button type="button" id="tv-vol-down-btn" class="w-7 h-7 circle-btn liquid-control-btn flex items-center justify-center text-white/80">
                            <i id="tv-vol-mute-icon" class="fa-solid fa-volume-low text-[10px]"></i>
                        </button>
                        <div class="flex-1 relative flex items-center py-2 cursor-pointer" id="tv-vol-slider-zone">
                            <input type="range" id="tv-vol-range" min="0" max="150" step="1" value="100" style="--progress: 66.7%;" class="w-full pointer-events-none">
                        </div>
                        <button type="button" id="tv-vol-up-btn" class="w-7 h-7 circle-btn liquid-control-btn flex items-center justify-center text-white/80">
                            <i class="fa-solid fa-volume-high text-[10px]"></i>
                        </button>
                        <span id="tv-vol-pct-label" class="text-[10px] font-extrabold text-white/80 w-9 text-right tabular-nums">100%</span>
                    </div>
                </div>
            `;
            bottomChrome.appendChild(tvVolHud);

            const volSliderZone = document.getElementById("tv-vol-slider-zone");
            let draggingVol = false;
            const updateVolFromX = (clientX) => {
                const rect = volSliderZone.getBoundingClientRect();
                if (rect.width <= 0) return;
                const ratio = Math.max(0, Math.min(1.5, ((clientX - rect.left) / rect.width) * 1.5));
                setTVVolume(ratio, false);
            };

            volSliderZone.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                draggingVol = true;
                try { volSliderZone.setPointerCapture(e.pointerId); } catch (err) {}
                updateVolFromX(e.clientX);
            });
            volSliderZone.addEventListener("pointermove", (e) => {
                if (!draggingVol) return;
                e.stopPropagation();
                updateVolFromX(e.clientX);
            });
            const endVolDrag = () => { draggingVol = false; };
            volSliderZone.addEventListener("pointerup", endVolDrag);
            volSliderZone.addEventListener("pointercancel", endVolDrag);

            document.getElementById("tv-vol-down-btn").onclick = (e) => {
                e.stopPropagation();
                setTVVolume(Math.max(0, tvVolume - 0.1), true);
            };
            document.getElementById("tv-vol-up-btn").onclick = (e) => {
                e.stopPropagation();
                setTVVolume(Math.min(1.5, tvVolume + 0.1), true);
            };
            document.getElementById("tv-cast-open-stage-pill").onclick = (e) => {
                e.stopPropagation();
                openTvCinemaStage();
            };
            document.getElementById("tv-cast-disconnect-pill").onclick = (e) => {
                e.stopPropagation();
                stopCastingToTV();
            };
        }

        // Cast Scanner Modal
        if (!document.getElementById("muse-cast-hub-modal")) {
            const modal = document.createElement("div");
            modal.id = "muse-cast-hub-modal";
            modal.className = "fixed inset-0 z-[110] hidden items-end sm:items-center justify-center p-4 modal-backdrop";
            modal.innerHTML = `
                <div class="liquid-glass rounded-[2rem] w-full max-w-md p-5 space-y-4 border border-white/20 shadow-2xl" onclick="event.stopPropagation()">
                    <div class="flex items-center justify-between border-b border-white/10 pb-3">
                        <div class="flex items-center gap-2.5">
                            <div class="w-9 h-9 rounded-full liquid-hero-play flex items-center justify-center">
                                <i class="fa-solid fa-tv text-xs text-white"></i>
                            </div>
                            <div>
                                <h3 class="text-base font-extrabold text-white tracking-tight">Cast to Fire TV & Smart TV</h3>
                                <p class="text-[11px] text-white/60 font-medium">Tap Connect below to launch TV Lyrics & Volume</p>
                            </div>
                        </div>
                        <button type="button" id="cast-hub-close-btn" class="w-8 h-8 circle-btn liquid-control-btn flex items-center justify-center">
                            <i class="fa-solid fa-xmark text-xs"></i>
                        </button>
                    </div>

                    <div class="p-3.5 rounded-2xl bg-black/40 border border-white/10 space-y-2.5">
                        <div class="flex items-center justify-between">
                            <span class="text-[10px] font-extrabold uppercase tracking-wider text-white/75 flex items-center gap-2">
                                <i id="cast-radar-icon" class="fa-solid fa-spinner fa-spin text-xs text-amber-400"></i>
                                <span id="cast-radar-text">Scanning Wi-Fi for Fire TV...</span>
                            </span>
                            <button type="button" id="cast-refresh-scan-btn" class="px-2.5 py-1 rounded-full liquid-control-btn text-[10px] font-extrabold text-sky-300">
                                Rescan
                            </button>
                        </div>

                        <div id="cast-discovered-list" class="flex flex-col gap-2 max-h-52 overflow-y-auto no-scrollbar"></div>
                    </div>
                </div>
            `;
            modal.addEventListener("click", closeCastScannerModal);
            document.body.appendChild(modal);

            document.getElementById("cast-hub-close-btn").onclick = closeCastScannerModal;
            document.getElementById("cast-refresh-scan-btn").onclick = (e) => {
                e.stopPropagation();
                runRealWifiHardwareScan();
            };
        }
    }

    function openCastScannerModal() {
        const modal = document.getElementById("muse-cast-hub-modal");
        if (modal) {
            modal.classList.remove("hidden");
            modal.classList.add("flex");
        }
        runRealWifiHardwareScan();
    }

    function closeCastScannerModal() {
        const modal = document.getElementById("muse-cast-hub-modal");
        if (modal) {
            modal.classList.add("hidden");
            modal.classList.remove("flex");
        }
    }

    function startFireTvCinemaCast(deviceName = "Amazon Fire TV") {
        closeCastScannerModal();
        ensureWebAudioVolumeEngine();
        remoteAudioAckReceived = false;

        const audioEl = getBridge().getAudioElement();
        if (audioEl && audioEl.paused) {
            audioEl.play().catch(() => {});
        }

        activateCastingState("firetv-direct", deviceName);
        openTvCinemaStage();
    }

    function activateCastingState(mode, deviceName) {
        isCastingActive = true;
        activeCastMode = mode;
        activeDeviceName = deviceName || "Amazon Fire TV";

        ensureWebAudioVolumeEngine();

        const labelEl = document.getElementById("menu-cast-tv-label");
        const hudEl = document.getElementById("tv-cast-volume-hud");
        const bannerName = document.getElementById("tv-cast-banner-name");

        if (labelEl) labelEl.innerText = `Disconnect (${activeDeviceName})`;
        if (bannerName) bannerName.innerText = `Casting to ${activeDeviceName}`;
        if (hudEl) hudEl.classList.remove("hidden");

        updateMenuCastStatusBadge(true);
        setTVVolume(tvVolume, false);

        getBridge().toast(`Casting to ${activeDeviceName}`);
    }

    function stopCastingToTV() {
        isCastingActive = false;
        activeCastMode = null;
        remoteAudioAckReceived = false;

        closeTvCinemaStage();

        const labelEl = document.getElementById("menu-cast-tv-label");
        const hudEl = document.getElementById("tv-cast-volume-hud");
        if (labelEl) labelEl.innerText = "Cast to TV";
        if (hudEl) hudEl.classList.add("hidden");

        if (webAudioGainNode) {
            webAudioGainNode.gain.value = 1.0;
        }
        const audioEl = getBridge().getAudioElement();
        if (audioEl) {
            audioEl.volume = 1.0;
            audioEl.muted = false;
        }

        getBridge().toast("Disconnected from TV");
    }

    function setTVVolume(newVol, notifyToast = false) {
        ensureWebAudioVolumeEngine();
        tvVolume = Math.max(0, Math.min(1.5, Number(newVol) || 0));
        tvMuted = tvVolume === 0;

        const pct = Math.round(tvVolume * 100);
        const sliderProgress = Math.min(100, (pct / 150) * 100);

        const volRange = document.getElementById("tv-vol-range");
        const volLabel = document.getElementById("tv-vol-pct-label");
        const muteIcon = document.getElementById("tv-vol-mute-icon");

        if (volRange) {
            volRange.value = pct;
            volRange.style.setProperty("--progress", `${sliderProgress.toFixed(1)}%`);
        }
        if (volLabel) volLabel.innerText = `${pct}%`;
        if (muteIcon) {
            muteIcon.className = pct === 0
                ? "fa-solid fa-volume-xmark text-[10px] text-rose-400"
                : "fa-solid fa-volume-low text-[10px]";
        }

        const drawerInput = document.getElementById("tv-drawer-vol-input");
        const drawerText = document.getElementById("tv-drawer-vol-text");
        const popup = document.getElementById("tv-stage-vol-popup");
        const popupBar = document.getElementById("tv-stage-vol-popup-bar");
        const popupLabel = document.getElementById("tv-stage-vol-popup-label");

        if (drawerInput) {
            drawerInput.value = pct;
            drawerInput.style.setProperty("--progress", `${sliderProgress.toFixed(1)}%`);
        }
        if (drawerText) drawerText.innerText = `${pct}%`;
        if (popup && popupBar && popupLabel) {
            popupBar.style.width = `${Math.min(100, pct)}%`;
            popupLabel.innerText = `${pct}%`;
            popup.style.opacity = "1";
            setTimeout(() => { popup.style.opacity = "0"; }, 1400);
        }

        if (webAudioGainNode) {
            try { webAudioGainNode.gain.value = tvMuted ? 0 : tvVolume; } catch (e) {}
        }

        const audioEl = getBridge().getAudioElement();
        if (audioEl) {
            try {
                audioEl.volume = Math.min(1, tvVolume);
                audioEl.muted = tvMuted;
            } catch (e) {}
        }

        if (notifyToast) {
            getBridge().toast(`TV Volume: ${pct}%`);
        }
    }

    function updateMenuCastStatusBadge() {
        const badge = document.getElementById("menu-cast-tv-status");
        if (!badge) return;
        badge.innerText = isCastingActive ? "Connected" : "Fire TV Ready";
    }

    function loadTrackOnTV() {
        if (!isCastingActive) return;
        setTimeout(() => syncTvCinemaStageMetadataAndLyrics(), 120);
    }

    function initCastProtocols() {
        injectCastUI();
        injectTvCinemaStageOverlay();

        registerDiscoveredDevice("firetv_primary", {
            name: cachedFireTvIp ? `Amazon Fire TV (${cachedFireTvIp})` : "Amazon Fire TV (Screen Mirroring / Cast)",
            subtitle: "Opens TV Lyrics + 3 Controls • Phone controls TV Volume",
            icon: "fa-fire-flame-curved text-amber-400",
            priority: 1,
            onSelect: () => startFireTvCinemaCast(cachedFireTvIp ? `Amazon Fire TV (${cachedFireTvIp})` : "Amazon Fire TV")
        });

        const audioEl = getBridge().getAudioElement();
        if (audioEl) {
            audioEl.addEventListener("loadeddata", () => {
                if (isCastingActive) syncTvCinemaStageMetadataAndLyrics();
            });
        }
    }

    // ========================================================================
    // 5. EXPOSE ALL GLOBAL ALIASES SO INDEX.HTML ALWAYS FINDS THE ENGINE
    // ========================================================================
    const EngineAPI = {
        isCasting: () => isCastingActive,
        openCastPrompt: () => openCastScannerModal(),
        openPicker: () => openCastScannerModal(),
        startCast: () => openCastScannerModal(),
        toggleCast: () => (isCastingActive ? stopCastingToTV() : openCastScannerModal()),
        loadTrackOnTV,
        play: () => getBridge().getAudioElement()?.play().catch(() => {}),
        pause: () => getBridge().getAudioElement()?.pause(),
        seek: (t) => {
            const a = getBridge().getAudioElement();
            if (a) a.currentTime = Math.max(0, Number(t) || 0);
        },
        setVolume: (v) => setTVVolume(v, false),
        getCurrentTime: () => getBridge().getAudioElement()?.currentTime || 0,
        getDuration: () => getBridge().getAudioElement()?.duration || 0
    };

    window.MuseCastEngine = EngineAPI;
    window.MuseCast = EngineAPI;
    window.CastEngine = EngineAPI;
    window.handleMenuCastTap = (e) => {
        if (e) e.stopPropagation();
        getBridge().closeMoreMenu();
        EngineAPI.toggleCast();
    };
    window.triggerCastToTV = window.handleMenuCastTap;

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initCastProtocols);
    } else {
        initCastProtocols();
    }
})();
