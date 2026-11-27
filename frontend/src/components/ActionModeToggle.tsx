interface ActionModeToggleProps {
  declareMode: boolean;
  disabled?: boolean;
  onChange: (declare: boolean) => void;
}

export default function ActionModeToggle({ declareMode, disabled, onChange }: ActionModeToggleProps) {
  return (
    <div className="relative flex items-center rounded-full bg-slate-700/70 p-0.5"
      role="radiogroup" aria-label="Action mode" data-testid="ask-declare-toggle">
      {(['Ask', 'Declare'] as const).map(label => {
        const declare = label === 'Declare';
        const selected = declareMode === declare;
        return (
          <button key={label} type="button" role="radio" aria-checked={selected}
            disabled={disabled} data-testid={declare ? 'toggle-declare' : 'toggle-ask'}
            onClick={() => { if (!selected) onChange(declare); }}
            className={[
              'relative z-10 px-3 py-1 text-xs font-semibold rounded-full transition-all duration-200',
              selected ? `${declare ? 'bg-violet-600' : 'bg-emerald-600'} text-white shadow-sm` : 'text-slate-400 hover:text-white',
              disabled ? 'opacity-50' : '',
            ].join(' ')}>{label}</button>
        );
      })}
    </div>
  );
}
