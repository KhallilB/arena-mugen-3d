import type { CharacterConfig } from '../engine/FighterController.ts';

export class CharacterSelect {
  public readonly container: HTMLElement;
  public characters: CharacterConfig[] = [];

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.id = 'character-select-grid';
    parent.appendChild(this.container);
  }

  public setRoster(chars: CharacterConfig[]): void {
    this.characters = chars;
    this.container.innerHTML = chars
      .map(
        (c) => `
        <div class="char-card" data-char-id="${c.id}">
          <h4>${c.displayName}</h4>
          <span>${c.title} • ${c.model.heightMeters.toFixed(2)}m • ${c.archetype}</span>
        </div>
      `,
      )
      .join('');
  }
}
