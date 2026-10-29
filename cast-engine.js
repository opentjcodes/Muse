     


// ============================================================================
// FILE: cast-engine.js
// MUSE ZERO-INSTALL TV CAST & REMOTE VOLUME ENGINE
// Supports Android TV, Fire TV (DIAL / Presentation API / RemotePlayback),
// Google Cast CAF, and AirPlay — Zero TV App Installation Required.
// ============================================================================

(function () {
    "use strict";

    const CAST_NAMESPACE = "urn:x-cast:com.muse.cast";
    const RECEIVER_URL = new URL("./tv-receiver.html", window.location.href).href;

    let isCastingActive = false;
    let activeCastMode = null; // 'presentation' | 'chromecast' | 'remoteplayback' | 'airplay'
    let activeDeviceName = "Living Room TV";

    let presentationRequest = null;
    let presentationConnection = null;
    let googleCastSession = null;
    let broadcastSyncChannel = null;

    let tvVolume = 0.85; // 0.0 to 1.0
    let tvMuted = false;
    let remoteCurrentTime = 0;
    let remoteDuration = 0;
    let remoteIsPlaying = false;
    let syncIntervalId = null;

    // ========================================================================
    // 1. INJECT UI INTO 3-DOTS MENU & DYNAMIC TV VOLUME BAR (HIDDEN UNLESS CASTING)
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
                <span id="menu-cast-tv-status" class="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-white/70">Ready</span>
            `;
            castBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (window.MusePlayerBridge) window.MusePlayerBridge.closeMoreMenu();
                handleCastMenuAction();
            });
            moreMenu.appendChild(castBtn);
        }

        // Remove any legacy .m4a export buttons if present in DOM
        document.querySelectorAll('[onclick*="handleMenuDirectFileDownloadTap"], [onclick*="handleActionSheetExportFile"]').forEach((el) => {
            el.remove();
        });

        // Inject Dynamic TV Volume Control Bar inside Fullscreen Player (Shown ONLY when casting to TV)
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

            // Bind TV Volume Controls
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
                setTVVolume(Math.max(0, tvVolume - 0.08));
            });
            volUpBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                setTVVolume(Math.min(1, tvVolume + 0.08));
            });
            disconnectBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                stopCastingToTV();
            });
        }
    }

    // ========================================================================
    // 2. INITIALIZE PROTOCOLS (W3C PRESENTATION API + GOOGLE CAST + REMOTE PLAYBACK)
    // ========================================================================
    function initCastProtocols() {
        injectCastUI();

        // A. W3C Presentation API (Zero-Install for Fire TV, Android TV & Smart TVs)
        if ("PresentationRequest" in window) {
            try {
                presentationRequest = new PresentationRequest([RECEIVER_URL]);
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

        // B. Local BroadcastChannel (For same-network / multi-screen receiver sync)
        if ("BroadcastChannel" in window) {
            broadcastSyncChannel = new BroadcastChannel("muse_tv_cast_channel_v1");
            broadcastSyncChannel.onmessage = (ev) => handleIncomingTVMessage(ev.data);
        }

        // C. Load Google Cast Sender SDK dynamically for Chromecast & Android TV
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
                                const friendlyName = googleCastSession?.getCastDevice()?.friendlyName || "Android TV / Cast";
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

        // D. Hardware Volume Key & Local Audio Volume Bridge when Casting
        window.addEventListener("keydown", (e) => {
            if (!isCastingActive) return;
            if (e.code === "AudioVolumeUp" || e.key === "VolumeUp" || e.code === "ArrowUp") {
                e.preventDefault();
                setTVVolume(Math.min(1, tvVolume + 0.06));
            } else if (e.code === "AudioVolumeDown" || e.key === "VolumeDown" || e.code === "ArrowDown") {
                e.preventDefault();
                setTVVolume(Math.max(0, tvVolume - 0.06));
            }
        });

        const audioEl = window.MusePlayerBridge?.getAudioElement();
        if (audioEl) {
            audioEl.addEventListener("volumechange", () => {
                if (!isCastingActive) return;
                // Mirror phone speaker volume slider changes directly to the TV
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
            badge.innerText = "TV Found";
            badge.className = "text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-400/20 text-sky-300";
        } else {
            badge.innerText = "Ready";
            badge.className = "text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-white/70";
        }
    }

    // ========================================================================
    // 3. START / STOP CASTING TO TV (ZERO-INSTALL MULTI-PROTOCOL CASCADE)
    // ========================================================================
    async function handleCastMenuAction() {
        if (isCastingActive) {
            stopCastingToTV();
            return;
        }

        const audioEl = window.MusePlayerBridge?.getAudioElement();

        // 1. Try W3C Presentation API first (Launches tv-receiver.html directly on Fire TV / Android TV / Smart TV with word-by-word lyrics & 3-button HUD)
        if (presentationRequest) {
            try {
                const connection = await presentationRequest.start();
                attachPresentationConnection(connection);
                return;
            } catch (err) {
                // If user cancelled the native picker, stop; otherwise fall through to Cast/RemotePlayback
                if (err && (err.name === "NotAllowedError" || err.name === "AbortError")) {
                    return;
                }
            }
        }

        // 2. Try Google Cast CAF Picker (Android TV / Chromecast)
        if (window.cast && window.cast.framework) {
            try {
                const context = cast.framework.CastContext.getInstance();
                await context.requestSession();
                return;
            } catch (err) {
                if (err === "cancel") return;
            }
        }

        // 3. Try Apple AirPlay Native Picker (Safari / iOS / Smart TVs with AirPlay 2)
        if (audioEl && typeof audioEl.webkitShowPlaybackTargetPicker === "function") {
            try {
                audioEl.webkitShowPlaybackTargetPicker();
                activateCastingState("airplay", "AirPlay TV");
                return;
            } catch (e) {}
        }

        // 4. Try W3C RemotePlayback API (Fire TV / DLNA / UPnP TVs on same Wi-Fi)
        if (audioEl && audioEl.remote && typeof audioEl.remote.prompt === "function") {
            try {
                await audioEl.remote.prompt();
                activateCastingState("remoteplayback", "Smart TV (Remote Playback)");
                return;
            } catch (e) {}
        }

        if (window.MusePlayerBridge) {
            window.MusePlayerBridge.toast("Ensure your TV (Android TV / Fire TV) is on the same Wi-Fi network", "error");
        }
    }

    function attachPresentationConnection(connection) {
        presentationConnection = connection;

        const onConnected = () => {
            activateCastingState("presentation", "Smart TV Receiver");
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
        activeDeviceName = deviceName || "Smart TV";

        const audioEl = window.MusePlayerBridge?.getAudioElement();
        if (audioEl && mode !== "airplay" && mode !== "remoteplayback") {
            // Transfer audio streaming to the TV and silence phone local playback
            remoteCurrentTime = audioEl.currentTime || 0;
            remoteDuration = audioEl.duration || window.MusePlayerBridge?.getActiveTrack()?.duration || 0;
            audioEl.pause();
        }

        // Update 3-dots menu item & show Dynamic TV Volume HUD
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
            const streamUrl = window.MusePlayerBridge.getStreamUrlForTrack(track);
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

        // Seamlessly transfer playback position back from TV to the phone
        const audioEl = window.MusePlayerBridge?.getAudioElement();
        if (wasCasting && audioEl && remoteCurrentTime > 0) {
            try {
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

        deactivateCastingState();
    }

    // ========================================================================
    // 4. SYNC AUDIO STREAM, WORD-BY-WORD LYRICS & DYNAMIC VOLUME WITH TV
    // ========================================================================
    function sendMessageToTV(payload) {
        const serialized = JSON.stringify(payload);
        if (presentationConnection && presentationConnection.state === "connected") {
            try {
                presentationConnection.send(serialized);
            } catch (e) {}
        }
        if (broadcastSyncChannel) {
            try {
                broadcastSyncChannel.postMessage(payload);
            } catch (e) {}
        }
        if (googleCastSession && activeCastMode === "chromecast") {
            try {
                googleCastSession.sendMessage(CAST_NAMESPACE, payload);
            } catch (e) {}
        }
    }

    function loadTrackOnTV(track, streamUrl, lyricsPayload, startTimeSec = 0) {
        if (!isCastingActive || !track) return;
        remoteCurrentTime = startTimeSec || 0;
        remoteDuration = Number(track.duration) || 0;
        remoteIsPlaying = true;

        const themeRGB = window.MusePlayerBridge?.getThemeRGB() || { r: 98, g: 120, b: 235 };
        const timeline = window.MusePlayerBridge?.getLyricsTimeline() || [];

        if (activeCastMode === "chromecast" && googleCastSession) {
            try {
                const mediaInfo = new chrome.cast.media.MediaInfo(streamUrl, "audio/mp4");
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
                streamUrl
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
        const streamUrl = window.MusePlayerBridge.getStreamUrlForTrack(track);
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
        }, 700);
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

        if (activeCastMode === "chromecast" && googleCastSession) {
            try {
                googleCastSession.setVolume(tvVolume);
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
            // 3 minimal D-pad controls from TV (Prev, Play/Pause, Next)
            if (!window.MusePlayerBridge) return;
            if (msg.action === "NEXT") window.MusePlayerBridge.playNext();
            else if (msg.action === "PREV") window.MusePlayerBridge.playPrev();
            else if (msg.action === "TOGGLE_PLAY") window.MusePlayerBridge.togglePlayPause();
        } else if (msg.type === "TV_READY") {
            sendFullStateToTVReceiver();
        }
    }

    // ========================================================================
    // 5. EXPOSE GLOBAL CAST ENGINE API FOR INDEX.HTML
    // ========================================================================
    window.MuseCastEngine = {
        isCasting: () => isCastingActive,
        openCastPrompt: () => handleCastMenuAction(),
        loadTrackOnTV,
        play: () => {
            remoteIsPlaying = true;
            sendMessageToTV({ type: "PLAY" });
        },
        pause: () => {
            remoteIsPlaying = false;
            sendMessageToTV({ type: "PAUSE" });
        },
        seek: (timeSec) => {
            remoteCurrentTime = Math.max(0, Number(timeSec) || 0);
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

