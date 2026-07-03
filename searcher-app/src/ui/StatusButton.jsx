export function StatusButton({ status, onComplete, onReopen }) {
  const complete = status === 'searched';
  return (
    <button
      onClick={complete ? onReopen : onComplete}
      style={{
        position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 10,
        padding: 16, fontSize: 18, fontWeight: 700, borderRadius: 12,
        color: '#fff', background: complete ? '#6b7280' : '#22c55e',
        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
      }}>
      {complete ? '✓ Zone Complete — tap to re-open' : 'Mark Zone Complete'}
    </button>
  );
}
