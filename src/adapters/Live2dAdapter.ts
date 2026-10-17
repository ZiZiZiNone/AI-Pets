import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display-lipsyncpatch';
import {
  type HitTestResult,
  type IPetAdapter,
  matchDeclaredHitArea,
  resolvePetAssetUrl,
} from './IPetAdapter';
import type { PetManifest } from '@/types/pet';

Live2DModel.registerTicker(PIXI.Ticker);

export class Live2dAdapter implements IPetAdapter {
  public readonly canvasType = '2d' as const;

  private app: PIXI.Application | null = null;
  private model: Live2DModel | null = null;
  private manifest: PetManifest | null = null;
  private mouthOpenValue = 0;
  private mouthFormValue = 0;
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

    const modelUrl = await resolvePetAssetUrl(manifest, manifest.model.entry);
    this.model = await Live2DModel.from(modelUrl, {
      autoInteract: false,
      autoUpdate: false,
    });

    this.model.anchor.set(0.5, 0.5);
    this.app.stage.addChild(this.model as unknown as PIXI.DisplayObject);
    this.applyTransform(this.baseScale, this.baseOffset.x, this.baseOffset.y);
  }

  public playMotion(motionName: string): void {
    if (!this.model) return;
    try {
      void this.model.motion(motionName);
    } catch {
      void this.model.motion('Idle');
    }
  }

  public setExpression(expressionName: string): void {
    if (!this.model) return;
    try {
      void this.model.expression(expressionName);
    } catch {
      // Optional model expression
    }
  }

  public setMouthOpen(value: number, formX = 0): void {
    this.mouthOpenValue = Math.min(1.0, Math.max(0.0, value));
    this.mouthFormValue = Math.min(1.0, Math.max(-1.0, formX));
  }

  public lookAt(x: number, y: number): void {
    this.model?.focus(x, y);
  }

  public applyTransform(scale: number, offsetX: number, offsetY: number): void {
    this.baseScale = scale;
    this.baseOffset = { x: offsetX, y: offsetY };
    if (!this.model || !this.app) return;

    const fitScale =
      Math.min(
        this.app.screen.width / Math.max(1, this.model.internalModel?.width || 400),
        this.app.screen.height / Math.max(1, this.model.internalModel?.height || 400)
      ) *
      0.85 *
      scale;

    this.model.scale.set(fitScale, fitScale);
    this.model.x = this.app.screen.width * 0.5 + offsetX;
    this.model.y = this.app.screen.height * 0.5 + offsetY;
  }

  public hitTest(x: number, y: number): HitTestResult {
    if (!this.model || !this.app) return { hit: false };

    try {
      const hitNames = this.model.hitTest(x, y);
      if (hitNames && hitNames.length > 0) {
        const hitName = hitNames[0].toLowerCase();
        const declared = this.manifest?.hit_areas?.find(
          (a) =>
            a.name.toLowerCase() === hitName || hitName.includes(a.name.toLowerCase())
        );
        return {
          hit: true,
          area:
            declared || {
              name: hitNames[0],
              label: hitNames[0],
              rect: { x: 0, y: 0, w: 100, h: 100 },
              motion: 'TapBody',
            },
        };
      }
    } catch {
      // Fallback to YAML hit_areas
    }

    const area = matchDeclaredHitArea(
      this.manifest,
      x,
      y,
      this.app.screen.width,
      this.app.screen.height
    );
    if (area) return { hit: true, area };

    const bounds = (this.model as unknown as PIXI.DisplayObject).getBounds();
    return { hit: bounds.contains(x, y) };
  }

  public renderFrame(deltaSec: number): void {
    if (!this.app || !this.model) return;
    this.model.update(deltaSec * 1000);

    const coreModel = this.model.internalModel?.coreModel as
      | {
          setParameterValueById?: (id: string, value: number) => void;
          setParamFloat?: (id: string, value: number) => void;
        }
      | undefined;

    if (coreModel) {
      if (typeof coreModel.setParameterValueById === 'function') {
        coreModel.setParameterValueById('ParamMouthOpenY', this.mouthOpenValue);
        coreModel.setParameterValueById('ParamMouthForm', this.mouthFormValue);
      } else if (typeof coreModel.setParamFloat === 'function') {
        coreModel.setParamFloat('PARAM_MOUTH_OPEN_Y', this.mouthOpenValue);
        coreModel.setParamFloat('PARAM_MOUTH_FORM', this.mouthFormValue);
      }
    }

    this.app.renderer.render(this.app.stage);
  }

  public dispose(): void {
    if (this.model) {
      this.model.destroy({ children: true, texture: true, baseTexture: true });
      this.model = null;
    }
    if (this.app) {
      this.app.destroy(false, { children: true, texture: true, baseTexture: true });
      this.app = null;
    }
  }
}
