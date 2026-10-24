// 只用 DSH 主题变量，深浅色跟随宿主。行、按钮、输入框、开关的尺寸取自原生设置页与 ui-primitives。
// 二维码底色固定为白：深色底上的二维码不一定能被企微识别。
export const STYLE_ID = 'dsh-remote-wecom/settings.css';

export const CSS = String.raw`
.drw-page { --drw-code: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; padding-bottom: 8px; }
.drw-main { height: 100%; min-height: 0; overflow: auto; box-sizing: border-box; padding: 48px clamp(16px, 4vw, 48px) 32px; }
.drw-mainInner { max-width: 640px; margin: 0 auto; }
.drw-open { display: inline-flex; align-items: center; height: 32px; padding: 0 14px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.drw-open:hover { background: var(--dsw-alias-interactive-bg-hover); }
.drw-open:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.drw-page *, .drw-page *::before, .drw-page *::after { box-sizing: border-box; }
.drw-head { display: flex; align-items: center; gap: 10px; min-height: 28px; margin: 0 0 6px; }
.drw-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.drw-status { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px 1px 7px; border-radius: 999px; font-size: 12px; line-height: 18px; font-weight: 500; white-space: nowrap; }
.drw-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.drw-status[data-tone=success] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.drw-status[data-tone=warning] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.drw-status[data-tone=danger] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.drw-status[data-tone=idle] { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); }
.drw-reason { margin: 0 0 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }

.drw-group { display: flex; flex-direction: column; }
.drw-group + .drw-group { margin-top: 20px; }
.drw-groupHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0 4px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; font-weight: 500; }
.drw-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 54px; padding: 12px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.drw-group > .drw-row:last-child { border-bottom: none; }
.drw-rowLabel { flex: none; font-size: 14px; line-height: 22px; }
.drw-rowMain { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; min-width: 0; }
.drw-rowControl { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; min-width: 0; }
.drw-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; text-align: right; }
.drw-value { color: var(--dsw-alias-label-secondary); font-family: var(--drw-code); font-size: 13px; letter-spacing: .02em; }
.drw-muted { color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.drw-code { display: inline-flex; gap: .45em; font-family: var(--drw-code); font-size: 24px; line-height: 30px; font-weight: 500; letter-spacing: .1em; font-variant-numeric: tabular-nums; }
.drw-confirmText { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }

.drw-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; white-space: nowrap; cursor: pointer; }
.drw-btn[data-size=sm] { height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm, 6px); font-size: 12px; line-height: 18px; }
.drw-btn[data-variant=outline] { border: .5px solid var(--dsw-alias-border-l3); }
.drw-btn[data-variant=primary] { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.drw-btn[data-variant=primary]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.drw-btn[data-variant=danger] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.drw-btn[data-variant=danger]:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }
.drw-btn:is([data-variant=outline], [data-variant=ghost]):hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.drw-btn:disabled { opacity: .4; cursor: not-allowed; }
.drw-icon { width: 28px; padding: 0; color: var(--dsw-alias-label-tertiary); }
.drw-icon:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.drw-link { padding: 2px 4px; border: none; border-radius: var(--dsw-radius-sm, 6px); background: none; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.drw-link:hover { color: var(--dsw-alias-label-secondary); }
.drw-page :is(button, input, select):focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

.drw-input { height: 32px; min-width: 0; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; }
.drw-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.drw-page .drw-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.drw-input[aria-invalid=true] { border-color: var(--dsw-alias-state-error-primary); }
.drw-num { width: 84px; text-align: right; font-variant-numeric: tabular-nums; }
.drw-unit { color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.drw-select { position: relative; display: inline-flex; align-items: center; }
.drw-select select { height: 32px; padding: 0 30px 0 12px; border: none; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; appearance: none; cursor: pointer; }
.drw-select select:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.drw-select svg { position: absolute; right: 10px; color: var(--dsw-alias-label-tertiary); pointer-events: none; }
.drw-switch { position: relative; flex: none; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; }
.drw-switch[aria-checked=true] { background: var(--dsw-alias-brand-primary); }
.drw-switch:disabled { opacity: .5; cursor: default; }
.drw-switch > span { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-switch-thumb, var(--dsw-alias-label-primary-foreground)); transition: transform .12s ease; }
.drw-switch[aria-checked=true] > span { background: var(--dsw-alias-label-primary-foreground); transform: translateX(16px); }

.drw-card { display: flex; flex-direction: column; align-items: center; width: min(340px, 100%); margin: 28px auto 8px; padding: 28px 24px 18px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-xl, 16px); text-align: center; }
.drw-tile { position: relative; display: grid; place-items: center; width: 200px; height: 200px; padding: 8px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 12px); background: #fff; overflow: hidden; }
.drw-tile[data-state=blank] { background: var(--dsw-alias-bg-module-platform); }
.drw-tile img { display: block; width: 184px; height: 184px; image-rendering: pixelated; }
.drw-skeleton { width: 184px; height: 184px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-module-platform); animation: drw-pulse 1.4s ease-in-out infinite; }
.drw-tile[data-state=blank] .drw-skeleton { background: var(--dsw-alias-interactive-bg-hover); }
.drw-tileBody { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 0 12px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.drw-tileBody .drw-error { text-align: center; }
.drw-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border: none; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 88%, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.drw-overlay svg { color: var(--dsw-alias-label-secondary); }
.drw-cardLine { display: flex; align-items: baseline; justify-content: center; gap: 8px; margin-top: 16px; font-size: 15px; line-height: 22px; font-weight: 500; }
.drw-cardFoot { margin-top: 14px; }
.drw-form { display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 12px; text-align: left; }
.drw-form .drw-input { width: 100%; }
.drw-form .drw-btn { align-self: flex-end; }
.drw-wait { gap: 6px; padding-top: 32px; }
.drw-waitTitle { margin-top: 10px; font-size: 15px; line-height: 22px; font-weight: 500; }
.drw-waitCode { display: flex; flex-direction: column; align-items: center; gap: 2px; margin-top: 18px; padding-top: 14px; border-top: .5px solid var(--dsw-alias-border-l2); width: 100%; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.drw-waitCode .drw-code { color: var(--dsw-alias-label-secondary); font-size: 20px; line-height: 28px; }
.drw-spinner { width: 18px; height: 18px; border: 2px solid var(--dsw-alias-border-l3); border-top-color: var(--dsw-alias-label-secondary); border-radius: 50%; animation: drw-spin .9s linear infinite; }
.drw-center { display: grid; place-items: center; min-height: 160px; gap: 10px; color: var(--dsw-alias-label-secondary); font-size: 13px; }

.drw-foot { display: flex; align-items: center; gap: 12px; margin-top: 24px; }

@keyframes drw-spin { to { transform: rotate(360deg); } }
@keyframes drw-pulse { 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) { .drw-spinner, .drw-skeleton { animation: none; } .drw-switch > span, @media (max-width: 560px) {
  .drw-row { flex-wrap: wrap; gap: 8px 16px; }
  .drw-rowMain { align-items: flex-start; width: 100%; }
  .drw-rowControl { justify-content: flex-start; }
  .drw-error { text-align: left; }
    }
@media (pointer: coarse) { .drw-btn[data-size=sm] { min-height: 36px; } .drw-input, .drw-select select { min-height: 40px; font-size: 16px; } }
`;

export function installStyles() {
  if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return () => {};
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-remote-wecom';
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
  return () => tag.remove();
}
