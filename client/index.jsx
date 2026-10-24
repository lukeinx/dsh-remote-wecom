// 「设置 → 企微远程」：扫码创建机器人、绑定账号、新会话位置、偏好与离线看门狗。保存即生效，状态约 2 秒轮询一次。
import * as React from 'react';
import {installStyles} from './styles.js';
import {en, zh} from './locale.js';

const {useCallback, useEffect, useRef, useState, useSyncExternalStore} = React;
const h = React.createElement;
const Fragment = React.Fragment;

const NS = 'dsh-remote-wecom';
const ENDPOINT = 'dsh-remote-wecom/settings';
const POLL_MS = 2000;
const POLICIES = ['ask-then-allow', 'ask', 'allow'];
const PACKAGE = 'dsh-remote-wecom';
const MAIN_PANEL = 'dsh-remote-wecom';

export const name = 'dsh-remote-wecom-settings';
export const inject = ['slots', 'connection', 'locale'];

const mmss = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function Button({variant = 'ghost', size = 'md', className = '', ...rest}) {
  return <button type="button" className={`drw-btn ${className}`} data-variant={variant} data-size={size} {...rest} />;
}
function Switch({checked, onChange, label, disabled}) {
  return (
    <button type="button" role="switch" className="drw-switch" aria-checked={checked} aria-label={label}
      disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
  );
}
const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const RefreshIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10a6 6 0 1 1-1.76-4.24M16 4v3.5h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

function Row({label, error, children, className = ''}) {
  return (
    <div className={`drw-row ${className}`}>
      <div className="drw-rowLabel">{label}</div>
      <div className="drw-rowMain">
        <div className="drw-rowControl">{children}</div>
        {error ? <div className="drw-error" role="alert">{error}</div> : null}
      </div>
    </div>
  );
}

/** 危险操作的行内二次确认。 */
function Confirmable({label, warning, busy, onConfirm, t, variant = 'outline'}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button variant={variant} size="sm" disabled={busy} onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <Fragment>
      <span className="drw-confirmText">{warning}</span>
      <Button variant="danger" size="sm" disabled={busy} onClick={() => { setAsking(false); onConfirm(); }}>{t('confirm')}</Button>
      <Button size="sm" onClick={() => setAsking(false)}>{t('cancel')}</Button>
    </Fragment>
  );
}

function statusOf(s, t) {
  if (!s.bot.configured) return ['idle', t('status.unconfigured')];
  if (!s.connection.connected) return ['danger', t('status.offline')];
  if (!s.owner.bound) return ['warning', t('status.pending')];
  return ['success', t('status.online')];
}

function QrTile({qr, now, busy, onStart, t}) {
  if (qr.state === 'connecting') {
    return <div className="drw-tile" data-state="blank"><div className="drw-tileBody"><div className="drw-spinner" />{t('qr.connecting')}</div></div>;
  }
  if (qr.state === 'failed') {
    return (
      <div className="drw-tile" data-state="blank">
        <div className="drw-tileBody">
          <div className="drw-error" role="alert">{qr.error}</div>
          <Button variant="outline" size="sm" disabled={busy} onClick={onStart}>{t('retry')}</Button>
        </div>
      </div>
    );
  }
  if (qr.state === 'idle') {
    return <div className="drw-tile" data-state="blank"><Button variant="outline" size="sm" disabled={busy} onClick={onStart}>{t('qr.generate')}</Button></div>;
  }
  if (!qr.dataUrl) return <div className="drw-tile" data-state="blank" aria-busy="true"><div className="drw-skeleton" /></div>;
  const expired = qr.state === 'expired' || now >= qr.expiresAt;
  return (
    <div className="drw-tile">
      <img src={qr.dataUrl} alt={t('qr.alt')} />
      {expired ? <button type="button" className="drw-overlay" disabled={busy} onClick={onStart}><RefreshIcon />{t('qr.refresh')}</button> : null}
    </div>
  );
}

function ManualForm({act, busy, error, t}) {
  const [botId, setBotId] = useState('');
  const [secret, setSecret] = useState('');
  const submit = e => {
    e.preventDefault();
    void act('manual', 'saveCredentials', {botId, secret});
  };
  return (
    <form className="drw-form" onSubmit={submit}>
      <input className="drw-input" placeholder={t('manual.botId')} aria-label={t('manual.botId')} autoComplete="off" spellCheck={false}
        value={botId} onChange={e => setBotId(e.target.value)} />
      <input className="drw-input" type="password" placeholder={t('manual.secret')} aria-label={t('manual.secret')} autoComplete="new-password"
        value={secret} onChange={e => setSecret(e.target.value)} />
      {error ? <div className="drw-error" role="alert">{error}</div> : null}
      <Button type="submit" variant="primary" size="sm" disabled={busy || !botId.trim() || !secret.trim()}>{t('save')}</Button>
    </form>
  );
}

function QrCard({s, now, act, busy, errors, t}) {
  const [manual, setManual] = useState(false);
  const qr = s.qr;
  const live = qr.state === 'waiting' && qr.dataUrl && now < qr.expiresAt;
  return (
    <div className="drw-card">
      <QrTile qr={qr} now={now} busy={busy.qr} t={t} onStart={() => act('qr', 'qrStart')} />
      <div className="drw-cardLine">
        <span>{t('qr.scan')}</span>
        {live ? <span className="drw-countdown">{mmss(qr.expiresAt - now)}</span> : null}
      </div>
      {errors.qr ? <div className="drw-error" role="alert">{errors.qr}</div> : null}
      <div className="drw-cardFoot">
        {s.bot.configured
          ? <button type="button" className="drw-link" onClick={() => act('qr', 'qrCancel')}>{t('cancel')}</button>
          : <button type="button" className="drw-link" aria-expanded={manual} onClick={() => setManual(v => !v)}>{t('manual.toggle')}</button>}
      </div>
      {manual && !s.bot.configured ? <ManualForm act={act} busy={busy.manual} error={errors.manual} t={t} /> : null}
    </div>
  );
}

const splitCode = code => <span className="drw-code"><span>{code.slice(0, 3)}</span><span>{code.slice(3)}</span></span>;

function WaitCard({s, now, t}) {
  return (
    <div className="drw-card drw-wait">
      <div className="drw-spinner" />
      <div className="drw-waitTitle">{t('wait.title')}</div>
      <span className="drw-countdown">{mmss(s.bind.auto.expiresAt - now)}</span>
      {s.bind.code ? <div className="drw-waitCode">{t('wait.code')}{splitCode(s.bind.code)}</div> : null}
    </div>
  );
}

function OwnerControl({s, now, act, busy, t}) {
  if (s.owner.bound) {
    return (
      <Fragment>
        <span className="drw-value">{s.owner.userId}</span>
        <Confirmable label={t('owner.unbind')} warning={t('owner.unbindConfirm')} busy={busy.owner} t={t} onConfirm={() => act('owner', 'unbind')} />
      </Fragment>
    );
  }
  if (s.bind.code && now < s.bind.expiresAt) {
    return (
      <Fragment>
        <span className="drw-muted">{t('owner.send')}</span>
        {splitCode(s.bind.code)}
        <span className="drw-countdown">{mmss(s.bind.expiresAt - now)}</span>
        <Button size="sm" disabled={busy.owner} onClick={() => act('owner', 'newBindCode')}>{t('owner.regen')}</Button>
      </Fragment>
    );
  }
  return (
    <Fragment>
      <span className="drw-muted">{t('owner.expired')}</span>
      <Button variant="outline" size="sm" disabled={busy.owner} onClick={() => act('owner', 'newBindCode')}>{t('owner.generate')}</Button>
    </Fragment>
  );
}

function TimeoutControl({prefs, act, busy, setError, t}) {
  const seconds = String(Math.round(prefs.remoteConfirmTimeoutMs / 1000));
  const [draft, setDraft] = useState(seconds);
  useEffect(() => setDraft(seconds), [seconds]);
  const commit = () => {
    if (draft === seconds) return;
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1 || n > 86400) { setError('confirm', t('seconds.invalid')); return; }
    void act('confirm', 'setPrefs', {remoteConfirmTimeoutMs: n * 1000});
  };
  return (
    <Fragment>
      <span className="drw-select">
        <select aria-label={t('row.confirm')} value={prefs.remoteConfirm} disabled={busy}
          onChange={e => act('confirm', 'setPrefs', {remoteConfirm: e.target.value})}>
          {POLICIES.map(p => <option key={p} value={p}>{t(`policy.${p}`)}</option>)}
        </select>
        <Chevron />
      </span>
      {prefs.remoteConfirm === 'allow' ? null : (
        <Fragment>
          <input className="drw-input drw-num" type="number" inputMode="numeric" min="1" max="86400" aria-label={t('seconds')}
            value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setDraft(seconds); }} />
          <span className="drw-unit">{t('seconds')}</span>
        </Fragment>
      )}
    </Fragment>
  );
}

function PlaceControl({place, act, busy, t}) {
  return (
    <span className="drw-select">
      <select aria-label={t('row.place')} value={place.current} disabled={busy}
        onChange={e => act('place', 'setPlace', {value: e.target.value})}>
        {place.options.map(o => <option key={o.value} value={o.value}>{o.value === 'none' ? t('place.none') : o.label}</option>)}
      </select>
      <Chevron />
    </span>
  );
}

function Configured({s, now, act, busy, errors, setError, t}) {
  return (
    <Fragment>
      <div className="drw-group">
        <Row label={t('row.bot')} error={errors.bot}>
          <span className="drw-value">{s.bot.botId}</span>
          <Confirmable label={t('bot.rescan')} warning={t('bot.rescanConfirm')} busy={busy.bot} t={t} onConfirm={() => act('bot', 'qrStart')} />
        </Row>
        <Row label={t('row.owner')} error={errors.owner}>
          <OwnerControl s={s} now={now} act={act} busy={busy} t={t} />
        </Row>
      </div>
      <div className="drw-group">
        {s.place ? (
          <Row label={t('row.place')} error={errors.place}>
            <PlaceControl place={s.place} act={act} busy={busy.place} t={t} />
          </Row>
        ) : null}
        <Row label={t('row.confirm')} error={errors.confirm}>
          <TimeoutControl prefs={s.prefs} act={act} busy={busy.confirm} setError={setError} t={t} />
        </Row>
        <Row label={t('row.openDesktop')} error={errors.open}>
          <Switch checked={s.prefs.openDesktop} label={t('row.openDesktop')} disabled={busy.open}
            onChange={v => act('open', 'setPrefs', {openDesktop: v})} />
        </Row>
        {s.watchdog ? (
          <Row label={t('row.watchdog')} error={errors.watchdog}>
            <Switch checked={s.watchdog.enabled} label={t('row.watchdog')} disabled={busy.watchdog}
              onChange={v => act('watchdog', 'setWatchdog', {enabled: v})} />
          </Row>
        ) : null}
      </div>
      <div className="drw-foot">
        <Button variant="outline" disabled={busy.restart} onClick={() => act('restart', 'restart')}>
          {busy.restart ? t('restarting') : t('restart')}
        </Button>
        {errors.restart ? <span className="drw-error" role="alert">{errors.restart}</span> : null}
      </div>
    </Fragment>
  );
}

function Settings({call, t}) {
  const [s, setS] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState({});
  const autoStarted = useRef(false);
  const mounted = useRef(true);
  const counting = Boolean(s && (s.qr.dataUrl || s.bind.code || s.bind.auto));
  const now = useNow(counting);

  const refresh = useCallback(async signal => {
    try {
      const next = await call('state', {}, signal);
      if (mounted.current) { setS(next); setLoadError(''); }
    } catch (e) {
      if (mounted.current && !signal?.aborted) setLoadError(e?.message || t('loadFailed'));
    }
  }, [call, t]);
  useEffect(() => {
    mounted.current = true;
    const ac = new AbortController();
    void refresh(ac.signal);
    const id = setInterval(() => { if (!document.hidden) void refresh(ac.signal); }, POLL_MS);
    return () => { mounted.current = false; ac.abort(); clearInterval(id); };
  }, [refresh]);

  const setError = useCallback((key, message) => setErrors(e => ({...e, [key]: message})), []);
  const act = useCallback(async (key, method, payload = {}) => {
    setBusy(b => ({...b, [key]: true}));
    setError(key, '');
    try {
      const next = await call(method, payload);
      if (mounted.current) setS(next);
      return true;
    } catch (e) {
      if (mounted.current) setError(key, e?.message || String(e));
      return false;
    } finally {
      if (mounted.current) setBusy(b => ({...b, [key]: false}));
    }
  }, [call, setError]);

  useEffect(() => {
    if (!s || s.bot.configured || s.qr.state !== 'idle' || autoStarted.current) return;
    autoStarted.current = true;
    void act('qr', 'qrStart');
  }, [s, act]);

  if (!s) {
    return (
      <div className="drw-page">
        <div className="drw-head"><h2 className="drw-title">{t('title')}</h2></div>
        <div className="drw-center">
          {loadError
            ? <Fragment><span className="drw-error" role="alert">{loadError}</span><Button variant="outline" size="sm" onClick={() => refresh()}>{t('retry')}</Button></Fragment>
            : <div className="drw-spinner" aria-label={t('title')} />}
        </div>
      </div>
    );
  }
  const [tone, label] = statusOf(s, t);
  const scanning = s.qr.state !== 'idle';
  let body;
  if (!s.bot.configured || scanning) body = <QrCard s={s} now={now} act={act} busy={busy} errors={errors} t={t} />;
  else if (!s.owner.bound && s.bind.auto && now < s.bind.auto.expiresAt) body = <WaitCard s={s} now={now} t={t} />;
  else body = <Configured s={s} now={now} act={act} busy={busy} errors={errors} setError={setError} t={t} />;
  return (
    <div className="drw-page">
      <div className="drw-head">
        <h2 className="drw-title">{t('title')}</h2>
        <span className="drw-status" data-tone={tone} role="status">{label}</span>
      </div>
      {s.bot.configured && !s.connection.connected && s.connection.reason ? <p className="drw-reason">{s.connection.reason}</p> : null}
      {loadError ? <p className="drw-error" role="alert" style={{textAlign: 'left'}}>{loadError}</p> : null}
      {body}
    </div>
  );
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'dsh-remote-wecom: dictionaries');
  ctx.effect(() => installStyles(), 'dsh-remote-wecom: styles');
  const t = ctx.locale.bind(NS);
  const call = async (method, payload = {}, signal) => {
    const result = await ctx.connection.rpc.call('/api', ENDPOINT, {method, payload}, signal);
    if (result?.ok === true) return result.value;
    throw new Error(result?.error?.message || t('loadFailed'));
  };
  const subscribe = fn => (typeof ctx.locale.subscribe === 'function' ? ctx.locale.subscribe(fn) : () => {});
  const revision = () => ctx.locale.getSnapshot?.()?.revision ?? 0;
  // 组件类型在插件生命周期内保持不变，切换语言只触发重绘。
  function Section() {
    useSyncExternalStore(subscribe, revision, revision);
    return <Settings call={call} t={t} />;
  }
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-remote-wecom',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({}),
  }, Section)), 'dsh-remote-wecom: settings section');

  // 设置弹窗没有公开「打开指定栏目」的接口：插件详情页的按钮改为在主区域打开同一面板。
  // layout 与两个槽位都是可选的，缺失时只保留设置入口。
  if (typeof ctx.inject !== 'function') return;
  function MainPanel() {
    return <div className="drw-main"><div className="drw-mainInner"><Section /></div></div>;
  }
  function OpenAction({subject, onOpen}) {
    useSyncExternalStore(subscribe, revision, revision);
    if (subject?.kind !== 'bundle' && subject?.kind !== 'row') return null;
    if (subject.pkg?.name !== PACKAGE) return null;
    if (subject.kind === 'row' && subject.row?.moduleName !== PACKAGE) return null;
    return <button type="button" className="drw-open" onClick={onOpen}>{t('openSettings')}</button>;
  }
  ctx.inject(['layout'], pageCtx => pageCtx.slots.inject('main', () => {
    const stopPage = pageCtx.slots.register({name: 'main', key: MAIN_PANEL, locale: NS, inject: () => ({})}, MainPanel);
    const stopAction = pageCtx.slots.inject('plugins.detail.actions', () => pageCtx.slots.register({
      name: 'plugins.detail.actions', id: `${MAIN_PANEL}-open`, order: 20, locale: NS,
      inject: () => ({onOpen: () => pageCtx.layout.selectPanel(MAIN_PANEL)}),
    }, OpenAction));
    return () => { stopAction(); stopPage(); };
  }));
}
