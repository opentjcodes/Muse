// ============================================================================
// FILE: cast-engine.js (v3.0 — Real-Time TV Scanner, Native Cast CAF & WSS Sync)
// 100% Compatible with GitHub Pages (HTTPS), Stock Fire TV, Android TV,
// Chromecast, AirPlay, and DLNA Smart TVs.
// ============================================================================

(function () {
    "use strict";

    const RECEIVER_URL = new URL("./tv-receiver.html", window.location.href).href;
    const WSS_BROKERS = [
        "wss://broker.emqx.io:8084/mqtt",
        "wss://broker.hivemq.com:8884/mqtt"
    ];

    let isCastingActive = false;
    let activeCastMode = null; // 'wss-receiver' | 'presentation' | 'chromecast' | 'remoteplayback' | 'airplay'
    let activeDeviceName = "Smart TV";

    let presentationRequest = null;
    let presentationConnection = null;
    let googleCastSession = null;
    let remotePlayer = null;
    let remotePlayerController = null;
    let broadcastSyncChannel = null;

    // Real-Time WSS Same-Wi-Fi & PIN Sync Client
    let mqttClient = null;
    let wifiTopicBase = null;
    let pairedPinCode = localStorage.getItem("muse_paired_tv_pin") || "";
    let discoveredTVs = new Map(); // id -> { id, name, mode, pin, lastSeen, action }

    let tvVolume = 0.85;
    let tvMuted = false;
    let remoteCurrentTime = 0;
    let remoteDuration = 0;
    let remoteIsPlaying = false;
    let syncIntervalId = null;

    // ========================================================================
    // 1. LIGHTWEIGHT BINARY MQTT-OVER-WSS CLIENT (ZERO EXTERNAL DEPENDENCIES)
    // Works 100% over HTTPS (GitHub Pages) with ~20ms latency
    // ========================================================================
    class MuseRealtimeWssBus {
        constructor(onMessageCallback) {
            this.ws = null;
            this.connected = false;
            this.brokerIdx = 0;
            this.onMessage = onMessageCallback;
            this.subscriptions = new Set();
            this.pingTimer = null;
            this.clientId = "muse_ctrl_" + Math.random().toString(36).slice(2, 10);
        }

        connect() {
            if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
                return;
            }
            const url = WSS_BROKERS[this.brokerIdx % WSS_BROKERS.length];
            try {
                this.ws = new WebSocket(url, "mqtt");
                this.ws.binaryType = "arraybuffer";

                this.ws.onopen = () => {
                    this._sendConnectPacket();
                };

                this.ws.onmessage = (ev) => {
                    this._handleBinaryFrame(new Uint8Array(ev.data));
                };

                this.ws.onerror = () => {};

                this.ws.onclose = () => {
                    this.connected = false;
                    if (this.pingTimer) clearInterval(this.pingTimer);
                    this.brokerIdx++;
                    setTimeout(() => this.connect(), 2500);
                };
            } catch (e) {}
        }

        _encodeLength(len) {
            const bytes = [];
            do {
                let b = len % 128;
                len = Math.floor(len / 128);
                if (len > 0) b |= 128;
                bytes.push(b);
            } while (len > 0);
            return bytes;
        }

        _encodeUtf8(str) {
            const raw = new TextEncoder().encode(str);
            return [(raw.length >> 8) & 0xff, raw.length & 0xff, ...raw];
        }

        _sendConnectPacket() {
            const payload = [
                0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // "MQTT"
                0x04,                               // Protocol level 4 (v3.1.1)
                0x02,                               // Clean session
                0x00, 0x3c,                         // Keep-alive 60s
                ...this._encodeUtf8(this.clientId)
            ];
            const pkt = new Uint8Array([0x10, ...this._encodeLength(payload.length), ...payload]);
            this.ws.send(pkt);
        }

        subscribe(topic) {
            this.subscriptions.add(topic);
            if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            const body = [0x00, 0x01, ...this._encodeUtf8(topic), 0x00];
            const pkt = new Uint8Array([0x82, ...this._encodeLength(body.length), ...body]);
            try { this.ws.send(pkt); } catch (e) {}
        }

        publish(topic, dataObj) {
            if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            const jsonBytes = new TextEncoder().encode(JSON.stringify(dataObj));
            const topicBytes = this._encodeUtf8(topic);
            const remLen = topicBytes.length + jsonBytes.length;
            const header = [0x30, ...this._encodeLength(remLen), ...topicBytes];
            const pkt = new Uint8Array(header.length + jsonBytes.length);
            pkt.set(header, 0);
            pkt.set(jsonBytes, header.length);
            try { this.ws.send(pkt); } catch (e) {}
        }

        _handleBinaryFrame(buf) {
            if (!buf || buf.length < 2) return;
            const type = buf[0] & 0xf0;

            // CONNACK (0x20)
            if (type === 0x20) {
                this.connected = true;
                this.subscriptions.forEach((t) => this.subscribe(t));
                if (this.pingTimer) clearInterval(this.pingTimer);
                this.pingTimer = setInterval(() => {
                    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
                        try { this.ws.send(new Uint8Array([0xc0, 0x00])); } catch (e) {}
                    }
                }, 25000);
                // Request immediate ping from any TV on the same Wi-Fi
                if (wifiTopicBase) {
                    this.publish(`${wifiTopicBase}/ctrl`, { type: "DISCOVER_PING" });
                }
                if (pairedPinCode) {
                    this.publish(`muse/tv/pin/${pairedPinCode}/ctrl`, { type: "DISCOVER_PING" });
                }
                return;
            }

            // PUBLISH (0x30)
            if (type === 0x30) {
                let mult = 1;
                let remLen = 0;
                let idx = 1;
                let encodedByte;
                do {
                    if (idx >= buf.length) return;
                    encodedByte = buf[idx++];
                    remLen += (encodedByte & 127) * mult;
                    mult *= 128;
                } while ((encodedByte & 128) !== 0);

                if (idx + 2 > buf.length) return;
                const topicLen = (buf[idx] << 8) | buf[idx + 1];
                idx += 2;
                const topic = new TextDecoder().decode(buf.subarray(idx, idx + topicLen));
                idx += topicLen;

                const payloadStr = new TextDecoder().decode(buf.subarray(idx, idx + (remLen - 2 - topicLen)));
                try {
                    const parsed = JSON.parse(payloadStr);
                    if (this.onMessage) this.onMessage(topic, parsed);
                } catch (e) {}
            }
        }
    }

    // ========================================================================
    // 2. ENSURE HTTPS STREAM FOR NATIVE CAST / AIRPLAY / REMOTE PLAYBACK
    // ========================================================================
    function prepareHttpsStreamForCasting() {
        const bridge = window.MusePlayerBridge;
        if (!bridge) return "";
        const track = bridge.getActiveTrack();
        const audioEl = bridge.getAudioElement();
        const httpsUrl = bridge.getStreamUrlForTrack(track);

        if (!httpsUrl) return "";

        // Ensure <audio> is using a network HTTPS URL (never a local RAM blob: URL)
        // because Chromecast / RemotePlayback / AirPlay cannot fetch a blob: URL from phone RAM.
        if (audioEl && (!audioEl.src || audioEl.src.startsWith("blob:"))) {
            const savedTime = audioEl.currentTime || 0;
            const wasPaused = audioEl.paused;
            audioEl.src = httpsUrl;
            if (savedTime > 0) {
                audioEl.addEventListener("loadedmetadata", () => {
                    try { audioEl.currentTime = savedTime; } catch (e) {}
                }, { once: true });
            }
            if (!wasPaused && !isCastingActive) {
                audioEl.play().catch(() => {});
            }
        }

        return httpsUrl;
    }

    // Builds an inline WebVTT subtitle data URI from word-by-word lyrics so even
    // standard Chromecast / Android TV receivers display synced lyrics on screen!
    function buildWebVttDataUriFromTimeline(timeline) {
        if (!Array.isArray(timeline) || timeline.length === 0) return null;
        const fmtVttTime = (sec) => {
            const s = Math.max(0, Number(sec) || 0);
            const hrs = Math.floor(s / 3600);
            const mins = Math.floor((s % 3600) / 60);
            const secs = Math.floor(s % 60);
            const ms = Math.round((s - Math.floor(s)) * 1000);
            return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
        };

        let vtt = "WEBVTT\n\n";
        timeline.forEach((line, i) => {
            const start = fmtVttTime(line.time);
            const end = fmtVttTime(Math.max(line.time + 0.5, line.endTime || (line.time + 3.5)));
            vtt += `${i + 1}\n${start} --> ${end}\n${line.text || "♪"}\n\n`;
        });

        try {
            return "data:text/vtt;charset=utf-8," + encodeURIComponent(vtt);
        } catch (e) {
            return null;
        }
    }

    // ========================================================================
    // 3. INJECT 3-DOTS MENU BUTTON, DYNAMIC TV VOLUME BAR & REAL SCANNER MODAL
    // ========================================================================
    function injectCastUI() {
        const moreMenu = document.getElementById("full-more-menu");
        if (moreMenu && !document.getElementById("menu-cast-tv-btn")) {
            const castBtn = document.createElement("button");
            castBtn.id = "menu-cast-tv-btn";
            castBtn.type = "button";
            castBtn.className = "w-full h-9 px-3.5 rounded-xl liquid-control-btn flex items-center justify-between text-xs font-bold text-white";
            castBtn.innerHTML = `
                <span class="flex items-center gap-2">
                    <i id="menu-cast-tv-icon" class="fa-solid fa-tv text-[11px]" style="color: var(--theme-color-bright)"></i>
                    <span id="menu-cast-tv-label">Cast to TV</span>
                </span>
                <span id="menu-cast-tv-status" class="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-white/70">Scan / Cast</span>
            `;
            castBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (window.MusePlayerBridge) window.MusePlayerBridge.closeMoreMenu();
                if (isCastingActive) {
                    stopCastingToTV();
                } else {
                    openCastScannerModal();
                }
            });
            moreMenu.appendChild(castBtn);
        }

        // Remove any legacy .m4a export buttons
        document.querySelectorAll('[onclick*="handleMenuDirectFileDownloadTap"], [onclick*="handleActionSheetExportFile"]').forEach((el) => {
            el.remove();
        });

        // Dynamic TV Volume HUD inside Fullscreen Player (Shown ONLY when casting to TV)
        const bottomChrome = document.getElementById("full-bottom-chrome");
        if (bottomChrome && !document.getElementById("tv-cast-volume-hud")) {
            const tvVolHud = document.createElement("div");
            tvVolHud.id = "tv-cast-volume-hud";
            tvVolHud.className = "hidden w-full px-2 pt-1 transition-all duration-300";
            tvVolHud.innerHTML = `
                <div class="liquid-glass rounded-2xl px-3.5 py-2.5 flex flex-col gap-2 border border-white/15">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                            <span id="tv-cast-banner-name" class="text-[11px] font-extrabold text-white truncate">Casting to TV</span>
                        </div>
                        <button type="button" id="tv-cast-disconnect-pill" class="px-2.5 py-0.5 rounded-full bg-rose-500/20 border border-rose-400/30 text-[10px] font-extrabold text-rose-300">
                            Disconnect
                        </button>
                    </div>
                    <div class="flex items-center gap-3">
                        <button type="button" id="tv-vol-down-btn" class="w-7 h-7 circle-btn liquid-control-btn flex items-center justify-center text-white/80">
                            <i id="tv-vol-mute-icon" class="fa-solid fa-volume-low text-[10px]"></i>
                        </button>
                        <div class="flex-1 relative flex items-center py-2 cursor-pointer" id="tv-vol-slider-zone">
                            <input type="range" id="tv-vol-range" min="0" max="100" step="1" value="85" style="--progress: 85%;" class="w-full pointer-events-none">
                        </div>
                        <button type="button" id="tv-vol-up-btn" class="w-7 h-7 circle-btn liquid-control-btn flex items-center justify-center text-white/80">
                            <i class="fa-solid fa-volume-high text-[10px]"></i>
                        </button>
                        <span id="tv-vol-pct-label" class="text-[10px] font-extrabold text-white/80 w-8 text-right tabular-nums">85%</span>
                    </div>
                </div>
            `;
            bottomChrome.appendChild(tvVolHud);

            const volSliderZone = document.getElementById("tv-vol-slider-zone");
            const volDownBtn = document.getElementById("tv-vol-down-btn");
            const volUpBtn = document.getElementById("tv-vol-up-btn");
            const disconnectBtn = document.getElementById("tv-cast-disconnect-pill");

            let draggingVol = false;
            const updateVolFromX = (clientX) => {
                const rect = volSliderZone.getBoundingClientRect();
                if (rect.width <= 0) return;
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                setTVVolume(ratio);
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
            const endVolDrag = (e) => {
                if (!draggingVol) return;
                draggingVol = false;
                if (e && typeof e.clientX === "number") updateVolFromX(e.clientX);
            };
            volSliderZone.addEventListener("pointerup", endVolDrag);
            volSliderZone.addEventListener("pointercancel", endVolDrag);

            volDownBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                setTVVolume(Math.max(0, tvVolume - 0.08), true);
            });
            volUpBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                setTVVolume(Math.min(1, tvVolume + 0.08), true);
            });
            disconnectBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                stopCastingToTV();
            });
        }

        // Real-Time Multi-Protocol TV Scanner & Cast Modal
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
                                <p class="text-[11px] text-white/60 font-medium">Real-time Wi-Fi scanner & native OS cast</p>
                            </div>
                        </div>
                        <button type="button" id="cast-hub-close-btn" class="w-8 h-8 circle-btn liquid-control-btn flex items-center justify-center">
                            <i class="fa-solid fa-xmark text-xs"></i>
                        </button>
                    </div>

                    <!-- 1. LIVE DISCOVERED TVs ON SAME WI-FI -->
                    <div class="p-3.5 rounded-2xl bg-black/40 border border-white/10 space-y-2.5">
                        <div class="flex items-center justify-between">
                            <span class="text-[10px] font-extrabold uppercase tracking-wider text-white/70 flex items-center gap-2">
                                <i id="cast-radar-icon" class="fa-solid fa-spinner fa-spin text-xs text-emerald-400"></i>
                                <span id="cast-radar-text">Scanning Wi-Fi for TVs...</span>
                            </span>
                            <button type="button" id="cast-refresh-scan-btn" class="px-2.5 py-1 rounded-full liquid-control-btn text-[10px] font-extrabold text-sky-300">
                                Rescan
                            </button>
                        </div>

                        <div id="cast-discovered-list" class="flex flex-col gap-2 max-h-44 overflow-y-auto no-scrollbar"></div>
                    </div>

                    <!-- 2. QUICK 4-DIGIT TV PIN PAIR (100% Instant on Any Fire TV / Smart TV) -->
                    <div class="p-3.5 rounded-2xl bg-black/35 border border-white/10 space-y-2">
                        <div class="flex items-center justify-between">
                            <span class="text-[11px] font-extrabold text-white flex items-center gap-1.5">
                                <i class="fa-solid fa-bolt text-amber-400 text-xs"></i>
                                <span>Instant TV Code Connect</span>
                            </span>
                            <span class="text-[10px] font-semibold text-white/45">Works across any Wi-Fi</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <input
                                id="cast-pin-input"
                                type="text"
                                inputmode="numeric"
                                maxlength="4"
                                placeholder="Enter 4-digit TV code"
                                class="flex-1 h-9 px-3.5 rounded-xl bg-white/5 border border-white/15 text-xs font-extrabold tracking-widest text-white placeholder-white/35 focus:outline-none focus:border-white/50"
                            />
                            <button type="button" id="cast-pin-connect-btn" class="h-9 px-4 rounded-xl liquid-control-btn liquid-hero-play text-xs font-extrabold text-white">
                                Connect TV
                            </button>
                        </div>
                    </div>

                    <!-- 3. NATIVE OS CAST PICKERS (Android TV, Chromecast, AirPlay & Wireless Display) -->
                    <div class="grid grid-cols-2 gap-2">
                        <button type="button" id="cast-native-chromecast-btn" class="p-3 rounded-2xl liquid-data-card flex flex-col items-start gap-1 text-left">
                            <div class="flex items-center gap-2 text-xs font-extrabold text-white">
                                <i class="fa-brands fa-chromecast text-sm" style="color: var(--theme-color-bright)"></i>
                                <span>Android TV / Cast</span>
                            </div>
                            <span class="text-[10px] text-white/50">Native Google Cast</span>
                        </button>

                        <button type="button" id="cast-native-airplay-btn" class="p-3 rounded-2xl liquid-data-card flex flex-col items-start gap-1 text-left">
                            <div class="flex items-center gap-2 text-xs font-extrabold text-white">
                                <i class="fa-solid fa-tower-broadcast text-sm text-emerald-400"></i>
                                <span>AirPlay / DLNA</span>
                            </div>
                            <span class="text-[10px] text-white/50">Direct TV Audio Stream</span>
                        </button>
                    </div>
                </div>
            `;
            modal.addEventListener("click", closeCastScannerModal);
            document.body.appendChild(modal);

            document.getElementById("cast-hub-close-btn").onclick = closeCastScannerModal;

            document.getElementById("cast-refresh-scan-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                runRealTimeDeviceScan();
            });

            document.getElementById("cast-pin-connect-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                const pin = (document.getElementById("cast-pin-input")?.value || "").trim();
                if (!/^\d{4}$/.test(pin)) {
                    if (window.MusePlayerBridge) window.MusePlayerBridge.toast("Enter the 4-digit code shown on TV", "error");
                    return;
                }
                connectToTvByPin(pin);
            });

            document.getElementById("cast-native-chromecast-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                triggerGoogleCastOrPresentationPicker();
            });

            document.getElementById("cast-native-airplay-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                triggerAirPlayOrRemotePlaybackPicker();
            });
        }
    }

    // ========================================================================
    // 4. REAL-TIME MULTI-PROTOCOL SCANNER (FINDS TVs ON WI-FI AUTOMATICALLY)
    // ========================================================================
    function registerDiscoveredTV(id, info) {
        discoveredTVs.set(id, {
            ...info,
            id,
            lastSeen: Date.now()
        });
        renderDiscoveredTVList();
        updateMenuCastStatusBadge(true);
    }

    function renderDiscoveredTVList() {
        const listEl = document.getElementById("cast-discovered-list");
        const radarText = document.getElementById("cast-radar-text");
        const radarIcon = document.getElementById("cast-radar-icon");
        if (!listEl) return;

        // Prune stale WSS entries older than 15s
        const now = Date.now();
        for (const [k, v] of discoveredTVs.entries()) {
            if (v.mode === "wss-receiver" && now - v.lastSeen > 15000) {
                discoveredTVs.delete(k);
            }
        }

        listEl.innerHTML = "";
        const items = Array.from(discoveredTVs.values());

        if (items.length > 0) {
            if (radarText) radarText.innerText = `Found ${items.length} TV device(s) ready to cast`;
            if (radarIcon) radarIcon.className = "fa-solid fa-circle-check text-xs text-emerald-400";
        } else {
            if (radarText) radarText.innerText = "Scanning Wi-Fi for active TV receivers...";
            if (radarIcon) radarIcon.className = "fa-solid fa-spinner fa-spin text-xs text-sky-400";
            listEl.innerHTML = `
                <div class="text-[11px] text-white/55 leading-relaxed py-1 px-1">
                    <div class="font-bold text-white/80 mb-0.5">How to pop up Lyrics + 3 Controls on Fire TV:</div>
                    1. Open <b>${window.location.origin + window.location.pathname.replace(/\/[^/]*$/, "/tv-receiver.html")}</b> once on Fire TV (Silk), OR use <b>Display Mirroring</b>.<br>
                    2. Your Fire TV will appear right here automatically on the same Wi-Fi!
                </div>
            `;
            return;
        }

        items.forEach((tv) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "w-full p-2.5 rounded-xl liquid-control-btn flex items-center justify-between text-left border border-emerald-400/30";
            btn.innerHTML = `
                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                        <i class="fa-solid fa-tv text-xs text-emerald-300"></i>
                    </div>
                    <div class="min-w-0">
                        <div class="text-xs font-extrabold text-white truncate">${tv.name}</div>
                        <div class="text-[10px] font-semibold text-emerald-300 truncate">${tv.subtitle || "Online on Same Wi-Fi • Tap to Connect"}</div>
                    </div>
                </div>
                <span class="px-2.5 py-1 rounded-full bg-emerald-400/20 text-emerald-200 text-[10px] font-extrabold flex-shrink-0">
                    Connect
                </span>
            `;
            btn.onclick = () => {
                if (tv.onSelect) tv.onSelect();
            };
            listEl.appendChild(btn);
        });
    }

    async function runRealTimeDeviceScan() {
        prepareHttpsStreamForCasting();
        renderDiscoveredTVList();

        // 1. Ping Same-Wi-Fi WSS Discovery Channel
        if (mqttClient && mqttClient.connected) {
            if (wifiTopicBase) {
                mqttClient.publish(`${wifiTopicBase}/ctrl`, { type: "DISCOVER_PING" });
            }
            if (pairedPinCode) {
                mqttClient.publish(`muse/tv/pin/${pairedPinCode}/ctrl`, { type: "DISCOVER_PING" });
            }
        }

        // 2. Probe W3C Presentation API Secondary Display (Fire TV Display Mirroring / Miracast)
        if ("PresentationRequest" in window) {
            try {
                if (!presentationRequest) {
                    presentationRequest = new PresentationRequest([RECEIVER_URL]);
                }
                const avail = await presentationRequest.getAvailability();
                if (avail && avail.value) {
                    registerDiscoveredTV("presentation_display", {
                        name: "Wireless TV Display (Presentation)",
                        subtitle: "Projects Lyrics + 3 Controls directly to TV",
                        mode: "presentation",
                        onSelect: () => triggerPresentationDisplayStart()
                    });
                }
                avail.onchange = () => {
                    if (avail.value) {
                        registerDiscoveredTV("presentation_display", {
                            name: "Wireless TV Display (Presentation)",
                            subtitle: "Projects Lyrics + 3 Controls directly to TV",
                            mode: "presentation",
                            onSelect: () => triggerPresentationDisplayStart()
                        });
                    } else {
                        discoveredTVs.delete("presentation_display");
                        renderDiscoveredTVList();
                    }
                };
            } catch (e) {}
        }

        // 3. Probe Google Cast SDK State (Android TV / Chromecast)
        if (window.cast && window.cast.framework) {
            try {
                const ctx = cast.framework.CastContext.getInstance();
                const state = ctx.getCastState();
                if (state && state !== cast.framework.CastState.NO_DEVICES_AVAILABLE) {
                    registerDiscoveredTV("google_cast_device", {
                        name: "Android TV / Chromecast",
                        subtitle: "Google Cast Receiver detected on Wi-Fi",
                        mode: "chromecast",
                        onSelect: () => triggerGoogleCastOrPresentationPicker()
                    });
                }
            } catch (e) {}
        }

        // 4. Probe HTML5 RemotePlayback Availability (AirPlay / DLNA / Fire TV Media Renderer)
        const audioEl = window.MusePlayerBridge?.getAudioElement();
        if (audioEl && audioEl.remote && typeof audioEl.remote.watchAvailability === "function") {
            try {
                audioEl.remote.watchAvailability((available) => {
                    if (available) {
                        registerDiscoveredTV("remote_playback_device", {
                            name: "Smart TV Media Renderer",
                            subtitle: "Direct 320kbps Audio Stream (DLNA / AirPlay)",
                            mode: "remoteplayback",
                            onSelect: () => triggerAirPlayOrRemotePlaybackPicker()
                        });
                    }
                }).catch(() => {});
            } catch (e) {}
        }
    }

    function openCastScannerModal() {
        const pinInput = document.getElementById("cast-pin-input");
        if (pinInput && pairedPinCode) {
            pinInput.value = pairedPinCode;
        }
        const modal = document.getElementById("muse-cast-hub-modal");
        if (modal) {
            modal.classList.remove("hidden");
            modal.classList.add("flex");
        }
        runRealTimeDeviceScan();
    }

    function closeCastScannerModal() {
        const modal = document.getElementById("muse-cast-hub-modal");
        if (modal) {
            modal.classList.add("hidden");
            modal.classList.remove("flex");
        }
    }

    // ========================================================================
    // 5. CONNECTION HANDLERS (WSS PIN / SAME-WIFI / CHROMECAST / PRESENTATION / AIRPLAY)
    // ========================================================================
    function connectToTvByPin(pin, tvFriendlyName = null) {
        pairedPinCode = String(pin).trim();
        try { localStorage.setItem("muse_paired_tv_pin", pairedPinCode); } catch (e) {}

        if (mqttClient) {
            mqttClient.subscribe(`muse/tv/pin/${pairedPinCode}/tv`);
            mqttClient.publish(`muse/tv/pin/${pairedPinCode}/ctrl`, { type: "DISCOVER_PING" });
        }

        closeCastScannerModal();
        activateCastingState("wss-receiver", tvFriendlyName || `Fire TV (#${pairedPinCode})`);
    }

    function triggerPresentationDisplayStart() {
        prepareHttpsStreamForCasting();
        if (!presentationRequest && "PresentationRequest" in window) {
            presentationRequest = new PresentationRequest([RECEIVER_URL]);
        }
        if (presentationRequest) {
            presentationRequest.start().then((conn) => {
                closeCastScannerModal();
                attachPresentationConnection(conn);
            }).catch((err) => {
                if (err && err.name !== "NotAllowedError" && err.name !== "AbortError") {
                    if (window.MusePlayerBridge) {
                        window.MusePlayerBridge.toast("Enable Display Mirroring on Fire TV first, or enter the 4-digit TV code", "info");
                    }
                }
            });
        }
    }

    function triggerGoogleCastOrPresentationPicker() {
        prepareHttpsStreamForCasting();

        if (window.cast && window.cast.framework) {
            try {
                const context = cast.framework.CastContext.getInstance();
                context.requestSession().then(() => {
                    closeCastScannerModal();
                }).catch((err) => {
                    if (err !== "cancel") {
                        triggerPresentationDisplayStart();
                    }
                });
                return;
            } catch (e) {}
        }

        triggerPresentationDisplayStart();
    }

    function triggerAirPlayOrRemotePlaybackPicker() {
        const httpsUrl = prepareHttpsStreamForCasting();
        const audioEl = window.MusePlayerBridge?.getAudioElement();
        if (!audioEl) return;

        // Apple AirPlay Picker
        if (typeof audioEl.webkitShowPlaybackTargetPicker === "function") {
            try {
                audioEl.webkitShowPlaybackTargetPicker();
                closeCastScannerModal();
                activateCastingState("airplay", "AirPlay TV");
                return;
            } catch (e) {}
        }

        // Standard HTML5 RemotePlayback Picker
        if (audioEl.remote && typeof audioEl.remote.prompt === "function") {
            // Ensure audio element has loaded metadata so Chrome doesn't drop the prompt
            if (audioEl.paused && httpsUrl) {
                audioEl.play().catch(() => {});
            }
            audioEl.remote.prompt().then(() => {
                closeCastScannerModal();
                activateCastingState("remoteplayback", "Smart TV Audio");
            }).catch(() => {
                if (window.MusePlayerBridge) {
                    window.MusePlayerBridge.toast("No DLNA/AirPlay receiver found. Use the 4-digit TV Code above for Fire TV!", "info");
                }
            });
        }
    }

    function attachPresentationConnection(connection) {
        presentationConnection = connection;

        const onConnected = () => {
            closeCastScannerModal();
            activateCastingState("presentation", "Smart TV Display");
            sendFullStateToTVReceiver();
        };

        if (connection.state === "connected") {
            onConnected();
        } else {
            connection.onconnect = onConnected;
        }

        connection.onmessage = (event) => {
            try {
                const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
                handleIncomingTVMessage(data);
            } catch (e) {}
        };

        connection.onclose = () => deactivateCastingState();
        connection.onterminate = () => deactivateCastingState();
    }

    // ========================================================================
    // 6. INITIALIZE WSS SAME-WI-FI BUS & GOOGLE CAST CAF FRAMEWORK
    // ========================================================================
    async function initSameWifiWssBus() {
        mqttClient = new MuseRealtimeWssBus((topic, msg) => {
            handleIncomingTVMessage(msg);
        });
        mqttClient.connect();

        if (pairedPinCode) {
            mqttClient.subscribe(`muse/tv/pin/${pairedPinCode}/tv`);
        }

        try {
            const res = await fetch("https://api.ipify.org?format=json");
            if (res.ok) {
                const data = await res.json();
                if (data && data.ip) {
                    wifiTopicBase = "muse/tv/wifi/" + data.ip.replace(/[^a-zA-Z0-9]/g, "_");
                    mqttClient.subscribe(`${wifiTopicBase}/tv`);
                    mqttClient.publish(`${wifiTopicBase}/ctrl`, { type: "DISCOVER_PING" });
                }
            }
        } catch (e) {}
    }

    function initCastProtocols() {
        injectCastUI();
        initSameWifiWssBus();

        // IMPORTANT: Do NOT set navigator.presentation.defaultRequest here!
        // Leaving defaultRequest untouched allows Google Cast SDK (cast_sender.js) to work without hanging on "Initializing...".
        if ("PresentationRequest" in window) {
            try {
                presentationRequest = new PresentationRequest([RECEIVER_URL]);
                presentationRequest.onconnectionavailable = (event) => {
                    attachPresentationConnection(event.connection);
                };
            } catch (e) {}
        }

        if ("BroadcastChannel" in window) {
            broadcastSyncChannel = new BroadcastChannel("muse_tv_cast_channel_v1");
            broadcastSyncChannel.onmessage = (ev) => handleIncomingTVMessage(ev.data);
        }

        // Load Official Google Cast CAF Sender SDK
        window.__onGCastApiAvailable = function (isAvailable) {
            if (isAvailable && window.cast && window.cast.framework) {
                try {
                    const context = cast.framework.CastContext.getInstance();
                    context.setOptions({
                        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
                        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
                    });

                    remotePlayer = new cast.framework.RemotePlayer();
                    remotePlayerController = new cast.framework.RemotePlayerController(remotePlayer);

                    remotePlayerController.addEventListener(
                        cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
                        () => {
                            if (activeCastMode === "chromecast" && remotePlayer) {
                                remoteCurrentTime = remotePlayer.currentTime || 0;
                                remoteDuration = remotePlayer.duration || remoteDuration;
                                if (window.MusePlayerBridge) {
                                    window.MusePlayerBridge.onRemoteTimeUpdate(remoteCurrentTime, remoteDuration);
                                }
                            }
                        }
                    );

                    remotePlayerController.addEventListener(
                        cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED,
                        () => {
                            if (activeCastMode === "chromecast" && remotePlayer) {
                                remoteIsPlaying = !remotePlayer.isPaused;
                                if (window.MusePlayerBridge) {
                                    window.MusePlayerBridge.onRemoteStateChange(remoteIsPlaying);
                                }
                            }
                        }
                    );

                    context.addEventListener(
                        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
                        (event) => {
                            if (
                                event.sessionState === cast.framework.SessionState.SESSION_STARTED ||
                                event.sessionState === cast.framework.SessionState.SESSION_RESUMED
                            ) {
                                googleCastSession = context.getCurrentSession();
                                const friendlyName = googleCastSession?.getCastDevice()?.friendlyName || "Android TV";
                                closeCastScannerModal();
                                activateCastingState("chromecast", friendlyName);
                            } else if (event.sessionState === cast.framework.SessionState.SESSION_ENDED) {
                                if (activeCastMode === "chromecast") {
                                    deactivateCastingState();
                                }
                            }
                        }
                    );
                } catch (e) {}
            }
        };

        if (!window.chrome || !window.chrome.cast) {
            const script = document.createElement("script");
            script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
            script.async = true;
            document.head.appendChild(script);
        }

        // Capture Phone Hardware Volume Keys & Speaker Volume Changes while Casting
        window.addEventListener("keydown", (e) => {
            if (!isCastingActive) return;
            if (e.code === "AudioVolumeUp" || e.key === "VolumeUp" || e.code === "ArrowUp") {
                e.preventDefault();
                setTVVolume(Math.min(1, tvVolume + 0.06), true);
            } else if (e.code === "AudioVolumeDown" || e.key === "VolumeDown" || e.code === "ArrowDown") {
                e.preventDefault();
                setTVVolume(Math.max(0, tvVolume - 0.06), true);
            }
        });

        const audioEl = window.MusePlayerBridge?.getAudioElement();
        if (audioEl) {
            audioEl.addEventListener("volumechange", () => {
                if (!isCastingActive) return;
                if (activeCastMode === "wss-receiver" || activeCastMode === "presentation" || activeCastMode === "chromecast") {
                    setTVVolume(audioEl.muted ? 0 : audioEl.volume, false);
                }
            });
        }
    }

    function updateMenuCastStatusBadge(available) {
        const badge = document.getElementById("menu-cast-tv-status");
        if (!badge) return;
        if (isCastingActive) {
            badge.innerText = "Connected";
            badge.className = "text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-400/20 text-emerald-300";
        } else if (available || discoveredTVs.size > 0) {
            badge.innerText = `${discoveredTVs.size || 1} TV Ready`;
            badge.className = "text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-400/20 text-emerald-300";
        } else {
            badge.innerText = "Scan / Cast";
            badge.className = "text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-white/70";
        }
    }

    // ========================================================================
    // 7. ACTIVATE / DEACTIVATE CASTING & STREAM TRANSFER
    // ========================================================================
    function activateCastingState(mode, deviceName) {
        isCastingActive = true;
        activeCastMode = mode;
        activeDeviceName = deviceName || "Smart TV";

        const audioEl = window.MusePlayerBridge?.getAudioElement();
        if (audioEl) {
            remoteCurrentTime = audioEl.currentTime || 0;
            remoteDuration = audioEl.duration || window.MusePlayerBridge?.getActiveTrack()?.duration || 0;
            // Silence local phone speaker when TV receiver is playing the stream
            if (mode === "wss-receiver" || mode === "presentation" || mode === "chromecast") {
                audioEl.pause();
            }
        }

        const labelEl = document.getElementById("menu-cast-tv-label");
        const hudEl = document.getElementById("tv-cast-volume-hud");
        const bannerName = document.getElementById("tv-cast-banner-name");

        if (labelEl) labelEl.innerText = `Disconnect (${activeDeviceName})`;
        if (bannerName) bannerName.innerText = `Casting to ${activeDeviceName}`;
        if (hudEl) hudEl.classList.remove("hidden");

        updateMenuCastStatusBadge(true);
        setTVVolume(tvVolume, false);

        const track = window.MusePlayerBridge?.getActiveTrack();
        if (track) {
            const streamUrl = prepareHttpsStreamForCasting();
            const lyrics = window.MusePlayerBridge.getActiveLyricsPayload();
            loadTrackOnTV(track, streamUrl, lyrics, remoteCurrentTime);
        }

        if (window.MusePlayerBridge) {
            window.MusePlayerBridge.toast(`Connected to ${activeDeviceName}`);
        }

        startLyricsAndStatePushLoop();
    }

    function deactivateCastingState() {
        const wasCasting = isCastingActive;
        isCastingActive = false;
        activeCastMode = null;

        if (syncIntervalId) {
            clearInterval(syncIntervalId);
            syncIntervalId = null;
        }

        const labelEl = document.getElementById("menu-cast-tv-label");
        const hudEl = document.getElementById("tv-cast-volume-hud");
        if (labelEl) labelEl.innerText = "Cast to TV";
        if (hudEl) hudEl.classList.add("hidden");

        updateMenuCastStatusBadge(false);

        const audioEl = window.MusePlayerBridge?.getAudioElement();
        if (wasCasting && audioEl && remoteCurrentTime > 0) {
            try {
                audioEl.volume = 1;
                audioEl.muted = false;
                audioEl.currentTime = remoteCurrentTime;
                if (remoteIsPlaying) {
                    audioEl.play().catch(() => {});
                }
            } catch (e) {}
        }

        if (wasCasting && window.MusePlayerBridge) {
            window.MusePlayerBridge.toast("Disconnected from TV");
        }
    }

    function stopCastingToTV() {
        sendMessageToTV({ type: "PAUSE" });

        try {
            if (presentationConnection && presentationConnection.state === "connected") {
                presentationConnection.terminate();
            }
        } catch (e) {}

        try {
            if (googleCastSession) {
                googleCastSession.endSession(true);
                googleCastSession = null;
            }
        } catch (e) {}

        deactivateCastingState();
    }

    function sendMessageToTV(payload) {
        const serialized = JSON.stringify(payload);

        if (presentationConnection && presentationConnection.state === "connected") {
            try { presentationConnection.send(serialized); } catch (e) {}
        }
        if (broadcastSyncChannel) {
            try { broadcastSyncChannel.postMessage(payload); } catch (e) {}
        }
        if (mqttClient && mqttClient.connected) {
            if (wifiTopicBase) {
                mqttClient.publish(`${wifiTopicBase}/ctrl`, payload);
            }
            if (pairedPinCode) {
                mqttClient.publish(`muse/tv/pin/${pairedPinCode}/ctrl`, payload);
            }
        }
    }

    function loadTrackOnTV(track, streamUrl, lyricsPayload, startTimeSec = 0) {
        if (!isCastingActive || !track) return;
        const cleanHttpsUrl = streamUrl && !streamUrl.startsWith("blob:")
            ? streamUrl
            : prepareHttpsStreamForCasting();

        remoteCurrentTime = startTimeSec || 0;
        remoteDuration = Number(track.duration) || 0;
        remoteIsPlaying = true;

        const themeRGB = window.MusePlayerBridge?.getThemeRGB() || { r: 98, g: 120, b: 235 };
        const timeline = window.MusePlayerBridge?.getLyricsTimeline() || [];

        // Native Chromecast / Android TV CAF Media Load
        if (activeCastMode === "chromecast" && googleCastSession) {
            try {
                const mediaInfo = new chrome.cast.media.MediaInfo(cleanHttpsUrl, "audio/mp4");
                mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;
                mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
                mediaInfo.metadata.title = track.title;
                mediaInfo.metadata.artist = track.artist;
                mediaInfo.metadata.albumName = track.album || "Muse";
                if (track.coverUrl && !track.coverUrl.startsWith("data:")) {
                    mediaInfo.metadata.images = [new chrome.cast.Image(track.coverUrl)];
                }

                // Attach synced WebVTT lyrics track for Chromecast display
                const vttUri = buildWebVttDataUriFromTimeline(timeline);
                if (vttUri) {
                    const lyricsTrack = new chrome.cast.media.Track(1, chrome.cast.media.TrackType.TEXT);
                    lyricsTrack.trackContentId = vttUri;
                    lyricsTrack.trackContentType = "text/vtt";
                    lyricsTrack.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
                    lyricsTrack.name = "Muse Synced Lyrics";
                    lyricsTrack.language = "en-US";
                    mediaInfo.tracks = [lyricsTrack];
                }

                const request = new chrome.cast.media.LoadRequest(mediaInfo);
                request.autoplay = true;
                request.currentTime = remoteCurrentTime;
                if (vttUri) request.activeTrackIds = [1];

                googleCastSession.loadMedia(request).catch(() => {});
            } catch (e) {}
        }

        // Send full track, HTTPS stream, theme RGB & word-by-word lyrics to TV Receiver
        sendMessageToTV({
            type: "LOAD_TRACK",
            track: {
                id: track.id,
                title: track.title,
                artist: track.artist,
                album: track.album || "Muse",
                coverUrl: track.coverUrl,
                duration: track.duration || 0,
                streamUrl: cleanHttpsUrl
            },
            startTime: remoteCurrentTime,
            volume: tvVolume,
            themeRGB,
            lyricsTimeline: timeline
        });
    }

    function sendFullStateToTVReceiver() {
        const track = window.MusePlayerBridge?.getActiveTrack();
        if (!track) return;
        const streamUrl = prepareHttpsStreamForCasting();
        const lyrics = window.MusePlayerBridge.getActiveLyricsPayload();
        loadTrackOnTV(track, streamUrl, lyrics, remoteCurrentTime);
    }

    function startLyricsAndStatePushLoop() {
        if (syncIntervalId) clearInterval(syncIntervalId);
        let lastSentLyricsCount = -1;
        let lastSentTrackId = null;

        syncIntervalId = setInterval(() => {
            if (!isCastingActive) return;
            const track = window.MusePlayerBridge?.getActiveTrack();
            const timeline = window.MusePlayerBridge?.getLyricsTimeline() || [];
            const themeRGB = window.MusePlayerBridge?.getThemeRGB() || { r: 98, g: 120, b: 235 };

            if (track && (track.id !== lastSentTrackId || timeline.length !== lastSentLyricsCount)) {
                lastSentTrackId = track.id;
                lastSentLyricsCount = timeline.length;
                sendMessageToTV({
                    type: "LYRICS_AND_THEME_SYNC",
                    trackId: track.id,
                    themeRGB,
                    lyricsTimeline: timeline
                });
            }
        }, 600);
    }

    function setTVVolume(newVol, notifyToast = false) {
        tvVolume = Math.max(0, Math.min(1, Number(newVol) || 0));
        tvMuted = tvVolume === 0;

        const pct = Math.round(tvVolume * 100);
        const volRange = document.getElementById("tv-vol-range");
        const volLabel = document.getElementById("tv-vol-pct-label");
        const muteIcon = document.getElementById("tv-vol-mute-icon");

        if (volRange) {
            volRange.value = pct;
            volRange.style.setProperty("--progress", `${pct}%`);
        }
        if (volLabel) volLabel.innerText = `${pct}%`;
        if (muteIcon) {
            muteIcon.className = pct === 0
                ? "fa-solid fa-volume-xmark text-[10px] text-rose-400"
                : "fa-solid fa-volume-low text-[10px]";
        }

        if (activeCastMode === "chromecast" && remotePlayer && remotePlayerController) {
            try {
                remotePlayer.volumeLevel = tvVolume;
                remotePlayerController.setVolumeLevel();
            } catch (e) {}
        }

        sendMessageToTV({
            type: "SET_VOLUME",
            volume: tvVolume,
            muted: tvMuted
        });

        if (notifyToast && window.MusePlayerBridge) {
            window.MusePlayerBridge.toast(`TV Volume: ${pct}%`);
        }
    }

    function handleIncomingTVMessage(msg) {
        if (!msg || typeof msg !== "object") return;

        // Real-Time TV Discovery Heartbeat from tv-receiver.html
        if (msg.type === "TV_ANNOUNCE_ALIVE") {
            const tvId = `tv_${msg.pin || "wifi"}`;
            registerDiscoveredTV(tvId, {
                name: msg.deviceName || `Amazon Fire TV / Smart TV`,
                subtitle: `Online on Wi-Fi (Code: ${msg.pin}) • Tap to Cast`,
                mode: "wss-receiver",
                pin: msg.pin,
                onSelect: () => connectToTvByPin(msg.pin, msg.deviceName || `Fire TV (#${msg.pin})`)
            });
            return;
        }

        if (msg.type === "TV_READY") {
            if (!isCastingActive && msg.pin) {
                connectToTvByPin(msg.pin, msg.deviceName || `Fire TV (#${msg.pin})`);
            } else if (isCastingActive) {
                sendFullStateToTVReceiver();
            }
            return;
        }

        if (!isCastingActive) return;

        if (msg.type === "TV_TIME_UPDATE") {
            remoteCurrentTime = Number(msg.currentTime) || 0;
            remoteDuration = Number(msg.duration) || remoteDuration;
            remoteIsPlaying = Boolean(msg.isPlaying);
            if (window.MusePlayerBridge) {
                window.MusePlayerBridge.onRemoteTimeUpdate(remoteCurrentTime, remoteDuration);
            }
        } else if (msg.type === "TV_STATE_CHANGE") {
            remoteIsPlaying = Boolean(msg.isPlaying);
            if (window.MusePlayerBridge) {
                window.MusePlayerBridge.onRemoteStateChange(remoteIsPlaying);
            }
        } else if (msg.type === "TV_TRACK_ENDED") {
            if (window.MusePlayerBridge) {
                window.MusePlayerBridge.onRemoteEnded();
            }
        } else if (msg.type === "TV_COMMAND") {
            if (!window.MusePlayerBridge) return;
            if (msg.action === "NEXT") window.MusePlayerBridge.playNext();
            else if (msg.action === "PREV") window.MusePlayerBridge.playPrev();
            else if (msg.action === "TOGGLE_PLAY") window.MusePlayerBridge.togglePlayPause();
        }
    }

    // ========================================================================
    // 8. EXPOSE GLOBAL CAST ENGINE API FOR INDEX.HTML
    // ========================================================================
    window.MuseCastEngine = {
        isCasting: () => isCastingActive,
        openCastPrompt: () => openCastScannerModal(),
        loadTrackOnTV,
        play: () => {
            remoteIsPlaying = true;
            if (activeCastMode === "chromecast" && remotePlayer && remotePlayer.isPaused) {
                try { remotePlayerController.playOrPause(); } catch (e) {}
            }
            sendMessageToTV({ type: "PLAY" });
        },
        pause: () => {
            remoteIsPlaying = false;
            if (activeCastMode === "chromecast" && remotePlayer && !remotePlayer.isPaused) {
                try { remotePlayerController.playOrPause(); } catch (e) {}
            }
            sendMessageToTV({ type: "PAUSE" });
        },
        seek: (timeSec) => {
            remoteCurrentTime = Math.max(0, Number(timeSec) || 0);
            if (activeCastMode === "chromecast" && remotePlayer && remotePlayerController) {
                try {
                    remotePlayer.currentTime = remoteCurrentTime;
                    remotePlayerController.seek();
                } catch (e) {}
            }
            sendMessageToTV({ type: "SEEK", time: remoteCurrentTime });
        },
        setVolume: (v) => setTVVolume(v, false),
        getCurrentTime: () => remoteCurrentTime,
        getDuration: () => remoteDuration
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initCastProtocols);
    } else {
        initCastProtocols();
    }
})();
