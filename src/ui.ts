// Kleine UI-Helfer

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

let toastTimer: number | undefined;
export function toast(msg: string, ms = 3000): void {
  const el = document.getElementById("toast")!;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), ms);
}

const panel = document.getElementById("panel")!;

export function openPanel(title: string, html: string): HTMLElement {
  document.getElementById("panel-title")!.textContent = title;
  const body = document.getElementById("panel-body")!;
  body.innerHTML = html;
  panel.hidden = false;
  return body;
}

export function closePanel(): void {
  panel.hidden = true;
}

document.getElementById("panel-close")!.addEventListener("click", closePanel);
