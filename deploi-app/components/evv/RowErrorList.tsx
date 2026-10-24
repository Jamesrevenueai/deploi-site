import type { RowError } from '@/lib/imports/validate'

/** Row-level import errors with 1-based data row numbers. Server component; shared by the EVV and applicant import pages. */
export function RowErrorList({ errors, limit = 200 }: { errors: RowError[]; limit?: number }) {
  const shown = errors.slice(0, limit)
  return (
    <>
      <div className="table-wrap hidden md:block">
        <table className="dg-table">
          <thead><tr><th>Row</th><th>Field</th><th>Problem</th></tr></thead>
          <tbody>{shown.map((e, i) => <tr key={i}><td className="ink">{e.row === 0 ? 'file' : e.row}</td><td>{e.field ?? '—'}</td><td>{e.message}</td></tr>)}</tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-2 md:hidden">
        {shown.map((e, i) => <li key={i} className="rounded-2xl border border-line px-4 py-3 text-[14px]"><span className="text-ink font-medium">Row {e.row === 0 ? 'file' : e.row}</span>{e.field && <span className="text-grey-h"> · {e.field}</span>}<div className="text-grey">{e.message}</div></li>)}
      </ul>
      {errors.length > limit && <p className="mt-2 text-[13px] text-grey-h">Showing the first {limit} of {errors.length}.</p>}
    </>
  )
}
