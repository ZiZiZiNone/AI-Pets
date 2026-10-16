import * as PIXI from 'pixi.js';
import { Spine } from 'pixi-spine';
import {
  type HitTestResult,
  type IPetAdapter,
  matchDeclaredHitArea,
  resolvePetAssetUrl,
} from './IPetAdapter';
import type { PetManifest } from '@/types/pet';

export class SpineAdapter implements IPetAdapter {
  public readonly canvasType = '2d' as const;

  private app: PIXI.Application | null = null;
  private spine: Spine | null = null;
  private manifest: PetManifest | null = null;
  private mouthOpenValue = 0;
  private baseScale = 1.0;
  private baseOffset = { x: 0, y: 0 };

  public async load(manifest: PetManifest, canvas: HTMLCanvasElement): Promise<void> {
    this.dispose();
    this.manifest = manifest;
    this.baseScale = manifest.model.scale || 1.0;
    this.baseOffset = {
      x: manifest.model.offset?.x || 0,
      y: manifest.model.offset?.y || 0,
    };

    const width = canvas.clientWidth || 360;
    const height = canvas.clientHeight || 420;
    const useHighDpi = canvas.dataset.highDpi !== '0';

    this.app = new PIXI.Application({
      view: canvas,
      width,
      height,
      backgroundAlpha: 0,
      antialias: true,
      autoStart: false,
      resolution: useHighDpi ? window.devicePixelRatio || 1 : 1,
      autoDensity: true,
    });

    const entryUrl = await resolvePetAssetUrl(manifest, manifest.model.entry);
    const resource = await PIXI.Assets.load(entryUrl);

    if (resource && resource.spineData) {
      this.spine = new Spine(resource.spineData);
      this.spine.stateData.defaultMix = 0.25;
      this.spine.autoUpdate = false;
      this.app.stage.addChild(this.spine as unknown as PIXI.DisplayObject);
      this.applyTransform(this.baseScale, this.baseOffset.x, this.baseOffset.y);
      this.playMotion('idle');
    }
  }

  public playMotion(motionName: string): void {
    if (!this.spine) return;
    const anims = this.spine.spineData.animations;
    if (!anims || anims.length === 0) return;

    const matched =
      anims.find((a) => a.name.toLowerCase() === motionName.toLowerCase()) ||
      anims.find((a) => a.name.toLowerCase().includes(motionName.toLowerCase())) ||
      anims[0];

    if (matched) {
      const isLoop =
        motionName === 'idle' ||
        motionName === 'sleep' ||
        motionName === 'climb' ||
        this.manifest?.model.animations?.[motionName]?.loop === true;
      this.spine.state.setAnimation(0, matched.name, isLoop);
    }
  }

  public setExpression(expressionName: string): void {
    if (!this.spine) return;
    const targetSkin = this.spine.spineData.skins?.find(
      (s) => s.name.toLowerCase() === expressionName.toLowerCase()
    );
    if (targetSkin) {
      this.spine.skeleton.setSkin(targetSkin);
      this.spine.skeleton.setSlotsToSetupPose();
    }
  }

  public setMouthOpen(value: number): void {
    this.mouthOpenValue = Math.min(1.0, Math.max(0.0, value));
  }

  public lookAt(x: number, _y: number): void {
    if (!this.spine || !this.app) return;
    const headBone =
      this.spine.skeleton.findBone('head') || this.spine.skeleton.findBone('Head');
    if (headBone) {
      const nx = (x - this.app.screen.width * 0.5) / 180;
      headBone.rotation = Math.max(-15, Math.min(15, nx * 10));
    }
  }

  public applyTransform(scale: number, offsetX: number, offsetY: number): void {
    this.baseScale = scale;
    this.baseOffset = { x: offsetX, y: offsetY };
    if (!this.spine || !this.app) return;

    this.spine.scale.set(scale, scale);
    this.spine.x = this.app.screen.width * 0.5 + offsetX;
    this.spine.y = this.app.screen.height * 0.82 + offsetY;
  }

  public hitTest(x: number, y: number): HitTestResult {
    if (!this.spine || !this.app) return { hit: false };

    const bounds = (this.spine as unknown as PIXI.DisplayObject).getBounds();
    if (!bounds.contains(x, y)) return { hit: false };

    return {
      hit: true,
      area: matchDeclaredHitArea(
        this.manifest,
        x,
        y,
        this.app.screen.width,
        this.app.screen.height
      ),
    };
  }

  public renderFrame(deltaSec: number): void {
    if (!this.app || !this.spine) return;
    this.spine.update(deltaSec);

    const jawBone =
      this.spine.skeleton.findBone('jaw') || this.spine.skeleton.findBone('mouth');
    if (jawBone && this.mouthOpenValue > 0.02) {
      jawBone.scaleY = 1.0 + this.mouthOpenValue * 0.5;
    }

    this.app.renderer.render(this.app.stage);
  }

  public dispose(): void {
    if (this.spine) {
      this.spine.destroy({ children: true, texture: true, baseTexture: true });
      this.spine = null;
    }
    if (this.app) {
      this.app.destroy(false, { children: true, texture: true, baseTexture: true });
      this.app = null;
    }
  }
}
