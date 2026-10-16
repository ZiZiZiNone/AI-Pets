import type { IPetAdapter } from './IPetAdapter';
import type { AdapterType } from '@/types/pet';

export class AdapterFactory {
  static async createAdapter(type: AdapterType): Promise<IPetAdapter> {
    switch (type) {
      case 'live2d': {
        const { Live2dAdapter } = await import('./Live2dAdapter');
        return new Live2dAdapter();
      }
      case 'spine': {
        const { SpineAdapter } = await import('./SpineAdapter');
        return new SpineAdapter();
      }
      case 'vrm': {
        const { VrmAdapter } = await import('./VrmAdapter');
        return new VrmAdapter();
      }
      case 'sprite':
      default: {
        const { SpriteAdapter } = await import('./SpriteAdapter');
        return new SpriteAdapter();
      }
    }
  }
}
