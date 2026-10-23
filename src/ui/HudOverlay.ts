import type { ArenaSimulation } from '../engine/ArenaSimulation.ts';

export class HudOverlay {
  public readonly container: HTMLElement;
  public speedMultiplier: 0.5 | 1 | 2 | 4 = 1;
  public matchMode: 'P1_VS_CPU' | 'P1_VS_P2' | 'CPU_VS_CPU' | 'AUTO_SPECTATE' = 'CPU_VS_CPU';

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.id = 'arena-hud-overlay';
    parent.appendChild(this.container);
  }

  public render(sim: ArenaSimulation): void {
    const [p1, p2] = sim.fighters;
    const ai1 = sim.aiControllers[0]?.lastTelemetryBadge ?? '[HUMAN]';
    const ai2 = sim.aiControllers[1]?.lastTelemetryBadge ?? '[HUMAN]';
    const sec = Math.ceil(sim.roundTimerTicks / 60);

    this.container.innerHTML = `
      <div class="hud-top-bar">
        <div class="fighter-hud p1">
          <strong>${p1.config.displayName} (${p1.config.model.heightMeters.toFixed(2)}m)</strong>
          <div>HP: ${p1.health}/${p1.maxHealth} | Guard: ${Math.round(p1.guardMeter)} | Meter: ${p1.meter}</div>
          <div class="ai-badge">${ai1} | State: ${p1.state} (f${p1.stateFrame})</div>
        </div>
        <div class="round-timer">
          <div>Round ${sim.roundNumber} (${sim.roundWins[0]} - ${sim.roundWins[1]})</div>
          <div class="timer-digits">${sec}s</div>
        </div>
        <div class="fighter-hud p2">
          <strong>${p2.config.displayName} (${p2.config.model.heightMeters.toFixed(2)}m)</strong>
          <div>HP: ${p2.health}/${p2.maxHealth} | Guard: ${Math.round(p2.guardMeter)} | Meter: ${p2.meter}</div>
          <div class="ai-badge">${ai2} | State: ${p2.state} (f${p2.stateFrame})</div>
        </div>
      </div>
    `;
  }
}
