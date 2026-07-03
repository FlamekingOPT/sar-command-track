const CONFIG = {
  unassigned:      { label: 'Unassigned',  color: '#9ca3af' },
  assigned:        { label: 'Assigned',    color: '#3b82f6' },
  in_progress:     { label: 'In Progress', color: '#f59e0b' },
  searched:        { label: 'Searched',    color: '#22c55e' },
  needs_re_search: { label: 'Re-search',   color: '#ef4444' },
  setup:           { label: 'Setup',       color: '#f59e0b' },
  active:          { label: 'Active',      color: '#22c55e' },
  complete:        { label: 'Complete',    color: '#6b7280' },
};

export function StatusPill({ status }) {
  const { label, color } = CONFIG[status] ?? { label: status, color: '#9ca3af' };
  return (
    <span style={{ background: color, color: '#fff', borderRadius: 12,
      padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
      {label}
    </span>
  );
}
