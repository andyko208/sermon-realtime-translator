/**
 * Transcript accumulator: detects new phrases by checking if text is a continuation
 */
export class TranscriptAccumulator {
  private buffer = ""; // Accumulated complete sentences
  private current = ""; // Current streaming fragment
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Update with streaming text - auto-detects phrase boundaries */
  update(text: string, finished?: boolean): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Detect new phrase: if new text doesn't start with current (not a continuation)
    const isNewPhrase = this.current && !trimmed.startsWith(this.current.slice(0, Math.min(10, this.current.length)));
    
    if (isNewPhrase || finished) {
      this.commitCurrent();
    }

    this.current = trimmed;
    this.render();
  }

  private commitCurrent(): void {
    if (!this.current) return;
    const separator = this.buffer && !this.buffer.endsWith(" ") ? " " : "";
    this.buffer += separator + this.current;
    this.current = "";
  }

  clear(): void {
    this.buffer = "";
    this.current = "";
    this.container.innerHTML = "";
  }

  private render(): void {
    const full = (this.buffer + (this.buffer && this.current ? " " : "") + this.current).trim();
    if (!full) {
      this.container.innerHTML = "";
      return;
    }

    const bufferHtml = this.buffer ? `<span class="history">${this.escapeHtml(this.buffer)}</span>` : "";
    const currentHtml = this.current ? `<span class="current">${this.escapeHtml(this.current)}</span>` : "";
    const separator = bufferHtml && currentHtml ? " " : "";
    
    this.container.innerHTML = bufferHtml + separator + currentHtml;
    this.container.parentElement?.scrollTo(0, this.container.parentElement.scrollHeight);
  }

  private escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
  }
}
