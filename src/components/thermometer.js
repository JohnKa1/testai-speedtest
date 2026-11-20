/**
 * Componente visual do termômetro vertical/horizontal de vazão.
 * Escala dinamicamente conforme a faixa de velocidade medida.
 */

const SCALE_STEPS = [
  { max: 100, label: '100M' },
  { max: 300, label: '300M' },
  { max: 500, label: '500M' },
  { max: 1000, label: '1G' },
  { max: 2500, label: '2.5G' },
  { max: 5000, label: '5G' }
];

export class ThermometerComponent {
  constructor() {
    this.currentScaleMax = 1000;
  }

  resolveScale(mbps) {
    const value = Math.max(0, Number(mbps) || 0);
    const step = SCALE_STEPS.find((s) => value <= s.max) || SCALE_STEPS[SCALE_STEPS.length - 1];
    this.currentScaleMax = Math.max(this.currentScaleMax, step.max);
    return SCALE_STEPS.find((s) => s.max === this.currentScaleMax) || step;
  }

  update(currentMbps, phase = 'download') {
    const fillEl = document.getElementById('thermoFill');
    const maxEl = document.getElementById('thermoMax');
    if (!fillEl) return;

    const safeMbps = Math.max(0, Number(currentMbps) || 0);
    const scale = this.resolveScale(safeMbps);

    if (maxEl) {
      maxEl.textContent = scale.label;
    }

    const percent = Math.min(100, (safeMbps / scale.max) * 100);
    fillEl.style.height = `${percent.toFixed(1)}%`;
    fillEl.style.width = `${percent.toFixed(1)}%`;

    fillEl.classList.toggle('upload-mode', phase === 'upload');
    fillEl.classList.toggle('high-speed', safeMbps >= 500);
  }

  reset() {
    this.currentScaleMax = 1000;
    const fillEl = document.getElementById('thermoFill');
    const maxEl = document.getElementById('thermoMax');

    if (maxEl) {
      maxEl.textContent = '1G';
    }
    if (fillEl) {
      fillEl.style.height = '0%';
      fillEl.style.width = '0%';
      fillEl.classList.remove('upload-mode', 'high-speed');
    }
  }
}