import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  createVRMAnimationClip,
  VRMAnimation,
  VRMAnimationLoaderPlugin,
} from '@pixiv/three-vrm-animation';
import {
  type HitTestResult,
  type IPetAdapter,
  matchDeclaredHitArea,
  resolvePetAssetUrl,
} from './IPetAdapter';
import type { PetManifest } from '@/types/pet';

export class VrmAdapter implements IPetAdapter {
  public readonly canvasType = '3d' as const;

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private vrm: VRM | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private currentAction: THREE.AnimationAction | null = null;
  private clipCache: Map<string, THREE.AnimationClip> = new Map();
  private lookAtTarget: THREE.Object3D = new THREE.Object3D();
  private raycaster: THREE.Raycaster = new THREE.Raycaster();
  private pointerNDC: THREE.Vector2 = new THREE.Vector2();

  private manifest: PetManifest | null = null;
  private canvasWidth = 360;
  private canvasHeight = 420;
  private baseScale = 1.0;
  private baseOffset = { x: 0, y: 0 };
  private mouthOpenValue = 0;
  private elapsedTime = 0;

  public async load(manifest: PetManifest, canvas: HTMLCanvasElement): Promise<void> {
    this.dispose();
    this.manifest = manifest;
    this.baseScale = manifest.model.scale || 1.0;
    this.baseOffset = {
      x: manifest.model.offset?.x || 0,
      y: manifest.model.offset?.y || 0,
    };

    this.canvasWidth = canvas.clientWidth || 360;
    this.canvasHeight = canvas.clientHeight || 420;
    const useHighDpi = canvas.dataset.highDpi !== '0';

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(this.canvasWidth, this.canvasHeight, false);
    this.renderer.setPixelRatio(
      useHighDpi ? Math.min(2, window.devicePixelRatio || 1) : 1
    );
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      30.0,
      this.canvasWidth / this.canvasHeight,
      0.1,
      20.0
    );
    this.camera.position.set(0.0, 1.15, 2.85);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.15);
    dirLight.position.set(1.2, 2.0, 1.8);
    this.scene.add(ambientLight, dirLight, this.lookAtTarget);
    this.lookAtTarget.position.set(0, 1.25, 2.5);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    const vrmUrl = await resolvePetAssetUrl(manifest, manifest.model.entry);
    const gltf = await loader.loadAsync(vrmUrl);
    const loadedVrm = gltf.userData.vrm as VRM | undefined;

    if (loadedVrm) {
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.removeUnnecessaryJoints(gltf.scene);
      VRMUtils.rotateVRM0(loadedVrm);

      this.vrm = loadedVrm;
      this.vrm.scene.traverse((obj) => {
        obj.frustumCulled = false;
      });
      if (this.vrm.lookAt) this.vrm.lookAt.target = this.lookAtTarget;

      this.scene.add(this.vrm.scene);
      this.mixer = new THREE.AnimationMixer(this.vrm.scene);
      await this.preloadVrmaAnimations(loader, manifest);
    } else {
      this.scene.add(gltf.scene);
      this.mixer = new THREE.AnimationMixer(gltf.scene);
    }

    this.applyTransform(this.baseScale, this.baseOffset.x, this.baseOffset.y);
    this.playMotion('idle');
    this.renderFrame(0.016);
  }

  private async preloadVrmaAnimations(
    loader: GLTFLoader,
    manifest: PetManifest
  ): Promise<void> {
    if (!this.vrm || !manifest.model.animations) return;

    for (const [motionName, clipDef] of Object.entries(manifest.model.animations)) {
      if (clipDef.file && clipDef.file.toLowerCase().endsWith('.vrma')) {
        try {
          const animUrl = await resolvePetAssetUrl(manifest, clipDef.file);
          const animGltf = await loader.loadAsync(animUrl);
          const vrmAnimations = animGltf.userData.vrmAnimations as VRMAnimation[] | undefined;
          if (vrmAnimations && vrmAnimations.length > 0) {
            this.clipCache.set(motionName, createVRMAnimationClip(vrmAnimations[0], this.vrm));
          }
        } catch {
          // Skip invalid .vrma clip
        }
      }
    }
  }

  public playMotion(motionName: string): void {
    if (!this.mixer) return;
    const clip = this.clipCache.get(motionName);
    if (!clip) return;

    const nextAction = this.mixer.clipAction(clip);
    const isLoop =
      motionName === 'idle' ||
      motionName === 'sleep' ||
      this.manifest?.model.animations?.[motionName]?.loop === true;

    nextAction.setLoop(
      isLoop ? THREE.LoopRepeat : THREE.LoopOnce,
      isLoop ? Infinity : 1
    );
    nextAction.clampWhenFinished = !isLoop;

    if (this.currentAction && this.currentAction !== nextAction) {
      this.currentAction.fadeOut(0.25);
    }
    nextAction.reset().fadeIn(0.25).play();
    this.currentAction = nextAction;
  }

  public setExpression(expressionName: string): void {
    const expMgr = this.vrm?.expressionManager;
    if (!expMgr) return;

    const presets = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'];
    for (const p of presets) expMgr.setValue(p, 0.0);

    const mapped =
      expressionName === 'smile'
        ? 'happy'
        : expressionName === 'sleepy'
        ? 'relaxed'
        : expressionName;

    if (presets.includes(mapped)) expMgr.setValue(mapped, 1.0);

    const customBlend = this.manifest?.expressions?.[expressionName]?.blendshape;
    if (customBlend) {
      for (const [k, v] of Object.entries(customBlend)) expMgr.setValue(k, v);
    }
  }

  public setMouthOpen(value: number): void {
    this.mouthOpenValue = Math.min(1.0, Math.max(0.0, value));
    this.vrm?.expressionManager?.setValue('aa', this.mouthOpenValue);
  }

  public lookAt(x: number, y: number): void {
    const nx = (x / Math.max(1, this.canvasWidth)) * 2 - 1;
    const ny = -(y / Math.max(1, this.canvasHeight)) * 2 + 1;
    this.lookAtTarget.position.set(nx * 1.2, 1.2 + ny * 0.6, 2.5);
  }

  public applyTransform(scale: number, offsetX: number, offsetY: number): void {
    this.baseScale = scale;
    this.baseOffset = { x: offsetX, y: offsetY };
    if (this.vrm) {
      this.vrm.scene.scale.setScalar(scale);
      this.vrm.scene.position.set(offsetX * 0.005, -offsetY * 0.005, 0);
    }
  }

  public hitTest(x: number, y: number): HitTestResult {
    if (!this.camera || !this.scene || !this.vrm) return { hit: false };

    this.pointerNDC.x = (x / Math.max(1, this.canvasWidth)) * 2 - 1;
    this.pointerNDC.y = -(y / Math.max(1, this.canvasHeight)) * 2 + 1;

    this.raycaster.setFromCamera(this.pointerNDC, this.camera);
    const intersects = this.raycaster.intersectObject(this.vrm.scene, true);
    if (intersects.length === 0) return { hit: false };

    const declaredArea = matchDeclaredHitArea(
      this.manifest,
      x,
      y,
      this.canvasWidth,
      this.canvasHeight
    );
    if (declaredArea) return { hit: true, area: declaredArea };

    if (intersects[0].point.y >= 1.25 && this.manifest?.hit_areas?.length) {
      const headArea = this.manifest.hit_areas.find((a) => a.name === 'head');
      if (headArea) return { hit: true, area: headArea };
    }

    return { hit: true, area: this.manifest?.hit_areas?.[0] };
  }

  public renderFrame(deltaSec: number): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    this.elapsedTime += deltaSec;
    this.mixer?.update(deltaSec);

    if (this.vrm) {
      if (!this.currentAction && this.vrm.humanoid) {
        const chest = this.vrm.humanoid.getNormalizedBoneNode('chest');
        if (chest) {
          chest.rotation.x = Math.sin(this.elapsedTime * 2.2) * 0.03;
          chest.rotation.z = Math.cos(this.elapsedTime * 1.5) * 0.015;
        }
      }
      this.vrm.expressionManager?.setValue('aa', this.mouthOpenValue);
      this.vrm.update(deltaSec);
    }

    this.renderer.render(this.scene, this.camera);
  }

  public dispose(): void {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.currentAction = null;
    this.clipCache.clear();

    if (this.scene) {
      this.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) m.dispose();
        }
      });
      this.scene.clear();
      this.scene = null;
    }

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer = null;
    }

    this.vrm = null;
    this.camera = null;
  }
}
