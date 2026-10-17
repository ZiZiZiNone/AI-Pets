import {
  LLM_SYSTEM_PROMPT_HEADLINE,
  LLM_SYSTEM_PROMPT_TAIL,
  LLM_SYSTEM_PROMPT_TRAITS,
} from '@/constants/messages';
import type { PetManifest, PetPersonaDef } from '@/types/pet';

/**
 * Composing the system prompt for a pet.
 *
 * Kept separate from the transport so the personality rules are testable on their own and
 * so switching LLM vendors never touches them. Precedence, strongest first:
 *
 *   1. `persona.system_prompt` — a pet that ships a complete brief owns the prompt.
 *   2. `llmConfig.customSystemPrompt` — a user override that replaces the host default.
 *   3. The structured persona fields, composed into the host template.
 *   4. The neutral host template.
 */

const NEUTRAL_PERSONA_TRAITS = ['友善', '好奇'];

/** Compose the structured persona fields into a prompt body. */
function composePersonaBody(persona: PetPersonaDef): string[] {
  const lines: string[] = [];
  if (persona.identity) lines.push(persona.identity.trim());
  const traits = persona.traits?.filter((t) => t.trim().length > 0) ?? [];
  if (traits.length > 0) lines.push(`性格：${traits.join('、')}。`);
  if (persona.style_notes) lines.push(persona.style_notes.trim());
  return lines;
}

export function buildPetSystemPrompt(
  pet: Pick<PetManifest, 'id' | 'name' | 'description' | 'persona'> | null,
  customSystemPrompt?: string
): string {
  const name = pet?.name || '桌面宠物';
  const persona = pet?.persona;

  if (persona?.system_prompt?.trim()) {
    return persona.system_prompt.trim();
  }

  const sections: string[] = [
    LLM_SYSTEM_PROMPT_HEADLINE(name, pet?.description || ''),
  ];
  sections.push(...composePersonaBody(persona ?? {}));

  const traits = persona?.traits?.filter((t) => t.trim().length > 0) ?? [];
  if (traits.length === 0) {
    sections.push(LLM_SYSTEM_PROMPT_TRAITS(NEUTRAL_PERSONA_TRAITS));
  }
  sections.push(LLM_SYSTEM_PROMPT_TAIL);

  const composed = sections.filter((line) => line.trim().length > 0).join('\n');
  const override = customSystemPrompt?.trim();
  return override || composed;
}

/** One-line summary of a pet's voice, for pickers and the companion panel. */
export function describePetPersona(persona?: PetPersonaDef): string {
  if (!persona) return NEUTRAL_PERSONA_TRAITS.join('、');
  if (persona.system_prompt?.trim()) return '自定义人格';
  const parts: string[] = [];
  if (persona.traits?.length) parts.push(persona.traits.join('、'));
  else parts.push(...NEUTRAL_PERSONA_TRAITS);
  if (persona.style_notes) parts.push(persona.style_notes);
  return parts.join('｜');
}
