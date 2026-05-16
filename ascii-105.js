//
// ascii.js
// v1.05
//
// Custom ASCII WebGL video renderer with eager preloading, shared pointer hub for glow,
// robust autoplay unlock, centralized media control, and viewport-aware no-op VFC handling.
//

// ---------------- Media Controller: single place to (re)play all <video> elements ----------------
class ASCIIMediaController {
  constructor() {
    this._videos = new Set();
  }
  register(videoEl) {
    if (videoEl) this._videos.add(videoEl);
  }
  unregister(videoEl) {
    if (videoEl) this._videos.delete(videoEl);
  }
  async playAllVideos() {
    // Best-effort: fire-and-forget play() on every registered video.
    // Any blocked play() will be retried again by callers (gesture or visibility regain).
    const ops = [];
    for (const v of this._videos) {
      try {
        ops.push(v.play());
      } catch {
        /* ignore per-element errors */
      }
    }
    try {
      await Promise.allSettled(ops);
    } catch {
      /* ignore aggregate errors */
    }
  }
}

// Ensure a single global controller
if (typeof window !== "undefined") {
  window.asciiMedia ||= new ASCIIMediaController();
}

// ---------------- Manager: shared pointer hub + viewport visibility orchestration ----------------
class ASCIIRendererManager {
  constructor() {
    // Active renderer instances
    this.renderers = [];

    // Pointer hub state (throttles pointer broadcasts via rAF)
    this._startedHub = false;
    this._rAFPendingPointer = false;
    this._lastPointer = { x: 0, y: 0, type: "mouse" };
    this._touchBroadcast = false;
    this._onMove = null;

    // Global visibility tracking (IO + manual fallback)
    this._io = null;
    this._observed = new Map(); // containerEl -> { renderer, isVisible }
    this._rootMarginPx = { top: 200, right: 0, bottom: 200, left: 0 };
    this._threshold = 0.01;

    // Manual visibility pass scheduling
    this._visCheckScheduled = false;
    this._boundManualCheck = () => this._scheduleManualVisibilityCheck();

    // IO lifecycle flag
    this._ioStarted = false;
  }

  // Register a renderer and begin pointer/visibility tracking
  addRenderer(renderer) {
    this.renderers.push(renderer);
    if (!this._startedHub) this._startGlobalPointerHub();
    this.observeRenderer(renderer);
  }

  // Unregister a renderer and clean up when the last one is removed
  removeRenderer(renderer) {
    this.renderers = this.renderers.filter((r) => r !== renderer);

    // Stop observing its container if present
    const entry = [...this._observed.entries()].find(([, v]) => v.renderer === renderer);
    if (entry) {
      const [el] = entry;
      this._unobserveElement(el);
    }

    // Tear down hubs when no renderers remain
    if (this.renderers.length === 0) {
      if (this._startedHub) {
        window.removeEventListener("pointermove", this._onMove, { passive: true });
        this._startedHub = false;
        this._rAFPendingPointer = false;
        this._onMove = null;
      }
      this._teardownGlobalIO();
    }
  }

  // Start tracking a renderer's container in the global visibility system
  observeRenderer(renderer) {
    const el = renderer.container;
    if (!el) return;

    this._observed.set(el, { renderer, isVisible: false });

    if (!this._ioStarted) this._startGlobalIO();
    if (this._io) this._io.observe(el);

    // Seed initial visibility state before IO fires
    this._scheduleManualVisibilityCheck();
  }

  // ---- Pointer hub (single global listener → broadcast to all renderers) ----
  _startGlobalPointerHub() {
    this._startedHub = true;
    this._onMove = (e) => {
      this._lastPointer.x = e.clientX;
      this._lastPointer.y = e.clientY;
      this._lastPointer.type = e.pointerType || "mouse";
      if (!this._rAFPendingPointer) {
        this._rAFPendingPointer = true;
        requestAnimationFrame(() => {
          this._rAFPendingPointer = false;
          this._broadcastPointer();
        });
      }
    };
    window.addEventListener("pointermove", this._onMove, { passive: true });
  }

  // Send the latest pointer position to all renderers (touch/pen only while drawing)
  _broadcastPointer() {
    const t = this._lastPointer.type;
    const canSend = t === "mouse" || (t !== "mouse" && this._touchBroadcast);
    if (!canSend) return;
    for (const r of this.renderers) r.receiveGlobalPointer(this._lastPointer);
  }

  // Enable/disable touch pointer broadcasts during long-press drawing
  startTouchBroadcast() {
    this._touchBroadcast = true;
  }
  stopTouchBroadcast() {
    this._touchBroadcast = false;
  }

  // ---- Global visibility tracking (IO primary, manual checks as fallback/assist) ----
  _startGlobalIO() {
    this._ioStarted = true;

    // Primary: IntersectionObserver for visibility state
    try {
      this._io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const el = entry.target;
            const rec = this._observed.get(el);
            if (!rec) continue;
            const isVisible = !!entry.isIntersecting;

            if (isVisible !== rec.isVisible) {
              rec.isVisible = isVisible;
              this._applyVisibilityChange(rec.renderer, el, isVisible);
            }
          }
        },
        {
          root: null,
          threshold: this._threshold,
          rootMargin: `${this._rootMarginPx.top}px ${this._rootMarginPx.right}px ${this._rootMarginPx.bottom}px ${this._rootMarginPx.left}px`,
        }
      );
    } catch {
      // If IO is unavailable, rely entirely on manual checks
      this._io = null;
    }

    // Manual pass helps on mobile during active touch and ensures snappy updates
    window.addEventListener("scroll", this._boundManualCheck, { passive: true });
    window.addEventListener("resize", this._boundManualCheck, { passive: true });
    window.addEventListener("touchmove", this._boundManualCheck, { passive: true });
  }

  // Stop global visibility tracking and clean all observers
  _teardownGlobalIO() {
    if (this._io) {
      for (const el of this._observed.keys()) this._io.unobserve(el);
      this._io.disconnect();
      this._io = null;
    }
    this._observed.clear();
    this._ioStarted = false;

    window.removeEventListener("scroll", this._boundManualCheck, { passive: true });
    window.removeEventListener("resize", this._boundManualCheck, { passive: true });
    window.removeEventListener("touchmove", this._boundManualCheck, { passive: true });
  }

  // Stop tracking a single element and reflect inactive state immediately
  _unobserveElement(el) {
    const rec = this._observed.get(el);
    if (!rec) return;
    if (rec.isVisible) this._applyVisibilityChange(rec.renderer, el, false);

    if (this._io) this._io.unobserve(el);
    this._observed.delete(el);
  }

  // Apply visibility state to renderer and container element
  _applyVisibilityChange(renderer, el, isVisible) {
    el.classList.toggle("active", isVisible);
    renderer.isInViewport = isVisible;
    if (isVisible) renderer.onEnterViewport();
    else renderer.onLeaveViewport();
  }

  // Schedule a single rAF-batched manual visibility pass
  _scheduleManualVisibilityCheck() {
    if (this._visCheckScheduled) return;
    this._visCheckScheduled = true;
    requestAnimationFrame(() => {
      this._visCheckScheduled = false;
      this._manualVisibilityPass();
    });
  }

  // Compute approximate intersection ratio using bounding boxes
  _manualVisibilityPass() {
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const root = {
      left: 0 - this._rootMarginPx.left,
      top: 0 - this._rootMarginPx.top,
      right: vw + this._rootMarginPx.right,
      bottom: vh + this._rootMarginPx.bottom,
    };

    for (const [el, rec] of this._observed.entries()) {
      const r = el.getBoundingClientRect();
      const interLeft = Math.max(r.left, root.left);
      const interTop = Math.max(r.top, root.top);
      const interRight = Math.min(r.right, root.right);
      const interBottom = Math.min(r.bottom, root.bottom);
      const interW = Math.max(0, interRight - interLeft);
      const interH = Math.max(0, interBottom - interTop);
      const interArea = interW * interH;
      const elArea = Math.max(1, r.width * r.height);
      const ratio = interArea / elArea;

      const isVisible = ratio >= this._threshold;
      if (isVisible !== rec.isVisible) {
        rec.isVisible = isVisible;
        this._applyVisibilityChange(rec.renderer, el, isVisible);
      }
    }
  }

  // Visibility/Tab Regain: nudge playback + refresh visibility and resume visible loops
  addVisibilityRAFHook() {
    const kick = () => {
      if (document.visibilityState !== "visible") return;

      // Two rAFs allow Safari/iOS to finish a paint/unfreeze cycle before we touch video/GL.
      requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
          // Centralized: reattempt autoplay for all videos
          try {
            await window.asciiMedia?.playAllVideos();
          } catch {}

          // Recompute visibility using existing path
          this._scheduleManualVisibilityCheck();

          // Nudge visible renderers
          for (const { renderer, isVisible } of this._observed.values()) {
            if (isVisible) {
              renderer.retryAutoplayIfNeeded();
              renderer.resume(); // loop is continuous, but resume is safe if paused
            }
          }
        });
      });
    };

    // Fire on tab/app returning to foreground (incl. BFCache restores)
    document.addEventListener("visibilitychange", kick, { passive: true });
    window.addEventListener("pageshow", kick, { passive: true });

    this._onVisibilityKick = kick;
  }
}

// ---------------- Core ASCII video renderer ----------------
class ASCIIVideoRenderer {
  static getDefaults() {
    return {
      // Grid and layout
      cellSizePx: 12,
      cellAspectRatio: 0.6, // cell width / cell height
      maxCanvasBackingDimPx: 5120,
      maxCols: 256,
      cellSizeMinPx: 6,
      cellSizeMaxPx: 30,
      responsive: [
        { maxWidth: 480, cellSizeScale: 0.7 },
        { maxWidth: 768, cellSizeScale: 0.8 },
        { maxWidth: 1024, cellSizeScale: 0.9 },
        { maxWidth: 1440, cellSizeScale: 1.0 },
        { maxWidth: 1920, cellSizeScale: 1.05 },
        { maxWidth: 2560, cellSizeScale: 1.1 },
        { maxWidth: 3840, cellSizeScale: 1.2 },
        { maxWidth: Infinity, cellSizeScale: 1.3 },
      ],

      // Content fitting and focal point
      fitMode: "cover",
      position: "50% 50%",
      positionX: null,
      positionY: null,

      // Glyph atlas and density
      charAspectRatio: 0.85,
      charFillRatio: 1,
      density: String.raw`$@B%8&WM#*oahkbdpqwmZO0QLCJUYZXcvunxrj/ft\|()1{}[]?_-+~<>i!lI;:",^'. `,
      atlasGlyphSize: 50,
      fontFamily: "'GeistMono-Light', monospace, system-ui, sans-serif",
      atlasPaddingPxPerCell: 120,
      atlasPaddingPx: 2,

      // Appearance and compositing
      tileOpacity: 0.5,
      glyphOpacity: 1.0,
      gamma: 1.6,
      edgeLo: 0.0,
      edgeHi: 1.0,
      blendMode: 1, // 0=screen, 1=add, 2=color-dodge, 3=normal
      blendStrength: 1,
      preserveHue: 1,

      // Pointer glow effect
      glowEnabled: true,
      glowRadiusMultiplier: 8,
      glowDurationSec: 1,
      glowIntensity: 2.5,
      glowOpacity: 1,
      glowBlendMode: 0,
      glowUseTileColor: 1,
      glowSaturationBoost: 1,
      glowInnerFrac: 1,
      glowFalloffExp: 0.1,
      glowMaxPoints: 64, // shader consumes up to 8; JS clamps to 8
      glowStampIntervalMs: 25,
      glowAffectsGlyph: 1,
      glowLumaGain: 0.6,
      glowLumaExp: 1.5,
      glowShrinkStrength: 0.2,

      // Touch drawing behavior
      longPressMs: 320,
      moveTolerancePx: 8,
      drawIntervalMs: 40,

      // Media, rendering, and device caps
      videoSrc: null,
      fallbackStillSrc: null,
      preloadPolicy: "auto",
      dprCap: 2,
    };
  }

  /**
   * @param {string} containerId - Wrapper element id
   * @param {string} canvasId    - <canvas> element id
   * @param {string} videoId     - <video> element id
   * @param {object} config      - Renderer configuration overrides
   */
  constructor(containerId, canvasId, videoId, config = {}) {
    const defaults = ASCIIVideoRenderer.getDefaults();
    this.config = { ...defaults, ...config };

    this.container = document.getElementById(containerId);
    this.canvas = document.getElementById(canvasId);
    this.video = document.getElementById(videoId);
    this.instanceId = canvasId;

    // Grid and performance metrics
    this.cols = 50;
    this.rows = 25;
    this.actualCellSize = this.config.cellSizePx;
    this.frameCount = 0;
    this.totalFrameCount = 0;
    this.lastTime = performance.now();
    this.fps = 0;
    this.videoFPS = 0;
    this.lastVideoTime = 0;
    this.videoFrameCount = 0;

    // Playback/visibility state
    this.isInViewport = false;
    this.isPaused = false;
    this.autoplayBlocked = false;
    this.srcAttached = false;
    this.hasRenderedFallback = false;
    this.contextLost = false;
    this._resourcesReady = false;

    // WebGL resources and video dimensions
    this.gl = null;
    this.prog = null;
    this.locs = null;
    this.atlas = null;
    this.videoTex = null;
    this._videoW = 0;
    this._videoH = 0;
    this._lastPresentedFrames = -1;

    // Glow data buffers
    this.glowPoints = [];
    this.lastGlowStamp = 0;
    this._glowCenters = new Float32Array(this.config.glowMaxPoints * 2);
    this._glowRadii = new Float32Array(this.config.glowMaxPoints);
    this._glowStarts = new Float32Array(this.config.glowMaxPoints);

    // Layout bookkeeping
    this._naturalCssW = 0;
    this._naturalCssH = 0;
    this._inROCallback = false;
    this._lastAppliedCssW = 0;
    this._lastAppliedCssH = 0;

    // Render loop control
    this._loopCancelled = false;
    this._loopKind = null;
    this._rafId = null;
    this._loopToken = 0;

    if (!this.container || !this.canvas || !this.video) {
      console.error(`Missing elements for ${this.instanceId}`);
      return;
    }

    // Ensure canvas overlays its container
    this.container.style.position ||= "relative";
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      display: "block",
    });

    // Register with singletons
    if (window.ASCIIRendererManagerSingleton) {
      window.ASCIIRendererManagerSingleton.addRenderer(this);
    }
    window.asciiMedia?.register(this.video);

    this._initPipeline();
  }

  // ---- Visibility lifecycle (called by the manager) ----
  async onEnterViewport() {
    // Ensure media is attached and try to play but do not bind loop start to visibility.
    if (!this.srcAttached) {
      const src = this.config.videoSrc || this.video.getAttribute("data-src");
      if (src) {
        this.video.src = src;
        this.video.preload = this.config.preloadPolicy === "none" ? "none" : this.config.preloadPolicy;
        this.srcAttached = true;
      }
    }
    try {
      await this.ensureVideoMetadata();
    } catch {}
    this.video.play().catch(() => {
      this.autoplayBlocked = true;
    });
    // Loop is continuous; nothing to start/stop here.
  }

  onLeaveViewport() {
    // Keep the video running; the loop remains active but will no-op while off-viewport.
  }

  // Retry autoplay once user interaction occurs
  retryAutoplayIfNeeded() {
    if (this.autoplayBlocked) this.safePlay();
  }

  // ---- Pipeline bootstrap ----
  async _initPipeline() {
    try {
      await this._initGL();
      this._setupShaders();
      this._setupGeometry();
      this._setupTextures();
      this._updateGridDimensions();
      this._setupUniforms();
      this._setupResize();
      this._setupGlowInput();
      await this._buildAtlas();
      this._resourcesReady = true;

      this._onWinResize = () => this.forceRefresh();
      window.addEventListener("resize", this._onWinResize, { passive: true });

      // Start the continuous loop immediately; off-viewport frames will no-op
      this.resume();
    } catch (e) {
      console.error(`[${this.instanceId}] init error`, e);
    }
  }

  // ---- Utility: guard GL usage ----
  _withGL(fn) {
    const gl = this.gl;
    if (!gl || !this.prog || !this.locs || this.contextLost) return false;
    fn(gl);
    return true;
  }

  // Check if a draw can occur (resources ready, canvas sized, etc.)
  _canRender() {
    return (
      !this.isPaused &&
      !this.contextLost &&
      !!this.gl &&
      !!this.prog &&
      !!this.locs &&
      !!this.atlas &&
      !!this.atlas.tex &&
      this._resourcesReady &&
      this.canvas.width >= 2 &&
      this.canvas.height >= 2
    );
  }

  // ---- Content positioning and cover-crop ----
  _parsePositionXY() {
    if (typeof this.config.positionX === "number" && typeof this.config.positionY === "number") {
      const cx = Math.max(0, Math.min(1, this.config.positionX));
      const cy = Math.max(0, Math.min(1, this.config.positionY));
      return [cx, cy];
    }
    const pos = (this.config.position || "50% 50%").trim().toLowerCase();
    const wordToPct = (w, isX) => {
      if (w === "left") return isX ? 0 : 0.5;
      if (w === "right") return isX ? 1 : 0.5;
      if (w === "top") return isX ? 0.5 : 0;
      if (w === "bottom") return isX ? 0.5 : 1;
      if (w === "center" || w === "middle") return 0.5;
      return null;
    };
    const asPct = (token, isX) => {
      const word = wordToPct(token, isX);
      if (word !== null) return word;
      if (token.endsWith("%")) {
        const v = parseFloat(token);
        return isFinite(v) ? Math.max(0, Math.min(100, v)) / 100 : 0.5;
      }
      const v = parseFloat(token);
      return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
    };
    let x = 0.5,
      y = 0.5;
    const parts = pos.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      const p = parts[0];
      const wx = wordToPct(p, true);
      const wy = wordToPct(p, false);
      if (wx !== null && wy !== null) {
        x = wx;
        y = wy;
      } else {
        x = asPct(p, true);
        y = 0.5;
      }
    } else {
      const lastTwo = parts.slice(-2);
      x = asPct(lastTwo[0], true);
      y = asPct(lastTwo[1], false);
    }
    return [x, y];
  }

  _getContainerAspect() {
    const w = Math.max(1, (this._naturalCssW || this.container.clientWidth) | 0);
    const h = Math.max(1, (this._naturalCssH || this.container.clientHeight) | 0);
    return w / h;
  }

  _getSourceAspect() {
    const vw = this._videoW || this.video.videoWidth || 0;
    const vh = this._videoH || this.video.videoHeight || 0;
    if (vw <= 0 || vh <= 0) return null;
    return vw / vh;
  }

  // Compute UV crop window for "cover" behavior honoring focal position
  _computeCoverCropUV() {
    const srcAR = this._getSourceAspect();
    const tgtAR = this._getContainerAspect();
    const [px, py] = this._parsePositionXY();
    let uMin = 0,
      uMax = 1,
      vMin = 0,
      vMax = 1;

    if (this.config.fitMode === "cover" && srcAR != null) {
      if (srcAR > tgtAR) {
        const visibleW = Math.max(0.0001, tgtAR / srcAR);
        const offset = (1 - visibleW) * px;
        uMin = offset;
        uMax = offset + visibleW;
      } else if (srcAR < tgtAR) {
        const visibleH = Math.max(0.0001, srcAR / tgtAR);
        const offset = (1 - visibleH) * py;
        vMin = offset;
        vMax = offset + visibleH;
      }
    }
    uMin = Math.max(0, Math.min(1, uMin));
    uMax = Math.max(0, Math.min(1, uMax));
    vMin = Math.max(0, Math.min(1, vMin));
    vMax = Math.max(0, Math.min(1, vMax));
    if (uMax - uMin < 1e-6) {
      uMin = 0;
      uMax = 1;
    }
    if (vMax - vMin < 1e-6) {
      vMin = 0;
      vMax = 1;
    }
    return { min: [uMin, vMin], max: [uMax, vMax] };
  }

  // ---- Media helpers ----
  ensureVideoMetadata() {
    return new Promise((resolve, reject) => {
      const video = this.video;
      if (!video) return reject(new Error("No video"));
      if (!video.src && this.config.videoSrc) video.src = this.config.videoSrc;
      if (video.readyState >= 1) {
        this._videoW = video.videoWidth || 0;
        this._videoH = video.videoHeight || 0;
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Video metadata timeout"));
      }, 6000);
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener("loadedmetadata", onMetadata);
        video.removeEventListener("error", onError);
      };
      const onMetadata = () => {
        cleanup();
        this._videoW = video.videoWidth || 0;
        this._videoH = video.videoHeight || 0;
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Video loading error"));
      };
      video.addEventListener("loadedmetadata", onMetadata);
      video.addEventListener("error", onError);
      if (video.readyState === 0 && video.src) video.load();
    });
  }

  // Attempt autoplay; on failure, present the fallback still and keep the loop alive
  async safePlay() {
    if (!this.video) return;
    if (!this.video.currentSrc && this.config.videoSrc) this.video.src = this.config.videoSrc;
    try {
      await this.video.play();
      this.autoplayBlocked = false;
      if (this.hasRenderedFallback) {
        this._clearFallbackTexture();
        this.hasRenderedFallback = false;
      }
    } catch {
      this.autoplayBlocked = true;
      if (!this.hasRenderedFallback) await this._renderFallbackStill();
    }
  }

  // Load an image for the fallback still
  static _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // Upload still image into the video texture and refresh crop uniforms
  async _renderFallbackStill() {
    const url = this.config.fallbackStillSrc;
    if (!url || !this.gl) return;
    try {
      const img = await ASCIIVideoRenderer._loadImage(url);
      this._withGL((gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      });
      this._videoW = img.naturalWidth || img.width || 0;
      this._videoH = img.naturalHeight || img.height || 0;
      this._updateCropUniforms();
      this.hasRenderedFallback = true;
    } catch (e) {
      console.warn(`[${this.instanceId}] fallback still failed`, e);
    }
  }

  // Reset the video texture to a 1×1 opaque pixel (clears fallback)
  _clearFallbackTexture() {
    if (!this.gl || !this.videoTex) return;
    this._withGL((gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      const tmp = new Uint8Array([0, 0, 0, 255]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
    });
  }

  // ---- WebGL init and context recovery ----
  async _initGL() {
    const dpr = Math.max(1, Math.min(this.config.dprCap, window.devicePixelRatio || 1));
    this.dpr = dpr;

    this.gl = this.canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
    if (!this.gl) throw new Error("WebGL not supported");

    this._onContextLost = (e) => {
      e.preventDefault();
      this.contextLost = true;
      this._resourcesReady = false;
      this.pause();
    };

    this._onContextRestored = async () => {
      this.contextLost = false;
      try {
        this.gl = this.canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
        this._setupShaders();
        this._setupGeometry();
        this._setupTextures();
        this._updateGridDimensions();
        this._setupUniforms();
        await this._buildAtlas();
        this._resourcesReady = true;

        if (this.hasRenderedFallback) {
          // still texture already present
        } else if (this.config.fallbackStillSrc) {
          await this._renderFallbackStill();
        }

        await this.safePlay();
        this.resume();
      } catch (e) {
        console.error(`[${this.instanceId}] Context restoration failed:`, e);
      }
    };

    this.canvas.addEventListener("webglcontextlost", this._onContextLost, false);
    this.canvas.addEventListener("webglcontextrestored", this._onContextRestored, false);
  }

  // Compile/link shaders and cache uniform locations
  _setupShaders() {
    const vsSrc = `
      attribute vec2 aPos;
      attribute vec2 aUV;
      varying vec2 vUV;
      void main() {
        vUV = aUV;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;

    const fsSrc = `
      precision mediump float;
      varying vec2 vUV;
      uniform sampler2D uVideo;
      uniform sampler2D uAtlas;
      uniform vec2  uCanvasSize;
      uniform float uCols;
      uniform float uRows;
      uniform vec2  uInvGrid;
      uniform vec2  uCellSizePx;
      uniform float uCharAspectRatio;
      uniform float uCharFillRatio;
      uniform float uGamma;
      uniform float uEdgeLo;
      uniform float uEdgeHi;
      uniform float uTileOpacity;
      uniform float uGlyphOpacity;
      uniform int   uBlendMode;
      uniform float uBlendStrength;
      uniform int   uPreserveHue;
      uniform float uGlyphCount;
      uniform vec2  uAtlasGrid;
      uniform vec2  uAtlasPadding;

      const int MAX_GLOW = 8;
      uniform int   uGlowCount;
      uniform vec2  uGlowCenters[MAX_GLOW];
      uniform float uGlowRadiiPx[MAX_GLOW];
      uniform float uGlowStart[MAX_GLOW];
      uniform float uNow;
      uniform float uGlowDuration;
      uniform float uGlowIntensity;
      uniform float uGlowOpacity;
      uniform int   uGlowBlendMode;
      uniform int   uGlowUseTileColor;
      uniform float uGlowSaturationBoost;
      uniform float uGlowInnerFrac;
      uniform float uGlowFalloffExp;
      uniform int   uGlowAffectsGlyph;
      uniform float uGlowLumaGain;
      uniform float uGlowLumaExp;
      uniform float uGlowShrinkStrength;

      uniform vec2  uCropMin;
      uniform vec2  uCropMax;

      float luminance(vec3 rgb){ return dot(rgb, vec3(0.299,0.587,0.114)); }
      float applyGamma(float x,float g){ return pow(clamp(x,0.0,1.0),g); }

      vec3 blendScreen(vec3 b, vec3 t){ return 1.0 - (1.0-b)*(1.0-t); }
      vec3 blendAdd(vec3 b, vec3 t){ return clamp(b+t,0.0,1.0); }
      vec3 blendColorDodge(vec3 b, vec3 t){ vec3 d = max(vec3(0.001), 1.0 - t); return clamp(b / d, 0.0, 1.0); }
      vec3 doBlend(vec3 b, vec3 t, int m){
        if(m==1) return blendAdd(b,t);
        if(m==2) return blendColorDodge(b,t);
        if(m==3) return t;
        return blendScreen(b,t);
      }

      vec3 retintToBase(vec3 c, vec3 base){
        float bl = max(0.0001, luminance(base));
        float cl = max(0.0001, luminance(c));
        return clamp(base * (cl/bl), 0.0, 1.0);
      }

      vec3 rgb2hsv(vec3 c){
        float cMax = max(c.r, max(c.g, c.b));
        float cMin = min(c.r, min(c.g, c.b));
        float d = cMax - cMin;
        float h = 0.0;
        if(d>1e-5){
          if(cMax==c.r) h = mod((c.g-c.b)/d, 6.0);
          else if(cMax==c.g) h = (c.b-c.r)/d + 2.0;
          else h = (c.r-c.g)/d + 4.0;
          h/=6.0; if(h<0.0) h+=1.0;
        }
        float s = (cMax<=0.0)?0.0:(d/cMax);
        float v = cMax;
        return vec3(h,s,v);
      }
      vec3 hsv2rgb(vec3 c){
        float h=c.x*6.0, s=c.y, v=c.z;
        float i=floor(h), f=h-i;
        float p=v*(1.0-s), q=v*(1.0-s*f), t=v*(1.0-s*(1.0-f));
        if(i==0.0) return vec3(v,t,p);
        if(i==1.0) return vec3(q,v,p);
        if(i==2.0) return vec3(p,v,t);
        if(i==3.0) return vec3(p,q,v);
        if(i==4.0) return vec3(t,p,v);
        return vec3(v,p,q);
      }

      float glowAmount(vec2 tileCenterUV) {
        float combined = 0.0;
        for(int i=0;i<MAX_GLOW;i++){
          if(i<uGlowCount){
            float age = uNow - uGlowStart[i];
            float timeF = clamp(1.0 - age / max(0.0001, uGlowDuration), 0.0, 1.0);

            vec2 dpPx = (tileCenterUV - uGlowCenters[i]) * uCanvasSize;
            float distPx = length(dpPx);
            float r = max(1.0, uGlowRadiiPx[i]);

            float sepPx = length((uGlowCenters[i] - uGlowCenters[0]) * uCanvasSize);
            float shrinkK = max(0.0, uGlowShrinkStrength);
            float shrinkFactor = (shrinkK > 0.0) ? max(0.15, exp(-shrinkK * sepPx / r)) : 1.0;

            float rScaled = r * shrinkFactor;
            float r0 = clamp(uGlowInnerFrac, 0.0, 0.99) * rScaled;

            float spatial;
            if(distPx <= r0) {
              spatial = 1.0;
            } else {
              float t = clamp((distPx - r0) / max(0.0001, (rScaled - r0)), 0.0, 1.0);
              spatial = 1.0 - t;
              spatial = pow(spatial, max(0.0001, uGlowFalloffExp));
            }
            combined = min(1.0, combined + spatial * timeF);
          }
        }
        return combined;
      }

      vec3 applyGlowColor(vec3 baseColor, float combined) {
        if(combined<=0.0) return baseColor;
        vec3 top = (uGlowUseTileColor==1) ? clamp(baseColor * uGlowIntensity, 0.0, 1.0) : vec3(clamp(uGlowIntensity * combined, 0.0, 1.0));
        vec3 glowed = doBlend(baseColor, top, uGlowBlendMode);
        vec3 mixed = mix(baseColor, glowed, clamp(uGlowOpacity * combined, 0.0, 1.0));
        if(uGlowSaturationBoost > 0.001){
          vec3 hsv = rgb2hsv(mixed);
          hsv.y = clamp(hsv.y * (1.0 + uGlowSaturationBoost * combined), 0.0, 1.0);
          mixed = hsv2rgb(hsv);
        }
        return mixed;
      }

      void main(){
        vec2 grid = vec2(uCols, uRows);
        vec2 cellCoord = floor(vUV * grid);
        vec2 cellUV = fract(vUV * grid);
        vec2 tileCenterUV = (cellCoord + 0.5) * uInvGrid;

        vec2 uvVideo = mix(uCropMin, uCropMax, tileCenterUV);
        vec3 videoRGB = texture2D(uVideo, uvVideo).rgb;

        float lum = applyGamma(dot(videoRGB, vec3(0.299,0.587,0.114)), uGamma);

        float gAmt = 0.0;
        if (uGlowCount > 0) { gAmt = glowAmount(tileCenterUV); }

        float lumAdj = lum;
        if (uGlowAffectsGlyph == 1 && gAmt > 0.0) {
          float shaped = pow(gAmt, max(0.0001, uGlowLumaExp));
          lumAdj = clamp(lum + shaped * uGlowLumaGain, 0.0, 1.0);
        }

        float glyphIdx = floor(lumAdj * (uGlyphCount - 1.0) + 0.5);

        float charH = uCellSizePx.y * uCharFillRatio;
        float charW = charH * uCharAspectRatio;
        vec2 charSizeInCell = vec2(charW / uCellSizePx.x, charH / uCellSizePx.y);
        vec2 charStart = (1.0 - charSizeInCell) * 0.5;
        vec2 charEnd = charStart + charSizeInCell;

        float charMask = 1.0;
        if(cellUV.x < charStart.x || cellUV.x > charEnd.x || cellUV.y < charStart.y || cellUV.y > charEnd.y){
          charMask = 0.0;
        }

        vec2 charUV = (cellUV - charStart) / charSizeInCell;
        charUV = clamp(charUV, 0.0, 1.0);

        float aCols = uAtlasGrid.x;
        float ax = mod(glyphIdx, aCols);
        float ay = floor(glyphIdx / aCols);

        vec2 paddedUV = uAtlasPadding + charUV * (1.0 - 2.0 * uAtlasPadding);
        vec2 atlasUV = (vec2(ax, ay) + paddedUV) / uAtlasGrid;

        float glyphAlpha = texture2D(uAtlas, atlasUV).r;
        glyphAlpha = smoothstep(uEdgeLo, uEdgeHi, glyphAlpha);
        glyphAlpha *= charMask * uGlyphOpacity;

        vec3 baseRGB = mix(vec3(0.0), videoRGB, clamp(uTileOpacity, 0.0, 1.0));
        vec3 glyphRGB = videoRGB;
        vec3 blended = doBlend(baseRGB, glyphRGB, uBlendMode);
        if(uBlendMode != 3) blended = mix(baseRGB, blended, clamp(uBlendStrength, 0.0, 1.0));
        if(uPreserveHue == 1) blended = retintToBase(blended, baseRGB);
        vec3 finalRGB = mix(baseRGB, blended, glyphAlpha);

        if(uGlowCount > 0 && gAmt > 0.0){ finalRGB = applyGlowColor(finalRGB, gAmt); }

        gl_FragColor = vec4(finalRGB, 1.0);
      }
    `;

    this.prog = this._createProgram(vsSrc, fsSrc);
    this.locs = this._getUniformLocations([
      "uVideo",
      "uAtlas",
      "uCanvasSize",
      "uCols",
      "uRows",
      "uInvGrid",
      "uCellSizePx",
      "uCharAspectRatio",
      "uCharFillRatio",
      "uGamma",
      "uEdgeLo",
      "uEdgeHi",
      "uTileOpacity",
      "uGlyphOpacity",
      "uBlendMode",
      "uBlendStrength",
      "uPreserveHue",
      "uGlyphCount",
      "uAtlasGrid",
      "uAtlasPadding",
      "uGlowCount",
      "uGlowCenters",
      "uGlowRadiiPx",
      "uGlowStart",
      "uNow",
      "uGlowDuration",
      "uGlowIntensity",
      "uGlowOpacity",
      "uGlowBlendMode",
      "uGlowUseTileColor",
      "uGlowSaturationBoost",
      "uGlowInnerFrac",
      "uGlowFalloffExp",
      "uGlowAffectsGlyph",
      "uGlowLumaGain",
      "uGlowLumaExp",
      "uCropMin",
      "uCropMax",
      "uGlowShrinkStrength",
    ]);
  }

  // Full-screen quad geometry with interleaved position/UV
  _setupGeometry() {
    this._withGL((gl) => {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          // pos   // uv
          -1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, -1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1, 1,
        ]),
        gl.STATIC_DRAW
      );
      const aPos = gl.getAttribLocation(this.prog, "aPos");
      const aUV = gl.getAttribLocation(this.prog, "aUV");
      gl.enableVertexAttribArray(aPos);
      gl.enableVertexAttribArray(aUV);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
    });
  }

  // Video texture bootstrap (1×1 black until a frame or still is uploaded)
  _setupTextures() {
    this._withGL((gl) => {
      this.videoTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      const black = new Uint8Array([0, 0, 0, 255]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, black);
    });
  }

  // Initialize uniforms that are static or change infrequently
  _setupUniforms() {
    this._withGL((gl) => {
      gl.useProgram(this.prog);
      gl.uniform1i(this.locs.uVideo, 0);
      gl.uniform1i(this.locs.uAtlas, 1);
      gl.uniform2f(this.locs.uCanvasSize, Math.max(2, this.canvas.width), Math.max(2, this.canvas.height));
      this._applyGridUniforms();

      gl.uniform1f(this.locs.uCharAspectRatio, this.config.charAspectRatio);
      gl.uniform1f(this.locs.uCharFillRatio, this.config.charFillRatio);
      gl.uniform1f(this.locs.uGamma, this.config.gamma);
      gl.uniform1f(this.locs.uEdgeLo, this.config.edgeLo);
      gl.uniform1f(this.locs.uEdgeHi, this.config.edgeHi);
      gl.uniform1f(this.locs.uTileOpacity, this.config.tileOpacity);
      gl.uniform1f(this.locs.uGlyphOpacity, this.config.glyphOpacity);
      gl.uniform1i(this.locs.uBlendMode, this.config.blendMode | 0);
      gl.uniform1f(this.locs.uBlendStrength, this.config.blendStrength);
      gl.uniform1i(this.locs.uPreserveHue, this.config.preserveHue ? 1 : 0);
      gl.uniform1f(this.locs.uGlyphCount, this.config.density.length);

      this._pushGlowStatics();
      this._updateCropUniforms();
    });
  }

  // Push glow parameters that rarely change
  _pushGlowStatics() {
    this._withGL((gl) => {
      gl.useProgram(this.prog);
      gl.uniform1f(this.locs.uGlowDuration, this.config.glowDurationSec);
      gl.uniform1f(this.locs.uGlowIntensity, this.config.glowIntensity);
      gl.uniform1f(this.locs.uGlowOpacity, this.config.glowOpacity);
      gl.uniform1i(this.locs.uGlowBlendMode, this.config.glowBlendMode | 0);
      gl.uniform1i(this.locs.uGlowUseTileColor, this.config.glowUseTileColor ? 1 : 0);
      gl.uniform1f(this.locs.uGlowSaturationBoost, this.config.glowSaturationBoost);
      gl.uniform1f(this.locs.uGlowInnerFrac, this.config.glowInnerFrac);
      gl.uniform1f(this.locs.uGlowFalloffExp, this.config.glowFalloffExp);
      gl.uniform1i(this.locs.uGlowAffectsGlyph, this.config.glowAffectsGlyph ? 1 : 0);
      gl.uniform1f(this.locs.uGlowLumaGain, this.config.glowLumaGain);
      gl.uniform1f(this.locs.uGlowLumaExp, this.config.glowLumaExp);
      gl.uniform1f(this.locs.uGlowShrinkStrength, this.config.glowShrinkStrength);
    });
  }

  // Build glyph atlas texture and inform the shader of grid/padding
  _buildAtlas() {
    this.atlas = this._createGlyphAtlas();
    this._withGL((gl) => {
      gl.useProgram(this.prog);
      gl.uniform2f(this.locs.uAtlasGrid, this.atlas.gridCols, this.atlas.gridRows);
      const pad = this.config.atlasPaddingPx / this.config.atlasPaddingPxPerCell;
      gl.uniform2f(this.locs.uAtlasPadding, pad, pad);
    });
  }

  // ---- Render loop (continuous VFC/RAF; no-op when off-viewport) ----
  _startRenderLoop() {
    this._loopToken = (this._loopToken || 0) + 1;
    const token = this._loopToken;
    this._loopCancelled = false;

    const useVFC = typeof this.video.requestVideoFrameCallback === "function";
    const step = (isNew) => {
      if (this._loopCancelled || token !== this._loopToken) return;
      // Off-viewport policy: consume the callback but do nothing.
      if (!this.isInViewport) return;
      this._drawFrame(isNew);
    };

    if (useVFC) {
      const loopVFC = () => {
        if (this._loopCancelled || token !== this._loopToken) return;
        this.video.requestVideoFrameCallback((now, metadata) => {
          const presented = metadata && typeof metadata.presentedFrames === "number" ? metadata.presentedFrames : -1;
          const isNew = presented !== this._lastPresentedFrames;
          this._lastPresentedFrames = presented;
          step(isNew);
          loopVFC();
        });
      };
      this._loopKind = "vfc";
      loopVFC();
    } else {
      const loopRAF = () => {
        if (this._loopCancelled || token !== this._loopToken) return;
        step(true);
        this._rafId = requestAnimationFrame(loopRAF);
      };
      this._loopKind = "raf";
      this._rafId = requestAnimationFrame(loopRAF);
    }
  }

  // Cancel whichever loop variant is running
  _stopRenderLoop() {
    this._loopCancelled = true;
    if (this._loopKind === "raf" && this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  // ---- Grid sizing and responsive scaling ----
  _resolveBreakpoint() {
    const sw = window.innerWidth || document.documentElement.clientWidth || 0;
    const bps = Array.isArray(this.config.responsive) ? this.config.responsive : [];
    let sel = bps.find((bp) => sw <= bp.maxWidth) || { cellSizeScale: 1 };
    return { cellSizeScale: Number(sel.cellSizeScale) || 1 };
  }

  _getResponsiveCellSize(basePx) {
    const { cellSizeScale } = this._resolveBreakpoint();
    const target = basePx * (Number(cellSizeScale) || 1);
    const minPx = this.config.cellSizeMinPx ?? 1;
    const maxPx = this.config.cellSizeMaxPx ?? Number.POSITIVE_INFINITY;
    return Math.max(minPx, Math.min(maxPx, target));
  }

  _calculateGridDimensions() {
    const canvasW = this.canvas.width || Math.max(2, Math.floor((this._naturalCssW || this.container.clientWidth) * this.dpr));
    const canvasH = this.canvas.height || Math.max(2, Math.floor((this._naturalCssH || this.container.clientHeight) * this.dpr));
    const targetCellCssPx = this._getResponsiveCellSize(this.config.cellSizePx);
    const targetCellDevPx = Math.max(1, targetCellCssPx * this.dpr);

    const minCols = 10;
    const maxCols = Number.isFinite(this.config.maxCols) ? Math.max(minCols, this.config.maxCols | 0) : Infinity;
    const colsBySize = Math.max(1, Math.floor(canvasW / targetCellDevPx));
    const cols = Math.max(minCols, Math.min(maxCols, colsBySize));

    const ar = Math.max(0.0001, this.config.cellAspectRatio);
    const cellW = canvasW / cols;
    const cellH = cellW / ar;

    const minRows = 5;
    const rows = Math.max(minRows, Math.floor(canvasH / cellH));
    return { cols, rows, actualCellSize: cellW };
  }

  _applyGridUniforms() {
    this._withGL((gl) => {
      gl.useProgram(this.prog);
      gl.uniform1f(this.locs.uCols, this.cols);
      gl.uniform1f(this.locs.uRows, this.rows);
      gl.uniform2f(this.locs.uInvGrid, 1 / this.cols, 1 / this.rows);
      const cellW = Math.max(1, this.canvas.width / this.cols);
      const cellH = Math.max(1, this.canvas.height / this.rows);
      gl.uniform2f(this.locs.uCellSizePx, cellW, cellH);
      gl.uniform2f(this.locs.uCanvasSize, this.canvas.width, this.canvas.height);
    });
  }

  _updateGridDimensions() {
    const { cols, rows, actualCellSize } = this._calculateGridDimensions();
    this.cols = cols;
    this.rows = rows;
    this.actualCellSize = actualCellSize;
    this._applyGridUniforms();
    this._updateCropUniforms();
  }

  _resizeCanvasBackingStoreFromCss(cssW, cssH, maxDimPx = this.config.maxCanvasBackingDimPx) {
    const dpr = this.dpr || 1;
    let desiredW = Math.max(2, Math.floor(cssW * dpr));
    let desiredH = Math.max(2, Math.floor(cssH * dpr));
    if (maxDimPx && (desiredW > maxDimPx || desiredH > maxDimPx)) {
      const s = maxDimPx / Math.max(desiredW, desiredH);
      desiredW = Math.max(2, Math.floor(desiredW * s));
      desiredH = Math.max(2, Math.floor(desiredH * s));
    }
    if (this.canvas.width === desiredW && this.canvas.height === desiredH) return false;

    this.canvas.width = desiredW;
    this.canvas.height = desiredH;
    this._withGL((gl) => {
      gl.viewport(0, 0, desiredW, desiredH);
      gl.useProgram(this.prog);
      gl.uniform2f(this.locs.uCanvasSize, desiredW, desiredH);
    });
    return true;
  }

  _setupResize() {
    const EPS = 0.5;
    const applySize = (cssW, cssH) => {
      cssW = Math.max(0, Math.round(cssW));
      cssH = Math.max(0, Math.round(cssH));
      if (Math.abs(cssW - this._lastAppliedCssW) < 1 && Math.abs(cssH - this._lastAppliedCssH) < 1) return;
      const changed = this._resizeCanvasBackingStoreFromCss(cssW, cssH);
      this._updateGridDimensions();
      this._lastAppliedCssW = cssW;
      this._lastAppliedCssH = cssH;
    };

    const ro = new ResizeObserver((entries) => {
      if (this._inROCallback) return;
      this._inROCallback = true;
      const entry = entries.find((e) => e.target === this.container) || entries[0];
      if (entry) {
        let cssW, cssH;
        if (entry.contentBoxSize) {
          const box = Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0] : entry.contentBoxSize;
          cssW = box.inlineSize;
          cssH = box.blockSize;
        } else {
          cssW = entry.contentRect.width;
          cssH = entry.contentRect.height;
        }
        if (Math.abs(cssW - this._naturalCssW) > EPS || Math.abs(cssH - this._naturalCssH) > EPS) {
          this._naturalCssW = cssW;
          this._naturalCssH = cssH;
          requestAnimationFrame(() => applySize(this._naturalCssW, this._naturalCssH));
        }
      }
      this._inROCallback = false;
    });
    ro.observe(this.container);
    this._ro = ro;

    const rect = this.container.getBoundingClientRect();
    this._naturalCssW = rect.width;
    this._naturalCssH = rect.height;
    requestAnimationFrame(() => applySize(this._naturalCssW, this._naturalCssH));
  }

  // ---- Playback control ----
  pause() {
    if (!this.isPaused) {
      this.isPaused = true;
      this._stopRenderLoop();
    }
  }

  resume() {
    if (this._resourcesReady) {
      this.isPaused = false;
      this._startRenderLoop();
    }
  }

  // ---- Per-frame rendering (no-op off-viewport) ----
  _drawFrame(shouldUpload = true) {
    if (!this._canRender()) return;

    // Lightweight metrics
    this.frameCount++;
    this.totalFrameCount++;
    const now = performance.now();
    if (now - this.lastTime >= 1000) {
      this.fps = ((this.frameCount * 1000) / (now - this.lastTime)).toFixed(1);
      this.frameCount = 0;
      this.lastTime = now;
    }
    if (this.video.currentTime !== this.lastVideoTime) {
      this.videoFrameCount++;
      this.lastVideoTime = this.video.currentTime;
      if (this.videoFrameCount >= 30) {
        this.videoFPS = ((this.videoFrameCount / (now - (this.lastTime || now))) * 1000).toFixed(1);
        this.videoFrameCount = 0;
      }
    }

    // Upload current frame only when visible
    if (this.isInViewport && shouldUpload) {
      const vW = this.video.videoWidth | 0;
      const vH = this.video.videoHeight | 0;
      if (vW > 0 && vH > 0) {
        this._withGL((gl) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
          } catch {
            /* transient upload issues can occur */
          }
        });
        if (vW !== this._videoW || vH !== this._videoH) {
          this._videoW = vW;
          this._videoH = vH;
          this._updateCropUniforms();
        }
      }
    } else {
      // Off-viewport: consume the callback but skip all GPU work
      return;
    }

    // Bind atlas, push glow dynamics, and draw full-screen quad
    this._withGL((gl) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas.tex);
      this._pushGlowDynamics();

      gl.useProgram(this.prog);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    });
  }

  // Push per-frame glow uniforms for active glow stamps
  _pushGlowDynamics() {
    if (!this.config.glowEnabled) {
      this._withGL((gl) => {
        gl.useProgram(this.prog);
        gl.uniform1i(this.locs.uGlowCount, 0);
      });
      return;
    }
    const nowSec = performance.now() / 1000;
    const dur = this.config.glowDurationSec;

    // Keep a small buffer past duration for smooth fade-out removal
    this.glowPoints = this.glowPoints.filter((p) => nowSec - p.tSec <= dur + 0.25);

    const count = Math.min(this.glowPoints.length, Math.min(this.config.glowMaxPoints, 8));
    for (let i = 0; i < count; i++) {
      const p = this.glowPoints[i];
      this._glowCenters[i * 2 + 0] = p.x;
      this._glowCenters[i * 2 + 1] = p.y;
      this._glowRadii[i] = p.rPx;
      this._glowStarts[i] = p.tSec;
    }

    this._withGL((gl) => {
      gl.useProgram(this.prog);
      gl.uniform1f(this.locs.uNow, nowSec);
      gl.uniform1i(this.locs.uGlowCount, count);
      if (count > 0) {
        gl.uniform2fv(this.locs.uGlowCenters, this._glowCenters.subarray(0, count * 2));
        gl.uniform1fv(this.locs.uGlowRadiiPx, this._glowRadii.subarray(0, count));
        gl.uniform1fv(this.locs.uGlowStart, this._glowStarts.subarray(0, count));
      }
    });
  }

  // ---- Shader/program helpers ----
  _createProgram(vs, fs) {
    const gl = this.gl;
    const v = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(v, vs);
    gl.compileShader(v);
    if (!gl.getShaderParameter(v, gl.COMPILE_STATUS)) {
      throw new Error("Vertex shader: " + gl.getShaderInfoLog(v));
    }

    const f = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(f, fs);
    gl.compileShader(f);
    if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) {
      throw new Error("Fragment shader: " + gl.getShaderInfoLog(f));
    }

    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Program link: " + gl.getProgramInfoLog(p));
    return p;
  }

  _getUniformLocations(names) {
    const locs = {};
    for (const n of names) locs[n] = this.gl.getUniformLocation(this.prog, n);
    return locs;
  }

  // Generate a glyph atlas texture from the configured density string
  _createGlyphAtlas() {
    const count = this.config.density.length;
    const gridCols = Math.ceil(Math.sqrt(count));
    const gridRows = Math.ceil(count / gridCols);
    const atlasW = gridCols * this.config.atlasGlyphSize;
    const atlasH = gridRows * this.config.atlasGlyphSize;

    const c = document.createElement("canvas");
    c.width = atlasW;
    c.height = atlasH;
    const ctx = c.getContext("2d", { alpha: false });
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, atlasW, atlasH);
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.floor(this.config.atlasGlyphSize * 0.8)}px ${this.config.fontFamily}`;

    for (let i = 0; i < count; i++) {
      const ch = this.config.density[i];
      const gx = i % gridCols;
      const gy = Math.floor(i / gridCols);
      const cx = gx * this.config.atlasGlyphSize + this.config.atlasGlyphSize * 0.5;
      const cy = gy * this.config.atlasGlyphSize + this.config.atlasGlyphSize * 0.5;
      ctx.fillText(ch, cx, cy);
    }

    const tex = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, c);
    return { tex, gridCols, gridRows };
  }

  // ---- Glow input (maps pointer to UV, supports long-press drawing on touch) ----
  mapClientToUV(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return [0, 0];
    const u = (clientX - rect.left) / rect.width;
    const v = 1.0 - (clientY - rect.top) / rect.height;
    return [u, v];
  }

  receiveGlobalPointer(pointer) {
    if (!this.config.glowEnabled || !this.isInViewport) return;
    const now = performance.now();
    if (now - this.lastGlowStamp < this.config.glowStampIntervalMs) return;
    this.lastGlowStamp = now;
    const [u, v] = this.mapClientToUV(pointer.x, pointer.y);
    this._addGlowPointUnclamped(u, v, now / 1000);
  }

  _setupGlowInput() {
    if (!this.config.glowEnabled) return;
    const c = this.canvas;
    c.style.touchAction = "pan-y pinch-zoom";

    let touchActive = false;
    let drawing = false;
    let pressTimer = null;
    let lastClientX = 0,
      lastClientY = 0;
    let drawIntervalId = null;

    const enableNoCallout = () => document.documentElement.classList.add("ascii-no-callout");
    const disableNoCallout = () => document.documentElement.classList.remove("ascii-no-callout");

    const endDrawing = () => {
      drawing = false;
      if (drawIntervalId !== null) {
        clearInterval(drawIntervalId);
        drawIntervalId = null;
      }
      window.removeEventListener("pointermove", routeWhileDrawing, { capture: false });
      window.ASCIIRendererManagerSingleton?.stopTouchBroadcast();
      disableNoCallout();
    };

    const clearPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      endDrawing();
    };

    const stampAt = (clientX, clientY) => {
      const t = performance.now() / 1000;
      const [u, v] = this.mapClientToUV(clientX, clientY);
      this._addGlowPointUnclamped(u, v, t);
    };

    const startPressTimer = () => {
      pressTimer = setTimeout(() => {
        drawing = true;
        if (drawIntervalId === null) {
          drawIntervalId = setInterval(() => {
            stampAt(lastClientX, lastClientY);
          }, this.config.drawIntervalMs);
        }
        window.addEventListener("pointermove", routeWhileDrawing, { passive: false });
        window.ASCIIRendererManagerSingleton?.startTouchBroadcast();
        enableNoCallout();
      }, this.config.longPressMs);
    };

    const routeWhileDrawing = (e) => {
      if (!drawing) return;
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      e.preventDefault();
      stampAt(e.clientX, e.clientY);
    };

    c.addEventListener(
      "pointerdown",
      (e) => {
        if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
        touchActive = true;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        startPressTimer();
      },
      { passive: true }
    );

    c.addEventListener(
      "pointermove",
      (e) => {
        if (!touchActive) return;
        if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
        const prevX = lastClientX,
          prevY = lastClientY;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        const movedFar = Math.abs(lastClientX - prevX) + Math.abs(lastClientY - prevY) > this.config.moveTolerancePx;
        if (drawing) {
          e.preventDefault();
          stampAt(e.clientX, e.clientY);
          return;
        }
        if (movedFar) clearPress(); // treat as scroll
      },
      { passive: false }
    );

    c.addEventListener(
      "pointerup",
      (e) => {
        if (!touchActive) return;
        if (!drawing && pressTimer) {
          clearPress();
          stampAt(e.clientX, e.clientY); // single tap stamp
        } else {
          clearPress();
        }
        touchActive = false;
      },
      { passive: true }
    );

    c.addEventListener(
      "pointercancel",
      () => {
        touchActive = false;
        clearPress();
      },
      { passive: true }
    );

    c.addEventListener(
      "contextmenu",
      (e) => {
        if (drawing) e.preventDefault();
      },
      { passive: false }
    );
  }

  _addGlowPointUnclamped(u, v, tSec, rPx) {
    const responsiveRadius = typeof rPx === "number" && rPx > 0 ? rPx : this.actualCellSize * this.config.glowRadiusMultiplier;
    this.glowPoints.unshift({ x: u, y: v, rPx: responsiveRadius, tSec });
    if (this.glowPoints.length > this.config.glowMaxPoints) this.glowPoints.length = this.config.glowMaxPoints;
  }

  // ---- Uniform updates ----
  _updateCropUniforms() {
    const { min, max } = this._computeCoverCropUV();
    this._withGL((gl) => {
      gl.useProgram(this.prog);
      gl.uniform2f(this.locs.uCropMin, min[0], min[1]);
      gl.uniform2f(this.locs.uCropMax, max[0], max[1]);
    });
  }

  // ---- External control surface ----
  forceRefresh() {
    this._resizeCanvasBackingStoreFromCss(this._naturalCssW || this.container.clientWidth || 0, this._naturalCssH || this.container.clientHeight || 0);
    this._updateGridDimensions();
  }

  getStatus() {
    return {
      renderFPS: this.fps,
      videoFPS: this.videoFPS,
      isInViewport: this.isInViewport,
      isPaused: this.isPaused,
      totalFrames: this.totalFrameCount,
      instanceId: this.instanceId,
      gridSize: `${this.cols}x${this.rows}`,
      cellSize: this.actualCellSize,
    };
  }

  pushUniforms() {
    this._withGL((gl) => {
      gl.useProgram(this.prog);
      gl.uniform1f(this.locs.uCharAspectRatio, this.config.charAspectRatio);
      gl.uniform1f(this.locs.uCharFillRatio, this.config.charFillRatio);
      gl.uniform1f(this.locs.uGamma, this.config.gamma);
      gl.uniform1f(this.locs.uEdgeLo, this.config.edgeLo);
      gl.uniform1f(this.locs.uEdgeHi, this.config.edgeHi);
      gl.uniform1f(this.locs.uTileOpacity, this.config.tileOpacity);
      gl.uniform1f(this.locs.uGlyphOpacity, this.config.glyphOpacity);
      gl.uniform1i(this.locs.uBlendMode, this.config.blendMode | 0);
      gl.uniform1f(this.locs.uBlendStrength, this.config.blendStrength);
      gl.uniform1i(this.locs.uPreserveHue, this.config.preserveHue ? 1 : 0);
      gl.uniform1f(this.locs.uGlyphCount, this.config.density.length);
      this._pushGlowStatics();
    });
  }

  drawFrame(shouldUpload = false) {
    this._drawFrame(shouldUpload);
  }

  rebuildAtlas() {
    this._buildAtlas();
    this._withGL((gl) => {
      gl.useProgram(this.prog);
      gl.uniform1f(this.locs.uGlyphCount, this.config.density.length);
    });
  }

  setDensity(str) {
    const s = String(str ?? "");
    if (s.length) this.config.density = s;
    this.rebuildAtlas();
  }

  destroy() {
    this._stopRenderLoop();
    try {
      this.video.pause();
    } catch {}
    if (this._onWinResize) window.removeEventListener("resize", this._onWinResize, { passive: true });
    if (this._ro) {
      this._ro.unobserve(this.container);
      this._ro.disconnect();
      this._ro = null;
    }
    this.canvas?.removeEventListener("webglcontextlost", this._onContextLost);
    this.canvas?.removeEventListener("webglcontextrestored", this._onContextRestored);
    if (this.gl) {
      const gl = this.gl;
      if (this.videoTex) gl.deleteTexture(this.videoTex);
      if (this.atlas?.tex) gl.deleteTexture(this.atlas.tex);
      if (this.prog) gl.deleteProgram(this.prog);
    }
    window.asciiMedia?.unregister(this.video);
    if (window.ASCIIRendererManagerSingleton?.removeRenderer) {
      window.ASCIIRendererManagerSingleton.removeRenderer(this);
    }
    this._resourcesReady = false;
  }
}

// ---------------- Loader: discovers placeholders, mounts renderers, primes media, manages unlock --------------
class ASCIILoader {
  /**
   * Scans the DOM for `.ascii-placeholder` elements, mounts a renderer for each,
   * preloads metadata and fallback stills, and defers visibility control to the global manager.
   *
   * Placeholder data attributes:
   *  - data-id        (required) unique identifier used to wire elements and instances
   *  - data-src       (optional) video URL
   *  - data-fallback  (optional) still image URL used as a fallback/prime frame
   *  - data-fitmode   (optional) e.g. "cover" to crop while preserving aspect ratio
   *  - data-position / data-position-x / data-position-y (optional) content alignment within the crop
   */
  constructor(opts = {}) {
    this.placeholders = Array.from(document.querySelectorAll(".ascii-placeholder"));

    this.manager = window.ASCIIRendererManagerSingleton || new ASCIIRendererManager();
    window.ASCIIRendererManagerSingleton = this.manager;

    // On tab/app visibility regain, re-play videos and nudge visible renderers
    this.manager.addVisibilityRAFHook();

    this.instances = new Map(); // id -> { container, canvas, video, renderer }
    this.pageUnlocked = false;
    this.opts = { preloadPolicy: "auto", ...opts };

    // Create canvas/video/renderer triples for all placeholders
    this._mountAll();

    // Prime: attach sources, try metadata, draw fallback stills, and attempt initial autoplay
    this._preloadAllAndPrime();

    // Set up a one-time user gesture unlock. Uses centralized playAllVideos().
    this._setupUnlockHandlers();

    // Initial attempt to ensure autoplay is active for all (safe when already playing)
    // Uses the same centralized function as gesture and visibility regain.
    window.asciiMedia?.playAllVideos().catch(() => {});
  }

  _setupUnlockHandlers() {
    const unlock = async () => {
      if (this.pageUnlocked) return;
      this.pageUnlocked = true;
      try {
        await window.asciiMedia?.playAllVideos();
      } catch {}
      window.removeEventListener("pointerdown", unlock, { passive: true });
      window.removeEventListener("touchstart", unlock, { passive: true });
      window.removeEventListener("wheel", unlock, { passive: true });
      window.removeEventListener("keydown", unlock, { passive: true });
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("touchstart", unlock, { passive: true });
    window.addEventListener("wheel", unlock, { passive: true });
    window.addEventListener("keydown", unlock, { passive: true });
  }

  _mountAll() {
    for (const el of this.placeholders) {
      const id = el.dataset.id;
      const src = el.dataset.src || "";
      const fallback = el.dataset.fallback || null;

      const position = el.dataset.position;
      const positionX = el.dataset.positionX;
      const positionY = el.dataset.positionY;
      const fitMode = el.dataset.fitmode;

      const container = document.createElement("div");
      container.className = "canvas-container";
      container.id = `ascii-container-${id}`;
      container.style.position = "relative";

      const videoWrap = document.createElement("div");
      videoWrap.className = "video-container";

      const video = document.createElement("video");
      video.id = `ascii-video-${id}`;
      video.setAttribute("muted", ""); // Safari cares about the attribute
      video.muted = true;
      video.setAttribute("playsinline", ""); // iOS Safari
      video.playsInline = true;
      video.setAttribute("autoplay", ""); // allow native autoplay
      video.autoplay = true;
      video.loop = true;
      video.crossOrigin = "anonymous";
      video.preload = this.opts.preloadPolicy || "auto";
      // NOTE: rely on markup autoplay as requested; controller will also nudge.

      const canvas = document.createElement("canvas");
      canvas.className = "ascii-canvas";
      canvas.id = `ascii-canvas-${id}`;

      videoWrap.appendChild(video);
      container.appendChild(videoWrap);
      container.appendChild(canvas);
      el.replaceWith(container);

      const renderer = new ASCIIVideoRenderer(container.id, canvas.id, video.id, {
        ...this.opts,
        videoSrc: src,
        fallbackStillSrc: fallback,
        ...(fitMode ? { fitMode } : {}),
        ...(position ? { position } : {}),
        ...(positionX ? { positionX: parseFloat(positionX) } : {}),
        ...(positionY ? { positionY: parseFloat(positionY) } : {}),
      });

      // Renderer registration with the global manager happens in constructor; also register video in media controller
      this.instances.set(id, { container, canvas, video, renderer });
    }
  }

  async _preloadAllAndPrime() {
    const primes = [];
    for (const { renderer, video } of this.instances.values()) {
      primes.push(
        (async () => {
          try {
            // Attach early to allow metadata fetch/preload
            if (!renderer.srcAttached && (renderer.config.videoSrc || renderer.video.getAttribute("data-src"))) {
              renderer.video.src = renderer.config.videoSrc || renderer.video.getAttribute("data-src");
              renderer.video.preload = renderer.config.preloadPolicy || "auto";
              renderer.srcAttached = true;
            }
            try {
              await renderer.ensureVideoMetadata();
            } catch {
              /* fallback will handle visuals */
            }
            if (renderer.config.fallbackStillSrc) {
              await renderer._renderFallbackStill();
              renderer.drawFrame(false);
            }
            // Attempt autoplay once on load; centralized controller will also retry as needed
            try {
              await video.play();
            } catch {
              /* blocked; handled by unlock/controller */
            }
          } catch (e) {
            console.warn(`[${renderer.instanceId}] prime failed`, e);
          }
        })()
      );
    }
    await Promise.allSettled(primes);
  }
}

// ---------------- Module Exports and Browser Globals ----------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ASCIIVideoRenderer, ASCIIRendererManager, ASCIILoader, ASCIIMediaController };
}
if (typeof window !== "undefined") {
  window.ASCIIVideoRenderer = ASCIIVideoRenderer;
  window.ASCIIRendererManager = ASCIIRendererManager;
  window.ASCIILoader = ASCIILoader;
  window.ASCIIMediaController = ASCIIMediaController;
  // Ensure singletons
  window.ASCIIRendererManagerSingleton ||= new ASCIIRendererManager();
  window.asciiMedia ||= new ASCIIMediaController();
}
