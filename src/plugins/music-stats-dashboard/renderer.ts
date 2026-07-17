import type { StatsData, StatsRange } from './types';
import type { RendererContext } from '@/types/contexts';

let ipc: RendererContext<{ enabled: boolean }>['ipc'] | null = null;
let keydownHandler: ((event: KeyboardEvent) => void) | null = null;

const OVERLAY_LOCK_CLASS = 'music-stats-overlay-open';

const isVideoId = (id?: string | null) =>
  !!id && /^[a-zA-Z0-9_-]{11}$/.test(id);

// ─── Lifecycle ─────────────────────────────────────────────────────────
// All playback tracking happens in the main process via the song-info
// provider; the renderer is purely UI.

export function start(context: RendererContext<{ enabled: boolean }>) {
  ipc = context.ipc;
  setupIpcListeners();
}

export function stop() {
  teardownIpcListeners();
  closeOverlay();
  ipc = null;
}

export default start;

function setupIpcListeners() {
  ipc?.on('music-stats:show-wrapped', () => {
    showWrapped().catch(console.error);
  });

  ipc?.on('music-stats:show-dashboard', () => {
    showDashboard().catch(console.error);
  });

  ipc?.on('music-stats:export', async () => {
    try {
      const data = (await ipc?.invoke('music-stats:export-data')) as
        | string
        | null;
      if (!data) {
        showNotification('Nothing to export yet');
        return;
      }
      const saved = (await ipc?.invoke(
        'music-stats:save-export-file',
        data,
      )) as boolean;
      if (saved) showNotification('Stats exported successfully');
    } catch (error) {
      console.error('[Music Stats] Export failed:', error);
      showNotification('Failed to export stats');
    }
  });

  ipc?.on('music-stats:import', async () => {
    try {
      const data = (await ipc?.invoke('music-stats:load-import-file')) as
        | string
        | null;
      if (data) {
        const result = (await ipc?.invoke('music-stats:import-data', data)) as {
          added: number;
        } | null;
        showNotification(
          result
            ? `Imported ${result.added} new play${result.added === 1 ? '' : 's'}`
            : 'Import failed',
        );
      }
    } catch (error) {
      console.error('[Music Stats] Import failed:', error);
      showNotification('Failed to import stats');
    }
  });

  ipc?.on('music-stats:notify', (message: string) => {
    showNotification(String(message));
  });

  ipc?.on('music-stats:history-sync', async () => {
    try {
      showNotification('Syncing plays from other devices…');
      const result = (await ipc?.invoke('music-stats:history-sync')) as {
        message?: string;
      } | null;
      if (result?.message) showNotification(result.message);
    } catch (error) {
      console.error('[Music Stats] Device sync failed:', error);
      showNotification('Device sync failed');
    }
  });

  ipc?.on('music-stats:import-takeout', async () => {
    try {
      const data = (await ipc?.invoke('music-stats:load-import-file')) as
        | string
        | null;
      if (!data) return;
      showNotification('Importing Takeout history…');
      const result = (await ipc?.invoke(
        'music-stats:import-takeout',
        data,
      )) as { message?: string } | null;
      if (result?.message) showNotification(result.message);
    } catch (error) {
      console.error('[Music Stats] Takeout import failed:', error);
      showNotification('Takeout import failed');
    }
  });

  for (const action of ['connect', 'sync', 'disconnect'] as const) {
    ipc?.on(`music-stats:drive-${action}`, async () => {
      try {
        const result = (await ipc?.invoke(`music-stats:drive-${action}`)) as {
          message?: string;
        } | null;
        if (result?.message) showNotification(result.message);
      } catch (error) {
        console.error(`[Music Stats] Drive ${action} failed:`, error);
        showNotification(`Google Drive ${action} failed`);
      }
    });
  }
}

function teardownIpcListeners() {
  for (const channel of [
    'music-stats:show-wrapped',
    'music-stats:show-dashboard',
    'music-stats:export',
    'music-stats:import',
    'music-stats:notify',
    'music-stats:history-sync',
    'music-stats:import-takeout',
    'music-stats:drive-connect',
    'music-stats:drive-sync',
    'music-stats:drive-disconnect',
  ]) {
    ipc?.removeAllListeners(channel);
  }
}

// ─── Overlay management ────────────────────────────────────────────────

function lockScroll() {
  document.documentElement.classList.add(OVERLAY_LOCK_CLASS);
  document.body.classList.add(OVERLAY_LOCK_CLASS);
}

function unlockScroll() {
  document.documentElement.classList.remove(OVERLAY_LOCK_CLASS);
  document.body.classList.remove(OVERLAY_LOCK_CLASS);
}

function closeOverlay() {
  wrappedTeardown?.();
  document.getElementById('music-stats-overlay')?.remove();
  unlockScroll();
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
}

function openOverlay(viewClass: string): HTMLElement {
  closeOverlay();
  const overlay = document.createElement('div');
  overlay.id = 'music-stats-overlay';
  overlay.className = `music-stats-overlay ${viewClass}`;
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) closeOverlay();
  });
  lockScroll();
  document.body.appendChild(overlay);
  return overlay;
}

function bindOverlayKeys(handler: (event: KeyboardEvent) => void) {
  keydownHandler = handler;
  document.addEventListener('keydown', handler);
}

// ─── Shared helpers ────────────────────────────────────────────────────

async function fetchStats(range: StatsRange): Promise<StatsData | null> {
  if (!ipc) return null;
  try {
    return (await ipc.invoke('music-stats:get-stats', range)) as StatsData;
  } catch (error) {
    console.error('[Music Stats] Failed to fetch stats:', error);
    return null;
  }
}

/** Escapes text for safe use in both HTML content and attribute values. */
function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch] ?? ch,
  );
}

/** Only allow https images from YouTube/Google CDNs — anything else is dropped. */
function safeImageUrl(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    const host = parsed.hostname;
    const allowed =
      host === 'i.ytimg.com' ||
      host === 'music.youtube.com' ||
      host === 'www.gstatic.com' ||
      host.endsWith('.ggpht.com') ||
      host.endsWith('.googleusercontent.com');
    return allowed ? url : '';
  } catch {
    return '';
  }
}

/** Cover/avatar cell: image when we have a safe URL, initial letter otherwise. */
function thumbHtml(imageUrl: string | undefined, name: string): string {
  const safe = safeImageUrl(imageUrl);
  if (safe) {
    return `<img src="${escapeHtml(safe)}" alt="" loading="lazy" />`;
  }
  return `<span>${escapeHtml((name || '?').charAt(0).toUpperCase())}</span>`;
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

/** Format a local YYYY-MM-DD key without UTC parsing (which shifts days). */
function formatDateKey(key: string, withYear = true): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

function formatMinutes(minutes: number): string {
  if (minutes >= 600) {
    return `${(minutes / 60).toFixed(0)} h`;
  }
  if (minutes >= 100) {
    return `${(minutes / 60).toFixed(1)} h`;
  }
  return `${minutes} min`;
}

async function playSong(videoId: string) {
  if (!ipc || !isVideoId(videoId)) return;
  try {
    const ok = (await ipc.invoke('music-stats:play-song', videoId)) as boolean;
    showNotification(ok ? 'Playing next' : 'Could not queue this song');
  } catch {
    showNotification('Could not queue this song');
  }
}

function bindPlayButtons(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-play-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.playId;
      if (id) playSong(id).catch(console.error);
    });
  });
}

function showNotification(message: string) {
  const notification = document.createElement('div');
  notification.className = 'music-stats-notification';
  notification.textContent = message;
  document.body.appendChild(notification);

  requestAnimationFrame(() => notification.classList.add('show'));

  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// ─── Charts ────────────────────────────────────────────────────────────
// Single-series marks in one accent hue; identity comes from the card
// title, values from the hover tooltip. Grid and axes stay recessive.

interface ChartPoint {
  x: number;
  y: number;
  tip: string;
}

function chartShell(inner: string, width: number, height: number): string {
  return `
    <div class="msd-chart">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
        ${inner}
      </svg>
      <div class="msd-tooltip" aria-hidden="true"></div>
    </div>
  `;
}

function gridLines(
  width: number,
  height: number,
  pad: { t: number; r: number; b: number; l: number },
  maxValue: number,
): string {
  const lines: string[] = [];
  for (const frac of [0, 0.5, 1]) {
    const y = pad.t + ((1 - frac) * (height - pad.t - pad.b));
    lines.push(
      `<line class="msd-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${width - pad.r}" y2="${y.toFixed(1)}" />`,
      `<text class="msd-axis-label" x="${pad.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${Math.round(maxValue * frac)}</text>`,
    );
  }
  return lines.join('');
}

/** Hourly listening: a 2px line with a soft area fill and hover dots. */
function createClockChart(hourlyData: number[]): string {
  const hasActivity = hourlyData.some((m) => m > 0);
  if (!hasActivity) {
    return '<div class="msd-chart-empty">No listening activity in this period yet</div>';
  }

  const width = 640;
  const height = 220;
  const pad = { t: 16, r: 12, b: 28, l: 40 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const max = Math.max(...hourlyData, 1);

  const points: ChartPoint[] = hourlyData.map((minutes, hour) => ({
    x: pad.l + ((hour / 23) * plotW),
    y: pad.t + ((1 - (minutes / max)) * plotH),
    tip: `${`${hour}`.padStart(2, '0')}:00 – ${`${(hour + 1) % 24}`.padStart(2, '0')}:00 · ${Math.round(minutes)} min`,
  }));

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const baseline = height - pad.b;
  const area = `${line} L ${points[points.length - 1].x.toFixed(1)} ${baseline} L ${points[0].x.toFixed(1)} ${baseline} Z`;

  const dots = points
    .map(
      (p, hour) => `
        <circle class="msd-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3"
          style="display:${hourlyData[hour] > 0 ? '' : 'none'}"></circle>
        <circle class="msd-hit" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="12"
          data-tip="${escapeHtml(p.tip)}"
          data-x="${(p.x / width).toFixed(4)}" data-y="${(p.y / height).toFixed(4)}"></circle>
      `,
    )
    .join('');

  const ticks = [0, 6, 12, 18, 23]
    .map((hour) => {
      const x = pad.l + ((hour / 23) * plotW);
      return `<text class="msd-axis-label" x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${`${hour}`.padStart(2, '0')}:00</text>`;
    })
    .join('');

  return chartShell(
    `
      <defs>
        <linearGradient id="msd-area-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--msd-accent)" stop-opacity="0.28" />
          <stop offset="100%" stop-color="var(--msd-accent)" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      ${gridLines(width, height, pad, max)}
      <path class="msd-area" d="${area}" fill="url(#msd-area-fill)" />
      <path class="msd-line" d="${line}" />
      ${dots}
      ${ticks}
    `,
    width,
    height,
  );
}

/** Daily listening: thin bars, rounded data-ends, 2px gaps, hover tooltips. */
function createTrendChart(trend: StatsData['dailyTrend']): string {
  if (!trend.length || trend.every((d) => d.minutes === 0)) {
    return '<div class="msd-chart-empty">No listening activity in this period yet</div>';
  }

  const width = 640;
  const height = 220;
  const pad = { t: 16, r: 12, b: 28, l: 40 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const max = Math.max(...trend.map((d) => d.minutes), 1);
  const n = trend.length;
  const gap = 2;
  const barW = Math.max(2, (plotW / n) - gap);
  const radius = Math.min(4, barW / 2);
  const baseline = height - pad.b;

  const bars = trend
    .map((day, i) => {
      const x = pad.l + ((i / n) * plotW) + (gap / 2);
      const h = (day.minutes / max) * plotH;
      const y = baseline - h;
      const tip = `${formatDateKey(day.date, false)} · ${day.minutes} min`;
      const centerX = x + (barW / 2);
      // Bars are anchored flat on the baseline with rounded data-ends on top.
      const bar =
        day.minutes > 0
          ? `<path class="msd-bar" d="M ${x.toFixed(1)} ${baseline}
               V ${(y + radius).toFixed(1)}
               Q ${x.toFixed(1)} ${y.toFixed(1)} ${(x + radius).toFixed(1)} ${y.toFixed(1)}
               H ${(x + barW - radius).toFixed(1)}
               Q ${(x + barW).toFixed(1)} ${y.toFixed(1)} ${(x + barW).toFixed(1)} ${(y + radius).toFixed(1)}
               V ${baseline} Z" />`
          : `<rect class="msd-bar-zero" x="${x.toFixed(1)}" y="${baseline - 2}" width="${barW.toFixed(1)}" height="2" />`;
      return `
        ${bar}
        <rect class="msd-hit" x="${x.toFixed(1)}" y="${pad.t}" width="${barW.toFixed(1)}" height="${plotH}"
          data-tip="${escapeHtml(tip)}"
          data-x="${(centerX / width).toFixed(4)}" data-y="${(Math.max(y, pad.t) / height).toFixed(4)}"></rect>
      `;
    })
    .join('');

  const tickEvery = n > 10 ? 7 : 1;
  const ticks = trend
    .map((day, i) => {
      const isLast = i === n - 1;
      if (i % tickEvery !== 0 && !isLast) return '';
      const x = pad.l + ((i / n) * plotW) + (gap / 2) + (barW / 2);
      return `<text class="msd-axis-label" x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${escapeHtml(formatDateKey(day.date, false))}</text>`;
    })
    .join('');

  return chartShell(
    `${gridLines(width, height, pad, max)}${bars}${ticks}`,
    width,
    height,
  );
}

function bindChartTooltips(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.msd-chart').forEach((chart) => {
    const svg = chart.querySelector<SVGSVGElement>('svg');
    const tooltip = chart.querySelector<HTMLElement>('.msd-tooltip');
    if (!svg || !tooltip) return;

    svg.addEventListener('mousemove', (event) => {
      const target = (event.target as Element | null)?.closest<SVGElement>(
        '.msd-hit',
      );
      if (!target) {
        tooltip.classList.remove('show');
        return;
      }
      const rect = svg.getBoundingClientRect();
      tooltip.textContent = target.dataset.tip ?? '';
      tooltip.style.left = `${rect.width * Number(target.dataset.x || 0)}px`;
      tooltip.style.top = `${(rect.height * Number(target.dataset.y || 0)) - 10}px`;
      tooltip.classList.add('show');
    });

    svg.addEventListener('mouseleave', () => {
      tooltip.classList.remove('show');
    });
  });
}

// ─── Dashboard ─────────────────────────────────────────────────────────

const RANGE_LABELS: Record<StatsRange, string> = {
  week: '7 days',
  month: '30 days',
  year: 'This year',
  all: 'All time',
};

async function showDashboard() {
  const initialRange: StatsRange = 'month';
  const stats = await fetchStats(initialRange);
  if (!stats) {
    showNotification('Stats are not ready yet — try again in a moment');
    return;
  }

  const overlay = openOverlay('dashboard-view');
  overlay.innerHTML = `
    <div class="dashboard-container">
      <header class="dashboard-header">
        <div>
          <div class="dashboard-eyebrow">Music Stats</div>
          <h1 class="dashboard-title">Your listening</h1>
        </div>
        <div class="dashboard-controls">
          <div class="range-tabs" role="tablist" aria-label="Time range">
            ${(Object.keys(RANGE_LABELS) as StatsRange[])
              .map(
                (range) => `
                  <button class="range-tab${range === initialRange ? ' active' : ''}"
                    role="tab" aria-selected="${range === initialRange}"
                    data-range="${range}">${RANGE_LABELS[range]}</button>
                `,
              )
              .join('')}
          </div>
          <button class="overlay-close" aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      </header>
      <main class="dashboard-body"></main>
    </div>
  `;

  const body = overlay.querySelector<HTMLElement>('.dashboard-body');
  const renderBody = (data: StatsData) => {
    if (!body) return;
    body.innerHTML = renderDashboardBody(data);
    bindChartTooltips(body);
    bindPlayButtons(body);
  };
  renderBody(stats);

  overlay
    .querySelector('.overlay-close')
    ?.addEventListener('click', closeOverlay);

  overlay.querySelectorAll<HTMLElement>('.range-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      const range = tab.dataset.range as StatsRange;
      const next = await fetchStats(range);
      if (!next) return;
      overlay.querySelectorAll('.range-tab').forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      renderBody(next);
    });
  });

  bindOverlayKeys((event) => {
    if (event.key === 'Escape') closeOverlay();
  });
}

function renderDashboardBody(stats: StatsData): string {
  if (stats.totalMinutes === 0 && stats.totalPlays === 0) {
    return `
      <div class="msd-empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
        <h2>Nothing here yet</h2>
        <p>Play some music and your stats will start filling in.
        Songs count after 30 seconds of listening.</p>
      </div>
    `;
  }

  const streakLabel =
    stats.currentStreak === 1 ? '1 day' : `${stats.currentStreak} days`;

  const tiles = [
    { label: 'Minutes', value: formatNumber(stats.totalMinutes) },
    { label: 'Plays', value: formatNumber(stats.totalPlays) },
    { label: 'Songs', value: formatNumber(stats.uniqueSongs) },
    { label: 'Artists', value: formatNumber(stats.uniqueArtists) },
    { label: 'Streak', value: streakLabel },
    ...(stats.peakListeningDay
      ? [
          {
            label: 'Peak day',
            value: formatMinutes(stats.peakListeningDay.minutes),
            sub: formatDateKey(stats.peakListeningDay.date),
          },
        ]
      : []),
  ];

  const songRows = stats.topSongs
    .map(
      (song, idx) => `
        <li class="list-row">
          <span class="list-rank">${idx + 1}</span>
          <span class="list-thumb square">${thumbHtml(song.imageUrl, song.title)}</span>
          <span class="list-text">
            <span class="list-title">${escapeHtml(song.title)}</span>
            <span class="list-sub">${escapeHtml(song.artist)}</span>
          </span>
          <span class="list-stat">
            <span class="list-stat-strong">${formatNumber(song.plays)} plays</span>
            <span class="list-stat-sub">${formatMinutes(song.minutes)}</span>
          </span>
          ${
            isVideoId(song.id)
              ? `<button class="list-play" data-play-id="${escapeHtml(song.id)}" aria-label="Play ${escapeHtml(song.title)}">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>`
              : ''
          }
        </li>
      `,
    )
    .join('');

  const artistRows = stats.topArtists
    .map(
      (artist, idx) => `
        <li class="list-row">
          <span class="list-rank">${idx + 1}</span>
          <span class="list-thumb round">${thumbHtml(artist.imageUrl, artist.name)}</span>
          <span class="list-text">
            <span class="list-title">${escapeHtml(artist.name)}</span>
            <span class="list-sub">${formatNumber(artist.plays)} plays</span>
          </span>
          <span class="list-stat">
            <span class="list-stat-strong">${formatMinutes(artist.minutes)}</span>
          </span>
        </li>
      `,
    )
    .join('');

  const skippedRows = stats.skipStats
    .slice(0, 5)
    .map(
      (song) => `
        <li class="list-row">
          <span class="list-thumb square">${thumbHtml(song.imageUrl, song.title)}</span>
          <span class="list-text">
            <span class="list-title">${escapeHtml(song.title)}</span>
            <span class="list-sub">${escapeHtml(song.artist)}</span>
          </span>
          <span class="list-stat">
            <span class="list-stat-strong">${formatNumber(song.skips)} skip${song.skips === 1 ? '' : 's'}</span>
            <span class="list-stat-sub">${formatNumber(song.plays)} full play${song.plays === 1 ? '' : 's'}</span>
          </span>
        </li>
      `,
    )
    .join('');

  return `
    <section class="stat-tiles">
      ${tiles
        .map(
          (tile) => `
            <div class="stat-tile">
              <div class="stat-tile-label">${escapeHtml(tile.label)}</div>
              <div class="stat-tile-value">${escapeHtml(tile.value)}</div>
              ${'sub' in tile && tile.sub ? `<div class="stat-tile-sub">${escapeHtml(tile.sub)}</div>` : ''}
            </div>
          `,
        )
        .join('')}
    </section>

    <section class="dashboard-grid">
      <div class="dashboard-card span-2">
        <h3 class="card-title">Daily listening <span class="card-title-sub">minutes per day</span></h3>
        ${createTrendChart(stats.dailyTrend)}
      </div>

      <div class="dashboard-card">
        <h3 class="card-title">Top songs</h3>
        ${songRows ? `<ol class="msd-list">${songRows}</ol>` : '<div class="msd-chart-empty">No plays in this period</div>'}
      </div>

      <div class="dashboard-card">
        <h3 class="card-title">Top artists</h3>
        ${artistRows ? `<ol class="msd-list">${artistRows}</ol>` : '<div class="msd-chart-empty">No plays in this period</div>'}
      </div>

      <div class="dashboard-card span-2">
        <h3 class="card-title">Time of day <span class="card-title-sub">minutes per hour</span></h3>
        ${createClockChart(stats.listeningClock)}
      </div>

      ${
        skippedRows
          ? `
        <div class="dashboard-card span-2">
          <h3 class="card-title">Most skipped</h3>
          <ol class="msd-list two-col">${skippedRows}</ol>
        </div>
      `
          : ''
      }
    </section>
  `;
}

// ─── Wrapped ───────────────────────────────────────────────────────────
// Story-mode experience: auto-advancing slides with segmented progress,
// count-up numbers, staggered reveals, a drumroll anthem, and a share card.

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface WrappedSlide {
  html: string;
  /** Auto-advance time in ms; 0 = stay (finale). */
  duration: number;
  /** Backdrop mood: 'hero' slides get the collage + strong glow. */
  theme: 'hero' | 'warm' | 'dim';
}

// Cleanup for timers/raf owned by the wrapped view, run on close.
let wrappedTeardown: (() => void) | null = null;

async function showWrapped() {
  const stats = await fetchStats('year');
  if (!stats) {
    showNotification('Stats are not ready yet — try again in a moment');
    return;
  }
  if (stats.totalPlays === 0) {
    showNotification('Not enough listening this year for a Wrapped yet');
    return;
  }
  createWrappedView(stats);
}

function createWrappedView(stats: StatsData) {
  const overlay = openOverlay('wrapped-view');
  const slides = createWrappedSlides(stats);
  const reducedMotion = prefersReducedMotion();

  let current = 0;
  let paused = false;
  let slideStart = 0;
  let elapsedBefore = 0;
  let rafId = 0;
  let slideCleanups: Array<() => void> = [];

  overlay.innerHTML = `
    <div class="wrapped-backdrop">
      <div class="wrapped-glow"></div>
      ${collageHtml(stats)}
    </div>
    <div class="wrapped-progress-rail" role="tablist" aria-label="Slides">
      ${slides
        .map(
          (_, i) =>
            `<button class="wrapped-seg" data-seg="${i}" aria-label="Slide ${i + 1}"><span></span></button>`,
        )
        .join('')}
    </div>
    <div class="wrapped-stage"></div>
    <nav class="wrapped-navigation">
      <button class="wrapped-nav-btn" data-nav="prev">← Back</button>
      <button class="wrapped-nav-btn wrapped-pause" data-nav="pause" aria-label="Pause">❚❚</button>
      <button class="wrapped-nav-btn primary" data-nav="next">Next →</button>
    </nav>
    <button class="overlay-close wrapped-close" aria-label="Close">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  `;

  const stage = overlay.querySelector<HTMLElement>('.wrapped-stage')!;
  const segFills = [
    ...overlay.querySelectorAll<HTMLElement>('.wrapped-seg span'),
  ];
  const prevBtn = overlay.querySelector<HTMLButtonElement>('[data-nav="prev"]')!;
  const nextBtn = overlay.querySelector<HTMLButtonElement>('[data-nav="next"]')!;
  const pauseBtn = overlay.querySelector<HTMLButtonElement>(
    '[data-nav="pause"]',
  )!;

  const stopTimer = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  };

  const tick = () => {
    const duration = slides[current].duration;
    if (!duration || paused || reducedMotion) return;
    const elapsed = elapsedBefore + (performance.now() - slideStart);
    const frac = Math.min(1, elapsed / duration);
    segFills[current].style.transform = `scaleX(${frac})`;
    if (frac >= 1) {
      goTo(current + 1, 1);
      return;
    }
    rafId = requestAnimationFrame(tick);
  };

  const startTimer = () => {
    stopTimer();
    slideStart = performance.now();
    if (slides[current].duration && !reducedMotion && !paused) {
      rafId = requestAnimationFrame(tick);
    }
  };

  const setPaused = (value: boolean) => {
    if (paused === value) return;
    if (value) {
      elapsedBefore += performance.now() - slideStart;
      stopTimer();
    } else {
      slideStart = performance.now();
      rafId = requestAnimationFrame(tick);
    }
    paused = value;
    pauseBtn.textContent = value ? '▶' : '❚❚';
    pauseBtn.setAttribute('aria-label', value ? 'Resume' : 'Pause');
  };

  const goTo = (index: number, dir: 1 | -1) => {
    const next = Math.max(0, Math.min(slides.length - 1, index));
    if (next === current && index !== 0) return;
    current = next;

    for (const cleanup of slideCleanups) cleanup();
    slideCleanups = [];
    stopTimer();
    elapsedBefore = 0;

    // Progress rail: everything before is done, after is empty.
    segFills.forEach((fill, i) => {
      fill.style.transform =
        i < current ? 'scaleX(1)' : i === current ? 'scaleX(0)' : 'scaleX(0)';
    });

    const slide = slides[current];
    overlay.dataset.theme = slide.theme;

    const container = document.createElement('div');
    container.className = `wrapped-container enter-${dir > 0 ? 'right' : 'left'}`;
    container.innerHTML = slide.html;
    stage.innerHTML = '';
    stage.appendChild(container);
    requestAnimationFrame(() => container.classList.add('slide-in'));

    bindPlayButtons(container);
    slideCleanups.push(
      bindCountUps(container, reducedMotion),
      bindReveals(container),
      bindDrumroll(container, reducedMotion),
      bindConfetti(container, reducedMotion),
      bindShareCard(container, stats),
    );

    prevBtn.disabled = current === 0;
    const isLast = current === slides.length - 1;
    nextBtn.textContent = isLast ? 'Close' : 'Next →';
    pauseBtn.style.visibility =
      slide.duration && !reducedMotion ? 'visible' : 'hidden';
    if (isLast) segFills[current].style.transform = 'scaleX(1)';

    startTimer();
  };

  prevBtn.addEventListener('click', () => goTo(current - 1, -1));
  nextBtn.addEventListener('click', () => {
    if (current === slides.length - 1) closeOverlay();
    else goTo(current + 1, 1);
  });
  pauseBtn.addEventListener('click', () => setPaused(!paused));
  overlay
    .querySelector('.wrapped-close')
    ?.addEventListener('click', closeOverlay);

  overlay.querySelectorAll<HTMLElement>('.wrapped-seg').forEach((seg) => {
    seg.addEventListener('click', () => {
      const index = Number(seg.dataset.seg || 0);
      goTo(index, index >= current ? 1 : -1);
    });
  });

  // Hold anywhere on the slide to pause, release to resume — story style.
  let holdPaused = false;
  stage.addEventListener('pointerdown', (event) => {
    if ((event.target as Element).closest('button')) return;
    if (!paused) {
      holdPaused = true;
      setPaused(true);
    }
  });
  const releaseHold = () => {
    if (holdPaused) {
      holdPaused = false;
      setPaused(false);
    }
  };
  window.addEventListener('pointerup', releaseHold);
  window.addEventListener('pointercancel', releaseHold);

  bindOverlayKeys((event) => {
    if (event.key === 'Escape') closeOverlay();
    else if (event.key === 'ArrowRight') goTo(current + 1, 1);
    else if (event.key === 'ArrowLeft') goTo(current - 1, -1);
    else if (event.key === ' ') {
      event.preventDefault();
      setPaused(!paused);
    }
  });

  wrappedTeardown = () => {
    stopTimer();
    for (const cleanup of slideCleanups) cleanup();
    slideCleanups = [];
    window.removeEventListener('pointerup', releaseHold);
    window.removeEventListener('pointercancel', releaseHold);
    wrappedTeardown = null;
  };

  goTo(0, 1);
}

// ─── Slide effects ─────────────────────────────────────────────────────

/** Animates every [data-count] element from 0 to its value. */
function bindCountUps(container: HTMLElement, reducedMotion: boolean) {
  const timers: number[] = [];
  container.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count || 0);
    const suffix = el.dataset.suffix ?? '';
    const format = (value: number) => `${formatNumber(value)}${suffix}`;
    if (reducedMotion || target <= 0) {
      el.textContent = format(target);
      return;
    }
    const duration = 1500;
    const startAt = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startAt) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(Math.round(target * eased));
      if (t < 1) timers.push(requestAnimationFrame(step));
    };
    timers.push(requestAnimationFrame(step));
  });
  return () => timers.forEach((id) => cancelAnimationFrame(id));
}

/** Assigns stagger indices so .reveal items cascade in via CSS. */
function bindReveals(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>('.reveal').forEach((el, i) => {
    el.style.setProperty('--ri', `${i}`);
  });
  return () => {};
}

/** The anthem suspense: blurred art, then the reveal. */
function bindDrumroll(container: HTMLElement, reducedMotion: boolean) {
  const target = container.querySelector<HTMLElement>('[data-drumroll]');
  if (!target) return () => {};
  if (reducedMotion) {
    target.classList.add('revealed');
    return () => {};
  }
  const id = window.setTimeout(() => target.classList.add('revealed'), 2200);
  return () => window.clearTimeout(id);
}

/** A short confetti burst in the accent palette. */
function bindConfetti(container: HTMLElement, reducedMotion: boolean) {
  const host = container.querySelector<HTMLElement>('[data-confetti]');
  if (!host || reducedMotion) return () => {};

  const canvas = document.createElement('canvas');
  canvas.className = 'wrapped-confetti';
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  const size = () => {
    canvas.width = host.clientWidth;
    canvas.height = host.clientHeight;
  };
  size();

  const colors = ['#ff4b3e', '#ff7a3e', '#ffd0cb', '#c93a30', '#f1f1f1'];
  const particles = Array.from({ length: 130 }, () => ({
    x: (canvas.width / 2) + ((Math.random() - 0.5) * canvas.width * 0.4),
    y: canvas.height * 0.35,
    vx: (Math.random() - 0.5) * 11,
    vy: (Math.random() * -10) - 4,
    size: 4 + (Math.random() * 6),
    color: colors[Math.floor(Math.random() * colors.length)],
    spin: Math.random() * Math.PI,
    spinV: (Math.random() - 0.5) * 0.25,
  }));

  let rafId = 0;
  const startAt = performance.now();
  const frame = (now: number) => {
    const t = (now - startAt) / 1000;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (t > 3.2) return;
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35;
      p.spin += p.spinV;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      ctx.globalAlpha = Math.max(0, 1 - (t / 3));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(rafId);
    canvas.remove();
  };
}

function bindShareCard(container: HTMLElement, stats: StatsData) {
  const btn = container.querySelector<HTMLElement>('[data-share-card]');
  if (!btn) return () => {};
  const handler = () => {
    showNotification('Rendering your card…');
    renderShareCard(stats).catch(() => {
      showNotification('Could not render the share card');
    });
  };
  btn.addEventListener('click', handler);
  return () => btn.removeEventListener('click', handler);
}

/** Floating cover collage built from the user's own artwork. */
function collageHtml(stats: StatsData): string {
  const urls = new Set<string>();
  const add = (url?: string) => {
    const safe = safeImageUrl(url);
    if (safe) urls.add(safe);
  };
  stats.topSongs.forEach((s) => add(s.imageUrl));
  stats.topAlbums.forEach((a) => add(a.imageUrl));
  stats.seasons.forEach((s) => add(s.imageUrl));
  stats.topArtists.forEach((a) => add(a.imageUrl));
  stats.skipStats.slice(0, 4).forEach((s) => add(s.imageUrl));
  add(stats.newArtists.topImageUrl);

  const tiles = [...urls].slice(0, 14);
  if (!tiles.length) return '';
  return `
    <div class="wrapped-collage" aria-hidden="true">
      ${tiles
        .map(
          (src, i) =>
            `<img class="collage-tile ct-${i}" src="${escapeHtml(src)}" alt="" loading="lazy" />`,
        )
        .join('')}
    </div>
  `;
}

// ─── Slides ────────────────────────────────────────────────────────────

function createWrappedSlides(stats: StatsData): WrappedSlide[] {
  const slides: WrappedSlide[] = [];
  const now = new Date();
  const year = now.getFullYear();
  const totalDays = (stats.totalMinutes / 60 / 24).toFixed(1);
  const topSong = stats.topSongs[0];
  const runnerUps = stats.topSongs.slice(1, 5);
  const topArtists = stats.topArtists;
  const monthName = now.toLocaleDateString('en-US', { month: 'long' });
  const isDecember = now.getMonth() === 11;

  // Chronotype
  const listeningClock = stats.listeningClock ?? new Array(24).fill(0);
  const hasClock = listeningClock.some((m) => m > 0);
  const peakHour = hasClock
    ? listeningClock.indexOf(Math.max(...listeningClock))
    : -1;
  const chronotype =
    peakHour < 0
      ? 'Mystery'
      : peakHour >= 22 || peakHour <= 4
        ? 'Night Owl'
        : peakHour <= 10
          ? 'Early Bird'
          : 'Day Groover';
  const afterMidnight = Math.round(
    listeningClock.slice(0, 4).reduce((sum, m) => sum + m, 0),
  );

  // Archetype
  const totalPlays = Math.max(1, stats.totalPlays);
  const varietyScore = Math.round((stats.uniqueSongs / totalPlays) * 100);
  const topFivePlays = topArtists.reduce((sum, a) => sum + a.plays, 0);
  const obsessionScore = Math.round((topFivePlays / totalPlays) * 100);
  const topArtistName = topArtists[0]?.name ?? 'your favorites';
  const archetype =
    varietyScore >= 70
      ? 'Trailblazer'
      : varietyScore >= 55
        ? 'Wanderer'
        : obsessionScore >= 55
          ? 'Superfan'
          : obsessionScore >= 35
            ? 'Loyalist'
            : 'Balancer';
  const auraClass =
    varietyScore >= 55
      ? 'aura-explorer'
      : obsessionScore >= 35
        ? 'aura-superfan'
        : 'aura-drifter';

  const monthly = stats.monthlyObsessions.filter((m) =>
    m.yearMonth.startsWith(`${year}-`),
  );
  const firstSongYear = stats.firstSongThisYear;

  // 1. Intro
  slides.push({
    theme: 'hero',
    duration: 6000,
    html: `
      <div class="wrapped-slide wrapped-intro">
        <div class="wrapped-eyebrow reveal">Music Stats · Wrapped</div>
        <h1 class="wrapped-title reveal">${year} sounded<br/>like this.</h1>
        <p class="wrapped-subtitle reveal">${isDecember ? 'Your year in music.' : `January through ${monthName} — your ${year} so far.`}</p>
      </div>
    `,
  });

  // 2. Timekeeper
  slides.push({
    theme: 'warm',
    duration: 7500,
    html: `
      <div class="wrapped-slide">
        <div class="wrapped-eyebrow reveal">The Timekeeper</div>
        <div class="wrapped-stat-large reveal" data-count="${stats.totalMinutes}">0</div>
        <div class="wrapped-label reveal">minutes this year</div>
        <p class="wrapped-text reveal">That's <strong>${totalDays} days</strong> of non-stop music across
        <strong>${formatNumber(stats.uniqueSongs)}</strong> different songs.</p>
        ${
          stats.peakListeningDay
            ? `<p class="wrapped-text subtle reveal">Your biggest day was <strong>${formatDateKey(stats.peakListeningDay.date)}</strong> — ${formatMinutes(stats.peakListeningDay.minutes)} of music.</p>`
            : ''
        }
      </div>
    `,
  });

  // 3. Chronotype (+ after midnight)
  if (hasClock) {
    slides.push({
      theme: 'dim',
      duration: 7500,
      html: `
        <div class="wrapped-slide">
          <div class="wrapped-eyebrow reveal">The Chronotype</div>
          <h2 class="wrapped-heading reveal">${chronotype}</h2>
          <p class="wrapped-text reveal">Your music peaks around <strong>${`${peakHour}`.padStart(2, '0')}:00</strong>.${
            afterMidnight > 0
              ? ` And <strong>${formatNumber(afterMidnight)} minutes</strong> of it played after midnight.`
              : ''
          }</p>
          <div class="wrapped-chronotype reveal">${createChronotypeTimeline(listeningClock, peakHour)}</div>
        </div>
      `,
    });
  }

  // 4. Aura
  slides.push({
    theme: 'hero',
    duration: 7000,
    html: `
      <div class="wrapped-slide">
        <div class="wrapped-eyebrow reveal">The Listening Aura</div>
        <div class="wrapped-aura ${auraClass} reveal"><div class="aura-orb"></div></div>
        <h2 class="wrapped-heading reveal">You're a ${archetype}.</h2>
        <p class="wrapped-text reveal">
          ${
            varietyScore >= 55
              ? `You wandered across <strong>${formatNumber(stats.uniqueSongs)}</strong> unique songs — always hunting something new.`
              : `${obsessionScore}% of your plays came from your top artists, led by <strong>${escapeHtml(topArtistName)}</strong>.`
          }
        </p>
      </div>
    `,
  });

  // 5. The Discovery
  if (stats.newArtists.count > 0 && stats.newArtists.topName) {
    slides.push({
      theme: 'warm',
      duration: 7500,
      html: `
        <div class="wrapped-slide">
          <div class="wrapped-eyebrow reveal">The Discovery</div>
          <div class="wrapped-stat-large reveal" data-count="${stats.newArtists.count}">0</div>
          <div class="wrapped-label reveal">new artists this year</div>
          <div class="discovery-artist reveal">
            <span class="discovery-avatar">${thumbHtml(stats.newArtists.topImageUrl, stats.newArtists.topName)}</span>
            <span class="discovery-meta">
              <span class="discovery-name">${escapeHtml(stats.newArtists.topName)}</span>
              <span class="discovery-sub">your favorite find · ${formatMinutes(stats.newArtists.topMinutes ?? 0)}</span>
            </span>
          </div>
        </div>
      `,
    });
  }

  // 6. The Obsessions — every month visible, no hidden controls.
  if (monthly.length > 0) {
    const maxMinutes = Math.max(...monthly.map((m) => m.minutes), 1);
    slides.push({
      theme: 'warm',
      duration: 9000,
      html: `
        <div class="wrapped-slide">
          <div class="wrapped-eyebrow reveal">The Obsessions</div>
          <h2 class="wrapped-heading reveal">One artist ruled each month</h2>
          <div class="months-grid">
            ${monthly
              .map((m) => {
                const [yy, mm] = m.yearMonth.split('-').map(Number);
                const label = new Date(yy, mm - 1, 1).toLocaleDateString(
                  'en-US',
                  { month: 'short' },
                );
                const isTop = m.minutes === maxMinutes;
                return `
                  <div class="month-row reveal${isTop ? ' top' : ''}">
                    <span class="month-label">${escapeHtml(label)}</span>
                    <span class="month-artist">${escapeHtml(m.artist)}</span>
                    <span class="month-bar"><span style="width:${Math.max(6, Math.round((m.minutes / maxMinutes) * 100))}%"></span></span>
                    <span class="month-minutes">${formatMinutes(m.minutes)}</span>
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>
      `,
    });
  }

  // 7. The Binge
  if (stats.binge) {
    const binge = stats.binge;
    slides.push({
      theme: 'hero',
      duration: 8500,
      html: `
        <div class="wrapped-slide">
          <div class="wrapped-eyebrow reveal">The Binge</div>
          <div class="binge-art reveal">${thumbHtml(binge.imageUrl, binge.title)}</div>
          <p class="wrapped-text big reveal">On <strong>${formatDateKey(binge.date, false)}</strong> you played
          <strong>${escapeHtml(binge.title)}</strong><br/>${binge.plays} times in one day.</p>
          <p class="wrapped-text subtle reveal">We don't judge.</p>
          <div class="binge-calendar reveal">${calendarHtml(binge.date)}</div>
        </div>
      `,
    });
  }

  // 8. The Seasons
  if (stats.seasons.length > 1) {
    slides.push({
      theme: 'warm',
      duration: 8500,
      html: `
        <div class="wrapped-slide">
          <div class="wrapped-eyebrow reveal">The Seasons</div>
          <h2 class="wrapped-heading reveal">Every season had its anthem</h2>
          <div class="seasons-list">
            ${stats.seasons
              .map(
                (s) => `
                  <div class="season-row reveal">
                    <span class="season-chip">${escapeHtml(s.season)}</span>
                    <span class="season-art">${thumbHtml(s.imageUrl, s.title)}</span>
                    <span class="season-meta">
                      <span class="season-title">${escapeHtml(s.title)}</span>
                      <span class="season-artist">${escapeHtml(s.artist)}</span>
                    </span>
                    <span class="season-plays">${formatNumber(s.plays)} plays</span>
                  </div>
                `,
              )
              .join('')}
          </div>
        </div>
      `,
    });
  }

  // 9. Top Albums
  if (stats.topAlbums.length > 0) {
    slides.push({
      theme: 'dim',
      duration: 8500,
      html: `
        <div class="wrapped-slide">
          <div class="wrapped-eyebrow reveal">The Records</div>
          <h2 class="wrapped-heading reveal">Your top albums</h2>
          <div class="albums-list">
            ${stats.topAlbums
              .map(
                (album, idx) => `
                  <div class="album-row reveal">
                    <span class="album-rank">#${idx + 1}</span>
                    <span class="album-art">${thumbHtml(album.imageUrl, album.name)}</span>
                    <span class="album-meta">
                      <span class="album-name">${escapeHtml(album.name)}</span>
                      <span class="album-artist">${escapeHtml(album.artist)}</span>
                    </span>
                    <span class="album-minutes">${formatMinutes(album.minutes)}</span>
                  </div>
                `,
              )
              .join('')}
          </div>
        </div>
      `,
    });
  }

  // 10. Honest stats
  slides.push({
    theme: 'dim',
    duration: 8000,
    html: `
      <div class="wrapped-slide">
        <div class="wrapped-eyebrow reveal">The Honest Stats</div>
        <div class="wrapped-honest">
          ${
            firstSongYear
              ? `
            <div class="honest-card reveal">
              <div class="honest-label">First song of ${year}</div>
              <div class="honest-value">${escapeHtml(firstSongYear.title)}</div>
              <div class="honest-sub">${escapeHtml(firstSongYear.artist)} · ${formatDateKey(firstSongYear.date, false)}</div>
            </div>
          `
              : ''
          }
          <div class="honest-card reveal">
            <div class="honest-label">Skip rate</div>
            <div class="honest-value"><span data-count="${stats.skipRate}" data-suffix="%">0%</span></div>
            <div class="honest-sub">didn't make the cut</div>
          </div>
          <div class="honest-card reveal">
            <div class="honest-label">Finished</div>
            <div class="honest-value"><span data-count="${stats.completionRate}" data-suffix="%">0%</span></div>
            <div class="honest-sub">of songs played to the end</div>
          </div>
          ${
            stats.currentStreak > 1
              ? `
            <div class="honest-card reveal">
              <div class="honest-label">Current streak</div>
              <div class="honest-value">${stats.currentStreak} days</div>
              <div class="honest-sub">of listening in a row</div>
            </div>
          `
              : ''
          }
        </div>
      </div>
    `,
  });

  // 11. Hall of Fame
  if (topArtists.length > 0) {
    slides.push({
      theme: 'warm',
      duration: 8000,
      html: `
        <div class="wrapped-slide">
          <div class="wrapped-eyebrow reveal">Hall of Fame</div>
          <h2 class="wrapped-heading reveal">Your top artists</h2>
          <div class="wrapped-artist-grid">
            ${topArtists
              .map(
                (artist, idx) => `
                  <div class="artist-card reveal${idx === 0 ? ' first' : ''}">
                    <div class="artist-rank">#${idx + 1}</div>
                    <div class="artist-avatar">${thumbHtml(artist.imageUrl, artist.name)}</div>
                    <div class="artist-name">${escapeHtml(artist.name)}</div>
                    <div class="artist-minutes">${formatMinutes(artist.minutes)}</div>
                  </div>
                `,
              )
              .join('')}
          </div>
        </div>
      `,
    });
  }

  // 12. Soundtrack (runner-ups)
  if (runnerUps.length > 0) {
    slides.push({
      theme: 'warm',
      duration: 8000,
      html: `
        <div class="wrapped-slide">
          <div class="wrapped-eyebrow reveal">The Soundtrack</div>
          <h2 class="wrapped-heading reveal">Almost your anthem</h2>
          <div class="wrapped-songlist">
            ${runnerUps
              .map(
                (song, idx) => `
                  <div class="song-row reveal">
                    <div class="song-rank">#${idx + 2}</div>
                    <div class="song-art">${thumbHtml(song.imageUrl, song.title)}</div>
                    <div class="song-meta">
                      <div class="song-title">${escapeHtml(song.title)}</div>
                      <div class="song-artist">${escapeHtml(song.artist)}</div>
                    </div>
                    <div class="song-plays">${formatNumber(song.plays)} plays</div>
                    ${
                      isVideoId(song.id)
                        ? `<button class="song-play" data-play-id="${escapeHtml(song.id)}">Play</button>`
                        : ''
                    }
                  </div>
                `,
              )
              .join('')}
          </div>
        </div>
      `,
    });
  }

  // 13. Anthem (drumroll)
  if (topSong) {
    const anthemArt = safeImageUrl(
      topSong.imageUrl ||
        (isVideoId(topSong.id)
          ? `https://i.ytimg.com/vi/${topSong.id}/hqdefault.jpg`
          : ''),
    );
    slides.push({
      theme: 'hero',
      duration: 12000,
      html: `
        <div class="wrapped-slide wrapped-anthem-final" data-drumroll>
          <div class="anthem-art">
            ${
              anthemArt
                ? `<img src="${escapeHtml(anthemArt)}" alt="" />`
                : '<div class="anthem-placeholder"></div>'
            }
          </div>
          <div class="anthem-content">
            <div class="wrapped-eyebrow anthem-tease">Your #1 song was…</div>
            <div class="anthem-reveal">
              <div class="anthem-title">${escapeHtml(topSong.title)}</div>
              <div class="anthem-artist">${escapeHtml(topSong.artist)}</div>
              <div class="anthem-stats">
                <div class="anthem-stat"><strong>${formatNumber(topSong.plays)}</strong> plays</div>
                <div class="anthem-stat"><strong>${formatMinutes(topSong.minutes)}</strong> together</div>
              </div>
              ${
                isVideoId(topSong.id)
                  ? `<button class="wrapped-btn primary" data-play-id="${escapeHtml(topSong.id)}">Play it again</button>`
                  : ''
              }
            </div>
          </div>
        </div>
      `,
    });
  }

  // 14. Finale — recap + share, stays open.
  slides.push({
    theme: 'hero',
    duration: 0,
    html: `
      <div class="wrapped-slide wrapped-finale" data-confetti>
        <div class="wrapped-eyebrow reveal">That's a wrap</div>
        <h2 class="wrapped-title small reveal">${year}, you sounded great.</h2>
        <div class="finale-chips">
          <div class="finale-chip reveal"><span class="chip-label">Minutes</span><span class="chip-value">${formatNumber(stats.totalMinutes)}</span></div>
          ${topSong ? `<div class="finale-chip reveal"><span class="chip-label">Top song</span><span class="chip-value">${escapeHtml(topSong.title)}</span></div>` : ''}
          ${topArtists[0] ? `<div class="finale-chip reveal"><span class="chip-label">Top artist</span><span class="chip-value">${escapeHtml(topArtists[0].name)}</span></div>` : ''}
          <div class="finale-chip reveal"><span class="chip-label">You are a</span><span class="chip-value">${archetype}</span></div>
        </div>
        <div class="finale-actions reveal">
          <button class="wrapped-btn primary" data-share-card>Save as image</button>
        </div>
      </div>
    `,
  });

  return slides;
}

/** Mini month calendar with one highlighted day (Monday-first). */
function calendarHtml(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) return '';
  const daysInMonth = new Date(y, m, 0).getDate();
  const firstWeekday = (new Date(y, m - 1, 1).getDay() + 6) % 7;

  const cells: string[] = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push('<div class="calendar-day blank"></div>');
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(
      `<div class="calendar-day${day === d ? ' peak' : ''}">${day}</div>`,
    );
  }
  return `<div class="wrapped-calendar">${cells.join('')}</div>`;
}

function createChronotypeTimeline(
  hourlyData: number[],
  peakHour: number,
): string {
  const maxMinutes = Math.max(...hourlyData, 1);
  const bars = hourlyData
    .map((minutes, hour) => {
      const height = Math.max(5, (minutes / maxMinutes) * 96);
      const label = `${hour}`.padStart(2, '0');
      return `
        <div class="chronotype-bar${hour === peakHour ? ' peak' : ''}"
          style="--h:${height.toFixed(0)}px" title="${label}:00 · ${Math.round(minutes)} min">
          <span class="chronotype-bar-inner"></span>
          ${hour % 6 === 0 || hour === 23 ? `<span class="chronotype-label">${label}</span>` : '<span class="chronotype-label"></span>'}
        </div>
      `;
    })
    .join('');

  return `<div class="chronotype-timeline">${bars}</div>`;
}

// ─── Share card ────────────────────────────────────────────────────────

function loadCardImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timeout = window.setTimeout(() => resolve(null), 3000);
    img.onload = () => {
      window.clearTimeout(timeout);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(timeout);
      resolve(null);
    };
    img.src = url;
  });
}

/** Renders a 1080×1920 recap card and downloads it as PNG. */
async function renderShareCard(stats: StatsData) {
  const year = new Date().getFullYear();
  const W = 1080;
  const H = 1920;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');

  // Backdrop
  ctx.fillStyle = '#0a0a0c';
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, -100, 80, W / 2, -100, 1100);
  glow.addColorStop(0, 'rgba(255, 75, 62, 0.35)');
  glow.addColorStop(1, 'rgba(255, 75, 62, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const accent = '#ff4b3e';
  const text = '#f1f1f1';
  const muted = '#a2a2a8';
  const font = (size: number, weight = 700) =>
    `${weight} ${size}px Roboto, "Segoe UI", sans-serif`;

  // Header
  ctx.fillStyle = accent;
  ctx.font = font(30, 600);
  ctx.textAlign = 'center';
  ctx.fillText('MUSIC STATS · WRAPPED', W / 2, 130);
  ctx.fillStyle = text;
  ctx.font = font(120, 800);
  ctx.fillText(`${year}`, W / 2, 260);

  // Minutes hero
  ctx.font = font(96, 800);
  ctx.fillText(formatNumber(stats.totalMinutes), W / 2, 420);
  ctx.fillStyle = muted;
  ctx.font = font(30, 600);
  ctx.fillText('MINUTES LISTENED', W / 2, 470);

  // Top songs
  const ellipsize = (value: string, max: number) => {
    let out = value;
    while (out.length > 3 && ctx.measureText(out).width > max) {
      out = `${out.slice(0, -2).trimEnd()}…`;
    }
    return out;
  };

  ctx.textAlign = 'left';
  ctx.fillStyle = accent;
  ctx.font = font(28, 600);
  ctx.fillText('TOP SONGS', 100, 590);

  const songImages = await Promise.all(
    stats.topSongs
      .slice(0, 5)
      .map((song) =>
        song.imageUrl ? loadCardImage(song.imageUrl) : Promise.resolve(null),
      ),
  );

  stats.topSongs.slice(0, 5).forEach((song, i) => {
    const y = 640 + (i * 130);
    const img = songImages[i];
    if (img) {
      try {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(100, y, 96, 96, 16);
        ctx.clip();
        ctx.drawImage(img, 100, y, 96, 96);
        ctx.restore();
      } catch {
        // Tainted canvas or draw failure — text-only row.
      }
    }
    ctx.fillStyle = muted;
    ctx.font = font(40, 700);
    ctx.fillText(`${i + 1}`, 230, y + 62);
    ctx.fillStyle = text;
    ctx.font = font(38, 700);
    ctx.fillText(ellipsize(song.title, 600), 290, y + 44);
    ctx.fillStyle = muted;
    ctx.font = font(30, 500);
    ctx.fillText(ellipsize(song.artist, 600), 290, y + 84);
  });

  // Top artists
  ctx.fillStyle = accent;
  ctx.font = font(28, 600);
  ctx.fillText('TOP ARTISTS', 100, 1400);
  stats.topArtists.slice(0, 5).forEach((artist, i) => {
    const y = 1455 + (i * 62);
    ctx.fillStyle = muted;
    ctx.font = font(32, 700);
    ctx.fillText(`${i + 1}`, 100, y);
    ctx.fillStyle = text;
    ctx.font = font(34, 600);
    ctx.fillText(ellipsize(artist.name, 700), 160, y);
  });

  // Footer
  ctx.textAlign = 'center';
  ctx.fillStyle = muted;
  ctx.font = font(26, 500);
  ctx.fillText(
    `${formatNumber(stats.uniqueSongs)} songs · ${formatNumber(stats.uniqueArtists)} artists · ${stats.skipRate}% skipped`,
    W / 2,
    1830,
  );

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) throw new Error('render failed');

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `music-wrapped-${year}.png`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  showNotification('Wrapped card saved');
}
