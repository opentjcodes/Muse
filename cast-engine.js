// ============================================================================
// FILE: cast-engine.js (v2.0 — Fire TV Zero-Install DIAL, RemotePlayback & Presentation Engine)
// Works with Stock Amazon Fire TV (No extra TV apps required), Android TV,
// Chromecast, and AirPlay Smart TVs on the same Wi-Fi.
// ============================================================================

(function () {
    "use strict";

    const CAST_NAMESPACE = "urn:x-cast:com.muse.cast";
    const RECEIVER_URL = new URL("./tv-receiver.html", window.location.href).href;

    // Multi-protocol URL list:
    // 1. "cast-dial:youtube" triggers Chromium's built-in DIAL MediaRouteProvider (discovers stock Fire TV on port 8009!)
    // 2. "cast:CC1AD845" triggers Google Cast Default Media Receiver (Android TV / Chromecast)
    // 3. RECEIVER_URL triggers W3C Secondary Display Presentation (Wireless Display / Miracast / Desktop Cast)
    const DIAL_AND_CAST_URLS = [
        "cast-dial:youtube",
        "cast:CC1AD845",
        RECEIVER_URL
    ];

    let isCastingActive = false;
    let activeCastMode = null; // 'presentation' | 'dial' | 'remoteplayback' | 'chromecast' | 'airplay' | 'wifi-sync'
    let activeDeviceName = "Fire TV";

    let presentationRequest = null;
    let screenPresentationRequest = null;
    let presentationConnection = null;
    let googleCastSession = null;
    let broadcastSyncChannel = null;

    // Hidden <video> + <canvas> stream bridge:
    // Chrome Android's RemotePlayback API often ignores <audio> elements for TVs,
    // but discovers TVs reliably when bound to a <video> element with an HTTPS source.
    let castVideoBridge = null;

    // Same-Wi-Fi Instant Sync (pairs phone controller & TV receiver on the same public IP)
    let wifiRoomId = null;
    let wifiSyncPollTimer = null;

    // Discovered Fire TV DIAL IPs on port 8009
    let discoveredFireTvIps = JSON.parse(localStorage.getItem("muse_firetv_ips_v1") || "[]");
    let isScanningSubnet = false;

    let tvVolume = 0.85; // 0.0 to 1.0
    let tvMuted = false;
    let remoteCurrentTime = 0;
    let remoteDuration = 0;
    let remoteIsPlaying = false;
    let syncIntervalId = null;

    // ========================================================================
    // 1. CREATE HIDDEN <VIDEO> STREAM BRIDGE FOR FIRE TV / ANDROID REMOTE PLAYBACK
    // ========================================================================
    function ensureCastVideoBridge() {
        if (castVideoBridge) return castVideoBridge;
        castVideoBridge = document.createElement("video");
        castVideoBridge.id = "muse-cast-video-bridge";
        castVideoBridge.playsInline = true;
        castVideoBridge.disableRemotePlayback = false;
        castVideoBridge.preload = "metadata";
        castVideoBridge.style.cssText = "position:fixed;width:1px;height:1px;bottom:0;left:0;opacity:0.01;pointer-events:none;z-index:-1;";
        document.body.appendChild(castVideoBridge);

        if (castVideoBridge.remote) {
            castVideoBridge.remote.addEventListener("connecting", () => {
                if (window.MusePlayerBridge) window.MusePlayerBridge.toast("Connecting to TV...");
            });
            castVideoBridge.remote.addEventListener("connect", () => {
                closeCastHubModal();
                activateCastingState("remoteplayback", "Fire TV / Smart TV");
            });
            castVideoBridge.remote.addEventListener("disconnect", () => {
                if (activeCastMode === "remoteplayback") {
                    deactivateCastingState();
                }
            });
        }

        castVideoBridge.addEventListener("timeupdate", () => {
            if (isCastingActive && activeCastMode === "remoteplayback") {
                remoteCurrentTime = castVideoBridge.currentTime || 0;
                remoteDuration = castVideoBridge.duration || remoteDuration;
                remoteIsPlaying = !castVideoBridge.paused;
                if (window.MusePlayerBridge) {
                    window.MusePlayerBridge.onRemoteTimeUpdate(remoteCurrentTime, remoteDuration);
                }
            }
        });

        castVideoBridge.addEventListener("ended", () => {
            if (isCastingActive && activeCastMode === "remoteplayback" && window.MusePlayerBridge) {
                window.MusePlayerBridge.onRemoteEnded();
            }
        });

        return castVideoBridge;
    }

    // Ensures both <audio> and <video> bridge have a direct HTTPS stream URL (never blob:)
    // so Chrome's RemotePlayback / Cast never throws NotSupportedError.
    function prepareHttpsStreamForCasting() {
        const bridge = window.MusePlayerBridge;
        if (!bridge) return "";
        const track = bridge.getActiveTrack();
        const audioEl = bridge.getAudioElement();
        const httpsUrl = bridge.getStreamUrlForTrack(track);

        if (!httpsUrl) return "";

        const vBridge = ensureCastVideoBridge();
        if (vBridge.src !== httpsUrl) {
            vBridge.src = httpsUrl;
        }

        // If the main <audio> element was swapped to a RAM blob: URL, switch it back to HTTPS
        // so native audioEl.remote.prompt() and AirPlay also see a valid HTTPS stream.
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

    // ========================================================================
    // 2. INJECT 3-DOTS MENU BUTTON, DYNAMIC TV VOLUME BAR & CAST HUB MODAL
    // ========================================================================
    function injectCastUI() {
        // A. Inject "Cast to TV" inside #full-more-menu (3-dots menu in fullscreen player)
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
                <span id="menu-cast-tv-status" class="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-white/70">Fire TV / Cast</span>
            `;
            castBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (window.MusePlayerBridge) window.MusePlayerBridge.closeMoreMenu();
                if (isCastingActive) {
                    stopCastingToTV();
                } else {
                    openCastHubModal();
                }
            });
            moreMenu.appendChild(castBtn);
        }

        // Remove any legacy .m4a export buttons if present
        document.querySelectorAll('[onclick*="handleMenuDirectFileDownloadTap"], [onclick*="handleActionSheetExportFile"]').forEach((el) => {
            el.remove();
        });

        // B. Inject Dynamic TV Volume Control Bar inside Fullscreen Player (Shown ONLY when casting to TV)
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
                            <span id="tv-cast-banner-name" class="text-[11px] font-extrabold text-white truncate">Casting to Fire TV</span>
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

        // C. Inject Interactive Cast Hub Modal (Guarantees a fresh synchronous user gesture & discovers Fire TV on port 8009)
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
                                <p id="cast-hub-subtitle" class="text-[11px] text-white/60 font-medium">Zero-install wireless streaming & lyrics</p>
                            </div>
                        </div>
                        <button type="button" id="cast-hub-close-btn" class="w-8 h-8 circle-btn liquid-control-btn flex items-center justify-center">
                            <i class="fa-solid fa-xmark text-xs"></i>
                        </button>
                    </div>

                    <!-- Primary Synchronous Gesture Buttons -->
                    <div class="space-y-2.5">
                        <!-- 1. Native DIAL / Cast Device Picker (Discovers Fire TV & Android TV) -->
                        <button type="button" id="cast-btn-native-dial" class="w-full p-3.5 rounded-2xl liquid-control-btn liquid-hero-play flex items-center justify-between text-left">
                            <div class="flex items-center gap-3 min-w-0">
                                <i class="fa-solid fa-wifi text-base text-white"></i>
                                <div class="min-w-0">
                                    <div class="text-xs font-extrabold text-white">Select TV from Device Picker</div>
                                    <div class="text-[10px] text-white/75 truncate">Fire TV (DIAL), Android TV, Chromecast & AirPlay</div>
                                </div>
                            </div>
                            <i class="fa-solid fa-chevron-right text-xs text-white/80"></i>
                        </button>

                        <!-- 2. Direct Media Stream Cast (RemotePlayback / DLNA / UPnP) -->
                        <button type="button" id="cast-btn-remote-media" class="w-full p-3.5 rounded-2xl liquid-data-card flex items-center justify-between text-left">
                            <div class="flex items-center gap-3 min-w-0">
                                <i class="fa-solid fa-tower-broadcast text-base" style="color: var(--theme-color-bright)"></i>
                                <div class="min-w-0">
                                    <div class="text-xs font-extrabold text-white">Direct Audio/Video Stream to TV</div>
                                    <div class="text-[10px] text-white/55 truncate">Streams 320kbps directly via RemotePlayback / AirPlay</div>
                                </div>
                            </div>
                            <i class="fa-solid fa-bolt text-xs text-white/60"></i>
                        </button>

                        <!-- 3. Wireless Display / Smart View Dual-Screen Receiver (For Stock Fire TV Stick Miracast) -->
                        <button type="button" id="cast-btn-dual-screen" class="w-full p-3.5 rounded-2xl liquid-data-card flex items-center justify-between text-left">
                            <div class="flex items-center gap-3 min-w-0">
                                <i class="fa-solid fa-display text-base text-emerald-400"></i>
                                <div class="min-w-0">
                                    <div class="text-xs font-extrabold text-white">Fire TV Receiver Screen (Lyrics + 3 Controls)</div>
                                    <div class="text-[10px] text-white/55 truncate">Projects TV-only lyrics view while phone stays controller</div>
                                </div>
                            </div>
                            <i class="fa-solid fa-up-right-from-square text-xs text-white/60"></i>
                        </button>
                    </div>

                    <!-- Auto-Discovered Fire TV on Local Wi-Fi (Port 8009 DIAL) -->
                    <div class="p-3 rounded-2xl bg-black/35 border border-white/10 space-y-2.5">
                        <div class="flex items-center justify-between">
                            <span class="text-[10px] font-extrabold uppercase tracking-wider text-white/60 flex items-center gap-1.5">
                                <i id="firetv-scan-spinner" class="fa-solid fa-radar text-[10px]" style="color: var(--theme-color-bright)"></i>
                                <span id="firetv-scan-status">Fire TV Direct Wake (Same Wi-Fi Port 8009)</span>
                            </span>
                            <button type="button" id="firetv-rescan-btn" class="text-[10px] font-extrabold text-sky-300 hover:underline">
                                Scan Wi-Fi
                            </button>
                        </div>

                        <div id="discovered-firetv-list" class="flex flex-col gap-1.5"></div>

                        <div class="flex items-center gap-2 pt-1">
                            <input
                                id="firetv-manual-ip"
                                type="text"
                                placeholder="Fire TV IP (optional, e.g. 192.168.1.50)"
                                class="flex-1 h-8 px-3 rounded-xl bg-white/5 border border-white/15 text-xs font-semibold text-white placeholder-white/35 focus:outline-none focus:border-white/40"
                            />
                            <button type="button" id="firetv-connect-ip-btn" class="h-8 px-3 rounded-xl liquid-control-btn text-[11px] font-extrabold text-white">
                                Wake & Cast
                            </button>
                        </div>
                    </div>
                </div>
            `;
            modal.addEventListener("click", closeCastHubModal);
            document.body.appendChild(modal);

            document.getElementById("cast-hub-close-btn").onclick = closeCastHubModal;

            // Bind Button 1: Native DIAL + Cast Picker (Synchronous User Gesture!)
            document.getElementById("cast-btn-native-dial").addEventListener("click", (e) => {
                e.stopPropagation();
                triggerNativeDialOrCastPickerSynchronous();
            });

            // Bind Button 2: Direct RemotePlayback / AirPlay Picker (Synchronous User Gesture!)
            document.getElementById("cast-btn-remote-media").addEventListener("click", (e) => {
                e.stopPropagation();
                triggerDirectRemotePlaybackSynchronous();
            });

            // Bind Button 3: Secondary Display Presentation (Miracast / Fire TV Display Mirroring Receiver)
            document.getElementById("cast-btn-dual-screen").addEventListener("click", (e) => {
                e.stopPropagation();
                triggerSecondaryDisplayReceiverSynchronous();
            });

            // Bind Rescan & Manual Fire TV IP Wake
            document.getElementById("firetv-rescan-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                scanLocalSubnetForFireTV();
            });

            document.getElementById("firetv-connect-ip-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                const ip = (document.getElementById("firetv-manual-ip")?.value || "").trim();
                if (!ip) {
                    if (window.MusePlayerBridge) window.MusePlayerBridge.toast("Enter your Fire TV IP (Settings > My Fire TV > About > Network)", "error");
                    return;
                }
                wakeAndCastToFireTvIp(ip);
            });
        }
    }

    function openCastHubModal() {
        prepareHttpsStreamForCasting();
        renderDiscoveredFireTvList();
        const modal = document.getElementById("muse-cast-hub-modal");
        if (modal) {
            modal.classList.remove("hidden");
            modal.classList.add("flex");
        }
        if (discoveredFireTvIps.length === 0 && !isScanningSubnet) {
            scanLocalSubnetForFireTV();
        }
    }

    function closeCastHubModal() {
        const modal = document.getElementById("muse-cast-hub-modal");
        if (modal) {
            modal.classList.add("hidden");
            modal.classList.remove("flex");
        }
    }

    // ========================================================================
    // 3. SYNCHRONOUS USER-GESTURE CAST TRIGGERS (NO AWAIT BEFORE PROMPT!)
    // ========================================================================

    // Option 1: Triggers Chrome's Native Cast / DIAL Device Picker
    function triggerNativeDialOrCastPickerSynchronous() {
        prepareHttpsStreamForCasting();

        // Use PresentationRequest with cast-dial:youtube + cast:CC1AD845 so Chrome Android
        // queries BOTH the DIAL MediaRouteProvider (Fire TV port 8009) and Cast MediaRouteProvider!
        if ("PresentationRequest" in window) {
            try {
                const req = presentationRequest || new PresentationRequest(DIAL_AND_CAST_URLS);
                req.start().then((conn) => {
                    closeCastHubModal();
                    attachPresentationConnection(conn);
                }).catch(() => {
                    // Fallback immediately to video remote playback prompt
                    triggerDirectRemotePlaybackSynchronous(true);
                });
                return;
            } catch (e) {}
        }

        triggerDirectRemotePlaybackSynchronous(true);
    }

    // Option 2: Triggers HTML5 RemotePlayback / AirPlay on HTTPS Stream
    function triggerDirectRemotePlaybackSynchronous(isFallback = false) {
        const httpsUrl = prepareHttpsStreamForCasting();
        const audioEl = window.MusePlayerBridge?.getAudioElement();
        const vBridge = ensureCastVideoBridge();

        // Apple AirPlay (Fire TV Smart TVs — Toshiba, Insignia, Hisense, Omni & Apple TV)
        if (audioEl && typeof audioEl.webkitShowPlaybackTargetPicker === "function") {
            try {
                audioEl.webkitShowPlaybackTargetPicker();
                closeCastHubModal();
                activateCastingState("airplay", "Fire TV (AirPlay)");
                return;
            } catch (e) {}
        }

        // Chrome Android RemotePlayback on <video> bridge
        if (vBridge && vBridge.remote && typeof vBridge.remote.prompt === "function") {
            vBridge.remote.prompt().then(() => {
                closeCastHubModal();
                activateCastingState("remoteplayback", "Fire TV / Smart TV");
            }).catch(() => {
                // Also try <audio> remote.prompt()
                if (audioEl && audioEl.remote && typeof audioEl.remote.prompt === "function") {
                    audioEl.remote.prompt().then(() => {
                        closeCastHubModal();
                        activateCastingState("remoteplayback", "Fire TV / Smart TV");
                    }).catch(() => {
                        if (!isFallback && window.MusePlayerBridge) {
                            window.MusePlayerBridge.toast("Tip: Use 'Fire TV Receiver Screen' or scan for your Fire TV IP below", "info");
                        }
                    });
                }
            });
            return;
        }

        if (audioEl && audioEl.remote && typeof audioEl.remote.prompt === "function") {
            audioEl.remote.prompt().then(() => {
                closeCastHubModal();
                activateCastingState("remoteplayback", "Fire TV / Smart TV");
            }).catch(() => {});
        }
    }

    // Option 3: Projects ONLY tv-receiver.html (Lyrics + 3 Controls) to Secondary Display / Miracast
    function triggerSecondaryDisplayReceiverSynchronous() {
        prepareHttpsStreamForCasting();

        if ("PresentationRequest" in window) {
            try {
                if (!screenPresentationRequest) {
                    screenPresentationRequest = new PresentationRequest([RECEIVER_URL]);
                }
                screenPresentationRequest.start().then((conn) => {
                    closeCastHubModal();
                    attachPresentationConnection(conn);
                }).catch(() => {
                    launchPopoutOrWirelessReceiverFallback();
                });
                return;
            } catch (e) {}
        }

        launchPopoutOrWirelessReceiverFallback();
    }

    function launchPopoutOrWirelessReceiverFallback() {
        closeCastHubModal();
        activateCastingState("wifi-sync", "Fire TV Receiver");
        if (window.MusePlayerBridge) {
            window.MusePlayerBridge.toast("Receiver Active! Connect phone 'Cast / Smart View' to Fire TV — phone controls volume & tracks.");
        }
    }

    // ========================================================================
    // 4. FIRE TV PORT 8009 DIAL SUBNET SCANNER & ZERO-APP WAKE LAUNCHER
    // ========================================================================
    function renderDiscoveredFireTvList() {
        const listEl = document.getElementById("discovered-firetv-list");
        if (!listEl) return;
        listEl.innerHTML = "";

        if (discoveredFireTvIps.length === 0) {
            listEl.innerHTML = `
                <div class="text-[11px] text-white/45 py-1">
                    No cached Fire TV IP yet. Tap <b>Scan Wi-Fi</b> or enter your Fire TV IP once.
                </div>
            `;
            return;
        }

        discoveredFireTvIps.forEach((ip) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "w-full h-9 px-3 rounded-xl liquid-control-btn flex items-center justify-between text-xs font-bold text-white";
            btn.innerHTML = `
                <span class="flex items-center gap-2">
                    <i class="fa-solid fa-fire-flame-curved text-amber-400"></i>
                    <span>Amazon Fire TV (${ip})</span>
                </span>
                <span class="text-[10px] font-extrabold text-emerald-300">Connect &rarr;</span>
            `;
            btn.onclick = () => wakeAndCastToFireTvIp(ip);
            listEl.appendChild(btn);
        });
    }

    // Probes local Wi-Fi for Fire TV's built-in DIAL server on port 8009
    async function probeFireTvDialPort(ip, timeoutMs = 1100) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            // Fire TV always keeps TCP port 8009 open for DIAL (/apps/FireTVRemote)
            await fetch(`http://${ip}:8009/apps/FireTVRemote`, {
                method: "GET",
                mode: "no-cors",
                signal: controller.signal
            });
            clearTimeout(timer);
            return true;
        } catch (err) {
            clearTimeout(timer);
            return false;
        }
    }

    async function scanLocalSubnetForFireTV() {
        if (isScanningSubnet) return;
        isScanningSubnet = true;

        const statusEl = document.getElementById("firetv-scan-status");
        const spinnerEl = document.getElementById("firetv-scan-spinner");
        if (statusEl) statusEl.innerText = "Scanning Wi-Fi for Fire TV (Port 8009)...";
        if (spinnerEl) spinnerEl.className = "fa-solid fa-spinner fa-spin text-[10px] text-amber-400";

        // Common home Wi-Fi subnets (including JioFiber 192.168.29.x, Airtel/ACT 192.168.1.x, TP-Link 192.168.0.x, Xiaomi 192.168.31.x)
        const subnets = ["192.168.1", "192.168.29", "192.168.0", "192.168.31", "10.0.0"];
        const foundIps = new Set(discoveredFireTvIps);

        for (const sub of subnets) {
            const batch = [];
            // Scan common DHCP client range (.2 to .45 and .100 to .125)
            const hostIds = [
                ...Array.from({ length: 35 }, (_, i) => i + 2),
                ...Array.from({ length: 20 }, (_, i) => i + 100)
            ];

            for (const h of hostIds) {
                const candidateIp = `${sub}.${h}`;
                batch.push(
                    probeFireTvDialPort(candidateIp, 950).then((alive) => {
                        if (alive && !foundIps.has(candidateIp)) {
                            foundIps.add(candidateIp);
                            discoveredFireTvIps = Array.from(foundIps).slice(0, 6);
                            try {
                                localStorage.setItem("muse_firetv_ips_v1", JSON.stringify(discoveredFireTvIps));
                            } catch (e) {}
                            renderDiscoveredFireTvList();
                        }
                    })
                );
                if (batch.length >= 18) {
                    await Promise.allSettled(batch.splice(0, batch.length));
                }
            }
            await Promise.allSettled(batch);
            if (foundIps.size > 0) break;
        }

        isScanningSubnet = false;
        if (spinnerEl) spinnerEl.className = "fa-solid fa-circle-check text-[10px] text-emerald-400";
        if (statusEl) {
            statusEl.innerText = discoveredFireTvIps.length > 0
                ? `Found ${discoveredFireTvIps.length} Fire TV device(s) on Wi-Fi`
                : "Enter Fire TV IP below (or use Device Picker above)";
        }
    }

    function wakeAndCastToFireTvIp(ip) {
        const cleanIp = ip.replace(/^https?:\/\//, "").split(":")[0].trim();
        if (!cleanIp) return;

        if (!discoveredFireTvIps.includes(cleanIp)) {
            discoveredFireTvIps.unshift(cleanIp);
            try {
                localStorage.setItem("muse_firetv_ips_v1", JSON.stringify(discoveredFireTvIps.slice(0, 6)));
            } catch (e) {}
            renderDiscoveredFireTvList();
        }

        // 1. Wake up Fire TV via its built-in DIAL Server on Port 8009 (no-cors POST)
        try {
            fetch(`http://${cleanIp}:8009/apps/FireTVRemote`, {
                method: "POST",
                mode: "no-cors",
                headers: { "Content-Type": "text/plain" },
                body: JSON.stringify({ action: "launch", url: RECEIVER_URL })
            }).catch(() => {});

            // Also ping built-in Silk / Web Receiver via DIAL if present on Fire OS
            fetch(`http://${cleanIp}:8009/apps/com.amazon.cloud9`, {
                method: "POST",
                mode: "no-cors",
                headers: { "Content-Type": "text/plain" },
                body: RECEIVER_URL
            }).catch(() => {});
        } catch (e) {}

        closeCastHubModal();
        activateCastingState("dial", `Fire TV (${cleanIp})`);

        // Also trigger native DIAL/RemotePlayback picker so audio routes to Fire TV
        triggerNativeDialOrCastPickerSynchronous();
    }

    // ========================================================================
    // 5. SAME-WI-FI CLOUD RELAY + PRESENTATION API + GOOGLE CAST INITIALIZATION
    // ========================================================================
    async function initSameWifiPairingId() {
        try {
            const res = await fetch("https://api.ipify.org?format=json");
            if (res.ok) {
                const data = await res.json();
                if (data && data.ip) {
                    wifiRoomId = "muse_wifi_" + data.ip.replace(/[^a-zA-Z0-9]/g, "_");
                }
            }
        } catch (e) {
            wifiRoomId = "muse_wifi_local_default";
        }
    }

    function initCastProtocols() {
        injectCastUI();
        ensureCastVideoBridge();
        initSameWifiPairingId();

        // A. Initialize W3C Presentation API with DIAL + Cast + Receiver URLs
        if ("PresentationRequest" in window) {
            try {
                presentationRequest = new PresentationRequest(DIAL_AND_CAST_URLS);
                navigator.presentation.defaultRequest = presentationRequest;

                presentationRequest.getAvailability().then((availability) => {
                    updateMenuCastStatusBadge(availability.value);
                    availability.onchange = () => updateMenuCastStatusBadge(availability.value);
                }).catch(() => {});

                presentationRequest.onconnectionavailable = (event) => {
                    attachPresentationConnection(event.connection);
                };
            } catch (e) {}
        }

        // B. Local BroadcastChannel (Syncs across tabs / secondary displays)
        if ("BroadcastChannel" in window) {
            broadcastSyncChannel = new BroadcastChannel("muse_tv_cast_channel_v1");
            broadcastSyncChannel.onmessage = (ev) => handleIncomingTVMessage(ev.data);
        }

        // C. Load Google Cast Sender SDK for Android TV / Chromecast
        if (!window.chrome || !window.chrome.cast) {
            const script = document.createElement("script");
            script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
            script.async = true;
            document.head.appendChild(script);
        }

        window.__onGCastApiAvailable = function (isAvailable) {
            if (isAvailable && window.cast && window.cast.framework) {
                try {
                    const context = cast.framework.CastContext.getInstance();
                    context.setOptions({
                        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
                        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
                    });
                    context.addEventListener(
                        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
                        (event) => {
                            if (
                                event.sessionState === cast.framework.SessionState.SESSION_STARTED ||
                                event.sessionState === cast.framework.SessionState.SESSION_RESUMED
                            ) {
                                googleCastSession = context.getCurrentSession();
                                const friendlyName = googleCastSession?.getCastDevice()?.friendlyName || "Smart TV";
                                closeCastHubModal();
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

        // D. Hardware Volume Keys & Phone Speaker Volume Bridge when Casting
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
                setTVVolume(audioEl.muted ? 0 : audioEl.volume, false);
            });
        }
    }

    function updateMenuCastStatusBadge(available) {
        const badge = document.getElementById("menu-cast-tv-status");
        if (!badge) return;
        if (isCastingActive) {
            badge.innerText = "Connected";
            badge.className = "text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-400/20 text-emerald-300";
        } else if (available) {
            badge.innerText = "TV Ready";
            badge.className = "text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-400/20 text-sky-300";
        } else {
            badge.innerText = "Fire TV / Cast";
            badge.className = "text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-white/70";
        }
    }

    function attachPresentationConnection(connection) {
        presentationConnection = connection;

        const onConnected = () => {
            closeCastHubModal();
            activateCastingState("presentation", "Fire TV / Smart TV");
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

    function activateCastingState(mode, deviceName) {
        isCastingActive = true;
        activeCastMode = mode;
        activeDeviceName = deviceName || "Fire TV";

        const audioEl = window.MusePlayerBridge?.getAudioElement();
        if (audioEl) {
            remoteCurrentTime = audioEl.currentTime || 0;
            remoteDuration = audioEl.duration || window.MusePlayerBridge?.getActiveTrack()?.duration || 0;
            // If streaming on separate receiver (Presentation / Chromecast), pause local phone speaker
            if (mode === "presentation" || mode === "chromecast") {
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
        try {
            if (presentationConnection && presentationConnection.state === "connected") {
                sendMessageToTV({ type: "TERMINATE" });
                presentationConnection.terminate();
            }
        } catch (e) {}

        try {
            if (googleCastSession) {
                googleCastSession.endSession(true);
                googleCastSession = null;
            }
        } catch (e) {}

        try {
            if (castVideoBridge) {
                castVideoBridge.pause();
            }
        } catch (e) {}

        deactivateCastingState();
    }

    // ========================================================================
    // 6. REAL-TIME STREAM, WORD-BY-WORD LYRICS & DYNAMIC TV VOLUME SYNC
    // ========================================================================
    function sendMessageToTV(payload) {
        const serialized = JSON.stringify(payload);
        if (presentationConnection && presentationConnection.state === "connected") {
            try { presentationConnection.send(serialized); } catch (e) {}
        }
        if (broadcastSyncChannel) {
            try { broadcastSyncChannel.postMessage(payload); } catch (e) {}
        }
        if (googleCastSession && activeCastMode === "chromecast") {
            try { googleCastSession.sendMessage(CAST_NAMESPACE, payload); } catch (e) {}
        }
        // Same-Wi-Fi instant cloud relay (allows zero-config sync if TV opens tv-receiver.html)
        if (wifiRoomId && (payload.type === "LOAD_TRACK" || payload.type === "SET_VOLUME" || payload.type === "PLAY" || payload.type === "PAUSE" || payload.type === "SEEK")) {
            fetch(`https://ntfy.sh/${wifiRoomId}`, {
                method: "POST",
                body: serialized
            }).catch(() => {});
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

        if (activeCastMode === "remoteplayback" && castVideoBridge) {
            if (castVideoBridge.src !== cleanHttpsUrl) {
                castVideoBridge.src = cleanHttpsUrl;
            }
            castVideoBridge.currentTime = remoteCurrentTime;
            castVideoBridge.play().catch(() => {});
        } else if ((activeCastMode === "dial" || activeCastMode === "wifi-sync" || activeCastMode === "airplay") && window.MusePlayerBridge) {
            const audioEl = window.MusePlayerBridge.getAudioElement();
            if (audioEl && audioEl.paused) {
                audioEl.play().catch(() => {});
            }
        }

        if (activeCastMode === "chromecast" && googleCastSession) {
            try {
                const mediaInfo = new chrome.cast.media.MediaInfo(cleanHttpsUrl, "audio/mp4");
                mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
                mediaInfo.metadata.title = track.title;
                mediaInfo.metadata.artist = track.artist;
                mediaInfo.metadata.albumName = track.album || "Muse";
                mediaInfo.metadata.images = [new chrome.cast.Image(track.coverUrl)];
                mediaInfo.customData = {
                    lyricsTimeline: timeline,
                    themeRGB
                };

                const request = new chrome.cast.media.LoadRequest(mediaInfo);
                request.autoplay = true;
                request.currentTime = remoteCurrentTime;
                googleCastSession.loadMedia(request).catch(() => {});
            } catch (e) {}
        }

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

            // Keep time updated if using direct audio/dial mode
            if (activeCastMode === "dial" || activeCastMode === "wifi-sync" || activeCastMode === "airplay") {
                const audioEl = window.MusePlayerBridge?.getAudioElement();
                if (audioEl) {
                    remoteCurrentTime = audioEl.currentTime || 0;
                    remoteDuration = audioEl.duration || track?.duration || 0;
                    if (window.MusePlayerBridge) {
                        window.MusePlayerBridge.onRemoteTimeUpdate(remoteCurrentTime, remoteDuration);
                    }
                }
            }

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

    // Dynamically controls TV sound from the phone slider or phone volume buttons
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

        // Apply to active cast pipeline
        if (activeCastMode === "chromecast" && googleCastSession) {
            try { googleCastSession.setVolume(tvVolume); } catch (e) {}
        }
        if (castVideoBridge) {
            try {
                castVideoBridge.volume = tvVolume;
                castVideoBridge.muted = tvMuted;
            } catch (e) {}
        }
        if (activeCastMode === "dial" || activeCastMode === "airplay" || activeCastMode === "wifi-sync") {
            const audioEl = window.MusePlayerBridge?.getAudioElement();
            if (audioEl) {
                try {
                    audioEl.volume = tvVolume;
                    audioEl.muted = tvMuted;
                } catch (e) {}
            }
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
        } else if (msg.type === "TV_READY") {
            sendFullStateToTVReceiver();
        }
    }

    // ========================================================================
    // 7. EXPOSE GLOBAL CAST ENGINE API FOR INDEX.HTML
    // ========================================================================
    window.MuseCastEngine = {
        isCasting: () => isCastingActive,
        openCastPrompt: () => openCastHubModal(),
        loadTrackOnTV,
        play: () => {
            remoteIsPlaying = true;
            if (activeCastMode === "remoteplayback" && castVideoBridge) {
                castVideoBridge.play().catch(() => {});
            } else if (activeCastMode === "dial" || activeCastMode === "wifi-sync" || activeCastMode === "airplay") {
                window.MusePlayerBridge?.getAudioElement()?.play().catch(() => {});
            }
            sendMessageToTV({ type: "PLAY" });
        },
        pause: () => {
            remoteIsPlaying = false;
            if (activeCastMode === "remoteplayback" && castVideoBridge) {
                castVideoBridge.pause();
            } else if (activeCastMode === "dial" || activeCastMode === "wifi-sync" || activeCastMode === "airplay") {
                window.MusePlayerBridge?.getAudioElement()?.pause();
            }
            sendMessageToTV({ type: "PAUSE" });
        },
        seek: (timeSec) => {
            remoteCurrentTime = Math.max(0, Number(timeSec) || 0);
            if (activeCastMode === "remoteplayback" && castVideoBridge) {
                castVideoBridge.currentTime = remoteCurrentTime;
            } else if (activeCastMode === "dial" || activeCastMode === "wifi-sync" || activeCastMode === "airplay") {
                const a = window.MusePlayerBridge?.getAudioElement();
                if (a) a.currentTime = remoteCurrentTime;
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
