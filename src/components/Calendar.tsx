'use client';

import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { MONTH_LABELS, WEEKDAY_SHORT, addDays, weekdayOfDate } from '@/lib/datetime';

type Props = {
  month: string;                       // YYYY-MM
  selected: string | null;             // YYYY-MM-DD
  availability: Record<string, boolean>;
  minDate: string;
  maxDate: string;
  loading?: boolean;
  onMonthChange: (month: string) => void;
  onSelect: (date: string) => void;
};

function monthShift(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function Calendar({
  month,
  selected,
  availability,
  minDate,
  maxDate,
  loading,
  onMonthChange,
  onSelect,
}: Props) {
  const { days, label } = useMemo(() => {
    const [year, m] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const offset = weekdayOfDate(`${month}-01`); // células vazias antes do dia 1

    const cells: (string | null)[] = Array(offset).fill(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(`${month}-${String(d).padStart(2, '0')}`);
    }
    return { days: cells, label: `${MONTH_LABELS[m - 1]} ${year}` };
  }, [month]);

  const canGoBack = monthShift(month, -1) >= minDate.slice(0, 7);
  const canGoForward = monthShift(month, 1) <= maxDate.slice(0, 7);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => canGoBack && onMonthChange(monthShift(month, -1))}
          disabled={!canGoBack}
          className="-ml-1.5 rounded-lg p-1.5 text-ink-400 transition-colors hover:text-ink-100 disabled:opacity-25"
          aria-label="Mês anterior"
        >
          <ChevronLeft size={17} strokeWidth={1.5} />
        </button>
        <span className="display text-[17px] capitalize tracking-wide text-ink-100">{label}</span>
        <button
          type="button"
          onClick={() => canGoForward && onMonthChange(monthShift(month, 1))}
          disabled={!canGoForward}
          className="-mr-1.5 rounded-lg p-1.5 text-ink-400 transition-colors hover:text-ink-100 disabled:opacity-25"
          aria-label="Próximo mês"
        >
          <ChevronRight size={17} strokeWidth={1.5} />
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7">
        {WEEKDAY_SHORT.map((d) => (
          <div key={d} className="py-2 text-center text-[10px] uppercase tracking-widest text-ink-500">
            {d.slice(0, 1)}
          </div>
        ))}
      </div>

      <div className={clsx('grid grid-cols-7 gap-y-1 transition-opacity', loading && 'opacity-40')}>
        {days.map((date, index) => {
          if (!date) return <div key={`empty-${index}`} />;

          const outOfRange = date < minDate || date > maxDate;
          const available = availability[date] ?? false;
          const disabled = outOfRange || !available;
          const isSelected = selected === date;

          return (
            <button
              key={date}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(date)}
              className={clsx(
                'tnum relative mx-auto flex h-10 w-10 items-center justify-center rounded-full text-[13px] transition-colors',
                isSelected && 'bg-bone text-ink-950',
                !isSelected && !disabled && 'text-ink-100 hover:bg-ink-850',
                disabled && 'cursor-not-allowed text-ink-600'
              )}
            >
              {Number(date.slice(-2))}
              {!isSelected && available && (
                <span className="absolute bottom-1 left-1/2 h-px w-3 -translate-x-1/2 bg-brand-500" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { addDays };
