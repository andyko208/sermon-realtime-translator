export interface FontSizeControlsOptions {
  initialRem?: number;
  stepRem?: number;
  minRem?: number;
  maxRem?: number;
}

/**
 * Binds +/- controls (inside `card`) to update transcript font size.
 * Expects markup:
 * - `[data-font-size-controls]` wrapper
 * - buttons: `[data-font-size="down"]` and `[data-font-size="up"]`
 * - optional `[data-font-size-value]` to display current size
 */
export function bindTranscriptFontSizeControls(
  card: HTMLElement | null,
  opts: FontSizeControlsOptions = {}
): void {
  if (!card) return;

  const controls = card.querySelector<HTMLElement>("[data-font-size-controls]");
  const downBtn = controls?.querySelector<HTMLButtonElement>('[data-font-size="down"]');
  const upBtn = controls?.querySelector<HTMLButtonElement>('[data-font-size="up"]');
  const valueEl = controls?.querySelector<HTMLElement>("[data-font-size-value]");
  if (!controls || !downBtn || !upBtn) return;

  const step = opts.stepRem ?? 0.1;
  const min = opts.minRem ?? 0.8;
  const max = opts.maxRem ?? 2;
  let size = opts.initialRem ?? 1;

  const apply = (): void => {
    size = Math.max(min, Math.min(max, size));
    card.style.setProperty("--transcript-font-size", `${size}rem`);
    if (valueEl) valueEl.textContent = `${Math.round(size * 100)}%`;
  };

  downBtn.onclick = () => {
    size -= step;
    apply();
  };
  upBtn.onclick = () => {
    size += step;
    apply();
  };

  apply();
}

