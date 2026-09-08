// 2026-09-08: what the dashboard shows while it is still fetching.
//
// The owner: *"when I go to landing dashboard it takes a while while the
// calender and patient dashboard etc loads. Add a nice bootstrap kinda
// feature so that it shows a waiting spinner etc while it gets loading."*
//
// ## Why the page felt empty rather than busy
//
// `account/index.astro` is statically generated and empty by design
// (ADR-0017 — see that page's header), so everything on it arrives in two
// steps: `RequireAuth` resolves a session, and then each island it admits
// fetches its own data. Until now every one of those steps rendered the same
// thing — one line of text — so a signed-in patient watched five headings
// appear over the word "Loading…", and then five separate layout jumps as
// the answers came back in whatever order the network chose.
//
// Nothing here makes the fetches faster. What it changes is that the wait
// now *looks* like the thing being waited for: a spinner that says the page
// is working, and grey shapes in roughly the outline of the calendar, the
// caseload table or the form that is coming — so the panel fills in where
// the skeleton stood instead of shoving everything below it down the page.
//
// ## One component, four outlines
//
// A single shared placeholder rather than a hand-written one per panel,
// because the value is in the panels agreeing: five areas that each invent
// their own waiting state is the same inconsistency as five areas that each
// invent their own button. `shape` picks the outline; `label` is the panel's
// own existing loading string, unchanged and still the only thing announced.
//
// The shapes are deliberately approximate. A skeleton that tries to be an
// exact preview has to be kept in step with the component it imitates
// forever, and gets it wrong the first time either one changes; one that is
// obviously a placeholder only has to be the right *size*.
import { Loading, Skeleton } from '@ndn/ui';
import type { ReactNode } from 'react';

/** The outline to hold open. Named for the panel it stands in for, not for its geometry — a caller should not have to count rows to pick one. */
export type PlaceholderShape = 'calendar' | 'table' | 'form' | 'lines';

export interface PanelPlaceholderProps {
  /** The panel's own loading string, passed through to the live region unchanged. */
  readonly label: string;
  readonly shape?: PlaceholderShape;
}

/** Five weeks of seven days — the same window `calendar-grid.ts` draws, so the grid lands on the space its skeleton held. */
const CALENDAR_WEEKS = 5;
const CALENDAR_DAYS_PER_WEEK = 7;

/** Enough rows that the table reads as a table; fewer than a full page, so a short caseload does not shrink on arrival. */
const TABLE_ROWS = 4;

/** Ragged on purpose: equal-length lines read as a barcode rather than as text. */
const FORM_FIELD_WIDTHS = ['7rem', '9rem', '6rem'] as const;
const LINE_WIDTHS = ['100%', '92%', '68%'] as const;

function CalendarSkeleton(): ReactNode {
  return (
    <div className="ndn-skeleton-stack">
      <div className="ndn-skeleton-row">
        <Skeleton shape="heading" width="9rem" />
        <Skeleton shape="pill" width="7rem" />
      </div>
      <div className="ndn-skeleton-grid">
        {Array.from({ length: CALENDAR_WEEKS * CALENDAR_DAYS_PER_WEEK }, (_, index) => (
          <Skeleton key={index} shape="block" height="3.25rem" />
        ))}
      </div>
    </div>
  );
}

function TableSkeleton(): ReactNode {
  return (
    <div className="ndn-skeleton-stack">
      <div className="ndn-skeleton-row">
        <Skeleton shape="heading" width="6rem" />
        <Skeleton shape="heading" width="6rem" />
      </div>
      <Skeleton shape="block" height="2.5rem" />
      {Array.from({ length: TABLE_ROWS }, (_, index) => (
        <Skeleton key={index} shape="block" height="2.75rem" />
      ))}
    </div>
  );
}

function FormSkeleton(): ReactNode {
  return (
    <div className="ndn-skeleton-stack">
      {FORM_FIELD_WIDTHS.map((width) => (
        <div className="ndn-skeleton-field" key={width}>
          <Skeleton width={width} />
          <Skeleton shape="block" height="2.75rem" />
        </div>
      ))}
      <Skeleton shape="pill" width="9rem" />
    </div>
  );
}

function LinesSkeleton(): ReactNode {
  return (
    <div className="ndn-skeleton-stack">
      {LINE_WIDTHS.map((width) => (
        <Skeleton key={width} width={width} />
      ))}
    </div>
  );
}

const shapes: Record<PlaceholderShape, () => ReactNode> = {
  calendar: CalendarSkeleton,
  table: TableSkeleton,
  form: FormSkeleton,
  lines: LinesSkeleton,
};

export function PanelPlaceholder({ label, shape = 'lines' }: PanelPlaceholderProps): ReactNode {
  const Shape = shapes[shape];
  return (
    <Loading label={label}>
      <Shape />
    </Loading>
  );
}
