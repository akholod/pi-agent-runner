// TUI helpers for the renderers, looked up in the bound host runtime at call
// time. The standalone pane viewer has no binding: its renderers take an
// explicit `TextRuntime` instead (see pane-viewer.ts).
import { requireHostRuntime } from './host-runtime.ts';
import type { TuiRuntime } from './host-runtime.ts';

/** What a renderer needs; passed explicitly where no host is bound. */
export type TextRuntime = Pick<
  TuiRuntime,
  'truncateToWidth' | 'wrapTextWithAnsi'
>;

export const tuiRuntime = (): TuiRuntime => requireHostRuntime().tui;

export const visibleWidth = (text: string): number =>
  tuiRuntime().visibleWidth(text);

export const truncateToWidth = (
  ...args: Parameters<TuiRuntime['truncateToWidth']>
): string => tuiRuntime().truncateToWidth(...args);

export const wrapTextWithAnsi = (
  ...args: Parameters<TuiRuntime['wrapTextWithAnsi']>
): string[] => tuiRuntime().wrapTextWithAnsi(...args);

export const matchesKey = (
  ...args: Parameters<TuiRuntime['matchesKey']>
): boolean => tuiRuntime().matchesKey(...args);
