import { convertFileSrc } from '@tauri-apps/api/core';
import type { HitAreaDef, PetManifest } from '@/types/pet';

export interface HitTestResult {
  hit: boolean;
  area?: HitAreaDef;
}

export interface IPetAdapter {
  readonly canvasType: '2d' | '3d';
  load(manifest: PetManifest, canvas: HTMLCanvasElement): Promise<void>;
  playMotion(motionName: string, index?: number): void;
  setExpression(expressionName: string): void;
  setMouthOpen(value: number, formX?: number): void;
  lookAt(x: number, y: number): void;
  applyTransform(scale: number, offsetX: number, offsetY: number): void;
  hitTest(x: number, y: number): HitTestResult;
  renderFrame(deltaSec: number): void;
  dispose(): void;
  setGravityAcceleration?(accel: number): void;
  spawnInteractionBurst?(x: number, y: number, text?: string): void;
}

export function matchDeclaredHitArea(
  manifest: PetManifest | null,
  x: number,
  y: number,
  canvasWidth = 360,
  canvasHeight = 420
): HitAreaDef | undefined {
  if (!manifest?.hit_areas || manifest.hit_areas.length === 0) {
    return undefined;
  }

  const scale = manifest.model.scale || 1.0;
  const offX = manifest.model.offset?.x || 0;
  const offY = manifest.model.offset?.y || 0;
  const cx = canvasWidth * 0.5;
  const cy = canvasHeight * 0.5;

  const localX = (x - cx - offX) / scale + 160;
  const localY = (y - cy - offY) / scale + 170;

  for (const area of manifest.hit_areas) {
    const { rect } = area;
    if (
      localX >= rect.x &&
      localX <= rect.x + rect.w &&
      localY >= rect.y &&
      localY <= rect.y + rect.h
    ) {
      return area;
    }
  }
  return undefined;
}

export async function resolvePetAssetUrl(
  manifest: PetManifest,
  relativePath: string
): Promise<string> {
  if (
    relativePath.startsWith('http://') ||
    relativePath.startsWith('https://') ||
    relativePath.startsWith('data:') ||
    relativePath.startsWith('blob:')
  ) {
    return relativePath;
  }

  const cleanRel = relativePath.replace(/^[./\\]+/, '');
  if (
    manifest.basePath &&
    (manifest.basePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(manifest.basePath))
  ) {
    try {
      const sep = manifest.basePath.includes('\\') ? '\\' : '/';
      const fullPath = `${manifest.basePath.replace(/[/\\]+$/, '')}${sep}${cleanRel}`;
      return convertFileSrc(fullPath);
    } catch {
      // Fallback to web path
    }
  }

  return `/pets/${manifest.id}/${cleanRel}`;
}
