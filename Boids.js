import * as THREE from 'three/webgpu'
import {
  Fn,
  If,
  Loop,
  Continue,
  float,
  uint,
  vec3,
  uniform,
  instancedArray,
  instanceIndex,
  cos,
  normalize,
  length,
  dot,
  select,
  attribute,
  positionLocal,
} from 'three/tsl'

export class Boids {
  // Private uniforms
  #separationU
  #alignmentU
  #cohesionU
  #dtU
  #rayOriginU
  #rayDirectionU
  #obstacleCenterU
  #obstacleRadiusU
  #colliderAttractionU
  #fishScaleU
  #tailSpeedU
  #fishColorU
  #speedMultiplierU

  // Private
  #renderer
  #count
  #speedLimit
  #positionStorage
  #velocityStorage
  #phaseStorage
  #computeVelocity
  #computePosition
  #colliderMesh

  // Public
  mesh
  material

  constructor(renderer, settings = {}) {
    this.#renderer = renderer
    this.#count = settings.count ?? 4096
    this.#speedLimit = settings.speedLimit ?? 9.0
    this.#colliderMesh = settings.colliderMesh ?? null

    // Determine spawn bounds from box mesh or fallback
    let spawnMin = new THREE.Vector3(-400, -400, -400)
    let spawnMax = new THREE.Vector3(400, 400, 400)

    if (settings.spawnBox) {
      const box = new THREE.Box3().setFromObject(settings.spawnBox)
      spawnMin = box.min
      spawnMax = box.max
    }

    const spawnSize = new THREE.Vector3().subVectors(spawnMax, spawnMin)

    // Storage buffers
    const positionArray = new Float32Array(this.#count * 3)
    const velocityArray = new Float32Array(this.#count * 3)
    const phaseArray = new Float32Array(this.#count)

    for (let i = 0; i < this.#count; i++) {
      positionArray[i * 3 + 0] = Math.random() * spawnSize.x + spawnMin.x
      positionArray[i * 3 + 1] = Math.random() * spawnSize.y + spawnMin.y
      positionArray[i * 3 + 2] = Math.random() * spawnSize.z + spawnMin.z

      velocityArray[i * 3 + 0] = (Math.random() - 0.5) * 10
      velocityArray[i * 3 + 1] = (Math.random() - 0.5) * 10
      velocityArray[i * 3 + 2] = (Math.random() - 0.5) * 10

      phaseArray[i] = 1
    }

    this.#positionStorage = instancedArray(positionArray, 'vec3')
    this.#velocityStorage = instancedArray(velocityArray, 'vec3')
    this.#phaseStorage = instancedArray(phaseArray, 'float')

    // Uniforms
    this.#separationU = uniform(settings.separation ?? 15.0)
    this.#alignmentU = uniform(settings.alignment ?? 20.0)
    this.#cohesionU = uniform(settings.cohesion ?? 20.0)
    this.#dtU = uniform(0.0)
    this.#rayOriginU = uniform(new THREE.Vector3())
    this.#rayDirectionU = uniform(new THREE.Vector3())
    this.#obstacleCenterU = uniform(new THREE.Vector3())
    this.#obstacleRadiusU = uniform(settings.obstacleRadius ?? 60.0)
    this.#colliderAttractionU = uniform(settings.colliderAttraction ?? 3.0)
    this.#fishScaleU = uniform(settings.fishScale ?? 1.2)
    this.#tailSpeedU = uniform(settings.tailSpeed ?? 7)
    this.#fishColorU = uniform(new THREE.Color(settings.fishColor ?? '#1a0f0a'))
    this.#speedMultiplierU = uniform(settings.speedMultiplier ?? 9.0)
  }

  // ─── Getters/Setters ────────────────────────────────────────────────────────

  get separation() {
    return this.#separationU.value
  }
  set separation(v) {
    this.#separationU.value = v
  }

  get alignment() {
    return this.#alignmentU.value
  }
  set alignment(v) {
    this.#alignmentU.value = v
  }

  get cohesion() {
    return this.#cohesionU.value
  }
  set cohesion(v) {
    this.#cohesionU.value = v
  }

  get colliderAttraction() {
    return this.#colliderAttractionU.value
  }
  set colliderAttraction(v) {
    this.#colliderAttractionU.value = v
  }

  get obstacleRadius() {
    return this.#obstacleRadiusU.value
  }
  set obstacleRadius(v) {
    this.#obstacleRadiusU.value = v
  }

  get fishScale() {
    return this.#fishScaleU.value
  }
  set fishScale(v) {
    this.#fishScaleU.value = v
  }

  get tailSpeed() {
    return this.#tailSpeedU.value
  }
  set tailSpeed(v) {
    this.#tailSpeedU.value = v
  }

  get fishColor() {
    return '#' + this.#fishColorU.value.getHexString()
  }
  set fishColor(v) {
    this.#fishColorU.value.set(v)
  }

  get speedMultiplier() {
    return this.#speedMultiplierU.value
  }
  set speedMultiplier(v) {
    this.#speedMultiplierU.value = v
  }

  get count() {
    return this.#count
  }

  get colliderMesh() {
    return this.#colliderMesh
  }
  set colliderMesh(v) {
    this.#colliderMesh = v
  }

  get rayOrigin() {
    return this.#rayOriginU.value
  }
  get rayDirection() {
    return this.#rayDirectionU.value
  }

  // ─── Initialization ─────────────────────────────────────────────────────────

  init() {
    this.#createComputeVelocity()
    this.#createComputePosition()
    this.#createMaterial()
    this.#createMesh()
    return this
  }

  // ─── Update ─────────────────────────────────────────────────────────────────

  update(delta) {
    if (delta > 1) delta = 1
    this.#dtU.value = delta

    // Sync collider mesh position/scale into uniforms
    if (this.#colliderMesh) {
      this.#colliderMesh.updateWorldMatrix(true, false)
      this.#obstacleCenterU.value.setFromMatrixPosition(this.#colliderMesh.matrixWorld)
      this.#obstacleRadiusU.value = this.#colliderMesh.matrixWorld.getMaxScaleOnAxis()
    }

    this.#renderer.compute(this.#computeVelocity)
    this.#renderer.compute(this.#computePosition)
  }

  // ─── Sparrow Geometry ────────────────────────────────────────────────────────

  #createSparrowGeometry() {
    const geo = new THREE.BufferGeometry()

    // Sparrow: Egg-like body + wings in XZ plane
    // Swims/Flies along +Z
    const verts = []
    const wingFlags = [] // 0 = body, 1 = wing tips

    // 1. Egg-like body
    const bodySegments = 8
    const bodyRings = 6
    for (let r = 0; r < bodyRings; r++) {
      const phi = (r / (bodyRings - 1)) * Math.PI
      const nextPhi = ((r + 1) / (bodyRings - 1)) * Math.PI
      
      const z = Math.cos(phi) * 8
      const nextZ = Math.cos(nextPhi) * 8
      const radius = Math.sin(phi) * 4
      const nextRadius = Math.sin(nextPhi) * 4

      for (let s = 0; s < bodySegments; s++) {
        const theta = (s / bodySegments) * Math.PI * 2
        const nextTheta = ((s + 1) / bodySegments) * Math.PI * 2

        const x1 = Math.cos(theta) * radius
        const y1 = Math.sin(theta) * radius
        const x2 = Math.cos(nextTheta) * radius
        const y2 = Math.sin(nextTheta) * radius

        const nx1 = Math.cos(theta) * nextRadius
        const ny1 = Math.sin(theta) * nextRadius
        const nx2 = Math.cos(nextTheta) * nextRadius
        const ny2 = Math.sin(nextTheta) * nextRadius

        // Quad logic
        verts.push(x1, y1, z, nx1, ny1, nextZ, nx2, ny2, nextZ)
        verts.push(x1, y1, z, nx2, ny2, nextZ, x2, y2, z)
        for(let i=0; i<6; i++) wingFlags.push(0)
      }
    }

    // 2. Wings (Triangular planes)
    // Left Wing
    verts.push(0, 0, 2,  -15, 0, -5,  0, 0, -4)
    wingFlags.push(0, 1, 0.2)
    // Right Wing
    verts.push(0, 0, 2,  15, 0, -5,  0, 0, -4)
    wingFlags.push(0, 1, 0.2)

    const vertices = new Float32Array(verts)
    for (let i = 0; i < vertices.length; i++) {
        vertices[i] *= 0.25 // scale down
    }

    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    geo.setAttribute('wingFlag', new THREE.BufferAttribute(new Float32Array(wingFlags), 1))

    return geo
  }

  // ─── Material ───────────────────────────────────────────────────────────────

  #createMaterial() {
    this.material = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
    })

    const positionStorage = this.#positionStorage
    const velocityStorage = this.#velocityStorage
    const phaseStorage = this.#phaseStorage
    const fishScaleU = this.#fishScaleU
    const fishColorU = this.#fishColorU

    // Vertex shader: position + orient + WING FLAP
    this.material.positionNode = Fn(() => {
      const birdPos = positionStorage.element(instanceIndex)
      const birdVel = velocityStorage.element(instanceIndex)
      const phase = phaseStorage.element(instanceIndex)

      const pos = positionLocal.toVar()

      // Wing flap (rotate around Z axis)
      const wingFlag = attribute('wingFlag', 'float')
      const flapAngle = phase.sin().mul(wingFlag).mul(0.8)
      
      const cosA = cos(flapAngle)
      const sinA = flapAngle.sin()
      
      // Pivot around Z-axis (up/down flapping)
      const newX = pos.x.mul(cosA).sub(pos.y.mul(sinA))
      const newY = pos.x.mul(sinA).add(pos.y.mul(cosA))
      pos.x.assign(newX)
      pos.y.assign(newY)

      // Scale
      pos.mulAssign(fishScaleU)

      // Orient along velocity
      const dir = normalize(birdVel)
      const right = normalize(dir.cross(vec3(0, 1, 0)))
      const up = normalize(right.cross(dir))

      const worldPos = vec3(right.mul(pos.x).add(up.mul(pos.y)).add(dir.mul(pos.z)))

      return worldPos.add(birdPos)
    })()

    this.material.colorNode = fishColorU
  }

  // ─── Mesh ───────────────────────────────────────────────────────────────────

  #createMesh() {
    const sparrowGeo = this.#createSparrowGeometry()
    this.mesh = new THREE.InstancedMesh(sparrowGeo, this.material, this.#count)
  }


  // ─── Compute Velocity ───────────────────────────────────────────────────────

  #createComputeVelocity() {
    const count = this.#count
    const speedLimit = this.#speedLimit
    const positionStorage = this.#positionStorage
    const velocityStorage = this.#velocityStorage
    const separationU = this.#separationU
    const alignmentU = this.#alignmentU
    const cohesionU = this.#cohesionU
    const dtU = this.#dtU
    const rayOriginU = this.#rayOriginU
    const rayDirectionU = this.#rayDirectionU
    const obstacleCenterU = this.#obstacleCenterU
    const obstacleRadiusU = this.#obstacleRadiusU
    const colliderAttractionU = this.#colliderAttractionU

    this.#computeVelocity = Fn(() => {
      const PI_2 = float(Math.PI * 2)
      const limit = float(speedLimit).toVar('limit')

      const zoneRadius = separationU.add(alignmentU).add(cohesionU).toConst()
      const separationThresh = separationU.div(zoneRadius).toConst()
      const alignmentThresh = separationU.add(alignmentU).div(zoneRadius).toConst()
      const zoneRadiusSq = zoneRadius.mul(zoneRadius).toConst()

      const birdIndex = instanceIndex.toConst('birdIndex')
      const position = positionStorage.element(birdIndex).toVar()
      const velocity = velocityStorage.element(birdIndex).toVar()

      // Mouse / ray influence
      const directionToRay = rayOriginU.sub(position).toConst()
      const projectionLength = dot(directionToRay, rayDirectionU).toConst()
      const closestPoint = rayOriginU.sub(rayDirectionU.mul(projectionLength)).toConst()
      const dirToClosest = closestPoint.sub(position).toConst()
      const distToClosestSq = dot(dirToClosest, dirToClosest).toConst()

      const rayRadius = float(150.0).toConst()
      const rayRadiusSq = rayRadius.mul(rayRadius).toConst()

      If(distToClosestSq.lessThan(rayRadiusSq), () => {
        const velocityAdjust = distToClosestSq.div(rayRadiusSq).sub(1.0).mul(dtU).mul(100.0)
        velocity.addAssign(normalize(dirToClosest).mul(velocityAdjust))
        limit.addAssign(5.0)
      })

      // Attract to center
      const dirToCenter = position.toVar()
      dirToCenter.y.mulAssign(2.5)
      velocity.subAssign(normalize(dirToCenter).mul(dtU).mul(5.0))

      // Attraction to obstacle
      const toObstacle = position.sub(obstacleCenterU)
      const distToObstacle = length(toObstacle)
      velocity.subAssign(normalize(toObstacle).mul(dtU).mul(colliderAttractionU))

      // Obstacle avoidance
      const avoidRadius = obstacleRadiusU.mul(1.8) // start avoiding before hitting
      If(distToObstacle.lessThan(avoidRadius), () => {
        const pushStrength = avoidRadius.div(distToObstacle.max(0.001)).sub(1.0).mul(dtU).mul(80.0)
        velocity.addAssign(normalize(toObstacle).mul(pushStrength))
      })

      // Boid rules: separation, alignment, cohesion
      Loop({ start: uint(0), end: uint(count), type: 'uint', condition: '<' }, ({ i }) => {
        If(i.equal(birdIndex), () => {
          Continue()
        })

        const birdPosition = positionStorage.element(i)
        const dirToBird = birdPosition.sub(position)
        const distToBird = length(dirToBird)

        If(distToBird.lessThan(0.0001), () => {
          Continue()
        })

        const distToBirdSq = distToBird.mul(distToBird)

        If(distToBirdSq.greaterThan(zoneRadiusSq), () => {
          Continue()
        })

        const percent = distToBirdSq.div(zoneRadiusSq)

        If(percent.lessThan(separationThresh), () => {
          // Separation: steer away from close neighbors
          const velocityAdjust = separationThresh.div(percent).sub(1.0).mul(dtU)
          velocity.subAssign(normalize(dirToBird).mul(velocityAdjust))
        })
          .ElseIf(percent.lessThan(alignmentThresh), () => {
            // Alignment: match velocity of nearby birds
            const threshDelta = alignmentThresh.sub(separationThresh)
            const adjustedPercent = percent.sub(separationThresh).div(threshDelta)
            const birdVelocity = velocityStorage.element(i)
            const cosRange = cos(adjustedPercent.mul(PI_2))
            const cosRangeAdjust = float(0.5).sub(cosRange.mul(0.5)).add(0.5)
            const velocityAdjust = cosRangeAdjust.mul(dtU)
            velocity.addAssign(normalize(birdVelocity).mul(velocityAdjust))
          })
          .Else(() => {
            // Cohesion: steer toward center of nearby flock
            const threshDelta = alignmentThresh.oneMinus()
            const adjustedPercent = select(
              threshDelta.equal(0.0),
              1.0,
              percent.sub(alignmentThresh).div(threshDelta),
            )
            const cosRange = cos(adjustedPercent.mul(PI_2))
            const velocityAdjust = float(0.5).sub(cosRange.mul(-0.5).add(0.5)).mul(dtU)
            velocity.addAssign(normalize(dirToBird).mul(velocityAdjust))
          })
      })

      // Speed limit
      If(length(velocity).greaterThan(limit), () => {
        velocity.assign(normalize(velocity).mul(limit))
      })

      velocityStorage.element(birdIndex).assign(velocity)
    })().compute(count)
  }

  // ─── Compute Position ───────────────────────────────────────────────────────

  #createComputePosition() {
    const count = this.#count
    const positionStorage = this.#positionStorage
    const velocityStorage = this.#velocityStorage
    const phaseStorage = this.#phaseStorage
    const dtU = this.#dtU
    const speedMultiplierU = this.#speedMultiplierU
    const tailSpeedU = this.#tailSpeedU

    this.#computePosition = Fn(() => {
      positionStorage
        .element(instanceIndex)
        .addAssign(velocityStorage.element(instanceIndex).mul(dtU).mul(speedMultiplierU))

      // Tail wag phase (based on speed)
      const velocity = velocityStorage.element(instanceIndex)
      const phase = phaseStorage.element(instanceIndex)

      const modValue = phase
        .add(dtU.mul(tailSpeedU))
        .add(length(velocity).mul(dtU).mul(tailSpeedU).mul(0.5))

      phaseStorage.element(instanceIndex).assign(modValue.mod(62.83))
    })().compute(count)
  }
}
