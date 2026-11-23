import { ArrowRight, Copy, Download, Drum, FolderOpen, Guitar, Layers, Music2, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { TIME_SIGNATURE_OPTIONS } from '../constants/presets';
import { TEMPLATES, createBlankProject, createTemplate, type TemplateId } from '../data/templates';
import type { RecentProject } from '../services/recentProjects';
import { MAX_BPM, MIN_BPM, clampBpm, type Song, type TimeSigDenominator, type TimeSigNumerator } from '../types/song';
import { cx } from './ui';

interface HomePageProps {
  recent: RecentProject[];
  /** The project currently loaded in the studio, if any. */
  currentSong: Song | null;
  onContinue: () => void;
  onOpenSong: (song: Song) => void;
  onOpenFile: () => void;
  onDuplicateRecent: (id: string) => void;
  onExportRecent: (song: Song) => void;
  onDeleteRecent: (id: string) => void;
}

const TEMPLATE_ICONS: Record<TemplateId, ReactNode> = {
  'full-band': <Layers size={20} />,
  'riff-sketchpad': <Guitar size={20} />,
  'dual-harmony': <Music2 size={20} />,
  'drum-groove': <Drum size={20} />,
};

const TEMPLATE_ACCENTS: Record<TemplateId, string> = {
  'full-band': '#f97316',
  'riff-sketchpad': '#eab308',
  'dual-harmony': '#38bdf8',
  'drum-groove': '#f43f5e',
};

function relativeTime(ts: number): string {
  const diffSec = Math.round((ts - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(diffSec, 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diffSec / 86400), 'day');
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-xs font-bold tracking-[0.18em] text-mist-400 uppercase">{children}</h2>
      {aside}
    </div>
  );
}

function NewProjectForm({ onCreate }: { onCreate: (song: Song) => void }) {
  const [title, setTitle] = useState('');
  const [bpmDraft, setBpmDraft] = useState('120');
  const [ts, setTs] = useState('4/4');
  const submit = () => {
    const option = TIME_SIGNATURE_OPTIONS.find((o) => o.label === ts) ?? TIME_SIGNATURE_OPTIONS[0];
    const parsed = Number.parseInt(bpmDraft, 10);
    onCreate(
      createBlankProject({
        title: title || 'Untitled Song',
        bpm: clampBpm(Number.isFinite(parsed) ? parsed : 120),
        numerator: option.numerator as TimeSigNumerator,
        denominator: option.denominator as TimeSigDenominator,
      }),
    );
  };
  return (
    <form
      className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_7rem_7rem_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
        <span className="text-[11px] font-semibold tracking-wider text-mist-400 uppercase">Song title</span>
        <input
          value={title}
          placeholder="Untitled Song"
          onChange={(e) => setTitle(e.target.value)}
          aria-label="New song title"
          className="h-11 rounded-xl border border-ink-600 bg-ink-950 px-3 text-sm text-zinc-100 outline-none focus:border-sky-500"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold tracking-wider text-mist-400 uppercase">BPM</span>
        <input
          inputMode="numeric"
          value={bpmDraft}
          aria-label="New song BPM"
          title={`${MIN_BPM}–${MAX_BPM} BPM`}
          onChange={(e) => setBpmDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
          onBlur={() => {
            const parsed = Number.parseInt(bpmDraft, 10);
            setBpmDraft(String(clampBpm(Number.isFinite(parsed) ? parsed : 120)));
          }}
          className="h-11 rounded-xl border border-ink-600 bg-ink-950 px-3 font-mono text-sm text-zinc-100 outline-none focus:border-sky-500"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold tracking-wider text-mist-400 uppercase">Time sig.</span>
        <select
          value={ts}
          aria-label="New song time signature"
          onChange={(e) => setTs(e.target.value)}
          className="h-11 rounded-xl border border-ink-600 bg-ink-950 px-2 font-mono text-sm text-zinc-100 outline-none"
        >
          {TIME_SIGNATURE_OPTIONS.map((o) => (
            <option key={o.label} value={o.label}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="col-span-2 flex h-11 items-center justify-center gap-1.5 self-end rounded-xl bg-orange-500 px-5 text-sm font-bold text-ink-950 hover:bg-orange-400 sm:col-span-1"
      >
        <Plus size={16} /> Create
      </button>
    </form>
  );
}

function RecentCard({
  project,
  isCurrent,
  onOpen,
  onDuplicate,
  onExport,
  onDelete,
}: {
  project: RecentProject;
  isCurrent: boolean;
  onOpen: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { song } = project;
  const shown = song.tracks.slice(0, 5);
  const action = 'flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border border-ink-600 bg-ink-800 px-3 text-xs font-medium text-zinc-200 hover:bg-ink-700';
  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-ink-700 bg-ink-900 p-4 transition-colors hover:border-ink-500">
      <button type="button" onClick={onOpen} className="flex flex-col items-start gap-1 text-left">
        <div className="flex w-full items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-base font-bold text-zinc-100">{song.title || 'Untitled'}</h3>
          {isCurrent && <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 uppercase">Open</span>}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-mist-400">
          <span>{Math.round(song.bpm)} BPM</span>
          <span>
            {song.bars.length} bar{song.bars.length === 1 ? '' : 's'}
          </span>
          <span>{relativeTime(project.updatedAt)}</span>
        </div>
      </button>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((t) => (
          <span
            key={t.id}
            className="flex max-w-[9rem] items-center gap-1.5 rounded-full border border-ink-600 bg-ink-950 px-2 py-0.5 text-[11px] text-zinc-300"
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.color }} />
            <span className="truncate">{t.name}</span>
          </span>
        ))}
        {song.tracks.length > shown.length && (
          <span className="rounded-full border border-ink-600 px-2 py-0.5 text-[11px] text-mist-400">+{song.tracks.length - shown.length}</span>
        )}
      </div>
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-rose-200">Delete this project from recents?</span>
          <button type="button" className={action} onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="flex h-11 items-center justify-center rounded-xl bg-rose-500 px-3 text-xs font-bold text-ink-950 hover:bg-rose-400"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onOpen}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-sky-500 px-3 text-xs font-bold text-ink-950 hover:bg-sky-400"
          >
            Open <ArrowRight size={14} />
          </button>
          <button type="button" className={action} onClick={onDuplicate} title="Duplicate" aria-label={`Duplicate ${song.title}`}>
            <Copy size={14} />
          </button>
          <button type="button" className={action} onClick={onExport} title="Export .json" aria-label={`Export ${song.title} as JSON`}>
            <Download size={14} />
          </button>
          <button
            type="button"
            className={cx(action, 'hover:border-rose-500/50 hover:text-rose-300')}
            onClick={() => setConfirming(true)}
            title="Delete"
            aria-label={`Delete ${song.title}`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </article>
  );
}

export function HomePage({
  recent,
  currentSong,
  onContinue,
  onOpenSong,
  onOpenFile,
  onDuplicateRecent,
  onExportRecent,
  onDeleteRecent,
}: HomePageProps) {
  return (
    <div className="touch-pan h-full overflow-y-auto bg-ink-950">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10">
        <header className="flex flex-wrap items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-400 to-rose-600 text-xl font-black text-ink-950">
            R
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-black tracking-tight text-zinc-50 sm:text-3xl">RiffForge Studio</h1>
            <p className="text-sm text-mist-400">Tablature, drive pedals and rock drums — write the riff before it slips away.</p>
          </div>
          {currentSong && (
            <button
              type="button"
              onClick={onContinue}
              className="flex h-11 items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-4 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/25"
            >
              Continue “{currentSong.title || 'Untitled'}” <ArrowRight size={16} />
            </button>
          )}
        </header>

        <section className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
          <div className="rounded-2xl border border-ink-700 bg-ink-900/60 p-4 sm:p-5">
            <SectionTitle>Start new project</SectionTitle>
            <NewProjectForm onCreate={onOpenSong} />
            <div className="mt-5 mb-2 text-[11px] font-semibold tracking-wider text-mist-400 uppercase">Starter templates</div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onOpenSong(createTemplate(t.id))}
                  className="group flex min-h-11 items-start gap-3 rounded-xl border border-ink-700 bg-ink-900 p-3 text-left transition-colors hover:border-ink-500 hover:bg-ink-800"
                >
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                    style={{ backgroundColor: `${TEMPLATE_ACCENTS[t.id]}22`, color: TEMPLATE_ACCENTS[t.id] }}
                  >
                    {TEMPLATE_ICONS[t.id]}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex items-center gap-1.5 text-sm font-bold text-zinc-100">
                      {t.name}
                      <ArrowRight size={14} className="opacity-0 transition-opacity group-hover:opacity-100" />
                    </span>
                    <span className="text-xs leading-snug text-mist-400">{t.description}</span>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {t.tracks.map((name) => (
                        <span key={name} className="rounded-md bg-ink-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
                          {name}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4 rounded-2xl border border-ink-700 bg-ink-900/60 p-4 sm:p-5">
            <SectionTitle>Open project file</SectionTitle>
            <p className="text-sm text-mist-400">Load a RiffForge <span className="font-mono text-zinc-300">.json</span> song saved from this or another device.</p>
            <button
              type="button"
              onClick={onOpenFile}
              className="flex h-12 items-center justify-center gap-2 rounded-xl border border-dashed border-ink-500 bg-ink-950 text-sm font-semibold text-zinc-100 hover:border-sky-500 hover:text-sky-200"
            >
              <FolderOpen size={18} /> Open .json file…
            </button>
            <p className="text-xs text-mist-400">
              Projects you work on are saved automatically on this device and appear under Recent Projects.
            </p>
          </div>
        </section>

        <section>
          <SectionTitle aside={<span className="text-xs text-mist-400">{recent.length} saved on this device</span>}>Recent projects</SectionTitle>
          {recent.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-ink-600 p-8 text-center text-sm text-mist-400">
              No recent projects yet — start one above and it will be auto-saved here.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {recent.map((p) => (
                <RecentCard
                  key={p.song.id}
                  project={p}
                  isCurrent={currentSong?.id === p.song.id}
                  onOpen={() => (currentSong?.id === p.song.id ? onContinue() : onOpenSong(p.song))}
                  onDuplicate={() => onDuplicateRecent(p.song.id)}
                  onExport={() => onExportRecent(p.song)}
                  onDelete={() => onDeleteRecent(p.song.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
