import './style.css'
import * as THREE from 'three'
import GUI from 'lil-gui'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

const MAX_SOURCES = 8

document.querySelector('#app').innerHTML = `
  <main class="experience" aria-label="Interactive thermal imaging study">
    <div class="stage" id="stage"></div>

    <header class="label"><strong>Google</strong></header>

    <p class="hint">Click to apply heat</p>

    <div class="loader" id="loader">
      <div class="loader__mark">G</div>
      <div class="loader__line"><span></span></div>
    </div>

    <div class="cursor" id="cursor" aria-hidden="true">
      <span class="cursor__ring"></span>
      <span class="cursor__dot"></span>
    </div>
  </main>
`

const stage = document.querySelector('#stage')
const loaderElement = document.querySelector('#loader')
const cursorElement = document.querySelector('#cursor')
const cursorRing = cursorElement.querySelector('.cursor__ring')
const cursorDot = cursorElement.querySelector('.cursor__dot')

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x06070a)
scene.fog = new THREE.FogExp2(0x08090c, 0.045)

const camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.02, 120)
camera.position.set(5, 3.2, 7)

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
renderer.setSize(window.innerWidth, window.innerHeight, false)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.86
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
stage.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.dampingFactor = 0.07
controls.enablePan = false
controls.rotateSpeed = 0.55
controls.zoomSpeed = 0.7
controls.minPolarAngle = THREE.MathUtils.degToRad(42)
controls.maxPolarAngle = THREE.MathUtils.degToRad(84)

const params = {
  palette: 'Ironbow',
  irVision: false,
  surfaceLock: false,
  intensity: 1.35,
  spread: 0.95,
  diffusion: 1.5,
  dwell: 3.6,
  bleed: 0.35,
  turbulence: 0.07,
  swell: 0.014,
  glow: 1,
  embers: true,
  haze: 0.55,
  vignette: 0.3,
  bloom: 0.22,
  exposure: 0.86,
  autoRotate: true,
  rotationSpeed: 0.3,
  trigger: () => triggerRandomPulse(),
  resetCamera: () => resetCamera(),
}

// ---------------------------------------------------------------------------
// Shared heat field. Every click injects a source that diffuses outward across
// the surface and cools exponentially, the way a hot spot reads on an IR camera.
// ---------------------------------------------------------------------------

const heatUniforms = {
  uSources: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector3(999, 999, 999)) },
  uAges: { value: new Float32Array(MAX_SOURCES).fill(-1) },
  uMeshIds: { value: new Float32Array(MAX_SOURCES).fill(-1) },
  uSurfaceLock: { value: 0 },
  uSpread: { value: params.spread },
  uDiffusion: { value: params.diffusion },
  uCooling: { value: 4.2 / params.dwell },
  uIntensity: { value: params.intensity },
  uBleed: { value: params.bleed },
  uTurbulence: { value: params.turbulence },
  uSwell: { value: params.swell },
  uGlow: { value: params.glow },
  uPalette: { value: 0 },
  uIrVision: { value: 0 },
  uTime: { value: 0 },
}

const heatFieldChunk = `
  #define MAX_SOURCES ${MAX_SOURCES}

  uniform vec3 uSources[MAX_SOURCES];
  uniform float uAges[MAX_SOURCES];
  uniform float uMeshIds[MAX_SOURCES];
  uniform float uCurrentMeshId;
  uniform float uSurfaceLock;
  uniform float uSpread;
  uniform float uDiffusion;
  uniform float uCooling;
  uniform float uIntensity;
  uniform float uBleed;

  float heatField(vec3 samplePosition) {
    float heat = 0.0;

    for (int i = 0; i < MAX_SOURCES; i++) {
      float age = uAges[i];
      if (age < 0.0) continue;
      if (uSurfaceLock > 0.5 && abs(uMeshIds[i] - uCurrentMeshId) > 0.25) continue;

      float growth = 1.0 - exp(-age * uDiffusion);
      float frontRadius = uSpread * growth;
      float distanceToSource = distance(samplePosition, uSources[i]);

      // The contact point stays the hottest and spreads only a little.
      float coreSigma = 0.055 + frontRadius * 0.22;
      float core = exp(-(distanceToSource * distanceToSource) / (2.0 * coreSigma * coreSigma));
      core *= 1.0 - 0.25 * growth;

      // The conduction front, travelling outward across the surface.
      float frontWidth = 0.042 + uBleed * 0.14 + frontRadius * 0.16;
      float ringDistance = (distanceToSource - frontRadius) / frontWidth;
      float front = exp(-ringDistance * ringDistance) * exp(-age * 1.35) * 1.05;

      // Everything the front has already crossed is left warm.
      float interior = 1.0 - smoothstep(frontRadius * 0.55, frontRadius + frontWidth, distanceToSource);
      interior *= 0.38 * (1.0 - 0.35 * growth);

      heat += (core + front + interior) * exp(-age * uCooling);
    }

    return heat * uIntensity;
  }
`

const noiseChunk = `
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec3 p) {
    vec3 cell = floor(p);
    vec3 offset = fract(p);
    offset = offset * offset * (3.0 - 2.0 * offset);

    float n000 = hash13(cell);
    float n100 = hash13(cell + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(cell + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(cell + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(cell + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(cell + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(cell + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(cell + vec3(1.0, 1.0, 1.0));

    return mix(
      mix(mix(n000, n100, offset.x), mix(n010, n110, offset.x), offset.y),
      mix(mix(n001, n101, offset.x), mix(n011, n111, offset.x), offset.y),
      offset.z
    );
  }
`

const paletteChunk = `
  vec3 ironbow(float t) {
    vec3 color = vec3(0.026, 0.012, 0.072);
    color = mix(color, vec3(0.190, 0.038, 0.330), smoothstep(0.00, 0.14, t));
    color = mix(color, vec3(0.560, 0.070, 0.420), smoothstep(0.12, 0.28, t));
    color = mix(color, vec3(0.880, 0.160, 0.240), smoothstep(0.24, 0.44, t));
    color = mix(color, vec3(0.970, 0.380, 0.060), smoothstep(0.40, 0.60, t));
    color = mix(color, vec3(1.000, 0.660, 0.060), smoothstep(0.56, 0.76, t));
    color = mix(color, vec3(1.000, 0.900, 0.520), smoothstep(0.74, 0.90, t));
    color = mix(color, vec3(1.000, 1.000, 0.980), smoothstep(0.88, 1.00, t));
    return color;
  }

  vec3 arctic(float t) {
    vec3 color = vec3(0.020, 0.040, 0.110);
    color = mix(color, vec3(0.090, 0.210, 0.520), smoothstep(0.00, 0.28, t));
    color = mix(color, vec3(0.180, 0.560, 0.840), smoothstep(0.24, 0.52, t));
    color = mix(color, vec3(0.620, 0.880, 0.960), smoothstep(0.48, 0.72, t));
    color = mix(color, vec3(1.000, 0.760, 0.420), smoothstep(0.70, 0.88, t));
    color = mix(color, vec3(1.000, 1.000, 0.980), smoothstep(0.86, 1.00, t));
    return color;
  }

  vec3 medical(float t) {
    vec3 color = vec3(0.020, 0.020, 0.090);
    color = mix(color, vec3(0.070, 0.120, 0.620), smoothstep(0.00, 0.22, t));
    color = mix(color, vec3(0.060, 0.640, 0.560), smoothstep(0.18, 0.42, t));
    color = mix(color, vec3(0.520, 0.820, 0.180), smoothstep(0.38, 0.58, t));
    color = mix(color, vec3(0.980, 0.780, 0.100), smoothstep(0.54, 0.74, t));
    color = mix(color, vec3(0.940, 0.220, 0.140), smoothstep(0.70, 0.88, t));
    color = mix(color, vec3(1.000, 1.000, 1.000), smoothstep(0.88, 1.00, t));
    return color;
  }

  vec3 thermalPalette(float t, float mode) {
    t = clamp(t, 0.0, 1.0);
    if (mode < 0.5) return ironbow(t);
    if (mode < 1.5) return vec3(pow(t, 0.82));
    if (mode < 2.5) return vec3(1.0 - pow(t, 0.82));
    if (mode < 3.5) return arctic(t);
    return medical(t);
  }
`

const thermalShellMaterial = new THREE.ShaderMaterial({
  uniforms: {
    ...heatUniforms,
    uCurrentMeshId: { value: -1 },
  },
  vertexShader: `
    ${heatFieldChunk}

    uniform float uSwell;
    varying vec3 vWorldPosition;
    varying vec3 vWorldNormal;

    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vec3 worldNormal = normalize(mat3(modelMatrix) * normal);

      float heat = min(heatField(worldPosition.xyz), 2.4);
      worldPosition.xyz += worldNormal * heat * uSwell;

      vWorldPosition = worldPosition.xyz;
      vWorldNormal = worldNormal;
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `,
  fragmentShader: `
    ${heatFieldChunk}
    ${noiseChunk}
    ${paletteChunk}

    uniform float uTurbulence;
    uniform float uGlow;
    uniform float uPalette;
    uniform float uIrVision;
    uniform float uTime;
    varying vec3 vWorldPosition;
    varying vec3 vWorldNormal;

    void main() {
      vec3 normal = normalize(vWorldNormal);
      vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
      float fresnel = pow(1.0 - clamp(abs(dot(normal, viewDirection)), 0.0, 1.0), 2.4);

      // Reject cold fragments before paying for the noise below.
      if (uIrVision < 0.5 && heatField(vWorldPosition) < 0.004) discard;

      // Convecting plume warp, so the heat edge breathes instead of staying a circle.
      vec3 warp = vec3(
        valueNoise(vWorldPosition * 7.5 + vec3(0.0, uTime * 0.26, 0.0)),
        valueNoise(vWorldPosition * 7.5 + vec3(11.3, uTime * 0.22, 4.7)),
        valueNoise(vWorldPosition * 7.5 + vec3(3.1, uTime * 0.19, 19.4))
      ) - 0.5;

      float heat = heatField(vWorldPosition + warp * uTurbulence);

      // Thermal blooming: grazing angles read hotter on a real sensor.
      heat += heat * fresnel * 0.45;
      heat += uIrVision * (0.030 + 0.060 * fresnel);

      // Soft knee, so the palette spends its range on the gradient instead of
      // saturating to white the instant a click lands.
      float temperature = 1.0 - exp(-heat * 2.8);

      vec3 color = thermalPalette(temperature, uPalette);
      color *= 1.0 + smoothstep(0.78, 1.0, temperature) * 1.1 * uGlow;

      float alpha = uIrVision > 0.5 ? 1.0 : smoothstep(0.03, 0.24, temperature);
      if (alpha < 0.004) discard;

      gl_FragColor = vec4(color, alpha);
    }
  `,
  transparent: true,
  depthWrite: false,
  depthTest: true,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
  toneMapped: false,
})

// ---------------------------------------------------------------------------
// Environment: a quiet graphite studio, so heat is the only colour on screen.
// ---------------------------------------------------------------------------

const skyUniforms = { uTime: { value: 0 } }
const backdrop = new THREE.Mesh(
  new THREE.SphereGeometry(72, 48, 32),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDirection;

      float dither(vec2 fragment) {
        return fract(sin(dot(fragment, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec3 direction = normalize(vDirection);
        float height = clamp(direction.y * 0.5 + 0.5, 0.0, 1.0);

        vec3 zenith = vec3(0.0035, 0.0040, 0.0055);
        vec3 horizon = vec3(0.0210, 0.0235, 0.0300);
        vec3 color = mix(horizon, zenith, smoothstep(0.40, 0.96, height));

        float floorBounce = exp(-max(direction.y + 0.04, 0.0) * 11.0);
        color += vec3(0.020, 0.014, 0.010) * floorBounce * 0.5;

        // Break up banding, which is what makes a dark backdrop look cheap.
        color += (dither(gl_FragCoord.xy) - 0.5) * 0.0035;

        gl_FragColor = vec4(color, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  }),
)
backdrop.renderOrder = -100
scene.add(backdrop)

const groundHeatUniforms = {
  uHeatOrigin: { value: new THREE.Vector3(0, 0, 0) },
  uHeatAmount: { value: 0 },
}

const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0x090a0e,
  roughness: 0.9,
  metalness: 0.06,
  transparent: true,
  depthWrite: false,
})
groundMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uHeatOrigin = groundHeatUniforms.uHeatOrigin
  shader.uniforms.uHeatAmount = groundHeatUniforms.uHeatAmount

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorldPosition;')
    .replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvGroundWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;',
    )

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      varying vec3 vGroundWorldPosition;
      uniform vec3 uHeatOrigin;
      uniform float uHeatAmount;`,
    )
    .replace(
      '#include <opaque_fragment>',
      `float groundFade = 1.0 - smoothstep(6.5, 21.0, length(vGroundWorldPosition.xz));
      diffuseColor.a *= groundFade;

      float pool = exp(-dot(vGroundWorldPosition.xz, vGroundWorldPosition.xz) / 26.0);
      outgoingLight += vec3(0.052, 0.058, 0.072) * pool * 0.5;

      float heatDistance = distance(vGroundWorldPosition, uHeatOrigin);
      float heatPool = exp(-(heatDistance * heatDistance) / 0.7) * uHeatAmount;
      outgoingLight += vec3(1.0, 0.42, 0.14) * heatPool * 0.14 * groundFade;
      #include <opaque_fragment>`,
    )
}
groundMaterial.customProgramCacheKey = () => 'thermal-studio-ground-v1'

const ground = new THREE.Mesh(new THREE.PlaneGeometry(56, 56), groundMaterial)
ground.rotation.x = -Math.PI / 2
ground.position.y = -0.015
ground.receiveShadow = true
scene.add(ground)

function createContactShadowTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')
  const gradient = context.createRadialGradient(128, 128, 4, 128, 128, 126)
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.55)')
  gradient.addColorStop(0.38, 'rgba(0, 0, 0, 0.24)')
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 256, 256)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const contactShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(5.2, 4),
  new THREE.MeshBasicMaterial({
    map: createContactShadowTexture(),
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    toneMapped: false,
  }),
)
contactShadow.rotation.x = -Math.PI / 2
contactShadow.position.y = 0.01
scene.add(contactShadow)

scene.add(new THREE.HemisphereLight(0xdde6f4, 0x0a0b0f, 0.85))

const keyLight = new THREE.DirectionalLight(0xffffff, 2.3)
keyLight.position.set(-4, 7, 5)
keyLight.castShadow = true
keyLight.shadow.mapSize.set(2048, 2048)
keyLight.shadow.camera.left = -5
keyLight.shadow.camera.right = 5
keyLight.shadow.camera.top = 5
keyLight.shadow.camera.bottom = -5
keyLight.shadow.bias = -0.00045
scene.add(keyLight)

const coolFill = new THREE.PointLight(0xa8c4e8, 2.4, 16, 1.7)
coolFill.position.set(5, 3.5, 2)
scene.add(coolFill)

const rimLight = new THREE.PointLight(0xbfcbdd, 1.5, 14, 1.8)
rimLight.position.set(-4, 2.4, -4)
scene.add(rimLight)

// Real light spill from whatever was just heated.
const heatLight = new THREE.PointLight(0xff6a1e, 0, 2.6, 2)
heatLight.position.set(0, 1, 0)
scene.add(heatLight)

// ---------------------------------------------------------------------------
// Post processing: bloom for the white-hot core, then a single output pass that
// adds rising heat haze and a vignette before tone mapping and encoding. Folding
// the output stage in here saves a full-screen read/write of the HDR buffer.
// ---------------------------------------------------------------------------

const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))

const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth * 0.5, window.innerHeight * 0.5),
  params.bloom,
  0.68,
  0.92,
)
composer.addPass(bloom)

const sensorPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uCenters: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uTime: { value: 0 },
    uAspect: { value: window.innerWidth / window.innerHeight },
    uHaze: { value: params.haze },
    uHazeActive: { value: 0 },
    uVignette: { value: params.vignette },
    uExposure: { value: params.exposure },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    #define MAX_SOURCES ${MAX_SOURCES}

    uniform sampler2D tDiffuse;
    uniform vec4 uCenters[MAX_SOURCES];
    uniform float uTime;
    uniform float uAspect;
    uniform float uHaze;
    uniform float uHazeActive;
    uniform float uVignette;
    uniform float uExposure;
    varying vec2 vUv;

    // Matches THREE.ACESFilmicToneMapping so the look is unchanged by the merge.
    vec3 rrtAndOdtFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }

    vec3 acesFilmic(vec3 color) {
      const mat3 inputMatrix = mat3(
        0.59719, 0.07600, 0.02840,
        0.35458, 0.90834, 0.13383,
        0.04823, 0.01566, 0.83777
      );
      const mat3 outputMatrix = mat3(
         1.60475, -0.10208, -0.00327,
        -0.53108,  1.10813, -0.07276,
        -0.07367, -0.00605,  1.07602
      );
      color *= uExposure / 0.6;
      color = outputMatrix * rrtAndOdtFit(inputMatrix * color);
      return clamp(color, 0.0, 1.0);
    }

    vec3 linearToSRGB(vec3 value) {
      return mix(
        pow(value, vec3(0.41666)) * 1.055 - vec3(0.055),
        value * 12.92,
        vec3(lessThanEqual(value, vec3(0.0031308)))
      );
    }

    void main() {
      vec2 offset = vec2(0.0);

      if (uHazeActive > 0.5) {
      // Independent of the sources, so it is computed once rather than per source.
      float sway = sin(vUv.x * 36.0 + uTime * 2.1) * 0.3;

      for (int i = 0; i < MAX_SOURCES; i++) {
        vec4 center = uCenters[i];
        if (center.w <= 0.002) continue;

        vec2 delta = (vUv - center.xy) * vec2(uAspect, 1.0);
        float distanceToCenter = length(delta);
        float radius = max(center.z, 0.012);

        // Beyond three radii the shimmer is under a tenth of a pixel; skip the
        // transcendentals rather than pay for them across the whole frame.
        if (distanceToCenter > radius * 3.0) continue;

        float field = exp(-(distanceToCenter * distanceToCenter) / (radius * radius * 2.2));
        float rising = smoothstep(-0.35, 1.15, (vUv.y - center.y) / max(radius * 2.4, 0.05));
        float wobble = sin(distanceToCenter * 44.0 - uTime * 4.2 + center.w * 17.0) * 0.7 + sway;

        vec2 direction = delta / max(distanceToCenter, 1e-5);
        offset += direction * wobble * field * center.w * uHaze * 0.006;
        offset.y += wobble * field * rising * center.w * uHaze * 0.004;
      }
      }

      vec3 color = texture2D(tDiffuse, vUv + offset).rgb;

      float vignette = smoothstep(1.15, 0.32, length((vUv - 0.5) * vec2(uAspect, 1.0)));
      color *= mix(1.0, vignette, uVignette);

      gl_FragColor = vec4(linearToSRGB(acesFilmic(color)), 1.0);
    }
  `,
})
composer.addPass(sensorPass)

// ---------------------------------------------------------------------------
// Embers: cooling sparks that convect upward off the heated point.
// ---------------------------------------------------------------------------

const MAX_EMBERS = 220
const emberPositions = new Float32Array(MAX_EMBERS * 3).fill(999)
const emberSizes = new Float32Array(MAX_EMBERS)
const emberLives = new Float32Array(MAX_EMBERS)
const emberSeeds = new Float32Array(MAX_EMBERS)

const emberGeometry = new THREE.BufferGeometry()
emberGeometry.setAttribute('position', new THREE.BufferAttribute(emberPositions, 3).setUsage(THREE.DynamicDrawUsage))
emberGeometry.setAttribute('aSize', new THREE.BufferAttribute(emberSizes, 1).setUsage(THREE.DynamicDrawUsage))
emberGeometry.setAttribute('aLife', new THREE.BufferAttribute(emberLives, 1).setUsage(THREE.DynamicDrawUsage))
emberGeometry.setAttribute('aSeed', new THREE.BufferAttribute(emberSeeds, 1).setUsage(THREE.DynamicDrawUsage))

const emberMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPixelRatio: { value: renderer.getPixelRatio() },
    uPalette: heatUniforms.uPalette,
  },
  vertexShader: `
    attribute float aSize;
    attribute float aLife;
    attribute float aSeed;
    uniform float uPixelRatio;
    varying float vLife;
    varying float vSeed;

    void main() {
      vLife = aLife;
      vSeed = aSeed;
      vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uPixelRatio * (16.0 / max(-viewPosition.z, 0.001)) * (0.35 + 0.65 * aLife);
      gl_Position = projectionMatrix * viewPosition;
    }
  `,
  fragmentShader: `
    ${paletteChunk}

    uniform float uPalette;
    varying float vLife;
    varying float vSeed;

    void main() {
      vec2 coordinate = gl_PointCoord - 0.5;
      float falloff = smoothstep(0.5, 0.02, length(coordinate));
      if (falloff < 0.01 || vLife <= 0.0) discard;

      float temperature = clamp(vLife * (0.78 + 0.34 * vSeed), 0.0, 1.0);
      vec3 color = thermalPalette(temperature, uPalette) * (0.45 + 1.15 * temperature);

      gl_FragColor = vec4(color, falloff * smoothstep(0.0, 0.25, vLife));
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  toneMapped: false,
})

const emberCloud = new THREE.Points(emberGeometry, emberMaterial)
emberCloud.frustumCulled = false
emberCloud.renderOrder = 12
scene.add(emberCloud)

const emberStates = Array.from({ length: MAX_EMBERS }, () => ({
  active: false,
  age: 0,
  duration: 1,
  velocity: new THREE.Vector3(),
}))
let nextEmber = 0

function spawnEmbers(point, normal) {
  if (!params.embers) return

  for (let count = 0; count < 20; count += 1) {
    const index = nextEmber % MAX_EMBERS
    nextEmber += 1
    const state = emberStates[index]

    const scatterDirection = new THREE.Vector3(
      THREE.MathUtils.randFloatSpread(1),
      THREE.MathUtils.randFloatSpread(1),
      THREE.MathUtils.randFloatSpread(1),
    ).normalize()

    state.active = true
    state.age = 0
    state.duration = THREE.MathUtils.randFloat(0.9, 1.9)
    state.velocity
      .copy(normal)
      .multiplyScalar(THREE.MathUtils.randFloat(0.1, 0.3))
      .addScaledVector(scatterDirection, THREE.MathUtils.randFloat(0.04, 0.14))

    emberPositions[index * 3] = point.x + scatterDirection.x * 0.022
    emberPositions[index * 3 + 1] = point.y + scatterDirection.y * 0.022
    emberPositions[index * 3 + 2] = point.z + scatterDirection.z * 0.022
    emberSizes[index] = THREE.MathUtils.randFloat(0.9, 2.6)
    emberLives[index] = 1
    emberSeeds[index] = Math.random()
  }

  emberGeometry.attributes.position.needsUpdate = true
  emberGeometry.attributes.aSize.needsUpdate = true
  emberGeometry.attributes.aLife.needsUpdate = true
  emberGeometry.attributes.aSeed.needsUpdate = true
}

function updateEmbers(deltaTime, elapsed) {
  let changed = false

  for (let index = 0; index < MAX_EMBERS; index += 1) {
    const state = emberStates[index]
    if (!state.active) continue
    changed = true

    state.age += deltaTime
    const life = Math.max(0, 1 - state.age / state.duration)

    if (life <= 0) {
      state.active = false
      emberLives[index] = 0
      emberPositions[index * 3] = 999
      emberPositions[index * 3 + 1] = 999
      emberPositions[index * 3 + 2] = 999
      continue
    }

    // Buoyancy plus a slow lateral drift: hot air rises and wanders.
    state.velocity.y += 0.22 * deltaTime
    state.velocity.multiplyScalar(1 - 0.9 * deltaTime)
    const drift = Math.sin(elapsed * 1.6 + emberSeeds[index] * 21.7) * 0.035 * deltaTime

    emberPositions[index * 3] += state.velocity.x * deltaTime + drift
    emberPositions[index * 3 + 1] += state.velocity.y * deltaTime
    emberPositions[index * 3 + 2] += state.velocity.z * deltaTime - drift
    emberLives[index] = life
  }

  if (changed) {
    emberGeometry.attributes.position.needsUpdate = true
    emberGeometry.attributes.aLife.needsUpdate = true
  }
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const pointerDown = new THREE.Vector2()
const clickableMeshes = []
const thermalShells = []
const heatSources = Array.from({ length: MAX_SOURCES }, () => ({ start: -1000, point: new THREE.Vector3() }))
const defaultCameraPosition = new THREE.Vector3()
const defaultTarget = new THREE.Vector3()
const projectedPoint = new THREE.Vector3()
const pointerPixel = new THREE.Vector2(-200, -200)
const cursorRingPixel = new THREE.Vector2(-200, -200)
let nextSource = 0
let model = null
let dragging = false
let pointerPressed = false
let peakHeat = 0
let cursorScale = 0.6
let cursorTargetScale = 0.6
let shellsVisible = false

// A trailing ring and an exact dot: the ring lags just enough to feel weighted.
function updateCursor(deltaTime) {
  cursorRingPixel.lerp(pointerPixel, 1 - Math.exp(-deltaTime * 17))
  cursorScale += (cursorTargetScale - cursorScale) * (1 - Math.exp(-deltaTime * 15))

  cursorRing.style.transform =
    `translate3d(${cursorRingPixel.x}px, ${cursorRingPixel.y}px, 0) scale(${cursorScale.toFixed(3)})`
  cursorDot.style.transform = `translate3d(${pointerPixel.x}px, ${pointerPixel.y}px, 0)`
}

function getHitWorldNormal(hit) {
  if (!hit.face) return new THREE.Vector3(0, 1, 0)
  return hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
}

function applyHeat(point, meshId, normal, fromPointer = true) {
  const index = nextSource % MAX_SOURCES
  nextSource += 1

  heatUniforms.uSources.value[index].copy(point)
  heatUniforms.uMeshIds.value[index] = meshId
  heatUniforms.uAges.value[index] = 0
  heatSources[index].start = performance.now() * 0.001
  heatSources[index].point.copy(point)

  heatLight.position.copy(point).addScaledVector(normal, 0.4)
  groundHeatUniforms.uHeatOrigin.value.set(point.x, 0, point.z)

  spawnEmbers(point, normal)
  if (fromPointer) document.body.classList.add('has-interacted')
}

function triggerRandomPulse(fromPointer = true) {
  if (!model) return
  for (let attempt = 0; attempt < 32; attempt += 1) {
    pointer.set(THREE.MathUtils.randFloat(-0.5, 0.5), THREE.MathUtils.randFloat(-0.36, 0.42))
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(clickableMeshes, false)[0]
    if (hit) {
      applyHeat(hit.point, hit.object.userData.thermalMeshId, getHitWorldNormal(hit), fromPointer)
      return
    }
  }
}

function prepareModel(root) {
  const sourceMeshes = []

  root.traverse((object) => {
    if (!object.isMesh) return

    object.geometry.computeBoundingBox()
    const localSize = object.geometry.boundingBox.getSize(new THREE.Vector3())
    if (Math.max(localSize.x, localSize.y, localSize.z) > 6) {
      object.visible = false
      return
    }

    object.castShadow = true
    object.receiveShadow = true
    clickableMeshes.push(object)
    sourceMeshes.push(object)

    const materials = Array.isArray(object.material) ? object.material : [object.material]
    materials.forEach((material) => {
      if (!material) return
      if ('envMapIntensity' in material) material.envMapIntensity = 0.8
      if ('roughness' in material) material.roughness = Math.max(material.roughness ?? 0.5, 0.38)
    })
  })

  sourceMeshes.forEach((object, meshId) => {
    object.userData.thermalMeshId = meshId

    const shellMaterial = thermalShellMaterial.clone()
    Object.keys(heatUniforms).forEach((uniformName) => {
      shellMaterial.uniforms[uniformName] = heatUniforms[uniformName]
    })
    shellMaterial.uniforms.uCurrentMeshId = { value: meshId }

    const shell = new THREE.Mesh(object.geometry, shellMaterial)
    shell.name = `${object.name || 'mesh'}-thermal-shell`
    shell.frustumCulled = false
    shell.renderOrder = 6
    shell.raycast = () => {}
    shell.visible = false
    thermalShells.push(shell)
    object.add(shell)
  })
}

function placeAndFrameModel(root) {
  const getVisibleBounds = () => {
    root.updateMatrixWorld(true)
    const bounds = new THREE.Box3()
    root.traverse((object) => {
      if (object.isMesh && object.visible && !object.name.endsWith('-thermal-shell')) {
        bounds.expandByObject(object, true)
      }
    })
    return bounds
  }

  root.updateMatrixWorld(true)
  const initialSize = getVisibleBounds().getSize(new THREE.Vector3())
  const scale = 3.7 / Math.max(initialSize.x, initialSize.y, initialSize.z, 0.001)
  root.scale.multiplyScalar(scale)
  root.updateMatrixWorld(true)

  let box = getVisibleBounds()
  const center = box.getCenter(new THREE.Vector3())
  root.position.x -= center.x
  root.position.z -= center.z
  root.position.y += 0.06 - box.min.y
  root.updateMatrixWorld(true)

  box = getVisibleBounds()
  const size = box.getSize(new THREE.Vector3())
  const target = new THREE.Vector3(0, size.y * 0.46 + 0.04, 0)
  const sphere = box.getBoundingSphere(new THREE.Sphere())
  const halfFov = THREE.MathUtils.degToRad(camera.fov * 0.5)
  const distance = (sphere.radius / Math.sin(halfFov)) * 1.08
  const viewDirection = new THREE.Vector3(0.9, 0.34, 1.45).normalize()

  camera.position.copy(target).addScaledVector(viewDirection, distance)
  controls.target.copy(target)
  controls.minDistance = distance * 0.66
  controls.maxDistance = distance * 1.7
  controls.update()
  defaultCameraPosition.copy(camera.position)
  defaultTarget.copy(controls.target)

  contactShadow.scale.set(Math.max(0.75, size.x / 3.7), Math.max(0.75, size.z / 3.7), 1)
}

function resetCamera() {
  camera.position.copy(defaultCameraPosition)
  controls.target.copy(defaultTarget)
  controls.update()
}

const gltfLoader = new GLTFLoader()
gltfLoader.load(
  '/google.glb',
  (gltf) => {
    model = gltf.scene
    prepareModel(model)
    placeAndFrameModel(model)
    scene.add(model)
    model.updateMatrixWorld(true)

    // Nothing in the scene casts a moving shadow, so stop re-rendering the shadow
    // map once the model has been in it for a frame. Freezing it any earlier
    // leaves the shadow sampler bound to a null texture and the ground plane,
    // which receives it, fails to draw at all.
    freezeShadowsIn = 2

    loaderElement.style.setProperty('--progress', 1)
    loaderElement.classList.add('is-hidden')
    setTimeout(() => loaderElement.remove(), 850)

    // One unattributed pulse so the effect introduces itself; the hint stays up.
    setTimeout(() => {
      if (!document.body.classList.contains('has-interacted')) triggerRandomPulse(false)
    }, 1500)
  },
  (event) => {
    if (!event.total) return
    loaderElement.style.setProperty('--progress', Math.min(1, event.loaded / event.total))
  },
  (error) => {
    console.error('Unable to load /google.glb', error)
    loaderElement.classList.add('has-error')
  },
)

function updatePointer(event) {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
}

window.addEventListener('pointermove', (event) => {
  pointerPixel.set(event.clientX, event.clientY)
  cursorElement.classList.add('is-visible')
}, { passive: true })

document.addEventListener('pointerleave', () => cursorElement.classList.remove('is-visible'))
window.addEventListener('blur', () => cursorElement.classList.remove('is-visible'))

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerDown.set(event.clientX, event.clientY)
  pointerPressed = true
  dragging = false
  cursorTargetScale = 0.42
  renderer.domElement.classList.add('is-dragging')
})

renderer.domElement.addEventListener('pointermove', (event) => {
  if (pointerPressed && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) dragging = true

  if (!model) return
  updatePointer(event)
  raycaster.setFromCamera(pointer, camera)
  const overObject = raycaster.intersectObjects(clickableMeshes, false).length > 0
  renderer.domElement.classList.toggle('is-over-object', overObject)
  cursorElement.classList.toggle('is-over', overObject)
  if (!pointerPressed) cursorTargetScale = overObject ? 1 : 0.6
})

renderer.domElement.addEventListener('pointerleave', () => {
  renderer.domElement.classList.remove('is-over-object')
  cursorElement.classList.remove('is-over')
  cursorTargetScale = 0.6
})

renderer.domElement.addEventListener('pointerup', (event) => {
  pointerPressed = false
  cursorTargetScale = cursorElement.classList.contains('is-over') ? 1 : 0.6
  renderer.domElement.classList.remove('is-dragging')
  if (!model || dragging) return

  updatePointer(event)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects(clickableMeshes, false)[0]
  if (hit) applyHeat(hit.point, hit.object.userData.thermalMeshId, getHitWorldNormal(hit))
})

renderer.domElement.addEventListener('pointercancel', () => {
  pointerPressed = false
  dragging = false
  cursorTargetScale = 0.6
  renderer.domElement.classList.remove('is-dragging')
})

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const palettes = { Ironbow: 0, 'White hot': 1, 'Black hot': 2, Arctic: 3, Rainbow: 4 }

const gui = new GUI({ title: 'Thermal controls', width: 252 })
gui.domElement.classList.add('effect-gui')
gui.domElement.addEventListener('pointerenter', () => cursorElement.classList.add('is-muted'))
gui.domElement.addEventListener('pointerleave', () => cursorElement.classList.remove('is-muted'))

const heatFolder = gui.addFolder('Heat')
heatFolder.add(params, 'palette', Object.keys(palettes)).name('Palette').onChange((value) => { heatUniforms.uPalette.value = palettes[value] })
heatFolder.add(params, 'irVision').name('Full IR vision').onChange((value) => { heatUniforms.uIrVision.value = value ? 1 : 0 })
heatFolder.add(params, 'intensity', 0.3, 2.6, 0.01).name('Intensity').onChange((value) => { heatUniforms.uIntensity.value = value })
heatFolder.add(params, 'spread', 0.15, 2.6, 0.01).name('Spread').onChange((value) => { heatUniforms.uSpread.value = value })
heatFolder.add(params, 'diffusion', 0.4, 6, 0.05).name('Diffusion rate').onChange((value) => { heatUniforms.uDiffusion.value = value })
heatFolder.add(params, 'dwell', 0.8, 8, 0.1).name('Cool-down (s)').onChange((value) => { heatUniforms.uCooling.value = 4.2 / value })
heatFolder.add(params, 'bleed', 0, 1, 0.01).name('Edge bleed').onChange((value) => { heatUniforms.uBleed.value = value })
heatFolder.add(params, 'turbulence', 0, 0.2, 0.005).name('Plume warp').onChange((value) => { heatUniforms.uTurbulence.value = value })
heatFolder.add(params, 'swell', 0, 0.06, 0.001).name('Thermal swell').onChange((value) => { heatUniforms.uSwell.value = value })
heatFolder.add(params, 'glow', 0, 3, 0.01).name('Core glow').onChange((value) => { heatUniforms.uGlow.value = value })
heatFolder.add(params, 'embers').name('Embers')
heatFolder.add(params, 'surfaceLock').name('Surface lock').onChange((value) => { heatUniforms.uSurfaceLock.value = value ? 1 : 0 })

const sensorFolder = gui.addFolder('Sensor')
sensorFolder.add(params, 'haze', 0, 2, 0.01).name('Heat haze').onChange((value) => { sensorPass.uniforms.uHaze.value = value })
sensorFolder.add(params, 'vignette', 0, 1, 0.01).name('Vignette').onChange((value) => { sensorPass.uniforms.uVignette.value = value })
sensorFolder.add(params, 'bloom', 0, 1.6, 0.01).name('Bloom').onChange((value) => { bloom.strength = value })
sensorFolder.add(params, 'exposure', 0.6, 1.4, 0.01).name('Exposure').onChange((value) => { sensorPass.uniforms.uExposure.value = value })

const sceneFolder = gui.addFolder('Scene')
sceneFolder.add(params, 'autoRotate').name('Auto rotate')
sceneFolder.add(params, 'rotationSpeed', 0.05, 1.5, 0.05).name('Rotate speed')
sceneFolder.add(params, 'trigger').name('Trigger heat pulse')
sceneFolder.add(params, 'resetCamera').name('Reset camera')

heatFolder.close()
sensorFolder.close()
sceneFolder.close()
gui.close()

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.setSize(window.innerWidth, window.innerHeight, false)
  composer.setSize(window.innerWidth, window.innerHeight)
  bloom.setSize(window.innerWidth * 0.5, window.innerHeight * 0.5)
  sensorPass.uniforms.uAspect.value = window.innerWidth / window.innerHeight
  emberMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio()
})

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let previousFrameTime = performance.now() * 0.001
let freezeShadowsIn = -1

function updateHeatSources(now) {
  const halfFovTangent = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))
  let strongest = 0
  let total = 0
  let active = 0

  for (let index = 0; index < MAX_SOURCES; index += 1) {
    const age = now - heatSources[index].start
    const centre = sensorPass.uniforms.uCenters.value[index]

    if (age < 0 || age > params.dwell) {
      heatUniforms.uAges.value[index] = -1
      centre.set(0, 0, 0, 0)
      continue
    }

    heatUniforms.uAges.value[index] = age
    active += 1

    const amplitude = Math.exp(-age * heatUniforms.uCooling.value) * params.intensity
    strongest = Math.max(strongest, amplitude)
    total += amplitude

    projectedPoint.copy(heatSources[index].point)
    const distanceToCamera = projectedPoint.distanceTo(camera.position)
    projectedPoint.project(camera)

    if (projectedPoint.z > 1) {
      centre.set(0, 0, 0, 0)
      continue
    }

    const frontRadius = params.spread * (1 - Math.exp(-age * params.diffusion))
    const screenHeight = 2 * halfFovTangent * distanceToCamera
    centre.set(
      projectedPoint.x * 0.5 + 0.5,
      projectedPoint.y * 0.5 + 0.5,
      Math.max(frontRadius / screenHeight, 0.012),
      Math.min(amplitude, 1.4),
    )
  }

  peakHeat = strongest + (total - strongest) * 0.35

  // With no live heat there is nothing for the shell or the haze to draw.
  const shellsNeeded = active > 0 || params.irVision
  if (shellsNeeded !== shellsVisible) {
    shellsVisible = shellsNeeded
    for (let index = 0; index < thermalShells.length; index += 1) {
      thermalShells[index].visible = shellsNeeded
    }
  }
  sensorPass.uniforms.uHazeActive.value = active > 0 ? 1 : 0
}

function animate() {
  requestAnimationFrame(animate)

  const now = performance.now() * 0.001
  const deltaTime = Math.min(0.05, Math.max(0, now - previousFrameTime))
  previousFrameTime = now

  if (freezeShadowsIn > 0 && --freezeShadowsIn === 0) renderer.shadowMap.autoUpdate = false

  updateHeatSources(now)

  const lightBlend = Math.min(1, deltaTime * 9)
  heatLight.intensity += (Math.min(peakHeat, 1.6) * 0.45 - heatLight.intensity) * lightBlend
  groundHeatUniforms.uHeatAmount.value +=
    (Math.min(peakHeat, 1.4) * 0.45 - groundHeatUniforms.uHeatAmount.value) * Math.min(1, deltaTime * 6)

  controls.autoRotate = params.autoRotate && !dragging
  controls.autoRotateSpeed = params.rotationSpeed

  backdrop.position.copy(camera.position)
  skyUniforms.uTime.value = now
  heatUniforms.uTime.value = now
  sensorPass.uniforms.uTime.value = now

  updateEmbers(deltaTime, now)
  updateCursor(deltaTime)
  controls.update()
  composer.render()
}

window.__dbg = { renderer, scene, ground, groundMaterial, keyLight, contactShadow }

animate()
