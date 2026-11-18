// Melodi hero scene (three.js): a wireframe CRT showing the app, floating over a
// synthwave terrain that moves like a scrolling audio spectrogram.

import * as THREE from "three";

// Colors are given as display (sRGB) hex values; keep them as-is end to end.
THREE.ColorManagement.enabled = false;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function start(initialTheme) {
  const canvas = document.getElementById("scene");
  const hero = document.querySelector(".hero");

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch (e) {
    document.documentElement.classList.add("no-webgl");
    return;
  }
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
  scene.fog = new THREE.Fog(0x000000, 18, 70);

  // ---------------------------------------------------------------- palette
  // `cur` eases toward `target` so theme changes glide instead of snapping.
  const mk = (t) => ({
    bg: new THREE.Color(t.bg),
    accent: new THREE.Color(t.accent),
    fg: new THREE.Color(t.fg),
    second: new THREE.Color(t.second),
  });
  const target = mk(initialTheme);
  const cur = mk(initialTheme);
  let light = initialTheme.id === "paper";

  // ---------------------------------------------------------------- terrain
  const COLS = 96;
  const ROWS = 64;
  const W = 64;
  const D = 70;
  const nV = COLS * ROWS;
  const pos = new Float32Array(nV * 3);
  const col = new Float32Array(nV * 3);
  const xs = new Float32Array(COLS);
  for (let c = 0; c < COLS; c++) xs[c] = (c / (COLS - 1) - 0.5) * W;
  const zs = new Float32Array(ROWS);
  for (let r = 0; r < ROWS; r++) zs[r] = 1 - (r / (ROWS - 1)) * D;

  const idx = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (c < COLS - 1) idx.push(i, i + 1); // across
      if (r < ROWS - 1) idx.push(i, i + COLS); // into the distance
    }
  }
  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  terrainGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  terrainGeo.setIndex(idx);
  const terrain = new THREE.LineSegments(
    terrainGeo,
    new THREE.LineBasicMaterial({ vertexColors: true, fog: true, transparent: true, opacity: 0.9 })
  );
  terrain.position.y = -1.2;
  scene.add(terrain);

  // Fake "music": a few drifting tones plus a kick on every beat (120 bpm).
  const BPM = 120;
  function spectrum(band, t) {
    const beat = (t * BPM) / 60;
    const kick = Math.pow(1 - (beat % 1), 6);
    // Smooth, low-frequency shapes read as "music" without turning into noise.
    const low = Math.exp(-band * 2.6) * (0.45 + 0.55 * kick);
    const mid =
      0.42 * (0.5 + 0.5 * Math.sin(band * 6.0 + t * 1.1)) * Math.exp(-Math.pow(band - 0.4, 2) * 6) +
      0.2 * (0.5 + 0.5 * Math.sin(band * 11.0 - t * 1.4 + Math.sin(t * 0.4) * 1.5));
    return low + mid;
  }

  const tmp = new THREE.Color();
  function updateTerrain(t) {
    for (let r = 0; r < ROWS; r++) {
      // Each row is a past moment: the landscape scrolls toward the viewer.
      const rowT = t - r * 0.045;
      // Keep the rows closest to the camera low so they don't fill the view.
      const near = THREE.MathUtils.smoothstep(r, 0, 10);
      const fade = 1 - r / ROWS;
      for (let c = 0; c < COLS; c++) {
        const x = xs[c];
        const ax = Math.abs(x);
        // Flat lane in the middle where the screen floats.
        const lane = THREE.MathUtils.smoothstep(ax, 2.6, 9.5);
        const band = Math.min(1, ax / (W * 0.5));
        const h = lane * near * spectrum(band, rowT) * (1.5 + band * 2.2);
        const i = (r * COLS + c) * 3;
        pos[i] = x;
        pos[i + 1] = h;
        pos[i + 2] = zs[r];
        const k = Math.min(1, h / 2.2);
        tmp.copy(cur.accent).lerp(cur.second, k * 0.55).multiplyScalar(0.35 + 0.65 * Math.max(k, fade * 0.5));
        if (light) tmp.copy(cur.accent).lerp(cur.second, k * 0.5).lerp(cur.bg, 0.15 + (1 - fade) * 0.5);
        col[i] = tmp.r;
        col[i + 1] = tmp.g;
        col[i + 2] = tmp.b;
      }
    }
    terrainGeo.attributes.position.needsUpdate = true;
    terrainGeo.attributes.color.needsUpdate = true;
  }

  // ---------------------------------------------------------------- sun
  const sunMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTop: { value: cur.accent }, uBottom: { value: cur.second }, uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uBottom; uniform float uTime; varying vec2 vUv;
      void main(){
        vec2 p = vUv - 0.5;
        float d = length(p);
        if (d > 0.5) discard;
        float y = vUv.y;
        // horizontal cut-outs in the lower half that drift downward
        float stripes = step(0.5, fract((y + uTime * 0.04) * 14.0));
        float cut = y < 0.48 ? mix(1.0, stripes, smoothstep(0.48, 0.0, y) * 0.95 + 0.05) : 1.0;
        if (cut < 0.5) discard;
        vec3 c = mix(uBottom, uTop, smoothstep(0.0, 1.0, y));
        float edge = smoothstep(0.5, 0.47, d);
        gl_FragColor = vec4(c, edge * 0.92);
      }`,
  });
  const sun = new THREE.Mesh(new THREE.CircleGeometry(9, 96), sunMat);
  sun.position.set(0, 6.5, -62);
  scene.add(sun);

  // ---------------------------------------------------------------- stars
  const starN = 700;
  const starPos = new Float32Array(starN * 3);
  for (let i = 0; i < starN; i++) {
    starPos[i * 3] = (Math.random() - 0.5) * 160;
    starPos[i * 3 + 1] = 4 + Math.random() * 50;
    starPos[i * 3 + 2] = -30 - Math.random() * 60;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ size: 0.16, color: cur.fg, transparent: true, opacity: 0.55, fog: false });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  // ---------------------------------------------------------------- monitor
  const monitor = new THREE.Group();
  scene.add(monitor);

  const SW = 5.2;
  const SH = SW / 1.6; // screenshots are 1440x900
  const edgeMat = new THREE.LineBasicMaterial({ color: cur.accent, transparent: true, opacity: 0.9 });
  const bodyMat = new THREE.MeshBasicMaterial({ color: cur.bg });

  function boxWithEdges(w, h, d, x, y, z) {
    const g = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(g, bodyMat);
    mesh.position.set(x, y, z);
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat);
    lines.position.copy(mesh.position);
    monitor.add(mesh, lines);
  }
  boxWithEdges(SW + 0.5, SH + 0.5, 0.55, 0, 0, -0.3); // bezel
  boxWithEdges(SW + 0.2, SH + 0.2, 1.4, 0, 0, -1.2); // tube back
  boxWithEdges(0.5, 0.9, 0.5, 0, -SH / 2 - 0.65, -0.9); // neck
  boxWithEdges(2.6, 0.18, 1.6, 0, -SH / 2 - 1.15, -0.9); // foot

  // Curved screen with a CRT shader.
  const screenGeo = new THREE.PlaneGeometry(SW, SH, 40, 25);
  {
    const p = screenGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / (SW / 2);
      const y = p.getY(i) / (SH / 2);
      p.setZ(i, 0.16 * (1 - 0.55 * x * x - 0.55 * y * y));
    }
    screenGeo.computeVertexNormals();
  }
  const loader = new THREE.TextureLoader();
  const texCache = new Map();
  function tex(id) {
    if (!texCache.has(id)) {
      const t = loader.load(`img/theme-${id}.webp`);
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = 4;
      texCache.set(id, t);
    }
    return texCache.get(id);
  }
  const screenMat = new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: tex(initialTheme.id) },
      uB: { value: tex(initialTheme.id) },
      uMix: { value: 1 },
      uTime: { value: 0 },
      uGlow: { value: cur.accent },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform sampler2D uA; uniform sampler2D uB; uniform float uMix; uniform float uTime; uniform vec3 uGlow;
      varying vec2 vUv;
      vec2 barrel(vec2 uv){ vec2 c = uv - 0.5; float r = dot(c, c); return 0.5 + c * (1.0 + 0.06 * r); }
      void main(){
        vec2 uv = barrel(vUv);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }
        vec3 a = texture2D(uA, uv).rgb;
        vec3 b = texture2D(uB, uv).rgb;
        vec3 c = mix(a, b, uMix);
        // slight horizontal colour bleed
        float o = 0.0012;
        c.r = mix(c.r, mix(texture2D(uA, uv + vec2(o,0.)).r, texture2D(uB, uv + vec2(o,0.)).r, uMix), 0.5);
        c.b = mix(c.b, mix(texture2D(uA, uv - vec2(o,0.)).b, texture2D(uB, uv - vec2(o,0.)).b, uMix), 0.5);
        float scan = 0.84 + 0.16 * sin(uv.y * 900.0);
        float roll = 0.97 + 0.03 * sin(uv.y * 6.0 - uTime * 1.6);
        vec2 v = uv - 0.5;
        float vig = smoothstep(0.85, 0.25, length(v * vec2(1.0, 1.25)));
        c = c * scan * roll * (0.55 + 0.45 * vig) + uGlow * 0.035;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const screen = new THREE.Mesh(screenGeo, screenMat);
  screen.position.z = 0.02;
  monitor.add(screen);

  // Soft light spill under the monitor.
  const glowMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: cur.accent }, uStrength: { value: 0.35 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uStrength; varying vec2 vUv;
      void main(){ float d = length((vUv - 0.5) * vec2(1.0, 1.8)); gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * uStrength); }`,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(12, 7), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(0, -SH / 2 - 1.22, -0.5);
  monitor.add(glow);

  // ---------------------------------------------------------------- layout
  let baseX = 0;
  function resize() {
    const w = hero.clientWidth;
    const h = hero.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Wide screens: keep the monitor clear of the text on the left.
    baseX = camera.aspect > 1.25 ? Math.min(4.2, 1.6 + (camera.aspect - 1.25) * 3) : 0;
    camera.fov = camera.aspect < 0.9 ? 62 : 42;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  // ---------------------------------------------------------------- interaction
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  window.addEventListener(
    "pointermove",
    (e) => {
      mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.ty = (e.clientY / window.innerHeight) * 2 - 1;
    },
    { passive: true }
  );

  window.addEventListener("melodi-theme", (e) => {
    const t = e.detail;
    const n = mk(t);
    target.bg.copy(n.bg);
    target.accent.copy(n.accent);
    target.fg.copy(n.fg);
    target.second.copy(n.second);
    light = t.id === "paper";
    // Cross-fade the screen to the new theme's screenshot.
    screenMat.uniforms.uA.value = mixedTexture();
    screenMat.uniforms.uB.value = tex(t.id);
    screenMat.uniforms.uMix.value = 0;
    if (reduceMotion) render(0.016, true);
  });
  function mixedTexture() {
    const u = screenMat.uniforms;
    return u.uMix.value > 0.5 ? u.uB.value : u.uA.value;
  }

  // ---------------------------------------------------------------- loop
  let running = true;
  let visible = true;
  const io = new IntersectionObserver((es) => {
    visible = es[0].isIntersecting;
    if (visible && running) loop();
  });
  io.observe(hero);
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running && visible) loop();
  });

  const clock = new THREE.Clock();
  let t = 0;
  let raf = 0;

  function render(dt, snap = false) {
    t += reduceMotion ? 0 : dt;
    const k = snap ? 1 : 1 - Math.pow(0.02, dt); // ease ~ over 1 s
    cur.bg.lerp(target.bg, k);
    cur.accent.lerp(target.accent, k);
    cur.fg.lerp(target.fg, k);
    cur.second.lerp(target.second, k);

    renderer.setClearColor(cur.bg, 1);
    scene.fog.color.copy(cur.bg);
    bodyMat.color.copy(cur.bg);
    edgeMat.color.copy(cur.accent);
    starMat.color.copy(cur.fg);
    starMat.opacity = light ? 0 : 0.55;
    glowMat.uniforms.uStrength.value = light ? 0.12 : 0.35;
    screenMat.uniforms.uMix.value = Math.min(1, screenMat.uniforms.uMix.value + (snap ? 1 : dt * 1.6));
    screenMat.uniforms.uTime.value = t;
    sunMat.uniforms.uTime.value = t;

    updateTerrain(reduceMotion ? 2.0 : t);

    mouse.x += (mouse.tx - mouse.x) * Math.min(1, dt * 3);
    mouse.y += (mouse.ty - mouse.y) * Math.min(1, dt * 3);
    monitor.position.set(baseX, 1.25 + Math.sin(t * 1.1) * 0.08, 0);
    monitor.rotation.set(-0.06 + mouse.y * 0.06, -0.32 + mouse.x * 0.16 + Math.sin(t * 0.5) * 0.03, 0);
    camera.position.set(baseX * 0.35 + mouse.x * 0.4, 2.3 - mouse.y * 0.25, 9.6);
    camera.lookAt(baseX * 0.6, 0.9, -2);

    renderer.render(scene, camera);
  }

  function loop() {
    cancelAnimationFrame(raf);
    if (!running || !visible || reduceMotion) return;
    raf = requestAnimationFrame(function frame() {
      const dt = Math.min(0.05, clock.getDelta());
      render(dt);
      if (running && visible) raf = requestAnimationFrame(frame);
    });
  }

  clock.getDelta();
  render(0.016, true);
  loop();
}
