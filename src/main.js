import './style.css'
import * as THREE from 'three'
import GUI from 'lil-gui'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

const MAX_PULSES = 6

document.querySelector('#app').innerHTML = `
  <main class="experience" aria-label="Interactive Google logo object study">
    <div class="stage" id="stage"></div>
    <div class="soft-light"></div>

    <header class="label">
      <span>Object study / 01</span>
      <strong>Google</strong>
    </header>

    <p class="hint"><span>Click the object</span><small>Drag to rotate</small></p>

    <div class="loader" id="loader">
      <div class="loader__mark">G</div>
      <div class="loader__line"><span></span></div>
      <p>Loading object</p>
    </div>

  </main>
`

const stage = document.querySelector('#stage')
const loaderElement = document.querySelector('#loader')

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x040914)
scene.fog = new THREE.FogExp2(0x0b2b4f, 0.065)

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.02, 100)
camera.position.set(5, 3.2, 7)

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.8
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
stage.appendChild(renderer.domElement)

const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.08,
  0.45,
  0.78,
)
composer.addPass(bloom)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.dampingFactor = 0.07
controls.enablePan = false
controls.rotateSpeed = 0.55
controls.zoomSpeed = 0.7
controls.minPolarAngle = THREE.MathUtils.degToRad(40)
controls.maxPolarAngle = THREE.MathUtils.degToRad(84)

const params = {
  autoRotate: true,
  rotationSpeed: 0.35,
  effectStyle: 'Grid',
  surfaceLock: true,
  googleColors: true,
  fragments: true,
  gridSize: 0.055,
  lineWidth: 0.72,
  spread: 0.92,
  duration: 1.75,
  glow: 0.88,
  displacement: 0.018,
  lineColor: '#4285f4',
  waveColor: '#7a5cff',
  bloom: 0.08,
  exposure: 0.8,
  trigger: () => triggerRandomPulse(),
  resetCamera: () => resetCamera(),
}

// Procedural night sky: atmospheric blue gradient with two layers of tiny stars.
const skyUniforms = {
  uTime: { value: 0 },
  uStarBrightness: { value: 0.76 },
}
const nightSky = new THREE.Mesh(
  new THREE.SphereGeometry(68, 64, 40),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vSkyDirection;

      void main() {
        vSkyDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uStarBrightness;
      varying vec3 vSkyDirection;

      const float PI = 3.14159265359;

      float hash21(vec2 value) {
        value = fract(value * vec2(123.34, 456.21));
        value += dot(value, value + 45.32);
        return fract(value.x * value.y);
      }

      float starLayer(vec2 uv, vec2 resolution, float threshold, float timeScale) {
        vec2 cellPosition = uv * resolution;
        vec2 cellId = floor(cellPosition);
        vec2 cellUv = fract(cellPosition) - 0.5;
        float randomValue = hash21(cellId);
        float exists = smoothstep(threshold, 1.0, randomValue);
        float radius = mix(0.03, 0.09, hash21(cellId + 17.7));
        float point = 1.0 - smoothstep(radius, radius + 0.035, length(cellUv));
        float twinkle = 0.76 + 0.24 * sin(uTime * timeScale + randomValue * 37.0);
        return exists * point * twinkle;
      }

      void main() {
        vec3 direction = normalize(vSkyDirection);
        float height = clamp(direction.y * 0.5 + 0.5, 0.0, 1.0);
        float upperSky = smoothstep(0.5, 0.86, height);
        vec3 horizonColor = vec3(0.025, 0.067, 0.14);
        vec3 zenithColor = vec3(0.002, 0.007, 0.026);
        vec3 skyColor = mix(horizonColor, zenithColor, upperSky);

        float horizonHaze = exp(-abs(direction.y) * 6.5);
        skyColor += vec3(0.025, 0.075, 0.16) * horizonHaze * 0.42;

        vec2 sphericalUv = vec2(
          atan(direction.z, direction.x) / (2.0 * PI) + 0.5,
          asin(clamp(direction.y, -1.0, 1.0)) / PI + 0.5
        );

        float fineStars = starLayer(sphericalUv, vec2(620.0, 310.0), 0.982, 0.52);
        float softStars = starLayer(sphericalUv + vec2(0.137, 0.071), vec2(310.0, 155.0), 0.991, 0.28);
        float aboveHorizon = smoothstep(0.48, 0.58, height);
        float stars = (fineStars + softStars * 0.58) * aboveHorizon * uStarBrightness;
        vec3 starColor = mix(vec3(0.48, 0.67, 1.0), vec3(0.96, 0.98, 1.0), fineStars);

        gl_FragColor = vec4(skyColor + starColor * stars, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  }),
)
nightSky.renderOrder = -100
scene.add(nightSky)

// A quiet studio floor with a soft contact shadow.
const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0x0b1423,
  roughness: 0.92,
  metalness: 0,
  transparent: true,
  depthWrite: false,
})
groundMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vGroundWorldPosition;',
    )
    .replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvGroundWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;',
    )

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vGroundWorldPosition;',
    )
    .replace(
      '#include <opaque_fragment>',
      `float groundFade = 1.0 - smoothstep(9.0, 31.0, length(vGroundWorldPosition.xz));
      diffuseColor.a *= groundFade;
      #include <opaque_fragment>`,
    )
}
groundMaterial.customProgramCacheKey = () => 'soft-radial-ground-v1'
const ground = new THREE.Mesh(new THREE.PlaneGeometry(180, 180), groundMaterial)
ground.rotation.x = -Math.PI / 2
ground.position.y = -0.015
ground.receiveShadow = true
scene.add(ground)

function createContactShadowTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')
  const gradient = context.createRadialGradient(128, 128, 5, 128, 128, 126)
  gradient.addColorStop(0, 'rgba(31, 42, 56, 0.28)')
  gradient.addColorStop(0.42, 'rgba(31, 42, 56, 0.12)')
  gradient.addColorStop(1, 'rgba(31, 42, 56, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 256, 256)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const contactShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(4.8, 3.6),
  new THREE.MeshBasicMaterial({
    map: createContactShadowTexture(),
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    toneMapped: false,
  }),
)
contactShadow.rotation.x = -Math.PI / 2
contactShadow.position.y = 0.012
scene.add(contactShadow)

const horizonRing = new THREE.Mesh(
  new THREE.RingGeometry(3.7, 3.71, 160),
  new THREE.MeshBasicMaterial({ color: 0x36577d, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
)
horizonRing.rotation.x = -Math.PI / 2
horizonRing.position.y = 0.004
scene.add(horizonRing)

// Soft studio lighting.
scene.add(new THREE.HemisphereLight(0xc8dcff, 0x07101d, 1.0))

const keyLight = new THREE.DirectionalLight(0xffffff, 2.1)
keyLight.position.set(-4, 7, 5)
keyLight.castShadow = true
keyLight.shadow.mapSize.set(2048, 2048)
keyLight.shadow.camera.left = -5
keyLight.shadow.camera.right = 5
keyLight.shadow.camera.top = 5
keyLight.shadow.camera.bottom = -5
keyLight.shadow.bias = -0.00045
scene.add(keyLight)

const coolFill = new THREE.PointLight(0x8bbaff, 3.3, 15, 1.6)
coolFill.position.set(5, 3.5, 2)
scene.add(coolFill)

const warmRim = new THREE.PointLight(0x8d72ff, 2.3, 13, 1.7)
warmRim.position.set(-4, 2.4, -4)
scene.add(warmRim)

// Fine, world-aligned square wire grid revealed only by a pulse.
const pulseUniforms = {
  uPoints: { value: Array.from({ length: MAX_PULSES }, () => new THREE.Vector3(999, 999, 999)) },
  uTimes: { value: new Float32Array(MAX_PULSES).fill(-1) },
  uMeshIds: { value: new Float32Array(MAX_PULSES).fill(-1) },
  uGridSize: { value: params.gridSize },
  uLineWidth: { value: params.lineWidth },
  uRadius: { value: params.spread },
  uGlow: { value: params.glow },
  uDisplacement: { value: params.displacement },
  uStyle: { value: 0 },
  uSurfaceLock: { value: 1 },
  uGoogleColors: { value: 1 },
  uGlobalTime: { value: 0 },
  uLineColor: { value: new THREE.Color(params.lineColor) },
  uWaveColor: { value: new THREE.Color(params.waveColor) },
}

const gridEffectMaterial = new THREE.ShaderMaterial({
  uniforms: {
    ...pulseUniforms,
    uCurrentMeshId: { value: -1 },
  },
  vertexShader: `
    #define MAX_PULSES ${MAX_PULSES}

    uniform vec3 uPoints[MAX_PULSES];
    uniform float uTimes[MAX_PULSES];
    uniform float uMeshIds[MAX_PULSES];
    uniform float uCurrentMeshId;
    uniform float uRadius;
    uniform float uDisplacement;
    uniform float uSurfaceLock;
    varying vec3 vWorldPosition;
    varying vec3 vWorldNormal;

    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
      float surfaceLift = 0.0;

      for (int i = 0; i < MAX_PULSES; i++) {
        float t = uTimes[i];
        if (t < 0.0 || t > 1.0) continue;
        if (uSurfaceLock > 0.5 && abs(uMeshIds[i] - uCurrentMeshId) > 0.25) continue;

        float eased = t * t * (3.0 - 2.0 * t);
        float radius = mix(0.015, uRadius, eased);
        float distanceFromClick = distance(worldPosition.xyz, uPoints[i]);
        float wave = 1.0 - smoothstep(0.015, 0.115, abs(distanceFromClick - radius));
        float life = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.76, 1.0, t));
        surfaceLift += wave * life * uDisplacement;
      }

      worldPosition.xyz += worldNormal * surfaceLift;
      vWorldPosition = worldPosition.xyz;
      vWorldNormal = worldNormal;
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `,
  fragmentShader: `
    #define MAX_PULSES ${MAX_PULSES}

    uniform vec3 uPoints[MAX_PULSES];
    uniform float uTimes[MAX_PULSES];
    uniform float uMeshIds[MAX_PULSES];
    uniform float uCurrentMeshId;
    uniform float uGridSize;
    uniform float uLineWidth;
    uniform float uRadius;
    uniform float uGlow;
    uniform float uStyle;
    uniform float uSurfaceLock;
    uniform float uGoogleColors;
    uniform float uGlobalTime;
    uniform vec3 uLineColor;
    uniform vec3 uWaveColor;
    varying vec3 vWorldPosition;
    varying vec3 vWorldNormal;

    float squareGrid(vec3 worldPosition, vec3 worldNormal) {
      vec3 coordinate = worldPosition / max(uGridSize, 0.008);
      vec3 cellEdge = min(fract(coordinate), 1.0 - fract(coordinate));
      vec3 antialiasWidth = fwidth(coordinate) * uLineWidth;
      vec3 line = 1.0 - smoothstep(vec3(0.0), antialiasWidth, cellEdge);
      vec3 normalWeight = abs(normalize(worldNormal));

      if (normalWeight.x > normalWeight.y && normalWeight.x > normalWeight.z) {
        return max(line.y, line.z);
      }
      if (normalWeight.y > normalWeight.z) {
        return max(line.x, line.z);
      }
      return max(line.x, line.y);
    }

    vec3 googlePalette(float phase) {
      vec3 blue = vec3(0.259, 0.522, 0.957);
      vec3 red = vec3(0.918, 0.263, 0.208);
      vec3 yellow = vec3(0.984, 0.737, 0.020);
      vec3 green = vec3(0.204, 0.659, 0.325);

      if (phase < 0.33) return mix(blue, red, phase / 0.33);
      if (phase < 0.66) return mix(red, yellow, (phase - 0.33) / 0.33);
      return mix(yellow, green, (phase - 0.66) / 0.34);
    }

    void main() {
      float grid = squareGrid(vWorldPosition, vWorldNormal);
      float alpha = 0.0;
      vec3 finalColor = vec3(0.0);

      for (int i = 0; i < MAX_PULSES; i++) {
        float t = uTimes[i];
        if (t < 0.0 || t > 1.0) continue;
        if (uSurfaceLock > 0.5 && abs(uMeshIds[i] - uCurrentMeshId) > 0.25) continue;

        float eased = t * t * (3.0 - 2.0 * t);
        float radius = mix(0.015, uRadius, eased);
        float distanceFromClick = distance(vWorldPosition, uPoints[i]);
        float leadingLine = 1.0 - smoothstep(0.012, 0.058, abs(distanceFromClick - radius));
        float wave = 1.0 - smoothstep(0.025, 0.15, abs(distanceFromClick - radius));
        float interior = 1.0 - smoothstep(radius - 0.025, radius + 0.04, distanceFromClick);
        float distanceBehindFront = max(radius - distanceFromClick, 0.0);
        float trailDistanceFade = 1.0 - smoothstep(0.12, max(uRadius * 0.82, 0.13), distanceBehindFront);
        float reveal = interior * trailDistanceFade * (1.0 - smoothstep(0.28, 0.94, t));
        float life = smoothstep(0.0, 0.055, t) * (1.0 - smoothstep(0.78, 1.0, t));
        float facing = 0.65 + 0.35 * abs(dot(normalize(vWorldNormal), normalize(cameraPosition - vWorldPosition)));

        float radarCoordinate = distanceFromClick / max(uGridSize * 1.75, 0.012);
        float radar = 1.0 - smoothstep(0.055, 0.13, abs(fract(radarCoordinate) - 0.5));
        float scanCoordinate = vWorldPosition.y / max(uGridSize * 0.78, 0.01);
        float dataScan = 1.0 - smoothstep(0.06, 0.15, abs(fract(scanCoordinate) - 0.5));
        float hologramScan = 0.5 + 0.5 * sin(vWorldPosition.y * 95.0 - uGlobalTime * 5.5);

        float pattern = grid;
        if (uStyle > 0.5 && uStyle < 1.5) pattern = max(radar, grid * 0.22);
        if (uStyle > 1.5 && uStyle < 2.5) pattern = max(dataScan, grid * 0.36);
        if (uStyle > 2.5) pattern = max(grid * 0.72, dataScan * hologramScan);

        float strength = pattern * (leadingLine * 1.72 + wave * 0.52 + reveal * 0.32) * life * facing;
        float colorPhase = clamp(t * 0.82 + distanceFromClick / max(uRadius, 0.01) * 0.18, 0.0, 1.0);
        vec3 customColor = mix(uLineColor, uWaveColor, smoothstep(0.0, 1.0, colorPhase));
        vec3 color = uGoogleColors > 0.5 ? googlePalette(colorPhase) : customColor;
        color = mix(color, vec3(1.0), leadingLine * 0.68);

        finalColor += color * strength * uGlow;
        alpha = max(alpha, strength);
      }

      if (alpha < 0.012) discard;
      gl_FragColor = vec4(finalColor, clamp(alpha, 0.0, 0.96));
    }
  `,
  transparent: true,
  depthWrite: false,
  depthTest: true,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
  toneMapped: false,
})

// Small square fragments released from the click point.
const MAX_FRAGMENTS = 180
const fragmentPositions = new Float32Array(MAX_FRAGMENTS * 3)
const fragmentColors = new Float32Array(MAX_FRAGMENTS * 3)
fragmentPositions.fill(999)
const fragmentGeometry = new THREE.BufferGeometry()
fragmentGeometry.setAttribute('position', new THREE.BufferAttribute(fragmentPositions, 3).setUsage(THREE.DynamicDrawUsage))
fragmentGeometry.setAttribute('color', new THREE.BufferAttribute(fragmentColors, 3).setUsage(THREE.DynamicDrawUsage))
const fragmentMaterial = new THREE.PointsMaterial({
  size: 0.038,
  vertexColors: true,
  transparent: true,
  opacity: 0.92,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  sizeAttenuation: true,
  toneMapped: false,
})
const fragmentCloud = new THREE.Points(fragmentGeometry, fragmentMaterial)
fragmentCloud.frustumCulled = false
fragmentCloud.renderOrder = 10
scene.add(fragmentCloud)

const fragmentStates = Array.from({ length: MAX_FRAGMENTS }, () => ({
  active: false,
  age: 0,
  duration: 1,
  velocity: new THREE.Vector3(),
  baseColor: new THREE.Color(),
}))
const fragmentPalette = [0x4285f4, 0xea4335, 0xfbbc05, 0x34a853].map((color) => new THREE.Color(color))
let nextFragment = 0

function spawnFragments(point, normal) {
  if (!params.fragments) return

  for (let count = 0; count < 24; count += 1) {
    const index = nextFragment % MAX_FRAGMENTS
    nextFragment += 1
    const state = fragmentStates[index]
    const randomDirection = new THREE.Vector3(
      THREE.MathUtils.randFloatSpread(1),
      THREE.MathUtils.randFloatSpread(1),
      THREE.MathUtils.randFloatSpread(1),
    ).normalize()
    const outward = THREE.MathUtils.randFloat(0.08, 0.26)
    const scatter = THREE.MathUtils.randFloat(0.05, 0.17)

    state.active = true
    state.age = 0
    state.duration = THREE.MathUtils.randFloat(0.6, 1.15)
    state.velocity.copy(normal).multiplyScalar(outward).addScaledVector(randomDirection, scatter)
    state.baseColor.copy(fragmentPalette[count % fragmentPalette.length])

    fragmentPositions[index * 3] = point.x + randomDirection.x * 0.025
    fragmentPositions[index * 3 + 1] = point.y + randomDirection.y * 0.025
    fragmentPositions[index * 3 + 2] = point.z + randomDirection.z * 0.025
    fragmentColors[index * 3] = state.baseColor.r
    fragmentColors[index * 3 + 1] = state.baseColor.g
    fragmentColors[index * 3 + 2] = state.baseColor.b
  }

  fragmentGeometry.attributes.position.needsUpdate = true
  fragmentGeometry.attributes.color.needsUpdate = true
}

function updateFragments(deltaTime) {
  let changed = false

  for (let index = 0; index < MAX_FRAGMENTS; index += 1) {
    const state = fragmentStates[index]
    if (!state.active) continue
    changed = true
    state.age += deltaTime
    const life = Math.max(0, 1 - state.age / state.duration)

    if (life <= 0) {
      state.active = false
      fragmentPositions[index * 3] = 999
      fragmentPositions[index * 3 + 1] = 999
      fragmentPositions[index * 3 + 2] = 999
      continue
    }

    fragmentPositions[index * 3] += state.velocity.x * deltaTime
    fragmentPositions[index * 3 + 1] += state.velocity.y * deltaTime
    fragmentPositions[index * 3 + 2] += state.velocity.z * deltaTime
    state.velocity.y -= 0.055 * deltaTime
    fragmentColors[index * 3] = state.baseColor.r * life
    fragmentColors[index * 3 + 1] = state.baseColor.g * life
    fragmentColors[index * 3 + 2] = state.baseColor.b * life
  }

  if (changed) {
    fragmentGeometry.attributes.position.needsUpdate = true
    fragmentGeometry.attributes.color.needsUpdate = true
  }
}

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const clickableMeshes = []
const pulses = Array.from({ length: MAX_PULSES }, () => ({ start: -100 }))
const pointerDown = new THREE.Vector2()
const defaultCameraPosition = new THREE.Vector3()
const defaultTarget = new THREE.Vector3()
let nextPulse = 0
let model = null
let dragging = false
let pointerPressed = false

function getHitWorldNormal(hit) {
  if (!hit.face) return new THREE.Vector3(0, 1, 0)
  return hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
}

function createPulse(point, meshId, normal) {
  const index = nextPulse % MAX_PULSES
  nextPulse += 1
  pulseUniforms.uPoints.value[index].copy(point)
  pulseUniforms.uMeshIds.value[index] = meshId
  pulses[index].start = performance.now() * 0.001
  pulseUniforms.uTimes.value[index] = 0
  spawnFragments(point, normal)
  document.body.classList.add('has-interacted')
}

function triggerRandomPulse() {
  if (!model) return
  for (let attempt = 0; attempt < 32; attempt += 1) {
    pointer.set(THREE.MathUtils.randFloat(-0.5, 0.5), THREE.MathUtils.randFloat(-0.36, 0.42))
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObjects(clickableMeshes, false)[0]
    if (hit) {
      createPulse(hit.point, hit.object.userData.effectMeshId, getHitWorldNormal(hit))
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
      if ('envMapIntensity' in material) material.envMapIntensity = 0.85
      if ('roughness' in material) material.roughness = Math.max(material.roughness ?? 0.5, 0.34)
    })
  })

  sourceMeshes.forEach((object, meshId) => {
    object.userData.effectMeshId = meshId
    const shellMaterial = gridEffectMaterial.clone()
    Object.keys(pulseUniforms).forEach((uniformName) => {
      shellMaterial.uniforms[uniformName] = pulseUniforms[uniformName]
    })
    shellMaterial.uniforms.uCurrentMeshId = { value: meshId }

    const gridShell = new THREE.Mesh(object.geometry, shellMaterial)
    gridShell.name = `${object.name || 'mesh'}-grid-pulse`
    gridShell.frustumCulled = false
    gridShell.renderOrder = 6
    gridShell.raycast = () => {}
    object.add(gridShell)
  })
}

function placeAndFrameModel(root) {
  const getVisibleBounds = () => {
    root.updateMatrixWorld(true)
    const bounds = new THREE.Box3()
    root.traverse((object) => {
      if (object.isMesh && object.visible && !object.name.endsWith('-grid-pulse')) {
        bounds.expandByObject(object, true)
      }
    })
    return bounds
  }

  root.updateMatrixWorld(true)
  const initialBox = getVisibleBounds()
  const initialSize = initialBox.getSize(new THREE.Vector3())
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

  contactShadow.scale.set(
    Math.max(0.75, size.x / 3.7),
    Math.max(0.75, size.z / 3.7),
    1,
  )
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

    loaderElement.style.setProperty('--progress', 1)
    loaderElement.classList.add('is-hidden')
    setTimeout(() => loaderElement.remove(), 850)
  },
  (event) => {
    if (!event.total) return
    loaderElement.style.setProperty('--progress', Math.min(1, event.loaded / event.total))
  },
  (error) => {
    console.error('Unable to load /google.glb', error)
    loaderElement.querySelector('p').textContent = 'Could not load google.glb'
    loaderElement.classList.add('has-error')
  },
)

function updatePointer(event) {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerDown.set(event.clientX, event.clientY)
  pointerPressed = true
  dragging = false
  renderer.domElement.classList.add('is-dragging')
})

renderer.domElement.addEventListener('pointermove', (event) => {
  if (pointerPressed && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) dragging = true

  if (!model) return
  updatePointer(event)
  raycaster.setFromCamera(pointer, camera)
  const overObject = raycaster.intersectObjects(clickableMeshes, false).length > 0
  renderer.domElement.classList.toggle('is-over-object', overObject)
})

renderer.domElement.addEventListener('pointerleave', () => {
  renderer.domElement.classList.remove('is-over-object')
})

renderer.domElement.addEventListener('pointerup', (event) => {
  pointerPressed = false
  renderer.domElement.classList.remove('is-dragging')
  if (!model || dragging) return
  updatePointer(event)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects(clickableMeshes, false)[0]
  if (hit) createPulse(hit.point, hit.object.userData.effectMeshId, getHitWorldNormal(hit))
})

renderer.domElement.addEventListener('pointercancel', () => {
  pointerPressed = false
  dragging = false
  renderer.domElement.classList.remove('is-dragging')
})

const gui = new GUI({ title: 'Effect Controls', width: 248 })
gui.domElement.classList.add('effect-gui')
const effectStyles = { Grid: 0, Radar: 1, 'Data Scan': 2, Hologram: 3 }
gui.add(params, 'effectStyle', Object.keys(effectStyles)).name('Pulse style').onChange((value) => { pulseUniforms.uStyle.value = effectStyles[value] })
gui.add(params, 'surfaceLock').name('Surface lock').onChange((value) => { pulseUniforms.uSurfaceLock.value = value ? 1 : 0 })
gui.add(params, 'googleColors').name('Google colors').onChange((value) => { pulseUniforms.uGoogleColors.value = value ? 1 : 0 })
gui.add(params, 'fragments').name('Grid fragments')
gui.add(params, 'gridSize', 0.018, 0.14, 0.001).name('Grid size').onChange((value) => { pulseUniforms.uGridSize.value = value })
gui.add(params, 'lineWidth', 0.4, 2.8, 0.05).name('Line width').onChange((value) => { pulseUniforms.uLineWidth.value = value })
gui.add(params, 'spread', 0.25, 2.2, 0.01).name('Spread').onChange((value) => { pulseUniforms.uRadius.value = value })
gui.add(params, 'duration', 0.55, 3, 0.05).name('Duration')
gui.add(params, 'glow', 0.15, 3, 0.01).name('Glow').onChange((value) => { pulseUniforms.uGlow.value = value })
gui.add(params, 'displacement', 0, 0.08, 0.001).name('Surface lift').onChange((value) => { pulseUniforms.uDisplacement.value = value })
gui.addColor(params, 'lineColor').name('Grid color').onChange((value) => { pulseUniforms.uLineColor.value.set(value) })
gui.addColor(params, 'waveColor').name('Wave color').onChange((value) => { pulseUniforms.uWaveColor.value.set(value) })
gui.add(params, 'bloom', 0, 1.3, 0.01).name('Bloom').onChange((value) => { bloom.strength = value })
gui.add(params, 'exposure', 0.65, 1.4, 0.01).name('Exposure').onChange((value) => { renderer.toneMappingExposure = value })
gui.add(params, 'autoRotate').name('Auto rotate')
gui.add(params, 'rotationSpeed', 0.05, 1.5, 0.05).name('Rotate speed')
gui.add(params, 'trigger').name('Trigger grid pulse')
gui.add(params, 'resetCamera').name('Reset camera')
gui.close()

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  composer.setSize(window.innerWidth, window.innerHeight)
})

let previousFrameTime = performance.now() * 0.001
function animate() {
  requestAnimationFrame(animate)
  const now = performance.now() * 0.001
  const deltaTime = Math.min(0.05, Math.max(0, now - previousFrameTime))
  previousFrameTime = now

  for (let i = 0; i < MAX_PULSES; i += 1) {
    const normalized = (now - pulses[i].start) / params.duration
    pulseUniforms.uTimes.value[i] = normalized >= 0 && normalized <= 1 ? normalized : -1
  }

  controls.autoRotate = params.autoRotate && !dragging
  controls.autoRotateSpeed = params.rotationSpeed
  nightSky.position.copy(camera.position)
  skyUniforms.uTime.value = now
  pulseUniforms.uGlobalTime.value = now
  updateFragments(deltaTime)
  controls.update()
  composer.render()
}

animate()
