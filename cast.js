
// ============================================================================
// MUSE UNIVERSAL TV CAST ENGINE (cast.js)
// Works on Fire TV (Silk Browser - Zero App Install), Android TV, Smart TVs,
// W3C Presentation API, RemotePlayback API & PeerJS WebRTC P2P DataChannel.
// ============================================================================

(function () {
    const PEERJS_CDN = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
    const PEER_PREFIX = "muse-tv-room-v6-";

    let peerLibLoaded = false;
    let hostPeer = null;
    let activeConnections = new Map();
    let presentationConn = null;
    let localBroadcast = null;

    let roomPinCode = localStorage.getItem("muse_cast_pin_code") || "";
    if (!/^\d{4}$/.test(roomPinCode)) {
        roomPinCode = String(Math.floor(1000 + Math.random() * 9000));
        try { localStorage.setItem("muse_cast_pin_code", roomPinCode); } catch (e) {}
    }

    let isCastingActive = false;
    let connectedDeviceName = "Fire TV / Smart TV";
    let currentTvVolume = 1.0;

    try {
        if ("BroadcastChannel" in window) {
            localBroadcast = new BroadcastChannel("muse_local_tv_cast_channel");
            localBroadcast.onmessage = (ev) => handleIncomingReceiverPacket(ev.data, "Local TV Tab");
        }
    } catch (e) {}

    function loadPeerJsLibrary() {
        if (window.Peer || peerLibLoaded) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = PEERJS_CDN;
            s.async = true;
            s.onload = () => {
                peerLibLoaded = true;
                resolve();
            };
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    function getTvReceiverUrl(includeCode = true) {
        const base = window.location.href.split("?")[0].split("#")[0].replace(/\/index\.html$/i, "/");
        const cleanDir = base.endsWith("/") ? base : base + "/";
        return includeCode ? `${cleanDir}tv.html?code=${roomPinCode}` : `${cleanDir}tv.html`;
    }

    function injectCastModalUI() {
        if (document.getElementById("muse-cast-modal")) return;

        const modal = document.createElement("div");
        modal.id = "muse-cast-modal";
        modal.className = "fixed inset-0 z-[105] hidden items-center justify-center p-4 modal-backdrop";
        modal.onclick = () => closeCastModal();

        modal.innerHTML = `
            <div class="liquid-glass rounded-[2rem] w-full max-w-md p-5 sm:p-6 space-y-4 max-h-[90dvh] overflow-y-auto no-scrollbar" onclick="event.stopPropagation()">
                <div class="flex items-center justify-between border-b border-white/10 pb-3">
                    <div class="flex items-center gap-2.5">
                        <div class="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-400/30 flex items-center justify-center text-emerald-300">
                            <i class="fa-solid fa-tv text-xs"></i>
                        </div>
                        <div>
                            <h3 class="text-base sm:text-lg font-extrabold text-white tracking-tight">Cast to Any TV</h3>
                            <p id="cast-modal-status-sub" class="text-[11px] font-medium text-white/55">Fire TV (No App Needed) • Android TV • Smart TV</p>
                        </div>
                    </div>
                    <button onclick="window.MuseCast.closeModal()" class="w-8 h-8 circle-btn liquid-control-btn flex items-center justify-center">
                        <i class="fa-solid fa-xmark text-xs"></i>
                    </button>
                </div>

                <!-- ACTIVE CONNECTION & DYNAMIC TV VOLUME PANEL -->
                <div id="cast-active-control-box" class="hidden p-4 rounded-2xl bg-emerald-500/10 border border-emerald-400/30 space-y-3">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping flex-shrink-0"></span>
                            <span id="cast-connected-title" class="text-xs font-extrabold text-emerald-300 truncate">Connected to Fire TV / Android TV</span>
                        </div>
                        <button onclick="window.MuseCast.disconnectAll()" class="px-3 py-1 rounded-full bg-rose-500/20 border border-rose-400/35 text-[10px] font-extrabold text-rose-300">
                            Disconnect
                        </button>
                    </div>

                    <div class="space-y-1.5 pt-1 border-t border-white/10">
                        <div class="flex items-center justify-between text-[11px] font-bold text-white/80">
                            <span class="flex items-center gap-1.5">
                                <i class="fa-solid fa-volume-high text-emerald-300 text-xs"></i>
                                <span>TV Speaker Sound (Phone Controlled)</span>
                            </span>
                            <span id="cast-modal-vol-pct" class="tabular-nums text-emerald-300 font-extrabold">100%</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <button onclick="window.MuseCast.stepVolume(-0.1)" class="w-8 h-8 circle-btn liquid-control-btn flex items-center justify-center text-xs">-</button>
                            <input
                                id="cast-modal-vol-slider"
                                type="range"
                                min="0"
                                max="150"
                                step="1"
                                value="100"
                                style="--progress: 66.7%; pointer-events: auto;"
                                oninput="window.MuseCast.setVolume(this.value / 100)"
                                class="w-full cursor-pointer"
                            />
                            <button onclick="window.MuseCast.stepVolume(0.1)" class="w-8 h-8 circle-btn liquid-control-btn flex items-center justify-center text-xs">+</button>
                        </div>
                    </div>
                </div>

                <!-- PAIR BY TV 4-DIGIT CODE (INSTANT FIRE TV / ANDROID TV PAIRING) -->
                <div class="p-4 rounded-2xl bg-black/40 border border-white/10 space-y-3">
                    <div class="flex items-center justify-between">
                        <span class="text-xs font-extrabold text-white flex items-center gap-2">
                            <span class="w-5 h-5 rounded-full bg-white/10 text-[10px] flex items-center justify-center">1</span>
                            <span>Enter 4-Digit Code Shown on TV</span>
                        </span>
                        <span class="text-[10px] font-bold text-emerald-300">Zero App Install</span>
                    </div>
                    <p class="text-[11px] text-white/55 leading-relaxed">
                        On your <b>Fire TV (Silk Browser)</b> or <b>Android TV Browser</b>, open <b id="cast-short-tv-url" class="text-white select-all"></b> and enter the 4-digit code shown on the TV screen:
                    </p>
                    <div class="flex items-center gap-2">
                        <input
                            id="cast-target-tv-pin-input"
                            type="text"
                            inputmode="numeric"
                            maxlength="4"
                            placeholder="e.g. 4829"
                            class="w-full h-11 px-4 rounded-2xl bg-black/50 border border-white/15 text-center text-base font-extrabold tracking-[0.35em] text-white placeholder-white/25 focus:outline-none focus:border-emerald-400"
                        />
                        <button onclick="window.MuseCast.connectToTvPin()" id="cast-connect-pin-btn" class="h-11 px-5 rounded-2xl liquid-control-btn liquid-hero-play text-xs font-extrabold whitespace-nowrap">
                            Connect TV
                        </button>
                    </div>
                </div>

                <!-- OR SCAN QR / USE PHONE ROOM CODE -->
                <div class="p-4 rounded-2xl bg-black/35 border border-white/10 space-y-3">
                    <div class="flex items-center justify-between">
                        <span class="text-xs font-extrabold text-white flex items-center gap-2">
                            <span class="w-5 h-5 rounded-full bg-white/10 text-[10px] flex items-center justify-center">2</span>
                            <span>Or Pair TV Using Your Phone's Code</span>
                        </span>
                        <button onclick="window.MuseCast.regenerateRoomPin()" class="text-[10px] font-bold text-white/50 hover:text-white">
                            <i class="fa-solid fa-rotate mr-1"></i>New Code
                        </button>
                    </div>

                    <div class="flex items-center justify-between gap-4 bg-black/40 p-3 rounded-2xl border border-white/10">
                        <div class="space-y-1">
                            <span class="text-[10px] uppercase tracking-wider font-bold text-white/45 block">Your Phone Cast PIN</span>
                            <div id="cast-phone-room-pin" class="text-2xl sm:text-3xl font-black tracking-[0.25em] text-white tabular-nums">${roomPinCode}</div>
                            <span id="cast-peer-ready-badge" class="text-[10px] font-semibold text-emerald-400 block">Ready for TV connection</span>
                        </div>
                        <div class="w-20 h-20 rounded-xl bg-white p-1.5 flex-shrink-0">
                            <img id="cast-qr-img" alt="TV QR" class="w-full h-full object-contain" src="" />
                        </div>
                    </div>
                </div>

                <!-- NATIVE BROWSER CAST / PRESENTATION API & RECEIVER PREVIEW -->
                <div class="grid grid-cols-2 gap-2 pt-1">
                    <button onclick="window.MuseCast.triggerNativeBrowserCast()" class="h-10 px-3 rounded-2xl liquid-control-btn flex items-center justify-center gap-2 text-[11px] font-extrabold text-white/90">
                        <i class="fa-brands fa-chromecast text-xs" style="color: var(--theme-color-bright)"></i>
                        <span>Native TV Cast</span>
                    </button>
                    <button onclick="window.MuseCast.openTvReceiverWindow()" class="h-10 px-3 rounded-2xl liquid-control-btn flex items-center justify-center gap-2 text-[11px] font-extrabold text-white/90">
                        <i class="fa-solid fa-up-right-from-square text-xs text-emerald-300"></i>
                        <span>Open TV Screen</span>
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        updateCastModalUI();
    }

    function updateCastModalUI() {
        const shortUrlEl = document.getElementById("cast-short-tv-url");
        if (shortUrlEl) {
            shortUrlEl.innerText = getTvReceiverUrl(false);
        }
        const pinEl = document.getElementById("cast-phone-room-pin");
        if (pinEl) {
            pinEl.innerText = roomPinCode;
        }
        const qrImg = document.getElementById("cast-qr-img");
        if (qrImg) {
            const tvUrl = getTvReceiverUrl(true);
            qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=4&data=${encodeURIComponent(tvUrl)}`;
        }

        const activeBox = document.getElementById("cast-active-control-box");
        const connectedTitle = document.getElementById("cast-connected-title");
        if (activeBox) {
            activeBox.classList.toggle("hidden", !isCastingActive);
        }
        if (connectedTitle) {
            connectedTitle.innerText = `Connected to ${connectedDeviceName}`;
        }

        const volPct = Math.round(currentTvVolume * 100);
        const volLabel = document.getElementById("cast-modal-vol-pct");
        const volSlider = document.getElementById("cast-modal-vol-slider");
        if (volLabel) volLabel.innerText = `${volPct}%`;
        if (volSlider) {
            volSlider.value = volPct;
            volSlider.style.setProperty("--progress", `${((volPct / 150) * 100).toFixed(1)}%`);
        }
    }

    async function ensureHostPeerInitialized() {
        await loadPeerJsLibrary();
        if (hostPeer && !hostPeer.destroyed) return hostPeer;

        return new Promise((resolve) => {
            const peerId = `${PEER_PREFIX}${roomPinCode}`;
            hostPeer = new window.Peer(peerId, { debug: 0 });

            hostPeer.on("open", () => {
                const badge = document.getElementById("cast-peer-ready-badge");
                if (badge) badge.innerText = "Cloud Relay Online • Ready for TV";
                resolve(hostPeer);
            });

            hostPeer.on("connection", (conn) => {
                registerDataConnection(conn, conn.metadata?.deviceName || "Fire TV / Smart TV");
            });

            hostPeer.on("error", () => {
                resolve(hostPeer);
            });
        });
    }

    function registerDataConnection(conn, label = "Fire TV / Smart TV") {
        if (!conn) return;
        conn.on("open", () => {
            activeConnections.set(conn.peer || label, conn);
            activateCastMode(label);
            sendFullSyncToTv();
        });

        conn.on("data", (data) => {
            handleIncomingReceiverPacket(data, label);
        });

        conn.on("close", () => {
            activeConnections.delete(conn.peer || label);
            if (activeConnections.size === 0 && !presentationConn) {
                deactivateCastMode();
            }
        });

        conn.on("error", () => {
            activeConnections.delete(conn.peer || label);
        });
    }

    function handleIncomingReceiverPacket(packet, sourceLabel) {
        if (!packet || typeof packet !== "object") return;

        if (packet.type === "TV_HELLO") {
            activateCastMode(packet.deviceName || sourceLabel || "Fire TV / Smart TV");
            sendFullSyncToTv();
            return;
        }

        if (packet.type === "TV_TELEMETRY") {
            if (!isCastingActive) {
                activateCastMode(packet.deviceName || sourceLabel || "Fire TV / Smart TV");
            }
            if (window.MuseBridge && window.MuseBridge.onTvTelemetryUpdate) {
                window.MuseBridge.onTvTelemetryUpdate(packet);
            }
            return;
        }

        if (packet.type === "TV_COMMAND") {
            if (window.MuseBridge && window.MuseBridge.onTvCommand) {
                window.MuseBridge.onTvCommand(packet.command);
            }
            return;
        }

        if (packet.type === "TV_DISCONNECT") {
            disconnectAll();
        }
    }

    function broadcastPacketToTv(payload) {
        const msg = { ...payload, timestamp: Date.now() };
        activeConnections.forEach((conn) => {
            try {
                if (conn && conn.open) conn.send(msg);
            } catch (e) {}
        });

        if (presentationConn && presentationConn.state === "connected") {
            try {
                presentationConn.send(JSON.stringify(msg));
            } catch (e) {}
        }

        if (localBroadcast) {
            try {
                localBroadcast.postMessage(msg);
            } catch (e) {}
        }
    }

    function activateCastMode(deviceName = "Fire TV / Smart TV") {
        isCastingActive = true;
        connectedDeviceName = deviceName;
        if (window.MuseBridge && window.MuseBridge.onCastSessionChanged) {
            window.MuseBridge.onCastSessionChanged(true, connectedDeviceName);
        }
        updateCastModalUI();
        if (window.MuseBridge && window.MuseBridge.notifyToast) {
            window.MuseBridge.notifyToast(`Connected to ${connectedDeviceName}`);
        }
    }

    function deactivateCastMode() {
        if (!isCastingActive) return;
        isCastingActive = false;
        if (window.MuseBridge && window.MuseBridge.onCastSessionChanged) {
            window.MuseBridge.onCastSessionChanged(false, "");
        }
        updateCastModalUI();
        if (window.MuseBridge && window.MuseBridge.notifyToast) {
            window.MuseBridge.notifyToast("Disconnected from TV");
        }
    }

    function sendFullSyncToTv() {
        if (!isCastingActive || !window.MuseBridge) return;
        const snapshot = window.MuseBridge.getFullStateSnapshot();
        broadcastPacketToTv({
            type: "PHONE_FULL_SYNC",
            state: snapshot
        });
    }

    async function connectToTvPin() {
        const input = document.getElementById("cast-target-tv-pin-input");
        const btn = document.getElementById("cast-connect-pin-btn");
        const code = String(input?.value || "").replace(/\D/g, "").trim();

        if (code.length !== 4) {
            window.MuseBridge?.notifyToast("Enter the 4-digit code shown on your TV", "error");
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.innerText = "Connecting...";
        }

        try {
            await ensureHostPeerInitialized();
            const targetPeerId = `${PEER_PREFIX}tv-${code}`;
            const conn = hostPeer.connect(targetPeerId, {
                reliable: true,
                metadata: { role: "controller" }
            });

            let connected = false;
            const timeout = setTimeout(() => {
                if (!connected) {
                    if (btn) {
                        btn.disabled = false;
                        btn.innerText = "Connect TV";
                    }
                    window.MuseBridge?.notifyToast("Could not find TV with that code. Check tv.html on TV.", "error");
                }
            }, 6500);

            conn.on("open", () => {
                connected = true;
                clearTimeout(timeout);
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = "Connect TV";
                }
                registerDataConnection(conn, `TV (${code})`);
                conn.send({
                    type: "PHONE_FULL_SYNC",
                    state: window.MuseBridge?.getFullStateSnapshot()
                });
            });
        } catch (err) {
            if (btn) {
                btn.disabled = false;
                btn.innerText = "Connect TV";
            }
            window.MuseBridge?.notifyToast("Connection error", "error");
        }
    }

    async function triggerNativeBrowserCast() {
        // 1. Try W3C Presentation API (Launches tv.html directly on Android TV / Chromecast / Fire TV)
        if ("PresentationRequest" in window) {
            try {
                const req = new PresentationRequest([getTvReceiverUrl(true)]);
                const conn = await req.start();
                presentationConn = conn;
                conn.addEventListener("message", (ev) => {
                    try {
                        handleIncomingReceiverPacket(JSON.parse(ev.data), "Presentation TV");
                    } catch (e) {}
                });
                conn.addEventListener("close", () => {
                    presentationConn = null;
                    if (activeConnections.size === 0) deactivateCastMode();
                });
                activateCastMode("Smart TV Display");
                sendFullSyncToTv();
                return;
            } catch (e) {}
        }

        // 2. Fallback to RemotePlayback API (AirPlay / Cast Audio)
        const audioEl = window.MuseBridge?.getAudioElement();
        if (audioEl && audioEl.remote && typeof audioEl.remote.prompt === "function") {
            try {
                await audioEl.remote.prompt();
                return;
            } catch (e) {}
        }

        window.MuseBridge?.notifyToast("Use the 4-Digit TV Code or QR above for Fire TV & Android TV");
    }

    function openTvReceiverWindow() {
        const url = getTvReceiverUrl(true);
        window.open(url, "_blank");
    }

    function regenerateRoomPin() {
        roomPinCode = String(Math.floor(1000 + Math.random() * 9000));
        try { localStorage.setItem("muse_cast_pin_code", roomPinCode); } catch (e) {}
        if (hostPeer) {
            try { hostPeer.destroy(); } catch (e) {}
            hostPeer = null;
        }
        updateCastModalUI();
        ensureHostPeerInitialized();
    }

    function openCastModal() {
        injectCastModalUI();
        updateCastModalUI();
        const modal = document.getElementById("muse-cast-modal");
        modal.classList.remove("hidden");
        modal.classList.add("flex");
        ensureHostPeerInitialized();
    }

    function closeCastModal() {
        const modal = document.getElementById("muse-cast-modal");
        if (modal) {
            modal.classList.add("hidden");
            modal.classList.remove("flex");
        }
    }

    window.MuseCast = {
        openModal: openCastModal,
        closeModal: closeCastModal,
        connectToTvPin,
        regenerateRoomPin,
        triggerNativeBrowserCast,
        openTvReceiverWindow,
        isCasting: () => isCastingActive,
        syncNow: () => sendFullSyncToTv(),
        loadAndPlayTrackOnTv: () => {
            sendFullSyncToTv();
        },
        setPlayPause: (shouldPlay) => {
            broadcastPacketToTv({
                type: "PHONE_TRANSPORT",
                action: shouldPlay ? "PLAY" : "PAUSE"
            });
        },
        seekTo: (seconds) => {
            broadcastPacketToTv({
                type: "PHONE_TRANSPORT",
                action: "SEEK",
                seekTime: Number(seconds) || 0
            });
        },
        setVolume: (volFloat) => {
            currentTvVolume = Math.max(0, Math.min(1.5, Number(volFloat) || 0));
            updateCastModalUI();
            if (window.handleSpeakerVolumeInput) {
                window.handleSpeakerVolumeInput(Math.round(currentTvVolume * 100), true);
            }
            broadcastPacketToTv({
                type: "PHONE_VOLUME",
                volume: currentTvVolume
            });
        },
        stepVolume: (delta) => {
            const nextV = Math.max(0, Math.min(1.5, currentTvVolume + delta));
            window.MuseCast.setVolume(nextV);
        },
        disconnectAll: () => {
            broadcastPacketToTv({ type: "PHONE_DISCONNECT" });
            activeConnections.forEach((c) => {
                try { c.close(); } catch (e) {}
            });
            activeConnections.clear();
            if (presentationConn) {
                try { presentationConn.close(); } catch (e) {}
                presentationConn = null;
            }
            deactivateCastMode();
        }
    };

    window.addEventListener("load", () => {
        injectCastModalUI();
    });
})();

