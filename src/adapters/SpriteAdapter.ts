import {
  type HitTestResult,
  type IPetAdapter,
  matchDeclaredHitArea,
  resolvePetAssetUrl,
} from './IPetAdapter';
import { resolvePetTheme } from '@/store/themes';
import { frameIndexAt, frameSourceRect } from '@/utils/frameStrip';
import { breathingScale, idleMotionFor, weightShift } from '@/utils/proceduralMotion';
import {
  ALPHA_MASK_ALPHA_THRESHOLD,
  ALPHA_MASK_REBUILD_FRAMES,
  ALPHA_MASK_SIZE,
  BOUNCE_DAMPING,
  BOUNCE_MIN_IMPACT_SPEED,
  BOUNCE_SPEED_DIVISOR,
  DEFAULT_GRAVITY_PX_S2,
  GRAVITY_MAX_PX_S2,
  GRAVITY_MIN_PX_S2,
  LOOK_SMOOTHING_PER_SEC,
  MAX_LANDING_SQUASH,
  SPRITE_CENTER_Y_RATIO,
  SPRITE_DRAW_HEIGHT_PX,
  SPRITE_DRAW_WIDTH_PX,
  SPRITE_FALLBACK_RADIUS_PX,
  SPRITE_GROUND_OFFSET_PX,
  SQUASH_DECAY_PER_SEC,
  STAGE_HEIGHT_PX,
  STAGE_WIDTH_PX,
} from '@/constants/timing';
import type { PetManifest } from '@/types/pet';

interface OrbitalParticle {
  angle: number;
  radius: number;
  speed: number;
  size: number;
  alpha: number;
  yOffset: number;
}

interface InteractionBurst {
  x: number;
  y: number;
  text: string;
  color: string;
  age: number;
  maxAge: number;
}

function numberTintToHex(tint?: number): string | null {
  if (typeof tint !== 'number' || tint === 0xffffff) return null;
  return `#${(tint & 0xffffff).toString(16).padStart(6, '0')}`;
}

export class SpriteAdapter implements IPetAdapter {
  public readonly canvasType = '2d' as const;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private img: HTMLImageElement | null = null;
  private loadedEntryFile = '';
  private manifest: PetManifest | null = null;

  private baseScale = 1.0;
  private baseOffset = { x: 0, y: 0 };
  private currentMotion = 'idle';
  private motionElapsed = 0;
  private currentExpression = 'neutral';
  private mouthOpenValue = 0;
  private mouthFormX = 0;
  private elapsedTime = 0;

  /** Frames in the file currently shown, and how fast they are stepped through. */
  private clipFrames = 1;
  private clipFps = 0;

  private physicsY = 0;
  private velocityY = 0;
  private gravityAccel = DEFAULT_GRAVITY_PX_S2;
  private landingSquash = 0;

  private lookTarget = { x: 0, y: 0 };
  private smoothLook = { x: 0, y: 0 };
  private particles: OrbitalParticle[] = [];
  private bursts: InteractionBurst[] = [];

  private readonly maskSize = ALPHA_MASK_SIZE;
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D | null;
  private alphaBitmask = new Uint32Array(
    (ALPHA_MASK_SIZE * ALPHA_MASK_SIZE) / 32
  );
  private maskUpdateCounter = 0;

  constructor() {
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = this.maskSize;
    this.maskCanvas.height = this.maskSize;
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.initParticles();
  }

  private initParticles(): void {
    this.particles = Array.from({ length: 14 }, (_, idx) => ({
      angle: (idx / 14) * Math.PI * 2,
      radius: 95 + (idx % 3) * 18,
      speed: (idx % 2 === 0 ? 1 : -1) * (0.45 + (idx % 4) * 0.15),
      size: 1.8 + (idx % 3) * 1.1,
      alpha: 0.35 + (idx % 4) * 0.15,
      yOffset: ((idx % 5) - 2) * 16,
    }));
  }

  public setGravityAcceleration(accel: number): void {
    this.gravityAccel = Math.max(
      GRAVITY_MIN_PX_S2,
      Math.min(GRAVITY_MAX_PX_S2, accel)
    );
  }

  public spawnInteractionBurst(x: number, y: number, text = '+EXP'): void {
    const theme = resolvePetTheme(this.manifest?.theme);
    this.bursts.push({
      x,
      y,
      text,
      color: theme.primary,
      age: 0,
      maxAge: 0.95,
    });
    if (this.bursts.length > 8) {
      this.bursts.shift();
    }
  }

  private stageSize(): { w: number; h: number } {
    return {
      w: this.canvas?.clientWidth || STAGE_WIDTH_PX,
      h: this.canvas?.clientHeight || STAGE_HEIGHT_PX,
    };
  }

  /**
   * Fit the backing store to the canvas element.
   *
   * The element grows with the stage window, and the backing store has to follow: a
   * surface that stays at the old size is either cropped by the element or stretched by
   * the browser, and the alpha mask — which is what decides where the pet can be clicked
   * — would be sampled from the wrong picture either way.
   */
  public resizeCanvas(): void {
    if (!this.canvas || !this.ctx) return;
    const dpr = this.devicePixelRatio();
    const { w: cssW, h: cssH } = this.stageSize();
    const width = Math.max(1, Math.round(cssW * dpr));
    const height = Math.max(1, Math.round(cssH * dpr));
    const changed = this.canvas.width !== width || this.canvas.height !== height;
    if (changed) {
      // Assigning either dimension clears the canvas and resets the context state, so the
      // transform has to be written again afterwards.
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (changed) this.rebuildAlphaBitmask();
  }

  private devicePixelRatio(): number {
    if (this.canvas?.dataset.highDpi === '0') return 1;
    return Math.min(2, window.devicePixelRatio || 1);
  }

  public async load(manifest: PetManifest, canvas: HTMLCanvasElement): Promise<void> {
    this.dispose();
    this.manifest = manifest;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.baseScale = manifest.model.scale || 1.0;
    this.baseOffset = {
      x: manifest.model.offset?.x || 0,
      y: manifest.model.offset?.y || 0,
    };

    this.resizeCanvas();

    const entryFile = manifest.model.entry || 'idle.svg';
    this.loadedEntryFile = entryFile;
    // The entry may itself be a strip of frames; the strip is stepped through from the
    // first frame, so the pet is already moving before any motion is requested.
    const entryClip = Object.values(manifest.model.animations ?? {}).find(
      (clip) => clip.file === entryFile
    );
    this.clipFrames = Math.max(1, entryClip?.frames ?? 1);
    this.clipFps = entryClip?.fps && entryClip.fps > 0 ? entryClip.fps : 0;
    const assetUrl = await resolvePetAssetUrl(manifest, entryFile);
    await this.loadImage(assetUrl);
    this.renderFrame(0.016);
    this.rebuildAlphaBitmask();
  }

  private async loadImage(url: string): Promise<void> {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
    this.img = img;
  }

  public playMotion(motionName: string): void {
    const prevMotion = this.currentMotion;
    if (prevMotion !== motionName) {
      this.currentMotion = motionName;
      this.motionElapsed = 0;

      if (prevMotion === 'drag' && motionName !== 'climb') {
        this.physicsY = -28;
        this.velocityY = 0;
      } else if (motionName === 'happy' || motionName === 'feed') {
        this.velocityY = -240;
      }
    }

    const clip = this.manifest?.model.animations?.[motionName];
    // A clip may be a strip of frames rather than one picture; the strip is stepped
    // through while the motion lasts.
    this.clipFrames = Math.max(1, clip?.frames ?? 1);
    this.clipFps = clip?.fps && clip.fps > 0 ? clip.fps : 0;

    const clipFile = clip?.file;
    if (clipFile && clipFile !== this.loadedEntryFile && this.manifest) {
      this.loadedEntryFile = clipFile;
      void resolvePetAssetUrl(this.manifest, clipFile).then((url) => this.loadImage(url));
    }
  }

  public setExpression(expressionName: string): void {
    this.currentExpression = expressionName;
  }

  public setMouthOpen(value: number, formX = 0): void {
    this.mouthOpenValue = Math.min(1.0, Math.max(0.0, value));
    this.mouthFormX = Math.min(1.0, Math.max(-1.0, formX));
  }

  public lookAt(x: number, y: number): void {
    const { w: cssW, h: cssH } = this.stageSize();
    this.lookTarget.x = Math.max(-1, Math.min(1, (x - cssW * 0.5) / (cssW * 0.5)));
    this.lookTarget.y = Math.max(-1, Math.min(1, (y - cssH * 0.5) / (cssH * 0.5)));
  }

  public applyTransform(scale: number, offsetX: number, offsetY: number): void {
    this.baseScale = scale;
    this.baseOffset = { x: offsetX, y: offsetY };
  }

  public hitTest(x: number, y: number): HitTestResult {
    if (!this.canvas) {
      return { hit: false };
    }

    const { w: cssW, h: cssH } = this.stageSize();

    const declaredArea = matchDeclaredHitArea(this.manifest, x, y, cssW, cssH);
    if (declaredArea) {
      return { hit: true, area: declaredArea };
    }

    const nx = Math.floor((x / Math.max(1, cssW)) * this.maskSize);
    const ny = Math.floor((y / Math.max(1, cssH)) * this.maskSize);
    if (nx >= 0 && nx < this.maskSize && ny >= 0 && ny < this.maskSize) {
      const bitIndex = ny * this.maskSize + nx;
      const isOpaque =
        (this.alphaBitmask[bitIndex >>> 5] & (1 << (bitIndex & 31))) !== 0;
      if (isOpaque) {
        return {
          hit: true,
          area: this.manifest?.hit_areas?.[0],
        };
      }
    }

    return { hit: false };
  }

  private rebuildAlphaBitmask(): void {
    if (!this.canvas || !this.maskCtx) return;
    this.maskCtx.clearRect(0, 0, this.maskSize, this.maskSize);
    this.maskCtx.drawImage(this.canvas, 0, 0, this.maskSize, this.maskSize);
    const data = this.maskCtx.getImageData(0, 0, this.maskSize, this.maskSize).data;
    this.alphaBitmask.fill(0);
    for (let i = 0; i < this.maskSize * this.maskSize; i++) {
      if (data[i * 4 + 3] >= ALPHA_MASK_ALPHA_THRESHOLD) {
        this.alphaBitmask[i >>> 5] |= 1 << (i & 31);
      }
    }
  }

  private stepPhysics(deltaSec: number): void {
    if (this.currentMotion === 'drag' || this.currentMotion === 'climb') {
      this.physicsY = 0;
      this.velocityY = 0;
      this.landingSquash = 0;
      return;
    }

    if (this.physicsY < 0 || this.velocityY !== 0) {
      this.velocityY += this.gravityAccel * deltaSec;
      this.physicsY += this.velocityY * deltaSec;

      if (this.physicsY >= 0) {
        this.physicsY = 0;
        if (Math.abs(this.velocityY) > BOUNCE_MIN_IMPACT_SPEED) {
          this.landingSquash = Math.min(
            MAX_LANDING_SQUASH,
            Math.abs(this.velocityY) / BOUNCE_SPEED_DIVISOR
          );
          this.velocityY = -this.velocityY * BOUNCE_DAMPING;
        } else {
          this.velocityY = 0;
        }
      }
    }

    if (this.landingSquash > 0.002) {
      this.landingSquash *= Math.max(
        0,
        1 - deltaSec * SQUASH_DECAY_PER_SEC
      );
    } else {
      this.landingSquash = 0;
    }
  }

  public renderFrame(deltaSec: number): void {
    if (!this.ctx || !this.canvas) return;

    this.elapsedTime += deltaSec;
    this.motionElapsed += deltaSec;
    this.stepPhysics(deltaSec);

    this.smoothLook.x +=
      (this.lookTarget.x - this.smoothLook.x) *
      Math.min(1, deltaSec * LOOK_SMOOTHING_PER_SEC);
    this.smoothLook.y +=
      (this.lookTarget.y - this.smoothLook.y) *
      Math.min(1, deltaSec * LOOK_SMOOTHING_PER_SEC);

    const { w: cssW, h: cssH } = this.stageSize();
    const ctx = this.ctx;

    ctx.clearRect(0, 0, cssW, cssH);

    const cx = cssW * 0.5 + this.baseOffset.x;
    const cy = cssH * SPRITE_CENTER_Y_RATIO + this.baseOffset.y;

    let bobY = Math.sin(this.elapsedTime * 2.6) * 5.5 + this.physicsY;
    let scaleX = this.baseScale * (1 + this.landingSquash);
    let scaleY = this.baseScale * (1 - this.landingSquash);
    let rotation = this.smoothLook.x * 0.055;

    if (this.currentMotion === 'happy') {
      bobY += -Math.abs(Math.sin(this.motionElapsed * 7.5)) * 14;
      scaleX = this.baseScale * (1 + Math.sin(this.motionElapsed * 15) * 0.05);
      scaleY = this.baseScale * (1 - Math.sin(this.motionElapsed * 15) * 0.05);
      rotation += Math.sin(this.motionElapsed * 6) * 0.08;
    } else if (this.currentMotion === 'pat') {
      const squash = Math.sin(this.motionElapsed * 10) * 0.07;
      scaleX = this.baseScale * (1 + squash);
      scaleY = this.baseScale * (1 - squash);
      bobY = Math.sin(this.motionElapsed * 5) * 3 + this.physicsY;
    } else if (this.currentMotion === 'feed') {
      const pulse = Math.sin(this.motionElapsed * 12) * 0.06;
      scaleX = this.baseScale * (1 + pulse);
      scaleY = this.baseScale * (1 + pulse);
    } else if (this.currentMotion === 'drag') {
      bobY = -10 + Math.sin(this.elapsedTime * 9) * 3;
      rotation = this.smoothLook.x * 0.14 + Math.sin(this.elapsedTime * 8) * 0.04;
    } else if (this.currentMotion === 'climb') {
      bobY = -12 + Math.sin(this.elapsedTime * 2.2) * 2.5;
      rotation = Math.sin(this.elapsedTime * 2.0) * 0.035;
    } else if (this.currentMotion === 'sleep') {
      bobY = Math.sin(this.elapsedTime * 1.2) * 3;
      scaleX = this.baseScale * (1 + Math.sin(this.elapsedTime * 1.2) * 0.02);
      scaleY = this.baseScale * (1 - Math.sin(this.elapsedTime * 1.2) * 0.02);
    }

    // Procedural idle life, for a package that asks for it and only while the pose is at
    // rest. `idleMotionFor` owns that decision — including which motions are already being
    // shaped below — so it can be checked without a canvas.
    let idleOffsetX = 0;
    const idleMotion = idleMotionFor(this.currentMotion, this.manifest?.dynamics);
    if (idleMotion?.breathing) {
      const breath = breathingScale(this.elapsedTime, idleMotion.breathing);
      scaleX *= breath.x;
      scaleY *= breath.y;
    }
    if (idleMotion?.sway) {
      const sway = weightShift(this.elapsedTime, idleMotion.sway);
      idleOffsetX = sway.dx;
      rotation += sway.rotation;
    }

    const theme = resolvePetTheme(this.manifest?.theme);
    const primary = theme.primary;
    const accent = theme.accent;
    const expTintHex = numberTintToHex(
      this.manifest?.expressions?.[this.currentExpression]?.tint
    );
    const activeGlowColor = expTintHex || primary;

    ctx.save();
    ctx.translate(cx, cy + SPRITE_GROUND_OFFSET_PX * this.baseScale);
    ctx.scale(1, 0.28);
    const ringRadius = Math.max(12, 72 * this.baseScale * (1 - bobY * 0.004));
    const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, ringRadius);
    grad.addColorStop(0, `${activeGlowColor}55`);
    grad.addColorStop(0.65, `${primary}18`);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(
      cx + this.smoothLook.x * 6 + idleOffsetX,
      cy + bobY + this.smoothLook.y * 4
    );
    ctx.rotate(rotation);
    ctx.scale(scaleX, scaleY);

    if (this.currentMotion === 'sleep' || this.currentExpression === 'sleepy') {
      ctx.globalAlpha = 0.8;
    }

    if (expTintHex) {
      const auraGrad = ctx.createRadialGradient(0, -10, 12, 0, -10, 118);
      auraGrad.addColorStop(0, `${expTintHex}38`);
      auraGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = auraGrad;
      ctx.beginPath();
      ctx.arc(0, -10, 118, 0, Math.PI * 2);
      ctx.fill();
    }

    const drawW = SPRITE_DRAW_WIDTH_PX;
    const drawH = SPRITE_DRAW_HEIGHT_PX;
    if (this.img && this.img.complete && this.img.naturalWidth > 0) {
      if (this.clipFrames > 1) {
        // The file is a strip: one frame at a time, stepped by the clip's own rate.
        const index = frameIndexAt(this.motionElapsed, this.clipFrames, this.clipFps);
        const cell = frameSourceRect(
          this.img.naturalWidth,
          this.img.naturalHeight,
          this.clipFrames,
          index
        );
        ctx.drawImage(
          this.img,
          cell.x,
          cell.y,
          cell.width,
          cell.height,
          -drawW * 0.5,
          -drawH * 0.5,
          drawW,
          drawH
        );
      } else {
        ctx.drawImage(this.img, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
      }
    } else {
      ctx.fillStyle = primary;
      ctx.beginPath();
      ctx.arc(0, 0, SPRITE_FALLBACK_RADIUS_PX, 0, Math.PI * 2);
      ctx.fill();
    }

    const blinkCycle = this.elapsedTime % 3.8;
    const isBlinking =
      this.currentMotion === 'sleep' ||
      this.currentExpression === 'sleepy' ||
      (blinkCycle > 3.64 && blinkCycle < 3.78);
    if (isBlinking) {
      ctx.strokeStyle = activeGlowColor;
      ctx.lineWidth = 2.4;
      ctx.globalAlpha = 0.82;
      ctx.beginPath();
      ctx.moveTo(-38 + this.smoothLook.x * 4, -18 + this.smoothLook.y * 3);
      ctx.lineTo(-18 + this.smoothLook.x * 4, -18 + this.smoothLook.y * 3);
      ctx.moveTo(18 + this.smoothLook.x * 4, -18 + this.smoothLook.y * 3);
      ctx.lineTo(38 + this.smoothLook.x * 4, -18 + this.smoothLook.y * 3);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }

    if (this.mouthOpenValue > 0.03) {
      const barCount = 7;
      const spacing = 7;
      const startX = -((barCount - 1) * spacing) * 0.5;
      const baseY = 24;

      for (let i = 0; i < barCount; i++) {
        const wave = Math.abs(
          Math.sin(this.elapsedTime * 18 + i * 0.9 + this.mouthFormX)
        );
        const h = Math.max(3, (4 + wave * 18) * this.mouthOpenValue);
        ctx.fillStyle = i % 2 === 0 ? primary : accent;
        ctx.fillRect(startX + i * spacing - 2, baseY - h * 0.5, 4, h);
      }
    }

    if (this.currentMotion === 'pat' || this.currentExpression === 'smile') {
      ctx.fillStyle = expTintHex || accent;
      ctx.font = 'bold 15px sans-serif';
      const floatY = -112 - ((this.elapsedTime * 28) % 24);
      ctx.fillText('✦', -58, floatY);
      if (this.currentMotion === 'pat') {
        ctx.fillText('♥', 46, floatY - 5);
      }
    }

    if (this.currentExpression === 'surprised') {
      ctx.fillStyle = accent;
      ctx.font = 'bold 16px "JetBrains Mono", monospace';
      const pulseY = -118 - Math.abs(Math.sin(this.elapsedTime * 10)) * 8;
      ctx.fillText('⚡!', 52, pulseY);
    }

    if (this.currentMotion === 'climb') {
      ctx.strokeStyle = primary;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(-42, -138);
      ctx.lineTo(42, -138);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.currentMotion === 'sleep' || this.currentExpression === 'sleepy') {
      ctx.fillStyle = primary;
      ctx.font = 'bold 14px "JetBrains Mono", monospace';
      const zOffset = (this.elapsedTime * 20) % 30;
      ctx.globalAlpha = Math.max(0.15, 1 - zOffset / 30);
      ctx.fillText('Zzz...', 52, -90 - zOffset);
    }

    ctx.restore();

    ctx.save();
    ctx.translate(cx, cy + bobY * 0.5);
    for (const p of this.particles) {
      p.angle += p.speed * deltaSec;
      const px = Math.cos(p.angle) * p.radius * this.baseScale;
      const py =
        Math.sin(p.angle) * (p.radius * 0.38) * this.baseScale +
        p.yOffset * this.baseScale;
      ctx.fillStyle = p.speed > 0 ? activeGlowColor : accent;
      ctx.globalAlpha =
        p.alpha * (this.currentMotion === 'sleep' ? 0.35 : 0.85);
      ctx.beginPath();
      ctx.arc(px, py, p.size * this.baseScale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    if (this.bursts.length > 0) {
      ctx.save();
      for (let i = this.bursts.length - 1; i >= 0; i--) {
        const b = this.bursts[i];
        b.age += deltaSec;
        if (b.age >= b.maxAge) {
          this.bursts.splice(i, 1);
          continue;
        }
        const progress = b.age / b.maxAge;
        const alpha = Math.max(0, 1 - progress);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 8 + progress * 28, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px "JetBrains Mono", Consolas, monospace';
        ctx.fillText(b.text, b.x - 16, b.y - 10 - progress * 26);
      }
      ctx.restore();
    }

    this.maskUpdateCounter++;
    if (this.maskUpdateCounter % ALPHA_MASK_REBUILD_FRAMES === 0) {
      this.rebuildAlphaBitmask();
    }
  }

  public dispose(): void {
    this.bursts = [];
    this.ctx = null;
    this.img = null;
    this.canvas = null;
  }
}
